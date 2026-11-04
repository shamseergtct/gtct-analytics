/** P2-E2C0: disposable TEST-only delivery payment-report acceptance. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureDataDirs } from '../config.js';
import { openDatabase, getDb, closeDatabase, runMigrations } from '../db/db.js';
import { initLogger } from '../util/logger.js';
import { createServer } from '../http/server.js';
import { seedSampleData } from '../seed/sampleData.js';
import { httpJson, openRoleSessions } from './testHttp.js';

let passed = 0;
function must(ok, message) { if (!ok) throw new Error(message); }
function pass(name) { console.log(`PASS ${name}`); passed++; }
function sessionCookie(response) {
  const raw = response.headers['set-cookie'];
  const str = Array.isArray(raw) ? raw.join(';') : String(raw || '');
  return decodeURIComponent(/gtct_ls_session=([^;]+)/.exec(str)?.[1] || '');
}
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtct-p2e2c-payment-'));
  process.env.GTCT_LOCAL_DATA_DIR = dir;
  process.env.GTCT_LOCAL_HOST = '127.0.0.1';
  process.env.GTCT_LOCAL_PORT = '19037';
  for (const k of [
    'GTCT_TLS_CERT_FILE', 'GTCT_TLS_KEY_FILE', 'GTCT_ALLOW_LAN_BIND',
    'GTCT_ENABLE_LAN_LISTENER', 'GTCT_LAN_BIND_ADDRESS', 'GTCT_ENABLE_PHYSICAL_PRINT',
    'GTCT_LOCAL_OPERATING_MODE', 'GTCT_TEST_BACKUP_DIR', 'GTCT_ENABLE_TEST_AUTO_BACKUP',
  ]) delete process.env[k];
  let server;
  const config = loadConfig({ mode:'http' });
  must(config.operatingMode === 'TEST' && config.loopback && !config.physicalPrintEnabled &&
    path.resolve(config.dbPath).startsWith(path.resolve(dir) + path.sep), 'temporary TEST isolation');
  ensureDataDirs(config); initLogger(config.logDir);
  try {
    openDatabase(config.dbPath);
    await runMigrations(getDb());
    seedSampleData(config);
    server = createServer(config);
    await new Promise((ok, err) => {server.once('error', err); server.listen(config.port, config.host, ok);});
    pass('temporary-loopback-test-only');
    const { admin, device:cashier } = await openRoleSessions(config.port, config.testTenantId);
    const sessions = [];
    for (const [user, password] of [['test.route.one', 'Route-Test-One-246'],['test.route.two', 'Route-Test-Two-357']]) {
      const created = await httpJson(config.port, 'POST', '/v1/staff-users', admin, {
        fullName: user, username:user, password, confirmPassword:password,
        role:'delivery', isActive:true, stationIds:[], permissions:[],
      });
      must(created.status === 201, `cannot create ${user}: ${created.json?.error}`);
      const loggedIn = await httpJson(config.port,'POST','/v1/session/login',null,
        { username:user, password }, {origin:true});
      must(loggedIn.status === 200 && sessionCookie(loggedIn), `login ${user}`);
      sessions.push(sessionCookie(loggedIn));
    }
    const [driver1, driver2] = sessions;
    pass('two-restricted-delivery-staff');
    const cust = await httpJson(config.port, 'POST','/v1/customers',admin,{
      name:'Route QA Only', phone:'55000000', label:'Home',
      buildingNumber:'17',roadNumber:'33',blockNumber:'44',addressNote:'Not real',
    });
    must(cust.status === 201, `customer: ${cust.json?.error}`);
    const customerId = cust.json.customer.customerId;
    const addressId = cust.json.customer.addresses[0].addressId;
    for (const blockNumber of ['44','45']) {
      const fee = await httpJson(config.port,'PUT','/v1/block-delivery-rates',admin,
        {blockNumber,chargeCents:250,taxApplicable:false,isActive:true});
      must(fee.status === 200, `fee: ${fee.json?.error}`);
    }
    const ids = [];
    // Oldest available same-block diff-road is intentionally before same-road.
    for (const [i, blockNumber, roadNumber] of [
      ['anchor','44','33'], ['diff-road','44','34'], ['same-road','44','33'],
      ['other-block','45','33'],
    ]) {
      const created = await httpJson(config.port,'POST','/v1/test-orders',cashier,{
        orderNumber:`E2B-${i}`, orderType:'DELIVERY',
        fulfillment:{ customerId,addressId,blockNumber,roadNumber,buildingNumber:'17',
          expectedBlockRateCents:250,deliveryChargeCents:250 },
        lines:[{itemId:'item_orange_juice',quantity:1}],
      });
      must(created.status === 201,`create ${i}: ${created.json?.error}`);
      ids.push(created.json.order.order_id);
    }
    pass('four-test-orders-across-road-and-block');
    for (const orderId of ids) {
      const board = await httpJson(config.port,'GET','/v1/prep-board?stationId=station_juice',cashier);
      const ticket = board.json.tickets.find(t => t.orderId === orderId);
      must(ticket?.status === 'NEW',`ticket missing ${orderId}`);
      const accepted = await httpJson(config.port,'POST','/v1/prep-board/accept',cashier,{
        orderId,stationId:'station_juice', expectedStatus:ticket.status, expectedRevision:ticket.revision,
      });
      must(accepted.status === 200,`ticket accept ${orderId}`);
      const latest = await httpJson(config.port,'GET','/v1/prep-board?stationId=station_juice',cashier);
      const next = latest.json.tickets.find(t => t.orderId === orderId);
      must(next?.status === 'ACCEPTED','accepted station status');
      const finished = await httpJson(config.port,'POST','/v1/prep-board/finish',cashier,{
        orderId,stationId:'station_juice',expectedStatus:next.status,expectedRevision:next.revision,
      });
      must(finished.status === 200,`ticket finish ${orderId}`);
      const detail = await httpJson(config.port,'GET',`/v1/order-monitor/${orderId}`,admin);
      const pack = await httpJson(config.port,'POST',`/v1/order-monitor/${orderId}/ready`,cashier,{
        expectedRevision:detail.json.order.dispatch.revision,
      });
      must(pack.status === 200,`packing ${orderId}`);
    }
    pass('all-orders-really-packed-and-ready');
    const before = getDb().prepare('SELECT SUM(total_cents) total FROM orders WHERE is_test=1').get().total;
    const unclaimed = await httpJson(config.port,'GET',`/v1/delivery-pool/suggestions?orderId=${ids[0]}`,driver1);
    must(unclaimed.status === 404,'must own anchor');
    pass('suggestions-require-accepted-anchor');
    const pool = await httpJson(config.port,'GET','/v1/delivery-pool',driver1);
    const original = pool.json.orders.find(o => o.orderId === ids[0]);
    must(original?.expectedRevision,'anchor in pool');
    const claim = await httpJson(config.port,'POST',`/v1/delivery-pool/${ids[0]}/accept`,driver1,{
      expectedRevision:original.expectedRevision,
    });
    must(claim.status === 200 && !claim.json.alreadyAccepted, 'claim anchor');
    pass('anchor-first-accept');
    const rec = await httpJson(config.port,'GET',`/v1/delivery-pool/suggestions?orderId=${ids[0]}`,driver1);
    must(rec.status === 200 && rec.json.orders.length === 2,`recommendations ${JSON.stringify(rec.json)}`);
    must(rec.json.orders[0].orderId === ids[2] && rec.json.orders[0].suggestion === 'SAME_ROAD',
      'same road should be recommended before older other road');
    must(rec.json.orders[1].orderId === ids[1] && rec.json.orders[1].suggestion === 'SAME_BLOCK',
      'other block should never be recommended');
    pass('same-road-first-and-same-block-second');
    must(rec.json.orders.every(o => o.expectedRevision?.length === 64), 'revision for safe accept');
    must(claim.json.sameBlockSuggestions[0].orderId === ids[2], 'post accept sorting');
    pass('recommendations-are-actionable-not-claims');
    const strangers = await httpJson(config.port,'GET',`/v1/delivery-pool/suggestions?orderId=${ids[0]}`,driver2);
    const guest = await httpJson(config.port,'GET',`/v1/delivery-pool/suggestions?orderId=${ids[0]}`);
    const cashierProbe = await httpJson(config.port,'GET',`/v1/delivery-pool/suggestions?orderId=${ids[0]}`,cashier);
    must(strangers.status === 404 && guest.status === 401 && cashierProbe.status === 403,
      'unauthorized access to route anchor');
    pass('unauthorized-and-other-rider-anchor-blocked');
    const invalid = await httpJson(config.port,'GET','/v1/delivery-pool/suggestions?orderId=bad%2Fid',driver1);
    must(invalid.status === 400, 'bad order id');
    pass('invalid-route-anchor-rejected');
    const otherAccept = await httpJson(config.port,'POST',`/v1/delivery-pool/${ids[2]}/accept`,driver2,{
      expectedRevision:rec.json.orders[0].expectedRevision,
    });
    must(otherAccept.status === 200,'other rider can accept suggested available order');
    const stale = await httpJson(config.port,'POST',`/v1/delivery-pool/${ids[2]}/accept`,driver1,{
      expectedRevision:rec.json.orders[0].expectedRevision,
    });
    must(stale.status === 409 && stale.json.code === 'ALREADY_ACCEPTED', 'first wins');
    pass('suggestion-first-accept-wins-even-if-stale');
    const refreshed = await httpJson(config.port,'GET',`/v1/delivery-pool/suggestions?orderId=${ids[0]}`,driver1);
    must(refreshed.json.orders.length === 1 && refreshed.json.orders[0].orderId === ids[1],
      'stale suggested order removed');
    pass('suggestion-refresh-removes-other-rider-claims');
    const remaining = refreshed.json.orders[0];
    const acceptNext = await httpJson(config.port,'POST',`/v1/delivery-pool/${remaining.orderId}/accept`,driver1,{
      expectedRevision:remaining.expectedRevision,
    });
    const myOrders = await httpJson(config.port,'GET','/v1/delivery-pool/mine',driver1);
    must(acceptNext.status === 200 && myOrders.json.orders.length === 2,
      'one driver multiple orders');
    pass('one-rider-accepts-multiple-orders');
    const empty = await httpJson(config.port,'GET',`/v1/delivery-pool/suggestions?orderId=${ids[0]}`,driver1);
    must(empty.status === 200 && empty.json.orders.length === 0, 'no additional same block orders');
    pass('empty-route-suggestions-safe');
    // P2-E2C0: TEST-only payment reporting after safe claim, with no ledger posting.
    const path0 = `/v1/delivery-pool/${ids[0]}/payment-report`;
    const path1 = `/v1/delivery-pool/${ids[1]}/payment-report`;
    const path2 = `/v1/delivery-pool/${ids[2]}/payment-report`;
    const initial = await httpJson(config.port,'GET','/v1/delivery-pool/mine',driver1);
    must(initial.json.orders.every(o => o.paymentReport?.status === 'UNMARKED'), 'initial not marked');
    pass('accepted-orders-unmarked-default');
    const forbiddenGuest = await httpJson(config.port,'POST',path0,null,
      {reportType:'CASH_WITH_BOY',expectedVersion:0});
    const forbiddenCashier = await httpJson(config.port,'POST',path0,cashier,
      {reportType:'CASH_WITH_BOY',expectedVersion:0});
    const forbiddenAdmin = await httpJson(config.port,'POST',path0,admin,
      {reportType:'CASH_WITH_BOY',expectedVersion:0});
    must(forbiddenGuest.status===401&&forbiddenCashier.status===403&&forbiddenAdmin.status===403,
      'rider-only posting');
    pass('guest-cashier-admin-cannot-report-as-rider');
    const wrongRider = await httpJson(config.port,'POST',path0,driver2,
      {reportType:'CASH_WITH_BOY',expectedVersion:0});
    must(wrongRider.status===404,'cannot report other rider order');
    pass('driver-cannot-mark-other-driver-order');
    const badKind = await httpJson(config.port,'POST',path0,driver1,
      {reportType:'CREDIT',expectedVersion:0});
    must(badKind.status===400,'only reporting enum');
    pass('unsafe-accounting-payment-type-rejected');
    const missingVersion = await httpJson(config.port,'POST',path0,driver1,
      {reportType:'CASH_WITH_BOY'});
    must(missingVersion.status===400,'version required');
    pass('payment-report-version-required');
    const crossShop = await httpJson(config.port,'POST',path0,driver1,
      {reportType:'CASH_WITH_BOY',expectedVersion:0,shopId:'wrong-shop'});
    must(crossShop.status===403,'shop scope guard');
    pass('cross-shop-payment-mark-blocked');
    const marked = await httpJson(config.port,'POST',path0,driver1,
      {reportType:'CASH_WITH_BOY',expectedVersion:0});
    must(marked.status===200 && marked.json.version===1 && marked.json.created===true,
      'cash mark');
    pass('cash-with-driver-reported');
    const noLedger = getDb().prepare('SELECT COUNT(*) n FROM order_settlements WHERE order_id=?').get(ids[0]).n;
    must(noLedger===0, 'report must not post sale payment');
    pass('rider-cash-not-posted-to-shop-ledger');
    const afterCash=await httpJson(config.port,'GET','/v1/delivery-pool/mine',driver1);
    const current0=afterCash.json.orders.find(o=>o.orderId===ids[0]);
    must(current0.paymentReport.status==='CASH_WITH_BOY' &&
      afterCash.json.pendingCashByCurrency.length===1 &&
      afterCash.json.pendingCashByCurrency[0].amountCents===current0.totalCents,
      'pending gross cash');
    pass('rider-cash-pending-handover-summary');
    const dup=await httpJson(config.port,'POST',path0,driver1,
      {reportType:'CASH_WITH_BOY',expectedVersion:0});
    const reportAudit1 = getDb().prepare(`SELECT COUNT(*) n FROM audit_events
      WHERE action='delivery.payment.report' AND entity_id=?`).get(ids[0]).n;
    must(dup.status===200 && dup.json.replayed===true && reportAudit1===1,
      'retry does not duplicate mark or audit');
    pass('mark-retry-idempotent');
    const stalePayment=await httpJson(config.port,'POST',path0,driver1,
      {reportType:'CREDIT_REPORTED',expectedVersion:0});
    must(stalePayment.status===409,'stale version');
    pass('stale-change-rejected');
    const credit=await httpJson(config.port,'POST',path1,driver1,
      {reportType:'CREDIT_REPORTED',expectedVersion:0});
    const shop=await httpJson(config.port,'POST',path2,driver2,
      {reportType:'SHOP_PAID_REPORTED',expectedVersion:0});
    must(credit.status===200 && shop.status===200,'shop paid and credit report');
    pass('credit-and-shop-paid-are-unverified-reports');
    const unposted = getDb().prepare('SELECT COUNT(*) n FROM order_settlements WHERE order_id IN (?,?,?)')
      .get(ids[0],ids[1],ids[2]).n;
    must(unposted===0,'no accounting entry for reported shop paid or credit');
    pass('credit-shop-reports-no-accounting-post');
    const switchMode=await httpJson(config.port,'POST',path0,driver1,
      {reportType:'CREDIT_REPORTED',expectedVersion:1});
    const summaryAfterSwitch=await httpJson(config.port,'GET','/v1/delivery-pool/mine',driver1);
    must(switchMode.status===200 && switchMode.json.version===2 &&
      summaryAfterSwitch.json.pendingCashByCurrency.length===0,'cash total removed on update');
    pass('versioned-correction-updates-cash-summary');
    const changedBack=await httpJson(config.port,'POST',path0,driver1,
      {reportType:'CASH_WITH_BOY',expectedVersion:2});
    must(changedBack.status===200 && changedBack.json.version===3,'mark correction');
    pass('corrected-mark-audited-and-versioned');
    const reportAudit3 = getDb().prepare(`SELECT COUNT(*) n FROM audit_events
      WHERE action='delivery.payment.report' AND entity_id=?`).get(ids[0]).n;
    must(reportAudit3===3,'one audit per successful revision');
    pass('all-successful-changes-audited');
    const settledOrder = getDb().prepare('SELECT total_cents,currency_code FROM orders WHERE order_id=?').get(ids[2]);
    const posted=await httpJson(config.port,'POST',`/v1/orders/${ids[2]}/settlements`,cashier,{
      submissionId:'cashier-payment-after-rider-report-0001', tender:'CASH',
      amountCents:settledOrder.total_cents,currencyCode:settledOrder.currency_code});
    must([200,201].includes(posted.status),`cashier settlement ${posted.status}: ${posted.json?.error}`);
    const mine2=await httpJson(config.port,'GET','/v1/delivery-pool/mine',driver2);
    must(mine2.json.orders.find(o=>o.orderId===ids[2]).paymentReport.status==='PAID_CONFIRMED',
      'shop confirmed beats rider report');
    pass('authoritative-shop-payment-overrides-rider-report');
    const override=await httpJson(config.port,'POST',path2,driver2,
      {reportType:'CASH_WITH_BOY',expectedVersion:1});
    must(override.status===409 && override.json.code==='ALREADY_PAID', 'rider cannot overwrite verified paid');
    pass('paid-order-cannot-be-remarked-by-rider');
    const moneyNoExtra = getDb().prepare('SELECT COUNT(*) n FROM order_settlements WHERE order_id IN (?,?,?)')
      .get(ids[0],ids[1],ids[2]).n;
    must(moneyNoExtra===1, 'only cashier explicitly posted one payment');
    pass('rider-marks-never-create-shop-payment');
    const after = getDb().prepare('SELECT SUM(total_cents) total FROM orders WHERE is_test=1').get().total;
    const moneyRows = getDb().prepare('SELECT COUNT(*) n FROM order_settlements WHERE order_id IN (?,?,?,?)').get(...ids).n;
    const claims = getDb().prepare('SELECT COUNT(*) n FROM order_delivery_claims').get().n;
    must(before === after && moneyRows === 1 && claims === 3, 'only cashier payment changed ledger, no auto claim');
    pass('only-explicit-cashier-payment-no-auto-assignment');
    console.log(`Delivery payment reports ${passed} passed (temporary TEST SQLite, rider reports create no financial writes)`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase();
    fs.rmSync(dir, {recursive:true,force:true});
  }
}
main().catch(e => {console.error(e);process.exitCode=1});
