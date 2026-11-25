/** P2-E3C4: TEST-only net rider cash settlement.
 * Invoice allocations represent gross customer cash PAID VIA RIDER, not physical shop cash.
 * Physical shop cash is represented by independent immutable settlement journal.
 * This phase does not post to a general accounting/ERP ledger, nor bank payments.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/db.js';
import { newId } from '../util/ids.js';
import { nowIso } from '../util/time.js';
import { recordAudit } from './audit.js';
import { riderOriginCents } from './deliverySplitReview.js';
import { readAllocationSummary } from './paymentAllocations.js';
import { listDeliveryCashHandovers } from './deliveryCashHandover.js';
import { approveCommissionAccrual, previewCommissionAccrual } from './deliveryCommissionAccruals.js';

const fail=(status,message,code)=>{throw Object.assign(new Error(message),{status,code});};
const digest=(obj)=>createHash('sha256').update(JSON.stringify(obj)).digest('hex');
function admin(actor){
  if(!actor?.userId || actor.role!=='admin' || !actor.staff ||
     !(actor.permissions||[]).includes('staff.manage') ||
     !(actor.permissions||[]).includes('sales.payment.receive'))
    fail(403,'Staff Admin with staff.manage and sales.payment.receive required.','FORBIDDEN');
}
function safeId(value,name){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(value))
    fail(400,`Invalid ${name}.`,'INVALID_ID');
  return value;
}
function validDate(value){
  if(typeof value!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)
    fail(400,'Valid business date required.','INVALID_DATE');
  return value;
}
function moneyNumber(n){return Number.isSafeInteger(n)&&n>=0;}
function readonlySettlement(row,replayed=false){
  return {settlementId:row.settlement_id,riderUserId:row.rider_user_id,
    businessDate:row.business_date,currencyCode:row.currency_code,
    currencyDecimals:row.currency_decimals,grossMinor:row.gross_minor,
    commissionMinor:row.commission_minor,shopCashMinor:row.shop_cash_minor,
    invoiceCount:row.invoice_count,accrualId:row.accrual_id,
    confirmedAt:row.created_at,confirmedByUserId:row.confirmed_by_user_id,replayed};
}
/** Tender amounts are money moved from rider custody TO THE SHOP; the invoice remains gross-paid. */
function verifiedTender(db,shopId,net,input){
  if(!input) return {cashMinor:net,bankMinor:0,bankAccountId:null,note:''};
  if(!input || typeof input!=='object' || Array.isArray(input))fail(400,'Tender breakdown required.','INVALID_TENDER');
  const cash=input.cashMinor,bank=input.bankMinor;
  if(!moneyNumber(cash)||!moneyNumber(bank)||cash+bank!==net||!Number.isSafeInteger(cash+bank))
    fail(409,'Cash + Bank must exactly equal net collection after commission.','TENDER_NOT_BALANCED');
  const note=String(input.note||'').trim();
  if(note.length>200)fail(400,'Collection note too long.','INVALID_NOTE');
  const accountId=bank>0?safeId(input.bankAccountId,'bank account'):null;
  if(bank>0){
    const acct=db.prepare(`SELECT 1 FROM shop_bank_accounts WHERE shop_id=? AND account_id=?
      AND account_type='OPERATIONAL' AND is_active=1`).get(shopId,accountId);
    if(!acct)fail(409,'Select an active Operational bank account.','BANK_ACCOUNT_NOT_ELIGIBLE');
  }else if(input.bankAccountId)fail(400,'No bank account permitted for zero bank collection.','BANK_ACCOUNT_UNEXPECTED');
  return {cashMinor:cash,bankMinor:bank,bankAccountId:accountId,note};
}
function currentTender(db,shopId,row){
  const t=db.prepare(`SELECT * FROM delivery_rider_tender_events WHERE shop_id=? AND settlement_id=?
    ORDER BY version DESC LIMIT 1`).get(shopId,row.settlement_id);
  return t?{cashMinor:t.cash_minor,bankMinor:t.bank_minor,bankAccountId:t.bank_account_id,
    note:t.note,version:t.version,changedAt:t.created_at,kind:t.kind}:
    {cashMinor:row.shop_cash_minor,bankMinor:0,bankAccountId:null,note:'',version:0,
      changedAt:row.created_at,kind:'LEGACY_CASH'};
}
function saveTenderEvent(db,shopId,row,version,kind,tender,submissionId,hash,actor){
  const id=newId('tender'),at=nowIso();
  db.prepare(`INSERT INTO delivery_rider_tender_events
    (event_id,settlement_id,shop_id,version,kind,cash_minor,bank_minor,bank_account_id,
      note,submission_id,submission_fingerprint,created_by_user_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,row.settlement_id,shopId,version,kind,
      tender.cashMinor,tender.bankMinor,tender.bankAccountId,tender.note,submissionId,hash,actor.userId,at);
  return {id,at};
}
function journalBankAllocation(db,shopId,eventId,currency,at,bankMinor,bankAccountId,reverse=false){
  if(!bankMinor)return;
  const line=db.prepare(`INSERT INTO delivery_rider_tender_journal
    (line_id,event_id,shop_id,account_code,bank_account_id,side,amount_minor,currency_code,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  line.run(newId('tnj'),eventId,shopId,'SHOP_CASH',null,reverse?'DEBIT':'CREDIT',bankMinor,currency,at);
  line.run(newId('tnj'),eventId,shopId,'SHOP_BANK',bankAccountId,reverse?'CREDIT':'DEBIT',bankMinor,currency,at);
}
function checkRider(db,shopId,riderId){
  if(!db.prepare(`SELECT 1 FROM staff_users u JOIN staff_user_roles r
    ON r.shop_id=u.shop_id AND r.user_id=u.user_id
    WHERE u.shop_id=? AND u.user_id=? AND r.role_id='role_delivery'
      AND r.revoked_at IS NULL`).get(shopId,riderId))
    fail(404,'Rider not found in shop.','RIDER_NOT_FOUND');
}
/** Exact pending set for ONE rider+date; 500 max, fail closed on larger sets. */
function cashOrders(db,shopId,riderId,day){
  const rows=db.prepare(`SELECT o.order_id,o.order_number,o.token_number,o.business_date,o.total_cents,
      o.currency_code,o.currency_decimals,o.customer_name,o.block_number,o.delivery_charge_cents,
      r.version AS report_version,r.amount_cents,r.report_type,r.cash_cents
    FROM delivery_order_payment_reports r
    JOIN orders o ON o.order_id=r.order_id AND o.tenant_id=r.shop_id
    JOIN order_delivery_claims c ON c.shop_id=r.shop_id AND c.order_id=r.order_id
      AND c.driver_user_id=r.driver_user_id
    JOIN delivery_order_lifecycle l ON l.shop_id=r.shop_id AND l.order_id=r.order_id
    WHERE r.shop_id=? AND r.driver_user_id=? AND o.business_date=?
      AND (r.report_type='CASH_WITH_BOY' OR (r.report_type='PARTIAL_SHOP' AND r.cash_cents>0))
      AND l.status='DELIVERED'
      AND o.is_test=1 AND o.status='OPEN' AND o.fulfillment_behavior='DELIVERY'
      AND NOT EXISTS(SELECT 1 FROM delivery_rider_net_settlement_orders x WHERE x.shop_id=r.shop_id AND x.order_id=r.order_id)
      AND NOT EXISTS(SELECT 1 FROM delivery_cash_handovers h WHERE h.shop_id=r.shop_id AND h.order_id=r.order_id)
      AND (r.report_type='PARTIAL_SHOP' OR NOT EXISTS(SELECT 1 FROM order_payment_allocations a WHERE a.shop_id=r.shop_id AND a.order_id=r.order_id))
      AND NOT EXISTS(SELECT 1 FROM order_settlements s WHERE s.shop_id=r.shop_id AND s.order_id=r.order_id)
      AND NOT EXISTS(SELECT 1 FROM delivery_shop_credit_authorizations c2
         WHERE c2.shop_id=r.shop_id AND c2.order_id=r.order_id AND c2.state='APPROVED')
      AND NOT EXISTS(SELECT 1 FROM delivery_credit_reviews cr
         WHERE cr.shop_id=r.shop_id AND cr.order_id=r.order_id AND cr.decision='CREDIT_APPROVED')
      AND NOT EXISTS(SELECT 1 FROM order_void_events v WHERE v.shop_id=r.shop_id AND v.order_id=r.order_id)
      AND (r.report_type='PARTIAL_SHOP' OR NOT EXISTS(SELECT 1 FROM order_payment_balances b WHERE b.shop_id=r.shop_id AND b.order_id=r.order_id
         AND (b.paid_cents>0 OR b.balance_cents!=o.total_cents OR b.payment_status!='UNPAID')))
    ORDER BY o.order_number,o.order_id LIMIT 501`).all(shopId,riderId,day);
  if(rows.length>500) fail(409,'Too many pending invoices; split dates or contact administrator.','BATCH_LIMIT');
  for(const o of rows){
    // Rider multiple payment: only the cash part is in the rider's custody.
    o.split=o.report_type==='PARTIAL_SHOP';
    o.rider_cash=o.split?Number(o.cash_cents):Number(o.total_cents);
    if(!moneyNumber(o.total_cents) || o.total_cents===0 ||
      (!o.split && o.amount_cents!==o.total_cents) ||
      (o.split && (!moneyNumber(o.rider_cash) || o.rider_cash===0 || o.rider_cash>o.total_cents)) ||
      !Number.isSafeInteger(Number(o.report_version)) || Number(o.report_version)<1)
      fail(409,`Invoice ${o.order_number} has an invalid rider cash report. Reconcile first.`,'CASH_REPORT_CONFLICT');
    if(o.split && readAllocationSummary(db,shopId,o.order_id,o.total_cents).unallocatedCents<o.rider_cash)
      fail(409,`Invoice ${o.order_number}: shop already recorded the rider's cash part. Reconcile first.`,'CASH_REPORT_CONFLICT');
  }
  return rows;
}
function dailySummary(db,shopId,riderId,day){
  const orders=db.prepare(`SELECT o.order_id,o.total_cents,o.currency_code,o.currency_decimals
    FROM orders o JOIN order_delivery_claims c ON c.shop_id=o.tenant_id AND c.order_id=o.order_id
    JOIN delivery_order_lifecycle l ON l.shop_id=o.tenant_id AND l.order_id=o.order_id
    WHERE o.tenant_id=? AND c.driver_user_id=? AND o.business_date=?
      AND o.is_test=1 AND o.status='OPEN' AND o.fulfillment_behavior='DELIVERY'
      AND l.status='DELIVERED'
      AND NOT EXISTS(SELECT 1 FROM order_void_events v WHERE v.shop_id=o.tenant_id AND v.order_id=o.order_id)
    ORDER BY o.order_number LIMIT 1501`).all(shopId,riderId,day);
  if(orders.length>1500)fail(409,'Too many rider deliveries for one date.','DATE_LIMIT');
  const currencies=new Set(orders.map(x=>`${x.currency_code}:${x.currency_decimals}`));
  if(currencies.size>1)fail(409,'Delivery totals have mixed currencies.','MIXED_CURRENCY');
  let total=0,paidDirect=0,creditAllocated=0;
  for(const o of orders){
    if(!moneyNumber(o.total_cents))fail(409,'Invalid delivered invoice amount.','BAD_INVOICE');
    total+=o.total_cents;
    const allocated=readAllocationSummary(db,shopId,o.order_id,o.total_cents);
    // Money paid at the shop directly = recorded payments minus what came from the rider.
    paidDirect+=allocated.paidCents-Math.min(riderOriginCents(db,shopId,o.order_id),allocated.paidCents);
    creditAllocated+=allocated.creditCents;
  }
  if(![total,paidDirect,creditAllocated].every(Number.isSafeInteger))fail(409,'Amount overflow.','OVERFLOW');
  return {totalDeliveredBills:orders.length,totalDeliveredMinor:total,
    directShopPaidMinor:paidDirect,customerCreditAllocatedMinor:creditAllocated,
    currencyCode:orders[0]?.currency_code||null,currencyDecimals:orders[0]?.currency_decimals??null};
}
function accrualFor(db,shopId,riderId,day){
  const accrued=db.prepare(`SELECT * FROM delivery_commission_accruals
    WHERE shop_id=? AND rider_user_id=? AND business_date=?`).get(shopId,riderId,day);
  if(!accrued)return null;
  const settled=db.prepare(`SELECT settlement_id FROM delivery_rider_net_settlements
    WHERE accrual_id=?`).get(accrued.accrual_id);
  return {accrualId:accrued.accrual_id,amountMinor:accrued.amount_minor,
    currencyCode:accrued.currency_code,currencyDecimals:accrued.currency_decimals,
    paid:Boolean(settled),paidSettlementId:settled?.settlement_id||null};
}
function quote(db,shopId,riderId,day){
  checkRider(db,shopId,riderId);
  const rows=cashOrders(db,shopId,riderId,day);
  const currencySet=new Set(rows.map(o=>`${o.currency_code}:${o.currency_decimals}`));
  if(currencySet.size>1) fail(409,'Pending invoices have mixed currencies; cannot settle together.','MIXED_CURRENCY');
  const gross=rows.reduce((n,o)=>n+o.rider_cash,0);
  if(!Number.isSafeInteger(gross)) fail(409,'Cash total overflow.','OVERFLOW');
  const currencyCode=rows[0]?.currency_code||null;
  const currencyDecimals=rows[0]?.currency_decimals??null;
  const receipt=rows.map(o=>({orderId:o.order_id,orderNumber:o.order_number,
    reportVersion:o.report_version,amountMinor:o.rider_cash}));
  const overview=dailySummary(db,shopId,riderId,day);
  const frozen=db.prepare(`SELECT eligible_delivery_count FROM delivery_commission_accruals
    WHERE shop_id=? AND rider_user_id=? AND business_date=?`).get(shopId,riderId,day);
  if(frozen && Number(frozen.eligible_delivery_count)!==overview.totalDeliveredBills)
    fail(409,'New or changed deliveries detected after daily commission was finalized. Reconcile the rider commission before collecting more cash for this date.','COMMISSION_RECONCILIATION_REQUIRED');
  if(overview.currencyCode&&currencyCode&&overview.currencyCode!==currencyCode)
    fail(409,'Rider cash currency differs from delivered invoices.','MIXED_CURRENCY');
  return {riderUserId:riderId,businessDate:day,
    currencyCode:currencyCode||overview.currencyCode,currencyDecimals:currencyDecimals??overview.currencyDecimals,
    overview,invoiceCount:rows.length,grossMinor:gross,
    orders:receipt.map((line,i)=>({...line,
      tokenNumber:rows[i].token_number==null?null:Number(rows[i].token_number),
      customerName:rows[i].customer_name||null,blockNumber:rows[i].block_number||null,
      deliveryChargeMinor:Number(rows[i].delivery_charge_cents||0),
      riderPartOnly:rows[i].split,orderTotalMinor:Number(rows[i].total_cents),
      commissionMinor:null})),
    accrual:accrualFor(db,shopId,riderId,day),
    snapshotHash:digest({shopId,riderId,day,currencyCode,currencyDecimals,receipt}),
    note:'Gross customer paid cash is NOT physical shop cash. Net shop cash is gross less approved commission offset.'};
}
export function listRiderNetSettlements(shopId,actor,riderId,day){
  admin(actor);const db=getDb();
  const roster=listDeliveryCashHandovers(shopId,actor).riders;
  const filtered=roster.map(r=>({userId:r.userId,fullName:r.fullName,isActive:r.isActive}));
  // Historical gross is sourced from immutable settlement lines. Customer/address/charge
  // labels are read-only order metadata (not a separately frozen address snapshot).
  // Daily/tier commission belongs to the SETTLEMENT, never an invented invoice split.
  const historyRows=db.prepare(`SELECT * FROM delivery_rider_net_settlements
    WHERE shop_id=? ORDER BY created_at DESC LIMIT 100`).all(shopId);
  const invoiceLines=db.prepare(`SELECT l.order_id,o.order_number,o.token_number,o.customer_name,
      o.block_number,o.delivery_charge_cents,l.gross_minor
    FROM delivery_rider_net_settlement_orders l
    JOIN orders o ON o.order_id=l.order_id AND o.tenant_id=l.shop_id
    WHERE l.shop_id=? AND l.settlement_id=? ORDER BY o.order_number,o.order_id LIMIT 501`);
  const history=historyRows.map(row=>{
    const entry={...readonlySettlement(row),tender:currentTender(db,shopId,row)};
    if(riderId && row.rider_user_id!==riderId) return entry;
    const lines=invoiceLines.all(shopId,row.settlement_id);
    // Avoid an ambiguous partial history if a settlement ever exceeds the cap.
    entry.orders=lines.length<=500?lines.map(inv=>({
      orderId:inv.order_id,orderNumber:inv.order_number,
      tokenNumber:inv.token_number==null?null:Number(inv.token_number),
      amountMinor:inv.gross_minor,
      customerName:inv.customer_name||null,blockNumber:inv.block_number||null,
      deliveryChargeMinor:Number(inv.delivery_charge_cents||0),commissionMinor:null
    })):[];
    entry.commissionAllocationNote=row.commission_minor>0
      ?'Commission is recorded on this daily settlement, not distributed per invoice.'
      :'No commission deducted for this settlement.';
    return entry;
  });
  if(!riderId || !day) return {riders:filtered,history,preview:null};
  safeId(riderId,'rider');validDate(day);
  return {riders:filtered,history,preview:quote(db,shopId,riderId,day)};
}
export function confirmRiderNetSettlement(shopId,input,actor){
  admin(actor);
  const riderId=safeId(input?.riderUserId,'rider');
  const day=validDate(input?.businessDate);
  const submissionId=safeId(input?.submissionId,'submission');
  if(submissionId.length<8||submissionId.length>78) fail(400,'Unique submission ID 8–78 characters required.','SUBMISSION_REQUIRED');
  const commissionAction=input?.payCommission===true;
  if(input?.payCommission!==true&&input?.payCommission!==false)
    fail(400,'Explicit commission decision required.','COMMISSION_DECISION');
  const expectedSnapshot=String(input?.expectedSnapshotHash||'');
  if(!/^[a-f0-9]{64}$/.test(expectedSnapshot))fail(400,'Refresh settlement preview.','PREVIEW_REQUIRED');
  if(!moneyNumber(input?.expectedGrossMinor)||!moneyNumber(input?.expectedCommissionMinor))
    fail(400,'Expected totals required in integer minor units.','AMOUNTS_REQUIRED');
  // A configured and dated Rider policy is pre-authorized. Only a confirmed
  // settlement can auto-post the expense/payable; the previous explicit UI approval
  // is no longer needed. The closing facts hash still prevents stale commission.
  const approveAccrual=input?.approveAccrual===true; // retained for old retry fingerprint compatibility
  const factsHash=String(input?.expectedFactsHash||'');
  if(commissionAction && factsHash && !/^[a-f0-9]{64}$/.test(factsHash))
    fail(400,'Refresh commission preview.','ACCRUAL_PREVIEW_REQUIRED');
  const fingerprint=digest({shopId,riderId,day,submissionId,expectedSnapshot,
    gross:input.expectedGrossMinor,commission:input.expectedCommissionMinor,
    commissionAction,approveAccrual,factsHash,
    ...(input.tender!==undefined?{tender:input.tender}:{})});
  const db=getDb();
  return db.transaction(()=>{
    const existing=db.prepare(`SELECT * FROM delivery_rider_net_settlements
      WHERE shop_id=? AND submission_id=?`).get(shopId,submissionId);
    if(existing){
      if(existing.submission_fingerprint!==fingerprint)fail(409,'Submission ID reused for another settlement.','SUBMISSION_CONFLICT');
      return {...readonlySettlement(existing,true),tender:currentTender(db,shopId,existing)};
    }
    const current=quote(db,shopId,riderId,day);
    if(!current.invoiceCount)fail(409,'No pending rider cash for date.','NOTHING_TO_SETTLE');
    if(current.snapshotHash!==expectedSnapshot || current.grossMinor!==input.expectedGrossMinor)
      fail(409,'Rider cash changed. Refresh.','STALE_PREVIEW');
    let accrual=current.accrual;
    if(commissionAction && !accrual){
      const checked=previewCommissionAccrual(shopId,riderId,day,actor);
      if(!checked.canAccrue || checked.factsHash!==factsHash)
        fail(409,'Commission rule/data changed or day is not closed. Refresh.','ACCRUAL_NOT_READY');
      const approved=approveCommissionAccrual(shopId,riderId,
        {submissionId:`ac_${submissionId}`,businessDate:day,approved:true,expectedFactsHash:factsHash},actor);
      accrual=accrualFor(db,shopId,riderId,day);
      if(approved.accrualId!==accrual?.accrualId)fail(409,'Accrual did not reconcile.','ACCRUAL_ERROR');
    }
    if(commissionAction && (!accrual||accrual.paid))
      fail(409,'Commission must be accrued and unpaid.','COMMISSION_NOT_PAYABLE');
    if(commissionAction && (accrual.currencyCode!==current.currencyCode ||
      Number(accrual.currencyDecimals)!==Number(current.currencyDecimals)))
      fail(409,'Commission currency differs from rider cash.','CURRENCY_MISMATCH');
    const commission=commissionAction?accrual.amountMinor:0;
    if(commission!==input.expectedCommissionMinor)
      fail(409,'Commission amount changed. Refresh.','STALE_COMMISSION');
    if(!moneyNumber(commission)||commission>current.grossMinor)
      fail(409,'Commission exceeds rider cash. Pay separately.','INSUFFICIENT_CUSTODY');
    const net=current.grossMinor-commission;
    const tender=verifiedTender(db,shopId,net,input.tender);
    const at=nowIso(),id=newId('rnet');
    // These are gross customer-paid allocations for invoice status; physical
    // shop cash is net, recorded ONLY in the dedicated immutable journal below.
    const insertAllocation=db.prepare(`INSERT INTO order_payment_allocations
      (allocation_id,shop_id,order_id,submission_id,submission_fingerprint,currency_code,
       cash_cents,bank_cents,credit_cents,bank_account_id,credit_customer_id,created_by_user_id,created_at)
      VALUES (?,?,?,?,?,?,?,0,0,NULL,NULL,?,?)`);
    const insertBalance=db.prepare(`INSERT INTO order_payment_balances
      (shop_id,order_id,currency_code,order_total_cents,paid_cents,balance_cents,payment_status,updated_at)
      VALUES (?,?,?,?,?,0,'PAID',?)
      ON CONFLICT(shop_id,order_id) DO UPDATE SET currency_code=excluded.currency_code,
        order_total_cents=excluded.order_total_cents,paid_cents=excluded.paid_cents,
        balance_cents=0,payment_status='PAID',updated_at=excluded.updated_at`);
    db.prepare(`INSERT INTO delivery_rider_net_settlements
      (settlement_id,shop_id,rider_user_id,business_date,currency_code,currency_decimals,
       gross_minor,commission_minor,shop_cash_minor,invoice_count,accrual_id,submission_id,
       submission_fingerprint,confirmed_by_user_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,shopId,riderId,day,current.currencyCode,
        current.currencyDecimals,current.grossMinor,commission,net,current.invoiceCount,
        commission?accrual.accrualId:null,submissionId,fingerprint,actor.userId,at);
    const line=db.prepare(`INSERT INTO delivery_rider_net_settlement_orders
      (settlement_id,shop_id,order_id,report_version,gross_minor,allocation_id)
      VALUES(?,?,?,?,?,?)`);
    for(const o of current.orders){
      const order=db.prepare(`SELECT total_cents,currency_code FROM orders WHERE order_id=? AND tenant_id=?`)
        .get(o.orderId,shopId);
      if(!order||order.currency_code!==current.currencyCode||
        (o.riderPartOnly?Number(order.total_cents)!==o.orderTotalMinor:Number(order.total_cents)!==o.amountMinor))
        fail(409,'Order changed. Refresh.','ORDER_CHANGED');
      const orderTotal=Number(order.total_cents);
      const prior=readAllocationSummary(db,shopId,o.orderId,orderTotal);
      if(o.riderPartOnly){
        // Shop-paid / credit parts may already be recorded; the rider's part must still be open.
        if(prior.legacySettlement||riderOriginCents(db,shopId,o.orderId)>0||prior.unallocatedCents<o.amountMinor)
          fail(409,'Order now has payment or credit. Refresh.','PAYMENT_CONFLICT');
      } else if(prior.hasAllocations||prior.legacySettlement||prior.paidCents||prior.creditCents||prior.unallocatedCents!==o.amountMinor)
        fail(409,'Order now has payment or credit. Refresh.','PAYMENT_CONFLICT');
      const allocId=newId('alloc'),sub=`rnet_${id}_${o.orderId}`;
      insertAllocation.run(allocId,shopId,o.orderId,sub,fingerprint,current.currencyCode,o.amountMinor,actor.userId,at);
      if(o.riderPartOnly){
        const now=readAllocationSummary(db,shopId,o.orderId,orderTotal);
        db.prepare(`INSERT INTO order_payment_balances
          (shop_id,order_id,currency_code,order_total_cents,paid_cents,balance_cents,payment_status,updated_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(shop_id,order_id) DO UPDATE SET currency_code=excluded.currency_code,
            order_total_cents=excluded.order_total_cents,paid_cents=excluded.paid_cents,
            balance_cents=excluded.balance_cents,payment_status=excluded.payment_status,
            updated_at=excluded.updated_at`).run(shopId,o.orderId,current.currencyCode,orderTotal,
            now.paidCents,now.balanceCents,now.paymentStatus==='PAID'?'PAID':'UNPAID',at);
      } else insertBalance.run(shopId,o.orderId,current.currencyCode,o.amountMinor,o.amountMinor,at);
      line.run(id,shopId,o.orderId,o.reportVersion,o.amountMinor,allocId);
      const after=readAllocationSummary(db,shopId,o.orderId,orderTotal);
      if(o.riderPartOnly
        ? (after.cashCents!==prior.cashCents+o.amountMinor||after.unallocatedCents!==prior.unallocatedCents-o.amountMinor)
        : (after.cashCents!==o.amountMinor||after.paidCents!==o.amountMinor||after.unallocatedCents!==0))
        fail(409,'Invoice payment not balanced.','INVOICE_RECONCILIATION_FAILED');
    }
    const journal=db.prepare(`INSERT INTO delivery_rider_settlement_journal
      (line_id,settlement_id,shop_id,account_code,side,amount_minor,currency_code,created_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    if(net>0)journal.run(newId('jnl'),id,shopId,'SHOP_CASH','DEBIT',net,current.currencyCode,at);
    if(commission>0)journal.run(newId('jnl'),id,shopId,'COMMISSION_PAYABLE','DEBIT',commission,current.currencyCode,at);
    journal.run(newId('jnl'),id,shopId,'RIDER_CUSTODY','CREDIT',current.grossMinor,current.currencyCode,at);
    const check=db.prepare(`SELECT SUM(CASE WHEN side='DEBIT' THEN amount_minor ELSE 0 END) AS debit,
      SUM(CASE WHEN side='CREDIT' THEN amount_minor ELSE 0 END) AS credit
      FROM delivery_rider_settlement_journal WHERE settlement_id=?`).get(id);
    if(check.debit!==check.credit||check.debit!==current.grossMinor)
      fail(409,'Settlement journal is unbalanced.','UNBALANCED_JOURNAL');
    const tenderEvent=saveTenderEvent(db,shopId,{settlement_id:id},1,'ORIGINAL',tender,
      `original_${submissionId}`,digest({fingerprint,tender}),actor);
    // The existing net settlement books CASH. Transfer the bank portion within the
    // SAME SQLite transaction, so aggregate SHOP_CASH is true physical cash.
    journalBankAllocation(db,shopId,tenderEvent.id,current.currencyCode,tenderEvent.at,
      tender.bankMinor,tender.bankAccountId);
    // Net custody settlement is balanced even when tender is split:
    // customer-paid gross = approved commission + actual shop cash + actual shop bank.
    if(tender.cashMinor+tender.bankMinor+commission!==current.grossMinor)
      fail(409,'Rider settlement failed gross/net reconciliation.','TENDER_RECONCILIATION');
    recordAudit({actorRole:actor.role,actorUserId:actor.userId,
      action:'delivery.rider.net.settlement',entityType:'delivery_rider_net_settlement',entityId:id,
      detail:{shopId,riderId,businessDate:day,invoiceCount:current.invoiceCount,
        grossCustomerPaidMinor:current.grossMinor,commissionPayoutMinor:commission,
        physicalShopCashMinor:net,currencyCode:current.currencyCode,
        accrualId:commission?accrual.accrualId:null,postedToGeneralLedger:false}});
    return {...readonlySettlement(db.prepare(`SELECT * FROM delivery_rider_net_settlements WHERE settlement_id=?`).get(id)), tender:currentTender(db,shopId,{settlement_id:id})};
  }).immediate();
}

/** An EDIT of posted tender is an immutable classification correction, never an UPDATE/DELETE. */
export function correctRiderSettlementTender(shopId,settlementId,input,actor){
  admin(actor);safeId(settlementId,'settlement');
  const sub=safeId(input?.submissionId,'submission');
  if(sub.length<8 || sub.length>78)fail(400,'Unique correction submission required.','SUBMISSION_REQUIRED');
  const version=input?.expectedTenderVersion;
  if(!Number.isSafeInteger(version)||version<0)fail(400,'Current tender version required.','VERSION_REQUIRED');
  const hash=digest({shopId,settlementId,sub,version,tender:input?.tender});
  const db=getDb();
  return db.transaction(()=>{
    const prior=db.prepare(`SELECT * FROM delivery_rider_tender_events WHERE shop_id=? AND submission_id=?`)
      .get(shopId,`correction_${sub}`);
    if(prior){
      if(prior.submission_fingerprint!==hash || prior.settlement_id!==settlementId)
        fail(409,'Correction submission reused with different values.','SUBMISSION_CONFLICT');
      const settlement=db.prepare(`SELECT * FROM delivery_rider_net_settlements WHERE shop_id=? AND settlement_id=?`)
        .get(shopId,settlementId);
      return {settlementId,tender:currentTender(db,shopId,settlement),replayed:true};
    }
    const settlement=db.prepare(`SELECT * FROM delivery_rider_net_settlements WHERE shop_id=? AND settlement_id=?`)
      .get(shopId,settlementId);
    if(!settlement)fail(404,'Collection record not found.','SETTLEMENT_NOT_FOUND');
    const old=currentTender(db,shopId,settlement);
    if(old.version!==version)fail(409,'Payment details changed. Refresh before editing.','TENDER_VERSION_CONFLICT');
    const next=verifiedTender(db,shopId,settlement.shop_cash_minor,input?.tender);
    if(old.cashMinor===next.cashMinor && old.bankMinor===next.bankMinor &&
       old.bankAccountId===next.bankAccountId && old.note===next.note)
      fail(400,'No changes to save.','NO_CHANGE');
    const evt=saveTenderEvent(db,shopId,settlement,version+1,'CORRECTION',next,
      `correction_${sub}`,hash,actor);
    journalBankAllocation(db,shopId,evt.id,settlement.currency_code,evt.at,
      old.bankMinor,old.bankAccountId,true);
    journalBankAllocation(db,shopId,evt.id,settlement.currency_code,evt.at,
      next.bankMinor,next.bankAccountId,false);
    recordAudit({actorRole:actor.role,actorUserId:actor.userId,
      action:'delivery.rider.settlement.tender_correction',entityType:'delivery_rider_net_settlement',
      entityId:settlementId,detail:{shopId,oldTender:old,newTender:next,
        originalGrossMinor:settlement.gross_minor,commissionMinor:settlement.commission_minor,
        originalInvoicesUnchanged:true}});
    return {settlementId,tender:{...next,version:version+1,kind:'CORRECTION',changedAt:evt.at},replayed:false};
  }).immediate();
}
