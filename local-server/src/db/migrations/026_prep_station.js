/**
 * Preparation station board.
 * Adds ticket status only. Existing orders are not rewritten.
 */

export function up(db) {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS station_prep_tickets (
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        station_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('NEW', 'ACCEPTED', 'FINISHED')),
        line_signature TEXT NOT NULL DEFAULT '',
        accepted_at TEXT,
        finished_at TEXT,
        updated_by_user_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (shop_id, order_id, station_id),
        FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
        FOREIGN KEY (station_id) REFERENCES stations(station_id)
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO staff_permissions (permission_code, description, created_at)
       VALUES ('prep.station.work', 'Accept and finish preparation tickets', ?)`
    ).run(now);
    for (const roleId of ["role_admin", "role_cashier"]) {
      db.prepare(
        `INSERT OR IGNORE INTO staff_role_permissions (role_id, permission_code, granted_at, revoked_at)
         VALUES (?, 'prep.station.work', ?, NULL)`
      ).run(roleId, now);
    }
  });
  tx();
}
