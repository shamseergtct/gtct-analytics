/**
 * Step 3 — staff user id on new orders and audits, plus user-management permission.
 * Existing rows stay unchanged. No accounts are created.
 */

function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  const tx = db.transaction(() => {
    ensureColumn(db, "orders", "created_by_user_id", "created_by_user_id TEXT");
    ensureColumn(db, "audit_events", "actor_user_id", "actor_user_id TEXT");

    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO staff_permissions (permission_code, description, created_at)
       VALUES ('staff.manage', 'Create and manage staff accounts', ?)`
    ).run(now);
    db.prepare(
      `INSERT OR IGNORE INTO staff_role_permissions (role_id, permission_code, granted_at, revoked_at)
       VALUES ('role_admin', 'staff.manage', ?, NULL)`
    ).run(now);
  });
  tx();
}
