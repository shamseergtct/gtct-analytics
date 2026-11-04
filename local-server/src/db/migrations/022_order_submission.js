/**
 * Shop-scoped order numbers and a submission id for retries.
 * Existing order ids and numbers are left unchanged.
 */

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS shop_order_counters (
      shop_id TEXT PRIMARY KEY,
      last_number INTEGER NOT NULL
    )`
  );
  ensureColumn(db, "orders", "submission_id", "submission_id TEXT");
  ensureColumn(db, "orders", "submission_fingerprint", "submission_fingerprint TEXT");
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_shop_submission
     ON orders (tenant_id, submission_id)
     WHERE submission_id IS NOT NULL`
  );
}
