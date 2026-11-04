/**
 * Operational bank accounts and full bank settlement.
 * Uses a temporary database only.
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
import { up as migrateBankAccounts } from "../db/migrations/024_bank_accounts.js";
import { httpJson, openRoleSessions } from "./testHttp.js";

const PORT = 19000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(root, "package.json"));
const Database = require("better-sqlite3");
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
    orderNumber: `BANK-${submissionId}`,
    submissionId,
    orderType: "TAKEAWAY",
    lines: [{ itemId: "item_orange_juice", quantity: 1 }],
  };
}

function orderSnapshot(orderId) {
  return getDb()
    .prepare(
      `SELECT status, total_cents, tax_cents, goods_cents, net_cents, currency_code, is_test
       FROM orders WHERE order_id = ?`
    )
    .get(orderId);
}

function jobCount(orderId) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ?`).get(orderId).n;
}

function settlementCount(orderId) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM order_settlements WHERE order_id = ?`).get(orderId).n;
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

async function migrateUntil(db, lastFile) {
  db.exec(fs.readFileSync(path.join(root, "src/db/schema.sql"), "utf8"));
  const dir = path.join(root, "src/db/migrations");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".sql") || name.endsWith(".js")).sort();
  const insert = db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)");
  for (const file of files) {
    if (file > lastFile) break;
    const full = path.join(dir, file);
    if (file.endsWith(".sql")) {
      const tx = db.transaction(() => {
        db.exec(fs.readFileSync(full, "utf8"));
        insert.run(file, new Date().toISOString());
      });
      tx();
      continue;
    }
    const mod = await import(pathToFileURL(full).href);
    mod.up(db);
    insert.run(file, new Date().toISOString());
  }
}

async function proveHistoricalCashCopy(tempRoot) {
  const file = path.join(tempRoot, "historical.sqlite");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  try {
    await migrateUntil(db, "023_cash_settlement.js");
    const historical = {
      settlement_id: "set_historical_cash",
      shop_id: "test-tenant-phase1",
      order_id: "ord_historical_cash",
      submission_id: "sub-historical-cash",
      submission_fingerprint: "fingerprint-historical-cash",
      kind: "PAYMENT",
      tender: "CASH",
      currency_code: "QAR",
      amount_cents: 800,
      balance_before_cents: 800,
      balance_after_cents: 0,
      created_by_user_id: "usr_historical",
      created_at: "2026-10-01T00:00:00.000Z",
    };
    db.pragma("foreign_keys = OFF");
    db.prepare(
      `INSERT INTO order_settlements (
         settlement_id, shop_id, order_id, submission_id, submission_fingerprint,
         kind, tender, currency_code, amount_cents, balance_before_cents, balance_after_cents,
         created_by_user_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...Object.values(historical));
    migrateBankAccounts(db);
    migrateBankAccounts(db);
    const copied = db.prepare(`SELECT * FROM order_settlements WHERE settlement_id = ?`).get(historical.settlement_id);
    for (const [key, value] of Object.entries(historical)) {
      assert(copied[key] === value, `historical ${key} changed`);
    }
    assert(copied.bank_account_id == null, "historical cash gained a bank account");
    let checkFailed = false;
    try {
      db.prepare(
        `INSERT INTO order_settlements (
           settlement_id, shop_id, order_id, submission_id, submission_fingerprint,
           kind, tender, currency_code, amount_cents, balance_before_cents, balance_after_cents,
           created_by_user_id, created_at, bank_account_id
         ) VALUES ('set_bad_bank', 'test-tenant-phase1', 'ord_bad', 'sub-bad-bank', 'fp',
           'PAYMENT', 'BANK', 'QAR', 800, 800, 0, 'usr', '2026-10-01T00:00:00.000Z', NULL)`
      ).run();
    } catch (err) {
      checkFailed = /CHECK/i.test(String(err.message || ""));
    }
    assert(checkFailed, "bank settlement without an account was stored");
    pass("historical-cash-migration");
  } finally {
    db.close();
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-bank-payment-"));
  await proveHistoricalCashCopy(tempRoot);

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

  const raceScript = path.join(tempRoot, "bank-race.mjs");
  fs.writeFileSync(
    raceScript,
    `import http from "node:http";
import fs from "node:fs";
const body = {
  submissionId: process.env.SUBMISSION_ID,
  tender: process.env.TENDER,
  amountCents: Number(process.env.AMOUNT),
  currencyCode: process.env.CURRENCY,
};
if (process.env.BANK_ACCOUNT_ID) body.bankAccountId = process.env.BANK_ACCOUNT_ID;
const payload = JSON.stringify(body);
const req = http.request({
  host: "127.0.0.1",
  port: Number(process.env.PORT),
  path: process.env.PAY_PATH,
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    Origin: "http://127.0.0.1:" + process.env.PORT,
    Cookie: "gtct_ls_session=" + encodeURIComponent(process.env.SESSION),
  },
}, (res) => {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => {
    let json = null;
    try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json = null; }
    fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({
      status: res.statusCode,
      code: json?.code || "",
      created: json?.created === true,
      tender: json?.settlement?.tender || "",
      settlementId: json?.settlement?.settlementId || "",
      submissionId: process.env.SUBMISSION_ID,
      requestTender: process.env.TENDER,
    }));
  });
});
req.on("error", (err) => {
  fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({ status: 0, code: String(err.message || "") }));
});
req.end(payload);
`
  );

  try {
    const staffAuth = fs.readFileSync(path.join(root, "src/services/staffAuth.js"), "utf8");
    const staffUsers = fs.readFileSync(path.join(root, "src/services/staffUsers.js"), "utf8");
    assert(!staffAuth.includes("shop.bank_accounts.manage"), "device can manage bank accounts");
    assert(!staffUsers.includes("shop.bank_accounts.manage"), "cashiers can be granted bank management");
    const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
    const appJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
    assert(html.includes("value=\"BANK\"") && html.includes("payment-bank-empty"), "bank payment choice");
    assert(appJs.includes("bankAccountId") && appJs.includes("gtct.cashSettlement."), "bank retry keeps the submission");
    pass("payment-ui-contract");

    const sessions = await openRoleSessions(PORT, config.testTenantId);
    const cashier = getDb().prepare(`SELECT user_id FROM staff_users WHERE username = 'test.cashier'`).get();
    const adminGrant = getDb()
      .prepare(
        `SELECT 1 AS ok FROM staff_role_permissions
         WHERE role_id = 'role_admin' AND permission_code = 'shop.bank_accounts.manage' AND revoked_at IS NULL`
      )
      .get();
    const cashierGrant = getDb()
      .prepare(
        `SELECT 1 AS ok FROM staff_role_permissions
         WHERE role_id = 'role_cashier' AND permission_code = 'shop.bank_accounts.manage' AND revoked_at IS NULL`
      )
      .get();
    assert(adminGrant && !cashierGrant, "bank management is admin only");

    const denied = await httpJson(PORT, "POST", "/v1/bank-accounts", sessions.device, {
      displayName: "Cashier account",
      bankName: "Test Bank",
      accountType: "OPERATIONAL",
    });
    assert(denied.status === 403, "cashier created an account");
    const deniedList = await httpJson(PORT, "GET", "/v1/bank-accounts?manage=1", sessions.device);
    assert(deniedList.status === 403, "cashier listed every account");
    pass("cashier-cannot-manage-accounts");

    const secret = await httpJson(PORT, "POST", "/v1/bank-accounts", sessions.admin, {
      displayName: "Secret account",
      bankName: "Test Bank",
      accountType: "OPERATIONAL",
      password: "not-stored",
    });
    assert(secret.status === 400 && secret.json?.code === "SECRET_NOT_ALLOWED", "password was accepted");

    const fullNumber = "1234567890123456";
    const operational = await httpJson(PORT, "POST", "/v1/bank-accounts", sessions.admin, {
      displayName: "Main operating",
      bankName: "Qatar National Bank",
      accountType: "OPERATIONAL",
      isActive: true,
      maskedReference: fullNumber,
    });
    assert(operational.status === 201, "operational account");
    const ops = operational.json.account;
    assert(ops.accountType === "OPERATIONAL" && ops.isActive === true, "operational fields");
    assert(ops.maskedReference === "****3456", "reference was not masked");
    assert(!JSON.stringify(operational.json).includes(fullNumber), "response exposed the full reference");
    const createAudit = getDb()
      .prepare(`SELECT detail_json, actor_user_id, created_at FROM audit_events WHERE action = 'bank_account.create' AND entity_id = ?`)
      .get(ops.accountId);
    assert(createAudit?.actor_user_id && createAudit.created_at, "create audit");
    assert(!createAudit.detail_json.includes(fullNumber), "audit stored the full reference");
    assert(createAudit.detail_json.includes("****3456"), "audit missed the mask");
    pass("admin-creates-operational");

    const reserve = await httpJson(PORT, "POST", "/v1/bank-accounts", sessions.admin, {
      displayName: "Owner reserve",
      bankName: "Qatar National Bank",
      accountType: "RESERVE",
      maskedReference: "****1111",
    });
    assert(reserve.status === 201 && reserve.json.account.accountType === "RESERVE", "reserve account");
    pass("admin-creates-reserve");

    const inactive = await httpJson(PORT, "POST", "/v1/bank-accounts", sessions.admin, {
      displayName: "Closed counter",
      bankName: "Doha Bank",
      accountType: "OPERATIONAL",
      isActive: false,
    });
    assert(inactive.status === 201 && inactive.json.account.isActive === false, "inactive account");

    const salesList = await httpJson(PORT, "GET", "/v1/bank-accounts", sessions.device);
    assert(salesList.status === 200, "sales account list");
    const salesIds = (salesList.json.accounts || []).map((account) => account.accountId);
    assert(salesIds.length === 1 && salesIds[0] === ops.accountId, `sales list ${JSON.stringify(salesList.json)}`);
    assert(
      (salesList.json.accounts || []).every((account) => account.accountType === "OPERATIONAL" && account.isActive),
      "sales list included a non-operational account"
    );
    pass("sales-lists-active-operational-only");

    const ordered = await httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale("sub-bank-order-a"));
    assert(ordered.status === 201, "bank order");
    const order = ordered.json.order;
    const orderId = order.order_id;
    const total = order.total_cents;
    const currency = order.currency_code;
    const before = orderSnapshot(orderId);
    const jobsBefore = jobCount(orderId);
    const payPath = `/v1/orders/${orderId}/settlements`;
    const pendingBefore = await httpJson(PORT, "GET", "/v1/pending-payments", sessions.device);
    assert((pendingBefore.json.orders || []).some((row) => row.orderId === orderId), "unpaid order missing");

    const payment = {
      submissionId: "sub-bank-pay-aaa",
      tender: "BANK",
      amountCents: total,
      currencyCode: currency,
      bankAccountId: ops.accountId,
    };
    const paid = await httpJson(PORT, "POST", payPath, sessions.device, payment);
    assert(paid.status === 201 && paid.json?.created === true, `bank payment ${paid.status} ${paid.json?.code || ""}`);
    assert(paid.json.paymentStatus === "PAID" && paid.json.balance.balanceCents === 0, "bank balance");
    assert(paid.json.settlement.tender === "BANK", "bank tender");
    assert(paid.json.settlement.bankAccountId === ops.accountId, "settlement account");
    assert(paid.json.settlement.bankAccountLabel.includes("Main operating"), "account label");
    assert(paid.json.settlement.amountCents === total && paid.json.balance.orderTotalCents === total, "frozen total");
    assert(JSON.stringify(orderSnapshot(orderId)) === JSON.stringify(before), "bank payment changed the order");
    assert(before.status === "OPEN", "order was not open");
    assert(jobCount(orderId) === jobsBefore, "bank payment created a kitchen ticket");
    assert(settlementCount(orderId) === 1, "bank settlement count");
    const bankAudit = getDb()
      .prepare(`SELECT * FROM audit_events WHERE action = 'payment.bank.post' AND entity_id = ?`)
      .get(paid.json.settlement.settlementId);
    const bankDetail = JSON.parse(bankAudit.detail_json);
    assert(bankAudit.actor_user_id === cashier.user_id, "bank audit staff");
    assert(bankDetail.orderId === orderId && bankDetail.settlementId === paid.json.settlement.settlementId, "bank audit ids");
    assert(bankDetail.bankAccountId === ops.accountId && bankDetail.amountCents === total, "bank audit amount");
    assert(bankDetail.currencyCode === currency && bankAudit.created_at, "bank audit currency");
    assert(!bankAudit.detail_json.includes(fullNumber), "bank audit exposed an account number");
    pass("full-bank-payment");

    const pendingAfter = await httpJson(PORT, "GET", "/v1/pending-payments", sessions.device);
    assert(!(pendingAfter.json.orders || []).some((row) => row.orderId === orderId), "paid order stayed pending");
    pass("pending-list-updates");

    const retry = await httpJson(PORT, "POST", payPath, sessions.admin, payment);
    assert(retry.status === 200 && retry.json?.created === false, "bank retry");
    assert(retry.json.settlement.settlementId === paid.json.settlement.settlementId, "retry created another settlement");
    pass("bank-retry");

    const cashOrder = await httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale("sub-bank-order-cash"));
    assert(cashOrder.status === 201, "cash order");
    const cashId = cashOrder.json.order.order_id;
    const cashPayment = {
      submissionId: "sub-bank-cash-aaa",
      tender: "CASH",
      amountCents: cashOrder.json.order.total_cents,
      currencyCode: cashOrder.json.order.currency_code,
    };
    const cashPaid = await httpJson(PORT, "POST", `/v1/orders/${cashId}/settlements`, sessions.device, cashPayment);
    assert(cashPaid.status === 201 && cashPaid.json.settlement.tender === "CASH", "cash payment");
    assert(cashPaid.json.settlement.bankAccountId == null, "cash payment stored a bank account");
    pass("full-cash-payment");

    const reservePay = await httpJson(PORT, "POST", `/v1/orders/${cashId}/settlements`, sessions.device, {
      submissionId: "sub-bank-reserve-1",
      tender: "BANK",
      amountCents: total,
      currencyCode: currency,
      bankAccountId: reserve.json.account.accountId,
    });
    const reserveOrder = await httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale("sub-bank-order-reserve"));
    const reserveAttempt = await httpJson(
      PORT,
      "POST",
      `/v1/orders/${reserveOrder.json.order.order_id}/settlements`,
      sessions.device,
      {
        submissionId: "sub-bank-reserve-2",
        tender: "BANK",
        amountCents: reserveOrder.json.order.total_cents,
        currencyCode: reserveOrder.json.order.currency_code,
        bankAccountId: reserve.json.account.accountId,
      }
    );
    assert(reserveAttempt.status === 400 && reserveAttempt.json?.code === "BANK_ACCOUNT_NOT_OPERATIONAL", "reserve payment");
    assert(settlementCount(reserveOrder.json.order.order_id) === 0, "reserve payment was stored");
    assert(reservePay.status === 409, "reserve request changed an existing cash payment");
    pass("reserve-account-rejected");

    const inactiveAttempt = await httpJson(
      PORT,
      "POST",
      `/v1/orders/${reserveOrder.json.order.order_id}/settlements`,
      sessions.device,
      {
        submissionId: "sub-bank-inactive-1",
        tender: "BANK",
        amountCents: reserveOrder.json.order.total_cents,
        currencyCode: reserveOrder.json.order.currency_code,
        bankAccountId: inactive.json.account.accountId,
      }
    );
    assert(inactiveAttempt.status === 400 && inactiveAttempt.json?.code === "BANK_ACCOUNT_INACTIVE", "inactive payment");
    pass("inactive-account-rejected");

    const foreignId = "acct_other_shop_bank";
    const foreignSource = getDb().prepare(`SELECT * FROM shop_bank_accounts WHERE account_id = ?`).get(ops.accountId);
    const foreignColumns = Object.keys(foreignSource);
    const foreignRow = { ...foreignSource, account_id: foreignId, shop_id: "other-shop", display_name: "Other shop" };
    getDb()
      .prepare(
        `INSERT INTO shop_bank_accounts (${foreignColumns.join(", ")}) VALUES (${foreignColumns.map(() => "?").join(", ")})`
      )
      .run(...foreignColumns.map((column) => foreignRow[column]));
    const foreignPay = await httpJson(
      PORT,
      "POST",
      `/v1/orders/${reserveOrder.json.order.order_id}/settlements`,
      sessions.device,
      {
        submissionId: "sub-bank-foreign-1",
        tender: "BANK",
        amountCents: reserveOrder.json.order.total_cents,
        currencyCode: reserveOrder.json.order.currency_code,
        bankAccountId: foreignId,
      }
    );
    assert(foreignPay.status === 404 && foreignPay.json?.code === "BANK_ACCOUNT_NOT_FOUND", "cross-shop account");
    pass("cross-shop-account-rejected");

    const missing = await httpJson(
      PORT,
      "POST",
      `/v1/orders/${reserveOrder.json.order.order_id}/settlements`,
      sessions.device,
      {
        submissionId: "sub-bank-missing-1",
        tender: "BANK",
        amountCents: reserveOrder.json.order.total_cents,
        currencyCode: reserveOrder.json.order.currency_code,
      }
    );
    assert(missing.status === 400 && missing.json?.code === "BANK_ACCOUNT_REQUIRED", "missing account");
    pass("missing-account-rejected");

    const wrongAmount = await httpJson(
      PORT,
      "POST",
      `/v1/orders/${reserveOrder.json.order.order_id}/settlements`,
      sessions.device,
      {
        submissionId: "sub-bank-amount-1",
        tender: "BANK",
        amountCents: reserveOrder.json.order.total_cents - 1,
        currencyCode: reserveOrder.json.order.currency_code,
        bankAccountId: ops.accountId,
      }
    );
    const wrongCurrency = await httpJson(
      PORT,
      "POST",
      `/v1/orders/${reserveOrder.json.order.order_id}/settlements`,
      sessions.device,
      {
        submissionId: "sub-bank-currency-1",
        tender: "BANK",
        amountCents: reserveOrder.json.order.total_cents,
        currencyCode: "USD",
        bankAccountId: ops.accountId,
      }
    );
    assert(wrongAmount.status === 400 && wrongAmount.json?.code === "AMOUNT_MISMATCH", "wrong amount");
    assert(wrongCurrency.status === 400 && wrongCurrency.json?.code === "CURRENCY_MISMATCH", "wrong currency");
    assert(settlementCount(reserveOrder.json.order.order_id) === 0, "rejected bank payment was stored");
    pass("wrong-amount-and-currency-rejected");

    const raceOrder = await httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale("sub-bank-order-race"));
    assert(raceOrder.status === 201, "race order");
    const raceId = raceOrder.json.order.order_id;
    const raceJobs = jobCount(raceId);
    const raceBefore = orderSnapshot(raceId);
    const raced = await Promise.all([
      runChild(raceScript, {
        PORT: String(PORT),
        PAY_PATH: `/v1/orders/${raceId}/settlements`,
        SESSION: sessions.device,
        SUBMISSION_ID: "sub-bank-race-cash",
        TENDER: "CASH",
        AMOUNT: String(raceOrder.json.order.total_cents),
        CURRENCY: raceOrder.json.order.currency_code,
        RESULT_PATH: path.join(tempRoot, "race-cash.json"),
      }),
      runChild(raceScript, {
        PORT: String(PORT),
        PAY_PATH: `/v1/orders/${raceId}/settlements`,
        SESSION: sessions.admin,
        SUBMISSION_ID: "sub-bank-race-bank",
        TENDER: "BANK",
        BANK_ACCOUNT_ID: ops.accountId,
        AMOUNT: String(raceOrder.json.order.total_cents),
        CURRENCY: raceOrder.json.order.currency_code,
        RESULT_PATH: path.join(tempRoot, "race-bank.json"),
      }),
    ]);
    assert(raced.filter((row) => row.created).length === 1, `race winners ${JSON.stringify(raced)}`);
    assert(raced.filter((row) => row.status === 409).length === 1, `race loser ${JSON.stringify(raced)}`);
    assert(settlementCount(raceId) === 1, "cash and bank both settled");
    assert(jobCount(raceId) === raceJobs, "race created a kitchen ticket");
    assert(JSON.stringify(orderSnapshot(raceId)) === JSON.stringify(raceBefore), "race changed the order");
    pass("cash-and-bank-cannot-double-pay");

    const storedSettlement = getDb()
      .prepare(`SELECT * FROM order_settlements WHERE order_id = ?`)
      .get(orderId);
    const deactivated = await httpJson(PORT, "PUT", `/v1/bank-accounts/${ops.accountId}`, sessions.admin, {
      displayName: ops.displayName,
      bankName: ops.bankName,
      accountType: "OPERATIONAL",
      maskedReference: ops.maskedReference,
      isActive: false,
    });
    assert(deactivated.status === 200 && deactivated.json.account.isActive === false, "deactivation");
    const deactivateAudit = getDb()
      .prepare(`SELECT action FROM audit_events WHERE entity_id = ? AND action = 'bank_account.deactivate'`)
      .get(ops.accountId);
    assert(deactivateAudit, "deactivation audit");
    const afterDeactivate = getDb().prepare(`SELECT * FROM order_settlements WHERE order_id = ?`).get(orderId);
    assert(JSON.stringify(afterDeactivate) === JSON.stringify(storedSettlement), "deactivation changed the payment");
    const stillPaid = await httpJson(PORT, "GET", payPath, sessions.device);
    assert(stillPaid.json.paymentStatus === "PAID", "historical bank payment unreadable");
    assert(stillPaid.json.settlement.bankAccountId === ops.accountId, "historical account link");
    assert(stillPaid.json.settlement.bankAccountLabel.includes("Main operating"), "historical label");
    assert(stillPaid.json.orderTotalCents === total && stillPaid.json.settlement.amountCents === total, "historical total");
    let removed = false;
    try {
      getDb().prepare(`DELETE FROM shop_bank_accounts WHERE account_id = ?`).run(ops.accountId);
      removed = true;
    } catch (err) {
      assert(/FOREIGN KEY/i.test(String(err.message || "")), "delete failed for another reason");
    }
    assert(!removed, "referenced account was deleted");
    const hidden = await httpJson(PORT, "GET", "/v1/bank-accounts", sessions.device);
    assert(!(hidden.json.accounts || []).some((account) => account.accountId === ops.accountId), "inactive account stayed selectable");
    pass("deactivation-preserves-payment");

    const cashRead = await httpJson(PORT, "GET", `/v1/orders/${cashId}/settlements`, sessions.device);
    assert(cashRead.json.paymentStatus === "PAID" && cashRead.json.settlement.tender === "CASH", "historical cash");
    assert(cashRead.json.settlement.bankAccountId == null, "historical cash account");
    assert(cashRead.json.orderTotalCents === cashOrder.json.order.total_cents, "historical cash total");
    pass("historical-cash-remains-readable");

    await closeServer(server);
    closeDatabase();
    openDatabase(config.dbPath);
    await runMigrations(getDb());
    server = createServer(config);
    await listen(server, config);
    const afterRestart = await httpJson(PORT, "POST", payPath, sessions.admin, payment);
    assert(afterRestart.status === 200 && afterRestart.json?.created === false, "restart retry");
    assert(afterRestart.json.settlement.settlementId === paid.json.settlement.settlementId, "restart created a payment");
    assert(settlementCount(orderId) === 1, "restart duplicated the bank payment");
    assert(JSON.stringify(orderSnapshot(orderId)) === JSON.stringify(before), "restart changed the order");
    pass("restart-retry");

    console.log(`bank payment ${results.length}`);
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
