/**
 * Publish ready local deliveries to GTCT Analytics and apply cloud claims.
 * Cellular Delivery Boys use Firebase; this PC remains source of truth for POS.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../db/db.js";
import { nowIso } from "../util/time.js";
import { getShopSettings, updateShopSettings } from "./shopSettings.js";
import { getDeliveryBillSnapshot } from "./deliveryPool.js";
import { readOrderOperationalState } from "./orderOperationalState.js";
import { getOrderPayment } from "./settlements.js";
import { hashPassword } from "./staffAuth.js";
import { recordAudit } from "./audit.js";
import {
  markDeliveryLifecycle,
  readDeliveryLifecycle,
} from "./deliveryLifecycle.js";
import { markDeliveryPayment } from "./deliveryPaymentReports.js";
import { readSplitReview } from "./deliverySplitReview.js";
import { assignStaffRiderCommissionInTx } from "./deliveryCommissionSettings.js";
import { log } from "../util/logger.js";

/**
 * Cash/bank the shop recorded that came FROM THE RIDER (cash handover or rider
 * settlement), as opposed to money the customer paid at the counter.
 */
function riderHandedCents(shopId, orderId) {
  try {
    const row = getDb()
      .prepare(
        `SELECT COALESCE(SUM(a.cash_cents + a.bank_cents), 0) AS cents
         FROM order_payment_allocations a
         WHERE a.shop_id = ? AND a.order_id = ?
           AND (a.allocation_id IN (SELECT allocation_id FROM delivery_cash_handovers
                                     WHERE shop_id = ? AND order_id = ?)
             OR a.allocation_id IN (SELECT allocation_id FROM delivery_rider_net_settlement_orders
                                     WHERE shop_id = ? AND order_id = ?))`
      )
      .get(shopId, orderId, shopId, orderId, shopId, orderId);
    return Number(row?.cents || 0);
  } catch {
    return 0;
  }
}

/** Same payment truth Monitor uses (allocations + balances + credit). */
export function readShopPaymentSnapshot(shopId, orderId) {
  const withSource = (snap) => {
    // riderCashCents: recorded cash that the rider handed in; counterCents: paid at the counter.
    const handed = Math.min(riderHandedCents(shopId, orderId), snap.cashCents + snap.bankCents);
    return { ...snap, riderCashCents: handed, counterCents: snap.cashCents + snap.bankCents - handed };
  };
  try {
    const payment = getOrderPayment(orderId, shopId);
    const status = String(payment.paymentStatus || "UNPAID").toUpperCase();
    const shopCredit = getDb()
      .prepare(
        `SELECT state FROM delivery_shop_credit_authorizations
         WHERE shop_id = ? AND order_id = ?`
      )
      .get(shopId, orderId);
    if (shopCredit?.state === "APPROVED" && status !== "PAID") {
      return withSource({
        status: "CREDIT",
        cashCents: Number(payment.cashCents || 0),
        bankCents: Number(payment.bankCents || 0),
        creditCents: Number(
          payment.creditCents || payment.orderTotalCents || payment.paidCents || 0
        ),
        verified: true,
      });
    }
    return withSource({
      status,
      cashCents: Number(payment.cashCents || 0),
      bankCents: Number(payment.bankCents || 0),
      creditCents: Number(payment.creditCents || 0),
      verified: status !== "UNPAID",
    });
  } catch {
    return {
      status: "UNPAID",
      cashCents: 0,
      bankCents: 0,
      creditCents: 0,
      riderCashCents: 0,
      counterCents: 0,
      verified: false,
    };
  }
}

/**
 * Commission comes from the rider's GTCT Analytics profile: a percentage of each
 * order's delivery charge, rounded per order (same as the Delivery App). Applied to
 * riders that came from the cloud (cdb_…) as a new rule version from today; closed
 * days keep their rule. POS-only riders keep their POS rules.
 */
const commissionNotes = new Map(); // riderUserId -> last logged error
function shopDecimals(shopId) {
  const s = getShopSettings(shopId) || {};
  const d = Number(s.currencyDecimals ?? s.currency_decimals);
  return Number.isInteger(d) && d >= 0 && d <= 4 ? d : 3;
}

/**
 * GTCT Analytics rider commission -> POS commission rule (one type per rider):
 *  DELIVERY_CHARGE (default) -> % of delivery charge, per order
 *  BILL_TOTAL               -> % of the full bill (delivery charge included), per order
 *  DAILY_TARGET             -> fixed amount by the day's delivered bill total (highest range)
 */
export function riderCommissionPolicy(r, decimals) {
  const none = { method: "NONE", period: "DAILY" };
  if (!r?.commissionEnabled) return none;
  const type = String(r.commissionType || "DELIVERY_CHARGE").toUpperCase();
  if (type === "DAILY_TARGET") {
    const scale = 10 ** decimals;
    const byThreshold = new Map();
    for (const t of Array.isArray(r.commissionTiers) ? r.commissionTiers.slice(0, 20) : []) {
      const from = Number(t?.fromAmount);
      const amount = Number(t?.amount);
      if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(amount) || amount < 0) continue;
      const thresholdMinor = Math.round(from * scale);
      const rewardMinor = Math.round(amount * scale);
      if (!Number.isSafeInteger(thresholdMinor) || thresholdMinor < 1 || !Number.isSafeInteger(rewardMinor)) continue;
      byThreshold.set(thresholdMinor, { thresholdMinor, rewardMinor });
    }
    const tiers = [...byThreshold.values()].sort((a, b) => a.thresholdMinor - b.thresholdMinor);
    return tiers.length ? { method: "TIERED_FIXED", period: "DAILY", basis: "TOTAL_BILL", tiers } : none;
  }
  const rate = Number(r.commissionRate);
  const rateBps = Math.min(10000, Math.max(0, Math.round((Number.isFinite(rate) ? rate : 0) * 100)));
  if (rateBps <= 0) return none;
  const basis = type === "BILL_TOTAL" ? "TOTAL_BILL" : "DELIVERY_CHARGE";
  return { method: "PERCENTAGE", period: "DAILY", basis, rateBps, rounding: "PER_ORDER" };
}

export function applyRiderCommissions(shopId, riders) {
  if (!Array.isArray(riders)) return;
  const db = getDb();
  for (const r of riders.slice(0, 100)) {
    const boyId = sanitizeBoyId(r?.deliveryBoyId);
    if (!boyId) continue;
    const userId = `cdb_${boyId}`.slice(0, 120);
    const exists = db.prepare(`SELECT 1 FROM staff_users WHERE shop_id = ? AND user_id = ?`).get(shopId, userId);
    if (!exists) continue; // created when the rider first takes an order
    const policy = riderCommissionPolicy(r, shopDecimals(shopId));
    try {
      db.transaction(() =>
        assignStaffRiderCommissionInTx(db, shopId, userId, policy, { role: "system", userId: "cloud_bridge" })
      )();
      commissionNotes.delete(userId);
    } catch (err) {
      // e.g. today's commission is already booked: the new rate starts next business day.
      if (commissionNotes.get(userId) !== err.code) {
        commissionNotes.set(userId, err.code);
        log.warn("rider commission from cloud not applied yet", { riderUserId: userId, code: err.code, error: err.message });
      }
    }
  }
}

/** The rider's multiple-payment split from a cloud payment report (null if none). */
function riderSplitFromReport(report) {
  if (!report || !(report.multi === true || String(report.status || "").toUpperCase() === "PARTIAL_SHOP")) {
    return null;
  }
  const keys = ["cashCents", "shopPaidCents", "creditCents"];
  if (!keys.some((k) => report[k] != null)) return null;
  const out = {};
  for (const k of keys) out[k] = Math.max(0, Math.round(Number(report[k]) || 0));
  return out;
}

/* A rider payment the POS cannot accept is kept in the cloud and retried, but less
   and less often (never dropped), and logged only now and then. */
const paymentRetry = new Map(); // orderId -> { failures, nextAt }
function paymentRetryDue(orderId) {
  const r = paymentRetry.get(orderId);
  return !r || Date.now() >= r.nextAt;
}
function notePaymentFailure(orderId, err) {
  const r = paymentRetry.get(orderId) || { failures: 0, nextAt: 0 };
  r.failures += 1;
  const waitMs = Math.min(30 * 60 * 1000, 8000 * 2 ** Math.min(r.failures, 12));
  r.nextAt = Date.now() + waitMs;
  paymentRetry.set(orderId, r);
  if (r.failures <= 3 || r.failures % 20 === 0) {
    log.warn("cloud payment apply failed — needs attention", {
      orderId,
      error: err.message,
      failures: r.failures,
      nextTryInMinutes: Math.round(waitMs / 60000),
    });
  }
}

const CLOUD_DELIVERY_PERMS = [
  "delivery.pool.view",
  "delivery.pool.accept",
  "delivery.payment.report",
  "delivery.status.update",
];

function cloudDriverActor(userId) {
  return {
    role: "delivery",
    userId,
    permissions: CLOUD_DELIVERY_PERMS,
  };
}

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

const SECRET_FILE_NAME = "cloud-bridge.secret";

/** Key saved from Shop Settings lives next to the database (works on Windows and Mac). */
function dataDirSecretPath(envConfig = {}) {
  const dir = String(envConfig.dataDir || process.env.GTCT_LOCAL_DATA_DIR || "").trim();
  return dir ? path.join(dir, SECRET_FILE_NAME) : "";
}

function bridgeSecretCandidates(envConfig = {}) {
  const override = String(process.env.GTCT_CLOUD_BRIDGE_SECRET_FILE || "").trim();
  return [
    override,
    dataDirSecretPath(envConfig),
    path.join(os.homedir(), "Library/Application Support/GTCT/RestaurantLocalServer", SECRET_FILE_NAME),
  ].filter(Boolean);
}

function readBridgeSecretFile(envConfig = {}) {
  for (const file of bridgeSecretCandidates(envConfig)) {
    try {
      if (!fs.existsSync(file)) continue;
      const value = fs.readFileSync(file, "utf8").replace(/\r?\n/g, "").trim();
      if (value) return value;
    } catch {
      /* try the next place */
    }
  }
  return "";
}

/* ---------- Per-shop activation (one-time code -> this POS's own key) ---------- */
const DEVICE_FILE_NAME = "cloud-bridge-device.json";

function deviceFilePath(envConfig = {}) {
  const dir = String(envConfig.dataDir || process.env.GTCT_LOCAL_DATA_DIR || "").trim();
  return dir ? path.join(dir, DEVICE_FILE_NAME) : "";
}

function readBridgeDevice(envConfig = {}) {
  const file = deviceFilePath(envConfig);
  if (!file || !fs.existsSync(file)) return null;
  try {
    const row = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!/^pos_[A-Za-z0-9_-]{8,40}$/.test(String(row.deviceId || ""))) return null;
    if (String(row.deviceKey || "").length < 32 || !String(row.clientId || "").trim()) return null;
    return row;
  } catch {
    return null;
  }
}

function writePrivateFile(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows */
  }
}

function activationUrl(bridgeUrl) {
  const url = new URL(bridgeUrl);
  url.pathname = url.pathname.replace(/[^/]*$/, "activateRestaurantPos");
  return url.toString();
}

/** Status of this POS's activation (never includes the key). */
export function cloudBridgeActivationStatus(envConfig = {}) {
  const device = readBridgeDevice(envConfig);
  if (!device) return { activated: false };
  return {
    activated: true,
    clientId: device.clientId,
    clientName: device.clientName || device.clientId,
    deviceId: device.deviceId,
    activatedAt: device.activatedAt || null,
  };
}

/**
 * Exchange a one-time activation code (from GTCT cloud admin) for this POS's
 * own key, then turn the bridge on for that shop.
 */
export async function activateCloudBridge(shopId, envConfig, rawCode) {
  const code = String(rawCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 10) fail(400, "Enter the 10-character activation code (like ABCDE-FGH23).", "invalid_code");
  const file = deviceFilePath(envConfig);
  if (!file) fail(500, "No data folder configured for this server.", "no_data_dir");
  const cfg = bridgeConfig(shopId, envConfig);
  const shop = getShopSettings(shopId);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let res;
  try {
    res = await fetch(activationUrl(cfg.url), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceLabel: String(shop.displayName || "").slice(0, 60) }),
      signal: ac.signal,
    });
  } catch (err) {
    fail(503, err?.name === "AbortError" ? "The cloud did not answer. Check the internet and try again." : "Cannot reach the cloud. Check the internet and try again.", "BRIDGE_UNREACHABLE");
  } finally {
    clearTimeout(timer);
  }
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  if (!res.ok || !json.ok) fail(res.status || 400, json.error || "Activation failed.", "activation_failed");
  const device = {
    clientId: String(json.clientId || "").trim(),
    clientName: String(json.clientName || "").trim(),
    deviceId: String(json.deviceId || "").trim(),
    deviceKey: String(json.deviceKey || "").trim(),
    activatedAt: nowIso(),
  };
  if (!device.clientId || !/^pos_[A-Za-z0-9_-]{8,40}$/.test(device.deviceId) || device.deviceKey.length < 32) {
    fail(502, "The cloud sent an unexpected answer.", "activation_bad_response");
  }
  writePrivateFile(file, `${JSON.stringify(device)}\n`);
  updateShopSettings(shopId, { cloudClientId: device.clientId, cloudBridgeEnabled: true }, { role: "admin" });
  return cloudBridgeActivationStatus(envConfig);
}

/** Forget this POS's activation (the cloud key should also be revoked by the admin). */
export function deactivateCloudBridge(envConfig = {}) {
  const file = deviceFilePath(envConfig);
  if (file && fs.existsSync(file)) fs.rmSync(file, { force: true });
  return cloudBridgeActivationStatus(envConfig);
}

/** Whether a bridge key is configured. Never returns the key itself. */
export function cloudBridgeSecretStatus(envConfig = {}) {
  if (String(process.env.GTCT_CLOUD_BRIDGE_SECRET || "").trim()) {
    return { set: true, source: "environment", editable: false };
  }
  return { set: Boolean(readBridgeSecretFile(envConfig)), source: "file", editable: Boolean(dataDirSecretPath(envConfig)) };
}

/** Save (or clear, with an empty value) the bridge key from Shop Settings. Owner-only file. */
export function saveCloudBridgeSecret(envConfig, rawSecret) {
  if (String(process.env.GTCT_CLOUD_BRIDGE_SECRET || "").trim()) {
    fail(409, "The key is set by the server environment on this PC; change it there.", "secret_from_env");
  }
  const file = dataDirSecretPath(envConfig);
  if (!file) fail(500, "No data folder configured for this server.", "no_data_dir");
  const secret = String(rawSecret ?? "").trim();
  if (!secret) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    return cloudBridgeSecretStatus(envConfig);
  }
  if (secret.length < 16 || secret.length > 256) {
    fail(400, "The key must be 16 to 256 characters.", "invalid_secret");
  }
  if (/[\s\x00-\x1f\x7f]/.test(secret)) {
    fail(400, "The key cannot contain spaces or line breaks.", "invalid_secret");
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows: the data folder is already private to this PC */
  }
  return cloudBridgeSecretStatus(envConfig);
}

function bridgeConfig(shopId, envConfig = {}) {
  const shop = getShopSettings(shopId);
  const clientId =
    String(shop.cloudClientId || envConfig.cloudClientId || "").trim() ||
    String(process.env.GTCT_CLOUD_CLIENT_ID || "").trim();
  const enabled =
    Boolean(shop.cloudBridgeEnabled) ||
    String(process.env.GTCT_CLOUD_BRIDGE_ENABLED || "").trim() === "1" ||
    String(process.env.GTCT_CLOUD_BRIDGE_ENABLED || "").trim().toLowerCase() ===
      "true";
  const url =
    String(shop.cloudBridgeUrl || "").trim() ||
    String(process.env.GTCT_CLOUD_BRIDGE_URL || "").trim() ||
    "https://asia-south1-gtct-global-analytics.cloudfunctions.net/restaurantDeliveryBridge";
  const secret =
    String(process.env.GTCT_CLOUD_BRIDGE_SECRET || "").trim() ||
    readBridgeSecretFile(envConfig);
  // An activated POS uses its own key, locked to the shop it was activated for.
  const device = readBridgeDevice(envConfig);
  return {
    clientId: device ? device.clientId : clientId,
    enabled,
    url,
    secret,
    device,
    shop,
  };
}

function sanitizeBoyId(cloudBoyId) {
  return String(cloudBoyId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 80);
}

/** Ensure a local delivery staff row exists for a Firebase delivery boy id. */
export function ensureLocalDriverForCloudBoy(shopId, cloudBoyId, name = "") {
  const boyId = sanitizeBoyId(cloudBoyId);
  if (!boyId) fail(400, "Cloud delivery boy id required.", "CLOUD_BOY_REQUIRED");
  const userId = `cdb_${boyId}`.slice(0, 120);
  const db = getDb();
  const existing = db
    .prepare(`SELECT user_id FROM staff_users WHERE shop_id = ? AND user_id = ?`)
    .get(shopId, userId);
  if (existing) return userId;
  const ts = nowIso();
  const username = `cloud_${boyId}`.slice(0, 40).toLowerCase();
  const passwordHash = hashPassword(randomBytes(24).toString("hex"));
  db.prepare(
    `INSERT INTO staff_users (
       user_id, shop_id, full_name, username, username_normalized, password_hash,
       is_active, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    userId,
    shopId,
    String(name || `Cloud rider ${boyId}`).slice(0, 120),
    username,
    username,
    passwordHash,
    ts,
    ts
  );
  db.prepare(
    `INSERT INTO staff_user_roles (shop_id, user_id, role_id, assigned_at, revoked_at)
     VALUES (?, ?, 'role_delivery', ?, NULL)`
  ).run(shopId, userId, ts);
  return userId;
}

function buildPublishPayload(shopId, order) {
  let bill = null;
  try {
    bill = getDeliveryBillSnapshot(shopId, order.orderId);
  } catch {
    bill = null;
  }
  const claimRevision =
    order.expectedRevision ||
    createHash("sha256")
      .update(`${order.orderId}:${order.updatedAt || order.createdAt || ""}`)
      .digest("hex");
  const totalCents = Number(order.totalCents ?? bill?.totalCents ?? 0);
  const shopPayment = readShopPaymentSnapshot(shopId, order.orderId);
  return {
    localOrderId: order.orderId,
    localShopId: shopId,
    orderNumber: order.orderNumber,
    tokenNumber: order.tokenNumber,
    businessDate: order.businessDate || "",
    customerName: order.customerName || bill?.customerName || "",
    customerPhone: order.customerPhone || bill?.customerPhone || "",
    blockNumber: order.blockNumber || bill?.blockNumber || "",
    roadNumber: order.roadNumber || bill?.roadNumber || "",
    buildingNumber: order.buildingNumber || bill?.buildingNumber || "",
    addressNote: order.addressNote || bill?.addressNote || "",
    currencyCode: order.currencyCode || bill?.currencyCode || "",
    currencyDecimals: Number(order.currencyDecimals ?? bill?.currencyDecimals ?? 2),
    totalCents,
    goodsCents: Number(bill?.goodsCents || 0),
    deliveryChargeCents: Number(bill?.deliveryChargeCents || 0),
    taxCents: Number(bill?.taxCents || 0),
    taxName: bill?.taxName || "",
    shopPayment,
    paymentStatus: shopPayment.status,
    // Rider multiple payment: the shop's review of each part (shown on the rider's phone).
    splitReview: (() => {
      try {
        const r = readSplitReview(getDb(), shopId, order.orderId);
        return r
          ? {
              reportVersion: r.reportVersion,
              cashCents: r.cash.requiredCents,
              shopPaidCents: r.shopPaid.requiredCents,
              creditCents: r.credit.requiredCents,
              cash: r.cash.state,
              shopPaid: r.shopPaid.state,
              credit: r.credit.state,
              creditRejectNote: r.credit.rejectNote || "",
              complete: r.complete,
            }
          : null;
      } catch {
        return null;
      }
    })(),
    claimRevision,
    prepRevision: order.expectedRevision || claimRevision,
    lines: (bill?.lines || []).map((line) => {
      const instructions = Array.isArray(line.instructions)
        ? line.instructions
        : [];
      let splitNo = Number(line.splitNo);
      if (!Number.isFinite(splitNo) || splitNo < 1) {
        for (const raw of instructions) {
          const match = String(raw || "")
            .trim()
            .match(/^Order\s+(\d+)$/i);
          if (match) {
            splitNo = Number(match[1]);
            break;
          }
        }
      }
      return {
        name: line.name,
        variantName: line.variantName || "",
        quantity: Number(line.quantity || 0),
        lineTotalCents: Number(line.lineTotalCents || 0),
        splitNo: Number.isFinite(splitNo) && splitNo >= 1 ? Math.trunc(splitNo) : null,
        instructions,
        addons: line.addons || [],
      };
    }),
  };
}

async function postBridge(url, auth, body) {
  const timeoutMs = Math.max(
    2000,
    Number(process.env.GTCT_CLOUD_BRIDGE_TIMEOUT_MS || 8000)
  );
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(auth.device
          ? {
              "X-GTCT-DEVICE-ID": auth.device.deviceId,
              "X-GTCT-DEVICE-KEY": auth.device.deviceKey,
            }
          : { "X-GTCT-BRIDGE-SECRET": auth.secret }),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      fail(504, "Cloud bridge timed out.", "BRIDGE_TIMEOUT");
    }
    fail(
      503,
      err?.message || "Cloud bridge unreachable.",
      "BRIDGE_UNREACHABLE"
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    fail(res.status, json?.error || `Bridge HTTP ${res.status}`, "BRIDGE_HTTP");
  }
  return json;
}

function applyClaim(shopId, claim) {
  const db = getDb();
  const orderId = String(claim.localOrderId || "").trim();
  if (!orderId) return false;
  const existing = db
    .prepare(
      `SELECT driver_user_id FROM order_delivery_claims WHERE shop_id = ? AND order_id = ?`
    )
    .get(shopId, orderId);
  if (existing) return true;
  const order = db
    .prepare(`SELECT order_id, status FROM orders WHERE tenant_id = ? AND order_id = ?`)
    .get(shopId, orderId);
  if (!order || order.status !== "OPEN") return false;
  const driverUserId = ensureLocalDriverForCloudBoy(
    shopId,
    claim.claimedByDeliveryBoyId,
    claim.claimedByName || ""
  );
  const prepRevision =
    String(claim.prepRevision || "").length === 64
      ? claim.prepRevision
      : createHash("sha256").update(`cloud:${orderId}:${claim.claimedAt || ""}`).digest("hex");
  const at =
    claim.claimedAt != null
      ? new Date(Number(claim.claimedAt)).toISOString()
      : nowIso();
  db.prepare(
    `INSERT INTO order_delivery_claims
       (shop_id, order_id, driver_user_id, accepted_at, prep_revision)
     VALUES (?, ?, ?, ?, ?)`
  ).run(shopId, orderId, driverUserId, at, prepRevision);
  recordAudit({
    actorRole: "delivery",
    actorUserId: driverUserId,
    action: "delivery.order.accept.cloud",
    entityType: "order_delivery_claim",
    entityId: orderId,
    detail: {
      shopId,
      orderId,
      cloudDeliveryBoyId: claim.claimedByDeliveryBoyId,
      source: "cloud_bridge",
    },
  });
  return true;
}

function resolveClaimedDriver(shopId, row) {
  const db = getDb();
  const orderId = String(row.localOrderId || "").trim();
  if (!orderId) return null;
  const claim = db
    .prepare(
      `SELECT driver_user_id FROM order_delivery_claims WHERE shop_id = ? AND order_id = ?`
    )
    .get(shopId, orderId);
  if (claim?.driver_user_id) return claim.driver_user_id;
  if (!row.claimedByDeliveryBoyId) return null;
  return ensureLocalDriverForCloudBoy(
    shopId,
    row.claimedByDeliveryBoyId,
    row.claimedByName || ""
  );
}

function applyStatus(shopId, row) {
  const orderId = String(row.localOrderId || "").trim();
  if (!orderId) return false;
  const life = row.deliveryLifecycle || {};
  const cloudStatus = String(life.status || row.status || "").toUpperCase();
  if (!["DELIVERED", "CANCEL_REQUESTED"].includes(cloudStatus)) {
    // Nothing local to apply yet (still claimed/available).
    return true;
  }
  const driverUserId = resolveClaimedDriver(shopId, row);
  if (!driverUserId) return false;
  // Ensure claim exists before lifecycle update.
  applyClaim(shopId, row);
  const db = getDb();
  const local = readDeliveryLifecycle(db, shopId, orderId, true);
  if (local.status === cloudStatus) return true;
  if (local.status !== "PENDING") return true;
  const action = cloudStatus === "DELIVERED" ? "DELIVERED" : "REQUEST_CANCEL";
  const note =
    cloudStatus === "CANCEL_REQUESTED"
      ? String(life.reason || "Cancelled via cloud delivery app").slice(0, 400)
      : "";
  markDeliveryLifecycle(
    shopId,
    orderId,
    action,
    local.version,
    note,
    cloudDriverActor(driverUserId)
  );
  return true;
}

function applyPayment(shopId, row) {
  const orderId = String(row.localOrderId || "").trim();
  if (!orderId) return false;
  const report = row.paymentReport || {};
  const kind = String(report.status || "").toUpperCase();
  if (!kind || kind === "UNMARKED") return true;
  if (
    ![
      "CASH_WITH_BOY",
      "SHOP_PAID_REPORTED",
      "CREDIT_REPORTED",
      "PARTIAL_SHOP",
    ].includes(kind)
  ) {
    // Shop-confirmed states stay local-cashier owned.
    return true;
  }
  const driverUserId = resolveClaimedDriver(shopId, row);
  if (!driverUserId) return false;
  applyClaim(shopId, row);
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT report_type, version, cash_cents, shop_paid_cents, credit_cents
       FROM delivery_order_payment_reports
       WHERE shop_id = ? AND order_id = ?`
    )
    .get(shopId, orderId);
  const split = kind === "PARTIAL_SHOP" ? riderSplitFromReport(report) : null;
  const sameSplit = split
    ? existing?.cash_cents != null &&
      Number(existing.cash_cents) === split.cashCents &&
      Number(existing.shop_paid_cents) === split.shopPaidCents &&
      Number(existing.credit_cents) === split.creditCents
    : true;
  if (existing && String(existing.report_type) === kind && sameSplit) return true;
  // Cashier settlement already recorded — nothing for the rider report to apply.
  try {
    const payment = getOrderPayment(orderId, shopId);
    if (
      ["PAID", "CREDIT"].includes(String(payment.paymentStatus || "").toUpperCase()) &&
      ["SHOP_PAID_REPORTED", "CREDIT_REPORTED", "PARTIAL_SHOP"].includes(kind)
    ) {
      return true;
    }
  } catch {
    // fall through to normal apply
  }
  const expectedVersion = Number(existing?.version || 0);
  markDeliveryPayment(
    shopId,
    orderId,
    kind,
    expectedVersion,
    cloudDriverActor(driverUserId),
    split ? { split } : {}
  );
  return true;
}

/**
 * One sync tick: publish available pool + apply remote accepts/status/payment.
 * Safe no-op when bridge is disabled or not configured.
 */
export async function syncCloudDeliveryBridge(shopId, envConfig = {}) {
  const cfg = bridgeConfig(shopId, envConfig);
  if (!cfg.enabled) {
    return { skipped: true, reason: "disabled" };
  }
  if (!cfg.clientId) {
    return { skipped: true, reason: "missing_client_id" };
  }
  if (!cfg.secret && !cfg.device) {
    log.warn("cloud delivery bridge skipped", { reason: "missing_secret" });
    return { skipped: true, reason: "missing_secret" };
  }

  // Bridge actor is synthetic; listAvailableDeliveries requires delivery guard.
  // Publish ready pool + claimed open orders so shop payment updates sync.
  const publishSource = listPublishableDeliveryOrders(shopId);
  const publishOrders = publishSource.map((order) =>
    buildPublishPayload(shopId, order)
  );

  const response = await postBridge(cfg.url, cfg, {
    clientId: cfg.clientId,
    publishOrders,
  });

  const ackClaimIds = [];
  for (const claim of response.pendingClaims || []) {
    try {
      if (applyClaim(shopId, claim)) ackClaimIds.push(claim.id);
    } catch (err) {
      log.warn("cloud claim apply failed", {
        orderId: claim.localOrderId,
        error: err.message,
      });
    }
  }

  applyRiderCommissions(shopId, response.riders);

  const ackStatusIds = [];
  for (const row of response.pendingStatuses || []) {
    try {
      if (applyStatus(shopId, row)) ackStatusIds.push(row.id);
    } catch (err) {
      log.warn("cloud status apply failed", {
        orderId: row.localOrderId,
        error: err.message,
      });
    }
  }

  const ackPaymentIds = [];
  for (const row of response.pendingPayments || []) {
    const key = String(row.localOrderId || row.id || "");
    if (!paymentRetryDue(key)) continue;
    try {
      if (applyPayment(shopId, row)) {
        ackPaymentIds.push(row.id);
        paymentRetry.delete(key);
      }
    } catch (err) {
      notePaymentFailure(key, err);
    }
  }

  if (ackClaimIds.length || ackStatusIds.length || ackPaymentIds.length) {
    await postBridge(cfg.url, cfg, {
      clientId: cfg.clientId,
      publishOrders: [],
      ackClaimIds,
      ackStatusIds,
      ackPaymentIds,
    });
  }

  return {
    skipped: false,
    clientId: cfg.clientId,
    published: publishOrders.length,
    claimsApplied: ackClaimIds.length,
    statusesApplied: ackStatusIds.length,
    paymentsApplied: ackPaymentIds.length,
  };
}

function listPublishableDeliveryOrders(shopId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT o.*, c.order_id AS claimed_order_id FROM orders o
       LEFT JOIN order_delivery_claims c
         ON c.shop_id = o.tenant_id AND c.order_id = o.order_id
       WHERE o.tenant_id = ? AND o.is_test = 1 AND o.status = 'OPEN'
         AND o.fulfillment_behavior = 'DELIVERY'
       ORDER BY o.created_at ASC
       LIMIT 250`
    )
    .all(shopId);
  const out = [];
  const seen = new Set();
  for (const o of rows) {
    const claimed = Boolean(o.claimed_order_id);
    const state = readOrderOperationalState(db, shopId, o);
    // Unclaimed: only when ready for the pool. Claimed: always sync payment.
    if (!claimed && !state.dispatch.ready) continue;
    if (seen.has(o.order_id)) continue;
    seen.add(o.order_id);
    out.push({
      orderId: o.order_id,
      orderNumber: o.order_number,
      tokenNumber: o.token_number == null ? null : Number(o.token_number),
      businessDate: o.business_date || "",
      customerName: o.customer_name || "",
      customerPhone: o.customer_phone || "",
      blockNumber: o.block_number || "",
      roadNumber: o.road_number || "",
      buildingNumber: o.building_number || "",
      addressNote: o.address_note || "",
      currencyCode: o.currency_code || "",
      currencyDecimals: Number(o.currency_decimals ?? 2),
      totalCents: Number(o.total_cents || 0),
      createdAt: o.created_at,
      updatedAt: o.updated_at,
      expectedRevision: state.dispatch.revision || "",
    });
    if (out.length >= 150) break;
  }
  return out;
}

/** Background loop pauses after failures so local POS stays responsive offline. */
let bridgeFailStreak = 0;
let bridgePauseUntilMs = 0;

export function resetCloudBridgeBackoff() {
  bridgeFailStreak = 0;
  bridgePauseUntilMs = 0;
}

function noteBridgeSuccess() {
  resetCloudBridgeBackoff();
}

function noteBridgeFailure() {
  bridgeFailStreak += 1;
  // 15s → 30s → 60s → 120s → 240s, cap 5 minutes.
  const delayMs = Math.min(
    300_000,
    15_000 * 2 ** Math.min(bridgeFailStreak - 1, 4)
  );
  bridgePauseUntilMs = Date.now() + delayMs;
  return delayMs;
}

export function startCloudDeliveryBridgeLoop(config) {
  const shopId = config.testTenantId;
  let timer = null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    if (Date.now() < bridgePauseUntilMs) return;
    busy = true;
    try {
      const result = await syncCloudDeliveryBridge(shopId, config);
      if (result.skipped) {
        // Disabled / not configured — stay quiet, no backoff noise.
        noteBridgeSuccess();
        return;
      }
      noteBridgeSuccess();
      if (result.published || result.claimsApplied || result.statusesApplied || result.paymentsApplied) {
        log.info("cloud delivery bridge sync", result);
      }
    } catch (err) {
      const nextRetryMs = noteBridgeFailure();
      log.warn("cloud delivery bridge error", {
        error: err.message,
        failStreak: bridgeFailStreak,
        nextRetryMs,
      });
    } finally {
      busy = false;
    }
  };
  timer = setInterval(() => {
    void tick();
  }, Number(process.env.GTCT_CLOUD_BRIDGE_INTERVAL_MS || 8000));
  void tick();
  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
