/** P2-E3B: TEST-only, one order / one full confirmed rider-cash handover.
 * Separate immutable custody-confirmation ledger linked to a shop cash allocation.
 * No legacy records are modified or backfilled. */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_cash_handovers (
      handover_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      driver_user_id TEXT NOT NULL,
      report_version INTEGER NOT NULL CHECK(report_version > 0),
      submission_id TEXT NOT NULL,
      submission_fingerprint TEXT NOT NULL,
      allocation_id TEXT NOT NULL,
      currency_code TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      cashier_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(order_id) REFERENCES orders(order_id) ON DELETE RESTRICT,
      FOREIGN KEY(allocation_id) REFERENCES order_payment_allocations(allocation_id) ON DELETE RESTRICT,
      FOREIGN KEY(driver_user_id,shop_id) REFERENCES staff_users(user_id,shop_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_handover_order
      ON delivery_cash_handovers(shop_id,order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_handover_submission
      ON delivery_cash_handovers(shop_id,submission_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_handover_allocation
      ON delivery_cash_handovers(shop_id,allocation_id);
    CREATE INDEX IF NOT EXISTS idx_delivery_handover_driver
      ON delivery_cash_handovers(shop_id,driver_user_id,created_at);
  `);
}
