/**
 * Full cash settlement on a temporary database.
 * Two separate processes race the same unpaid order.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { nowIso } from "../util/time.js";
import { httpJson, openRoleSessions } from "./testHttp.js";

const PORT = 18997;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const results = [];

function pass(name) {
  results.push(name);
  console.log(`PASS ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function listen(server, config) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function sale(submissionId) {
  return {
    orderNumber: `CASH-${submissionId}`,
    submissionId,
    orderType: "TAKEAWAY",
    lines: [{ itemId: "item_orange_juice", quantity: 1 }],
  };
}

function orderSnapshot(orderId) {
  return getDb()
    .prepare(
      `SELECT status, total_cents, tax_cents, goods_cents, net_cents, currency_code,
              delivery_charge_cents, updated_at, fulfillment_behavior, is_test
       FROM orders WHERE order_id = ?`
    )
    .get(orderId);
}

function jobCount(orderId) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ?`).get(orderId).n;
}

function settlementCount(orderId) {
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM order_settlements WHERE order_id = ?`)
    .get(orderId).n;
}

function postAuditCount(settlementId) {
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'payment.cash.post' AND entity_id = ?`)
    .get(settlementId).n;
}

function runChild(scriptPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("close", (code) => {
      let payload = null;
      try {
        payload = JSON.parse(fs.readFileSync(env.RESULT_PATH, "utf8"));
      } catch {
        payload = null;
      }
      if (!payload) {
        reject(new Error(`race child ${code}: ${err || "no result"}`));
        return;
      }
      resolve(payload);
    });
  });
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-cash-settlement-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = String(PORT);
  delete process.env.GTCT_TLS_CERT_FILE;
  delete process.env.GTCT_TLS_KEY_FILE;
  delete process.env.GTCT_ALLOW_LAN_BIND;
  delete process.env.GTCT_ENABLE_LAN_LISTENER;
  delete process.env.GTCT_LAN_BIND_ADDRESS;
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;

  const config = loadConfig({ mode: "http" });
  assert(config.host === "127.0.0.1" && config.physicalPrintEnabled === false, "safety flags");
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);
  let server = createServer(config);
  await listen(server, config);

  const serviceRace = path.join(tempRoot, "service-race.mjs");
  const uniqueRace = path.join(tempRoot, "unique-race.mjs");
  const dbModule = pathToFileURL(path.join(root, "src/db/db.js")).href;
  const serviceModule = pathToFileURL(path.join(root, "src/services/settlements.js")).href;
  const packageJson = path.join(root, "package.json");
  fs.writeFileSync(
    serviceRace,
    `import fs from "node:fs";
import { openDatabase, closeDatabase } from ${JSON.stringify(dbModule)};
import { settleCashPayment } from ${JSON.stringify(serviceModule)};
openDatabase(process.env.DB_PATH);
try {
  const result = settleCashPayment({
    orderId: process.env.ORDER_ID,
    submissionId: process.env.SUBMISSION_ID,
    tender: "CASH",
    amountCents: Number(process.env.AMOUNT),
    currencyCode: process.env.CURRENCY,
  }, { testTenantId: process.env.SHOP_ID }, { role: "cashier", userId: process.env.USER_ID });
  fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({
    ok: true,
    created: result.created === true,
    paymentStatus: result.paymentStatus,
  }));
} catch (err) {
  fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({
    ok: false,
    status: err.status || 0,
    code: err.code || "",
  }));
} finally {
  closeDatabase();
}
`
  );
  fs.writeFileSync(
    uniqueRace,
    `import fs from "node:fs";
import { createRequire } from "node:module";
const Database = createRequire(${JSON.stringify(packageJson)})("better-sqlite3");
const db = new Database(process.env.DB_PATH);
db.pragma("busy_timeout = 5000");
db.pragma("foreign_keys = ON");
const amount = Number(process.env.AMOUNT);
db.exec("BEGIN IMMEDIATE");
try {
  db.prepare(\`INSERT INTO order_settlements (
      settlement_id, shop_id, order_id, submission_id, submission_fingerprint,
      kind, tender, currency_code, amount_cents, balance_before_cents, balance_after_cents,
      created_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, 'PAYMENT', 'CASH', ?, ?, ?, 0, ?, ?)\`).run(
    process.env.SETTLEMENT_ID,
    process.env.SHOP_ID,
    process.env.ORDER_ID,
    process.env.SUBMISSION_ID,
    process.env.SUBMISSION_ID,
    process.env.CURRENCY,
    amount,
    amount,
    process.env.USER_ID,
    process.env.CREATED_AT
  );
  db.prepare(\`INSERT INTO order_payment_balances (
      shop_id, order_id, currency_code, order_total_cents, paid_cents, balance_cents,
      payment_status, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 'PAID', ?)\`).run(
    process.env.SHOP_ID,
    process.env.ORDER_ID,
    process.env.CURRENCY,
    amount,
    amount,
    process.env.CREATED_AT
  );
  db.exec("COMMIT");
  fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({ ok: true }));
} catch (err) {
  try { db.exec("ROLLBACK"); } catch { /* already closed */ }
  fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({
    ok: false,
    code: err.code || "",
    message: String(err.message || ""),
  }));
} finally {
  db.close();
}
`
  );

  try {
    const sessions = await openRoleSessions(PORT, config.testTenantId);
    const cashier = getDb()
      .prepare(`SELECT user_id FROM staff_users WHERE username = 'test.cashier'`)
      .get();
    assert(cashier?.user_id, "cashier user");

    const disposable = await httpJson(PORT, "POST", "/v1/test-orders", sessions.admin, sale("sub-cash-wipe-01"));
    assert(disposable.status === 201, "disposable order");
    const wiped = await httpJson(PORT, "DELETE", "/v1/test-orders", sessions.admin, { confirm: true });
    assert(wiped.status === 200 && wiped.json?.deleted >= 1, "unsettled test orders can be deleted");
    assert(
      !getDb().prepare(`SELECT order_id FROM orders WHERE order_id = ?`).get(disposable.json.order.order_id),
      "deleted order remained"
    );
    pass("unsettled-test-order-delete");

    const created = await httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale("sub-cash-order-a"));
    assert(created.status === 201 && created.json?.order?.order_id, "order create");
    const order = created.json.order;
    const orderId = order.order_id;
    const total = Number(order.total_cents);
    const currency = order.currency_code;
    const before = orderSnapshot(orderId);
    const jobsBefore = jobCount(orderId);
    assert(before.status === "OPEN" && total > 0 && currency, "open payable order");
    assert(
      !getDb().prepare(`SELECT order_id FROM order_payment_balances WHERE order_id = ?`).get(orderId),
      "open order was treated as paid"
    );
    pass("open-order-is-unpaid");

    const payPath = `/v1/orders/${encodeURIComponent(orderId)}/settlements`;
    const payment = {
      submissionId: "sub-cash-pay-aaa",
      tender: "CASH",
      amountCents: total,
      currencyCode: currency,
    };

    const missing = await httpJson(PORT, "POST", payPath, sessions.device, { tender: "CASH" });
    assert(missing.status === 400 && missing.json?.code === "SUBMISSION_REQUIRED", "missing submission");
    const invalid = await httpJson(PORT, "POST", payPath, sessions.device, {
      submissionId: "short",
      tender: "CASH",
    });
    assert(invalid.status === 400 && invalid.json?.code === "INVALID_SUBMISSION", "invalid submission");
    assert(settlementCount(orderId) === 0, "invalid submission created a settlement");
    pass("submission-id-required");

    const wrongAmount = await httpJson(PORT, "POST", payPath, sessions.device, {
      ...payment,
      amountCents: total - 1,
    });
    assert(wrongAmount.status === 400 && wrongAmount.json?.code === "AMOUNT_MISMATCH", "wrong amount");
    const wrongCurrency = await httpJson(PORT, "POST", payPath, sessions.device, {
      ...payment,
      submissionId: "sub-cash-pay-cur",
      currencyCode: "USD",
    });
    assert(wrongCurrency.status === 400 && wrongCurrency.json?.code === "CURRENCY_MISMATCH", "wrong currency");
    const bank = await httpJson(PORT, "POST", payPath, sessions.device, { ...payment, tender: "BANK" });
    assert(bank.status === 400 && bank.json?.code === "BANK_ACCOUNT_REQUIRED", "bank without an account");
    const credit = await httpJson(PORT, "POST", payPath, sessions.device, {
      ...payment,
      submissionId: "sub-cash-pay-crd",
      tender: "CREDIT",
    });
    assert(credit.status === 400 && credit.json?.code === "TENDER_NOT_ALLOWED", "credit tender");
    assert(JSON.stringify(orderSnapshot(orderId)) === JSON.stringify(before), "rejected payment changed the order");
    pass("rejected-payment-leaves-order");

    const anon = await httpJson(PORT, "POST", payPath, null, payment);
    assert(anon.status === 401, "anonymous payment");
    pass("anonymous-rejected");

    const paid = await httpJson(PORT, "POST", payPath, sessions.device, payment);
    assert(paid.status === 201 && paid.json?.created === true, "cashier payment");
    assert(paid.json.paymentStatus === "PAID", "payment status");
    assert(paid.json.balance.paidCents === total, "paid cents");
    assert(paid.json.balance.balanceCents === 0, "remaining balance");
    assert(paid.json.balance.orderTotalCents === total, "stored order total");
    assert(paid.json.settlement.tender === "CASH", "cash tender");
    assert(paid.json.settlement.amountCents === total, "server amount");
    assert(paid.json.settlement.currencyCode === currency, "server currency");
    assert(paid.json.settlement.createdByUserId === cashier.user_id, "staff user");
    assert(JSON.stringify(orderSnapshot(orderId)) === JSON.stringify(before), "payment changed the order");
    assert(jobCount(orderId) === jobsBefore, "payment created a printer job");
    assert(settlementCount(orderId) === 1, "settlement count");
    const settlementId = paid.json.settlement.settlementId;
    const audit = getDb()
      .prepare(`SELECT * FROM audit_events WHERE action = 'payment.cash.post' AND entity_id = ?`)
      .get(settlementId);
    const detail = JSON.parse(audit.detail_json);
    assert(audit.actor_user_id === cashier.user_id, "audit staff");
    assert(detail.shopId === config.testTenantId, "audit shop");
    assert(detail.orderId === orderId, "audit order");
    assert(detail.settlementId === settlementId, "audit settlement");
    assert(detail.tender === "CASH" && detail.amountCents === total, "audit amount");
    assert(detail.currencyCode === currency, "audit currency");
    assert(detail.balanceBeforeCents === total && detail.balanceAfterCents === 0, "audit balance");
    assert(detail.staffUserId === cashier.user_id && audit.created_at, "audit actor and time");
    const secretBlob = `${audit.detail_json} ${JSON.stringify(paid.json)}`.toLowerCase();
    assert(!secretBlob.includes("password") && !secretBlob.includes("gtct_ls_session"), "audit leaked a secret");
    pass("full-cash-settlement");
    pass("audit-success");

    const retry = await httpJson(PORT, "POST", payPath, sessions.device, payment);
    assert(retry.status === 200 && retry.json?.created === false, "same submission retry");
    assert(retry.json.settlement.settlementId === settlementId, "retry returned a new settlement");
    assert(settlementCount(orderId) === 1 && postAuditCount(settlementId) === 1, "retry duplicated payment");
    pass("same-submission-retry");

    const conflict = await httpJson(PORT, "POST", payPath, sessions.device, {
      ...payment,
      amountCents: total - 1,
    });
    assert(conflict.status === 409 && conflict.json?.code === "SUBMISSION_CONFLICT", "conflicting submission");
    assert(settlementCount(orderId) === 1, "conflict added a settlement");
    pass("conflicting-submission");

    const again = await httpJson(PORT, "POST", payPath, sessions.device, {
      ...payment,
      submissionId: "sub-cash-pay-bbb",
    });
    assert(again.status === 409 && again.json?.code === "ALREADY_PAID", "second payment");
    assert(settlementCount(orderId) === 1, "second payment was stored");
    pass("already-paid");

    const raceOrder = await httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale("sub-cash-order-b"));
    assert(raceOrder.status === 201, "race order");
    const raceId = raceOrder.json.order.order_id;
    const raceBefore = orderSnapshot(raceId);
    const raceJobs = jobCount(raceId);
    const raceBase = {
      DB_PATH: config.dbPath,
      ORDER_ID: raceId,
      SHOP_ID: config.testTenantId,
      USER_ID: cashier.user_id,
      AMOUNT: String(raceOrder.json.order.total_cents),
      CURRENCY: raceOrder.json.order.currency_code,
    };
    const raced = await Promise.all([
      runChild(serviceRace, {
        ...raceBase,
        SUBMISSION_ID: "sub-cash-race-a1",
        RESULT_PATH: path.join(tempRoot, "race-a.json"),
      }),
      runChild(serviceRace, {
        ...raceBase,
        SUBMISSION_ID: "sub-cash-race-b2",
        RESULT_PATH: path.join(tempRoot, "race-b.json"),
      }),
    ]);
    const winners = raced.filter((row) => row.ok && row.created);
    const losers = raced.filter((row) => row.code === "ALREADY_PAID");
    assert(winners.length === 1 && losers.length === 1, `service race ${JSON.stringify(raced)}`);
    assert(settlementCount(raceId) === 1, "race stored two payments");
    assert(JSON.stringify(orderSnapshot(raceId)) === JSON.stringify(raceBefore), "race changed the order");
    assert(jobCount(raceId) === raceJobs, "race created a printer job");
    const raceBalance = getDb()
      .prepare(`SELECT * FROM order_payment_balances WHERE order_id = ?`)
      .get(raceId);
    assert(
      raceBalance.payment_status === "PAID" && Number(raceBalance.balance_cents) === 0,
      "race balance"
    );
    pass("simultaneous-payments");

    const uniqueOrder = await httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale("sub-cash-order-c"));
    assert(uniqueOrder.status === 201, "unique-index order");
    const uniqueId = uniqueOrder.json.order.order_id;
    const uniqueBase = {
      DB_PATH: config.dbPath,
      ORDER_ID: uniqueId,
      SHOP_ID: config.testTenantId,
      USER_ID: cashier.user_id,
      AMOUNT: String(uniqueOrder.json.order.total_cents),
      CURRENCY: uniqueOrder.json.order.currency_code,
      CREATED_AT: nowIso(),
    };
    const uniqueRaced = await Promise.all([
      runChild(uniqueRace, {
        ...uniqueBase,
        SUBMISSION_ID: "sub-cash-uniq-a1",
        SETTLEMENT_ID: "set_cash_uniq_a",
        RESULT_PATH: path.join(tempRoot, "uniq-a.json"),
      }),
      runChild(uniqueRace, {
        ...uniqueBase,
        SUBMISSION_ID: "sub-cash-uniq-b2",
        SETTLEMENT_ID: "set_cash_uniq_b",
        RESULT_PATH: path.join(tempRoot, "uniq-b.json"),
      }),
    ]);
    assert(uniqueRaced.filter((row) => row.ok).length === 1, `unique race winners ${JSON.stringify(uniqueRaced)}`);
    assert(
      uniqueRaced.some((row) => !row.ok && String(row.code).includes("UNIQUE")),
      `unique race loser ${JSON.stringify(uniqueRaced)}`
    );
    assert(settlementCount(uniqueId) === 1, "unique index allowed two payments");
    pass("concurrent-unique-payment");

    getDb()
      .prepare(
        `UPDATE staff_role_permissions
         SET revoked_at = ?
         WHERE role_id = 'role_cashier' AND permission_code = 'sales.payment.receive' AND revoked_at IS NULL`
      )
      .run(nowIso());
    const locked = await httpJson(PORT, "POST", "/v1/test-orders", sessions.admin, sale("sub-cash-order-d"));
    assert(locked.status === 201, "permission order");
    const lockedId = locked.json.order.order_id;
    const denied = await httpJson(PORT, "POST", `/v1/orders/${lockedId}/settlements`, sessions.device, {
      submissionId: "sub-cash-deny-01",
      tender: "CASH",
      amountCents: locked.json.order.total_cents,
      currencyCode: locked.json.order.currency_code,
    });
    assert(denied.status === 403, "cashier without permission");
    assert(settlementCount(lockedId) === 0, "forbidden payment was stored");
    const forbiddenAudit = getDb()
      .prepare(
        `SELECT detail_json FROM audit_events
         WHERE action = 'payment.cash.reject' AND entity_id = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(lockedId);
    assert(JSON.parse(forbiddenAudit.detail_json).code === "FORBIDDEN", "forbidden audit");
    const adminPaid = await httpJson(PORT, "POST", `/v1/orders/${lockedId}/settlements`, sessions.admin, {
      submissionId: "sub-cash-admin-1",
      tender: "CASH",
      amountCents: locked.json.order.total_cents,
      currencyCode: locked.json.order.currency_code,
    });
    assert(adminPaid.status === 201 && adminPaid.json.paymentStatus === "PAID", "admin payment");
    pass("cashier-authorized-then-revoked");

    const foreignId = `ord_foreign_${Date.now()}`;
    const source = getDb().prepare(`SELECT * FROM orders WHERE order_id = ?`).get(orderId);
    const columns = Object.keys(source);
    const copy = { ...source, order_id: foreignId, tenant_id: "other-shop", order_number: `OTHER-${Date.now()}` };
    getDb()
      .prepare(`INSERT INTO orders (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map((column) => copy[column]));
    const foreign = await httpJson(PORT, "POST", `/v1/orders/${foreignId}/settlements`, sessions.admin, {
      submissionId: "sub-cash-other-1",
      tender: "CASH",
      amountCents: total,
      currencyCode: currency,
    });
    assert(foreign.status === 404 && foreign.json?.code === "ORDER_NOT_FOUND", "other shop");
    assert(settlementCount(foreignId) === 0, "other shop settlement");
    pass("shop-isolation");

    const blocked = await httpJson(PORT, "DELETE", "/v1/test-orders", sessions.admin, { confirm: true });
    assert(blocked.status === 409 && blocked.json?.code === "SETTLED_TEST_ORDERS", "settled delete");
    assert(getDb().prepare(`SELECT order_id FROM orders WHERE order_id = ?`).get(orderId), "settled order was deleted");
    assert(settlementCount(orderId) === 1, "settlement was removed");
    assert(JSON.stringify(orderSnapshot(orderId)) === JSON.stringify(before), "blocked delete changed the order");
    pass("settled-test-order-delete-blocked");

    await closeServer(server);
    closeDatabase();
    openDatabase(config.dbPath);
    await runMigrations(getDb());
    server = createServer(config);
    await listen(server, config);
    const afterRestart = await httpJson(PORT, "POST", payPath, sessions.admin, payment);
    assert(afterRestart.status === 200 && afterRestart.json?.created === false, "restart retry");
    assert(afterRestart.json.settlement.settlementId === settlementId, "restart created a new settlement");
    assert(settlementCount(orderId) === 1 && postAuditCount(settlementId) === 1, "restart duplicated payment");
    assert(JSON.stringify(orderSnapshot(orderId)) === JSON.stringify(before), "restart changed the order");
    pass("restart-retry");

    console.log(`cash settlement ${results.length}`);
  } finally {
    if (server.listening) await closeServer(server);
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
