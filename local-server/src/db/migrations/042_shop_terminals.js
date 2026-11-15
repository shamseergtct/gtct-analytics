/**
 * Shop terminals for multi-device TEST use (tablets / other PCs on LAN).
 * Staff sessions may attach a paired terminal; one staff user may stay signed
 * in on many terminals at once.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_terminals (
      terminal_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      code TEXT NOT NULL,
      display_name TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'any'
        CHECK (purpose IN ('any', 'sales', 'monitor', 'prep')),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      pair_token_hash TEXT,
      paired_at TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (shop_id, code),
      FOREIGN KEY (shop_id) REFERENCES shop_settings(shop_id)
    );

    CREATE TABLE IF NOT EXISTS shop_terminal_pairing_codes (
      code_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      terminal_id TEXT NOT NULL,
      code_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (terminal_id) REFERENCES shop_terminals(terminal_id) ON DELETE CASCADE,
      FOREIGN KEY (shop_id) REFERENCES shop_settings(shop_id)
    );

    CREATE INDEX IF NOT EXISTS idx_shop_terminals_shop
      ON shop_terminals (shop_id, is_active, display_name);
    CREATE INDEX IF NOT EXISTS idx_terminal_pairing_terminal
      ON shop_terminal_pairing_codes (shop_id, terminal_id, expires_at);
  `);

  const sessionCols = db.prepare(`PRAGMA table_info(staff_sessions)`).all();
  if (!sessionCols.some((c) => c.name === "terminal_id")) {
    db.exec(`ALTER TABLE staff_sessions ADD COLUMN terminal_id TEXT`);
  }

  const orderCols = db.prepare(`PRAGMA table_info(orders)`).all();
  if (!orderCols.some((c) => c.name === "created_by_terminal_id")) {
    db.exec(`ALTER TABLE orders ADD COLUMN created_by_terminal_id TEXT`);
  }
  if (!orderCols.some((c) => c.name === "created_by_terminal_name")) {
    db.exec(`ALTER TABLE orders ADD COLUMN created_by_terminal_name TEXT`);
  }
}
