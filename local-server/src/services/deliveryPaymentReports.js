/**
 * P2-E2C0: TEST-only reports entered by the delivery boy.
 * CASH_WITH_BOY means cash in rider custody, not shop cash or a completed sale payment.
 * SHOP_PAID_REPORTED and CREDIT_REPORTED are UNVERIFIED rider observations.
 * Do not create settlement/transaction/receivable/commission entries here.
 */
import { getDb } from '../db/db.js';
import { nowIso } from '../util/time.js';
import { recordAudit } from './audit.js';
import { readAllocationSummary } from './paymentAllocations.js';

const TYPES = new Set([
  'CASH_WITH_BOY',
  'SHOP_PAID_REPORTED',
  'CREDIT_REPORTED',
  'PARTIAL_SHOP',
]);
const SHOP_PAYMENT = 'PAID_CONFIRMED';
function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}
function checkPermission(db, shopId, actor, permission) {
  if (actor?.role !== 'delivery' || !actor?.userId || !(actor.permissions || []).includes(permission)) {
    fail(403, 'Delivery account permission required.', 'DELIVERY_FORBIDDEN');
  }
  const active = db.prepare(`SELECT 1 FROM staff_users u
    JOIN staff_user_roles r ON r.shop_id = u.shop_id AND r.user_id = u.user_id
    WHERE u.shop_id = ? AND u.user_id = ? AND u.is_active = 1
      AND r.role_id = 'role_delivery' AND r.revoked_at IS NULL`).get(shopId, actor.userId);
  if (!active) fail(403, 'Delivery account is not active.', 'DELIVERY_INACTIVE');
}
function getOwnedOrder(db, shopId, orderId, actor) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(String(orderId || ''))) {
    fail(404, 'Order not found.', 'ORDER_NOT_FOUND');
  }
  const row = db.prepare(`SELECT o.*, c.driver_user_id FROM orders o
    JOIN order_delivery_claims c ON c.shop_id = o.tenant_id AND c.order_id = o.order_id
    WHERE o.tenant_id = ? AND o.order_id = ? AND c.driver_user_id = ?`).get(shopId, orderId, actor.userId);
  if (!row) fail(404, 'Order is not assigned to you.', 'ORDER_NOT_OWNED');
  if (Number(row.is_test) !== 1 || row.fulfillment_behavior !== 'DELIVERY') {
    fail(403, 'Only TEST delivery orders are supported.', 'REAL_ORDER_DISABLED');
  }
  return row;
}
function actualPayment(db, shopId, orderId) {
  return db.prepare(`SELECT b.payment_status, b.balance_cents, s.tender, s.created_at
    FROM order_payment_balances b LEFT JOIN order_settlements s
      ON s.shop_id = b.shop_id AND s.order_id = b.order_id
    WHERE b.shop_id = ? AND b.order_id = ?`).get(shopId, orderId);
}
export function readDeliveryPaymentReport(db, shopId, orderId, driverUserId, orderTotalCents = null) {
  const order = db.prepare(`SELECT total_cents FROM orders WHERE tenant_id=? AND order_id=?`).get(shopId,orderId);
  const split = readAllocationSummary(db, shopId, orderId, Number(order?.total_cents || 0));
  if (split.hasAllocations) {
    const status = split.paymentStatus === 'PAID' ? 'PAID_CONFIRMED'
      : split.paymentStatus === 'CREDIT' ? 'CREDIT_APPROVED' : 'PARTIAL_SHOP';
    return {status,verified:status==='PAID_CONFIRMED',shopAuthorized:true,canMark:false,version:0,
      cashCents:split.cashCents,bankCents:split.bankCents,creditCents:split.creditCents,
      unallocatedCents:split.unallocatedCents,amountCents:split.unallocatedCents,
      note:'Shop cashier allocations; customer credit is authorized but not posted to receivables.'};
  }
  const actual = actualPayment(db, shopId, orderId);
  if (actual?.payment_status === 'PAID' || Number(actual?.balance_cents) === 0 && actual?.payment_status) {
    return { status: SHOP_PAYMENT, verified: true, tender: actual.tender || '',
      version: 0, canMark: false, amountCents: 0, note: 'Recorded by shop' };
  }
  // Cashier/Admin decision is authoritative. No second rider credit approval.
  const shopCredit = db.prepare(`SELECT c.state,c.version,c.updated_at,c.note,u.full_name
    FROM delivery_shop_credit_authorizations c
    LEFT JOIN staff_users u ON u.shop_id=c.shop_id AND u.user_id=c.updated_by_user_id
    WHERE c.shop_id=? AND c.order_id=?`).get(shopId,orderId);
  if (shopCredit?.state === 'APPROVED') {
    return {status:'CREDIT_APPROVED',version:0,verified:false,creditAuthorized:true,
      shopAuthorized:true,shopCreditVersion:Number(shopCredit.version),reviewedBy:shopCredit.full_name || 'Cashier/Admin',
      reviewedAt:shopCredit.updated_at,ledgerPosted:false,canMark:false,
      note:'Shop credit authorization recorded; receivable ledger not yet posted'};
  }
  const row = db.prepare(`SELECT * FROM delivery_order_payment_reports
    WHERE shop_id = ? AND order_id = ? AND driver_user_id = ?`).get(shopId, orderId, driverUserId);
  if (!row) return { status: 'UNMARKED', version: 0, verified: false, canMark: true, shopCreditVersion:Number(shopCredit?.version || 0) };
  const review = row.report_type === 'CREDIT_REPORTED' ? db.prepare(`SELECT v.decision, v.reviewed_at, u.full_name
    FROM delivery_credit_reviews v LEFT JOIN staff_users u
      ON u.shop_id = v.shop_id AND u.user_id = v.reviewed_by_user_id
    WHERE v.shop_id=? AND v.order_id=? AND v.report_version=?`).get(shopId, orderId, row.version) : null;
  return { status: review?.decision || row.report_type, version: Number(row.version), verified: false,
    shopCreditVersion:Number(shopCredit?.version || 0),
    creditAuthorized: review?.decision === 'CREDIT_APPROVED',
    ledgerPosted: false, reviewedAt: review?.reviewed_at || null,
    reviewedBy: review?.full_name || null,
    canMark: review?.decision !== 'CREDIT_APPROVED',
    amountCents: Number(row.amount_cents), currencyCode: row.currency_code,
    currencyDecimals: Number(row.currency_decimals),
    amountChanged: orderTotalCents != null && Number(orderTotalCents) !== Number(row.amount_cents),
    reportedAt: row.updated_at };
}
/** Atomic compare-and-set version, with duplicate retry protection. */
export function markDeliveryPayment(shopId, orderId, reportType, expectedVersion, actor) {
  const kind = String(reportType || '').trim().toUpperCase();
  if (!TYPES.has(kind)) fail(400, 'Choose a valid payment observation.', 'INVALID_REPORT_TYPE');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    fail(400, 'Refresh the order before marking payment.', 'VERSION_REQUIRED');
  }
  const db = getDb();
  const tx = db.transaction(() => {
    checkPermission(db, shopId, actor, 'delivery.payment.report');
    const order = getOwnedOrder(db, shopId, orderId, actor);
    const lifecycle = db.prepare(`SELECT status FROM delivery_order_lifecycle WHERE shop_id=? AND order_id=?`)
      .get(shopId, orderId);
    if (lifecycle && ['CANCEL_REQUESTED','CANCELLED'].includes(lifecycle.status)) {
      fail(409, 'Cancellation pending/approved. Ask cashier to resolve.', 'DELIVERY_CANCELLED');
    }
    const directCredit = db.prepare(`SELECT 1 FROM delivery_shop_credit_authorizations
      WHERE shop_id=? AND order_id=? AND state='APPROVED'`).get(shopId,orderId);
    if (directCredit) fail(409, 'Shop has already authorized credit. Refresh.', 'SHOP_CREDIT_APPROVED');
    const approvedCredit = db.prepare(`SELECT 1 FROM delivery_credit_reviews v
      JOIN delivery_order_payment_reports r ON r.shop_id=v.shop_id AND r.order_id=v.order_id
      WHERE v.shop_id=? AND v.order_id=? AND v.report_version=r.version
        AND v.decision='CREDIT_APPROVED'`).get(shopId, orderId);
    if (approvedCredit) fail(409, 'Shop approved credit. Delivery Boy cannot change it.', 'CREDIT_ALREADY_APPROVED');
    if (order.status !== 'OPEN') fail(409, 'Order is no longer open.', 'ORDER_NOT_OPEN');
    if (!Number.isSafeInteger(Number(order.total_cents)) || Number(order.total_cents) <= 0) {
      fail(409, 'Invalid order total. Ask the cashier.', 'INVALID_ORDER_AMOUNT');
    }
    const split = readAllocationSummary(db,shopId,orderId,Number(order.total_cents));
    if (split.hasAllocations) fail(409,'Cashier has already allocated payment. Contact the shop for remaining balance.','SHOP_PARTIAL_PAYMENT');
    const actual = actualPayment(db, shopId, orderId);
    if (actual?.payment_status === 'PAID' || actual?.balance_cents === 0 && actual?.payment_status) {
      fail(409, 'Shop payment is already recorded. Refresh.', 'ALREADY_PAID');
    }
    // Full outstanding only: no partial amounts or payment splitting in this phase.
    if (actual && Number(actual.balance_cents) !== Number(order.total_cents)) {
      fail(409, 'Partial payment requires cashier review.', 'PARTIAL_PAYMENT_UNSUPPORTED');
    }
    const old = db.prepare(`SELECT * FROM delivery_order_payment_reports
      WHERE shop_id = ? AND order_id = ?`).get(shopId, orderId);
    if (old && old.driver_user_id !== actor.userId) {
      fail(409, 'Another delivery owner recorded this order.', 'PAYMENT_OWNER_CONFLICT');
    }
    // Idempotent retry of the immediately previous successful request.
    if (old && old.version === expectedVersion + 1 && old.report_type === kind
      && Number(old.amount_cents) === Number(order.total_cents)) {
      return { created: false, replayed: true, status: kind, version: old.version, orderId };
    }
    if (Number(old?.version || 0) !== expectedVersion) {
      fail(409, 'Payment mark changed. Refresh before updating.', 'STALE_PAYMENT_REPORT');
    }
    const now = nowIso();
    if (!old) {
      db.prepare(`INSERT INTO delivery_order_payment_reports
        (shop_id, order_id, driver_user_id, report_type, amount_cents, currency_code,
         currency_decimals, version, reported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(shopId, orderId, actor.userId, kind, Number(order.total_cents),
          order.currency_code || '', Number(order.currency_decimals ?? 2), now, now);
    } else {
      db.prepare(`UPDATE delivery_order_payment_reports
        SET report_type = ?, amount_cents = ?, currency_code = ?, currency_decimals = ?,
            version = version + 1, updated_at = ?
        WHERE shop_id = ? AND order_id = ? AND driver_user_id = ?`)
        .run(kind, Number(order.total_cents), order.currency_code || '',
          Number(order.currency_decimals ?? 2), now, shopId, orderId, actor.userId);
    }
    recordAudit({ actorRole: 'delivery', actorUserId: actor.userId,
      action: 'delivery.payment.report', entityType: 'delivery_payment_report', entityId: orderId,
      detail: { shopId, orderId, reportType: kind, previousType: old?.report_type || '',
        version: expectedVersion + 1, amountCents: Number(order.total_cents),
        note: 'OBSERVATION_ONLY_NO_LEDGER_POSTING' } });
    return { created: !old, replayed: false, status: kind,
      version: expectedVersion + 1, orderId };
  });
  return tx.immediate();
}
