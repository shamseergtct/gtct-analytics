function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_customers (
      customer_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      phone_key TEXT NOT NULL,
      building_number TEXT NOT NULL DEFAULT '',
      road_number TEXT NOT NULL DEFAULT '',
      block_number TEXT NOT NULL DEFAULT '',
      address_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_customers_phone
      ON shop_customers (shop_id, phone_key);
    CREATE INDEX IF NOT EXISTS idx_shop_customers_name
      ON shop_customers (shop_id, name);
  `);
  ensureColumn(db, "orders", "customer_id", "customer_id TEXT");
  ensureColumn(
    db,
    "orders",
    "delivery_rate_source",
    "delivery_rate_source TEXT NOT NULL DEFAULT ''"
  );
}
