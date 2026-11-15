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
import { getShopSettings } from "./shopSettings.js";
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
import { log } from "../util/logger.js";

/** Same payment truth Monitor uses (allocations + balances + credit). */
function readShopPaymentSnapshot(shopId, orderId) {
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
      return {
        status: "CREDIT",
        cashCents: Number(payment.cashCents || 0),
        bankCents: Number(payment.bankCents || 0),
        creditCents: Number(
          payment.creditCents || payment.orderTotalCents || payment.paidCents || 0
        ),
        verified: true,
      };
    }
    return {
      status,
      cashCents: Number(payment.cashCents || 0),
      bankCents: Number(payment.bankCents || 0),
      creditCents: Number(payment.creditCents || 0),
      verified: status !== "UNPAID",
    };
  } catch {
    return {
      status: "UNPAID",
      cashCents: 0,
      bankCents: 0,
      creditCents: 0,
      verified: false,
    };
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

function readBridgeSecretFile() {
  try {
    const override = String(process.env.GTCT_CLOUD_BRIDGE_SECRET_FILE || "").trim();
    const file =
      override ||
      path.join(
        os.homedir(),
        "Library/Application Support/GTCT/RestaurantLocalServer/cloud-bridge.secret"
      );
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8").replace(/\r?\n/g, "").trim();
  } catch {
    return "";
  }
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
    readBridgeSecretFile();
  return { clientId, enabled, url, secret, shop };
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

async function postBridge(url, secret, body) {
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
        "X-GTCT-BRIDGE-SECRET": secret,
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
      `SELECT report_type, version FROM delivery_order_payment_reports
       WHERE shop_id = ? AND order_id = ?`
    )
    .get(shopId, orderId);
  if (existing && String(existing.report_type) === kind) return true;
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
    cloudDriverActor(driverUserId)
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
  if (!cfg.secret) {
    log.warn("cloud delivery bridge skipped", { reason: "missing_secret" });
    return { skipped: true, reason: "missing_secret" };
  }

  // Bridge actor is synthetic; listAvailableDeliveries requires delivery guard.
  // Publish ready pool + claimed open orders so shop payment updates sync.
  const publishSource = listPublishableDeliveryOrders(shopId);
  const publishOrders = publishSource.map((order) =>
    buildPublishPayload(shopId, order)
  );

  const response = await postBridge(cfg.url, cfg.secret, {
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
    try {
      if (applyPayment(shopId, row)) ackPaymentIds.push(row.id);
    } catch (err) {
      log.warn("cloud payment apply failed", {
        orderId: row.localOrderId,
        error: err.message,
      });
    }
  }

  if (ackClaimIds.length || ackStatusIds.length || ackPaymentIds.length) {
    await postBridge(cfg.url, cfg.secret, {
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
