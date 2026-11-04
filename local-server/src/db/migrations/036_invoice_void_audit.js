/** TEST-only invoice void audit. Immutable order history is not deleted. */
export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS order_void_events (
    shop_id TEXT NOT NULL,
    order_id TEXT NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
    invoice_number TEXT NOT NULL,
    reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 5 AND 240),
    voided_at TEXT NOT NULL,
    voided_by_user_id TEXT NOT NULL,
    PRIMARY KEY(shop_id,order_id)
  );`);
}
