/**
 * Rider "multiple payment" (PARTIAL_SHOP) review.
 *   cash      — collected by the rider: his account; reaches the shop only through
 *               Cash handover / Rider settlement (never at the counter).
 *   shop paid — customer paid the shop: the cashier confirms it (cash or bank),
 *               unless the shop already recorded that money.
 *   credit    — customer pays later: the shop approves (credit allocation to the
 *               order's customer) or rejects (rider must correct the report).
 * Confirmations go through recordPaymentAllocation, so every existing payment
 * guard, idempotency rule and receipt print applies.
 */
import { getDb } from '../db/db.js';
import { nowIso } from '../util/time.js';
import { recordAudit } from './audit.js';
import { readAllocationSummary, recordPaymentAllocation } from './paymentAllocations.js';

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

/** Cash/bank recorded on the order that came from the rider (handover / settlement). */
export function riderOriginCents(db, shopId, orderId) {
  const row = db.prepare(`SELECT COALESCE(SUM(a.cash_cents + a.bank_cents), 0) AS cents
    FROM order_payment_allocations a
    WHERE a.shop_id = ? AND a.order_id = ?
      AND (a.allocation_id IN (SELECT allocation_id FROM delivery_cash_handovers
                                WHERE shop_id = ? AND order_id = ?)
        OR a.allocation_id IN (SELECT allocation_id FROM delivery_rider_net_settlement_orders
                                WHERE shop_id = ? AND order_id = ?))`)
    .get(shopId, orderId, shopId, orderId, shopId, orderId);
  return Number(row?.cents || 0);
}

/**
 * The rider's report as parts needing shop review, or null when nothing needs it.
 * Every "paid at shop" and every "credit" needs the shop's approval, whether it is
 * a multiple payment or the whole bill in one mode.
 */
function splitReport(db, shopId, orderId) {
  const r = db.prepare(`SELECT * FROM delivery_order_payment_reports
    WHERE shop_id = ? AND order_id = ?`).get(shopId, orderId);
  if (!r) return null;
  const whole = Number(r.amount_cents);
  if (r.report_type === 'PARTIAL_SHOP' && r.cash_cents != null) {
    return { ...r, kind: 'MULTI' };
  }
  if (r.report_type === 'SHOP_PAID_REPORTED') {
    return { ...r, kind: 'SHOP_PAID', cash_cents: 0, shop_paid_cents: whole, credit_cents: 0 };
  }
  if (r.report_type === 'CREDIT_REPORTED') {
    return { ...r, kind: 'CREDIT', cash_cents: 0, shop_paid_cents: 0, credit_cents: whole };
  }
  return null;
}

/** Current state of each part. Read-only. */
export function readSplitReview(db, shopId, orderId) {
  const r = splitReport(db, shopId, orderId);
  if (!r) return null;
  const order = db.prepare(`SELECT total_cents, currency_code, currency_decimals, customer_id
    FROM orders WHERE order_id = ? AND tenant_id = ?`).get(orderId, shopId);
  if (!order) return null;
  const total = Number(order.total_cents);
  const alloc = readAllocationSummary(db, shopId, orderId, total);
  const fromRider = Math.min(riderOriginCents(db, shopId, orderId), alloc.cashCents + alloc.bankCents);
  const counter = alloc.cashCents + alloc.bankCents - fromRider;
  const cashReq = Number(r.cash_cents);
  const shopReq = Number(r.shop_paid_cents || 0);
  const creditReq = Number(r.credit_cents || 0);
  const rejected = db.prepare(`SELECT note, decided_at FROM delivery_split_credit_decisions
    WHERE shop_id = ? AND order_id = ? AND report_version = ? AND decision = 'REJECTED'`)
    .get(shopId, orderId, r.version);
  const cash = { requiredCents: cashReq, handedCents: Math.min(fromRider, cashReq),
    state: cashReq === 0 ? 'NONE' : fromRider >= cashReq ? 'HANDED_OVER' : 'WITH_RIDER' };
  const shopPaid = { requiredCents: shopReq, recordedCents: Math.min(counter, shopReq),
    dueCents: Math.max(0, shopReq - counter),
    state: shopReq === 0 ? 'NONE' : counter >= shopReq ? 'CONFIRMED' : 'PENDING' };
  const credit = { requiredCents: creditReq, recordedCents: Math.min(alloc.creditCents, creditReq),
    dueCents: Math.max(0, creditReq - alloc.creditCents),
    state: creditReq === 0 ? 'NONE' : alloc.creditCents >= creditReq ? 'APPROVED'
      : rejected ? 'REJECTED' : 'PENDING',
    rejectNote: rejected?.note || '' };
  const done = (p) => ['NONE', 'CONFIRMED', 'APPROVED', 'HANDED_OVER'].includes(p.state);
  return {
    orderId, kind: r.kind, reportVersion: Number(r.version), driverUserId: r.driver_user_id,
    totalCents: total, currencyCode: order.currency_code,
    currencyDecimals: Number(order.currency_decimals ?? 3),
    hasOrderCustomer: Boolean(order.customer_id),
    cash, shopPaid, credit,
    shopActionsDone: done(shopPaid) && done(credit),
    complete: done(cash) && done(shopPaid) && done(credit),
  };
}

function guardActor(actor) {
  if (!actor?.userId || !['admin', 'cashier'].includes(actor.role) ||
    !(actor.permissions || []).includes('sales.payment.receive'))
    fail(403, 'Cashier/Admin with payment permission required.', 'FORBIDDEN');
}

function currentReview(db, shopId, orderId, reportVersion) {
  const review = readSplitReview(db, shopId, orderId);
  if (!review) fail(409, 'No delivery boy payment waiting for review on this order.', 'NO_SPLIT_REPORT');
  if (!Number.isSafeInteger(reportVersion) || reportVersion !== review.reportVersion)
    fail(409, 'The delivery boy changed this payment. Refresh.', 'STALE_SPLIT_REPORT');
  return review;
}

/** Cashier confirms the customer's payment at the shop (the part not yet recorded). */
export function confirmSplitShopPaid(shopId, orderId, input, actor) {
  guardActor(actor);
  const db = getDb();
  const review = currentReview(db, shopId, orderId, input?.reportVersion);
  if (review.shopPaid.state !== 'PENDING') fail(409, 'Shop payment is already recorded.', 'NOTHING_TO_CONFIRM');
  const tender = String(input?.tender || '').toUpperCase();
  if (!['CASH', 'BANK'].includes(tender)) fail(400, 'Choose Cash or Bank.', 'TENDER_REQUIRED');
  const due = review.shopPaid.dueCents;
  return recordPaymentAllocation(shopId, orderId, {
    submissionId: input?.submissionId,
    cashCents: tender === 'CASH' ? due : 0,
    bankCents: tender === 'BANK' ? due : 0,
    creditCents: 0,
    ...(tender === 'BANK' ? { bankAccountId: input?.bankAccountId } : {}),
    currencyCode: review.currencyCode,
    printCashier: input?.printCashier,
  }, actor);
}

/** Shop approves the credit part: a credit allocation to the order's customer. */
export function approveSplitCredit(shopId, orderId, input, actor) {
  guardActor(actor);
  const db = getDb();
  const review = currentReview(db, shopId, orderId, input?.reportVersion);
  if (!['PENDING', 'REJECTED'].includes(review.credit.state))
    fail(409, 'No credit waiting for approval.', 'NOTHING_TO_APPROVE');
  const order = db.prepare(`SELECT customer_id FROM orders WHERE order_id = ? AND tenant_id = ?`)
    .get(orderId, shopId);
  const creditCustomerId = order?.customer_id || String(input?.creditCustomerId || '').trim();
  if (!creditCustomerId) fail(400, 'Select the customer who will pay later.', 'CREDIT_CUSTOMER_REQUIRED');
  return recordPaymentAllocation(shopId, orderId, {
    submissionId: input?.submissionId,
    cashCents: 0, bankCents: 0, creditCents: review.credit.dueCents,
    creditCustomerId,
    currencyCode: review.currencyCode,
    printCashier: input?.printCashier,
  }, actor);
}

/** Shop refuses the credit part; the delivery boy must correct his report. */
export function rejectSplitCredit(shopId, orderId, input, actor) {
  guardActor(actor);
  const note = String(input?.note || '').trim().slice(0, 200);
  if (note.length < 3) fail(400, 'Enter a short reason (at least 3 characters).', 'NOTE_REQUIRED');
  const db = getDb();
  return db.transaction(() => {
    const review = currentReview(db, shopId, orderId, input?.reportVersion);
    if (review.credit.state === 'REJECTED') return { ...review, alreadyRejected: true };
    if (review.credit.state !== 'PENDING') fail(409, 'No credit waiting for approval.', 'NOTHING_TO_REJECT');
    const at = nowIso();
    db.prepare(`INSERT INTO delivery_split_credit_decisions
      (shop_id, order_id, report_version, decision, note, decided_by_user_id, decided_at)
      VALUES (?, ?, ?, 'REJECTED', ?, ?, ?)`)
      .run(shopId, orderId, review.reportVersion, note, actor.userId, at);
    recordAudit({ actorRole: actor.role, actorUserId: actor.userId,
      action: 'delivery.split.credit.reject', entityType: 'delivery_split_credit_decisions',
      entityId: orderId, detail: { shopId, orderId, reportVersion: review.reportVersion,
        creditCents: review.credit.requiredCents, note } });
    return readSplitReview(db, shopId, orderId);
  }).immediate();
}
