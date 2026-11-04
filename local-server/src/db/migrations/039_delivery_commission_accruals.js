/** P2-E3C3 TEST ONLY. Immutable daily commission expense and payable SUBLEDGER.
 * DOES NOT affect POS sales, cash, bank, settlement, or external General Ledger.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_commission_accruals (
      accrual_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      rider_user_id TEXT NOT NULL,
      business_date TEXT NOT NULL CHECK(business_date GLOB '????-??-??'),
      policy_id TEXT NOT NULL,
      policy_version INTEGER NOT NULL CHECK(policy_version>0),
      policy_snapshot_json TEXT NOT NULL,
      eligible_orders_json TEXT NOT NULL,
      facts_hash TEXT NOT NULL CHECK(length(facts_hash)=64),
      submission_id TEXT NOT NULL,
      submission_fingerprint TEXT NOT NULL CHECK(length(submission_fingerprint)=64),
      currency_code TEXT NOT NULL CHECK(length(currency_code)=3),
      currency_decimals INTEGER NOT NULL CHECK(currency_decimals BETWEEN 0 AND 4),
      eligible_delivery_count INTEGER NOT NULL CHECK(eligible_delivery_count>0),
      total_bill_minor INTEGER NOT NULL CHECK(total_bill_minor>=0),
      delivery_charge_minor INTEGER NOT NULL CHECK(delivery_charge_minor>=0),
      amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
      approved_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(policy_id) REFERENCES delivery_commission_policies(policy_id) ON DELETE RESTRICT,
      FOREIGN KEY(rider_user_id,shop_id) REFERENCES staff_users(user_id,shop_id),
      UNIQUE(shop_id,rider_user_id,business_date),
      UNIQUE(shop_id,submission_id)
    );
    CREATE TABLE IF NOT EXISTS delivery_commission_accrual_orders (
      accrual_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      PRIMARY KEY(accrual_id,order_id),
      UNIQUE(shop_id,order_id),
      FOREIGN KEY(accrual_id) REFERENCES delivery_commission_accruals(accrual_id) ON DELETE RESTRICT,
      FOREIGN KEY(order_id) REFERENCES orders(order_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS delivery_commission_journal_lines (
      line_id TEXT PRIMARY KEY,
      accrual_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      account_code TEXT NOT NULL CHECK(account_code IN ('COMMISSION_EXPENSE','COMMISSION_PAYABLE')),
      side TEXT NOT NULL CHECK(side IN ('DEBIT','CREDIT')),
      amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
      currency_code TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(accrual_id,account_code),
      FOREIGN KEY(accrual_id) REFERENCES delivery_commission_accruals(accrual_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_commission_accrual_rider_date
      ON delivery_commission_accruals(shop_id,rider_user_id,business_date DESC);
  `);
  for (const table of ['delivery_commission_accruals','delivery_commission_accrual_orders','delivery_commission_journal_lines']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Commission accrual records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_${table}_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Commission accrual records are immutable'); END;`);
  }
}
