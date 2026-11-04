/** P2-E2E TEST-only irreversible void of a genuinely unpaid invoice.
 * Never erases order number/token, order lines, payment audit, or print history.
 * Delivery cancellation is separate from invoice void. No financial reversal.
 */
import { getDb } from '../db/db.js';
import { nowIso } from '../util/time.js';
import { newId } from '../util/ids.js';
import { recordAudit } from './audit.js';

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}
function exists(db, sql, shopId, orderId) {
  return !!db.prepare(sql).get(shopId, orderId);
}
export function voidUnpaidTestOrder(shopId, orderId, input, actor) {
  if (actor?.role !== 'admin' || !actor.userId) {
    fail(403, 'Admin login required to void an invoice.', 'VOID_ADMIN_ONLY');
  }
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(orderId || ''))) {
    fail(404, 'Invoice not found.', 'ORDER_NOT_FOUND');
  }
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < 5 || reason.length > 240 || /[\x00-\x08\x0b\x0e-\x1f]/.test(reason)) {
    fail(400, 'Enter a reason (5–240 characters).', 'VOID_REASON_REQUIRED');
  }
  const expectedUpdatedAt = String(input?.expectedUpdatedAt || '');
  if (!expectedUpdatedAt || expectedUpdatedAt.length > 60) {
    fail(400, 'Refresh the invoice before voiding.', 'VOID_REFRESH_REQUIRED');
  }
  const db = getDb();
  return db.transaction(() => {
    const order = db.prepare(`SELECT * FROM orders WHERE tenant_id=? AND order_id=?`)
      .get(shopId, orderId);
    if (!order) fail(404, 'Invoice not found.', 'ORDER_NOT_FOUND');
    if (Number(order.is_test) !== 1) fail(403, 'Only TEST invoices can be voided.', 'VOID_TEST_ONLY');
    if (order.status !== 'OPEN') fail(409, 'Invoice is already closed or voided.', 'VOID_NOT_OPEN');
    if (order.updated_at !== expectedUpdatedAt) fail(409, 'Invoice changed. Refresh and review.', 'VOID_STALE');
    if (exists(db, `SELECT 1 FROM order_settlements WHERE shop_id=? AND order_id=?`, shopId, orderId) ||
        exists(db, `SELECT 1 FROM order_payment_allocations WHERE shop_id=? AND order_id=?`, shopId, orderId) ||
        exists(db, `SELECT 1 FROM order_payment_balances WHERE shop_id=? AND order_id=? AND (paid_cents>0 OR payment_status!='UNPAID' OR balance_cents!=order_total_cents)`, shopId, orderId)) {
      fail(409, 'Payment or credit has been recorded. This invoice requires reconciliation, not void.', 'VOID_PAYMENT_EXISTS');
    }
    if (exists(db, `SELECT 1 FROM delivery_shop_credit_authorizations WHERE shop_id=? AND order_id=? AND state='APPROVED'`, shopId, orderId) ||
        exists(db, `SELECT 1 FROM delivery_credit_reviews WHERE shop_id=? AND order_id=? AND decision='CREDIT_APPROVED'`, shopId, orderId)) {
      fail(409, 'Shop credit is authorized. Reconcile credit before voiding.', 'VOID_CREDIT_EXISTS');
    }
    // Even a reported paid-at-shop amount is unverified, NOT proof of zero cash custody.
    if (exists(db, `SELECT 1 FROM delivery_order_payment_reports WHERE shop_id=? AND order_id=?`, shopId, orderId)) {
      fail(409, 'Delivery Boy has a payment report. Verify cash/credit before voiding.', 'VOID_RIDER_REPORT');
    }
    const claim = db.prepare(`SELECT driver_user_id FROM order_delivery_claims WHERE shop_id=? AND order_id=?`)
      .get(shopId, orderId);
    if (claim) {
      const delivery = db.prepare(`SELECT status FROM delivery_order_lifecycle WHERE shop_id=? AND order_id=?`)
        .get(shopId, orderId);
      if (delivery?.status !== 'CANCELLED') {
        fail(409, 'Cancel the assigned delivery and have the shop approve it before voiding.', 'VOID_DELIVERY_ACTIVE');
      }
    }
    const processing = db.prepare(`SELECT 1 FROM print_jobs WHERE tenant_id=? AND order_id=? AND status='DISPATCHING'`)
      .get(shopId, orderId);
    if (processing) fail(409, 'A print job is processing. Review printer queue before voiding.', 'VOID_PRINT_PROCESSING');
    const at = nowIso();
    const applied = db.prepare(`UPDATE orders SET status='VOID',updated_at=?
      WHERE tenant_id=? AND order_id=? AND status='OPEN' AND is_test=1 AND updated_at=?`)
      .run(at, shopId, orderId, expectedUpdatedAt);
    if (applied.changes !== 1) fail(409, 'Invoice changed. Refresh and review.', 'VOID_STALE');
    db.prepare(`INSERT INTO order_void_events
      (shop_id,order_id,invoice_number,reason,voided_at,voided_by_user_id)
      VALUES (?,?,?,?,?,?)`).run(shopId,orderId,order.order_number,reason,at,actor.userId);
    // Disable unsent TEST tickets without deleting their audit trail.
    const pending = db.prepare(`SELECT job_id,status FROM print_jobs
      WHERE tenant_id=? AND order_id=? AND status IN ('PENDING','FAILED')`).all(shopId,orderId);
    const update = db.prepare(`UPDATE print_jobs SET status='NEEDS_REVIEW',
      last_error='Invoice voided; do not dispatch',updated_at=? WHERE job_id=? AND status=?`);
    const logEvent = db.prepare(`INSERT INTO print_job_events
      (event_id,job_id,from_status,to_status,note,created_at) VALUES (?,?,?,?,?,?)`);
    for (const job of pending) {
      const changed=update.run(at,job.job_id,job.status);
      if (changed.changes !== 1) fail(409,'Printer queue changed. Refresh before voiding.','VOID_PRINT_CHANGED');
      logEvent.run(newId('evt'),job.job_id,job.status,'NEEDS_REVIEW','Invoice voided; print suppressed',at);
    }
    recordAudit({actorRole:actor.role,actorUserId:actor.userId,
      action:'sales.invoice.void',entityType:'order',entityId:orderId,
      detail:{shopId,invoiceNumber:order.order_number,reason,voidedAt:at,
        printJobsSuppressed:pending.length, amountCents:Number(order.total_cents)}});
    return {orderId,invoiceNumber:order.order_number,status:'VOID',voidedAt:at};
  }).immediate();
}
