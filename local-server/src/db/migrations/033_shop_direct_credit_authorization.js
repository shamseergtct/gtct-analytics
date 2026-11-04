/** P2-E2C2: Shop-originated TEST customer-credit authorization.
 * Does not create receivables or mutate sales/payment ledgers.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_shop_credit_authorizations (
      shop_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('APPROVED','REVOKED')),
      version INTEGER NOT NULL CHECK(version >= 1),
      updated_by_user_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(shop_id,order_id),
      FOREIGN KEY(order_id) REFERENCES orders(order_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_shop_credit_shop_state
      ON delivery_shop_credit_authorizations(shop_id,state);
  `);
}
