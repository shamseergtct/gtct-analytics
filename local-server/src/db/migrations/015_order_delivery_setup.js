const SHOP_ID = "test-tenant-phase1";

const DEFAULT_TYPES = [
  ["otype_takeaway", "TAKEAWAY", "Takeaway", "TAKEAWAY", 1, 10],
  ["otype_dine_in", "DINE_IN", "Dine in", "TABLE", 1, 20],
  ["otype_counter", "COUNTER", "Counter", "COUNTER", 1, 30],
  ["otype_delivery", "DELIVERY", "Delivery", "DELIVERY", 1, 40],
  ["otype_car_hop", "CAR_HOP", "Car-Hop", "CAR_HOP", 1, 50],
];

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_order_types (
      order_type_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      name_norm TEXT NOT NULL,
      behavior TEXT NOT NULL CHECK (
        behavior IN ('COUNTER', 'TAKEAWAY', 'DELIVERY', 'TABLE', 'CAR_HOP')
      ),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (shop_id, code),
      UNIQUE (shop_id, name_norm)
    );

    CREATE TABLE IF NOT EXISTS shop_block_delivery_rates (
      rate_id TEXT PRIMARY KEY,
      shop_id TEXT NOT NULL,
      block_number TEXT NOT NULL,
      block_norm TEXT NOT NULL,
      charge_cents INTEGER NOT NULL CHECK (charge_cents >= 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (shop_id, block_norm)
    );

    CREATE INDEX IF NOT EXISTS idx_shop_order_types_shop
      ON shop_order_types(shop_id, sort_order, name);
    CREATE INDEX IF NOT EXISTS idx_shop_block_rates_shop
      ON shop_block_delivery_rates(shop_id, block_norm);
  `);

  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO shop_order_types (
      order_type_id, shop_id, code, name, name_norm, behavior,
      is_active, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of DEFAULT_TYPES) {
    insert.run(row[0], SHOP_ID, row[1], row[2], row[2].trim().toLowerCase(), row[3], row[4], row[5], now, now);
  }
}
