/** P2-E2C1 TEST delivery workflow, credit authorization only; no finance postings. */
export function up(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_order_lifecycle (
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING','DELIVERED','CANCEL_REQUESTED','CANCELLED')),
        version INTEGER NOT NULL CHECK(version >= 1),
        reason TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL,
        updated_by_role TEXT NOT NULL,
        PRIMARY KEY (shop_id, order_id),
        FOREIGN KEY(order_id) REFERENCES orders(order_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_lifecycle_shop_status
      ON delivery_order_lifecycle(shop_id, status);
      CREATE TABLE IF NOT EXISTS delivery_credit_reviews (
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        report_version INTEGER NOT NULL CHECK(report_version > 0),
        decision TEXT NOT NULL CHECK(decision IN ('CREDIT_APPROVED','CREDIT_REJECTED')),
        reviewed_by_user_id TEXT NOT NULL,
        reviewed_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (shop_id, order_id),
        FOREIGN KEY(order_id) REFERENCES orders(order_id) ON DELETE CASCADE
      );
    `);
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO staff_permissions(permission_code, description, created_at)
      VALUES('delivery.status.update', 'Mark TEST delivery as delivered or request cancellation', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO staff_role_permissions(role_id, permission_code, granted_at, revoked_at)
      VALUES('role_delivery', 'delivery.status.update', ?, NULL)`).run(now);
  });
  tx();
}
