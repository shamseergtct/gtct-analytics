/**
 * Step 5B — full cash settlement ledger.
 * Existing orders, totals, and permissions are left in place.
 * Historical order rows are not rewritten.
 */

export function up(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS order_settlements (
        settlement_id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        submission_id TEXT NOT NULL,
        submission_fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind = 'PAYMENT'),
        tender TEXT NOT NULL CHECK (tender = 'CASH'),
        currency_code TEXT NOT NULL,
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        balance_before_cents INTEGER NOT NULL CHECK (balance_before_cents >= 0),
        balance_after_cents INTEGER NOT NULL CHECK (balance_after_cents = 0),
        created_by_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(order_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_shop_submission
        ON order_settlements (shop_id, submission_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_one_payment
        ON order_settlements (shop_id, order_id);

      CREATE TABLE IF NOT EXISTS order_payment_balances (
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        currency_code TEXT NOT NULL,
        order_total_cents INTEGER NOT NULL CHECK (order_total_cents >= 0),
        paid_cents INTEGER NOT NULL CHECK (paid_cents >= 0),
        balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
        payment_status TEXT NOT NULL CHECK (payment_status IN ('UNPAID', 'PAID')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (shop_id, order_id),
        FOREIGN KEY (order_id) REFERENCES orders(order_id)
      );
    `);

    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO staff_permissions (permission_code, description, created_at)
       VALUES ('sales.payment.receive', 'Record a full cash payment for an open order', ?)`
    ).run(now);
    const grant = db.prepare(
      `INSERT OR IGNORE INTO staff_role_permissions (role_id, permission_code, granted_at, revoked_at)
       VALUES (?, 'sales.payment.receive', ?, NULL)`
    );
    grant.run("role_admin", now);
    grant.run("role_cashier", now);
  });
  tx();
}
