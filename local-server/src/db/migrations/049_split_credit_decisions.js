/**
 * Shop decision on the CREDIT part of a rider's multiple payment.
 * Only rejections are stored here (an approval is the credit allocation itself).
 * Tied to the rider report version: when the rider corrects the report, it is
 * pending again.
 */

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_split_credit_decisions (
      shop_id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      report_version INTEGER NOT NULL CHECK (report_version > 0),
      decision TEXT NOT NULL CHECK (decision IN ('REJECTED')),
      note TEXT NOT NULL DEFAULT '',
      decided_by_user_id TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      PRIMARY KEY (shop_id, order_id, report_version),
      FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
    );
  `);
}
