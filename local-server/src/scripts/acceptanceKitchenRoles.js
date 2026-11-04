/**
 * P2-B2 kitchen role/station access, temporary SQLite only.
 * No live files, production vault, physical printer, or real orders touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { httpJson, openRoleSessions } from "./testHttp.js";

const PORT = 19016;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const results = [];
function assert(condition, message) { if (!condition) throw new Error(message); }
function pass(name) { results.push(name); console.log(`PASS ${name}`); }
function cookieFrom(res) {
  const header = res.headers["set-cookie"] || [];
  const combined = Array.isArray(header) ? header.join(";") : String(header);
  const match = combined.match(/gtct_ls_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}
async function login(username, password) {
  const res = await httpJson(PORT, "POST", "/v1/session/login", null, { username, password }, { origin: true });
  assert(res.status === 200, res.json?.error || "login failed");
  const cookie = cookieFrom(res);
  assert(cookie, "no session cookie");
  return cookie;
}
function listen(server, config) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
}
const readOrder = (orderId) => getDb().prepare(
  `SELECT total_cents, tax_cents, goods_cents, status FROM orders WHERE order_id = ?`
).get(orderId);
async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-kitchen-role-"));
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
  assert(config.host === "127.0.0.1" && config.physicalPrintEnabled === false && config.operatingMode === "TEST", "isolated TEST guard");
  ensureDataDirs(config);
  initLogger(config.logDir);
  const db = openDatabase(config.dbPath);
  let server = null;
  try {
    await runMigrations(db);
    seedSampleData(config);
    const kitchenRole = db.prepare(`SELECT role_id FROM staff_roles WHERE role_id = 'role_kitchen'`).get();
    const kitchenPerms = db.prepare(`SELECT permission_code FROM staff_role_permissions WHERE role_id = 'role_kitchen' AND revoked_at IS NULL`).all();
    assert(kitchenRole && kitchenPerms.length === 1 && kitchenPerms[0].permission_code === "prep.station.work", "only prep work granted");
    assert(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='staff_station_assignments'`).get(), "assignments table missing");
    pass("kitchen-role-migration");

    server = createServer(config);
    await listen(server, config);
    const sessions = await openRoleSessions(PORT, config.testTenantId);
    const stations = await httpJson(PORT, "GET", "/v1/staff-users/stations", sessions.admin);
    assert(stations.status === 200 && stations.json.stations.some((s) => s.stationId === "station_juice"), "admin station catalog");
    assert(!stations.json.stations.some((s) => s.stationId === "station_cashier"), "cashier excluded");
    assert((await httpJson(PORT, "GET", "/v1/staff-users/stations", sessions.device)).status === 403, "cashier station catalog denied");
    pass("admin-only-station-catalog");

    const credentials = { fullName: "Juice Prep", username: "prep.juice", password: "Juice-Prep-247", confirmPassword: "Juice-Prep-247", role: "kitchen", isActive: true, permissions: [] };
    for (const [name, patch] of [
      ["no-station", { stationIds: [] }],
      ["unknown", { stationIds: ["station_unknown"] }],
      ["cashier-station", { stationIds: ["station_cashier"] }],
      ["duplicates", { stationIds: ["station_juice", "station_juice"] }],
      ["sales-grant", { stationIds: ["station_juice"], permissions: ["sales.price_override"] }],
    ]) {
      const res = await httpJson(PORT, "POST", "/v1/staff-users", sessions.admin,
        { ...credentials, username: `bad.${name}`, ...patch });
      assert(res.status === 400, `unsafe staff user accepted: ${name}`);
    }
    const cashierCreate = await httpJson(PORT, "POST", "/v1/staff-users", sessions.device,
      { ...credentials, stationIds: ["station_juice"] });
    assert(cashierCreate.status === 403, "cashier cannot create kitchen user");
    pass("invalid-assignments-rejected");

    const add = await httpJson(PORT, "POST", "/v1/staff-users", sessions.admin,
      { ...credentials, stationIds: ["station_juice"] });
    assert(add.status === 201 && add.json.user.role === "kitchen" && add.json.user.stationIds.join() === "station_juice", add.json?.error || "create kitchen");
    const kitchenId = add.json.user.userId;
    const freshList = await httpJson(PORT, "GET", "/v1/staff-users", sessions.admin);
    assert(freshList.json.users.find((u) => u.userId === kitchenId)?.stationIds.join() === "station_juice", "staff list assignments");
    assert(!JSON.stringify(freshList.json).includes("scrypt$"), "password hash not disclosed");
    const juiceSession = await login("prep.juice", "Juice-Prep-247");
    const me = await httpJson(PORT, "GET", "/v1/session/me", juiceSession);
    assert(me.status === 200 && me.json.role === "kitchen" && me.json.permissions.join() === "prep.station.work", "kitchen login permissions");
    pass("kitchen-login-least-privilege");

    const unauthorizedPaths = ["/v1/staff-users", "/v1/staff-users/stations", "/v1/config", "/v1/order-register"];
    for (const route of unauthorizedPaths) {
      const res = await httpJson(PORT, "GET", route, juiceSession);
      assert(res.status === 403, `kitchen could read ${route}: ${res.status}`);
    }
    const badSales = await httpJson(PORT, "POST", "/v1/test-orders", juiceSession, { orderType: "TAKEAWAY", lines: [] });
    assert(badSales.status === 403, "kitchen sales access denied");
    pass("sales-and-admin-apis-denied");

    const order = await httpJson(PORT, "POST", "/v1/test-orders", sessions.admin, {
      orderNumber: "KITCHEN-P2B2-1", orderType: "TAKEAWAY",
      lines: [{ itemId: "item_orange_juice", quantity: 1, instructions: ["Less Sugar"] }],
    });
    assert(order.status === 201, order.json?.error || "could not seed test order");
    const orderId = order.json.order.order_id;
    const before = readOrder(orderId);
    const board = await httpJson(PORT, "GET", "/v1/prep-board", juiceSession);
    assert(board.status === 200 && board.json.stations.length === 1, "only assigned station visible");
    assert(board.json.station.stationId === "station_juice" && board.json.tickets.some((t) => t.orderId === orderId), "assigned station default");
    const forbidden = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_grill", juiceSession);
    assert(forbidden.status === 403, "other station board protected");
    pass("station-board-scoped");

    const ticket = board.json.tickets.find((t) => t.orderId === orderId);
    const action = { orderId, stationId: "station_juice", expectedStatus: ticket.status, expectedRevision: ticket.revision };
    const badAction = await httpJson(PORT, "POST", "/v1/prep-board/accept", juiceSession,
      { ...action, stationId: "station_grill" });
    assert(badAction.status === 403, "other station action denied");
    const accepted = await httpJson(PORT, "POST", "/v1/prep-board/accept", juiceSession, action);
    assert(accepted.status === 200 && accepted.json.status === "ACCEPTED", accepted.json?.error || "assigned station accept");
    const stale = await httpJson(PORT, "POST", "/v1/prep-board/accept", juiceSession, action);
    assert(stale.status === 409, "stale transition rejected");
    assert(JSON.stringify(before) === JSON.stringify(readOrder(orderId)), "order totals altered by prep action");
    pass("station-write-scope-and-prep-revision");

    const second = await httpJson(PORT, "POST", "/v1/staff-users", sessions.admin, {
      fullName: "Multi Station Prep", username: "prep.multi", password: "Other-Prep-291", confirmPassword: "Other-Prep-291",
      role: "kitchen", isActive: true, permissions: [], stationIds: ["station_shawarma", "station_grill"],
    });
    assert(second.status === 201, "multi station create");
    const multiSession = await login("prep.multi", "Other-Prep-291");
    const multiBoard = await httpJson(PORT, "GET", "/v1/prep-board", multiSession);
    assert(multiBoard.status === 200 && multiBoard.json.stations.length === 2, "multiple assigned stations");
    assert(!multiBoard.json.stations.some((s) => s.stationId === "station_juice"), "juices hidden");
    assert((await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", multiSession)).status === 403, "multi worker other station denied");
    pass("multiple-stations-assigned");

    const reassigned = await httpJson(PORT, "PATCH", `/v1/staff-users/${kitchenId}`, sessions.admin,
      { stationIds: ["station_grill"] });
    assert(reassigned.status === 200 && reassigned.json.user.stationIds.join() === "station_grill", "station reassignment");
    assert((await httpJson(PORT, "GET", "/v1/session/me", juiceSession)).status === 401, "station change revoked old session");
    const newSession = await login("prep.juice", "Juice-Prep-247");
    assert((await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", newSession)).status === 403, "old station restricted");
    assert((await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_grill", newSession)).status === 200, "new station permitted");
    pass("station-reassignment-revokes-session");

    const madeCashier = await httpJson(PORT, "PATCH", `/v1/staff-users/${kitchenId}`, sessions.admin,
      { role: "cashier", stationIds: [] });
    assert(madeCashier.status === 200 && madeCashier.json.user.stationIds.length === 0, "role change cleared assignments");
    assert((await httpJson(PORT, "GET", "/v1/session/me", newSession)).status === 401, "role change session revoked");
    const cashierAfter = await login("prep.juice", "Juice-Prep-247");
    assert((await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_shawarma", cashierAfter)).status === 200, "existing cashier prep rights retained");
    pass("role-change-session-revocation");

    const madeKitchen = await httpJson(PORT, "PATCH", `/v1/staff-users/${kitchenId}`, sessions.admin,
      { role: "kitchen", stationIds: ["station_juice"] });
    assert(madeKitchen.status === 200, madeKitchen.json?.error || "cashier to kitchen");
    const backKitchen = await login("prep.juice", "Juice-Prep-247");
    assert((await httpJson(PORT, "GET", "/v1/session/me", backKitchen)).json.permissions.join() === "prep.station.work", "no cashier rights leaked into kitchen");
    const inactive = await httpJson(PORT, "PATCH", `/v1/staff-users/${kitchenId}`, sessions.admin, { isActive: false });
    assert(inactive.status === 200, "deactivate kitchen");
    assert((await httpJson(PORT, "GET", "/v1/session/me", backKitchen)).status === 401, "inactive session revoked");
    const failedLogin = await httpJson(PORT, "POST", "/v1/session/login", null,
      { username: "prep.juice", password: "Juice-Prep-247" }, { origin: true });
    assert(failedLogin.status === 401, "inactive user cannot login");
    pass("kitchen-deactivation");

    const audit = db.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'prep.station.accept' AND entity_id = ?`).get(`${orderId}:station_juice`);
    assert(audit.n === 1, "kitchen accept audit");
    assert(JSON.stringify(before) === JSON.stringify(readOrder(orderId)), "financial snapshot unchanged");
    pass("audit-and-financial-integrity");

    const prepJs = fs.readFileSync(path.join(root, "public/prep.js"), "utf8");
    const usersJs = fs.readFileSync(path.join(root, "public/users.js"), "utf8");
    const usersHtml = fs.readFileSync(path.join(root, "public/users.html"), "utf8");
    assert(usersHtml.includes('value="kitchen"') && usersJs.includes("selectedStationIds"), "kitchen user admin UI");
    assert(prepJs.includes("gtct.prepStation") && prepJs.includes('state.role === "kitchen"'), "station preference fails closed");
    pass("browser-ui-contract");

    console.log(`kitchen roles ${results.length} passed (temporary SQLite only, real sales disabled)`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
run().catch((err) => { console.error(err); process.exitCode = 1; });
