/** P2-E3B: TEST-only cashier-confirmed full handover of CASH_WITH_BOY.
 * An atomic custody transfer posts exactly ONE shop cash allocation for the invoice.
 * Does not post sales, credit receivables, commission or expenses.
 * This specialized transaction is intentionally separate from the generic cashier
 * allocation endpoint: that endpoint MUST continue to reject rider-held cash.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/db.js';
import { newId } from '../util/ids.js';
import { nowIso } from '../util/time.js';
import { readAllocationSummary } from './paymentAllocations.js';
import { recordAudit } from './audit.js';

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}
function shopPermission(actor) {
  if (!actor?.userId || !['admin','cashier'].includes(actor.role) ||
    !(actor.permissions || []).includes('sales.payment.receive'))
    fail(403,'Cashier/Admin with payment permission required.','FORBIDDEN');
}
function validOrderId(value) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(value || '')))
    fail(404,'Order not found.','ORDER_NOT_FOUND');
  return String(value);
}
function fingerprintOf(shopId, orderId, input) {
  return createHash('sha256').update(JSON.stringify({
    shopId,orderId,submissionId:input.submissionId,
    reportVersion:input.expectedReportVersion,
    driverUserId:input.driverUserId,
    amountCents:input.amountCents,
    currencyCode:input.currencyCode,
  })).digest('hex');
}
function view(row, replayed = false) {
  return {
    handoverId:row.handover_id,orderId:row.order_id,
    driverUserId:row.driver_user_id,reportVersion:Number(row.report_version),
    amountCents:Number(row.amount_cents),currencyCode:row.currency_code,
    allocationId:row.allocation_id,confirmedByUserId:row.cashier_user_id,
    confirmedAt:row.created_at,created:!replayed,replayed,
  };
}
export function listDeliveryCashHandovers(shopId, actor) {
  shopPermission(actor);
  const db = getDb();
  const pending = db.prepare(`SELECT o.order_id, o.order_number, o.token_number, o.business_date, o.total_cents,
      o.currency_code,o.currency_decimals,o.customer_name,o.block_number,o.delivery_charge_cents,r.driver_user_id,r.amount_cents,
      r.version AS report_version, r.reported_at,u.full_name AS driver_name
    FROM delivery_order_payment_reports r
    JOIN orders o ON o.order_id=r.order_id AND o.tenant_id=r.shop_id
    JOIN order_delivery_claims c ON c.order_id=o.order_id AND c.shop_id=o.tenant_id
      AND c.driver_user_id=r.driver_user_id
    LEFT JOIN staff_users u ON u.shop_id=r.shop_id AND u.user_id=r.driver_user_id
    LEFT JOIN delivery_order_lifecycle l ON l.shop_id=r.shop_id AND l.order_id=r.order_id
    WHERE r.shop_id=? AND r.report_type='CASH_WITH_BOY'
      AND o.is_test=1 AND o.status='OPEN' AND o.fulfillment_behavior='DELIVERY'
      AND l.status='DELIVERED'
      AND NOT EXISTS (SELECT 1 FROM delivery_cash_handovers h
        WHERE h.shop_id=r.shop_id AND h.order_id=r.order_id)
      AND NOT EXISTS (SELECT 1 FROM order_payment_allocations a
        WHERE a.shop_id=r.shop_id AND a.order_id=r.order_id)
      AND NOT EXISTS (SELECT 1 FROM order_settlements s
        WHERE s.shop_id=r.shop_id AND s.order_id=r.order_id)
      AND NOT EXISTS (SELECT 1 FROM order_payment_balances b
        WHERE b.shop_id=r.shop_id AND b.order_id=r.order_id
          AND (b.paid_cents>0 OR b.balance_cents!=o.total_cents OR b.payment_status!='UNPAID'))
      AND NOT EXISTS (SELECT 1 FROM delivery_shop_credit_authorizations sc
        WHERE sc.shop_id=r.shop_id AND sc.order_id=r.order_id AND sc.state='APPROVED')
      AND NOT EXISTS (SELECT 1 FROM delivery_credit_reviews cr
        WHERE cr.shop_id=r.shop_id AND cr.order_id=r.order_id AND cr.decision='CREDIT_APPROVED')
    ORDER BY r.reported_at, o.order_number LIMIT 150`).all(shopId);
  // P2-E3B UI1: scoped delivery roster, including riders without pending cash.
  // Expose only IDs, display names and active flags to authorized cashiers;
  // the existing list permission check and shop_id constraint remain in force.
  const riders = db.prepare(`SELECT DISTINCT u.user_id, u.full_name, u.is_active
    FROM staff_users u
    JOIN staff_user_roles r ON r.shop_id=u.shop_id AND r.user_id=u.user_id
      AND r.role_id='role_delivery' AND r.revoked_at IS NULL
    WHERE u.shop_id=?
    ORDER BY u.is_active DESC, u.full_name COLLATE NOCASE`).all(shopId);
  const history = db.prepare(`SELECT h.handover_id,h.order_id,h.driver_user_id,
      h.report_version,h.amount_cents,h.currency_code,h.allocation_id,
      h.cashier_user_id,h.created_at,o.order_number,o.currency_decimals,o.customer_name,o.block_number,o.delivery_charge_cents,
      u.full_name AS driver_name
    FROM delivery_cash_handovers h
    JOIN orders o ON o.order_id=h.order_id AND o.tenant_id=h.shop_id
    LEFT JOIN staff_users u ON u.shop_id=h.shop_id AND u.user_id=h.driver_user_id
    WHERE h.shop_id=? ORDER BY h.created_at DESC LIMIT 100`).all(shopId);
  return {
    riders: riders.map(r=>({userId:r.user_id,fullName:r.full_name,
      isActive:Boolean(r.is_active)})),
    pending: pending.filter(r => Number(r.total_cents) > 0 &&
      Number(r.amount_cents) === Number(r.total_cents) &&
      Number.isSafeInteger(Number(r.total_cents)))
      .map(r=>({orderId:r.order_id,orderNumber:r.order_number,
        tokenNumber:r.token_number==null?null:Number(r.token_number),
        businessDate:r.business_date,
        driverUserId:r.driver_user_id,driverName:r.driver_name || 'Delivery Boy',
        amountCents:Number(r.amount_cents),currencyCode:r.currency_code,
        currencyDecimals:Number(r.currency_decimals ?? 3),
        reportVersion:Number(r.report_version),reportedAt:r.reported_at,
        customerName:r.customer_name||null,blockNumber:r.block_number||null,
        deliveryChargeMinor:Number(r.delivery_charge_cents||0),commissionMinor:0})),
    history:history.map(r=>({handoverId:r.handover_id,orderId:r.order_id,
      orderNumber:r.order_number,driverUserId:r.driver_user_id,
      driverName:r.driver_name || 'Delivery Boy',amountCents:Number(r.amount_cents),
      currencyCode:r.currency_code,currencyDecimals:Number(r.currency_decimals ?? 3),reportVersion:Number(r.report_version),
      allocationId:r.allocation_id,confirmedByUserId:r.cashier_user_id,
      confirmedAt:r.created_at,customerName:r.customer_name||null,blockNumber:r.block_number||null,
      deliveryChargeMinor:Number(r.delivery_charge_cents||0),commissionMinor:0})),
    note:'TEST ONLY — full delivered-order cash handover. Commission is not deducted.',
  };
}

/** A successful retry with the same submission ID and exact same payload is read-only. */
export function confirmDeliveryCashHandover(shopId, orderIdInput, input, actor) {
  shopPermission(actor);
  const orderId=validOrderId(orderIdInput);
  const submissionId=String(input?.submissionId || '').trim();
  if(!/^[A-Za-z0-9_-]{8,80}$/.test(submissionId))
    fail(400,'Unique submission ID required.','SUBMISSION_REQUIRED');
  const expectedReportVersion=input?.expectedReportVersion;
  const driverUserId=String(input?.driverUserId || '').trim();
  const amountCents=input?.amountCents;
  const currencyCode=String(input?.currencyCode || '').trim();
  if (!Number.isSafeInteger(expectedReportVersion) || expectedReportVersion<1)
    fail(400,'Refresh rider report version.','REPORT_VERSION_REQUIRED');
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(driverUserId))
    fail(400,'Choose an assigned delivery boy.','DRIVER_REQUIRED');
  if (!Number.isSafeInteger(amountCents) || amountCents<=0)
    fail(400,'Enter the exact full amount in minor units.','AMOUNT_REQUIRED');
  if (!/^[A-Z]{3}$/.test(currencyCode))
    fail(400,'Valid currency required.','CURRENCY_REQUIRED');
  const fingerprint=fingerprintOf(shopId,orderId,
    {submissionId,expectedReportVersion,driverUserId,amountCents,currencyCode});
  const db=getDb();
  return db.transaction(()=>{
    const replay=db.prepare(`SELECT * FROM delivery_cash_handovers
      WHERE shop_id=? AND submission_id=?`).get(shopId,submissionId);
    if (replay) {
      if (replay.order_id!==orderId || replay.submission_fingerprint!==fingerprint)
        fail(409,'Submission ID already used for another handover.','SUBMISSION_CONFLICT');
      return view(replay,true);
    }
    const order=db.prepare(`SELECT * FROM orders WHERE tenant_id=? AND order_id=?`)
      .get(shopId,orderId);
    if (!order) fail(404,'Order not found.','ORDER_NOT_FOUND');
    if(Number(order.is_test)!==1 || order.status!=='OPEN' ||
      order.fulfillment_behavior!=='DELIVERY')
      fail(409,'Only open TEST delivery invoices qualify.','ORDER_NOT_ELIGIBLE');
    const total=Number(order.total_cents);
    if (!Number.isSafeInteger(total) || total<=0 ||
      total!==amountCents || order.currency_code!==currencyCode)
      fail(409,'Amount/currency has changed. Refresh.','AMOUNT_MISMATCH');
    const claim=db.prepare(`SELECT driver_user_id FROM order_delivery_claims
      WHERE shop_id=? AND order_id=?`).get(shopId,orderId);
    const report=db.prepare(`SELECT * FROM delivery_order_payment_reports
      WHERE shop_id=? AND order_id=?`).get(shopId,orderId);
    if (!claim || claim.driver_user_id!==driverUserId ||
      !report || report.driver_user_id!==driverUserId ||
      report.report_type!=='CASH_WITH_BOY')
      fail(409,'Order ownership or rider cash report changed.','CUSTODY_NOT_CONFIRMED');
    if (Number(report.version)!==expectedReportVersion ||
      Number(report.amount_cents)!==amountCents || report.currency_code!==currencyCode ||
      Number(report.currency_decimals)!==Number(order.currency_decimals))
      fail(409,'Rider report changed. Refresh.','STALE_RIDER_REPORT');
    const life=db.prepare(`SELECT status FROM delivery_order_lifecycle
      WHERE shop_id=? AND order_id=?`).get(shopId,orderId);
    if (life?.status!=='DELIVERED')
      fail(409,'Delivery Boy must mark the order Delivered first.','NOT_DELIVERED');
    if (db.prepare(`SELECT 1 FROM delivery_shop_credit_authorizations
      WHERE shop_id=? AND order_id=? AND state='APPROVED'`).get(shopId,orderId) ||
      db.prepare(`SELECT 1 FROM delivery_credit_reviews
        WHERE shop_id=? AND order_id=? AND decision='CREDIT_APPROVED'`).get(shopId,orderId))
      fail(409,'Unresolved shop/rider credit decision.','CREDIT_CONFLICT');
    if (db.prepare(`SELECT 1 FROM delivery_cash_handovers WHERE shop_id=? AND order_id=?`)
      .get(shopId,orderId))
      fail(409,'Cash already handed over for this order.','ALREADY_HANDED_OVER');
    const before=readAllocationSummary(db,shopId,orderId,total);
    if (before.hasAllocations || before.legacySettlement ||
      before.paidCents!==0 || before.creditCents!==0 || before.unallocatedCents!==total)
      fail(409,'Payment or credit already recorded. Reconcile before handover.','FINANCIAL_CONFLICT');
    const balance=db.prepare(`SELECT * FROM order_payment_balances
      WHERE shop_id=? AND order_id=?`).get(shopId,orderId);
    if(balance && (balance.payment_status!=='UNPAID' ||
      Number(balance.paid_cents)!==0 || Number(balance.balance_cents)!==total))
      fail(409,'Payment balance needs reconciliation.','BALANCE_CONFLICT');
    const allocationSubmissionId=`rider_${submissionId}`;
    if(db.prepare(`SELECT 1 FROM order_payment_allocations
      WHERE shop_id=? AND submission_id=?`).get(shopId,allocationSubmissionId))
      fail(409,'Settlement reference already used.','ALLOCATION_ID_CONFLICT');
    const at=nowIso();
    const allocationId=newId('alloc');
    const handoverId=newId('hand');
    // The ONLY bypass of the generic CASH_WITH_BOY guard. Cashier confirms
    // physical handover, and both financial allocation and custody linkage
    // are written in the SAME IMMEDIATE transaction.
    db.prepare(`INSERT INTO order_payment_allocations
      (allocation_id,shop_id,order_id,submission_id,submission_fingerprint,
        currency_code,cash_cents,bank_cents,credit_cents,bank_account_id,
        credit_customer_id,created_by_user_id,created_at)
      VALUES (?,?,?,?,?,?,?,0,0,NULL,NULL,?,?)`)
      .run(allocationId,shopId,orderId,allocationSubmissionId,fingerprint,
        currencyCode,amountCents,actor.userId,at);
    db.prepare(`INSERT INTO delivery_cash_handovers
      (handover_id,shop_id,order_id,driver_user_id,report_version,submission_id,
        submission_fingerprint,allocation_id,currency_code,amount_cents,
        cashier_user_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(handoverId,shopId,orderId,driverUserId,expectedReportVersion,
        submissionId,fingerprint,allocationId,currencyCode,amountCents,actor.userId,at);
    db.prepare(`INSERT INTO order_payment_balances
      (shop_id,order_id,currency_code,order_total_cents,paid_cents,balance_cents,
        payment_status,updated_at)
      VALUES (?,?,?,?,?,0,'PAID',?)
      ON CONFLICT(shop_id,order_id) DO UPDATE SET
        currency_code=excluded.currency_code,order_total_cents=excluded.order_total_cents,
        paid_cents=excluded.paid_cents,balance_cents=0,
        payment_status='PAID',updated_at=excluded.updated_at`)
      .run(shopId,orderId,currencyCode,total,total,at);
    const after=readAllocationSummary(db,shopId,orderId,total);
    if(after.cashCents!==total || after.paidCents!==total ||
      after.unallocatedCents!==0 || after.allocationCount!==1)
      fail(409,'Payment reconciliation failed. Transaction rolled back.','RECONCILIATION_FAILED');
    recordAudit({actorRole:actor.role,actorUserId:actor.userId,
      action:'delivery.cash.handover.confirm',entityType:'delivery_cash_handover',
      entityId:handoverId,detail:{shopId,orderId,driverUserId,allocationId,
        submissionId,reportVersion:expectedReportVersion,amountCents,currencyCode,
        commissionDeductedCents:0,customerReceivablePosted:false,shopCashPosted:true}});
    const inserted=db.prepare(`SELECT * FROM delivery_cash_handovers WHERE handover_id=?`)
      .get(handoverId);
    return view(inserted,false);
  }).immediate();
}
