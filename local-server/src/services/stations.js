import { getDb } from "../db/db.js";
import { nowIso } from "../util/time.js";

export function listStations() {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.*,
        (SELECT printer_id FROM station_printers sp WHERE sp.station_id = s.station_id LIMIT 1) AS printer_id
       FROM stations s
       ORDER BY s.name`
    )
    .all();
}

export function getStation(stationId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.*,
        (SELECT printer_id FROM station_printers sp WHERE sp.station_id = s.station_id LIMIT 1) AS printer_id
       FROM stations s
       WHERE s.station_id = ?`
    )
    .get(stationId);
}

export function upsertStation({
  stationId,
  name,
  description = "",
  isActive = true,
  printerId = null,
}) {
  if (!stationId || typeof stationId !== "string") {
    throw Object.assign(new Error("Station id is required."), { status: 400 });
  }
  const db = getDb();
  const ts = nowIso();
  const existing = db
    .prepare(`SELECT station_id FROM stations WHERE station_id = ?`)
    .get(stationId);

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE stations
         SET name = ?, description = ?, is_active = ?, updated_at = ?
         WHERE station_id = ?`
      ).run(name, description, isActive ? 1 : 0, ts, stationId);
    } else {
      db.prepare(
        `INSERT INTO stations (station_id, name, description, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(stationId, name, description, isActive ? 1 : 0, ts, ts);
    }

    db.prepare(`DELETE FROM station_printers WHERE station_id = ?`).run(stationId);
    if (printerId) {
      db.prepare(
        `INSERT INTO station_printers (station_id, printer_id) VALUES (?, ?)`
      ).run(stationId, printerId);
    }
  });
  tx();
  return getStation(stationId);
}

/**
 * Remove rows that were saved without an id (older builds had no validation).
 * Nothing can reference a station with no id, so deleting them is safe.
 */
export function repairStations() {
  const db = getDb();
  return db.transaction(() => {
    db.prepare(`DELETE FROM station_printers WHERE station_id IS NULL OR station_id = ''`).run();
    return db.prepare(`DELETE FROM stations WHERE station_id IS NULL OR station_id = ''`).run().changes;
  })();
}

export function stationItemCount(stationId) {
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM item_stations WHERE station_id = ?`)
    .get(stationId).n;
}

/**
 * Remove a preparation center. Refused while menu items still use it.
 * If past orders, tickets or staff refer to it, it is hidden (inactive) so
 * history keeps its name; otherwise it is deleted.
 */
export function removeStation(stationId) {
  const db = getDb();
  const station = db.prepare(`SELECT * FROM stations WHERE station_id = ?`).get(stationId);
  if (!station) throw Object.assign(new Error("Station not found."), { status: 404 });
  if (stationId === "station_cashier") {
    throw Object.assign(new Error("The CASHIER station cannot be removed."), { status: 400 });
  }
  const items = stationItemCount(stationId);
  if (items > 0) {
    throw Object.assign(
      new Error(
        `${station.name} is used by ${items} menu item${items === 1 ? "" : "s"}. Move them to another preparation center first.`
      ),
      { status: 409, code: "STATION_IN_USE", items }
    );
  }
  const used = (sql) => db.prepare(sql).get(stationId) != null;
  const hasHistory =
    used(`SELECT 1 FROM order_lines WHERE station_id = ? LIMIT 1`) ||
    used(`SELECT 1 FROM print_jobs WHERE station_id = ? LIMIT 1`) ||
    used(`SELECT 1 FROM station_prep_tickets WHERE station_id = ? LIMIT 1`) ||
    used(`SELECT 1 FROM staff_station_assignments WHERE station_id = ? LIMIT 1`);
  db.transaction(() => {
    db.prepare(`DELETE FROM station_printers WHERE station_id = ?`).run(stationId);
    if (hasHistory) {
      db.prepare(`UPDATE stations SET is_active = 0, updated_at = ? WHERE station_id = ?`).run(
        nowIso(),
        stationId
      );
    } else {
      db.prepare(`DELETE FROM stations WHERE station_id = ?`).run(stationId);
    }
  })();
  return { stationId, name: station.name, mode: hasHistory ? "hidden" : "deleted" };
}
