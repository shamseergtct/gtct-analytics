/**
 * Rider "multiple payment" report.
 *  - The original table (031) only allowed CASH_WITH_BOY / SHOP_PAID_REPORTED /
 *    CREDIT_REPORTED, so every PARTIAL_SHOP report coming from the Delivery App was
 *    refused by the database (and retried forever by the cloud bridge).
 *  - Keep the split the rider entered: cash he collected / paid at shop / credit.
 *    Observation only — no ledger posting. NULL for single-mode reports.
 * SQLite cannot change a CHECK, so the table is rebuilt: new table, copy every row,
 * swap, recreate the index. No other table references it.
 */

export function up(db) {
  const cols = new Set(
    db.prepare(`PRAGMA table_info(delivery_order_payment_reports)`).all().map((c) => c.name)
  );
  if (cols.has("cash_cents")) return; // already done
  // All or nothing: the copy, swap and index happen in one transaction.
  db.transaction(() => rebuild(db))();
}

function rebuild(db) {
  const before = db.prepare(`SELECT COUNT(*) AS n FROM delivery_order_payment_reports`).get().n;
  db.exec(`
    CREATE TABLE delivery_order_payment_reports_v2 (
      shop_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      driver_user_id TEXT NOT NULL,
      report_type TEXT NOT NULL CHECK (report_type IN
        ('CASH_WITH_BOY', 'SHOP_PAID_REPORTED', 'CREDIT_REPORTED', 'PARTIAL_SHOP')),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      currency_code TEXT NOT NULL,
      currency_decimals INTEGER NOT NULL CHECK (currency_decimals BETWEEN 0 AND 4),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      reported_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      cash_cents INTEGER CHECK (cash_cents IS NULL OR cash_cents >= 0),
      shop_paid_cents INTEGER CHECK (shop_paid_cents IS NULL OR shop_paid_cents >= 0),
      credit_cents INTEGER CHECK (credit_cents IS NULL OR credit_cents >= 0),
      CHECK ((report_type = 'PARTIAL_SHOP') OR (cash_cents IS NULL AND shop_paid_cents IS NULL AND credit_cents IS NULL)),
      CHECK (cash_cents IS NULL OR cash_cents + shop_paid_cents + credit_cents = amount_cents),
      PRIMARY KEY (shop_id, order_id),
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
      FOREIGN KEY (driver_user_id, shop_id) REFERENCES staff_users(user_id, shop_id)
    );
    INSERT INTO delivery_order_payment_reports_v2
      (shop_id, order_id, driver_user_id, report_type, amount_cents, currency_code,
       currency_decimals, version, reported_at, updated_at)
      SELECT shop_id, order_id, driver_user_id, report_type, amount_cents, currency_code,
             currency_decimals, version, reported_at, updated_at
      FROM delivery_order_payment_reports;
  `);
  const after = db.prepare(`SELECT COUNT(*) AS n FROM delivery_order_payment_reports_v2`).get().n;
  if (after !== before) {
    throw new Error(`Rider report copy mismatch (${after} vs ${before}); migration stopped.`);
  }
  db.exec(`
    DROP TABLE delivery_order_payment_reports;
    ALTER TABLE delivery_order_payment_reports_v2 RENAME TO delivery_order_payment_reports;
    CREATE INDEX IF NOT EXISTS idx_delivery_payment_reports_driver
      ON delivery_order_payment_reports (shop_id, driver_user_id, report_type);
  `);
}
