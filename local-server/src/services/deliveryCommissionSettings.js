/** P2-E3C1 TEST only: append-only rider policies and READ-ONLY commission estimates.
 * Does NOT accrue commissions, create payable, expense, payouts or deduct handovers.
 * Evaluator is P2-E3A and works exclusively in exact integer minor units.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/db.js';
import { newId } from '../util/ids.js';
import { nowIso } from '../util/time.js';
import { getShopSettings } from './shopSettings.js';
import { recordAudit } from './audit.js';
import { evaluateDeliveryCommission } from './deliveryCommission.js';

function fail(status,message,code) {throw Object.assign(new Error(message),{status,code});}
function admin(actor) {
  if (!actor?.userId || actor.role !== 'admin' || !actor.staff ||
    !(actor.permissions || []).includes('staff.manage')) fail(403,'Staff Admin required.','FORBIDDEN');
}
function isoDate(value) {
  if (typeof value!=='string'|| !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value)
    fail(400,'Valid YYYY-MM-DD business date required.','INVALID_DATE');
  return value;
}
function shopDate(db, shopId) {
  const shift=db.prepare("SELECT business_date FROM shop_business_shifts WHERE shop_id=? AND status='OPEN'").get(shopId);
  if (shift) return shift.business_date;
  const zone=getShopSettings(shopId).timezone || 'UTC';
  return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
function shopMoney(shopId) {
  const s=getShopSettings(shopId);
  const currencyCode=String(s.currencyCode||s.currency_code||'').toUpperCase();
  const currencyDecimals=Number(s.currencyDecimals??s.currency_decimals);
  if (!/^[A-Z]{3}$/.test(currencyCode)||!Number.isInteger(currencyDecimals)||currencyDecimals<0||currencyDecimals>4)
    fail(409,'Shop currency is not configured.','CURRENCY_REQUIRED');
  return {currencyCode,currencyDecimals};
}
function rider(db,shopId,riderId) {
  if (typeof riderId!=='string'||! /^[A-Za-z0-9_-]{1,120}$/.test(riderId))
    fail(400,'Select a rider.','RIDER_REQUIRED');
  const r=db.prepare(`SELECT u.user_id,u.full_name,u.is_active FROM staff_users u
    JOIN staff_user_roles role ON role.user_id=u.user_id AND role.shop_id=u.shop_id
    WHERE u.shop_id=? AND u.user_id=? AND role.role_id='role_delivery' AND role.revoked_at IS NULL`)
    .get(shopId,riderId);
  if (!r) fail(404,'Rider not found in this shop.','RIDER_NOT_FOUND');
  return {userId:r.user_id,fullName:r.full_name,isActive:Boolean(r.is_active)};
}
export function sanitizePolicy(obj) {
  if (!obj||typeof obj!=='object'||Array.isArray(obj)) fail(400,'Commission policy required.','INVALID_POLICY');
  const method=obj.method, period=obj.period || 'DAILY';
  // Only DAILY implemented at this stage; others require explicit period reconciliation.
  if (period!=='DAILY') fail(400,'Only DAILY commission is available in P2-E3C1.','PERIOD_NOT_SUPPORTED');
  const valid=['FIXED_PER_DELIVERY','TIERED_FIXED','PERCENTAGE','MANUAL','NONE'];
  if (!valid.includes(method)) fail(400,'Invalid commission method.','INVALID_METHOD');
  const p={method,period};
  if (method==='FIXED_PER_DELIVERY'||method==='MANUAL') p.amountMinor=obj.amountMinor;
  if (method==='TIERED_FIXED') {
    p.basis=obj.basis || 'TOTAL_BILL';
    if (!Array.isArray(obj.tiers)||obj.tiers.length<1||obj.tiers.length>20) fail(400,'1–20 tiers required.','INVALID_TIERS');
    p.tiers=obj.tiers.map(t=>({thresholdMinor:t?.thresholdMinor,rewardMinor:t?.rewardMinor}));
  }
  if (method==='PERCENTAGE'){p.basis=obj.basis;p.rateBps=obj.rateBps;}
  // Evaluate with an eligible 1-delivery zero-value sample so every field is validated
  // even when the selected rider has no delivered orders yet.
  try {evaluateDeliveryCommission(p,{currencyDecimals:3,eligibleDeliveryCount:1,totalBillMinor:0,deliveryChargeMinor:0});}
  catch(e){fail(400,e.message,'INVALID_POLICY');}
  return p;
}
function toRow(row) {
  if(!row)return null;
  return {policyId:row.policy_id,riderUserId:row.rider_user_id,version:row.version,
    effectiveBusinessDate:row.effective_business_date,currencyCode:row.currency_code,
    currencyDecimals:row.currency_decimals,policy:JSON.parse(row.policy_json),
    createdAt:row.created_at,createdByUserId:row.created_by_user_id};
}
function selectedPolicy(db,shopId,riderId,date) {
  return db.prepare(`SELECT * FROM delivery_commission_policies
    WHERE shop_id=? AND rider_user_id=? AND effective_business_date<=?
    ORDER BY effective_business_date DESC,version DESC LIMIT 1`).get(shopId,riderId,date);
}
export function listCommissionSettings(shopId,actor) {
  admin(actor);const db=getDb(); const currency=shopMoney(shopId);
  const today=shopDate(db,shopId);
  const rows=db.prepare(`SELECT u.user_id,u.full_name,u.is_active FROM staff_users u
    JOIN staff_user_roles r ON r.user_id=u.user_id AND r.shop_id=u.shop_id
      AND r.role_id='role_delivery' AND r.revoked_at IS NULL
    WHERE u.shop_id=? ORDER BY u.is_active DESC,u.full_name COLLATE NOCASE`).all(shopId);
  return {businessDate:today,...currency,riders:rows.map(r=>({
    userId:r.user_id,fullName:r.full_name,isActive:Boolean(r.is_active),
    activePolicy:toRow(selectedPolicy(db,shopId,r.user_id,today))
  })),note:'Estimate only — no commission accrual, expense, payable, deduction or payout.'};
}
export function saveCommissionSetting(shopId,riderId,input,actor) {
  admin(actor); const db=getDb();
  const submissionId=String(input?.submissionId||'');
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(submissionId)) fail(400,'Unique submission ID required.','SUBMISSION_REQUIRED');
  const effectiveDate=isoDate(input?.effectiveBusinessDate);
  const policy=sanitizePolicy(input?.policy);
  const currency=shopMoney(shopId);
  const fingerprint=createHash('sha256').update(JSON.stringify({shopId,riderId,effectiveDate,policy,...currency})).digest('hex');
  return db.transaction(()=>{
    const existing=db.prepare('SELECT * FROM delivery_commission_policies WHERE shop_id=? AND submission_id=?')
      .get(shopId,submissionId);
    if(existing){
      if(existing.rider_user_id!==riderId||existing.submission_fingerprint!==fingerprint)
        fail(409,'Submission ID already used with different policy.','SUBMISSION_CONFLICT');
      return {...toRow(existing),replayed:true};
    }
    const currentRider=rider(db,shopId,riderId);
    if(!currentRider.isActive) fail(409,'Cannot assign a new policy to inactive rider.','RIDER_INACTIVE');
    const today=shopDate(db,shopId);
    if(effectiveDate<today) fail(409,'Policy cannot start in a past business date.','PAST_DATE');
    const version=(db.prepare(`SELECT COALESCE(MAX(version),0)+1 AS next
      FROM delivery_commission_policies WHERE shop_id=? AND rider_user_id=?`).get(shopId,riderId).next);
    const id=newId('cpr'),createdAt=nowIso();
    db.prepare(`INSERT INTO delivery_commission_policies
      (policy_id,shop_id,rider_user_id,version,effective_business_date,
       currency_code,currency_decimals,policy_json,submission_id,submission_fingerprint,created_by_user_id,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id,shopId,riderId,version,effectiveDate,currency.currencyCode,currency.currencyDecimals,
        JSON.stringify(policy),submissionId,fingerprint,actor.userId,createdAt);
    recordAudit({actorRole:actor.role,actorUserId:actor.userId,action:'delivery.commission.policy.created',
      entityType:'delivery_commission_policy',entityId:id,
      detail:{shopId,riderId,version,effectiveDate,method:policy.method,currencyCode:currency.currencyCode}});
    return {policyId:id,riderUserId:riderId,version,effectiveBusinessDate:effectiveDate,...currency,
      policy,createdAt,createdByUserId:actor.userId,replayed:false};
  }).immediate();
}
export function commissionPreview(shopId,riderId,businessDate,actor) {
  admin(actor);const db=getDb();rider(db,shopId,riderId);
  const day=isoDate(businessDate);const money=shopMoney(shopId);
  const row=selectedPolicy(db,shopId,riderId,day);
  // Only distinct delivered, still-open TEST orders assigned to this rider, in the shop business date.
  // Previous-day orders, voids, cancelled orders, and other currencies are excluded.
  const orders=db.prepare(`SELECT o.order_id,o.order_number,o.total_cents,o.delivery_charge_cents,
      o.currency_code,o.currency_decimals
    FROM order_delivery_claims c JOIN orders o
      ON o.order_id=c.order_id AND o.tenant_id=c.shop_id
    JOIN delivery_order_lifecycle l ON l.order_id=o.order_id AND l.shop_id=c.shop_id
    WHERE c.shop_id=? AND c.driver_user_id=? AND o.business_date=?
      AND o.is_test=1 AND o.status='OPEN' AND o.fulfillment_behavior='DELIVERY'
      AND l.status='DELIVERED'
      AND NOT EXISTS(SELECT 1 FROM order_void_events v WHERE v.shop_id=c.shop_id AND v.order_id=c.order_id)
    ORDER BY o.order_number LIMIT 5000`).all(shopId,riderId,day);
  let totalBillMinor=0,deliveryChargeMinor=0,count=0,skipped=0;
  for(const order of orders){
    const total=Number(order.total_cents),charge=Number(order.delivery_charge_cents||0);
    if(order.currency_code!==money.currencyCode||Number(order.currency_decimals)!==money.currencyDecimals ||
      !Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(charge)||charge<0||charge>total){
      skipped++;continue;
    }
    if(!Number.isSafeInteger(totalBillMinor+total)||!Number.isSafeInteger(deliveryChargeMinor+charge))
      fail(409,'Delivery totals exceed safe integer limit.','AMOUNT_OVERFLOW');
    totalBillMinor+=total;deliveryChargeMinor+=charge;count++;
  }
  const facts={currencyDecimals:money.currencyDecimals,eligibleDeliveryCount:count,totalBillMinor,deliveryChargeMinor};
  const policy=row&&row.currency_code===money.currencyCode&&Number(row.currency_decimals)===money.currencyDecimals
    ? JSON.parse(row.policy_json):null;
  const calculated=policy?evaluateDeliveryCommission(policy,facts):null;
  return {riderUserId:riderId,businessDate:day,...money,eligibleDeliveryCount:count,
    totalBillMinor,deliveryChargeMinor,skippedOrders:skipped,
    activePolicy:policy?toRow(row):null,estimatedCommissionMinor:calculated?.commissionMinor??null,
    provisional:true,accountingPosted:false,
    note:'Provisional live estimate only. No earned accrual, payable, expense or payout is recorded. Current-day deliveries may change.'};
}

/** P2-E3C6: User Management is the only rider commission rule editor.
 * Both staff account and immutable policy save in the same caller-owned SQLite transaction.
 * This function must never be called outside the authorized Staff Admin route.
 */
export function readStaffRiderCommission(shopId,riderId) {
  const db=getDb();
  const day=shopDate(db,shopId);
  return toRow(selectedPolicy(db,shopId,riderId,day));
}
export function assignStaffRiderCommissionInTx(db,shopId,riderId,rawPolicy,actor) {
  const policy=sanitizePolicy(rawPolicy);
  const day=shopDate(db,shopId),currency=shopMoney(shopId);
  const current=selectedPolicy(db,shopId,riderId,day);
  if(current && current.currency_code===currency.currencyCode &&
    Number(current.currency_decimals)===currency.currencyDecimals &&
    JSON.stringify(JSON.parse(current.policy_json))===JSON.stringify(policy)) {
    return {changed:false,policyId:current.policy_id,version:current.version};
  }
  // Never rewrite an already booked commission period. Changes begin today and
  // previously closed dates retain the rule version that was effective then.
  const settled=db.prepare(`SELECT 1 FROM delivery_commission_accruals
    WHERE shop_id=? AND rider_user_id=? AND business_date=?`).get(shopId,riderId,day);
  if(settled)fail(409,'Today already has commission accounting. New policy must begin a future business day.','ALREADY_ACCRUED');
  const version=db.prepare(`SELECT COALESCE(MAX(version),0)+1 AS next
    FROM delivery_commission_policies WHERE shop_id=? AND rider_user_id=?`).get(shopId,riderId).next;
  const policyId=newId('cpr'),createdAt=nowIso();
  const submissionId=`staff_${policyId}`;
  const fingerprint=createHash('sha256').update(JSON.stringify({shopId,riderId,day,policy,currency})).digest('hex');
  db.prepare(`INSERT INTO delivery_commission_policies
    (policy_id,shop_id,rider_user_id,version,effective_business_date,currency_code,currency_decimals,
     policy_json,submission_id,submission_fingerprint,created_by_user_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(policyId,shopId,riderId,version,day,
      currency.currencyCode,currency.currencyDecimals,JSON.stringify(policy),submissionId,
      fingerprint,actor.userId,createdAt);
  recordAudit({actorRole:actor.role,actorUserId:actor.userId,action:'delivery.commission.policy.created',
    entityType:'delivery_commission_policy',entityId:policyId,
    detail:{shopId,riderId,version,effectiveDate:day,method:policy.method,configuredVia:'staff_users'}});
  return {changed:true,policyId,version};
}
