/**
 * Per item: open the preparation (modifier) screen when it is added on Sales.
 * Default ON (current behaviour); turn OFF for quick items like soft drinks.
 */

export function up(db) {
  const cols = new Set(db.prepare(`PRAGMA table_info(menu_items)`).all().map((c) => c.name));
  if (!cols.has("open_customize")) {
    db.exec(
      `ALTER TABLE menu_items ADD COLUMN open_customize INTEGER NOT NULL DEFAULT 1
       CHECK (open_customize IN (0, 1))`
    );
  }
}
