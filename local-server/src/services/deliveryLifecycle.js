/**
 * P2-E2C1: Delivery fulfillment state and shop credit decisions for TEST orders.
 * Independent of Kitchen, orders.status, shop settlements, cash custody and accounting.
 * Credit APPROVED means authorized by shop, NOT posted as receivable.
 * Delivery CANCELLED means delivery cancelled, NOT invoice void/refund.
 */
import { getDb } from '../db/db.js';
import { nowIso } from '../util/time.js';
import { recordAudit } from './audit.js';

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}
function validId(orderId) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(orderId || ''))) {
    fail(404, 'Order not found.', 'ORDER_NOT_FOUND');
  }
  return orderId;
}
function validVersion(version) {
  if (!Number.isSafeInteger(version) || version < 0) {
    fail(400, 'Refresh before changing delivery status.', 'VERSION_REQUIRED');
  }
}
function shortNote(note, required = false) {
  if (typeof note !== 'string' || note.length > 400 || /[\x00-\x08\x0b\x0e-\x1f]/.test(note)) {
    fail(400, 'Note must be under 400 characters.', 'INVALID_NOTE');
  }
  const clean = note.trim();
  if (required && clean.length < 3) fail(400, 'Enter a cancellation reason.', 'REASON_REQUIRED');
  return clean;
}
function ownerGuard(db, shopId, actor) {
  if (actor?.role !== 'delivery' || !actor.userId || !(actor.permissions || []).includes('delivery.status.update')) {
    fail(403, 'Delivery role required.', 'DELIVERY_FORBIDDEN');
  }
  const active = db.prepare(`SELECT 1 FROM staff_users u JOIN staff_user_roles r
    ON r.shop_id = u.shop_id AND r.user_id = u.user_id
    WHERE u.shop_id = ? AND u.user_id = ? AND u.is_active = 1
    AND r.role_id = 'role_delivery' AND r.revoked_at IS NULL`).get(shopId, actor.userId);
  if (!active) fail(403, 'Delivery Boy is inactive.', 'DELIVERY_INACTIVE');
}
function shopGuard(actor) {
  if (!actor?.userId || !['admin', 'cashier'].includes(actor?.role) ||
      !(actor.permissions || []).includes('sales.orders.view')) {
    fail(403, 'Cashier/Admin order permission required.', 'SHOP_FORBIDDEN');
  }
}
function testOrder(db, shopId, orderId) {
  const order = db.prepare(`SELECT o.* FROM orders o WHERE o.tenant_id = ? AND o.order_id = ?`)
    .get(shopId, validId(orderId));
  if (!order) fail(404, 'Order not found.', 'ORDER_NOT_FOUND');
  if (order.is_test !== 1 || order.status !== 'OPEN' || order.fulfillment_behavior !== 'DELIVERY') {
    fail(409, 'Only open TEST delivery orders can be updated.', 'TEST_DELIVERY_REQUIRED');
  }
  return order;
}
function current(db, shopId, orderId) {
  return db.prepare(`SELECT status, version, reason, updated_at, updated_by_role
    FROM delivery_order_lifecycle WHERE shop_id = ? AND order_id = ?`).get(shopId, orderId);
}
function payment(db, shopId, orderId) {
  return db.prepare(`SELECT payment_status FROM order_payment_balances
    WHERE shop_id = ? AND order_id = ?`).get(shopId, orderId);
}
function report(db, shopId, orderId) {
  return db.prepare(`SELECT report_type FROM delivery_order_payment_reports
    WHERE shop_id = ? AND order_id = ?`).get(shopId, orderId);
}
export function readDeliveryLifecycle(db, shopId, orderId, isClaimed = true) {
  const row = isClaimed ? current(db, shopId, orderId) : null;
  return { status: row?.status || 'PENDING', version: Number(row?.version || 0),
    reason: row?.reason || '', updatedAt: row?.updated_at || null,
    updatedByRole: row?.updated_by_role || null };
}
function putState(db, shopId, orderId, state, expectedVersion, actor, reason = '') {
  const now = nowIso();
  db.prepare(`INSERT INTO delivery_order_lifecycle
    (shop_id, order_id, status, version, reason, updated_at, updated_by_user_id, updated_by_role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (shop_id, order_id) DO UPDATE SET
      status=excluded.status, version=excluded.version, reason=excluded.reason,
      updated_at=excluded.updated_at, updated_by_user_id=excluded.updated_by_user_id,
      updated_by_role=excluded.updated_by_role`).run(shopId, orderId, state, expectedVersion + 1,
    reason, now, actor.userId, actor.role);
  recordAudit({ actorRole: actor.role, actorUserId: actor.userId,
    action: 'delivery.lifecycle.update', entityType: 'delivery_order_lifecycle', entityId: orderId,
    detail: { shopId, orderId, status: state, version: expectedVersion + 1, reason } });
  return { orderId, status: state, version: expectedVersion + 1 };
}
export function markDeliveryLifecycle(shopId, orderId, action, expectedVersion, note, actor) {
  validVersion(expectedVersion);
  if (!['DELIVERED', 'REQUEST_CANCEL'].includes(action)) fail(400, 'Unknown action.', 'INVALID_ACTION');
  const db = getDb();
  return db.transaction(() => {
    ownerGuard(db, shopId, actor);
    testOrder(db, shopId, orderId);
    const claim = db.prepare(`SELECT 1 FROM order_delivery_claims WHERE shop_id=? AND order_id=? AND driver_user_id=?`)
      .get(shopId, orderId, actor.userId);
    if (!claim) fail(403, 'You did not accept this order.', 'ORDER_NOT_OWNED');
    const prev = readDeliveryLifecycle(db, shopId, orderId);
    if (prev.version !== expectedVersion) fail(409, 'Delivery status changed. Refresh.', 'STALE_DELIVERY_STATUS');
    if (prev.status !== 'PENDING') fail(409, 'Only pending deliveries can be updated.', 'INVALID_TRANSITION');
    if (action === 'DELIVERED') {
      return putState(db, shopId, orderId, 'DELIVERED', expectedVersion, actor);
    }
    const reason = shortNote(note, true);
    return putState(db, shopId, orderId, 'CANCEL_REQUESTED', expectedVersion, actor, reason);
  }).immediate();
}
export function shopReviewDeliveryCancellation(shopId, orderId, action, expectedVersion, actor) {
  validVersion(expectedVersion);
  if (!['APPROVE_CANCEL','REJECT_CANCEL'].includes(action)) fail(400, 'Unknown action.', 'INVALID_ACTION');
  const db = getDb();
  return db.transaction(() => {
    shopGuard(actor);
    testOrder(db, shopId, orderId);
    const claim = db.prepare(`SELECT 1 FROM order_delivery_claims WHERE shop_id=? AND order_id=?`)
      .get(shopId, orderId);
    if (!claim) fail(409, 'Order not assigned to delivery.', 'NOT_ACCEPTED');
    const prev = readDeliveryLifecycle(db, shopId, orderId);
    if (prev.version !== expectedVersion) fail(409, 'Status changed. Refresh.', 'STALE_DELIVERY_STATUS');
    if (prev.status !== 'CANCEL_REQUESTED') fail(409, 'No cancellation request to review.', 'INVALID_TRANSITION');
    if (action === 'APPROVE_CANCEL') {
      if (payment(db, shopId, orderId)?.payment_status === 'PAID' ||
          db.prepare(`SELECT 1 FROM order_payment_allocations WHERE shop_id=? AND order_id=?`)
            .get(shopId,orderId) ||
          report(db, shopId, orderId)?.report_type === 'CASH_WITH_BOY' ||
          db.prepare(`SELECT 1 FROM delivery_shop_credit_authorizations
            WHERE shop_id=? AND order_id=? AND state='APPROVED'`).get(shopId,orderId) ||
          db.prepare(`SELECT 1 FROM delivery_credit_reviews WHERE shop_id=? AND order_id=? AND decision='CREDIT_APPROVED'`)
            .get(shopId, orderId)) {
        fail(409, 'Payment/credit needs manual resolution before delivery cancellation.', 'FINANCE_REVIEW_REQUIRED');
      }
    }
    return putState(db, shopId, orderId, action === 'APPROVE_CANCEL' ? 'CANCELLED' : 'PENDING',
      expectedVersion, actor, action === 'APPROVE_CANCEL' ? prev.reason : 'Cancellation declined by shop');
  }).immediate();
}
export function reviewDeliveryCredit(shopId, orderId, reportVersion, decision, note, actor) {
  if (!Number.isSafeInteger(reportVersion) || reportVersion <= 0) fail(400, 'Refresh credit request.', 'VERSION_REQUIRED');
  if (!['CREDIT_APPROVED','CREDIT_REJECTED'].includes(decision)) fail(400, 'Unknown decision.', 'INVALID_DECISION');
  const cleanedNote = shortNote(note || '');
  const db = getDb();
  return db.transaction(() => {
    shopGuard(actor);
    testOrder(db, shopId, orderId);
    const lifecycle = readDeliveryLifecycle(db, shopId, orderId);
    if (lifecycle.status === 'CANCELLED' || lifecycle.status === 'CANCEL_REQUESTED') {
      fail(409, 'Cancellation is pending or approved.', 'DELIVERY_CANCELLED');
    }
    if (db.prepare(`SELECT 1 FROM order_payment_allocations WHERE shop_id=? AND order_id=?`)
      .get(shopId,orderId)) {
      fail(409, 'Shop already recorded payment or credit. No second approval.', 'SPLIT_PAYMENT_EXISTS');
    }
    if (payment(db, shopId, orderId)?.payment_status === 'PAID') {
      fail(409, 'Already paid at shop.', 'ALREADY_PAID');
    }
    if (db.prepare(`SELECT 1 FROM delivery_shop_credit_authorizations
      WHERE shop_id=? AND order_id=? AND state='APPROVED'`).get(shopId,orderId)) {
      fail(409, 'Shop already authorized credit. Refresh.', 'SHOP_CREDIT_APPROVED');
    }
    const r = db.prepare(`SELECT report_type,version,driver_user_id FROM delivery_order_payment_reports
      WHERE shop_id=? AND order_id=?`).get(shopId, orderId);
    if (!r || r.report_type !== 'CREDIT_REPORTED') fail(409, 'No credit request to review.', 'NO_CREDIT_REQUEST');
    if (r.version !== reportVersion) fail(409, 'Credit mark changed. Refresh.', 'STALE_CREDIT_REQUEST');
    const existing = db.prepare(`SELECT * FROM delivery_credit_reviews WHERE shop_id=? AND order_id=?`)
      .get(shopId, orderId);
    if (existing && existing.report_version === reportVersion && existing.decision === decision) {
      return { orderId, status: decision, alreadyReviewed: true, ledgerPosted: false };
    }
    if (existing && existing.report_version === reportVersion) {
      fail(409, 'Decision already recorded. Ask Admin to resolve.', 'REVIEW_FINAL');
    }
    const now = nowIso();
    db.prepare(`INSERT INTO delivery_credit_reviews(shop_id,order_id,report_version,decision,reviewed_by_user_id,reviewed_at,note)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(shop_id,order_id) DO UPDATE SET
      report_version=excluded.report_version, decision=excluded.decision,
      reviewed_by_user_id=excluded.reviewed_by_user_id, reviewed_at=excluded.reviewed_at,
      note=excluded.note`).run(shopId, orderId, reportVersion, decision, actor.userId, now, cleanedNote);
    recordAudit({ actorRole: actor.role, actorUserId: actor.userId,
      action:'delivery.credit.review', entityType:'delivery_credit_reviews', entityId:orderId,
      detail:{shopId,orderId,reportVersion,decision,note:cleanedNote,ledgerPosted:false} });
    return { orderId, status:decision, alreadyReviewed:false, ledgerPosted:false };
  }).immediate();
}

/** TEST-only shop direct credit marking. No second approval and NO receivable posting. */
export function shopSetDirectCredit(shopId, orderId, action, expectedVersion, note, actor) {
  validVersion(expectedVersion);
  if (!['APPROVE','REVOKE'].includes(action)) fail(400, 'Unknown credit action.', 'INVALID_ACTION');
  const cleanedNote = shortNote(note || '', action === 'REVOKE');
  const db = getDb();
  return db.transaction(() => {
    shopGuard(actor);
    const order = testOrder(db,shopId,orderId);
    if (Number(order.total_cents) <= 0) fail(409,'Order amount invalid.','INVALID_TOTAL');
    // Shop may authorize credit BEFORE a Delivery Boy claims the order.
    // Rider will see the existing shop decision automatically after claim.
    const life = readDeliveryLifecycle(db,shopId,orderId);
    if (['CANCEL_REQUESTED','CANCELLED'].includes(life.status))
      fail(409,'Resolve cancellation before changing customer credit.','CANCELLATION_PENDING');
    if (action==='APPROVE' && db.prepare(`SELECT 1 FROM order_payment_allocations
      WHERE shop_id=? AND order_id=?`).get(shopId,orderId))
      fail(409,'Payment/credit already allocated by shop. Use Orders payment entry.','SPLIT_PAYMENT_EXISTS');
    if (payment(db,shopId,orderId)?.payment_status === 'PAID')
      fail(409,'Shop already received this order payment.','ALREADY_PAID');
    const cash = report(db,shopId,orderId);
    if (cash?.report_type === 'CASH_WITH_BOY')
      fail(409,'Cash is with rider. Resolve collection before authorizing credit.','CASH_CUSTODY_CONFLICT');
    const riderCredit = db.prepare(`SELECT 1 FROM delivery_credit_reviews
      WHERE shop_id=? AND order_id=? AND decision='CREDIT_APPROVED'`)
      .get(shopId,orderId);
    if (riderCredit) fail(409,'Rider credit was already approved.','ALREADY_CREDIT_APPROVED');
    const existing = db.prepare(`SELECT state,version FROM delivery_shop_credit_authorizations
      WHERE shop_id=? AND order_id=?`).get(shopId,orderId);
    if (Number(existing?.version || 0) !== expectedVersion) {
      fail(409,'Credit authorization changed. Refresh.','STALE_SHOP_CREDIT');
    }
    if (action === 'REVOKE' && existing?.state !== 'APPROVED')
      fail(409,'Only an approved shop credit can be revoked.','NOT_APPROVED');
    if (action === 'APPROVE' && existing?.state === 'APPROVED')
      fail(409,'Credit already approved by shop.','ALREADY_APPROVED');
    const next = action === 'APPROVE' ? 'APPROVED' : 'REVOKED';
    const now = nowIso();
    db.prepare(`INSERT INTO delivery_shop_credit_authorizations
      (shop_id,order_id,state,version,updated_by_user_id,updated_at,note)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(shop_id,order_id) DO UPDATE SET
        state=excluded.state,version=excluded.version,
        updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at,
        note=excluded.note`).run(shopId,orderId,next,expectedVersion+1,actor.userId,now,cleanedNote);
    recordAudit({actorRole:actor.role,actorUserId:actor.userId,
      action:'delivery.shop.credit.'+next.toLowerCase(),
      entityType:'delivery_shop_credit_authorizations',entityId:orderId,
      detail:{shopId,orderId,state:next,version:expectedVersion+1,
        note:cleanedNote,ledgerPosted:false}});
    return {orderId,status: next === 'APPROVED' ? 'CREDIT_APPROVED' : 'CREDIT_UNMARKED',
      version:expectedVersion+1,ledgerPosted:false,shopAuthorized:next==='APPROVED'};
  }).immediate();
}
