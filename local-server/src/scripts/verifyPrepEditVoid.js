import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { seedSampleData } from "../seed/sampleData.js";
import { listPrepBoard, setPrepStatus } from "../services/prepBoard.js";
import { nowIso } from "../util/time.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-prep-edit-"));
const dbPath = path.join(dir, "t.sqlite");
openDatabase(dbPath);
await runMigrations(getDb());
seedSampleData({
  dataDir: dir,
  dbPath,
  operatingMode: "TEST",
});

const db = getDb();
const shopId = "shop_test";
const stationId = "station_juice";
const orderId = "ord_prep_edit_1";
const ts = nowIso();

db.prepare(
  `INSERT INTO orders (
     order_id, tenant_id, order_number, order_type, destination, status, is_test,
     total_cents, created_at, updated_at, order_type_name, fulfillment_behavior, token_number
   ) VALUES (?, ?, ?, 'TAKEAWAY', 'Counter', 'OPEN', 1, 2400, ?, ?, 'Takeaway', 'COUNTER', 10)`
).run(orderId, shopId, "TEST-PREP-EDIT", ts, ts);

db.prepare(
  `INSERT INTO order_lines (
     line_id, order_id, item_id, item_name, quantity, station_id, line_index,
     unit_base_price_cents, unit_addons_cents, unit_total_cents, line_total_cents,
     variant_name
   ) VALUES
     ('ln1', ?, 'item_orange_juice', 'Orange Juice', 1, ?, 0, 800, 0, 800, 800, 'Small'),
     ('ln2', ?, 'item_orange_juice', 'Orange Juice', 2, ?, 1, 800, 0, 800, 1600, 'Large')`
).run(orderId, stationId, orderId, stationId);

let board = listPrepBoard(shopId, stationId);
let ticket = board.tickets.find((t) => t.orderId === orderId);
if (!ticket || ticket.status !== "NEW") throw new Error("expected NEW");
setPrepStatus(shopId, orderId, stationId, "ACCEPTED", "u_admin", "NEW", ticket.revision, "admin");

board = listPrepBoard(shopId, stationId);
ticket = board.tickets.find((t) => t.orderId === orderId);
if (ticket.status !== "ACCEPTED") throw new Error("accept failed");
const snap = db
  .prepare(
    `SELECT lines_snapshot_json FROM station_prep_tickets
     WHERE shop_id=? AND order_id=? AND station_id=?`
  )
  .get(shopId, orderId, stationId);
if (!snap?.lines_snapshot_json || snap.lines_snapshot_json === "[]") {
  throw new Error("snapshot missing after accept");
}

// Void Large by deleting that line and bumping updated_at (simulates Sales edit).
db.prepare(`DELETE FROM order_lines WHERE line_id = 'ln2'`).run();
db.prepare(`UPDATE orders SET updated_at = ?, total_cents = 800 WHERE order_id = ?`).run(
  nowIso(),
  orderId
);

board = listPrepBoard(shopId, stationId);
ticket = board.tickets.find((t) => t.orderId === orderId);
if (!ticket?.edited && !ticket?.updated) throw new Error("expected edited");
if (ticket.status !== "NEW") throw new Error(`expected NEW, got ${ticket.status}`);
const voided = ticket.lines.filter((l) => l.voided);
const active = ticket.lines.filter((l) => !l.voided);
if (active.length !== 1 || active[0].variantName !== "Small") {
  throw new Error(`active=${JSON.stringify(active)}`);
}
if (voided.length !== 1 || voided[0].variantName !== "Large" || Number(voided[0].quantity) !== 2) {
  throw new Error(`voided=${JSON.stringify(voided)}`);
}

setPrepStatus(
  shopId,
  orderId,
  stationId,
  "ACCEPTED",
  "u_admin",
  "NEW",
  ticket.revision,
  "admin"
);
board = listPrepBoard(shopId, stationId);
ticket = board.tickets.find((t) => t.orderId === orderId);
if (ticket.status !== "ACCEPTED") throw new Error("re-accept failed");
if (!ticket.edited) throw new Error("edited highlight should remain while preparing");

console.log("OK", {
  edited: true,
  stayedEditedAfterAccept: true,
  active: active[0].variantName,
  voided: `${voided[0].quantity}x ${voided[0].variantName}`,
});
closeDatabase();
fs.rmSync(dir, { recursive: true, force: true });
