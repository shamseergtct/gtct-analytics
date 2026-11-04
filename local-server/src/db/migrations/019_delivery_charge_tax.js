function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  ensureColumn(
    db,
    "shop_block_delivery_rates",
    "tax_applicable",
    "tax_applicable INTEGER NOT NULL DEFAULT 0"
  );
}
