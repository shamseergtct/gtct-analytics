/**
 * Step 5C-B — shop bank accounts and full bank settlement.
 * Existing cash settlement rows are copied unchanged.
 * Cash amounts, fingerprints, and submission ids are not rewritten.
 */

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_bank_accounts (
      account_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      bank_name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK (account_type IN ('OPERATIONAL', 'RESERVE')),
      is_active INTEGER NOT NULL CHECK (is_active IN (0, 1)),
      masked_reference TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT NOT NULL,
      updated_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bank_accounts_shop
      ON shop_bank_accounts (shop_id, account_type, is_active);
  `);

  const settlementColumns = columnNames(db, "order_settlements");
  if (settlementColumns.length && !settlementColumns.includes("bank_account_id")) {
    const foreignKeys = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    const rebuild = db.transaction(() => {
      db.exec(`DROP TABLE IF EXISTS order_settlements_next`);
      db.exec(`
        CREATE TABLE order_settlements_next (
          settlement_id TEXT PRIMARY KEY,
          shop_id TEXT NOT NULL,
          order_id TEXT NOT NULL,
          submission_id TEXT NOT NULL,
          submission_fingerprint TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind = 'PAYMENT'),
          tender TEXT NOT NULL CHECK (tender IN ('CASH', 'BANK')),
          currency_code TEXT NOT NULL,
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
          balance_before_cents INTEGER NOT NULL CHECK (balance_before_cents >= 0),
          balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents = 0),
          created_by_user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          bank_account_id TEXT,
          CHECK (
            (tender = 'CASH' AND bank_account_id IS NULL)
            OR (tender = 'BANK' AND bank_account_id IS NOT NULL)
          ),
          FOREIGN KEY (order_id) REFERENCES orders(order_id),
          FOREIGN KEY (bank_account_id) REFERENCES shop_bank_accounts(account_id) ON DELETE RESTRICT
        );
      `);
      db.exec(`
        INSERT INTO order_settlements_next (
          settlement_id, shop_id, order_id, submission_id, submission_fingerprint,
          kind, tender, currency_code, amount_cents, balance_before_cents, balance_after_cents,
          created_by_user_id, created_at, bank_account_id
        )
        SELECT
          settlement_id, shop_id, order_id, submission_id, submission_fingerprint,
          kind, tender, currency_code, amount_cents, balance_before_cents, balance_after_cents,
          created_by_user_id, created_at, NULL
        FROM order_settlements;
      `);
      db.exec(`DROP TABLE order_settlements`);
      db.exec(`ALTER TABLE order_settlements_next RENAME TO order_settlements`);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_shop_submission
          ON order_settlements (shop_id, submission_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_one_payment
          ON order_settlements (shop_id, order_id);
      `);
    });
    try {
      rebuild();
    } finally {
      db.pragma(foreignKeys ? "foreign_keys = ON" : "foreign_keys = OFF");
    }
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO staff_permissions (permission_code, description, created_at)
     VALUES ('shop.bank_accounts.manage', 'Create and update shop bank accounts', ?)`
  ).run(now);
  db.prepare(
    `INSERT OR IGNORE INTO staff_role_permissions (role_id, permission_code, granted_at, revoked_at)
     VALUES ('role_admin', 'shop.bank_accounts.manage', ?, NULL)`
  ).run(now);
}
