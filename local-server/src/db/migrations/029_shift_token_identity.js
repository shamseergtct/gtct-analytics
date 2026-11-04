/** P2-E1.1 TEST-only shift-scoped token numbers.
 * Existing order_number remains the immutable, shop-wide invoice reference.
 * Historical orders are NOT backfilled or renumbered.
 */
function ensureColumn(db, column, ddl) {
  const cols = db.prepare('PRAGMA table_info(orders)').all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE orders ADD COLUMN ${ddl}`);
}

export function up(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shop_business_shifts (
        shift_id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        business_date TEXT NOT NULL CHECK (business_date GLOB '????-??-??'),
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
        last_token_number INTEGER NOT NULL DEFAULT 0 CHECK (last_token_number >= 0),
        opened_at TEXT NOT NULL,
        opened_by_user_id TEXT,
        closed_at TEXT,
        closed_by_user_id TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_one_open_shift
        ON shop_business_shifts(shop_id) WHERE status = 'OPEN';
      CREATE INDEX IF NOT EXISTS idx_shop_shift_history
        ON shop_business_shifts(shop_id, opened_at);
    `);
    ensureColumn(db, 'business_shift_id', 'business_shift_id TEXT');
    ensureColumn(db, 'business_date', 'business_date TEXT');
    ensureColumn(db, 'token_number', 'token_number INTEGER');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_shift_token_unique
        ON orders(tenant_id, business_shift_id, token_number)
        WHERE business_shift_id IS NOT NULL AND token_number IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_orders_business_date
        ON orders(tenant_id, business_date);
    `);
  });
  tx();
}
