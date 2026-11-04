/** P2-E2C3C TEST-only: bind future credit allocations to shop customers.
 * Historic credit entries remain unchanged/unassigned until manual reconciliation.
 */
export function up(db) {
  const columns = db.prepare('PRAGMA table_info(order_payment_allocations)').all();
  if (!columns.some((c) => c.name === 'credit_customer_id')) {
    db.exec(`ALTER TABLE order_payment_allocations
      ADD COLUMN credit_customer_id TEXT REFERENCES shop_customers(customer_id)`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_credit_allocations_customer
    ON order_payment_allocations(shop_id, credit_customer_id)
    WHERE credit_customer_id IS NOT NULL`);
}
