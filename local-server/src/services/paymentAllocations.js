/** P2-E2C3A — authoritative TEST cashier allocations, not rider observations.
 * Do NOT treat credit authorization as a receivables journal posting.
 * Cash and bank allocations are kept separate from the legacy one-full-payment ledger;
 * any downstream financial integration must reconcile BOTH sources once, by allocation_id.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/db.js';
import { newId } from '../util/ids.js';
import { nowIso } from '../util/time.js';
import { recordAudit } from './audit.js';
import { enqueueCashierReceiptAfterPayment } from './printQueue.js';
import { log } from '../util/logger.js';

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}
function cents(n, key) {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    fail(400, `${key} must be a non-negative integer in minor units.`, 'INVALID_AMOUNT');
  }
  return n;
}
function sum(db, shopId, orderId) {
  return db.prepare(`SELECT COUNT(*) AS entries,
    COALESCE(SUM(cash_cents),0) AS cash,
    COALESCE(SUM(bank_cents),0) AS bank,
    COALESCE(SUM(credit_cents),0) AS credit
    FROM order_payment_allocations WHERE shop_id=? AND order_id=?`).get(shopId,orderId);
}
/** Compatibility: reads the old *one-shot* ledger and the new split ledger. */
export function readAllocationSummary(db, shopId, orderId, totalCents) {
  const old = db.prepare(`SELECT tender, amount_cents FROM order_settlements
    WHERE shop_id=? AND order_id=?`).get(shopId, orderId);
  const parts = sum(db, shopId, orderId);
  const cash = Number(parts.cash) + (old?.tender === 'CASH' ? Number(old.amount_cents) : 0);
  const bank = Number(parts.bank) + (old?.tender === 'BANK' ? Number(old.amount_cents) : 0);
  const credit = Number(parts.credit);
  const paid = cash + bank;
  const unallocated = Number(totalCents) - paid - credit;
  if (unallocated < 0) fail(409, 'Payment ledger exceeds order total. Stop and reconcile.', 'LEDGER_OVERALLOCATED');
  const status = paid === Number(totalCents) ? 'PAID'
    : credit === Number(totalCents) ? 'CREDIT'
    : paid || credit ? 'PARTIAL' : 'UNPAID';
  return { cashCents:cash, bankCents:bank, creditCents:credit,
    paidCents:paid, balanceCents:Number(totalCents)-paid, unallocatedCents:unallocated,
    paymentStatus:status, hasAllocations:Number(parts.entries)>0,
    allocationCount:Number(parts.entries), legacySettlement:Boolean(old) };
}
export function listPaymentAllocations(shopId, orderId) {
  const db = getDb();
  const order = db.prepare(`SELECT order_id, tenant_id, total_cents, currency_code, is_test
    FROM orders WHERE order_id=? AND tenant_id=?`).get(orderId, shopId);
  if (!order) fail(404, 'Order not found.', 'ORDER_NOT_FOUND');
  const rows = db.prepare(`SELECT a.allocation_id, a.cash_cents, a.bank_cents, a.credit_cents,
     a.created_at, a.created_by_user_id, a.credit_customer_id,
     c.name AS credit_customer_name, c.phone AS credit_customer_phone,
     b.display_name AS bank_name
     FROM order_payment_allocations a LEFT JOIN shop_bank_accounts b
       ON b.account_id=a.bank_account_id
     LEFT JOIN shop_customers c ON c.customer_id=a.credit_customer_id AND c.shop_id=a.shop_id
     WHERE a.shop_id=? AND a.order_id=? ORDER BY a.created_at,a.allocation_id`).all(shopId,orderId);
  return { orderId, summary:readAllocationSummary(db,shopId,orderId,order.total_cents),
    allocations:rows.map(r=>({allocationId:r.allocation_id,cashCents:r.cash_cents,
      bankCents:r.bank_cents,creditCents:r.credit_cents,createdAt:r.created_at,
      creditCustomerId:r.credit_customer_id || null,
      creditCustomerName:r.credit_customer_name || '',
      creditCustomerPhone:r.credit_customer_phone || '',
      bankAccountLabel:r.bank_name || ''})) };
}
/** One immutable allocation event; repeat request idempotent, never cash twice. */
export function recordPaymentAllocation(shopId, orderId, input, actor) {
  if (!actor?.userId || !['admin','cashier'].includes(actor.role))
    fail(403, 'Cashier or Admin required.', 'FORBIDDEN');
  const submissionId = String(input?.submissionId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(submissionId))
    fail(400, 'A unique submission ID is required.', 'SUBMISSION_REQUIRED');
  const cash = cents(input?.cashCents, 'Cash');
  const bank = cents(input?.bankCents, 'Bank');
  const credit = cents(input?.creditCents, 'Credit');
  const total = cash + bank + credit;
  if (!Number.isSafeInteger(total) || total <= 0) fail(400,'Enter a payment or credit amount.', 'EMPTY_ALLOCATION');
  const bankAccountId = bank ? String(input?.bankAccountId || '').trim() : '';
  if (bank && !bankAccountId) fail(400, 'Select an operational bank account.', 'BANK_REQUIRED');
  if (!bank && input?.bankAccountId) fail(400, 'Remove bank account if bank amount is zero.', 'BANK_NOT_APPLICABLE');
  const creditCustomerId = String(input?.creditCustomerId || '').trim();
  if (credit && !creditCustomerId) fail(400, 'Select a customer for credit.', 'CREDIT_CUSTOMER_REQUIRED');
  if (!credit && creditCustomerId) fail(400, 'Customer selection is only for credit.', 'CREDIT_CUSTOMER_NOT_APPLICABLE');
  if (creditCustomerId.length > 128) fail(400, 'Invalid credit customer.', 'CREDIT_CUSTOMER_INVALID');
  const currency = String(input?.currencyCode || '').trim();
  const fingerprint = createHash('sha256').update(JSON.stringify({shopId,orderId,submissionId,cash,bank,credit,bankAccountId,currency,...(credit?{creditCustomerId}:{})})).digest('hex');
  const db=getDb();
  const tx=db.transaction(()=>{
    const previous=db.prepare(`SELECT * FROM order_payment_allocations WHERE shop_id=? AND submission_id=?`)
      .get(shopId,submissionId);
    if (previous) {
      if (previous.submission_fingerprint!==fingerprint) fail(409,'Submission ID already used for different payment.', 'SUBMISSION_CONFLICT');
      return {...listPaymentAllocations(shopId,orderId),created:false,replayed:true};
    }
    const order=db.prepare(`SELECT * FROM orders WHERE order_id=? AND tenant_id=?`).get(orderId,shopId);
    if (!order) fail(404,'Order not found.','ORDER_NOT_FOUND');
    if (order.status!=='OPEN' || Number(order.is_test)!==1)
      fail(403,'Only open TEST orders can be allocated.','TEST_ONLY');
    if (!Number.isSafeInteger(Number(order.total_cents)) || Number(order.total_cents)<=0)
      fail(400,'Order total is invalid.','INVALID_ORDER');
    if (currency!==order.currency_code) fail(400,'Currency does not match the order.','CURRENCY_MISMATCH');
    if (credit) {
      const customer = db.prepare(`SELECT customer_id FROM shop_customers
        WHERE customer_id=? AND shop_id=?`).get(creditCustomerId,shopId);
      if (!customer) fail(400,'Choose a customer from this shop.','CREDIT_CUSTOMER_INVALID');
      if (order.customer_id && order.customer_id !== creditCustomerId)
        fail(409,'Credit customer must match the customer already on this order.','ORDER_CUSTOMER_MISMATCH');
      const existingCredit = db.prepare(`SELECT credit_customer_id
        FROM order_payment_allocations WHERE shop_id=? AND order_id=? AND credit_cents>0
        ORDER BY created_at,allocation_id LIMIT 1`).get(shopId,orderId);
      if (existingCredit && !existingCredit.credit_customer_id)
        fail(409,'Existing credit has no linked customer. Reconcile it before adding more credit.','LEGACY_CREDIT_UNLINKED');
      if (existingCredit && existingCredit.credit_customer_id !== creditCustomerId)
        fail(409,'Credit customer must match previous credit on this order.','CREDIT_CUSTOMER_MISMATCH');
    }
    if (bank) {
      const b=db.prepare(`SELECT shop_id,account_type,is_active FROM shop_bank_accounts WHERE account_id=?`).get(bankAccountId);
      if (!b || b.shop_id!==shopId || b.account_type!=='OPERATIONAL' || Number(b.is_active)!==1)
        fail(400,'Choose an active operational bank account.','BANK_NOT_OPERATIONAL');
    }
    const oldCredit = db.prepare(`SELECT state FROM delivery_shop_credit_authorizations
      WHERE shop_id=? AND order_id=?`).get(shopId,orderId);
    if (oldCredit?.state==='APPROVED') fail(409,'Legacy direct-credit authorization exists. Revoke it in Order Monitor before entering a split payment.', 'LEGACY_CREDIT_AUTH');
    if (order.fulfillment_behavior === 'DELIVERY') {
      const life=db.prepare(`SELECT status FROM delivery_order_lifecycle
        WHERE shop_id=? AND order_id=?`).get(shopId,orderId);
      if (life && ['CANCEL_REQUESTED','CANCELLED'].includes(life.status))
        fail(409,'Delivery cancellation is pending/approved. Resolve before allocating payment.','DELIVERY_CANCELLED');
      const report=db.prepare(`SELECT report_type FROM delivery_order_payment_reports
        WHERE shop_id=? AND order_id=?`).get(shopId,orderId);
      if (report?.report_type==='CASH_WITH_BOY')
        fail(409,'Delivery Boy reports holding customer cash. Resolve rider collection and handover before posting shop money/credit.','RIDER_CASH_CUSTODY');
      const riderCredit=db.prepare(`SELECT decision FROM delivery_credit_reviews
        WHERE shop_id=? AND order_id=?`).get(shopId,orderId);
      if (riderCredit?.decision==='CREDIT_APPROVED')
        fail(409,'Previous rider credit approval exists. Reconcile before creating another credit allocation.','LEGACY_CREDIT_APPROVAL');
    }
    const before=readAllocationSummary(db,shopId,orderId,order.total_cents);
    if (before.legacySettlement) fail(409,'Order already settled by legacy payment.', 'ALREADY_PAID');
    if (total>before.unallocatedCents) fail(409,'Allocation exceeds remaining unallocated amount. Refresh.', 'OVERPAYMENT');
    // Rider multiple payment: his cash share is in his custody and may only reach the
    // shop through Cash handover / Rider settlement, never as counter money.
    if (order.fulfillment_behavior === 'DELIVERY') {
      const split=db.prepare(`SELECT cash_cents FROM delivery_order_payment_reports
        WHERE shop_id=? AND order_id=? AND report_type='PARTIAL_SHOP'`).get(shopId,orderId);
      const riderShare=Number(split?.cash_cents || 0);
      if (riderShare>0) {
        const handed=db.prepare(`SELECT COALESCE(SUM(a.cash_cents+a.bank_cents),0) AS cents
          FROM order_payment_allocations a WHERE a.shop_id=? AND a.order_id=?
            AND (a.allocation_id IN (SELECT allocation_id FROM delivery_cash_handovers WHERE shop_id=? AND order_id=?)
              OR a.allocation_id IN (SELECT allocation_id FROM delivery_rider_net_settlement_orders WHERE shop_id=? AND order_id=?))`)
          .get(shopId,orderId,shopId,orderId,shopId,orderId).cents;
        const reserve=Math.max(0,riderShare-Number(handed));
        if (total>before.unallocatedCents-reserve)
          fail(409,'Part of this bill is cash with the Delivery Boy. Take it with Cash handover, not at the counter.','RIDER_CASH_CUSTODY');
      }
    }
    const at=nowIso(); const allocationId=newId('alloc');
    db.prepare(`INSERT INTO order_payment_allocations
      (allocation_id,shop_id,order_id,submission_id,submission_fingerprint,currency_code,
       cash_cents,bank_cents,credit_cents,bank_account_id,credit_customer_id,created_by_user_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(allocationId,shopId,orderId,submissionId,fingerprint,order.currency_code,
        cash,bank,credit,bankAccountId || null,creditCustomerId || null,actor.userId,at);
    const after=readAllocationSummary(db,shopId,orderId,order.total_cents);
    // Legacy-compatible, shop-received money only. Credit remains part of outstanding.
    db.prepare(`INSERT INTO order_payment_balances
      (shop_id,order_id,currency_code,order_total_cents,paid_cents,balance_cents,payment_status,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(shop_id,order_id) DO UPDATE SET
        paid_cents=excluded.paid_cents,balance_cents=excluded.balance_cents,
        payment_status=excluded.payment_status,updated_at=excluded.updated_at`)
      .run(shopId,orderId,order.currency_code,Number(order.total_cents),after.paidCents,
        after.balanceCents,after.paymentStatus==='PAID'?'PAID':'UNPAID',at);
    recordAudit({actorRole:actor.role,actorUserId:actor.userId,action:'payment.split.allocate',
      entityType:'order_payment_allocation',entityId:allocationId,
      detail:{shopId,orderId,submissionId,cashCents:cash,bankCents:bank,
        creditCents:credit,bankAccountId:bankAccountId||null,creditCustomerId:creditCustomerId||null,
        unallocatedBeforeCents:before.unallocatedCents,unallocatedAfterCents:after.unallocatedCents,
        note:'TEST_ONLY_CREDIT_NOT_RECEIVABLE_POSTED'}});
    return {...listPaymentAllocations(shopId,orderId),created:true,replayed:false,
      _paymentSummary:after};
  });
  const result = tx.immediate();
  // Print only when the bill is fully finalized (paid or fully credited).
  let cashierPrint = null;
  const wantCashierPrint = input?.printCashier !== false;
  if (result.created && wantCashierPrint && result._paymentSummary &&
      (result._paymentSummary.paymentStatus === 'PAID' ||
       result._paymentSummary.paymentStatus === 'CREDIT')) {
    try {
      const job = enqueueCashierReceiptAfterPayment(orderId, {
        paymentStatus: result._paymentSummary.paymentStatus,
        paidCents: result._paymentSummary.paidCents,
        creditCents: result._paymentSummary.creditCents,
        cashCents: result._paymentSummary.cashCents,
        bankCents: result._paymentSummary.bankCents,
      }, { testTenantId: shopId });
      cashierPrint = {
        ok: true,
        jobId: job.job_id,
        printerId: job.printer_id,
        status: job.status,
      };
    } catch (err) {
      log.error('Cashier receipt enqueue after allocation failed', {
        orderId,
        error: err instanceof Error ? err.message : String(err),
      });
      cashierPrint = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: err?.code || 'CASHIER_PRINT_FAILED',
      };
    }
  } else if (result.created && !wantCashierPrint) {
    cashierPrint = { ok: true, skipped: true, reason: 'screen_only' };
  }
  if (result._paymentSummary) delete result._paymentSummary;
  return { ...result, cashierPrint };
}
