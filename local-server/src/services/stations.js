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
