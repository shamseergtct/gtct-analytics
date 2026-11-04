/** P2-E2A: TEST-only delivery role + atomic order claim ledger. No sales or money writes. */
export function up(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS order_delivery_claims (
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        driver_user_id TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        prep_revision TEXT NOT NULL CHECK(length(prep_revision) = 64),
        PRIMARY KEY (shop_id, order_id),
        FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
        FOREIGN KEY (driver_user_id, shop_id) REFERENCES staff_users(user_id, shop_id)
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_claim_driver
        ON order_delivery_claims (shop_id, driver_user_id, accepted_at);
    `);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO staff_roles (role_id, code, name, created_at, updated_at)
      VALUES ('role_delivery', 'delivery', 'Delivery Boy', ?, ?)`).run(now, now);
    for (const [code, description] of [
      ['delivery.pool.view', 'View ready TEST deliveries for this shop'],
      ['delivery.pool.accept', 'Accept one ready TEST delivery atomically']
    ]) {
      db.prepare(`INSERT OR IGNORE INTO staff_permissions (permission_code, description, created_at)
        VALUES (?, ?, ?)`).run(code, description, now);
      db.prepare(`INSERT OR IGNORE INTO staff_role_permissions
        (role_id, permission_code, granted_at, revoked_at)
        VALUES ('role_delivery', ?, ?, NULL)`).run(code, now);
    }
  });
  tx();
}
