/**
 * Rider "release order" requests from the cloud Delivery App.
 * A rider who accepted an order asks to give it back; the cashier/admin allows
 * (the claim is removed and the order is offered to all riders again) or refuses.
 * decision_sent = 1 once the cloud has applied the decision.
 */
export function up(db) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_release_requests (
        shop_id TEXT NOT NULL,
        request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 80),
        order_id TEXT NOT NULL,
        cloud_doc_id TEXT NOT NULL,
        driver_user_id TEXT NOT NULL DEFAULT '',
        rider_name TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')),
        requested_at TEXT NOT NULL,
        decided_by_user_id TEXT,
        decided_at TEXT,
        note TEXT NOT NULL DEFAULT '',
        decision_sent INTEGER NOT NULL DEFAULT 0 CHECK (decision_sent IN (0,1)),
        PRIMARY KEY (shop_id, request_id),
        FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_release_requests_order
        ON delivery_release_requests (shop_id, order_id, status);
      CREATE INDEX IF NOT EXISTS idx_release_requests_unsent
        ON delivery_release_requests (shop_id, decision_sent, status);
    `);
  })();
}
