/**
 * Two different sales in the same second must stay two orders.
 * The same submission retries as one order. Temporary database only.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createStaffUser } from "../services/staffUsers.js";
import { httpJson, openRoleSessions, TEST_ADMIN_PASSWORD, TEST_ADMIN_USERNAME } from "./testHttp.js";

const PORT = 18993;
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
    server.listen(config.port, config.host, (err) => (err ? reject(err) : resolve()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function cookieFrom(res) {
  const raw = res.headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const match = /gtct_ls_session=([^;]+)/.exec(joined);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function rawPost(port, session, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/test-orders",
        method: "POST",
        agent: false,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Origin: `http://127.0.0.1:${port}`,
          Cookie: `gtct_ls_session=${encodeURIComponent(session)}`,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function sale(orderNumber, submissionId, extra = {}) {
  return {
    orderNumber,
    submissionId,
    orderType: "TAKEAWAY",
    lines: [{ itemId: "item_orange_juice", quantity: 1 }],
    ...extra,
  };
}

async function login(port, username, password) {
  const res = await httpJson(
    port,
    "POST",
    "/v1/session/login",
    null,
    { username, password },
    { origin: true }
  );
  const cookie = cookieFrom(res);
  assert(res.status === 200 && cookie, `${username} login`);
  return cookie;
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-order-identity-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = String(PORT);
  delete process.env.GTCT_TLS_CERT_FILE;
  delete process.env.GTCT_TLS_KEY_FILE;
  delete process.env.GTCT_ALLOW_LAN_BIND;
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
  const sharedNumber = "TEST-UI-20261024-120000";

  try {
    const sessions = await openRoleSessions(PORT, config.testTenantId);
    const second = createStaffUser(
      config.testTenantId,
      {
        fullName: "Second Cashier",
        username: "lane.two",
        password: "Market-Cedar-23",
        confirmPassword: "Market-Cedar-23",
        role: "cashier",
      },
      { role: "admin", userId: sessions.adminUserId }
    );
    const laneTwo = await login(PORT, "lane.two", "Market-Cedar-23");
    const numbers = await Promise.all([
      httpJson(PORT, "POST", "/v1/order-numbers", sessions.device, {}),
      httpJson(PORT, "POST", "/v1/order-numbers", laneTwo, {}),
    ]);
    assert(numbers.every((res) => res.status === 200), "number allocation");
    assert(
      numbers[0].json.orderNumber === numbers[1].json.orderNumber &&
        numbers[0].json.orderNumber === "TEST-UI-000001",
      "both terminals do not share the next number"
    );
    pass("shared-next-number");

    const [first, secondSale] = await Promise.all([
      httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale(sharedNumber, "sub-same-second-a")),
      httpJson(PORT, "POST", "/v1/test-orders", laneTwo, sale(sharedNumber, "sub-same-second-b")),
    ]);
    assert(first.status === 201 && secondSale.status === 201, "both sales accepted");
    assert(first.json.created && secondSale.json.created, "both sales are new");
    assert(first.json.order.order_id !== secondSale.json.order.order_id, "distinct order ids");
    assert(first.json.order.order_number !== secondSale.json.order.order_number, "distinct order numbers");
    const stored = getDb()
      .prepare(`SELECT order_id, order_number, created_by_user_id FROM orders WHERE submission_id IN (?, ?)`)
      .all("sub-same-second-a", "sub-same-second-b");
    assert(stored.length === 2, "two sqlite rows");
    assert(new Set(stored.map((row) => row.order_number)).size === 2, "sqlite numbers differ");
    assert(
      stored.some((row) => row.created_by_user_id === sessions.cashierUserId),
      "first cashier recorded"
    );
    assert(stored.some((row) => row.created_by_user_id === second.userId), "second cashier recorded");
    const jobsFor = (orderId) =>
      getDb().prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ?`).get(orderId).n;
    assert(jobsFor(first.json.order.order_id) > 0 && jobsFor(secondSale.json.order.order_id) > 0, "each order has tickets");
    pass("same-second-different-orders");

    const [seqA, seqB] = await Promise.all([
      httpJson(PORT, "POST", "/v1/test-orders", sessions.device, sale("TEST-UI-000016", "sub-seq-a")),
      httpJson(PORT, "POST", "/v1/test-orders", laneTwo, sale("TEST-UI-000018", "sub-seq-b")),
    ]);
    assert(seqA.status === 201 && seqB.status === 201, "sequential sales were not both accepted");
    const seqNumbers = [seqA.json.order.order_number, seqB.json.order.order_number].sort();
    assert(
      seqNumbers[0] === "TEST-UI-000002" && seqNumbers[1] === "TEST-UI-000003",
      "stale draft numbers were accepted out of order"
    );
    const seqRetry = await httpJson(
      PORT,
      "POST",
      "/v1/test-orders",
      sessions.device,
      sale("TEST-UI-000099", "sub-seq-a")
    );
    assert(
      seqRetry.status === 200 && seqRetry.json.created === false && seqRetry.json.order.order_id === seqA.json.order.order_id,
      "retry of a sequential sale created another order"
    );
    const nextPeek = await httpJson(PORT, "POST", "/v1/order-numbers", sessions.device, {});
    assert(nextPeek.status === 200 && nextPeek.json.orderNumber === "TEST-UI-000004", "next number did not advance by one");
    pass("one-by-one-numbers");

    const retryBody = sale(first.json.order.order_number, "sub-same-second-a");
    const beforeJobs = jobsFor(first.json.order.order_id);
    const beforeAudits = getDb().prepare(`SELECT COUNT(*) AS n FROM audit_events`).get().n;
    const retry = await httpJson(PORT, "POST", "/v1/test-orders", sessions.device, retryBody);
    assert(retry.status === 200 && retry.json.created === false, "retry created another sale");
    assert(retry.json.order.order_id === first.json.order.order_id, "retry returned a different order");
    assert(retry.json.order.order_number === first.json.order.order_number, "retry changed the order number");
    assert(jobsFor(first.json.order.order_id) === beforeJobs, "retry added kitchen jobs");
    assert(getDb().prepare(`SELECT COUNT(*) AS n FROM audit_events`).get().n === beforeAudits, "retry added an audit");
    pass("same-key-retry");

    const overlapped = await Promise.all(
      Array.from({ length: 8 }, () =>
        httpJson(PORT, "POST", "/v1/test-orders", sessions.device, retryBody)
      )
    );
    assert(overlapped.every((res) => res.status === 200 && res.json.created === false), "overlapped retry was a new sale");
    assert(new Set(overlapped.map((res) => res.json.order.order_id)).size === 1, "overlapped retries split the order");
    assert(jobsFor(first.json.order.order_id) === beforeJobs, "overlapped retries added jobs");
    pass("overlapped-same-submission");

    const conflict = await httpJson(
      PORT,
      "POST",
      "/v1/test-orders",
      sessions.device,
      sale(sharedNumber, "sub-same-second-a", {
        lines: [{ itemId: "item_orange_juice", quantity: 3 }],
      })
    );
    assert(conflict.status === 409 && conflict.json?.code === "SUBMISSION_CONFLICT", "conflict was treated as success");
    assert(jobsFor(first.json.order.order_id) === beforeJobs, "conflict added jobs");
    assert(
      getDb().prepare(`SELECT quantity FROM order_lines WHERE order_id = ?`).get(first.json.order.order_id).quantity === 1,
      "conflict changed the saved quantity"
    );
    pass("conflicting-payload");

    const beforeMissing = getDb().prepare(`SELECT COUNT(*) AS n FROM orders`).get().n;
    const missing = await rawPost(PORT, sessions.admin, {
      orderNumber: "MISSING-SUBMISSION",
      orderType: "TAKEAWAY",
      lines: [{ itemId: "item_chicken_shawarma", quantity: 1 }],
    });
    const afterMissing = getDb().prepare(`SELECT COUNT(*) AS n FROM orders`).get().n;
    assert(missing.status === 400 && missing.json?.code === "SUBMISSION_REQUIRED", "missing submission id was accepted");
    assert(afterMissing === beforeMissing, "missing submission id created an order");
    pass("missing-submission-rejected");

    const historical = await httpJson(
      PORT,
      "POST",
      "/v1/test-orders",
      sessions.admin,
      sale("HIST-0001", "sub-historical-0001")
    );
    assert(historical.status === 201, "historical fixture was not created");
    const historicalId = historical.json.order.order_id;
    getDb()
      .prepare(
        `UPDATE orders SET submission_id = NULL, submission_fingerprint = NULL WHERE order_id = ?`
      )
      .run(historicalId);
    const read = await httpJson(PORT, "GET", `/v1/orders/${encodeURIComponent(historicalId)}`, sessions.admin);
    assert(read.status === 200 && read.json.order.order_number === "HIST-0001", "historical order is not readable");
    assert(read.json.order.submission_id == null, "historical submission id was rewritten");
    const reuse = await httpJson(
      PORT,
      "POST",
      "/v1/test-orders",
      sessions.admin,
      sale("HIST-0001", "sub-historical-new2")
    );
    assert(reuse.status === 409 && reuse.json?.code === "ORDER_NUMBER_USED", "historical number was reused as a new sale");
    const historicalRow = getDb()
      .prepare(`SELECT order_number, submission_id FROM orders WHERE order_id = ?`)
      .get(historicalId);
    assert(historicalRow.order_number === "HIST-0001" && historicalRow.submission_id == null, "historical order was rewritten");
    const copies = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM orders WHERE order_number = 'HIST-0001'`)
      .get().n;
    assert(copies === 1, "historical number was duplicated");
    pass("historical-order-remains");
  } finally {
    await closeServer(server);
    closeDatabase();
  }

  openDatabase(config.dbPath);
  await runMigrations(getDb());
  const restarted = createServer(config);
  await listen(restarted, config);
  try {
    const admin = await login(PORT, TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);
    const again = await httpJson(PORT, "POST", "/v1/test-orders", admin, sale(sharedNumber, "sub-same-second-a"));
    assert(again.status === 200 && again.json.created === false, "restart retry created a second order");
    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM orders WHERE submission_id = ?`)
      .get("sub-same-second-a").n;
    assert(count === 1, "restart duplicated the order");
    pass("restart-and-retry");
  } finally {
    await closeServer(restarted);
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const appJs = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../../public/app.js"), "utf8");
  assert(appJs.includes("submissionId: state.submissionId"), "cart submit omits the draft id");
  assert(appJs.includes("res.json.order?.order_number"), "success ignores the accepted order number");
  assert(appJs.includes("SUBMISSION_CONFLICT"), "conflict response is not handled");
  const sendStart = appJs.indexOf('api("/v1/test-orders"');
  const rejected = appJs.slice(sendStart, appJs.indexOf("const sentOrderNumber", sendStart));
  assert(rejected.includes("res.status === 401"), "authorization failure is not handled");
  assert(
    rejected.includes("This sign-in is no longer valid") && rejected.includes("persistActiveCart()"),
    "authorization failure does not keep the cart"
  );
  assert(!rejected.includes("newSubmissionId(") && !rejected.includes("prepareNextOrderAfterDispatch"), "rejection starts another submission");
  assert(appJs.includes("void syncDraftNumber()"), "adding an item does not refresh the next number");
  assert(appJs.includes("nextValue < currentValue"), "a confirmed number can be shown again");
  assert(appJs.includes("watchReviewNumber"), "an open review does not follow the next number");
  const salesPage = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../../public/index.html"), "utf8");
  assert(salesPage.includes("Draft #"), "draft number is labeled as a confirmed order");
  pass("sales-draft-identity");

  console.log(`order identity ${results.length} passed`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
