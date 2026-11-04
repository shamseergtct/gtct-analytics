/**
 * Preparation station board. Uses a temporary database only.
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

const PORT = 19005;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function listen(server, config) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-prep-"));
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

  try {
    const staffAuth = fs.readFileSync(path.join(root, "src/services/staffAuth.js"), "utf8");
    const deviceBlock = staffAuth.slice(staffAuth.indexOf("DEVICE_PERMISSIONS"), staffAuth.indexOf("function"));
    assert(!deviceBlock.includes("prep.station.work"), "device permission stays off the station screen");
    const html = fs.readFileSync(path.join(root, "public/prep.html"), "utf8");
    const page = fs.readFileSync(path.join(root, "public/prep.js"), "utf8");
    assert(html.includes("prep-board") && page.includes("data-accept") && page.includes("data-finish"), "station screen");
    assert(page.includes("playNewOrderSound") && page.includes("showOrderNotices") && html.includes("prep-alerts"), "new order number notice");

    const sessions = await openRoleSessions(PORT, config.testTenantId);
    const created = await httpJson(PORT, "POST", "/v1/test-orders", sessions.admin, {
      orderNumber: "PREP-JUICE-1",
      orderType: "TAKEAWAY",
      lines: [{ itemId: "item_orange_juice", quantity: 1, instructions: ["Less Sugar"] }],
    });
    assert(created.status === 201, created.json?.error || "order");
    const orderId = created.json.order.order_id;
    const jobsBefore = getDb().prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ?`).get(orderId).n;

    const board = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", sessions.device);
    assert(board.status === 200, board.json?.error || "board");
    assert(board.json.station.name && board.json.tickets.length === 1, "juice ticket");
    assert(board.json.tickets[0].status === "NEW", "new ticket");
    assert(board.json.tickets[0].lines[0].name && board.json.tickets[0].lines[0].instructions[0] === "Less Sugar", "item details");
    const grill = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_grill", sessions.admin);
    assert(grill.json.tickets.length === 0, "other station is empty");
    const cashierStation = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_cashier", sessions.admin);
    assert(cashierStation.status === 400, "cashier is not a preparation station");
    assert(getDb().prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ?`).get(orderId).n === jobsBefore, "viewing does not print");

    const accepted = await httpJson(PORT, "POST", "/v1/prep-board/accept", sessions.device, {
      orderId,
      stationId: "station_juice",
    });
    assert(accepted.status === 200 && accepted.json.status === "ACCEPTED", accepted.json?.error || "accept");
    const preparing = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", sessions.device);
    assert(preparing.json.tickets[0].status === "ACCEPTED", "preparing");
    const finished = await httpJson(PORT, "POST", "/v1/prep-board/finish", sessions.device, {
      orderId,
      stationId: "station_juice",
    });
    assert(finished.status === 200 && finished.json.status === "FINISHED", finished.json?.error || "finish");
    const done = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", sessions.admin);
    assert(done.json.tickets[0].status === "FINISHED", "finished column");
    const total = getDb().prepare(`SELECT total_cents FROM orders WHERE order_id = ?`).get(orderId).total_cents;

    const edited = await httpJson(PORT, "POST", "/v1/test-orders", sessions.admin, {
      orderId,
      orderNumber: "PREP-JUICE-1",
      submissionId: "prep-edit-juice-01",
      orderType: "TAKEAWAY",
      lines: [{ itemId: "item_orange_juice", quantity: 2, instructions: ["Less Sugar"] }],
    });
    assert(edited.status === 200 && edited.json.edited === true, edited.json?.error || "edit");
    const reopened = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", sessions.admin);
    assert(reopened.json.tickets[0].status === "NEW" && reopened.json.tickets[0].updated === true, "edit returns to the station");
    assert(reopened.json.tickets[0].lines[0].quantity === 2, "edited quantity");
    assert(getDb().prepare(`SELECT total_cents, status FROM orders WHERE order_id = ?`).get(orderId).status === "OPEN", "order stays open");
    assert(getDb().prepare(`SELECT total_cents FROM orders WHERE order_id = ?`).get(orderId).total_cents !== total, "server total follows the edit");

    getDb()
      .prepare(
        `UPDATE staff_role_permissions SET revoked_at = ?
         WHERE role_id = 'role_cashier' AND permission_code = 'prep.station.work'`
      )
      .run(new Date().toISOString());
    const denied = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", sessions.device);
    assert(denied.status === 403, "cashier permission");
    const anon = await httpJson(PORT, "GET", "/v1/prep-board", null);
    assert(anon.status === 401, "sign-in required");
    console.log("prep station ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
