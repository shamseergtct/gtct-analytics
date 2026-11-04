/**
 * P2-B2: Non-destructive kitchen role and per-staff station assignments.
 * Existing Admin/Cashier grants, sessions, orders and payments are untouched.
 */
export function up(db) {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_station_assignments (
        shop_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        station_id TEXT NOT NULL,
        assigned_at TEXT NOT NULL,
        PRIMARY KEY (shop_id, user_id, station_id),
        FOREIGN KEY (user_id, shop_id) REFERENCES staff_users(user_id, shop_id),
        FOREIGN KEY (shop_id) REFERENCES shop_settings(shop_id),
        FOREIGN KEY (station_id) REFERENCES stations(station_id)
      );
      CREATE INDEX IF NOT EXISTS idx_staff_station_assignments_station
        ON staff_station_assignments(shop_id, station_id, user_id);
    `);
    db.prepare(`INSERT OR IGNORE INTO staff_roles (role_id, code, name, created_at, updated_at)
       VALUES ('role_kitchen', 'kitchen', 'Kitchen', ?, ?)`).run(now, now);
    db.prepare(`INSERT OR IGNORE INTO staff_permissions (permission_code, description, created_at)
       VALUES ('prep.station.work', 'Accept and finish preparation tickets', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO staff_role_permissions (role_id, permission_code, granted_at, revoked_at)
       VALUES ('role_kitchen', 'prep.station.work', ?, NULL)`).run(now);
  });
  tx();
}
