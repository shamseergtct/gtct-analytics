/**
 * Cash payment screen and unpaid-order reads.
 * Temporary database only. Two processes settle the same order together.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createStaffUser } from "../services/staffUsers.js";
import { toPublicSettlementError } from "../services/settlements.js";
import { httpJson, openRoleSessions, TEST_ADMIN_PASSWORD } from "./testHttp.js";

const PORT = 18998;
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
    orderNumber: `PAY-${submissionId}`,
    submissionId,
    orderType: "TAKEAWAY",
    lines: [{ itemId: "item_orange_juice", quantity: 1 }],
  };
}

function snapshot(orderId) {
  return getDb()
    .prepare(
      `SELECT status, total_cents, tax_cents, goods_cents, updated_at
       FROM orders WHERE order_id = ?`
    )
    .get(orderId);
}

function jobs(orderId) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ?`).get(orderId).n;
}

function settlements(orderId) {
  return getDb().prepare(`SELECT COUNT(*) AS n FROM order_settlements WHERE order_id = ?`).get(orderId).n;
}

function runChild(scriptPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { cwd: root, env: { ...process.env, ...env } });
    let err = "";
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(fs.readFileSync(env.RESULT_PATH, "utf8")));
      } catch {
        reject(new Error(`payment child ${code}: ${err || "no result"}`));
      }
    });
  });
}

async function main() {
  const busy = toPublicSettlementError(
    Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
  );
  assert(busy.status === 409 && busy.code === "PAYMENT_IN_PROGRESS", "busy translation");
  assert(!/sqlite|locked|constraint/i.test(busy.message), "busy message leaked SQL");
  const constraint = toPublicSettlementError(
    Object.assign(new Error("SQLITE_CONSTRAINT: order_settlements.shop_id"), { code: "SQLITE_CONSTRAINT" })
  );
  assert(constraint.code === "PAYMENT_CONFLICT" && !/SQLITE|order_settlements/i.test(constraint.message), "constraint translation");
  pass("sqlite-errors-are-safe");

  const appJs = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  const confirmFn = appJs.slice(
    appJs.indexOf("async function confirmCashPayment"),
    appJs.indexOf("async function recoverUncertainPayment")
  );
  const recoverFn = appJs.slice(
    appJs.indexOf("async function recoverUncertainPayment"),
    appJs.indexOf("async function renewPaymentAttempt")
  );
  const renewFn = appJs.slice(
    appJs.indexOf("async function renewPaymentAttempt"),
    appJs.indexOf("async function refreshPendingCount")
  );
  assert(html.includes("Take Payment") && html.includes("Confirm Payment"), "payment actions");
  assert(html.includes("pending-payments-drawer"), "pending drawer");
  assert(html.includes("pending-search") && appJs.includes("orderMatchesPendingSearch"), "unpaid order search");
  assert(appJs.includes('permissions.includes("sales.payment.receive")'), "ui permission");
  assert(appJs.includes("gtct.cashSettlement."), "stable settlement id storage");
  assert(confirmFn.includes("state.payment.confirming) return"), "duplicate confirm blocked");
  assert(confirmFn.includes("paymentStatus === \"PAID\""), "paid only from server status");
  assert(!recoverFn.includes("newSubmissionId"), "uncertain result mints a new payment");
  assert(recoverFn.includes("readServerPayment"), "uncertain result checks the server");
  assert(renewFn.indexOf("readServerPayment") < renewFn.indexOf("clearPaymentAttempt"), "new confirmation waits for status");
  pass("payment-ui-contract");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-cash-ui-"));
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
  const server = createServer(config);
  await listen(server, config);

  const raceScript = path.join(tempRoot, "pay-race.mjs");
  fs.writeFileSync(
    raceScript,
    `import http from "node:http";
import fs from "node:fs";
const body = JSON.stringify({
  submissionId: process.env.SUBMISSION_ID,
  tender: "CASH",
  amountCents: Number(process.env.AMOUNT),
  currencyCode: process.env.CURRENCY,
});
const req = http.request({
  host: "127.0.0.1",
  port: Number(process.env.PORT),
  path: process.env.PAY_PATH,
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    Origin: "http://127.0.0.1:" + process.env.PORT,
    Cookie: "gtct_ls_session=" + encodeURIComponent(process.env.SESSION),
  },
}, (res) => {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => {
    fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({
      status: res.statusCode,
      json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    }));
  });
});
req.on("error", (err) => {
  fs.writeFileSync(process.env.RESULT_PATH, JSON.stringify({ status: 0, error: err.message }));
});
req.end(body);
`
  );

  try {
    const sessions = await openRoleSessions(PORT, config.testTenantId);
    const second = createStaffUser(
      config.testTenantId,
      {
        fullName: "Second Cashier",
        username: "cashier.pay.two",
        password: "Market-Cedar-24",
        confirmPassword: "Market-Cedar-24",
        role: "cashier",
        isActive: true,
        permissions: [],
      },
      { role: "admin", userId: sessions.adminUserId }
    );
    const secondLogin = await httpJson(
      PORT,
      "POST",
      "/v1/session/login",
      null,
      { username: "cashier.pay.two", password: "Market-Cedar-24" },
      { origin: true }
    );
    const secondCookie = /gtct_ls_session=([^;]+)/.exec(
      [].concat(secondLogin.headers["set-cookie"] || []).join("\n")
    );
    assert(second.userId && secondLogin.status === 200 && secondCookie, "second cashier");
    const cashierTwo = decodeURIComponent(secondCookie[1]);

    const created = await httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale("sub-ui-order-a1"));
    assert(created.status === 201, "order accepted");
    const order = created.json.order;
    const orderId = order.order_id;
    const before = snapshot(orderId);
    const jobsBefore = jobs(orderId);
    const statusPath = `/v1/orders/${encodeURIComponent(orderId)}/settlements`;
    const unpaid = await httpJson(PORT, "GET", statusPath, sessions.device);
    assert(unpaid.status === 200 && unpaid.json.paymentStatus === "UNPAID", "accepted order stays unpaid");
    assert(unpaid.json.orderNumber === order.order_number, "accepted order number");
    assert(unpaid.json.orderTotalCents === Number(order.total_cents), "server total");
    assert(unpaid.json.paidCents === 0 && unpaid.json.balanceCents === Number(order.total_cents), "full balance");
    assert(unpaid.json.settlement == null, "no settlement yet");
    assert(!getDb().prepare(`SELECT order_id FROM order_payment_balances WHERE order_id = ?`).get(orderId), "missing balance invented a row");
    pass("accepted-order-unpaid");

    const pending = await httpJson(PORT, "GET", "/v1/pending-payments", sessions.device);
    assert(pending.status === 200 && pending.json.orders.some((row) => row.orderId === orderId), "pending includes the order");
    pass("take-payment-reads-accepted-order");

    const anon = await httpJson(PORT, "GET", "/v1/pending-payments", null);
    assert(anon.status === 401, "anonymous pending list");
    const payment = {
      submissionId: "sub-ui-pay-aaa1",
      tender: "CASH",
      amountCents: unpaid.json.balanceCents,
      currencyCode: unpaid.json.currencyCode,
    };
    const paid = await httpJson(PORT, "POST", statusPath, sessions.device, payment);
    assert(paid.status === 201 && paid.json.paymentStatus === "PAID", "cash payment");
    assert(paid.json.balance.balanceCents === 0 && paid.json.balance.paidCents === payment.amountCents, "paid balance");
    const after = await httpJson(PORT, "GET", statusPath, sessions.device);
    assert(after.json.paymentStatus === "PAID" && after.json.settlement.tender === "CASH", "status read after payment");
    assert(JSON.stringify(snapshot(orderId)) === JSON.stringify(before), "payment changed the order");
    assert(jobs(orderId) === jobsBefore, "payment created a ticket");
    pass("full-cash-payment");

    const again = await httpJson(PORT, "POST", statusPath, sessions.device, {
      ...payment,
      submissionId: "sub-ui-pay-bbb2",
    });
    assert(again.status === 409 && again.json.code === "ALREADY_PAID", "second payment");
    assert(!/SQLITE|constraint/i.test(JSON.stringify(again.json)), "second payment leaked SQL");
    assert(settlements(orderId) === 1, "second payment stored");
    pass("already-paid-once");

    const retry = await httpJson(PORT, "POST", statusPath, sessions.device, payment);
    assert(retry.status === 200 && retry.json.created === false, "same submission retry");
    assert(retry.json.settlement.settlementId === paid.json.settlement.settlementId, "retry settlement");
    assert(settlements(orderId) === 1, "retry stored another payment");
    pass("same-submission-and-network-recovery");

    const other = await httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale("sub-ui-order-b2"));
    assert(other.status === 201, "second order");
    const otherId = other.json.order.order_id;
    const raced = await Promise.all([
      runChild(raceScript, {
        PORT: String(PORT),
        PAY_PATH: `/v1/orders/${encodeURIComponent(otherId)}/settlements`,
        SESSION: sessions.device,
        SUBMISSION_ID: "sub-ui-race-a1",
        AMOUNT: String(other.json.order.total_cents),
        CURRENCY: other.json.order.currency_code,
        RESULT_PATH: path.join(tempRoot, "race-a.json"),
      }),
      runChild(raceScript, {
        PORT: String(PORT),
        PAY_PATH: `/v1/orders/${encodeURIComponent(otherId)}/settlements`,
        SESSION: cashierTwo,
        SUBMISSION_ID: "sub-ui-race-b2",
        AMOUNT: String(other.json.order.total_cents),
        CURRENCY: other.json.order.currency_code,
        RESULT_PATH: path.join(tempRoot, "race-b.json"),
      }),
    ]);
    assert(raced.filter((row) => row.status === 201).length === 1, `race winners ${JSON.stringify(raced.map((row) => row.status))}`);
    assert(raced.some((row) => row.status === 409 && row.json?.code === "ALREADY_PAID"), "race loser");
    assert(settlements(otherId) === 1, "two cashiers stored two payments");
    pass("concurrent-cashiers");

    const left = await httpJson(PORT, "GET", "/v1/pending-payments", sessions.admin);
    assert(!left.json.orders.some((row) => row.orderId === orderId || row.orderId === otherId), "paid orders stayed pending");
    const source = getDb().prepare(`SELECT * FROM orders WHERE order_id = ?`).get(orderId);
    const columns = Object.keys(source);
    const foreignId = `ord_foreign_ui_${Date.now()}`;
    const copy = { ...source, order_id: foreignId, tenant_id: "other-shop", order_number: `OTHER-UI-${Date.now()}` };
    getDb()
      .prepare(`INSERT INTO orders (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...columns.map((column) => copy[column]));
    const hidden = await httpJson(PORT, "GET", `/v1/orders/${foreignId}/settlements`, sessions.admin);
    assert(hidden.status === 404 && hidden.json.code === "ORDER_NOT_FOUND", "other shop");
    assert(!left.json.orders.some((row) => row.orderId === foreignId), "other shop listed");
    pass("pending-list-and-shop-scope");

    getDb()
      .prepare(
        `UPDATE staff_role_permissions
         SET revoked_at = ?
         WHERE role_id = 'role_cashier' AND permission_code = 'sales.payment.receive' AND revoked_at IS NULL`
      )
      .run(new Date().toISOString());
    const fresh = await httpJson(PORT, "POST", "/v1/test-orders", sessions.admin, sale("sub-ui-order-c3"));
    const denied = await httpJson(
      PORT,
      "POST",
      `/v1/orders/${fresh.json.order.order_id}/settlements`,
      sessions.device,
      {
        submissionId: "sub-ui-deny-01",
        tender: "CASH",
        amountCents: fresh.json.order.total_cents,
        currencyCode: fresh.json.order.currency_code,
      }
    );
    const deniedList = await httpJson(PORT, "GET", "/v1/pending-payments", sessions.device);
    assert(denied.status === 403 && deniedList.status === 403, "cashier permission");
    assert(settlements(fresh.json.order.order_id) === 0, "forbidden payment stored");
    const adminList = await httpJson(PORT, "GET", "/v1/pending-payments", sessions.admin);
    assert(adminList.status === 200 && adminList.json.orders.some((row) => row.orderId === fresh.json.order.order_id), "admin pending list");
    pass("cashier-permission");

    console.log(`cash payment ui ${results.length}`);
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
