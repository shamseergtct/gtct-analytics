/**
 * Allow a library add-on to have no default price.
 * NULL = price not set. 0 remains an explicit free price.
 * Existing numeric prices, including 0, are copied unchanged.
 */

function tableExists(db, name) {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)
  );
}

export function up(db) {
  if (!tableExists(db, "addons")) return;
  const info = db.prepare(`PRAGMA table_info(addons)`).all();
  const price = info.find((c) => c.name === "price_cents");
  if (!price || price.notnull === 0) return;

  const hasTax = info.some((c) => c.name === "tax_applicable");
  const taxCol = hasTax
    ? "tax_applicable INTEGER NOT NULL DEFAULT 1 CHECK (tax_applicable IN (0, 1)),"
    : "";
  const cols = [
    "addon_id",
    "shop_id",
    "name",
    "name_norm",
    "description",
    "price_cents",
    "is_active",
    "sort_order",
    "max_quantity",
    ...(hasTax ? ["tax_applicable"] : []),
    "created_at",
    "updated_at",
  ];

  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`
      CREATE TABLE addons_price_optional (
        addon_id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_norm TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        price_cents INTEGER,
        is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        max_quantity INTEGER NOT NULL DEFAULT 1 CHECK (max_quantity >= 1),
        ${taxCol}
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (shop_id, name_norm)
      );
      INSERT INTO addons_price_optional (${cols.join(", ")})
      SELECT ${cols.join(", ")} FROM addons;
      DROP TABLE addons;
      ALTER TABLE addons_price_optional RENAME TO addons;
      CREATE INDEX IF NOT EXISTS idx_addons_shop ON addons(shop_id, is_active);
    `);
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
