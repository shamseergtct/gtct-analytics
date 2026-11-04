/**
 * P2-E1.3 — isolated TEST-only order-register token search regression.
 * Creates a disposable SQLite DB and HTTP listener. No live database or
 * production mode can be accessed; no money/settlement actions are executed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, getDb, closeDatabase } from "../db/db.js";
import { initLogger } from "../util/logger.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createServer } from "../http/server.js";
import { httpJson, openRoleSessions } from "./testHttp.js";

const PORT = 19043;
let passed = 0;
function check(condition, name) {
  if (!condition) throw new Error(`FAIL ${name}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-token-search-test-"));
  process.env.GTCT_LOCAL_DATA_DIR = temp;
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = String(PORT);
  for (const k of [
    "GTCT_TLS_CERT_FILE", "GTCT_TLS_KEY_FILE", "GTCT_ALLOW_LAN_BIND",
    "GTCT_ENABLE_LAN_LISTENER", "GTCT_LAN_BIND_ADDRESS",
    "GTCT_ENABLE_PHYSICAL_PRINT", "GTCT_LOCAL_OPERATING_MODE",
    "GTCT_TEST_BACKUP_DIR", "GTCT_ENABLE_TEST_AUTO_BACKUP",
  ]) delete process.env[k];
  const config = loadConfig({ mode: "http" });
  check(config.operatingMode === "TEST" && config.loopback && !config.physicalPrintEnabled &&
    path.resolve(config.dbPath).startsWith(path.resolve(temp) + path.sep), "disposable-test-only");
  ensureDataDirs(config);
  initLogger(config.logDir);
  let server;
  try {
    openDatabase(config.dbPath);
    await runMigrations(getDb());
    seedSampleData(config);
    server = createServer(config);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
    const { admin, device } = await openRoleSessions(PORT, config.testTenantId);
    const unauth = await httpJson(PORT, "GET", "/v1/order-register?q=001");
    check(unauth.status === 401, "authentication-preserved");

    async function createOrder(number, submission) {
      const result = await httpJson(PORT, "POST", "/v1/test-orders", device, {
        orderNumber: number,
        submissionId: submission,
        orderType: "TAKEAWAY",
        lines: [{ itemId: "item_orange_juice", quantity: 1 }],
      });
      if (result.status !== 201) throw new Error(`Create ${number}: ${result.json?.error}`);
      return result.json.order;
    }
    async function find(q, more = "") {
      const result = await httpJson(PORT, "GET",
        `/v1/order-register?q=${encodeURIComponent(q)}${more}`, admin);
      if (result.status !== 200) throw new Error(`Search ${q}: ${result.json?.error}`);
      return result.json.orders;
    }
    const a = await createOrder("TOKEN-SEARCH-A", "token-search-a");
    const b = await createOrder("TOKEN-SEARCH-B", "token-search-b");
    check(a.token_number === 1 && b.token_number === 2, "token-001-and-002-issued");
    check((await find("001")).some(row => row.orderId === a.order_id),
      "padded-bare-001-finds-token-1");
    check((await find("Token 001")).map(row => row.orderId).join() === a.order_id,
      "explicit-token-001-exact");
    check((await find("token #002")).map(row => row.orderId).join() === b.order_id,
      "token-hash-syntax");
    check((await find("#001")).map(row => row.orderId).join() === a.order_id,
      "hash-prefix-syntax");
    check((await find("Token 999")).length === 0,
      "unknown-token-does-not-match");
    check((await find("TOKEN-SEARCH-B")).map(row => row.orderId).join() === b.order_id,
      "existing-invoice-search-preserved");
    check((await find("Token 000")).length === 0,
      "invalid-zero-token-rejected");
    const active = (await httpJson(PORT, "GET", "/v1/business-shift", admin)).json.active;
    const closed = await httpJson(PORT, "POST", "/v1/business-shift/close", admin,
      { shiftId: active.shiftId, confirm: true });
    if (closed.status !== 200) throw new Error(closed.json?.error || "Close shift failed");
    const next = await httpJson(PORT, "POST", "/v1/business-shift/open", admin,
      { businessDate: active.businessDate });
    if (next.status !== 201) throw new Error(next.json?.error || "Open shift failed");
    const c = await createOrder("TOKEN-SEARCH-C", "token-search-c");
    const repeated = await find("Token 001");
    check(c.token_number === 1 && c.business_shift_id !== a.business_shift_id &&
      repeated.length === 2 && repeated.some(row => row.orderId === a.order_id) &&
      repeated.some(row => row.orderId === c.order_id),
    "tokens-repeat-across-shifts-without-hiding-orders");
    const byDate = await find("Token 001", `&date=${active.businessDate}`);
    check(byDate.length === 2, "business-date-filter-still-supported");
    const totals = getDb().prepare("SELECT COUNT(*) AS n FROM order_settlements").get();
    check(totals.n === 0, "no-settlement-writes");
    const htmlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
      "../../public/orders.html");
    check(fs.readFileSync(htmlPath, "utf8").includes("Search invoice, token, customer"),
      "ui-search-label-includes-token");
    console.log(`Token search ${passed} passed (temporary TEST SQLite only, no financial changes)`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    closeDatabase();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
