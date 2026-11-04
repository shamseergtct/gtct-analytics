/** P2-E3C4 TEST ONLY: rider custody gross vs physical shop cash net, separately auditable. */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_rider_net_settlements (
      settlement_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      rider_user_id TEXT NOT NULL,
      business_date TEXT NOT NULL,
      currency_code TEXT NOT NULL CHECK(length(currency_code)=3),
      currency_decimals INTEGER NOT NULL CHECK(currency_decimals BETWEEN 0 AND 4),
      gross_minor INTEGER NOT NULL CHECK(gross_minor>0),
      commission_minor INTEGER NOT NULL CHECK(commission_minor>=0),
      shop_cash_minor INTEGER NOT NULL CHECK(shop_cash_minor>=0),
      invoice_count INTEGER NOT NULL CHECK(invoice_count>0),
      accrual_id TEXT,
      submission_id TEXT NOT NULL,
      submission_fingerprint TEXT NOT NULL CHECK(length(submission_fingerprint)=64),
      confirmed_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK(gross_minor=commission_minor+shop_cash_minor),
      CHECK((commission_minor=0 AND accrual_id IS NULL) OR (commission_minor>0 AND accrual_id IS NOT NULL)),
      UNIQUE(shop_id,submission_id),
      UNIQUE(accrual_id),
      FOREIGN KEY(accrual_id) REFERENCES delivery_commission_accruals(accrual_id) ON DELETE RESTRICT,
      FOREIGN KEY(rider_user_id,shop_id) REFERENCES staff_users(user_id,shop_id)
    );
    CREATE TABLE IF NOT EXISTS delivery_rider_net_settlement_orders (
      settlement_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      report_version INTEGER NOT NULL,
      gross_minor INTEGER NOT NULL CHECK(gross_minor>0),
      allocation_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY(settlement_id,order_id),
      UNIQUE(shop_id,order_id),
      FOREIGN KEY(settlement_id) REFERENCES delivery_rider_net_settlements(settlement_id) ON DELETE RESTRICT,
      FOREIGN KEY(order_id) REFERENCES orders(order_id) ON DELETE RESTRICT,
      FOREIGN KEY(allocation_id) REFERENCES order_payment_allocations(allocation_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS delivery_rider_settlement_journal (
      line_id TEXT PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      account_code TEXT NOT NULL CHECK(account_code IN ('SHOP_CASH','COMMISSION_PAYABLE','RIDER_CUSTODY')),
      side TEXT NOT NULL CHECK(side IN ('DEBIT','CREDIT')),
      amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
      currency_code TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(settlement_id,account_code),
      FOREIGN KEY(settlement_id) REFERENCES delivery_rider_net_settlements(settlement_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_rider_net_settlements_shop_date
      ON delivery_rider_net_settlements(shop_id,rider_user_id,business_date DESC);
  `);
  for (const table of ['delivery_rider_net_settlements','delivery_rider_net_settlement_orders','delivery_rider_settlement_journal']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Rider net settlement is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_${table}_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Rider net settlement is immutable'); END;`);
  }
}
