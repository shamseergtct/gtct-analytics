/* functions/index.js */
const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

admin.initializeApp();
const db = admin.firestore();

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
