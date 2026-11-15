/**
 * Keep an "Edited" highlight on prep tickets after Accept until Finished.
 */

export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(station_prep_tickets)`).all();
  if (!cols.some((col) => col.name === "edit_highlight")) {
    db.exec(
      `ALTER TABLE station_prep_tickets
       ADD COLUMN edit_highlight INTEGER NOT NULL DEFAULT 0
       CHECK (edit_highlight IN (0, 1))`
    );
  }
}
