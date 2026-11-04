/** P2-E3D1 TEST only — immutable cash/bank tender events, never rewrite invoice payments. */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_rider_tender_events (
      event_id TEXT PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version >= 1),
      kind TEXT NOT NULL CHECK(kind IN ('ORIGINAL','CORRECTION')),
      cash_minor INTEGER NOT NULL CHECK(cash_minor >= 0),
      bank_minor INTEGER NOT NULL CHECK(bank_minor >= 0),
      bank_account_id TEXT,
      note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=200),
      submission_id TEXT NOT NULL,
      submission_fingerprint TEXT NOT NULL CHECK(length(submission_fingerprint)=64),
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK ((bank_minor=0 AND bank_account_id IS NULL) OR (bank_minor>0 AND bank_account_id IS NOT NULL)),
      UNIQUE(settlement_id, version),
      UNIQUE(shop_id, submission_id),
      FOREIGN KEY(settlement_id) REFERENCES delivery_rider_net_settlements(settlement_id) ON DELETE RESTRICT,
      FOREIGN KEY(bank_account_id) REFERENCES shop_bank_accounts(account_id) ON DELETE RESTRICT
    );
    CREATE TABLE IF NOT EXISTS delivery_rider_tender_journal (
      line_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      account_code TEXT NOT NULL CHECK(account_code IN ('SHOP_CASH','SHOP_BANK')),
      bank_account_id TEXT,
      side TEXT NOT NULL CHECK(side IN ('DEBIT','CREDIT')),
      amount_minor INTEGER NOT NULL CHECK(amount_minor>0),
      currency_code TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK((account_code='SHOP_CASH' AND bank_account_id IS NULL)
            OR (account_code='SHOP_BANK' AND bank_account_id IS NOT NULL)),
      FOREIGN KEY(event_id) REFERENCES delivery_rider_tender_events(event_id) ON DELETE RESTRICT,
      FOREIGN KEY(bank_account_id) REFERENCES shop_bank_accounts(account_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_rider_tender_history
       ON delivery_rider_tender_events(shop_id, settlement_id, version DESC);
  `);
  for (const table of ['delivery_rider_tender_events','delivery_rider_tender_journal']) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Rider tender events are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_${table}_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Rider tender events are immutable'); END;`);
  }
}
