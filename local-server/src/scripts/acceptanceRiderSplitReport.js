/** Rider "multiple payment" split: stored by the POS, accepted after the shop's part,
 *  bridge passes it on, rider vs counter cash reported to the Delivery App. TEST only. */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureDataDirs } from '../config.js';
import { openDatabase, getDb, closeDatabase, runMigrations } from '../db/db.js';
import { initLogger } from '../util/logger.js';
import { createServer } from '../http/server.js';
import { seedSampleData } from '../seed/sampleData.js';
import { httpJson, openRoleSessions } from './testHttp.js';
import { markDeliveryPayment, readDeliveryPaymentReport } from '../services/deliveryPaymentReports.js';
import { readShopPaymentSnapshot, syncCloudDeliveryBridge } from '../services/cloudDeliveryBridge.js';
import { readAllocationSummary } from '../services/paymentAllocations.js';
import { updateShopSettings } from '../services/shopSettings.js';
import { readSplitReview } from '../services/deliverySplitReview.js';
import { getShopSettings } from '../services/shopSettings.js';
import { commissionPreview } from '../services/deliveryCommissionSettings.js';

let passed = 0;
function must(ok, message) { if (!ok) throw new Error(message); }
function pass(name) { console.log(`PASS ${name}`); passed++; }
function sessionCookie(response) {
  const raw = response.headers['set-cookie'];
  const str = Array.isArray(raw) ? raw.join(';') : String(raw || '');
  return decodeURIComponent(/gtct_ls_session=([^;]+)/.exec(str)?.[1] || '');
}
function codeOf(fn) { try { fn(); return 'OK'; } catch (e) { return e.code || e.message; } }

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtct-rider-split-'));
  process.env.GTCT_LOCAL_DATA_DIR = dir;
  process.env.GTCT_LOCAL_HOST = '127.0.0.1';
  process.env.GTCT_LOCAL_PORT = '19041';
  for (const k of ['GTCT_TLS_CERT_FILE','GTCT_TLS_KEY_FILE','GTCT_ALLOW_LAN_BIND','GTCT_ENABLE_LAN_LISTENER',
    'GTCT_LAN_BIND_ADDRESS','GTCT_ENABLE_PHYSICAL_PRINT','GTCT_LOCAL_OPERATING_MODE',
    'GTCT_TEST_BACKUP_DIR','GTCT_ENABLE_TEST_AUTO_BACKUP']) delete process.env[k];
  const config = loadConfig({ mode:'http' });
  must(config.operatingMode === 'TEST' && config.loopback &&
    path.resolve(config.dbPath).startsWith(path.resolve(dir) + path.sep), 'temporary TEST isolation');
  ensureDataDirs(config); initLogger(config.logDir);
  let server; let cloud;
  try {
    openDatabase(config.dbPath);
    await runMigrations(getDb());
    seedSampleData(config);
    server = createServer(config);
    await new Promise((ok, err) => { server.once('error', err); server.listen(config.port, config.host, ok); });
    const shopId = config.testTenantId;
    const { admin, device:cashier } = await openRoleSessions(config.port, shopId);
    const created = await httpJson(config.port,'POST','/v1/staff-users',admin,{ fullName:'split.rider',
      username:'split.rider', password:'Split-Rider-246', confirmPassword:'Split-Rider-246',
      role:'delivery', isActive:true, stationIds:[], permissions:[] });
    must(created.status === 201, `rider: ${created.json?.error}`);
    const login = await httpJson(config.port,'POST','/v1/session/login',null,
      { username:'split.rider', password:'Split-Rider-246' }, { origin:true });
    const rider = sessionCookie(login);
    const cust = await httpJson(config.port,'POST','/v1/customers',admin,{ name:'Split QA', phone:'55000001',
      label:'Home', buildingNumber:'1', roadNumber:'2', blockNumber:'44', addressNote:'Not real' });
    const customerId = cust.json.customer.customerId;
    const addressId = cust.json.customer.addresses[0].addressId;
    await httpJson(config.port,'PUT','/v1/block-delivery-rates',admin,
      { blockNumber:'44', chargeCents:250, taxApplicable:false, isActive:true });
    const ids = [];
    for (const n of ['A','B','C','D','E','F','G','H']) {
      const o = await httpJson(config.port,'POST','/v1/test-orders',cashier,{ orderNumber:`SPLIT-${n}`,
        orderType:'DELIVERY', fulfillment:{ customerId, addressId, blockNumber:'44', roadNumber:'2',
          buildingNumber:'1', expectedBlockRateCents:250, deliveryChargeCents:250 },
        lines:[{ itemId:'item_orange_juice', quantity:2 }] });
      must(o.status === 201, `order ${n}: ${o.json?.error}`);
      ids.push(o.json.order.order_id);
    }
    for (const orderId of ids) {
      const board = await httpJson(config.port,'GET','/v1/prep-board?stationId=station_juice',cashier);
      const t = board.json.tickets.find((x) => x.orderId === orderId);
      const acc = await httpJson(config.port,'POST','/v1/prep-board/accept',cashier,
        { orderId, stationId:'station_juice', expectedStatus:t.status, expectedRevision:t.revision });
      must(acc.status === 200, 'ticket accept');
      const b2 = await httpJson(config.port,'GET','/v1/prep-board?stationId=station_juice',cashier);
      const t2 = b2.json.tickets.find((x) => x.orderId === orderId);
      await httpJson(config.port,'POST','/v1/prep-board/finish',cashier,
        { orderId, stationId:'station_juice', expectedStatus:t2.status, expectedRevision:t2.revision });
      const d = await httpJson(config.port,'GET',`/v1/order-monitor/${orderId}`,admin);
      const r = await httpJson(config.port,'POST',`/v1/order-monitor/${orderId}/ready`,cashier,
        { expectedRevision:d.json.order.dispatch.revision });
      must(r.status === 200, 'ready');
      const pool = await httpJson(config.port,'GET','/v1/delivery-pool',rider);
      const row = pool.json.orders.find((x) => x.orderId === orderId);
      const claim = await httpJson(config.port,'POST',`/v1/delivery-pool/${orderId}/accept`,rider,
        { expectedRevision:row.expectedRevision });
      must(claim.status === 200, `claim ${orderId}: ${claim.json?.error}`);
    }
    const db = getDb();
    const totalOf = (id) => Number(db.prepare('SELECT total_cents t FROM orders WHERE order_id=?').get(id).t);
    const riderId = db.prepare('SELECT driver_user_id d FROM order_delivery_claims WHERE order_id=?').get(ids[0]).d;
    const actor = { role:'delivery', userId:riderId,
      permissions:['delivery.pool.view','delivery.pool.accept','delivery.payment.report','delivery.status.update'] };
    pass('eight-claimed-delivery-orders');

    // 1. Split stored on a clean order; bad splits refused.
    const [A, B, C, D, E, F, G, H] = ids; const tA = totalOf(A); const half = Math.floor(tA / 2);
    must(codeOf(() => markDeliveryPayment(shopId, A, 'PARTIAL_SHOP', 0, actor,
      { split:{ cashCents:half, shopPaidCents:tA - half - 1, creditCents:0 } })) === 'SPLIT_TOTAL_MISMATCH',
      'under total refused');
    must(codeOf(() => markDeliveryPayment(shopId, A, 'PARTIAL_SHOP', 0, actor,
      { split:{ cashCents:-1, shopPaidCents:tA + 1, creditCents:0 } })) === 'INVALID_SPLIT', 'negative refused');
    must(codeOf(() => markDeliveryPayment(shopId, A, 'PARTIAL_SHOP', 0, actor,
      { split:{ cashCents:tA, shopPaidCents:0, creditCents:0 } })) === 'INVALID_SPLIT', 'one mode refused');
    must(codeOf(() => markDeliveryPayment(shopId, A, 'PARTIAL_SHOP', 0, actor,
      { split:{ cashCents:tA, shopPaidCents:1, creditCents:0 } })) === 'SPLIT_TOTAL_MISMATCH', 'over total refused');
    must(codeOf(() => markDeliveryPayment(shopId, A, 'CASH_WITH_BOY', 0, actor,
      { split:{ cashCents:1, shopPaidCents:tA - 1, creditCents:0 } })) === 'INVALID_SPLIT', 'split on single mode refused');
    const cashA = tA - 300;
    markDeliveryPayment(shopId, A, 'PARTIAL_SHOP', 0, actor, { split:{ cashCents:cashA, shopPaidCents:300, creditCents:0 } });
    const repA = readDeliveryPaymentReport(db, shopId, A, riderId, tA);
    must(repA.status === 'PARTIAL_SHOP' && repA.split?.cashCents === cashA && repA.split.shopPaidCents === 300,
      `split stored ${JSON.stringify(repA.split)}`);
    // Same request again = harmless replay; a changed split needs the new version.
    must(markDeliveryPayment(shopId, A, 'PARTIAL_SHOP', 0, actor,
      { split:{ cashCents:cashA, shopPaidCents:300, creditCents:0 } }).replayed === true, 'replay');
    must(codeOf(() => markDeliveryPayment(shopId, A, 'PARTIAL_SHOP', 0, actor,
      { split:{ cashCents:cashA - 100, shopPaidCents:400, creditCents:0 } })) === 'STALE_PAYMENT_REPORT', 'stale change');
    pass('split-stored-validated-and-versioned');

    // 2. Cashier records the shop's part first; rider's split still accepted; single mode still refused.
    const tB = totalOf(B);
    const alloc = await httpJson(config.port,'POST',`/v1/orders/${B}/payment-allocations`,cashier,{
      submissionId:'split-b-counter-1', cashCents:500, bankCents:0, creditCents:0,
      currencyCode:db.prepare('SELECT currency_code c FROM orders WHERE order_id=?').get(B).c });
    must(alloc.status === 200 || alloc.status === 201, `counter allocation: ${alloc.status} ${alloc.json?.error}`);
    must(codeOf(() => markDeliveryPayment(shopId, B, 'CASH_WITH_BOY', 0, actor)) === 'SHOP_PARTIAL_PAYMENT',
      'single-mode report still refused after cashier allocation');
    must(codeOf(() => markDeliveryPayment(shopId, B, 'PARTIAL_SHOP', 0, actor,
      { split:{ cashCents:tB - 400, shopPaidCents:400, creditCents:0 } })) === 'SHOP_PARTIAL_PAYMENT',
      'rider cash larger than what is left is refused');
    markDeliveryPayment(shopId, B, 'PARTIAL_SHOP', 0, actor, { split:{ cashCents:tB - 500, shopPaidCents:500, creditCents:0 } });
    const snapB = readShopPaymentSnapshot(shopId, B);
    must(snapB.status === 'PARTIAL' && snapB.counterCents === 500 && snapB.riderCashCents === 0,
      `counter vs rider ${JSON.stringify(snapB)}`);
    pass('split-accepted-after-shop-part-and-counter-cash-reported');

    // 3. Full cash handover is reported as rider cash, not counter cash.
    const tC = totalOf(C);
    markDeliveryPayment(shopId, C, 'CASH_WITH_BOY', 0, actor);
    const delivered = await httpJson(config.port,'POST',`/v1/delivery-pool/${C}/status`,rider,
      { action:'DELIVERED', expectedVersion:0 });
    must(delivered.status === 200, `deliver C: ${delivered.status} ${delivered.json?.error}`);
    const list = await httpJson(config.port,'GET','/v1/delivery-cash-handovers',cashier);
    const pend = list.json?.pending?.find((p) => p.orderId === C);
    must(pend, `handover pending ${list.status} ${JSON.stringify(list.json).slice(0, 200)}`);
    const hand = await httpJson(config.port,'POST',`/v1/delivery-cash-handovers/${C}/confirm`,cashier,{
      submissionId:'split-c-handover', expectedReportVersion:pend.reportVersion, driverUserId:riderId,
      amountCents:tC, currencyCode:pend.currencyCode });
    must(hand.status === 200 || hand.status === 201, `handover: ${hand.status} ${hand.json?.error}`);
    const snapC = readShopPaymentSnapshot(shopId, C);
    must(snapC.status === 'PAID' && snapC.riderCashCents === tC && snapC.counterCents === 0,
      `handover source ${JSON.stringify(snapC)}`);
    pass('handover-cash-reported-as-rider-cash');

    // 4. Bridge: cloud split reaches the POS; a refused payment backs off instead of every 8 s.
    const tD = totalOf(D); let pending = []; let calls = 0; let cloudClaims = []; let cloudStatuses = []; let cloudRiders = []; let cloudReleases = []; const cloudBodies = [];
    cloud = http.createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        calls += 1;
        let parsed = {}; try { parsed = JSON.parse(body || '{}'); } catch { parsed = {}; }
        cloudBodies.push(parsed);
        const releaseDecided = (parsed.releaseDecisions || []).map((d) => d.requestId);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok:true, publishedCount:0, pendingClaims:cloudClaims, pendingStatuses:cloudStatuses, pendingPayments:pending, riders:cloudRiders, pendingReleases:cloudReleases, releaseDecided }));
      });
    });
    await new Promise((ok) => cloud.listen(19042, '127.0.0.1', ok));
    process.env.GTCT_CLOUD_BRIDGE_SECRET = 'test-secret-for-split-1234';
    process.env.GTCT_CLOUD_BRIDGE_URL = 'http://127.0.0.1:19042/restaurantDeliveryBridge';
    updateShopSettings(shopId, { cloudClientId:'clientQA', cloudBridgeEnabled:true }, { role:'admin' });
    pending = [{ id:`clientQA_${D}`, localOrderId:D, paymentReport:{ status:'PARTIAL_SHOP', multi:true,
      cashCents:tD - 700, shopPaidCents:0, creditCents:700, version:1 } }];
    await syncCloudDeliveryBridge(shopId, config);
    const repD = readDeliveryPaymentReport(db, shopId, D, riderId, tD);
    must(repD.status === 'PARTIAL_SHOP' && repD.split?.cashCents === tD - 700 && repD.split.creditCents === 700,
      `bridge split ${JSON.stringify(repD)}`);
    pass('bridge-passes-rider-split-to-pos');
    pending = [{ id:'clientQA_ghost', localOrderId:'ord_not_here', claimedByDeliveryBoyId:'',
      paymentReport:{ status:'CASH_WITH_BOY', version:1 } }];
    const logFile = () => fs.readdirSync(config.logDir).map((f) => fs.readFileSync(path.join(config.logDir, f), 'utf8')).join('');
    const warnsBefore = (logFile().match(/needs attention/g) || []).length;
    for (let i = 0; i < 5; i++) await syncCloudDeliveryBridge(shopId, config);
    const warnsAfter = (logFile().match(/needs attention/g) || []).length;
    must(warnsAfter - warnsBefore <= 1, `refused payment retried ${warnsAfter - warnsBefore} times in a burst`);
    pass('refused-payment-backs-off');

    // 5. Full review of a three-part split: cash 1/3, shop paid, credit.
    const tE = totalOf(E); const cashE = Math.floor(tE / 3); const creditE = 400; const shopE = tE - cashE - creditE;
    markDeliveryPayment(shopId, E, 'PARTIAL_SHOP', 0, actor, { split:{ cashCents:cashE, shopPaidCents:shopE, creditCents:creditE } });
    let rv = readSplitReview(db, shopId, E);
    must(rv.cash.state === 'WITH_RIDER' && rv.shopPaid.state === 'PENDING' && rv.credit.state === 'PENDING' && !rv.complete,
      `initial states ${JSON.stringify(rv)}`);
    const currency = db.prepare('SELECT currency_code c FROM orders WHERE order_id=?').get(E).c;
    const grab = await httpJson(config.port,'POST',`/v1/orders/${E}/payment-allocations`,cashier,{
      submissionId:'split-e-counter-all', cashCents:tE - creditE, bankCents:0, creditCents:0, currencyCode:currency });
    must(grab.status === 409 && grab.json?.code === 'RIDER_CASH_CUSTODY', `counter cannot take rider cash: ${grab.status} ${grab.json?.code}`);
    const splitUrl = `/v1/delivery-review/${E}/split`;
    const riderTry = await httpJson(config.port,'POST',splitUrl,rider,{ action:'CONFIRM_SHOP_PAID', reportVersion:1, tender:'CASH', submissionId:'split-e-rider-try' });
    must(riderTry.status === 403, `rider cannot confirm: ${riderTry.status}`);
    const stale = await httpJson(config.port,'POST',splitUrl,cashier,{ action:'CONFIRM_SHOP_PAID', reportVersion:9, tender:'CASH', submissionId:'split-e-stale' });
    must(stale.status === 409 && stale.json?.code === 'STALE_SPLIT_REPORT', 'stale version refused');
    const conf = await httpJson(config.port,'POST',splitUrl,cashier,{ action:'CONFIRM_SHOP_PAID', reportVersion:1, tender:'CASH', submissionId:'split-e-shop-cash', printCashier:false });
    must(conf.status === 200 && conf.json.review.shopPaid.state === 'CONFIRMED', `confirm shop paid: ${conf.status} ${conf.json?.error}`);
    const again = await httpJson(config.port,'POST',splitUrl,cashier,{ action:'CONFIRM_SHOP_PAID', reportVersion:1, tender:'CASH', submissionId:'split-e-shop-cash-2' });
    must(again.status === 409, 'no double confirmation');
    const rej = await httpJson(config.port,'POST',splitUrl,cashier,{ action:'REJECT_CREDIT', reportVersion:1, note:'Customer not on credit list' });
    must(rej.status === 200 && rej.json.review.credit.state === 'REJECTED', `reject: ${rej.status} ${rej.json?.error}`);
    const appr = await httpJson(config.port,'POST',splitUrl,cashier,{ action:'APPROVE_CREDIT', reportVersion:1, submissionId:'split-e-credit', printCashier:false });
    must(appr.status === 200 && appr.json.review.credit.state === 'APPROVED', `approve: ${appr.status} ${appr.json?.error}`);
    const allocAfterReview = readAllocationSummary(db, shopId, E, tE);
    must(allocAfterReview.cashCents === shopE && allocAfterReview.creditCents === creditE && allocAfterReview.unallocatedCents === cashE,
      `ledger after shop review ${JSON.stringify(allocAfterReview)}`);
    pass('cashier-confirms-shop-part-rejects-then-approves-credit');

    // Rider cash part through Cash handover; then the report is locked.
    const delE = await httpJson(config.port,'POST',`/v1/delivery-pool/${E}/status`,rider,{ action:'DELIVERED', expectedVersion:0 });
    must(delE.status === 200, 'deliver E');
    const listE = await httpJson(config.port,'GET','/v1/delivery-cash-handovers',cashier);
    const pendE = listE.json.pending.find((x) => x.orderId === E);
    must(pendE?.split === true && pendE.amountCents === cashE && pendE.orderTotalCents === tE, `handover shows cash part ${JSON.stringify(pendE)}`);
    const wrongAmt = await httpJson(config.port,'POST',`/v1/delivery-cash-handovers/${E}/confirm`,cashier,{
      submissionId:'split-e-hand-bad', expectedReportVersion:pendE.reportVersion, driverUserId:riderId, amountCents:tE, currencyCode:currency });
    must(wrongAmt.status === 409, 'full total refused for split handover');
    const handE = await httpJson(config.port,'POST',`/v1/delivery-cash-handovers/${E}/confirm`,cashier,{
      submissionId:'split-e-hand', expectedReportVersion:pendE.reportVersion, driverUserId:riderId, amountCents:cashE, currencyCode:currency });
    must(handE.status === 200 || handE.status === 201, `split handover: ${handE.status} ${handE.json?.error}`);
    rv = readSplitReview(db, shopId, E);
    const allocE = readAllocationSummary(db, shopId, E, tE);
    must(rv.complete && rv.cash.state === 'HANDED_OVER' && allocE.unallocatedCents === 0 &&
      allocE.cashCents === shopE + cashE && allocE.creditCents === creditE, `after handover ${JSON.stringify(allocE)}`);
    const snapE = readShopPaymentSnapshot(shopId, E);
    must(snapE.riderCashCents === cashE && snapE.counterCents === shopE, `snapshot split sources ${JSON.stringify(snapE)}`);
    must(codeOf(() => markDeliveryPayment(shopId, E, 'CASH_WITH_BOY', 1, actor)) === 'RIDER_CASH_SETTLED', 'report locked after handover');
    pass('split-cash-handed-over-order-fully-settled-and-locked');

    // 6. Daily rider settlement picks up only the cash part of a split.
    const tF = totalOf(F); const cashF = tF - 600;
    markDeliveryPayment(shopId, F, 'PARTIAL_SHOP', 0, actor, { split:{ cashCents:cashF, shopPaidCents:600, creditCents:0 } });
    const delF = await httpJson(config.port,'POST',`/v1/delivery-pool/${F}/status`,rider,{ action:'DELIVERED', expectedVersion:0 });
    must(delF.status === 200, 'deliver F');
    const day = db.prepare('SELECT business_date d FROM orders WHERE order_id=?').get(F).d;
    const q = await httpJson(config.port,'GET',`/v1/delivery-rider-settlements?riderUserId=${encodeURIComponent(riderId)}&businessDate=${day}`,admin);
    const prev = q.json?.preview;
    must(q.status === 200 && prev?.invoiceCount === 1 && prev.grossMinor === cashF && prev.orders[0].riderPartOnly === true,
      `settlement preview ${q.status} ${JSON.stringify(q.json).slice(0, 300)}`);
    const settle = await httpJson(config.port,'POST','/v1/delivery-rider-settlements',admin,{ submissionId:'split_net_settle_1',
      riderUserId:riderId, businessDate:day, expectedGrossMinor:cashF, expectedSnapshotHash:prev.snapshotHash,
      expectedCommissionMinor:0, payCommission:false });
    must(settle.status === 201 || settle.status === 200, `settlement: ${settle.status} ${JSON.stringify(settle.json).slice(0, 200)}`);
    const allocF = readAllocationSummary(db, shopId, F, tF);
    must(allocF.cashCents === cashF && allocF.unallocatedCents === 600, `settlement records only rider cash ${JSON.stringify(allocF)}`);
    const confF = await httpJson(config.port,'POST',`/v1/delivery-review/${F}/split`,cashier,{ action:'CONFIRM_SHOP_PAID', reportVersion:1, tender:'CASH', submissionId:'split-f-shop', printCashier:false });
    must(confF.status === 200 && confF.json.review.complete === true, `F complete after shop part: ${confF.status} ${confF.json?.error}`);
    pass('rider-settlement-takes-only-split-cash-then-shop-part-confirmed');

    // 7. Single mode needs approval too: whole bill "paid at shop".
    const tG = totalOf(G);
    markDeliveryPayment(shopId, G, 'SHOP_PAID_REPORTED', 0, actor);
    const monG = await httpJson(config.port,'GET',`/v1/order-monitor/${G}`,admin);
    const rvG = monG.json?.order?.deliverySplitReview || monG.json?.deliverySplitReview;
    must(rvG?.kind === 'SHOP_PAID' && rvG.shopPaid.state === 'PENDING' && rvG.shopPaid.dueCents === tG,
      `monitor shows shop-paid review ${JSON.stringify(rvG)}`);
    const confG = await httpJson(config.port,'POST',`/v1/delivery-review/${G}/split`,cashier,{ action:'CONFIRM_SHOP_PAID',
      reportVersion:rvG.reportVersion, tender:'CASH', submissionId:'single-g-shop', printCashier:false });
    must(confG.status === 200 && confG.json.review.complete === true, `confirm whole bill: ${confG.status} ${confG.json?.error}`);
    must(readShopPaymentSnapshot(shopId, G).status === 'PAID', 'order paid after confirmation');
    pass('single-shop-paid-needs-and-gets-cashier-confirmation');

    // 8. Single mode credit: rejected, rider corrects to credit again, shop approves.
    const tH = totalOf(H);
    markDeliveryPayment(shopId, H, 'CREDIT_REPORTED', 0, actor);
    let rvH = readSplitReview(db, shopId, H);
    must(rvH.kind === 'CREDIT' && rvH.credit.state === 'PENDING' && rvH.credit.requiredCents === tH, 'credit review pending');
    const rejH = await httpJson(config.port,'POST',`/v1/delivery-review/${H}/split`,cashier,{ action:'REJECT_CREDIT', reportVersion:rvH.reportVersion, note:'Call the owner first' });
    must(rejH.status === 200 && rejH.json.review.credit.state === 'REJECTED', 'credit rejected');
    markDeliveryPayment(shopId, H, 'CASH_WITH_BOY', rvH.reportVersion, actor);
    must(readSplitReview(db, shopId, H) === null, 'cash report needs no shop review');
    markDeliveryPayment(shopId, H, 'CREDIT_REPORTED', rvH.reportVersion + 1, actor);
    rvH = readSplitReview(db, shopId, H);
    must(rvH.credit.state === 'PENDING' && rvH.reportVersion === 3, `new report is pending again ${JSON.stringify(rvH.credit)}`);
    const apprH = await httpJson(config.port,'POST',`/v1/delivery-review/${H}/split`,cashier,{ action:'APPROVE_CREDIT', reportVersion:3, submissionId:'single-h-credit', printCashier:false });
    must(apprH.status === 200 && apprH.json.review.complete === true, `approve whole credit: ${apprH.status} ${apprH.json?.error}`);
    must(readShopPaymentSnapshot(shopId, H).status === 'CREDIT', 'order on credit after approval');
    pass('single-credit-reject-correct-approve');

    // 9. Commission = rider's GTCT Analytics percentage of the delivery charge, per order.
    const cloudOrders = [];
    for (const n of ['I', 'J']) {
      const o = await httpJson(config.port,'POST','/v1/test-orders',cashier,{ orderNumber:`SPLIT-${n}`,
        orderType:'DELIVERY', fulfillment:{ customerId, addressId, blockNumber:'44', roadNumber:'2',
          buildingNumber:'1', expectedBlockRateCents:250, deliveryChargeCents:250 },
        lines:[{ itemId:'item_orange_juice', quantity:1 }] });
      const orderId = o.json.order.order_id; cloudOrders.push(orderId);
      const board = await httpJson(config.port,'GET','/v1/prep-board?stationId=station_juice',cashier);
      const t = board.json.tickets.find((x) => x.orderId === orderId);
      await httpJson(config.port,'POST','/v1/prep-board/accept',cashier,{ orderId, stationId:'station_juice', expectedStatus:t.status, expectedRevision:t.revision });
      const b2 = await httpJson(config.port,'GET','/v1/prep-board?stationId=station_juice',cashier);
      const t2 = b2.json.tickets.find((x) => x.orderId === orderId);
      await httpJson(config.port,'POST','/v1/prep-board/finish',cashier,{ orderId, stationId:'station_juice', expectedStatus:t2.status, expectedRevision:t2.revision });
      const d = await httpJson(config.port,'GET',`/v1/order-monitor/${orderId}`,admin);
      await httpJson(config.port,'POST',`/v1/order-monitor/${orderId}/ready`,cashier,{ expectedRevision:d.json.order.dispatch.revision });
    }
    pending = [];
    cloudClaims = cloudOrders.map((id) => ({ id:`clientQA_${id}`, localOrderId:id, status:'CLAIMED',
      claimedByDeliveryBoyId:'boyQA15', claimedByName:'Cloud Boy', claimedAt:Date.now() }));
    cloudStatuses = cloudOrders.map((id) => ({ id:`clientQA_${id}`, localOrderId:id, status:'DELIVERED',
      claimedByDeliveryBoyId:'boyQA15', deliveryLifecycle:{ status:'DELIVERED' } }));
    cloudRiders = [{ deliveryBoyId:'boyQA15', commissionEnabled:true, commissionRate:15 }];
    await syncCloudDeliveryBridge(shopId, config);
    await syncCloudDeliveryBridge(shopId, config); // statuses after claims exist
    const staffAdmin = { userId:'qa_admin', role:'admin', staff:true, permissions:['staff.manage'] };
    const dayI = db.prepare('SELECT business_date d FROM orders WHERE order_id=?').get(cloudOrders[0]).d;
    let prevC = commissionPreview(shopId, 'cdb_boyQA15', dayI, staffAdmin);
    // Analytics per order: 0.250 x 15% = 0.0375 -> 0.038; two orders = 0.076 (a day total would give 0.075).
    must(prevC.eligibleDeliveryCount === 2 && prevC.activePolicy?.policy?.rateBps === 1500 &&
      prevC.activePolicy.policy.rounding === 'PER_ORDER' && prevC.estimatedCommissionMinor === 76,
      `analytics commission ${JSON.stringify({ n:prevC.eligibleDeliveryCount, p:prevC.activePolicy?.policy, c:prevC.estimatedCommissionMinor })}`);
    const versions = () => db.prepare(`SELECT COUNT(*) n FROM delivery_commission_policies WHERE rider_user_id='cdb_boyQA15'`).get().n;
    const v1 = versions();
    await syncCloudDeliveryBridge(shopId, config);
    must(versions() === v1, 'same rate does not add a new rule version');
    cloudRiders = [{ deliveryBoyId:'boyQA15', commissionEnabled:true, commissionRate:20 }];
    await syncCloudDeliveryBridge(shopId, config);
    prevC = commissionPreview(shopId, 'cdb_boyQA15', dayI, staffAdmin);
    must(versions() === v1 + 1 && prevC.estimatedCommissionMinor === 100, `rate change applied ${prevC.estimatedCommissionMinor}`);
    cloudRiders = [{ deliveryBoyId:'boyQA15', commissionEnabled:false, commissionRate:20 }];
    await syncCloudDeliveryBridge(shopId, config);
    prevC = commissionPreview(shopId, 'cdb_boyQA15', dayI, staffAdmin);
    must(prevC.estimatedCommissionMinor === 0 && prevC.activePolicy.policy.method === 'NONE', 'commission off in Analytics = none');
    // % of the full bill (delivery charge included), per order.
    cloudRiders = [{ deliveryBoyId:'boyQA15', commissionEnabled:true, commissionRate:1, commissionType:'BILL_TOTAL' }];
    await syncCloudDeliveryBridge(shopId, config);
    prevC = commissionPreview(shopId, 'cdb_boyQA15', dayI, staffAdmin);
    const perOrderTotals = cloudOrders.map((id) => db.prepare('SELECT total_cents t FROM orders WHERE order_id=?').get(id).t);
    const expectBill = perOrderTotals.reduce((sum, t) => sum + Math.floor(t / 100) + ((t % 100) >= 50 ? 1 : 0), 0);
    must(prevC.activePolicy.policy.method === 'PERCENTAGE' && prevC.activePolicy.policy.basis === 'TOTAL_BILL' &&
      prevC.totalBillMinor === perOrderTotals.reduce((a, b) => a + b, 0) && prevC.estimatedCommissionMinor === expectBill,
      `1% of bill ${JSON.stringify({ p:prevC.activePolicy.policy, est:prevC.estimatedCommissionMinor, expectBill, perOrderTotals })}`);
    // Daily target: highest range reached by the day's delivered total.
    const dec = Number(getShopSettings(shopId).currencyDecimals ?? 2);
    const unit = 1 / 10 ** dec;
    const dayTotal = prevC.totalBillMinor / 10 ** dec;
    cloudRiders = [{ deliveryBoyId:'boyQA15', commissionEnabled:true, commissionRate:0, commissionType:'DAILY_TARGET',
      commissionTiers:[{ fromAmount:dayTotal + unit, amount:0.9 }, { fromAmount:unit, amount:0.2 },
        { fromAmount:dayTotal, amount:0.5 }, { fromAmount:unit / 10, amount:7 }] }];
    await syncCloudDeliveryBridge(shopId, config);
    prevC = commissionPreview(shopId, 'cdb_boyQA15', dayI, staffAdmin);
    must(prevC.activePolicy.policy.method === 'TIERED_FIXED' && prevC.activePolicy.policy.tiers.length === 3 &&
      prevC.activePolicy.policy.tiers[0].thresholdMinor === 1 && prevC.estimatedCommissionMinor === 0.5 * 10 ** dec,
      `daily target ${JSON.stringify({ p:prevC.activePolicy.policy, est:prevC.estimatedCommissionMinor })}`);
    const vT = versions();
    await syncCloudDeliveryBridge(shopId, config);
    must(versions() === vT, 'same ranges do not add a new rule version');
    cloudRiders = [{ deliveryBoyId:'boyQA15', commissionEnabled:true, commissionType:'DAILY_TARGET', commissionTiers:[] }];
    await syncCloudDeliveryBridge(shopId, config);
    must(commissionPreview(shopId, 'cdb_boyQA15', dayI, staffAdmin).activePolicy.policy.method === 'NONE', 'target with no ranges = none');
    pass('commission-bill-percent-and-daily-target-from-analytics');

    const localRule = db.prepare(`SELECT COUNT(*) n FROM delivery_commission_policies WHERE rider_user_id=?`).get(riderId).n;
    cloudRiders = [{ deliveryBoyId:'notHere', commissionEnabled:true, commissionRate:10 }];
    await syncCloudDeliveryBridge(shopId, config);
    must(db.prepare(`SELECT COUNT(*) n FROM delivery_commission_policies WHERE rider_user_id=?`).get(riderId).n === localRule &&
      !db.prepare(`SELECT 1 FROM staff_users WHERE user_id='cdb_notHere'`).get(), 'POS-only riders and unknown boys untouched');
    pass('commission-follows-analytics-percentage-per-order');

    // 10. Rider "release order": shop allows -> claim removed, cloud told; refuse -> stays.
    const relOrders = [];
    for (const n of ['K', 'L', 'M']) {
      const o = await httpJson(config.port,'POST','/v1/test-orders',cashier,{ orderNumber:`REL-${n}`,
        orderType:'DELIVERY', fulfillment:{ customerId, addressId, blockNumber:'44', roadNumber:'2',
          buildingNumber:'1', expectedBlockRateCents:250, deliveryChargeCents:250 },
        lines:[{ itemId:'item_orange_juice', quantity:1 }] });
      const orderId = o.json.order.order_id; relOrders.push(orderId);
      const board = await httpJson(config.port,'GET','/v1/prep-board?stationId=station_juice',cashier);
      const t = board.json.tickets.find((x) => x.orderId === orderId);
      await httpJson(config.port,'POST','/v1/prep-board/accept',cashier,{ orderId, stationId:'station_juice', expectedStatus:t.status, expectedRevision:t.revision });
      const b2 = await httpJson(config.port,'GET','/v1/prep-board?stationId=station_juice',cashier);
      const t2 = b2.json.tickets.find((x) => x.orderId === orderId);
      await httpJson(config.port,'POST','/v1/prep-board/finish',cashier,{ orderId, stationId:'station_juice', expectedStatus:t2.status, expectedRevision:t2.revision });
      const d = await httpJson(config.port,'GET',`/v1/order-monitor/${orderId}`,admin);
      await httpJson(config.port,'POST',`/v1/order-monitor/${orderId}/ready`,cashier,{ expectedRevision:d.json.order.dispatch.revision });
    }
    const [K, L, M] = relOrders;
    cloudStatuses = []; pending = []; cloudRiders = [];
    cloudClaims = relOrders.map((id) => ({ id:`clientQA_${id}`, localOrderId:id, status:'CLAIMED',
      claimedByDeliveryBoyId:'boyQA15', claimedByName:'Cloud Boy', claimedAt:Date.now() }));
    await syncCloudDeliveryBridge(shopId, config);
    const claimOf = (id) => db.prepare('SELECT driver_user_id d FROM order_delivery_claims WHERE order_id=?').get(id)?.d;
    must(relOrders.every((id) => claimOf(id) === 'cdb_boyQA15'), 'cloud rider holds K, L, M');
    cloudClaims = [];
    // M: rider already reported cash -> release must be blocked.
    markDeliveryPayment(shopId, M, 'CASH_WITH_BOY', 0, { ...actor, userId:'cdb_boyQA15' });
    const relRow = (id, rq) => ({ id:`clientQA_${id}`, localOrderId:id, claimedByDeliveryBoyId:'boyQA15', claimedByName:'Cloud Boy',
      releaseRequest:{ status:'PENDING', requestId:rq, reason:'Too far', deliveryBoyId:'boyQA15', deliveryBoyName:'Cloud Boy', requestedAt:Date.now() } });
    cloudReleases = [relRow(K, 'rqK'), relRow(L, 'rqL'), relRow(M, 'rqM')];
    cloudBodies.length = 0;
    await syncCloudDeliveryBridge(shopId, config);
    const acked = cloudBodies.flatMap((b) => b.ackReleaseIds || []);
    must(acked.length === 3 && acked.includes(`clientQA_${K}`), `requests acknowledged ${JSON.stringify(acked)}`);
    cloudReleases = [];
    await syncCloudDeliveryBridge(shopId, config); // repeat delivery is harmless
    must(db.prepare(`SELECT COUNT(*) n FROM delivery_release_requests WHERE status='PENDING'`).get().n === 3, 'three pending requests stored once');
    const monK = await httpJson(config.port,'GET',`/v1/order-monitor/${K}`,admin);
    const rrK = monK.json?.order?.deliveryReleaseRequest;
    must(rrK?.requestId === 'rqK' && rrK.reason === 'Too far' && rrK.riderName === 'Cloud Boy', `board shows request ${JSON.stringify(rrK)}`);
    // wrong request id / bad decision
    let r = await httpJson(config.port,'POST',`/v1/delivery-review/${K}/release`,cashier,{ requestId:'nope', decision:'ALLOW' });
    must(r.status === 404, `unknown request 404 (${r.status})`);
    r = await httpJson(config.port,'POST',`/v1/delivery-review/${K}/release`,cashier,{ requestId:'rqK', decision:'MAYBE' });
    must(r.status === 400, 'bad decision 400');
    // Allow K
    r = await httpJson(config.port,'POST',`/v1/delivery-review/${K}/release`,cashier,{ requestId:'rqK', decision:'ALLOW' });
    must(r.status === 200 && r.json.status === 'APPROVED' && !claimOf(K), `K released ${r.status} ${r.json?.error}`);
    r = await httpJson(config.port,'POST',`/v1/delivery-review/${K}/release`,cashier,{ requestId:'rqK', decision:'REFUSE' });
    must(r.status === 409, 'answer only once');
    // Refuse L
    r = await httpJson(config.port,'POST',`/v1/delivery-review/${L}/release`,cashier,{ requestId:'rqL', decision:'REFUSE' });
    must(r.status === 200 && claimOf(L) === 'cdb_boyQA15', 'L refused: stays with rider');
    // M blocked (payment reported)
    r = await httpJson(config.port,'POST',`/v1/delivery-review/${M}/release`,cashier,{ requestId:'rqM', decision:'ALLOW' });
    must(r.status === 409 && r.json.code === 'RELEASE_BLOCKED' && claimOf(M) === 'cdb_boyQA15', `M blocked ${r.status} ${r.json?.code}`);
    // Decisions go to the cloud, K is published again as a free order.
    cloudBodies.length = 0;
    await syncCloudDeliveryBridge(shopId, config);
    const sent = cloudBodies[0]?.releaseDecisions || [];
    must(sent.length === 2 && sent.some((d) => d.requestId === 'rqK' && d.decision === 'APPROVED' && d.id === `clientQA_${K}`) &&
      sent.some((d) => d.requestId === 'rqL' && d.decision === 'REJECTED'), `decisions sent ${JSON.stringify(sent)}`);
    must((cloudBodies[0].publishOrders || []).some((o) => o.localOrderId === K), 'K published again for all riders');
    cloudBodies.length = 0;
    await syncCloudDeliveryBridge(shopId, config);
    must(!(cloudBodies[0]?.releaseDecisions || []).length, 'decisions not resent after the cloud confirmed');
    const monK2 = await httpJson(config.port,'GET',`/v1/order-monitor/${K}`,admin);
    must(!monK2.json?.order?.deliveryReleaseRequest, 'no badge after decision');
    // K can be accepted again by another cloud rider.
    cloudClaims = [{ id:`clientQA_${K}`, localOrderId:K, status:'CLAIMED', claimedByDeliveryBoyId:'boyQA99', claimedByName:'Other', claimedAt:Date.now() }];
    await syncCloudDeliveryBridge(shopId, config);
    must(claimOf(K) === 'cdb_boyQA99', 'released order taken by another rider');
    cloudClaims = [];
    pass('rider-release-request-allow-refuse-blocked');

    console.log(JSON.stringify({ ok:true, passed }));
  } finally {
    await new Promise((ok) => (cloud ? cloud.close(ok) : ok()));
    await new Promise((ok) => (server ? server.close(ok) : ok()));
    closeDatabase();
  }
}
main().catch((err) => { console.error(err); process.exit(1); });
