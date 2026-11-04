/**
 * Phase 1.9 — Menu item variants (sizes/options) + order-line variant snapshots.
 * Non-destructive. Existing items remain non-variant (has_variants = 0).
 */

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_item_variants (
      variant_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES menu_items(item_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      sku TEXT,
      code TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      is_sold_out INTEGER NOT NULL DEFAULT 0 CHECK (is_sold_out IN (0, 1)),
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (item_id, name_norm)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_menu_item_variants_item
      ON menu_item_variants(item_id, sort_order, name);
  `);

  ensureColumn(
    db,
    "menu_items",
    "has_variants",
    "has_variants INTEGER NOT NULL DEFAULT 0 CHECK (has_variants IN (0, 1))"
  );

  ensureColumn(
    db,
    "order_lines",
    "variant_id",
    "variant_id TEXT"
  );
  ensureColumn(
    db,
    "order_lines",
    "variant_name",
    "variant_name TEXT NOT NULL DEFAULT ''"
  );
  ensureColumn(
    db,
    "order_lines",
    "variant_price_cents",
    "variant_price_cents INTEGER"
  );
}
