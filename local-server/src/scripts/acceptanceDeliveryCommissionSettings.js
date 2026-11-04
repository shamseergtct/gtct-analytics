/** P2-E3C1 isolated TEST-only API/database acceptance. No production data. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, ensureDataDirs } from '../config.js';
import { openDatabase,closeDatabase,getDb,runMigrations } from '../db/db.js';
import { initLogger } from '../util/logger.js';
import { seedSampleData } from '../seed/sampleData.js';
import { createServer } from '../http/server.js';
import { httpJson,openRoleSessions } from './testHttp.js';

let tests=0;function ok(v,msg){if(!v)throw Error(msg);}function pass(n){console.log('PASS',n);tests++;}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gtct-commission-E3C1-'));
process.env.GTCT_LOCAL_DATA_DIR=dir;process.env.GTCT_LOCAL_HOST='127.0.0.1';
process.env.GTCT_LOCAL_PORT='19079';process.env.GTCT_OPERATING_MODE='TEST';
for(const k of ['GTCT_TLS_CERT_FILE','GTCT_TLS_KEY_FILE','GTCT_ALLOW_LAN_BIND','GTCT_ENABLE_LAN_LISTENER',
  'GTCT_LAN_BIND_ADDRESS','GTCT_ENABLE_PHYSICAL_PRINT','GTCT_TEST_BACKUP_DIR','GTCT_ENABLE_TEST_AUTO_BACKUP'])delete process.env[k];
const config=loadConfig({mode:'http'});
const api=(m,p,c,b)=>httpJson(config.port,m,p,c,b);
let server;
try {
  ok(config.operatingMode==='TEST'&&config.loopback&&!config.physicalPrintEnabled&&
    path.resolve(config.dbPath).startsWith(path.resolve(dir)+path.sep),'TEST isolation only');
  pass('temporary-TEST-DB-only');
  ensureDataDirs(config);initLogger(config.logDir);openDatabase(config.dbPath);
  await runMigrations(getDb());seedSampleData(config);
  ok(Boolean(getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='delivery_commission_policies'").get()),'migration 038 absent');
  pass('additive-policy-history-migration');
  server=createServer(config);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve)});
  const {admin,device:cashier}=await openRoleSessions(config.port,config.testTenantId);
  let r=await api('POST','/v1/staff-users',admin,{fullName:'Commission Test Rider',username:'e3c.rider',
    password:'E3C-Rider-246',confirmPassword:'E3C-Rider-246',role:'delivery',isActive:true,stationIds:[],permissions:[]});
  ok(r.status===201,`rider create ${r.json?.error}`);
  const list=await api('GET','/v1/delivery-commissions',admin);
  ok(list.status===200&&list.json.riders.some(x=>x.fullName==='Commission Test Rider'),'rider roster');
  const riderId=list.json.riders.find(x=>x.fullName==='Commission Test Rider').userId;
  const date=list.json.businessDate,decimals=list.json.currencyDecimals,unit=10**decimals;
  pass('admin-rider-roster-and-currency');
  ok((await api('GET','/v1/delivery-commissions',cashier)).status===403,'cashier denied');
  ok((await api('GET','/v1/delivery-commissions',null)).status===401,'anonymous denied');
  pass('admin-only-policy-access');
  const pv=`/v1/delivery-commissions/${riderId}/preview?businessDate=${date}`;
  const preview0=await api('GET',pv,admin);
  ok(preview0.status===200&&preview0.json.estimatedCommissionMinor===null,'no policy no amount');
  pass('unconfigured-preview-not-zero-payable');
  const body={submissionId:'commission_test_fixed_1',effectiveBusinessDate:date,
    policy:{method:'FIXED_PER_DELIVERY',period:'DAILY',amountMinor:unit}};
  r=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,admin,body);
  ok(r.status===201&&r.json.version===1,'save v1');pass('fixed-per-delivery-policy-saved');
  const repeated=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,admin,body);
  ok(repeated.status===200&&repeated.json.replayed===true,'idempotent repeat');pass('idempotent-exact-save');
  r=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,admin,{...body,policy:{method:'NONE'}});
  ok(r.status===409&&r.json.code==='SUBMISSION_CONFLICT','id changed payload');pass('reused-id-conflict-rejected');
  r=await api('POST','/v1/delivery-commissions/foreign_rider/policy',admin,{...body,submissionId:'foreign_rider_attempt'});
  ok(r.status===404,'unknown rider rejected');pass('rider-shop-isolation');
  r=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,cashier,{...body,submissionId:'cashier_bad_attempt'});
  ok(r.status===403,'cashier mutation rejected');pass('cashier-cannot-change-rules');
  const badPolicy={...body,submissionId:'bad_policy_attempt',policy:{method:'PERCENTAGE',basis:'TOTAL_BILL',rateBps:11000}};
  r=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,admin,badPolicy);
  ok(r.status===400,'invalid rate');pass('rate-over-100-rejected');
  const wrong={...body,submissionId:'wrong_shop_attempt',shopId:'other-tenant'};
  r=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,admin,wrong);
  ok(r.status===403,'shop mismatch');pass('shop-mismatch-rejected');
  // Add two bona fide DELIVERY orders through order creation API; simulate only the
  // subsequent accepted+delivered ledger rows inside the disposable TEST DB.
  const customer=await api('POST','/v1/customers',admin,{name:'Commission Test Customer',phone:'55000988',
    label:'Office',buildingNumber:'11',roadNumber:'22',blockNumber:'44'});
  ok(customer.status===201,`customer ${customer.json?.error}`);
  const cid=customer.json.customer.customerId,aid=customer.json.customer.addresses[0].addressId;
  const fee=await api('PUT','/v1/block-delivery-rates',admin,
    {blockNumber:'44',chargeCents:unit,taxApplicable:false,isActive:true});
  ok(fee.status===200,'block fee');
  const invoices=[];
  for(let i=0;i<2;i++){
    const created=await api('POST','/v1/test-orders',cashier,{orderNumber:`COM-${randomUUID()}`,
      orderType:'DELIVERY',fulfillment:{customerId:cid,addressId:aid,blockNumber:'44',roadNumber:'22',buildingNumber:'11',
      expectedBlockRateCents:unit,deliveryChargeCents:unit},lines:[{itemId:'item_orange_juice',quantity:1}]});
    ok(created.status===201,`invoice ${created.json?.error}`);
    invoices.push(created.json.order.order_id);
  }
  const db=getDb();const beforeSales=db.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
  const beforePayment=db.prepare('SELECT COUNT(*) AS n FROM order_payment_allocations').get().n;
  for(const id of invoices){
    db.prepare(`INSERT INTO order_delivery_claims(shop_id,order_id,driver_user_id,accepted_at,prep_revision)
      VALUES(?,?,?,?,?)`).run(config.testTenantId,id,riderId,new Date().toISOString(),'a'.repeat(64));
    db.prepare(`INSERT INTO delivery_order_lifecycle(shop_id,order_id,status,version,reason,updated_at,updated_by_user_id,updated_by_role)
      VALUES(?,?,'DELIVERED',1,'',?,?,'delivery')`).run(config.testTenantId,id,new Date().toISOString(),riderId);
  }
  pass('two-delivered-test-orders-fixtures');
  const sample=await api('GET',pv,admin);
  ok(sample.status===200&&sample.json.eligibleDeliveryCount===2&&sample.json.estimatedCommissionMinor===2*unit,
    `fixed preview ${JSON.stringify(sample.json)}`);
  pass('fixed-per-delivery-live-preview');
  const threshold=sample.json.totalBillMinor;
  const tier={submissionId:'commission_test_tiers_2',effectiveBusinessDate:date,
    policy:{method:'TIERED_FIXED',period:'DAILY',basis:'TOTAL_BILL',tiers:[
      {thresholdMinor:Math.floor(threshold/2),rewardMinor:50},
      {thresholdMinor:threshold,rewardMinor:100}]}};
  r=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,admin,tier);
  ok(r.status===201&&r.json.version===2,'v2 tiers');
  const tierPreview=await api('GET',pv,admin);
  ok(tierPreview.json.estimatedCommissionMinor===100,'highest tier, not sum');
  pass('non-additive-daily-target');
  const pct={submissionId:'commission_test_percent_3',effectiveBusinessDate:date,
    policy:{method:'PERCENTAGE',period:'DAILY',basis:'DELIVERY_CHARGE',rateBps:500}};
  r=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,admin,pct);
  ok(r.status===201&&r.json.version===3,'v3 percent');
  const p=await api('GET',pv,admin);
  ok(p.json.estimatedCommissionMinor===Math.floor((p.json.deliveryChargeMinor*500+5000)/10000),'percentage 5%');
  pass('percentage-of-delivery-charge');
  const manual={submissionId:'commission_test_manual_4',effectiveBusinessDate:date,
    policy:{method:'MANUAL',period:'DAILY',amountMinor:75}};
  r=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,admin,manual);
  ok(r.status===201&&(await api('GET',pv,admin)).json.estimatedCommissionMinor===75,'manual preview');
  pass('manual-estimate-not-approval');
  const none={submissionId:'commission_test_none_5',effectiveBusinessDate:date,
    policy:{method:'NONE',period:'DAILY'}};
  r=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,admin,none);
  ok(r.status===201&&(await api('GET',pv,admin)).json.estimatedCommissionMinor===0,'none');
  pass('no-commission-rule');
  const all=db.prepare('SELECT version,policy_json FROM delivery_commission_policies WHERE shop_id=? AND rider_user_id=? ORDER BY version')
    .all(config.testTenantId,riderId);
  ok(all.length===5&&all.map(x=>x.version).join(',')==='1,2,3,4,5','immutable versions');
  pass('append-only-five-versions');
  const previousDate=new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  const before=await api('GET',`/v1/delivery-commissions/${riderId}/preview?businessDate=${previousDate}`,admin);
  ok(before.status===200&&before.json.activePolicy===null,'no retroactive policy');
  pass('past-period-not-retroactively-covered');
  const invalid=await api('POST',`/v1/delivery-commissions/${riderId}/policy`,admin,
    {submissionId:'past_date_attempt',effectiveBusinessDate:previousDate,policy:{method:'NONE',period:'DAILY'}});
  ok(invalid.status===409,'past date reject');pass('cannot-backdate-policy');
  ok(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n===beforeSales&&
    db.prepare('SELECT COUNT(*) AS n FROM order_payment_allocations').get().n===beforePayment&&
    db.prepare('SELECT COUNT(*) AS n FROM delivery_cash_handovers').get().n===0,'no money posting');
  pass('no-sales-payment-or-handover-mutations');
  const audit=db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='delivery.commission.policy.created'").get().n;
  ok(audit===5,'immutable audit per new policy');pass('audit-record-for-each-version');
  console.log(`P2-E3C1 COMMISSION SETTINGS ${tests} passed`);
} finally {
  if(server) await new Promise(resolve=>server.close(resolve));
  closeDatabase();fs.rmSync(dir,{recursive:true,force:true});
}
