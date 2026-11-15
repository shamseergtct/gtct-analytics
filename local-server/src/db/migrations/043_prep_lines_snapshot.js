/**
 * Snapshot of last accepted station lines so Prep can show voided (removed) items
 * after an order edit.
 */

export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(station_prep_tickets)`).all();
  if (!cols.some((col) => col.name === "lines_snapshot_json")) {
    db.exec(
      `ALTER TABLE station_prep_tickets
       ADD COLUMN lines_snapshot_json TEXT NOT NULL DEFAULT '[]'`
    );
  }
}
