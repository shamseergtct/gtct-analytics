/**
 * Rider "release order" (un-accept) requests coming from the cloud Delivery App.
 *
 * Allow  -> the rider's claim is removed; the order stays ready, so the bridge
 *           offers it to all riders again (cloud sets it back to AVAILABLE).
 * Refuse -> the order stays with the rider.
 * Allowed only while nothing has happened on the delivery yet: not delivered,
 * no cancel request, no payment reported by the rider.
 */
import { getDb } from '../db/db.js';
import { nowIso } from '../util/time.js';
import { recordAudit } from './audit.js';

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}
function clean(value, max) {
  return String(value ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max);
}

/** Store a request from the cloud (idempotent). Returns true when stored or already known. */
export function recordReleaseRequest(shopId, row) {
  const db = getDb();
  const rr = row?.releaseRequest || {};
  const requestId = clean(rr.requestId, 80);
  const orderId = clean(row?.localOrderId, 120);
  if (!requestId || !orderId) return false;
  const order = db.prepare(`SELECT order_id FROM orders WHERE tenant_id=? AND order_id=?`).get(shopId, orderId);
  if (!order) return true; // unknown here: acknowledge so the cloud stops resending
  const boyId = clean(rr.deliveryBoyId || row.claimedByDeliveryBoyId, 80).replace(/[^a-zA-Z0-9_-]/g, '');
  db.prepare(`INSERT OR IGNORE INTO delivery_release_requests
    (shop_id, request_id, order_id, cloud_doc_id, driver_user_id, rider_name, reason, status, requested_at)
    VALUES (?,?,?,?,?,?,?,'PENDING',?)`).run(
    shopId, requestId, orderId, clean(row.id, 200),
    boyId ? `cdb_${boyId}`.slice(0, 120) : '',
    clean(rr.deliveryBoyName || row.claimedByName, 120),
    clean(rr.reason, 200),
    rr.requestedAt ? new Date(Number(rr.requestedAt)).toISOString() : nowIso()
  );
  return true;
}

/** Latest request for an order that the cashier still has to answer, or null. */
export function readPendingReleaseRequest(db, shopId, orderId) {
  const r = db.prepare(`SELECT request_id, rider_name, reason, requested_at FROM delivery_release_requests
    WHERE shop_id=? AND order_id=? AND status='PENDING' ORDER BY requested_at DESC LIMIT 1`).get(shopId, orderId);
  return r ? { requestId: r.request_id, riderName: r.rider_name, reason: r.reason, requestedAt: r.requested_at } : null;
}

/** Why the claim cannot be released now, or '' when it can. */
function releaseBlocker(db, shopId, orderId) {
  const order = db.prepare(`SELECT status FROM orders WHERE tenant_id=? AND order_id=?`).get(shopId, orderId);
  if (!order) return 'Order not found.';
  if (order.status !== 'OPEN') return 'Order is no longer open.';
  const life = db.prepare(`SELECT status FROM delivery_order_lifecycle WHERE shop_id=? AND order_id=?`).get(shopId, orderId);
  if (life && life.status !== 'PENDING') return 'The delivery boy already marked this order as delivered or asked to cancel it.';
  const report = db.prepare(`SELECT 1 FROM delivery_order_payment_reports WHERE shop_id=? AND order_id=?`).get(shopId, orderId);
  if (report) return 'The delivery boy already reported the payment for this order.';
  const handed = db.prepare(`SELECT 1 FROM delivery_cash_handovers WHERE shop_id=? AND order_id=?`).get(shopId, orderId);
  if (handed) return 'Cash for this order was already handed over.';
  return '';
}

/**
 * Cashier/Admin answer. decision: 'ALLOW' | 'REFUSE'.
 * ALLOW removes the rider's claim (only that rider's, only if nothing happened yet).
 */
export function decideReleaseRequest(shopId, orderId, input, actor) {
  const requestId = clean(input?.requestId, 80);
  const decision = String(input?.decision || '').toUpperCase();
  if (!requestId) fail(400, 'Request id required.', 'REQUEST_REQUIRED');
  if (!['ALLOW', 'REFUSE'].includes(decision)) fail(400, 'Choose Allow or Refuse.', 'INVALID_DECISION');
  const note = clean(input?.note, 200);
  const db = getDb();
  return db.transaction(() => {
    const req = db.prepare(`SELECT * FROM delivery_release_requests WHERE shop_id=? AND request_id=? AND order_id=?`)
      .get(shopId, requestId, orderId);
    if (!req) fail(404, 'Release request not found.', 'REQUEST_NOT_FOUND');
    if (req.status !== 'PENDING') fail(409, 'This request was already answered.', 'ALREADY_DECIDED');
    const at = nowIso();
    if (decision === 'ALLOW') {
      const claim = db.prepare(`SELECT driver_user_id FROM order_delivery_claims WHERE shop_id=? AND order_id=?`)
        .get(shopId, orderId);
      if (claim && req.driver_user_id && claim.driver_user_id !== req.driver_user_id) {
        fail(409, 'This order is now with another delivery boy.', 'OTHER_RIDER');
      }
      const blocker = releaseBlocker(db, shopId, orderId);
      if (blocker) fail(409, blocker, 'RELEASE_BLOCKED');
      if (claim) {
        db.prepare(`DELETE FROM delivery_order_lifecycle WHERE shop_id=? AND order_id=? AND status='PENDING'`).run(shopId, orderId);
        db.prepare(`DELETE FROM order_delivery_claims WHERE shop_id=? AND order_id=?`).run(shopId, orderId);
      }
    }
    db.prepare(`UPDATE delivery_release_requests SET status=?, decided_by_user_id=?, decided_at=?, note=?, decision_sent=0
      WHERE shop_id=? AND request_id=?`).run(decision === 'ALLOW' ? 'APPROVED' : 'REJECTED', actor.userId, at, note, shopId, requestId);
    // Any older open requests for the same order are settled by this answer.
    db.prepare(`UPDATE delivery_release_requests SET status='REJECTED', decided_by_user_id=?, decided_at=?, note='Superseded', decision_sent=1
      WHERE shop_id=? AND order_id=? AND status='PENDING' AND request_id<>?`).run(actor.userId, at, shopId, orderId, requestId);
    recordAudit({ actorRole: actor.role, actorUserId: actor.userId,
      action: decision === 'ALLOW' ? 'delivery.release.allow' : 'delivery.release.refuse',
      entityType: 'delivery_release_request', entityId: requestId,
      detail: { shopId, orderId, riderUserId: req.driver_user_id, note } });
    return { requestId, status: decision === 'ALLOW' ? 'APPROVED' : 'REJECTED' };
  })();
}

/** Decisions the cloud has not applied yet (sent on every sync until confirmed). */
export function unsentReleaseDecisions(shopId) {
  return getDb().prepare(`SELECT request_id, cloud_doc_id, status, note FROM delivery_release_requests
    WHERE shop_id=? AND decision_sent=0 AND status IN ('APPROVED','REJECTED') LIMIT 100`).all(shopId)
    .map((r) => ({ id: r.cloud_doc_id, requestId: r.request_id, decision: r.status, note: r.note }));
}

export function markReleaseDecisionsSent(shopId, requestIds) {
  const stmt = getDb().prepare(`UPDATE delivery_release_requests SET decision_sent=1 WHERE shop_id=? AND request_id=?`);
  for (const id of Array.isArray(requestIds) ? requestIds.slice(0, 200) : []) stmt.run(shopId, String(id));
}
