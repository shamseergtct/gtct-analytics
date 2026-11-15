/**
 * Link local TEST POS to GTCT Analytics shop (clientId) for cellular delivery pool.
 */

export function up(db) {
  const cols = db.prepare(`PRAGMA table_info(shop_settings)`).all();
  const names = new Set(cols.map((col) => col.name));
  if (!names.has("cloud_client_id")) {
    db.exec(
      `ALTER TABLE shop_settings ADD COLUMN cloud_client_id TEXT NOT NULL DEFAULT ''`
    );
  }
  if (!names.has("cloud_bridge_enabled")) {
    db.exec(
      `ALTER TABLE shop_settings ADD COLUMN cloud_bridge_enabled INTEGER NOT NULL DEFAULT 0
       CHECK (cloud_bridge_enabled IN (0, 1))`
    );
  }
  if (!names.has("cloud_bridge_url")) {
    db.exec(
      `ALTER TABLE shop_settings ADD COLUMN cloud_bridge_url TEXT NOT NULL DEFAULT ''`
    );
  }
}
