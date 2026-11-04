/**
 * Read-only order register.
 * Copies the customer address label onto new orders only.
 * Existing order rows are not rewritten.
 */

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  const tx = db.transaction(() => {
    ensureColumn(db, "orders", "address_label", "address_label TEXT");
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_shop_created
        ON orders (tenant_id, created_at);
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO staff_permissions (permission_code, description, created_at)
       VALUES ('sales.orders.view', 'View accepted orders', ?)`
    ).run(now);
    for (const roleId of ["role_admin", "role_cashier"]) {
      db.prepare(
        `INSERT OR IGNORE INTO staff_role_permissions (role_id, permission_code, granted_at)
         VALUES (?, 'sales.orders.view', ?)`
      ).run(roleId, now);
    }
  });
  tx();
}
