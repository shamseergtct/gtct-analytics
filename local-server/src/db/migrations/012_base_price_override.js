/**
 * Phase 1.9 — Order-line base unit price override snapshots.
 * Non-destructive. Existing lines keep unit_base_price_cents as-applied;
 * configured_unit_base_price_cents backfilled from applied when null.
 */

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  ensureColumn(
    db,
    "order_lines",
    "configured_unit_base_price_cents",
    "configured_unit_base_price_cents INTEGER"
  );
  ensureColumn(
    db,
    "order_lines",
    "base_price_adjusted",
    "base_price_adjusted INTEGER NOT NULL DEFAULT 0 CHECK (base_price_adjusted IN (0, 1))"
  );
  ensureColumn(
    db,
    "order_lines",
    "base_price_adjusted_by_role",
    "base_price_adjusted_by_role TEXT NOT NULL DEFAULT ''"
  );

  db.exec(`
    UPDATE order_lines
    SET configured_unit_base_price_cents = unit_base_price_cents
    WHERE configured_unit_base_price_cents IS NULL
  `);
}
