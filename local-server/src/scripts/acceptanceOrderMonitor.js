/**
 * P2-E1 disposable TEST SQLite acceptance. Never opens the Mac/Windows pilot DB.
 * No production mode, physical printing, cloud sync, or delivery-boy financial writes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDataDirs } from '../config.js';
import { getDb, openDatabase, closeDatabase, runMigrations } from '../db/db.js';
import { initLogger } from '../util/logger.js';
import { createServer } from '../http/server.js';
import { seedSampleData } from '../seed/sampleData.js';
import { httpJson, openRoleSessions } from './testHttp.js';
import { getOrderMonitorDetail } from '../services/orderMonitor.js';

const PORT = 19028;
let checks = 0;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const pass = name => { checks++; console.log(`PASS ${name}`); };

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gtct-p2e1-monitor-'));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_LOCAL_HOST = '127.0.0.1';
  process.env.GTCT_LOCAL_PORT = String(PORT);
  for (const key of ['GTCT_TLS_CERT_FILE', 'GTCT_TLS_KEY_FILE', 'GTCT_ALLOW_LAN_BIND',
    'GTCT_ENABLE_LAN_LISTENER', 'GTCT_LAN_BIND_ADDRESS', 'GTCT_ENABLE_PHYSICAL_PRINT',
    'GTCT_LOCAL_OPERATING_MODE']) delete process.env[key];

  let server = null;
  const config = loadConfig({ mode: 'http' });
  assert(config.operatingMode === 'TEST' && config.loopback && !config.physicalPrintEnabled &&
    path.resolve(config.dbPath).startsWith(path.resolve(tempRoot) + path.sep), 'TEST path guard');
  ensureDataDirs(config);
  initLogger(config.logDir);
  try {
    openDatabase(config.dbPath);
    await runMigrations(getDb());
    seedSampleData(config);
    server = createServer(config);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, resolve);
    });
    pass('temporary-test-sqlite-and-local-listener');

    const uiFile = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/monitor.html'), 'utf8');
    const uiJs = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/monitor.js'), 'utf8');
    assert(uiFile.includes('Order Monitor') && uiJs.includes('sales.orders.dispatch') &&
      uiJs.includes('delivery driver settlement') === false, 'monitor UI');
    const noSession = await httpJson(PORT, 'GET', '/v1/order-monitor');
    assert(noSession.status === 401, 'unauthenticated monitor not blocked');
    pass('monitor-ui-and-auth-required');

    const sessions = await openRoleSessions(PORT, config.testTenantId);
    const admin = sessions.admin;
    const cashier = sessions.device;
    const kitchenCreated = await httpJson(PORT, 'POST', '/v1/staff-users', admin, {
      fullName: 'Monitor Guard Test', username: 'kitchen.monitor',
      password: 'Monitor-Guard-345', confirmPassword: 'Monitor-Guard-345',
      role: 'kitchen', isActive: true, permissions: [], stationIds: ['station_juice'],
    });
    assert(kitchenCreated.status === 201, kitchenCreated.json?.error || 'kitchen user');
    const kitchenLogin = await httpJson(PORT, 'POST', '/v1/session/login', null, {
      username: 'kitchen.monitor', password: 'Monitor-Guard-345',
    }, { origin: true });
    const cookieHeader = kitchenLogin.headers['set-cookie'] || [];
    const cookieMatch = /gtct_ls_session=([^;]+)/.exec(Array.isArray(cookieHeader) ? cookieHeader.join(';') : String(cookieHeader));
    const kitchenCookie = cookieMatch ? decodeURIComponent(cookieMatch[1]) : '';
    assert(kitchenLogin.status === 200 && kitchenCookie, 'kitchen login');
    const kitchenView = await httpJson(PORT, 'GET', '/v1/order-monitor', kitchenCookie);
    const kitchenMutation = await httpJson(PORT, 'POST', '/v1/order-monitor/any/ready', kitchenCookie, { expectedRevision: 'a'.repeat(64) });
    assert(kitchenView.status === 403 && kitchenMutation.status === 403, 'kitchen bypassed monitor role guard');
    pass('kitchen-staff-cannot-view-or-confirm-dispatch');
    const cust = await httpJson(PORT, 'POST', '/v1/customers', admin, {
      name: 'Test Delivery Customer', phone: '55512345', label: 'Home',
      buildingNumber: '17', roadNumber: '33', blockNumber: '44', addressNote: 'QA-only',
    });
    assert(cust.status === 201, cust.json?.error || 'customer');
    const account = cust.json.customer;
    const address = account.addresses?.[0];
    assert(address?.addressId, 'customer address missing');
    const block = await httpJson(PORT, 'PUT', '/v1/block-delivery-rates', admin, {
      blockNumber: '44', chargeCents: 250, taxApplicable: false, isActive: true,
    });
    assert(block.status === 200, block.json?.error || 'delivery rate');
    const created = await httpJson(PORT, 'POST', '/v1/test-orders', cashier, {
      orderNumber: 'E1-DELIVERY-001', orderType: 'DELIVERY',
      fulfillment: {
        customerId: account.customerId, addressId: address.addressId,
        blockNumber: '44', roadNumber: '33', buildingNumber: '17',
        expectedBlockRateCents: 250, deliveryChargeCents: 250,
      },
      lines: [
        { itemId: 'item_orange_juice', quantity: 1 },
        { itemId: 'item_chicken_shawarma', quantity: 1 },
      ],
    });
    assert(created.status === 201, created.json?.error || 'order');
    const id = created.json.order.order_id;
    const db = getDb();
    const snapshot = db.prepare(`SELECT total_cents, goods_cents, tax_cents, delivery_charge_cents,
      status, is_test FROM orders WHERE order_id = ?`).get(id);
    pass('delivery-order-created-with-existing-workflow');

    const initial = await httpJson(PORT, 'GET', `/v1/order-monitor/${id}`, admin);
    assert(initial.status === 200 && initial.json.order.preparation.stationCount === 2 &&
      initial.json.order.dispatch.status === 'WAITING_FOR_KITCHEN', 'new order monitor states');
    assert(initial.json.order.paymentStatus === 'UNPAID', 'payment projection mismatch');
    pass('independent-kitchen-dispatch-and-payment-status');

    const rawList = await httpJson(PORT, 'GET', '/v1/order-monitor?behavior=DELIVERY', cashier);
    assert(rawList.status === 200 && rawList.json.orders.some(row => row.orderId === id) &&
      rawList.json.orders[0].dispatch, 'monitor list');
    pass('cashier-monitor-list-and-delivery-filter');

    const missing = await httpJson(PORT, 'POST', `/v1/order-monitor/${id}/ready`, cashier, {});
    assert(missing.status === 400 && missing.json.code === 'MONITOR_REVISION_REQUIRED', 'missing revision');
    pass('packing-requires-client-revision');

    const tooSoon = await httpJson(PORT, 'POST', `/v1/order-monitor/${id}/ready`, cashier, {
      expectedRevision: initial.json.order.dispatch.revision,
    });
    assert(tooSoon.status === 409 && tooSoon.json.code === 'KITCHEN_NOT_FINISHED', 'premature dispatch');
    pass('cannot-mark-ready-before-all-stations-finish');

    async function finishStation(stationId) {
      const open = await httpJson(PORT, 'GET', `/v1/prep-board?stationId=${stationId}`, cashier);
      assert(open.status === 200, open.json?.error || 'prep board');
      const ticket = open.json.tickets.find(row => row.orderId === id);
      assert(ticket && ticket.status === 'NEW', 'expected new kitchen ticket');
      const accept = await httpJson(PORT, 'POST', '/v1/prep-board/accept', cashier, {
        orderId: id, stationId, expectedStatus: ticket.status, expectedRevision: ticket.revision,
      });
      assert(accept.status === 200, accept.json?.error || 'accept');
      const changed = await httpJson(PORT, 'GET', `/v1/prep-board?stationId=${stationId}`, cashier);
      const inProgress = changed.json.tickets.find(row => row.orderId === id);
      assert(inProgress?.status === 'ACCEPTED', 'ticket not accepted');
      const done = await httpJson(PORT, 'POST', '/v1/prep-board/finish', cashier, {
        orderId: id, stationId, expectedStatus: inProgress.status, expectedRevision: inProgress.revision,
      });
      assert(done.status === 200, done.json?.error || 'finish');
    }
    await finishStation('station_juice');
    const partial = await httpJson(PORT, 'GET', `/v1/order-monitor/${id}`, admin);
    assert(partial.json.order.preparation.finishedCount === 1 &&
      partial.json.order.dispatch.canMarkReady === false, 'one station should not unlock dispatch');
    pass('multiple-stations-must-finish');

    await finishStation('station_shawarma');
    const prepared = await httpJson(PORT, 'GET', `/v1/order-monitor/${id}`, cashier);
    assert(prepared.json.order.preparation.allFinished &&
      prepared.json.order.dispatch.status === 'AWAITING_PACKING_CONFIRMATION' &&
      prepared.json.order.dispatch.canMarkReady, 'all stations done but packing still manual');
    pass('all-stations-finished-requires-manual-packing');

    const oldRevision = await httpJson(PORT, 'POST', `/v1/order-monitor/${id}/ready`, admin, {
      expectedRevision: initial.json.order.dispatch.revision,
    });
    assert(oldRevision.status === 409 && oldRevision.json.code === 'MONITOR_STALE', 'stale packing view allowed');
    pass('stale-kitchen-view-rejected');

    const wrongShop = await httpJson(PORT, 'POST', `/v1/order-monitor/${id}/ready`, cashier, {
      shopId: 'unrelated-tenant', expectedRevision: prepared.json.order.dispatch.revision,
    });
    assert(wrongShop.status === 403, 'cross shop accepted');
    const otherShopView = await httpJson(PORT, 'GET', `/v1/order-monitor/non-existing`, admin);
    assert(otherShopView.status === 404, 'missing order not rejected');
    pass('tenant-scoped-access-and-missing-order');

    const readyBody = { expectedRevision: prepared.json.order.dispatch.revision };
    const raced = await Promise.all([
      httpJson(PORT, 'POST', `/v1/order-monitor/${id}/ready`, cashier, readyBody),
      httpJson(PORT, 'POST', `/v1/order-monitor/${id}/ready`, admin, readyBody),
    ]);
    assert(raced.every(r => r.status === 200) &&
      raced.filter(r => !r.json.alreadyReady).length === 1, 'ready idempotency/race');
    const ready = await httpJson(PORT, 'GET', `/v1/order-monitor/${id}`, admin);
    assert(ready.json.order.dispatch.status === 'READY_FOR_DELIVERY' && ready.json.order.dispatch.ready,
      'ready not visible');
    pass('concurrent-packing-confirmation-is-idempotent');

    const eventCount = db.prepare(`SELECT COUNT(*) AS n FROM audit_events
      WHERE action = 'order.dispatch.ready' AND entity_id = ?`).get(id).n;
    assert(eventCount === 1, 'duplicate packing audit events');
    const afterSnapshot = db.prepare(`SELECT total_cents, goods_cents, tax_cents, delivery_charge_cents,
      status, is_test FROM orders WHERE order_id = ?`).get(id);
    assert(JSON.stringify(snapshot) === JSON.stringify(afterSnapshot), 'sales amount changed');
    assert(db.prepare(`SELECT COUNT(*) AS n FROM order_settlements WHERE order_id = ?`).get(id).n === 0,
      'payment unexpectedly posted');
    assert(db.prepare(`SELECT COUNT(*) AS n FROM order_dispatch_readiness WHERE shop_id = ? AND order_id = ?`)
      .get(config.testTenantId, id).n === 1, 'duplicate dispatch rows');
    pass('single-audit-and-no-financial-writes');

    const nonDelivery = await httpJson(PORT, 'POST', '/v1/test-orders', admin, {
      orderNumber: 'E1-TAKEAWAY-002', orderType: 'TAKEAWAY',
      lines: [{ itemId: 'item_orange_juice', quantity: 1 }],
    });
    assert(nonDelivery.status === 201, nonDelivery.json?.error || 'non-delivery order');
    const otherId = nonDelivery.json.order.order_id;
    const otherView = await httpJson(PORT, 'GET', `/v1/order-monitor/${otherId}`, admin);
    assert(otherView.json.order.dispatch.status === 'NOT_APPLICABLE', 'non-delivery dispatch state');
    const nonDeliveryPost = await httpJson(PORT, 'POST', `/v1/order-monitor/${otherId}/ready`, cashier, {
      expectedRevision: otherView.json.order.dispatch.revision,
    });
    assert(nonDeliveryPost.status === 400 && nonDeliveryPost.json.code === 'NOT_DELIVERY', 'non-delivery mark-ready');
    pass('non-delivery-packing-blocked');

    db.prepare('UPDATE orders SET updated_at = ? WHERE order_id = ?').run('2099-01-01T00:00:00.000Z', id);
    const changed = await httpJson(PORT, 'GET', `/v1/order-monitor/${id}`, admin);
    assert(changed.json.order.dispatch.status === 'PACKING_RECHECK_REQUIRED' &&
      changed.json.order.dispatch.ready === false, 'order edit did not invalidate ready');
    const staleAfterEdit = await httpJson(PORT, 'POST', `/v1/order-monitor/${id}/ready`, cashier, readyBody);
    assert(staleAfterEdit.status === 409 && staleAfterEdit.json.code === 'MONITOR_STALE', 'previous ready revision valid after edit');
    pass('order-edit-invalidates-confirmation');

    const reReady = await httpJson(PORT, 'POST', `/v1/order-monitor/${id}/ready`, admin, {
      expectedRevision: changed.json.order.dispatch.revision,
    });
    assert(reReady.status === 200 && reReady.json.alreadyReady === false, 'recheck confirmation');
    assert(db.prepare(`SELECT COUNT(*) AS n FROM audit_events
      WHERE action = 'order.dispatch.ready' AND entity_id = ?`).get(id).n === 2, 'recheck audit');
    pass('packing-reconfirmation-audited');

    await new Promise(resolve => server.close(resolve));
    server = null;
    closeDatabase();
    openDatabase(config.dbPath);
    const persisted = getOrderMonitorDetail(config.testTenantId, id);
    assert(persisted.dispatch.ready && persisted.dispatch.status === 'READY_FOR_DELIVERY', 'ready state lost on restart');
    pass('restart-keeps-dispatch-readiness');

    console.log(`order monitor ${checks} passed (temporary SQLite only, no delivery settlement, real sales disabled)`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
