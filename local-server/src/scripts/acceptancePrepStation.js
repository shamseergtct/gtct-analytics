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
    assert(/^[a-f0-9]{64}$/.test(board.json.tickets[0].revision || ""), "server revision");
    assert(board.json.tickets[0].lines[0].name && board.json.tickets[0].lines[0].instructions[0] === "Less Sugar", "item details");
    const grill = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_grill", sessions.admin);
    assert(grill.json.tickets.length === 0, "other station is empty");
    const cashierStation = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_cashier", sessions.admin);
    assert(cashierStation.status === 400, "cashier is not a preparation station");
    assert(getDb().prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ?`).get(orderId).n === jobsBefore, "viewing does not print");

    const initial = board.json.tickets[0];
    const directFinish = await httpJson(PORT, "POST", "/v1/prep-board/finish", sessions.device, {
      orderId, stationId: "station_juice", expectedStatus: initial.status, expectedRevision: initial.revision,
    });
    assert(directFinish.status === 409 && directFinish.json.code === "PREP_INVALID_TRANSITION", "cannot finish NEW");
    const missingExpectation = await httpJson(PORT, "POST", "/v1/prep-board/accept", sessions.device, {
      orderId, stationId: "station_juice",
    });
    assert(missingExpectation.status === 400 && missingExpectation.json.code === "PREP_EXPECTATION_REQUIRED", "stale clients rejected");

    const acceptBody = {
      orderId, stationId: "station_juice", expectedStatus: initial.status, expectedRevision: initial.revision,
    };
    const acceptRace = await Promise.all([
      httpJson(PORT, "POST", "/v1/prep-board/accept", sessions.device, acceptBody),
      httpJson(PORT, "POST", "/v1/prep-board/accept", sessions.admin, acceptBody),
    ]);
    assert(acceptRace.filter((r) => r.status === 200).length === 1, "only one accept wins");
    assert(acceptRace.filter((r) => r.status === 409 && r.json.code === "PREP_STALE").length === 1, "stale second accept rejected");
    const preparing = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", sessions.device);
    assert(preparing.json.tickets[0].status === "ACCEPTED", "preparing");
    assert(preparing.json.tickets[0].revision !== initial.revision, "accept revision changes");

    const finished = await httpJson(PORT, "POST", "/v1/prep-board/finish", sessions.device, {
      orderId,
      stationId: "station_juice",
      expectedStatus: preparing.json.tickets[0].status,
      expectedRevision: preparing.json.tickets[0].revision,
    });
    assert(finished.status === 200 && finished.json.status === "FINISHED", finished.json?.error || "finish");
    const staleFinish = await httpJson(PORT, "POST", "/v1/prep-board/finish", sessions.device, {
      orderId,
      stationId: "station_juice",
      expectedStatus: preparing.json.tickets[0].status,
      expectedRevision: preparing.json.tickets[0].revision,
    });
    assert(staleFinish.status === 409 && staleFinish.json.code === "PREP_STALE", "duplicate finish rejected");
    const done = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", sessions.admin);
    assert(done.json.tickets[0].status === "FINISHED", "finished column");
    const prepAudits = getDb().prepare(
      `SELECT action, actor_user_id, detail_json FROM audit_events
       WHERE entity_type = 'station_prep_ticket' AND entity_id = ? ORDER BY created_at`
    ).all(`${orderId}:station_juice`);
    assert(prepAudits.length === 2, "one audit for accept and one for finish, no duplicates");
    assert(prepAudits.some((row) => row.action === "prep.station.accept"), "accept audited");
    assert(prepAudits.some((row) => row.action === "prep.station.finish"), "finish audited");
    assert(prepAudits.every((row) => row.actor_user_id), "staff identity recorded");
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
    const staleAfterEdit = await httpJson(PORT, "POST", "/v1/prep-board/finish", sessions.admin, {
      orderId, stationId: "station_juice",
      expectedStatus: preparing.json.tickets[0].status,
      expectedRevision: preparing.json.tickets[0].revision,
    });
    assert(staleAfterEdit.status === 409 && staleAfterEdit.json.code === "PREP_STALE", "edited order cannot be finished from stale screen");
    const reaccept = await httpJson(PORT, "POST", "/v1/prep-board/accept", sessions.admin, {
      orderId, stationId: "station_juice",
      expectedStatus: reopened.json.tickets[0].status,
      expectedRevision: reopened.json.tickets[0].revision,
    });
    assert(reaccept.status === 200, "updated ticket can be reaccepted after review");
    const afterReaccept = await httpJson(PORT, "GET", "/v1/prep-board?stationId=station_juice", sessions.admin);
    assert(afterReaccept.json.tickets[0].status === "ACCEPTED", "updated recipe is preparing");
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
    console.log("prep station safety ok");
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
