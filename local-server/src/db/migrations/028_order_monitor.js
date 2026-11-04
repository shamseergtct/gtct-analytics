/**
 * P2-E1: TEST-only dispatch readiness, independent of sale, prep and payment ledgers.
 * Historical orders and preparation tickets are never rewritten.
 */
export function up(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS order_dispatch_readiness (
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status = 'READY_FOR_DELIVERY'),
        prep_revision TEXT NOT NULL CHECK (length(prep_revision) = 64),
        confirmed_by_user_id TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY (shop_id, order_id),
        FOREIGN KEY (order_id) REFERENCES orders(order_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_readiness_shop
        ON order_dispatch_readiness (shop_id, confirmed_at);
    `);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO staff_permissions (permission_code, description, created_at)
      VALUES ('sales.orders.dispatch', 'Confirm packing and ready-for-delivery status', ?)`).run(now);
    for (const roleId of ['role_admin', 'role_cashier']) {
      db.prepare(`INSERT OR IGNORE INTO staff_role_permissions
        (role_id, permission_code, granted_at, revoked_at)
        VALUES (?, 'sales.orders.dispatch', ?, NULL)`).run(roleId, now);
    }
  });
  tx();
}
