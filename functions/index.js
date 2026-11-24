/* functions/index.js */
const admin = require("firebase-admin");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");

admin.initializeApp();
const db = admin.firestore();

// TEST bridge shared key (defineString — avoids Secret Manager / Blaze requirement).
// Set in functions/.env as RESTAURANT_DELIVERY_BRIDGE_SECRET=...
const restaurantBridgeSecret = defineString("RESTAURANT_DELIVERY_BRIDGE_SECRET", {
  default: "",
});
const RESTAURANT_DELIVERY_ORDERS = "restaurant_delivery_orders";

/* ---------- Restaurant POS activation (per-shop keys) ----------
 * New, separate collections, only reachable through these functions
 * (firestore.rules already denies all client access to unknown collections).
 */
const crypto = require("crypto");
const RESTAURANT_POS_CODES = "restaurant_pos_activation_codes";
const RESTAURANT_POS_DEVICES = "restaurant_pos_devices";
const POS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars, no 0/O/1/I
const POS_CODE_LENGTH = 10;

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizePosCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function newPosActivationCode() {
  const bytes = crypto.randomBytes(POS_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < POS_CODE_LENGTH; i += 1) code += POS_CODE_ALPHABET[bytes[i] & 31];
  return code;
}

function formatPosCode(code) {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Per-shop POS key check. Returns { clientId } or null. Never throws on bad input. */
async function verifyRestaurantPosDevice(deviceIdRaw, keyRaw) {
  const deviceId = String(deviceIdRaw || "").trim();
  const key = String(keyRaw || "").trim();
  if (!/^pos_[A-Za-z0-9_-]{8,40}$/.test(deviceId) || key.length < 32 || key.length > 128) {
    return null;
  }
  const ref = db.collection(RESTAURANT_POS_DEVICES).doc(deviceId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const device = snap.data() || {};
  if (device.revokedAt || !device.keyHash || !device.clientId) return null;
  const a = Buffer.from(sha256Hex(key), "hex");
  const b = Buffer.from(String(device.keyHash), "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const now = Date.now();
  if (!device.lastSeenAt || now - Number(device.lastSeenAt) > 5 * 60 * 1000) {
    await ref.set({ lastSeenAt: now }, { merge: true });
  }
  return { clientId: String(device.clientId) };
}

/**
 * Verify caller is a valid super_admin from Firestore users/{uid}
 * (No need for custom claims to start.)
 */
async function assertSuperAdmin(context) {
  if (!context.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }

  const uid = context.auth.uid;
  const snap = await db.collection("users").doc(uid).get();

  if (!snap.exists) {
    throw new HttpsError("permission-denied", "User profile missing.");
  }

  const data = snap.data();
  if (data?.isActive === false) {
    throw new HttpsError("permission-denied", "Account disabled.");
  }

  if (data?.role !== "super_admin") {
    throw new HttpsError("permission-denied", "Only super_admin can do this.");
  }

  return { uid, profile: data };
}

/**
 * ✅ Create a new Auth user + Firestore users/{uid} profile
 * Replaces secondary-auth approach.
 */
exports.superCreateUser = onCall({ region: "asia-south1" }, async (request) => {
  const { email, password, role, assignedShops } = request.data || {};
  const { uid: creatorUid } = await assertSuperAdmin(request);

  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanPassword = String(password || "");
  const cleanRole = role === "partner" ? "partner" : "admin";
  const shops = Array.isArray(assignedShops) ? assignedShops : [];

  if (!cleanEmail) {
    throw new HttpsError("invalid-argument", "Email is required.");
  }
  if (!cleanPassword || cleanPassword.length < 6) {
    throw new HttpsError("invalid-argument", "Password must be at least 6 characters.");
  }
  if (shops.length === 0) {
    throw new HttpsError("invalid-argument", "assignedShops must have at least 1 shop.");
  }

  try {
    // Create Auth user
    const userRecord = await admin.auth().createUser({
      email: cleanEmail,
      password: cleanPassword,
      emailVerified: false,
      disabled: false,
    });

    const newUid = userRecord.uid;

    // Create Firestore profile
    await db.collection("users").doc(newUid).set({
      uid: newUid,
      email: cleanEmail,
      role: cleanRole,              // "admin" | "partner"
      assignedShops: shops,         // array of clientIds
      createdBy: creatorUid,
      createdAt: Date.now(),
      isActive: true,
    });

    return { ok: true, uid: newUid };
  } catch (e) {
    // Friendly errors
    const msg = e?.message || "Failed to create user";
    if (msg.includes("email-already-exists")) {
      throw new HttpsError("already-exists", "Email already exists.");
    }
    throw new HttpsError("internal", msg);
  }
});

/**
 * ✅ Reset password securely (Admin SDK)
 * Super admin supplies target uid and a new temp password.
 */
exports.superResetUserPassword = onCall({ region: "asia-south1" }, async (request) => {
  const { targetUid, newPassword } = request.data || {};
  await assertSuperAdmin(request);

  const uid = String(targetUid || "").trim();
  const pwd = String(newPassword || "");

  if (!uid) {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }
  if (!pwd || pwd.length < 6) {
    throw new HttpsError("invalid-argument", "New password must be at least 6 characters.");
  }

  try {
    await admin.auth().updateUser(uid, { password: pwd });
    return { ok: true };
  } catch (e) {
    throw new HttpsError("internal", e?.message || "Failed to reset password");
  }
});

/**
 * ✅ Disable/Enable user in BOTH places:
 * - Firestore users/{uid}.isActive
 * - Firebase Auth disabled flag
 */
/**
 * Assert caller is active super_admin OR admin assigned to clientId.
 */
async function assertShopAdmin(request, clientId) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }
  const uid = request.auth.uid;
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError("permission-denied", "User profile missing.");
  }
  const data = snap.data() || {};
  if (data.isActive === false) {
    throw new HttpsError("permission-denied", "Account disabled.");
  }
  const role = String(data.role || "");
  const shops = Array.isArray(data.assignedShops) ? data.assignedShops : [];
  const shop = String(clientId || "").trim();
  if (role === "super_admin") {
    return { uid, profile: data };
  }
  if (
    (role === "admin" || role === "shop_admin") &&
    shop &&
    shops.includes(shop)
  ) {
    return { uid, profile: data };
  }
  throw new HttpsError(
    "permission-denied",
    "Only shop admin or super admin can do this."
  );
}

/**
 * Update Delivery Entry login email and/or password for a delivery_boy user.
 * Shop admin (assigned) or super_admin.
 */
exports.updateDeliveryBoyLogin = onCall(
  { region: "asia-south1" },
  async (request) => {
    const {
      targetUid,
      deliveryBoyId,
      clientId,
      email,
      password,
    } = request.data || {};

    const uid = String(targetUid || "").trim();
    const boyId = String(deliveryBoyId || "").trim();
    const shopId = String(clientId || "").trim();
    const nextEmail = String(email || "").trim().toLowerCase();
    const nextPassword = String(password || "");

    if (!uid) {
      throw new HttpsError("invalid-argument", "targetUid is required.");
    }
    if (!boyId) {
      throw new HttpsError("invalid-argument", "deliveryBoyId is required.");
    }
    if (!shopId) {
      throw new HttpsError("invalid-argument", "clientId is required.");
    }
    if (!nextEmail && !nextPassword) {
      throw new HttpsError(
        "invalid-argument",
        "Provide a new email and/or password."
      );
    }
    if (nextPassword && nextPassword.length < 6) {
      throw new HttpsError(
        "invalid-argument",
        "Password must be at least 6 characters."
      );
    }

    const { uid: callerUid } = await assertShopAdmin(request, shopId);

    const userSnap = await db.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "Login user profile not found.");
    }
    const userData = userSnap.data() || {};
    if (userData.role !== "delivery_boy") {
      throw new HttpsError(
        "failed-precondition",
        "Target user is not a delivery boy login."
      );
    }
    if (String(userData.deliveryBoyId || "") !== boyId) {
      throw new HttpsError(
        "failed-precondition",
        "Login is not linked to this delivery boy."
      );
    }
    const assigned = Array.isArray(userData.assignedShops)
      ? userData.assignedShops
      : [];
    if (!assigned.includes(shopId)) {
      throw new HttpsError(
        "failed-precondition",
        "Login is not assigned to this shop."
      );
    }

    const boySnap = await db.collection("delivery_boys").doc(boyId).get();
    if (!boySnap.exists) {
      throw new HttpsError("not-found", "Delivery boy not found.");
    }
    const boyData = boySnap.data() || {};
    if (String(boyData.clientId || "") !== shopId) {
      throw new HttpsError(
        "failed-precondition",
        "Delivery boy does not belong to this shop."
      );
    }
    if (String(boyData.linkedUserId || "") !== uid) {
      throw new HttpsError(
        "failed-precondition",
        "Delivery boy login link does not match."
      );
    }

    const authPatch = {};
    if (nextEmail) authPatch.email = nextEmail;
    if (nextPassword) authPatch.password = nextPassword;

    try {
      if (Object.keys(authPatch).length) {
        await admin.auth().updateUser(uid, authPatch);
      }

      const now = Date.now();
      const userPatch = {
        updatedAt: now,
        updatedBy: callerUid,
      };
      if (nextEmail) userPatch.email = nextEmail;
      await db.collection("users").doc(uid).update(userPatch);

      if (nextEmail) {
        await db.collection("delivery_boys").doc(boyId).update({
          linkedUserEmail: nextEmail,
          updatedAt: now,
          updatedAtMs: now,
          updatedBy: callerUid,
        });
      }

      return {
        ok: true,
        email: nextEmail || userData.email || "",
        passwordUpdated: Boolean(nextPassword),
      };
    } catch (e) {
      const msg = e?.message || "Failed to update login";
      if (msg.includes("email-already-exists")) {
        throw new HttpsError("already-exists", "Email already exists.");
      }
      if (msg.includes("invalid-email")) {
        throw new HttpsError("invalid-argument", "Email is invalid.");
      }
      throw new HttpsError("internal", msg);
    }
  }
);

exports.superSetUserActive = onCall({ region: "asia-south1" }, async (request) => {
  const { targetUid, isActive } = request.data || {};
  const { uid: callerUid } = await assertSuperAdmin(request);

  const uid = String(targetUid || "").trim();
  const next = Boolean(isActive);

  if (!uid) {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }
  if (uid === callerUid && next === false) {
    throw new HttpsError("failed-precondition", "You cannot disable your own account.");
  }

  try {
    // Firestore
    await db.collection("users").doc(uid).update({
      isActive: next,
      updatedAt: Date.now(),
      updatedBy: callerUid,
    });

    // Auth
    await admin.auth().updateUser(uid, { disabled: !next });

    return { ok: true };
  } catch (e) {
    throw new HttpsError("internal", e?.message || "Failed to update user status");
  }
});

async function assertDeliveryBoyCaller(request, clientId) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in.");
  }
  const uid = request.auth.uid;
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError("permission-denied", "User profile missing.");
  }
  const profile = snap.data() || {};
  if (profile.isActive === false) {
    throw new HttpsError("permission-denied", "Account disabled.");
  }
  if (profile.role !== "delivery_boy") {
    throw new HttpsError("permission-denied", "Delivery boy login required.");
  }
  const boyId = String(profile.deliveryBoyId || "").trim();
  if (!boyId) {
    throw new HttpsError("failed-precondition", "Delivery boy profile not linked.");
  }
  const shops = Array.isArray(profile.assignedShops) ? profile.assignedShops : [];
  const shop = String(clientId || "").trim();
  if (!shop || (!shops.includes(shop) && String(profile.clientId || "") !== shop)) {
    throw new HttpsError("permission-denied", "Not assigned to this shop.");
  }
  const boySnap = await db.collection("delivery_boys").doc(boyId).get();
  const boy = boySnap.exists ? boySnap.data() || {} : {};
  return {
    uid,
    deliveryBoyId: boyId,
    deliveryBoyName: String(boy.name || profile.email || "Delivery"),
    profile,
  };
}

function restaurantOrderRef(clientId, localOrderId) {
  return db
    .collection(RESTAURANT_DELIVERY_ORDERS)
    .doc(`${String(clientId).trim()}_${String(localOrderId).trim()}`);
}

/** First-wins accept for cellular Delivery Boys. */
exports.acceptRestaurantDeliveryOrder = onCall(
  { region: "asia-south1" },
  async (request) => {
    const orderDocId = String(request.data?.orderDocId || "").trim();
    const expectedRevision = String(request.data?.expectedRevision || "").trim();
    if (!orderDocId) {
      throw new HttpsError("invalid-argument", "orderDocId is required.");
    }
    const ref = db.collection(RESTAURANT_DELIVERY_ORDERS).doc(orderDocId);
    const existing = await ref.get();
    if (!existing.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }
    const actor = await assertDeliveryBoyCaller(
      request,
      existing.data()?.clientId
    );
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        throw new HttpsError("not-found", "Order not found.");
      }
      const order = snap.data() || {};
      if (order.status === "CLAIMED" && order.claimedByDeliveryBoyId === actor.deliveryBoyId) {
        return { alreadyAccepted: true, orderId: order.localOrderId };
      }
      if (order.status !== "AVAILABLE") {
        throw new HttpsError("failed-precondition", "Order is no longer available.");
      }
      if (expectedRevision && String(order.claimRevision || "") !== expectedRevision) {
        throw new HttpsError("aborted", "Order changed. Refresh and try again.");
      }
      const now = Date.now();
      tx.update(ref, {
        status: "CLAIMED",
        claimedByDeliveryBoyId: actor.deliveryBoyId,
        claimedByName: actor.deliveryBoyName,
        claimedByUid: actor.uid,
        claimedAt: now,
        claimRevision: `${String(order.claimRevision || "0")}:claimed:${now}`,
        localClaimApplied: false,
        updatedAt: now,
        deliveryLifecycle: {
          status: "PENDING",
          version: Number(order.deliveryLifecycle?.version || 0),
        },
      });
      return { alreadyAccepted: false, orderId: order.localOrderId };
    });
    return { ok: true, ...result };
  }
);

exports.updateRestaurantDeliveryStatus = onCall(
  { region: "asia-south1" },
  async (request) => {
    const orderDocId = String(request.data?.orderDocId || "").trim();
    const action = String(request.data?.action || "").trim().toUpperCase();
    const expectedVersion = Number(request.data?.expectedVersion || 0);
    if (!orderDocId) {
      throw new HttpsError("invalid-argument", "orderDocId is required.");
    }
    if (!["DELIVERED", "REQUEST_CANCEL"].includes(action)) {
      throw new HttpsError("invalid-argument", "Unsupported action.");
    }
    const ref = db.collection(RESTAURANT_DELIVERY_ORDERS).doc(orderDocId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
      const order = snap.data() || {};
      const actor = await assertDeliveryBoyCaller(request, order.clientId);
      if (order.claimedByDeliveryBoyId !== actor.deliveryBoyId) {
        throw new HttpsError("permission-denied", "Not your delivery.");
      }
      if (order.status !== "CLAIMED") {
        throw new HttpsError("failed-precondition", "Order is not in delivery.");
      }
      const life = order.deliveryLifecycle || { status: "PENDING", version: 0 };
      if (Number(life.version || 0) !== expectedVersion) {
        throw new HttpsError("aborted", "Status changed. Refresh and retry.");
      }
      const now = Date.now();
      if (action === "DELIVERED") {
        tx.update(ref, {
          status: "DELIVERED",
          deliveryLifecycle: { status: "DELIVERED", version: expectedVersion + 1, at: now },
          updatedAt: now,
          localStatusApplied: false,
        });
      } else {
        tx.update(ref, {
          status: "CANCEL_REQUESTED",
          deliveryLifecycle: {
            status: "CANCEL_REQUESTED",
            version: expectedVersion + 1,
            at: now,
            reason: String(request.data?.reason || "").trim(),
          },
          updatedAt: now,
          localStatusApplied: false,
        });
      }
    });
    return { ok: true };
  }
);

exports.reportRestaurantDeliveryPayment = onCall(
  { region: "asia-south1" },
  async (request) => {
    const orderDocId = String(request.data?.orderDocId || "").trim();
    const reportType = String(request.data?.reportType || "").trim().toUpperCase();
    const expectedVersion = Number(request.data?.expectedVersion || 0);
    const allowed = [
      "CASH_WITH_BOY",
      "SHOP_PAID_REPORTED",
      "CREDIT_REPORTED",
      "PARTIAL_SHOP",
    ];
    if (!orderDocId) {
      throw new HttpsError("invalid-argument", "orderDocId is required.");
    }
    if (!allowed.includes(reportType)) {
      throw new HttpsError("invalid-argument", "Unsupported payment mark.");
    }
    const ref = db.collection(RESTAURANT_DELIVERY_ORDERS).doc(orderDocId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
      const order = snap.data() || {};
      const actor = await assertDeliveryBoyCaller(request, order.clientId);
      if (order.claimedByDeliveryBoyId !== actor.deliveryBoyId) {
        throw new HttpsError("permission-denied", "Not your delivery.");
      }
      if (!["CLAIMED", "DELIVERED"].includes(order.status)) {
        throw new HttpsError("failed-precondition", "Accept the order first.");
      }
      const pay = order.paymentReport || { status: "UNMARKED", version: 0 };
      if (Number(pay.version || 0) !== expectedVersion) {
        throw new HttpsError("aborted", "Payment mark changed. Refresh and retry.");
      }
      const now = Date.now();
      const cashCents = Math.max(0, Math.round(Number(request.data?.cashCents) || 0));
      const shopPaidCents = Math.max(
        0,
        Math.round(Number(request.data?.shopPaidCents) || 0)
      );
      const creditCents = Math.max(
        0,
        Math.round(Number(request.data?.creditCents) || 0)
      );
      const multi = request.data?.multi === true;
      const paymentReport = {
        status: reportType,
        version: expectedVersion + 1,
        reportedAt: now,
        reportedByDeliveryBoyId: actor.deliveryBoyId,
        multi: Boolean(multi),
      };
      if (multi || reportType === "PARTIAL_SHOP") {
        paymentReport.cashCents = cashCents;
        paymentReport.shopPaidCents = shopPaidCents;
        paymentReport.creditCents = creditCents;
      }
      tx.update(ref, {
        paymentReport,
        updatedAt: now,
        localPaymentApplied: false,
      });
    });
    return { ok: true };
  }
);

/**
 * Local POS bridge: publish ready orders + pull unapplied claims/status/payment.
 * Auth: shared secret header X-GTCT-BRIDGE-SECRET (Functions secret).
 */
exports.restaurantDeliveryBridge = onRequest(
  { region: "asia-south1" },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set(
      "Access-Control-Allow-Headers",
      "Content-Type, X-GTCT-BRIDGE-SECRET, X-GTCT-DEVICE-ID, X-GTCT-DEVICE-KEY"
    );
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "POST only" });
      return;
    }
    // A POS activated with a code sends its own key; others use the shared key (unchanged).
    let boundClientId = "";
    if (req.get("X-GTCT-DEVICE-ID")) {
      const device = await verifyRestaurantPosDevice(
        req.get("X-GTCT-DEVICE-ID"),
        req.get("X-GTCT-DEVICE-KEY")
      );
      if (!device) {
        res.status(401).json({ error: "Unauthorized POS. Activate it again with a new code." });
        return;
      }
      boundClientId = device.clientId;
    } else {
      const expected = String(restaurantBridgeSecret.value() || "").trim();
      const provided = String(req.get("X-GTCT-BRIDGE-SECRET") || "").trim();
      if (!expected || provided !== expected) {
        res.status(401).json({ error: "Unauthorized bridge." });
        return;
      }
    }
    const body = req.body || {};
    const clientId = String(body.clientId || "").trim();
    if (!clientId) {
      res.status(400).json({ error: "clientId is required." });
      return;
    }
    if (boundClientId && clientId !== boundClientId) {
      res.status(403).json({ error: "This POS is activated for a different shop." });
      return;
    }
    // An activated POS may only acknowledge its own shop's orders.
    const ownAckId = (id) => !boundClientId || String(id).startsWith(`${clientId}_`);
    const now = Date.now();
    const published = [];
    for (const order of Array.isArray(body.publishOrders) ? body.publishOrders : []) {
      const localOrderId = String(order.localOrderId || "").trim();
      if (!localOrderId) continue;
      const ref = restaurantOrderRef(clientId, localOrderId);
      const existing = await ref.get();
      const prev = existing.exists ? existing.data() || {} : {};
      // Never overwrite an active claim with AVAILABLE.
      if (
        existing.exists &&
        ["CLAIMED", "DELIVERED", "CANCEL_REQUESTED", "CANCELLED"].includes(prev.status)
      ) {
        await ref.set(
          {
            ...order,
            clientId,
            localOrderId,
            status: prev.status,
            claimedByDeliveryBoyId: prev.claimedByDeliveryBoyId || "",
            claimedByName: prev.claimedByName || "",
            claimedByUid: prev.claimedByUid || "",
            claimedAt: prev.claimedAt || null,
            // Keep rider marks; always refresh cashier settlement from POS.
            paymentReport: prev.paymentReport || order.paymentReport || null,
            shopPayment: order.shopPayment || prev.shopPayment || null,
            deliveryLifecycle: prev.deliveryLifecycle || order.deliveryLifecycle || null,
            localClaimApplied: prev.localClaimApplied === true,
            localStatusApplied: prev.localStatusApplied === true,
            localPaymentApplied: prev.localPaymentApplied === true,
            updatedAt: now,
            publishedAt: prev.publishedAt || now,
          },
          { merge: true }
        );
      } else {
        await ref.set(
          {
            ...order,
            clientId,
            localOrderId,
            status: "AVAILABLE",
            claimedByDeliveryBoyId: "",
            claimedByName: "",
            claimedByUid: "",
            claimedAt: null,
            paymentReport: order.paymentReport || {
              status: "UNMARKED",
              version: 0,
            },
            deliveryLifecycle: order.deliveryLifecycle || {
              status: "PENDING",
              version: 0,
            },
            localClaimApplied: false,
            localStatusApplied: true,
            localPaymentApplied: true,
            updatedAt: now,
            publishedAt: prev.publishedAt || now,
          },
          { merge: true }
        );
      }
      published.push(localOrderId);
    }

    // Single client query (no composite index). Filter pending apply flags in memory.
    const clientOrdersSnap = await db
      .collection(RESTAURANT_DELIVERY_ORDERS)
      .where("clientId", "==", clientId)
      .limit(300)
      .get();
    const clientOrders = clientOrdersSnap.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));
    const pendingClaims = clientOrders.filter(
      (row) =>
        row.localClaimApplied === false &&
        row.status !== "AVAILABLE" &&
        row.claimedByDeliveryBoyId
    );
    const pendingStatuses = clientOrders.filter(
      (row) => row.localStatusApplied === false
    );
    const pendingPayments = clientOrders.filter(
      (row) => row.localPaymentApplied === false
    );

    for (const id of (Array.isArray(body.ackClaimIds) ? body.ackClaimIds : []).filter(ownAckId)) {
      const ref = db.collection(RESTAURANT_DELIVERY_ORDERS).doc(String(id));
      await ref.set({ localClaimApplied: true, updatedAt: now }, { merge: true });
    }
    for (const id of (Array.isArray(body.ackStatusIds) ? body.ackStatusIds : []).filter(ownAckId)) {
      const ref = db.collection(RESTAURANT_DELIVERY_ORDERS).doc(String(id));
      await ref.set({ localStatusApplied: true, updatedAt: now }, { merge: true });
    }
    for (const id of (Array.isArray(body.ackPaymentIds) ? body.ackPaymentIds : []).filter(ownAckId)) {
      const ref = db.collection(RESTAURANT_DELIVERY_ORDERS).doc(String(id));
      await ref.set({ localPaymentApplied: true, updatedAt: now }, { merge: true });
    }

    res.status(200).json({
      ok: true,
      publishedCount: published.length,
      pendingClaims,
      pendingStatuses,
      pendingPayments,
    });
  }
);

/**
 * Super admin: create a one-time activation code for a shop's POS.
 * The code is returned once and only its hash is stored.
 */
exports.createRestaurantPosActivationCode = onCall({ region: "asia-south1" }, async (request) => {
  const { uid } = await assertSuperAdmin(request);
  const clientId = String(request.data?.clientId || "").trim();
  const label = String(request.data?.label || "").trim().slice(0, 60);
  const hours = Math.min(72, Math.max(1, Number(request.data?.validHours || 24) || 24));
  if (!clientId) throw new HttpsError("invalid-argument", "Choose a shop (clientId).");
  const client = await db.collection("clients").doc(clientId).get();
  if (!client.exists) throw new HttpsError("not-found", "Shop not found.");
  const code = newPosActivationCode();
  const now = Date.now();
  const expiresAt = now + hours * 60 * 60 * 1000;
  await db.collection(RESTAURANT_POS_CODES).doc(sha256Hex(code)).set({
    clientId,
    label,
    createdBy: uid,
    createdAt: now,
    expiresAt,
    usedAt: null,
    usedByDeviceId: "",
  });
  return {
    code: formatPosCode(code),
    clientId,
    clientName: String(client.data()?.name || client.data()?.shopName || clientId),
    expiresAt,
  };
});

/**
 * POS (no Firebase login): exchange a one-time code for this POS's own key.
 * Body: { code, deviceLabel }. Each code works once and expires.
 */
exports.activateRestaurantPos = onRequest({ region: "asia-south1" }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const code = normalizePosCode(req.body?.code);
  const deviceLabel = String(req.body?.deviceLabel || "").trim().slice(0, 60);
  const invalid = async () => {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    res.status(400).json({ error: "This activation code is not valid, already used, or expired." });
  };
  if (code.length !== POS_CODE_LENGTH) {
    await invalid();
    return;
  }
  const codeRef = db.collection(RESTAURANT_POS_CODES).doc(sha256Hex(code));
  const deviceId = `pos_${crypto.randomBytes(12).toString("base64url")}`;
  const deviceKey = crypto.randomBytes(32).toString("base64url");
  let result = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(codeRef);
    if (!snap.exists) return;
    const row = snap.data() || {};
    const now = Date.now();
    if (row.usedAt || Number(row.expiresAt || 0) < now || !row.clientId) return;
    tx.set(db.collection(RESTAURANT_POS_DEVICES).doc(deviceId), {
      clientId: row.clientId,
      keyHash: sha256Hex(deviceKey),
      label: deviceLabel || row.label || "",
      activatedAt: now,
      activatedByCodeCreator: row.createdBy || "",
      revokedAt: null,
      lastSeenAt: null,
    });
    tx.set(codeRef, { usedAt: now, usedByDeviceId: deviceId }, { merge: true });
    result = { clientId: row.clientId };
  });
  if (!result) {
    await invalid();
    return;
  }
  const client = await db.collection("clients").doc(result.clientId).get();
  res.status(200).json({
    ok: true,
    clientId: result.clientId,
    clientName: String(client.data()?.name || client.data()?.shopName || result.clientId),
    deviceId,
    deviceKey,
  });
});

/** Super admin: list activated POS devices (no keys) and open codes for a shop. */
exports.listRestaurantPos = onCall({ region: "asia-south1" }, async (request) => {
  await assertSuperAdmin(request);
  const clientId = String(request.data?.clientId || "").trim();
  let devQuery = db.collection(RESTAURANT_POS_DEVICES);
  let codeQuery = db.collection(RESTAURANT_POS_CODES);
  if (clientId) {
    devQuery = devQuery.where("clientId", "==", clientId);
    codeQuery = codeQuery.where("clientId", "==", clientId);
  }
  const [devices, codes] = await Promise.all([devQuery.limit(200).get(), codeQuery.limit(200).get()]);
  const now = Date.now();
  return {
    devices: devices.docs.map((d) => {
      const x = d.data() || {};
      return {
        deviceId: d.id,
        clientId: x.clientId,
        label: x.label || "",
        activatedAt: x.activatedAt || null,
        lastSeenAt: x.lastSeenAt || null,
        revokedAt: x.revokedAt || null,
      };
    }),
    openCodes: codes.docs
      .map((d) => d.data() || {})
      .filter((x) => !x.usedAt && Number(x.expiresAt || 0) > now)
      .map((x) => ({ clientId: x.clientId, label: x.label || "", createdAt: x.createdAt, expiresAt: x.expiresAt })),
  };
});

/** Super admin: block one POS immediately (other shops are not affected). */
exports.revokeRestaurantPos = onCall({ region: "asia-south1" }, async (request) => {
  const { uid } = await assertSuperAdmin(request);
  const deviceId = String(request.data?.deviceId || "").trim();
  if (!/^pos_[A-Za-z0-9_-]{8,40}$/.test(deviceId)) {
    throw new HttpsError("invalid-argument", "Invalid POS id.");
  }
  const ref = db.collection(RESTAURANT_POS_DEVICES).doc(deviceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "POS not found.");
  await ref.set({ revokedAt: Date.now(), revokedBy: uid }, { merge: true });
  return { ok: true };
});
