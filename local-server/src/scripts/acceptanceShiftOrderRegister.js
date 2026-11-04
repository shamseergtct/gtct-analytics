/**
 * P2-E1.1 disposable TEST acceptance — shift/date/token + read-only order status.
 * Never opens a live restaurant database, deletes records or enables real sales.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureDataDirs } from '../config.js';
import { openDatabase, runMigrations, getDb, closeDatabase } from '../db/db.js';
import { initLogger } from '../util/logger.js';
import { seedSampleData } from '../seed/sampleData.js';
import { createServer } from '../http/server.js';
import { httpJson, openRoleSessions } from './testHttp.js';
import { renderCashierReceipt, renderKitchenTicket } from '../print/ticketFormat.js';

const PORT = 19029;
let n = 0;
function ok(condition, message) { if (!condition) throw new Error(message); }
function pass(label) { n++; console.log(`PASS ${label}`); }

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtct-e11-test-'));
  process.env.GTCT_LOCAL_DATA_DIR = temp;
  process.env.GTCT_LOCAL_HOST = '127.0.0.1';
  process.env.GTCT_LOCAL_PORT = String(PORT);
  for (const k of ['GTCT_TLS_CERT_FILE', 'GTCT_TLS_KEY_FILE', 'GTCT_ALLOW_LAN_BIND',
    'GTCT_ENABLE_LAN_LISTENER', 'GTCT_LAN_BIND_ADDRESS', 'GTCT_ENABLE_PHYSICAL_PRINT',
    'GTCT_LOCAL_OPERATING_MODE']) delete process.env[k];
  const cfg = loadConfig({ mode: 'http' });
  ok(cfg.operatingMode === 'TEST' && cfg.loopback && !cfg.physicalPrintEnabled &&
    path.resolve(cfg.dbPath).startsWith(path.resolve(temp) + path.sep), 'TEST path guard');
  ensureDataDirs(cfg);
  initLogger(cfg.logDir);
  let srv;
  try {
    openDatabase(cfg.dbPath);
    await runMigrations(getDb());
    // Repeat migration must never overwrite existing shift or token metadata.
    await runMigrations(getDb());
    seedSampleData(cfg);
    pass('disposable-sqlite-migrations');
    srv = createServer(cfg);
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(cfg.port, cfg.host, resolve);
    });
    const denied = await httpJson(PORT, 'GET', '/v1/business-shift');
    ok(denied.status === 401, 'unauthenticated business shift leaked');
    pass('business-shift-login-required');
    const sessions = await openRoleSessions(PORT, cfg.testTenantId);
    const admin = sessions.admin;
    const cashier = sessions.device;
    const initial = await httpJson(PORT, 'GET', '/v1/business-shift', admin);
    ok(initial.status === 200 && !initial.json.active && !initial.json.requiresManualStart,
      'unexpected first shift');
    pass('initial-shift-not-started');

    const orderBody = (label, sub) => ({
      orderNumber: label, submissionId: sub,
      orderType: 'TAKEAWAY', lines: [{ itemId: 'item_orange_juice', quantity: 1 }],
    });
    const body1 = orderBody('E11-INVOICE-001', 'e11-invoice-one');
    const first = await httpJson(PORT, 'POST', '/v1/test-orders', cashier, body1);
    ok(first.status === 201, first.json?.error || 'first order');
    const firstOrder = first.json.order;
    const id1 = firstOrder.order_id;
    ok(firstOrder.token_number === 1 && firstOrder.business_date && firstOrder.business_shift_id,
      'first order has no shift token');
    pass('first-order-auto-initializes-test-shift');
    const active = (await httpJson(PORT, 'GET', '/v1/business-shift', admin)).json.active;
    ok(active?.shiftId === firstOrder.business_shift_id && active.lastTokenNumber === 1,
      'shift identity mismatch');
    pass('shift-business-date-and-counter-visible');

    const second = await httpJson(PORT, 'POST', '/v1/test-orders', cashier,
      orderBody('E11-INVOICE-002', 'e11-invoice-two'));
    ok(second.status === 201 && second.json.order.token_number === 2 &&
      second.json.order.business_shift_id === active.shiftId,
      second.json?.error || 'second token');
    pass('tokens-increment-within-shift');
    const retry = await httpJson(PORT, 'POST', '/v1/test-orders', cashier, body1);
    ok(retry.status === 200 && retry.json.order.order_id === id1 &&
      (await httpJson(PORT, 'GET', '/v1/business-shift', admin)).json.active.lastTokenNumber === 2,
      'retry consumed a token');
    pass('submission-retry-does-not-consume-token');

    const before = getDb().prepare(`SELECT total_cents, tax_cents, goods_cents, order_number,
      business_shift_id, business_date, token_number FROM orders WHERE order_id=?`).get(id1);
    const register = await httpJson(PORT, 'GET', '/v1/order-register', admin);
    const row = register.json.orders.find(o => o.orderId === id1);
    ok(register.status === 200 && row.invoiceNumber === before.order_number &&
      row.tokenNumber === 1 && row.operationalStatus !== 'OPEN', 'incorrect order list projection');
    pass('current-kitchen-status-instead-of-record-open');
    ok(row.deliveryBoyName == null && row.businessDate === before.business_date,
      'invented delivery name or incorrect business date');
    pass('no-fake-driver-assignment');
    const detail = await httpJson(PORT, 'GET', `/v1/order-register/${id1}`, admin);
    ok(detail.status === 200 && detail.json.order.tokenNumber === 1 &&
      detail.json.order.invoiceNumber === before.order_number,
      'order detail missing invoice/token');
    pass('read-only-order-detail-identifiers');

    const pendingJobs = getDb().prepare(`SELECT job_type, payload_snapshot FROM print_jobs
      WHERE order_id=?`).all(id1);
    const kitchen = pendingJobs.find(j => j.job_type === 'KITCHEN');
    const cashierJob = pendingJobs.find(j => j.job_type === 'CASHIER');
    ok(kitchen && cashierJob, 'print snapshots missing');
    const kitchenText = renderKitchenTicket(JSON.parse(kitchen.payload_snapshot));
    const cashierText = renderCashierReceipt(JSON.parse(cashierJob.payload_snapshot));
    ok(kitchenText.includes('TOKEN: 001') && cashierText.includes('TOKEN: 001') &&
      cashierText.includes(`INVOICE: ${before.order_number}`), 'invoice and token not printed');
    pass('print-snapshots-keep-permanent-invoice-and-shift-token');

    const cashierClose = await httpJson(PORT, 'POST', '/v1/business-shift/close', cashier,
      { shiftId: active.shiftId, confirm: true });
    ok(cashierClose.status === 403, 'cashier closed shift');
    pass('admin-only-shift-change');
    const noConfirm = await httpJson(PORT, 'POST', '/v1/business-shift/close', admin,
      { shiftId: active.shiftId });
    ok(noConfirm.status === 400 && noConfirm.json.code === 'SHIFT_CONFIRM_REQUIRED',
      'shift closed without confirmation');
    pass('shift-close-confirmation-guard');
    const closed = await httpJson(PORT, 'POST', '/v1/business-shift/close', admin,
      { shiftId: active.shiftId, confirm: true });
    ok(closed.status === 200 && closed.json.shift.status === 'CLOSED',
      closed.json?.error || 'shift close');
    pass('explicit-close-without-settlement');
    const blocked = await httpJson(PORT, 'POST', '/v1/test-orders', cashier,
      orderBody('E11-INVOICE-003', 'e11-invoice-three'));
    ok(blocked.status === 409 && blocked.json.code === 'BUSINESS_SHIFT_CLOSED',
      'new order accepted in closed shift');
    pass('new-order-blocked-after-close');
    const unchanged = getDb().prepare(`SELECT total_cents, tax_cents, goods_cents,
      business_shift_id, business_date, token_number FROM orders WHERE order_id=?`).get(id1);
    ok(JSON.stringify(unchanged) === JSON.stringify({
      total_cents: before.total_cents, tax_cents: before.tax_cents,
      goods_cents: before.goods_cents, business_shift_id: before.business_shift_id,
      business_date: before.business_date, token_number: before.token_number,
    }), 'shift close changed order math or identity');
    pass('close-does-not-change-financial-amounts');

    // Explicitly choose SAME business date: a second shift is still a new token series.
    const reopened = await httpJson(PORT, 'POST', '/v1/business-shift/open', admin,
      { businessDate: active.businessDate });
    ok(reopened.status === 201 && reopened.json.shift.shiftId !== active.shiftId,
      reopened.json?.error || 'open new shift');
    pass('admin-opens-new-shift-with-explicit-business-date');
    const third = await httpJson(PORT, 'POST', '/v1/test-orders', cashier,
      orderBody('E11-INVOICE-003', 'e11-invoice-three'));
    ok(third.status === 201 && third.json.order.token_number === 1 &&
      third.json.order.order_number !== firstOrder.order_number &&
      third.json.order.business_shift_id !== firstOrder.business_shift_id,
      third.json?.error || 'new shift token reset');
    pass('token-resets-only-on-next-shift-not-on-midnight');
    ok(third.json.order.business_date === active.businessDate, 'chosen business date ignored');
    pass('business-date-frozen-within-shift');

    const listed = await httpJson(PORT, 'GET', `/v1/order-register?date=${active.businessDate}`, admin);
    ok(listed.status === 200 && listed.json.orders.length >= 3, 'filter did not use business date');
    pass('order-register-filters-by-shift-business-date');
    const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
    const page = fs.readFileSync(path.join(uiRoot, 'orders.js'), 'utf8');
    const html = fs.readFileSync(path.join(uiRoot, 'orders.html'), 'utf8');
    ok(page.includes('data-open-order') && page.includes('operationalStatus') &&
      page.includes('deliveryBoyName') && page.includes('tokenNumber') &&
      html.includes('shift-close') && html.includes('shift-next-date'), 'UI contract missing');
    pass('row-click-status-driver-token-and-shift-ui-contract');
    ok(getDb().prepare('SELECT COUNT(*) AS n FROM order_settlements').get().n === 0,
      'TEST shift close opened payment ledger');
    pass('no-cash-bank-or-driver-settlement-writes');
    console.log(`Shift order register ${n} passed (temporary TEST SQLite only, real sales disabled)`);
  } finally {
    if (srv) await new Promise(resolve => srv.close(resolve));
    closeDatabase();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err.stack || err.message || err); process.exitCode = 1; });
