/**
 * P2-B2.1 Kitchen document navigation/authorization regression.
 * Uses disposable TEST SQLite + localhost only. Never uses live restaurant data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, closeDatabase } from "../db/db.js";
import { initLogger } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { httpJson, openRoleSessions } from "./testHttp.js";

const PORT = 19017;
let count = 0;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const pass = (name) => { count += 1; console.log(`PASS ${name}`); };
function cookieFrom(response) {
  const header = response.headers["set-cookie"] || [];
  const str = Array.isArray(header) ? header.join(";") : String(header);
  const match = /gtct_ls_session=([^;]+)/.exec(str);
  return match ? decodeURIComponent(match[1]) : "";
}
async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-kitchen-nav-"));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = String(PORT);
  delete process.env.GTCT_TLS_CERT_FILE;
  delete process.env.GTCT_TLS_KEY_FILE;
  delete process.env.GTCT_ALLOW_LAN_BIND;
  delete process.env.GTCT_ENABLE_LAN_LISTENER;
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  const config = loadConfig({ mode: "http" });
  assert(config.operatingMode === "TEST" && config.loopback === true &&
    config.physicalPrintEnabled === false && config.dbPath.startsWith(tempRoot), "TEST/SQLite isolation guard");
  ensureDataDirs(config);
  initLogger(config.logDir);
  const db = openDatabase(config.dbPath);
  let server;
  try {
    await runMigrations(db);
    seedSampleData(config);
    server = createServer(config);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve);
    });
    pass("temporary-test-database-only");

    const unauth = await httpJson(PORT, "GET", "/");
    assert(unauth.status === 200 && unauth.json.raw?.includes('id="login-view"'), "unauthenticated login page broken");
    pass("unauthenticated-login-remains-available");

    const sessions = await openRoleSessions(PORT, config.testTenantId);
    for (const [name, cookie] of [["admin", sessions.admin], ["cashier", sessions.device]]) {
      const rootPage = await httpJson(PORT, "GET", "/", cookie);
      assert(rootPage.status === 200 && rootPage.json.raw?.includes("Restaurant Sales"), `${name} sales page broken`);
      const orderPage = await httpJson(PORT, "GET", "/orders.html", cookie);
      assert(orderPage.status === 200, `${name} orders page broken`);
    }
    pass("admin-and-cashier-ui-unchanged");

    const kitchen = await httpJson(PORT, "POST", "/v1/staff-users", sessions.admin, {
      fullName: "Kitchen Navigation", username: "kitchen.nav",
      password: "Nav-Kitchen-247", confirmPassword: "Nav-Kitchen-247",
      role: "kitchen", isActive: true, permissions: [], stationIds: ["station_juice"],
    });
    assert(kitchen.status === 201, kitchen.json?.error || "kitchen user create failed");
    const loggedIn = await httpJson(PORT, "POST", "/v1/session/login", null,
      { username: "kitchen.nav", password: "Nav-Kitchen-247" }, { origin: true });
    assert(loggedIn.status === 200, loggedIn.json?.error || "kitchen login failed");
    const cookie = cookieFrom(loggedIn);
    assert(cookie, "kitchen session cookie missing");
    const me = await httpJson(PORT, "GET", "/v1/session/me", cookie);
    assert(me.status === 200 && me.json.role === "kitchen", "kitchen identity mismatch");
    pass("kitchen-staff-login");

    for (const page of ["/", "/index.html", "/orders.html", "/users.html", "/menu.html", "/shop-settings.html", "/settings.html"]) {
      const result = await httpJson(PORT, "GET", page, cookie);
      assert(result.status === 302 && result.headers.location === "/prep.html", `Kitchen page ${page} not redirected (${result.status})`);
      assert(result.headers["cache-control"] === "no-store", `Kitchen redirect cacheable: ${page}`);
    }
    pass("all-non-preparation-html-pages-redirect");

    const prep = await httpJson(PORT, "GET", "/prep.html", cookie);
    assert(prep.status === 200 && prep.json.raw?.includes("Preparation"), "preparation page unavailable");
    const board = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", cookie);
    assert(board.status === 200 && board.json.station?.stationId === "station_juice", "assigned station blocked");
    pass("preparation-page-and-assigned-station-allowed");

    for (const route of ["/v1/config", "/v1/order-register", "/v1/menu-items"]) {
      const result = await httpJson(PORT, "GET", route, cookie);
      assert(result.status === 403, `Kitchen gained sales API ${route}`);
    }
    const submit = await httpJson(PORT, "POST", "/v1/test-orders", cookie,
      { orderType: "TAKEAWAY", lines: [] });
    assert(submit.status === 403, "Kitchen can submit test order");
    pass("sales-apis-remain-denied-server-side");

    const appSource = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
    assert(appSource.includes('window.location.replace("/prep.html")') &&
      appSource.includes("if (redirectKitchenToPreparation()) return false;") &&
      appSource.includes("if (redirectKitchenToPreparation()) return;"),
    "Kitchen initial session/login redirect missing");
    pass("client-redirect-before-pos-bootstrap-contract");
    console.log(`Kitchen navigation ${count} passed (temporary SQLite only, real sales disabled)`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
