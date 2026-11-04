/** P2-E3C3: TEST-only, approved immutable daily commission subledger.
 * Does NOT credit/debit live shop cash, bank, sales, expenses or external accounting.
 * Payouts, reversals, deduction and main-ledger reconciliation must be a later audited phase.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/db.js';
import { newId } from '../util/ids.js';
import { nowIso } from '../util/time.js';
import { recordAudit } from './audit.js';
import { commissionPreview, listCommissionSettings } from './deliveryCommissionSettings.js';
import { getShopSettings } from './shopSettings.js';

function fail(status,message,code){throw Object.assign(new Error(message),{status,code});}
function hash(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
/** Commission day is based on shop-local CALENDAR, not the POS token-number shift.
 * The shop shift may remain on an older business date until Admin rolls it over.
 * This is a cutoff for commission eligibility only, never an accounting day-end.
 */
function localCalendarDay(shopId){
  const zone=getShopSettings(shopId).timezone || 'UTC';
  return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
function admin(actor){if(!actor?.userId || actor.role!=='admin'||!actor.staff ||
  !(actor.permissions||[]).includes('staff.manage')) fail(403,'Staff Admin required.','FORBIDDEN');}
function isoDate(d){if(typeof d!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d)||
  !Number.isFinite(Date.parse(`${d}T00:00:00Z`))||
  new Date(`${d}T00:00:00Z`).toISOString().slice(0,10)!==d)fail(400,'Valid date required.','INVALID_DATE');return d;}
function validRiderId(id){if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(id))fail(400,'Invalid rider.','INVALID_RIDER');return id;}
function rowView(row, replayed=false){const payout=getDb().prepare(`SELECT settlement_id,commission_minor FROM delivery_rider_net_settlements WHERE accrual_id=?`).get(row.accrual_id);return {accrualId:row.accrual_id,riderUserId:row.rider_user_id,
  businessDate:row.business_date,policyId:row.policy_id,policyVersion:row.policy_version,
  currencyCode:row.currency_code,currencyDecimals:row.currency_decimals,
  deliveryCount:row.eligible_delivery_count,totalBillMinor:row.total_bill_minor,
  deliveryChargeMinor:row.delivery_charge_minor,amountMinor:row.amount_minor,
  approvedByUserId:row.approved_by_user_id,createdAt:row.created_at,replayed,
  postedToCommissionSubledger:true,postedToShopGeneralLedger:false,payoutPosted:!!payout,
  paidMinor:payout?.commission_minor||0,payableMinor:row.amount_minor-(payout?.commission_minor||0),
  paidSettlementId:payout?.settlement_id||null};}
function facts(shopId,riderId,day,actor){
  const db=getDb(),current=commissionPreview(shopId,riderId,day,actor);
  const orders=db.prepare(`SELECT o.order_id,o.total_cents,o.delivery_charge_cents,o.currency_code,o.currency_decimals
    FROM order_delivery_claims c JOIN orders o ON o.order_id=c.order_id AND o.tenant_id=c.shop_id
    JOIN delivery_order_lifecycle l ON l.shop_id=c.shop_id AND l.order_id=o.order_id
    WHERE c.shop_id=? AND c.driver_user_id=? AND o.business_date=?
      AND o.is_test=1 AND o.status='OPEN' AND o.fulfillment_behavior='DELIVERY'
      AND l.status='DELIVERED'
      AND NOT EXISTS(SELECT 1 FROM order_void_events v WHERE v.shop_id=c.shop_id AND v.order_id=c.order_id)
    ORDER BY o.order_number LIMIT 5000`).all(shopId,riderId,day);
  const eligible=[];
  let bill=0,charges=0;
  for(const o of orders){
    const amount=Number(o.total_cents),charge=Number(o.delivery_charge_cents||0);
    if(o.currency_code!==current.currencyCode || Number(o.currency_decimals)!==current.currencyDecimals ||
      !Number.isSafeInteger(amount)||amount<0||!Number.isSafeInteger(charge)||charge<0||charge>amount)continue;
    eligible.push({orderId:o.order_id,totalMinor:amount,deliveryChargeMinor:charge});
    bill+=amount;charges+=charge;
    if(!Number.isSafeInteger(bill)||!Number.isSafeInteger(charges))fail(409,'Amount overflow.','AMOUNT_OVERFLOW');
  }
  if(eligible.length!==current.eligibleDeliveryCount ||bill!==current.totalBillMinor||charges!==current.deliveryChargeMinor)
    fail(409,'Delivery data changed; refresh and retry.','STALE_FACTS');
  const policy=current.activePolicy;
  const payload={shopId,riderId,businessDate:day,policyId:policy?.policyId||null,
    policyVersion:policy?.version||null,policySnapshot:policy?.policy||null,
    currencyCode:current.currencyCode,currencyDecimals:current.currencyDecimals,
    eligible,amountMinor:current.estimatedCommissionMinor};
  return {...current,eligible,hash:hash(payload)};
}
export function previewCommissionAccrual(shopId,riderId,date,actor){
  admin(actor);validRiderId(riderId);const day=isoDate(date);
  const shopCalendarBusinessDate=localCalendarDay(shopId);
  const activeShiftBusinessDate=listCommissionSettings(shopId,actor).businessDate;
  const today=shopCalendarBusinessDate>activeShiftBusinessDate?shopCalendarBusinessDate:activeShiftBusinessDate;
  const f=facts(shopId,riderId,day,actor);
  const closed=Boolean(getDb().prepare('SELECT 1 FROM delivery_commission_accruals WHERE shop_id=? AND rider_user_id=? AND business_date=?')
    .get(shopId,riderId,day));
  return {...f,eligible:undefined,orderIds:f.eligible.map(x=>x.orderId),factsHash:f.hash,
    canAccrue:day<today&&!closed&&!!f.activePolicy&&f.eligibleDeliveryCount>0&&f.skippedOrders===0&&f.estimatedCommissionMinor>0,
    alreadyAccrued:closed,currentBusinessDate:today,activeShiftBusinessDate,shopCalendarBusinessDate,
    note:'POSTS ONLY to isolated commission EXPENSE/PAYABLE subledger; not to shop general ledger or shop cash/bank.'};
}
export function listCommissionAccruals(shopId,riderId,actor){
  admin(actor);validRiderId(riderId);const db=getDb();
  // Exact rider validation, including empty histories.
  const roster=listCommissionSettings(shopId,actor);
  if(!roster.riders.some(r=>r.userId===riderId))fail(404,'Rider not found.','RIDER_NOT_FOUND');
  const rows=db.prepare(`SELECT * FROM delivery_commission_accruals
    WHERE shop_id=? AND rider_user_id=? ORDER BY business_date DESC LIMIT 100`).all(shopId,riderId);
  const totals=db.prepare(`SELECT a.currency_code,a.currency_decimals,SUM(a.amount_minor) AS total_minor,
      COALESCE(SUM(s.commission_minor),0) AS paid_minor
    FROM delivery_commission_accruals a
    LEFT JOIN delivery_rider_net_settlements s ON s.accrual_id=a.accrual_id
    WHERE a.shop_id=? AND a.rider_user_id=?
    GROUP BY a.currency_code,a.currency_decimals`).all(shopId,riderId);
  return {accruals:rows.map(r=>rowView(r)),totals:totals.map(r=>({currencyCode:r.currency_code,
    currencyDecimals:r.currency_decimals,expenseMinor:r.total_minor,
    payableMinor:r.total_minor-r.paid_minor,paidMinor:r.paid_minor})),
    note:'TEST commission-only subledger: rider cash commission offset reduces payable. External General Ledger integration not enabled.'};
}
export function approveCommissionAccrual(shopId,riderId,input,actor){
  admin(actor);validRiderId(riderId);
  const submissionId=String(input?.submissionId||'');
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(submissionId))fail(400,'Unique submission ID required.','SUBMISSION_REQUIRED');
  const day=isoDate(input?.businessDate);
  if(input?.approved!==true)fail(400,'Explicit Admin approval required.','APPROVAL_REQUIRED');
  const expectedHash=String(input?.expectedFactsHash||'');
  if(!/^[a-f0-9]{64}$/.test(expectedHash))fail(400,'Review current preview before approval.','SNAPSHOT_REQUIRED');
  const fingerprint=hash({shopId,riderId,day,expectedHash});
  const db=getDb();
  return db.transaction(()=>{
    const replay=db.prepare('SELECT * FROM delivery_commission_accruals WHERE shop_id=? AND submission_id=?').get(shopId,submissionId);
    if(replay){
      if(replay.submission_fingerprint!==fingerprint||replay.rider_user_id!==riderId||replay.business_date!==day)
        fail(409,'Submission ID reused with different accrual.','SUBMISSION_CONFLICT');
      return rowView(replay,true);
    }
    if(db.prepare('SELECT 1 FROM delivery_commission_accruals WHERE shop_id=? AND rider_user_id=? AND business_date=?')
      .get(shopId,riderId,day))fail(409,'This rider/day is already accrued.','ALREADY_ACCRUED');
    const shiftDate=listCommissionSettings(shopId,actor).businessDate;
    const calendarDate=localCalendarDay(shopId);
    const currentBusinessDate=calendarDate>shiftDate?calendarDate:shiftDate;
    if(day>=currentBusinessDate)fail(409,'Daily commission is not final until the next shop-local date or the POS shift advances. A collection may be recorded on a different date.','COMMISSION_DAY_NOT_FINISHED');
    const snap=facts(shopId,riderId,day,actor);
    if(snap.hash!==expectedHash)fail(409,'Commission facts/policy changed. Refresh preview.','STALE_PREVIEW');
    if(!snap.activePolicy)fail(409,'No active commission rule for date.','POLICY_REQUIRED');
    if(snap.skippedOrders!==0)fail(409,'Invalid/cross-currency orders require review.','INVALID_ORDERS');
    if(snap.eligibleDeliveryCount<1||!Number.isSafeInteger(snap.estimatedCommissionMinor)||snap.estimatedCommissionMinor<=0)
      fail(409,'No positive commission to accrue.','NO_COMMISSION');
    if(!Number.isSafeInteger(snap.totalBillMinor)||!Number.isSafeInteger(snap.deliveryChargeMinor))
      fail(409,'Invalid invoice totals.','AMOUNT_OVERFLOW');
    const id=newId('cacc'),at=nowIso(),policy=snap.activePolicy;
    db.prepare(`INSERT INTO delivery_commission_accruals
      (accrual_id,shop_id,rider_user_id,business_date,policy_id,policy_version,policy_snapshot_json,
       eligible_orders_json,facts_hash,submission_id,submission_fingerprint,currency_code,currency_decimals,
       eligible_delivery_count,total_bill_minor,delivery_charge_minor,amount_minor,approved_by_user_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,shopId,riderId,day,policy.policyId,
       policy.version,JSON.stringify(policy.policy),JSON.stringify(snap.eligible),snap.hash,submissionId,fingerprint,
       snap.currencyCode,snap.currencyDecimals,snap.eligibleDeliveryCount,snap.totalBillMinor,
       snap.deliveryChargeMinor,snap.estimatedCommissionMinor,actor.userId,at);
    for(const item of snap.eligible) db.prepare(`INSERT INTO delivery_commission_accrual_orders
      (accrual_id,shop_id,order_id) VALUES(?,?,?)`).run(id,shopId,item.orderId);
    const line=db.prepare(`INSERT INTO delivery_commission_journal_lines
      (line_id,accrual_id,shop_id,account_code,side,amount_minor,currency_code,created_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    line.run(newId('cln'),id,shopId,'COMMISSION_EXPENSE','DEBIT',snap.estimatedCommissionMinor,snap.currencyCode,at);
    line.run(newId('cln'),id,shopId,'COMMISSION_PAYABLE','CREDIT',snap.estimatedCommissionMinor,snap.currencyCode,at);
    const verify=db.prepare(`SELECT SUM(CASE WHEN side='DEBIT' THEN amount_minor ELSE 0 END) AS debit,
      SUM(CASE WHEN side='CREDIT' THEN amount_minor ELSE 0 END) AS credit,COUNT(*) AS n
      FROM delivery_commission_journal_lines WHERE accrual_id=?`).get(id);
    if(verify.n!==2||verify.debit!==verify.credit||verify.debit!==snap.estimatedCommissionMinor)
      fail(409,'Journal not balanced. Rolled back.','JOURNAL_UNBALANCED');
    recordAudit({actorRole:actor.role,actorUserId:actor.userId,
      action:'delivery.commission.accrual.approved',entityType:'delivery_commission_accrual',entityId:id,
      detail:{shopId,riderId,businessDate:day,policyId:policy.policyId,amountMinor:snap.estimatedCommissionMinor,
        currencyCode:snap.currencyCode,factsHash:snap.hash,postedToShopGeneralLedger:false}});
    return rowView(db.prepare('SELECT * FROM delivery_commission_accruals WHERE accrual_id=?').get(id));
  }).immediate();
}
