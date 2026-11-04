/** P2-E2C3A: additive TEST-only shop payment allocations.
 * Legacy one-shot full order_settlements remain untouched, no backfill.
 * Credit is an approved balance allocation, NOT an Accounts Receivable journal entry.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_payment_allocations (
      allocation_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      submission_fingerprint TEXT NOT NULL,
      currency_code TEXT NOT NULL,
      cash_cents INTEGER NOT NULL CHECK(cash_cents >= 0),
      bank_cents INTEGER NOT NULL CHECK(bank_cents >= 0),
      credit_cents INTEGER NOT NULL CHECK(credit_cents >= 0),
      bank_account_id TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(cash_cents + bank_cents + credit_cents > 0),
      CHECK((bank_cents = 0 AND bank_account_id IS NULL)
        OR (bank_cents > 0 AND bank_account_id IS NOT NULL)),
      FOREIGN KEY(order_id) REFERENCES orders(order_id) ON DELETE RESTRICT,
      FOREIGN KEY(bank_account_id) REFERENCES shop_bank_accounts(account_id) ON DELETE RESTRICT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_allocations_shop_submission
      ON order_payment_allocations(shop_id,submission_id);
    CREATE INDEX IF NOT EXISTS idx_allocations_shop_order
      ON order_payment_allocations(shop_id,order_id);
  `);
}
