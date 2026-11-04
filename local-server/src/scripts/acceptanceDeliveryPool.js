/** Disposable local TEST acceptance: never touches a live restaurant or Firebase. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureDataDirs } from '../config.js';
import { openDatabase, getDb, closeDatabase, runMigrations } from '../db/db.js';
import { initLogger } from '../util/logger.js';
import { createServer } from '../http/server.js';
import { seedSampleData } from '../seed/sampleData.js';
import { httpJson, openRoleSessions } from './testHttp.js';

let n=0;
function must(x,m){if(!x) throw new Error(m)}
function pass(name){console.log(`PASS ${name}`);n++}
function cookie(res){const raw=res.headers['set-cookie'];const str=Array.isArray(raw)?raw.join(';'):String(raw||'');return decodeURIComponent(/gtct_ls_session=([^;]+)/.exec(str)?.[1]||'')}

async function main() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gtct-p2e2a-delivery-'));
  process.env.GTCT_LOCAL_DATA_DIR=dir;
  process.env.GTCT_LOCAL_HOST='127.0.0.1';
  process.env.GTCT_LOCAL_PORT='19035';
  for(const k of ['GTCT_TLS_CERT_FILE','GTCT_TLS_KEY_FILE','GTCT_ALLOW_LAN_BIND','GTCT_ENABLE_LAN_LISTENER',
    'GTCT_LAN_BIND_ADDRESS','GTCT_ENABLE_PHYSICAL_PRINT','GTCT_LOCAL_OPERATING_MODE','GTCT_TEST_BACKUP_DIR',
    'GTCT_ENABLE_TEST_AUTO_BACKUP']) delete process.env[k];
  let server;
  const conf=loadConfig({mode:'http'});
  must(conf.operatingMode==='TEST' && conf.loopback && !conf.physicalPrintEnabled &&
    path.resolve(conf.dbPath).startsWith(path.resolve(dir)+path.sep),'disposable path guard');
  ensureDataDirs(conf);initLogger(conf.logDir);
  try {
    openDatabase(conf.dbPath);await runMigrations(getDb());seedSampleData(conf);
    server=createServer(conf);
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(conf.port,conf.host,resolve)});
    pass('temp-sqlite-test-mode-only');
    const adminCashier=await openRoleSessions(conf.port,conf.testTenantId);
    const admin=adminCashier.admin,cashier=adminCashier.device;
    const d1=await httpJson(conf.port,'POST','/v1/staff-users',admin,{
      fullName:'Test Nasir',username:'test.nasir',password:'Route-Nasir-246',confirmPassword:'Route-Nasir-246',
      role:'delivery',isActive:true,stationIds:[],permissions:[]});
    const d2=await httpJson(conf.port,'POST','/v1/staff-users',admin,{
      fullName:'Test Hilal',username:'test.hilal',password:'Route-Hilal-357',confirmPassword:'Route-Hilal-357',
      role:'delivery',isActive:true,stationIds:[],permissions:[]});
    must(d1.status===201&&d2.status===201&&d1.json.user.role==='delivery','driver setup');
    pass('admin-creates-two-local-test-delivery-staff');
    const badGrant=await httpJson(conf.port,'POST','/v1/staff-users',admin,{
      fullName:'Bad User',username:'test.badgrant',password:'Route-Blocked-456',confirmPassword:'Route-Blocked-456',
      role:'delivery',permissions:['sales.price_override'],stationIds:[]});
    must(badGrant.status===400,'delivery restricted grant rejected');
    pass('delivery-cannot-receive-sales-grants');
    const l1=await httpJson(conf.port,'POST','/v1/session/login',null,{username:'test.nasir',password:'Route-Nasir-246'},{origin:true});
    const l2=await httpJson(conf.port,'POST','/v1/session/login',null,{username:'test.hilal',password:'Route-Hilal-357'},{origin:true});
    const c1=cookie(l1),c2=cookie(l2);
    must(l1.status===200&&l2.status===200&&c1&&c2,'driver sessions');
    const me=await httpJson(conf.port,'GET','/v1/session/me',c1);
    must(me.json.role==='delivery'&&me.json.permissions.length===2 &&
      !me.json.permissions.includes('sales.order.create'),'delivery role rights');
    pass('limited-delivery-session-role');
    const noSession=await httpJson(conf.port,'GET','/v1/delivery-pool');
    const adminPool=await httpJson(conf.port,'GET','/v1/delivery-pool',admin);
    const sales=await httpJson(conf.port,'GET','/v1/order-register',c1);
    const monitor=await httpJson(conf.port,'GET','/v1/order-monitor',c1);
    const prep=await httpJson(conf.port,'GET','/v1/prep-board?stationId=station_juice',c1);
    must(noSession.status===401 && adminPool.status===403 &&
      sales.status===403 && monitor.status===403 && prep.status===403,'session scope');
    pass('guest-manager-and-delivery-privilege-boundary');
    const redirect=await httpJson(conf.port,'GET','/',c1);
    const page=await httpJson(conf.port,'GET','/delivery-pool.html',c1);
    must(redirect.status===302&&redirect.headers.location==='/delivery-pool.html'&&page.status===200,'delivery page redirect');
    pass('sales-html-redirects-delivery-to-own-page');
    const cust=await httpJson(conf.port,'POST','/v1/customers',admin,{
      name:'Route Test',phone:'55512345',label:'Home',buildingNumber:'17',roadNumber:'33',blockNumber:'44',addressNote:'QA only'});
    must(cust.status===201,cust.json?.error||'customer');
    const address=cust.json.customer.addresses[0];
    const rate=await httpJson(conf.port,'PUT','/v1/block-delivery-rates',admin,{
      blockNumber:'44',chargeCents:250,taxApplicable:false,isActive:true});
    must(rate.status===200,rate.json?.error||'block fee');
    const ids=[];
    for(const [i,road] of [['1','33'],['2','34']]) {
      const created=await httpJson(conf.port,'POST','/v1/test-orders',cashier,{
        orderNumber:`E2A-DELIVERY-${i}`,orderType:'DELIVERY',fulfillment:{customerId:cust.json.customer.customerId,
          addressId:address.addressId,blockNumber:'44',roadNumber:road,buildingNumber:'17',
          expectedBlockRateCents:250,deliveryChargeCents:250},
        lines:[{itemId:'item_orange_juice',quantity:1}]});
      must(created.status===201,created.json?.error||'delivery creation');ids.push(created.json.order.order_id);
    }
    pass('two-delivery-orders-for-same-block');
    const noReady=await httpJson(conf.port,'GET','/v1/delivery-pool',c1);
    must(noReady.status===200&&noReady.json.orders.length===0,'packing gating');
    pass('no-pool-visibility-before-kitchen-and-packing');
    for(const orderId of ids) {
      const board=await httpJson(conf.port,'GET','/v1/prep-board?stationId=station_juice',cashier);
      const ticket=board.json.tickets.find(t=>t.orderId===orderId);
      must(ticket?.status==='NEW','ticket not new');
      const accepted=await httpJson(conf.port,'POST','/v1/prep-board/accept',cashier,{
        orderId,stationId:'station_juice',expectedStatus:ticket.status,expectedRevision:ticket.revision});
      must(accepted.status===200,accepted.json?.error||'prep accept');
      const nextBoard=await httpJson(conf.port,'GET','/v1/prep-board?stationId=station_juice',cashier);
      const next=nextBoard.json.tickets.find(t=>t.orderId===orderId);
      must(next?.status==='ACCEPTED','prep transition');
      const finished=await httpJson(conf.port,'POST','/v1/prep-board/finish',cashier,{
        orderId,stationId:'station_juice',expectedStatus:next.status,expectedRevision:next.revision});
      must(finished.status===200,finished.json?.error||'prep finish');
      const detail=await httpJson(conf.port,'GET',`/v1/order-monitor/${orderId}`,admin);
      must(detail.json.order.preparation.allFinished && !detail.json.order.dispatch.ready,'pre packing stage');
      const pack=await httpJson(conf.port,'POST',`/v1/order-monitor/${orderId}/ready`,cashier,{
        expectedRevision:detail.json.order.dispatch.revision});
      must(pack.status===200,pack.json?.error||'packing ready');
    }
    pass('readiness-follows-real-kitchen-completion');
    const pool1=await httpJson(conf.port,'GET','/v1/delivery-pool',c1);
    const pool2=await httpJson(conf.port,'GET','/v1/delivery-pool',c2);
    must(pool1.json.orders.length===2&&pool2.json.orders.length===2,'shared pool');
    pass('same-two-orders-visible-to-both-drivers');
    const byBlock=await httpJson(conf.port,'GET','/v1/delivery-pool?block=44',c1);
    const byRoad=await httpJson(conf.port,'GET','/v1/delivery-pool?block=44&road=34',c1);
    const noBlock=await httpJson(conf.port,'GET','/v1/delivery-pool?block=999',c1);
    must(byBlock.json.orders.length===2&&byRoad.json.orders.length===1&&
      noBlock.json.orders.length===0,'route filters');
    pass('block-and-road-filters');
    const amountBefore=getDb().prepare(`SELECT total_cents FROM orders WHERE order_id=?`).get(ids[0]).total_cents;
    const bad=await httpJson(conf.port,'POST',`/v1/delivery-pool/${ids[0]}/accept`,c1,{});
    const badRev=await httpJson(conf.port,'POST',`/v1/delivery-pool/${ids[0]}/accept`,c1,{expectedRevision:'a'.repeat(64)});
    must(bad.status===400&&badRev.status===409,'no-stale');
    pass('missing-and-stale-revisions-rejected');
    const mismatch=await httpJson(conf.port,'POST',`/v1/delivery-pool/${ids[0]}/accept`,c1,{
      expectedRevision:pool1.json.orders[0].expectedRevision,shopId:'wrong-shop'});
    must(mismatch.status===403,'shop mismatch');pass('shop-scope-mismatch-blocked');
    const claim=await httpJson(conf.port,'POST',`/v1/delivery-pool/${ids[0]}/accept`,c1,{
      expectedRevision:pool1.json.orders.find(o=>o.orderId===ids[0]).expectedRevision});
    must(claim.status===200&&!claim.json.alreadyAccepted,'first accept');
    must(claim.json.sameBlockSuggestions?.some(o=>o.orderId===ids[1]),'same block suggestion');
    pass('first-accept-wins-and-suggests-same-block');
    const other=await httpJson(conf.port,'POST',`/v1/delivery-pool/${ids[0]}/accept`,c2,{
      expectedRevision:pool2.json.orders.find(o=>o.orderId===ids[0]).expectedRevision});
    must(other.status===409&&other.json.code==='ALREADY_ACCEPTED','no double claims');
    pass('second-driver-cannot-claim-same-order');
    const retry=await httpJson(conf.port,'POST',`/v1/delivery-pool/${ids[0]}/accept`,c1,{
      expectedRevision:pool1.json.orders.find(o=>o.orderId===ids[0]).expectedRevision});
    must(retry.status===200&&retry.json.alreadyAccepted,'retry');
    pass('same-driver-retry-idempotent');
    const my1=await httpJson(conf.port,'GET','/v1/delivery-pool/mine',c1);
    const my2=await httpJson(conf.port,'GET','/v1/delivery-pool/mine',c2);
    const remaining=await httpJson(conf.port,'GET','/v1/delivery-pool',c2);
    must(my1.json.orders.length===1&&my2.json.orders.length===0&&
      remaining.json.orders.length===1,'per driver lists');
    pass('claimed-order-disappears-from-open-pool');
    const details=await httpJson(conf.port,'GET',`/v1/order-monitor/${ids[0]}`,admin);
    must(details.json.order.deliveryBoyName==='Test Nasir'&&
      details.json.order.operationalStatus==='ACCEPTED_BY_DELIVERY_BOY','monitor assigned');
    pass('order-monitor-shows-real-claim-owner');
    const orderList=await httpJson(conf.port,'GET','/v1/order-register?behavior=DELIVERY',admin);
    must(orderList.json.orders.some(o=>o.orderId===ids[0]&&o.deliveryBoyName==='Test Nasir'),'order register rider');
    pass('order-register-shows-real-delivery-boy');
    const snapshotAfter=getDb().prepare(`SELECT total_cents FROM orders WHERE order_id=?`).get(ids[0]).total_cents;
    const claimCount=getDb().prepare(`SELECT COUNT(*) n FROM order_delivery_claims`).get().n;
    const settlements=getDb().prepare(`SELECT COUNT(*) n FROM order_settlements WHERE order_id=?`).get(ids[0]).n;
    must(amountBefore===snapshotAfter&&claimCount===1&&settlements===0,'finance unchanged');
    pass('orders-prices-payment-ledgers-untouched');
    const changed=await httpJson(conf.port,'PATCH',`/v1/staff-users/${d1.json.user.userId}`,admin,{isActive:false});
    must(changed.status===200,'deactivation');
    const revoked=await httpJson(conf.port,'GET','/v1/delivery-pool',c1);
    must(revoked.status===401,'session revoke');
    pass('deactivated-delivery-account-session-revoked');
    const audit=getDb().prepare(`SELECT COUNT(*) n FROM audit_events WHERE action='delivery.order.accept'`).get();
    must(audit.n===1,'audit duplicate');
    pass('acceptance-audit-exactly-once');
    console.log(`Delivery pool ${n} passed (temporary SQLite, local TEST only, no Firebase/financial writes)`);
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    closeDatabase();fs.rmSync(dir,{recursive:true,force:true});
  }
}
main().catch(err=>{console.error(err);process.exitCode=1});
