/** P2-E2C0 TEST-only delivery payment observations, NOT accounting transactions. */
export function up(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_order_payment_reports (
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        driver_user_id TEXT NOT NULL,
        report_type TEXT NOT NULL CHECK (report_type IN
          ('CASH_WITH_BOY', 'SHOP_PAID_REPORTED', 'CREDIT_REPORTED')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
        currency_code TEXT NOT NULL,
        currency_decimals INTEGER NOT NULL CHECK (currency_decimals BETWEEN 0 AND 4),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        reported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (shop_id, order_id),
        FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
        FOREIGN KEY (driver_user_id, shop_id) REFERENCES staff_users(user_id, shop_id)
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_payment_reports_driver
        ON delivery_order_payment_reports (shop_id, driver_user_id, report_type);
    `);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO staff_permissions (permission_code, description, created_at)
      VALUES ('delivery.payment.report', 'Report delivery payment received or customer credit request, without posting a financial transaction', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO staff_role_permissions
      (role_id, permission_code, granted_at, revoked_at)
      VALUES ('role_delivery', 'delivery.payment.report', ?, NULL)`).run(now);
  });
  tx();
}
