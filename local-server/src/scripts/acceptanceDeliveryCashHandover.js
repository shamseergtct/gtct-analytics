/** P2-E3B: disposable loopback TEST DB, never contacts a real restaurant ledger. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureDataDirs } from '../config.js';
import { openDatabase, getDb, closeDatabase, runMigrations } from '../db/db.js';
import { initLogger } from '../util/logger.js';
import { createServer } from '../http/server.js';
import { seedSampleData } from '../seed/sampleData.js';
import { httpJson, openRoleSessions } from './testHttp.js';

let passed=0;
function must(p,msg) { if(!p) throw Error(msg||'assertion failed'); }
function pass(msg) { console.log('PASS',msg);passed++; }
function cookie(resp) {
  const raw=resp.headers['set-cookie'];
  return decodeURIComponent(/gtct_ls_session=([^;]+)/.exec(Array.isArray(raw)?raw.join(';'):String(raw||''))?.[1] || '');
}
const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'gtct-handover-E3B-'));
process.env.GTCT_LOCAL_DATA_DIR=tempRoot;
process.env.GTCT_LOCAL_HOST='127.0.0.1';
process.env.GTCT_LOCAL_PORT='19068';
process.env.GTCT_OPERATING_MODE='TEST';
for(const k of ['GTCT_TLS_CERT_FILE','GTCT_TLS_KEY_FILE','GTCT_ALLOW_LAN_BIND',
 'GTCT_ENABLE_LAN_LISTENER','GTCT_LAN_BIND_ADDRESS','GTCT_ENABLE_PHYSICAL_PRINT',
 'GTCT_TEST_BACKUP_DIR','GTCT_ENABLE_TEST_AUTO_BACKUP']) delete process.env[k];
const config=loadConfig({mode:'http'});
let server;
const api=(method,route,cookie,body,options)=>httpJson(config.port,method,route,cookie,body,options);
const handover=o=>`/v1/delivery-cash-handovers/${o.id}/confirm`;
async function makeDelivery(cashier,admin,driver,customer) {
  const created=await api('POST','/v1/test-orders',cashier,{
    orderType:'DELIVERY',orderNumber:`HC-${randomUUID()}`,
    fulfillment:{customerId:customer.customerId,addressId:customer.addressId,
      blockNumber:'44',roadNumber:'33',buildingNumber:'17',
      expectedBlockRateCents:250,deliveryChargeCents:250},
    lines:[{itemId:'item_orange_juice',quantity:1}],
  });
  must(created.status===201,`create order: ${created.status} ${created.json?.error}`);
  const o={id:created.json.order.order_id,total:created.json.order.total_cents,
    currency:created.json.order.currency_code};
  const board=await api('GET','/v1/prep-board?stationId=station_juice',cashier);
  const ticket=board.json.tickets.find(t=>t.orderId===o.id);
  must(ticket?.status==='NEW','ticket not ready');
  let r=await api('POST','/v1/prep-board/accept',cashier,
    {orderId:o.id,stationId:'station_juice',expectedStatus:ticket.status,expectedRevision:ticket.revision});
  must(r.status===200,`accept: ${r.json?.error}`);
  const t=(await api('GET','/v1/prep-board?stationId=station_juice',cashier)).json.tickets.find(t=>t.orderId===o.id);
  r=await api('POST','/v1/prep-board/finish',cashier,
    {orderId:o.id,stationId:'station_juice',expectedStatus:t.status,expectedRevision:t.revision});
  must(r.status===200,`finish: ${r.json?.error}`);
  const detail=await api('GET',`/v1/order-monitor/${o.id}`,admin);
  r=await api('POST',`/v1/order-monitor/${o.id}/ready`,cashier,
    {expectedRevision:detail.json.order.dispatch.revision});
  must(r.status===200,`pack: ${r.json?.error}`);
  const pool=await api('GET','/v1/delivery-pool',driver);
  const available=pool.json.orders.find(x=>x.orderId===o.id);
  must(available?.expectedRevision,'order missing from delivery pool');
  r=await api('POST',`/v1/delivery-pool/${o.id}/accept`,driver,
    {expectedRevision:available.expectedRevision});
  must(r.status===200,`claim: ${r.json?.error}`);
  r=await api('POST',`/v1/delivery-pool/${o.id}/payment-report`,driver,
    {reportType:'CASH_WITH_BOY',expectedVersion:0});
  must(r.status===200,`cash report: ${r.json?.error}`);
  return o;
}
try {
  must(config.operatingMode==='TEST' && config.loopback && !config.physicalPrintEnabled &&
    path.resolve(config.dbPath).startsWith(path.resolve(tempRoot)+path.sep),'must use TEST temp DB');
  pass('temporary-TEST-loopback-and-no-real-printers');
  ensureDataDirs(config);initLogger(config.logDir);openDatabase(config.dbPath);
  await runMigrations(getDb());seedSampleData(config);
  must(!!getDb().prepare("SELECT name FROM sqlite_master WHERE name='delivery_cash_handovers'").get(),
    '037 not migrated');pass('additive-handover-migration');
  server=createServer(config);
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(config.port,config.host,ok)});
  const {admin,device:cashier}=await openRoleSessions(config.port,config.testTenantId);
  const newRider=await api('POST','/v1/staff-users',admin,{
    fullName:'Handover Driver',username:'handover.driver',
    password:'Handover-Driver-246',confirmPassword:'Handover-Driver-246',
    role:'delivery',isActive:true,stationIds:[],permissions:[]});
  must(newRider.status===201,`create driver ${newRider.json?.error}`);
  const login=await api('POST','/v1/session/login',null,
    {username:'handover.driver',password:'Handover-Driver-246'},{origin:true});
  must(login.status===200 && cookie(login),'delivery session');
  const driver=cookie(login);
  const who=await api('GET','/v1/session/me',driver);
  const riderId=who.json.userId;
  must(riderId,'rider identity');
  pass('role-based-admin-cashier-rider-sessions');
  const cust=await api('POST','/v1/customers',admin,{name:'Mock Handover Customer',phone:'55000001',label:'Test Home',
    buildingNumber:'17',roadNumber:'33',blockNumber:'44'});
  must(cust.status===201,`customer ${cust.json?.error}`);
  const customer={customerId:cust.json.customer.customerId,addressId:cust.json.customer.addresses[0].addressId};
  const fee=await api('PUT','/v1/block-delivery-rates',admin,
    {blockNumber:'44',chargeCents:250,taxApplicable:false,isActive:true});
  must(fee.status===200,`fee ${fee.json?.error}`);
  const o=await makeDelivery(cashier,admin,driver,customer);
  pass('delivery-claim-and-cash-with-boy-report');
  const body={submissionId:'handover_testing_12345',expectedReportVersion:1,
    driverUserId:riderId,amountCents:o.total,currencyCode:o.currency};
  const list0=await api('GET','/v1/delivery-cash-handovers',cashier);
  must(Array.isArray(list0.json.riders) && list0.json.riders.some(r=>
    r.userId===riderId && r.fullName==='Handover Driver' && r.isActive===true) &&
    list0.json.riders.every(r=>Object.keys(r).sort().join(',')==='fullName,isActive,userId'),
    'cashier sees safe rider roster even before order is delivered');
  pass('cashier-rider-list-includes-no-pending-and-hides-sensitive-fields');
  const riderRosterDenied=await api('GET','/v1/delivery-cash-handovers',driver);
  must(riderRosterDenied.status===403,'delivery boy cannot read cashier rider roster');
  pass('cashier-roster-permissions-preserved');
  must(list0.status===200 && !list0.json.pending.some(r=>r.orderId===o.id),
    'undelivered excluded from cash queue');pass('undelivered-orders-not-eligible');
  let r=await api('POST',handover(o),cashier,body);
  must(r.status===409 && r.json.code==='NOT_DELIVERED','delivered condition enforced');
  pass('no-handover-before-delivery');
  const legacy=await api('POST',`/v1/orders/${o.id}/settlements`,cashier,
    {submissionId:'legacyridercash_test',tender:'CASH',amountCents:o.total,currencyCode:o.currency});
  must(legacy.status===409 && legacy.json.code==='RIDER_CASH_CUSTODY',
    `legacy cash guard: ${legacy.json?.code}`);
  pass('legacy-payment-cannot-bypass-rider-custody');
  const allocated=await api('POST',`/v1/orders/${o.id}/payment-allocations`,cashier,
    {submissionId:'split_handover_test',cashCents:o.total,bankCents:0,creditCents:0,currencyCode:o.currency});
  must(allocated.status===409 && allocated.json.code==='RIDER_CASH_CUSTODY','generic split guard');
  pass('generic-split-payment-cannot-bypass-rider-custody');
  const status=await api('POST',`/v1/delivery-pool/${o.id}/status`,driver,
    {action:'DELIVERED',expectedVersion:0});
  must(status.status===200 && status.json.status==='DELIVERED',
    `marked delivered: ${status.json.error}`);
  pass('delivered-confirmed');
  const list1=await api('GET','/v1/delivery-cash-handovers',cashier);
  const pending=list1.json.pending.find(p=>p.orderId===o.id);
  must(pending?.reportVersion===1 && pending.amountCents===o.total,'handover queue');
  pass('pending-cash-visible-to-cashier');
  const guest=await api('POST',handover(o),null,body);
  const riderForbidden=await api('POST',handover(o),driver,body);
  must(guest.status===401 && riderForbidden.status===403,'role enforcement');
  pass('guest-rider-cannot-confirm-cash');
  const wrongAmount=await api('POST',handover(o),cashier,{...body,amountCents:o.total+1});
  must(wrongAmount.status===409 && wrongAmount.json.code==='AMOUNT_MISMATCH','full exact amount');
  pass('no-partial-or-overpayment');
  const wrongRider=await api('POST',handover(o),cashier,{...body,driverUserId:'someone_else'});
  must(wrongRider.status===409 && wrongRider.json.code==='CUSTODY_NOT_CONFIRMED','rider mismatch');
  pass('no-wrong-rider-credit');
  const wrongShop=await api('POST',handover(o),cashier,{...body,shopId:'different-shop'});
  must(wrongShop.status===403 && wrongShop.json.code==='SHOP_MISMATCH','shop isolation');
  pass('shop-isolation');
  const before=getDb().prepare('SELECT total_cents,updated_at,tax_cents FROM orders WHERE order_id=?').get(o.id);
  const result=await api('POST',handover(o),cashier,body);
  must(result.status===201 && result.json.created && result.json.amountCents===o.total,
    `handover success: ${result.status} ${result.json?.error}`);
  pass('cashier-confirmed-atomic-handover');
  const row=getDb().prepare('SELECT * FROM delivery_cash_handovers WHERE shop_id=? AND order_id=?')
    .get(config.testTenantId,o.id);
  const alloc=getDb().prepare('SELECT * FROM order_payment_allocations WHERE allocation_id=?')
    .get(row.allocation_id);
  const bal=getDb().prepare('SELECT * FROM order_payment_balances WHERE order_id=? AND shop_id=?')
    .get(o.id,config.testTenantId);
  must(alloc.cash_cents===o.total && alloc.bank_cents===0 && alloc.credit_cents===0 &&
    bal.paid_cents===o.total && bal.balance_cents===0 && bal.payment_status==='PAID',
    'payment summary incorrect');
  pass('exactly-one-shop-cash-allocation-and-paid-balance');
  must(getDb().prepare('SELECT COUNT(*) AS n FROM order_settlements WHERE order_id=?').get(o.id).n===0,
    'legacy settlement incorrectly added');
  const after=getDb().prepare('SELECT total_cents,updated_at,tax_cents FROM orders WHERE order_id=?').get(o.id);
  must(JSON.stringify(before)===JSON.stringify(after),'order mutated by handover');
  pass('no-duplicate-sales-or-order-rewrite');
  const replay=await api('POST',handover(o),cashier,body);
  must(replay.status===200 && replay.json.replayed && replay.json.handoverId===result.json.handoverId,
    'idempotent replay');
  pass('same-submission-retry-is-idempotent');
  const conflict=await api('POST',handover(o),cashier,{...body,submissionId:'another_handover_retry'});
  must(conflict.status===409 && conflict.json.code==='ALREADY_HANDED_OVER','duplicate handover prevention');
  pass('new-submission-same-order-rejected');
  const changed=await api('POST',handover(o),cashier,{...body,amountCents:o.total+2});
  must(changed.status===409 && changed.json.code==='SUBMISSION_CONFLICT','same id different payload');
  pass('same-id-changed-payload-rejected');
  const list2=await api('GET','/v1/delivery-cash-handovers',cashier);
  must(!list2.json.pending.some(p=>p.orderId===o.id) &&
    list2.json.history.some(p=>p.orderId===o.id),'pending/history');
  pass('history-visible-no-pending-after-handover');
  const monitor=await api('GET',`/v1/order-monitor/${o.id}`,admin);
  must(monitor.status===200 && monitor.json.order.paymentStatus==='PAID',
    'monitor read model should see PAID');
  pass('order-monitor-paid-reconciliation');
  const voided=await api('POST',`/v1/orders/${o.id}/void`,admin,
    {reason:'Trying to void already-paid rider cash',expectedUpdatedAt:after.updated_at});
  must(voided.status===409,'paid invoice must not be voided');pass('paid-invoice-void-blocked');
  const audit=getDb().prepare(`SELECT COUNT(*) AS n FROM audit_events
    WHERE action='delivery.cash.handover.confirm' AND entity_id=?`).get(row.handover_id).n;
  must(audit===1,'handover audit must be unique');pass('one-immutable-confirmation-audit');
  console.log(`P2-E3B DELIVERY CASH HANDOVER ${passed} passed`);
} finally {
  if(server) await new Promise(resolve=>server.close(resolve));
  closeDatabase();
  fs.rmSync(tempRoot,{recursive:true,force:true});
}
