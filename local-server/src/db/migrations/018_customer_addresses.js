function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_customer_addresses (
      address_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT 'Home',
      building_number TEXT NOT NULL DEFAULT '',
      road_number TEXT NOT NULL DEFAULT '',
      block_number TEXT NOT NULL DEFAULT '',
      address_note TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer
      ON shop_customer_addresses (shop_id, customer_id);
  `);
  const dupes = db
    .prepare(
      `SELECT shop_id, phone_key, COUNT(*) AS n
       FROM shop_customers
       GROUP BY shop_id, phone_key
       HAVING n > 1`
    )
    .all();
  if (!dupes.length) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shop_customers_phone
        ON shop_customers (shop_id, phone_key);
    `);
  }
  const customers = db.prepare(`SELECT * FROM shop_customers`).all();
  const hasAddress = db.prepare(
    `SELECT 1 AS hit FROM shop_customer_addresses
     WHERE shop_id = ? AND customer_id = ? LIMIT 1`
  );
  const insert = db.prepare(
    `INSERT INTO shop_customer_addresses (
      address_id, customer_id, shop_id, label,
      building_number, road_number, block_number, address_note,
      is_default, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, 'Home', ?, ?, ?, ?, 1, 1, ?, ?)`
  );
  for (const row of customers) {
    if (hasAddress.get(row.shop_id, row.customer_id)) continue;
    const addressId = `addr_${row.customer_id.replace(/^cust_/, "")}`;
    insert.run(
      addressId,
      row.customer_id,
      row.shop_id,
      row.building_number || "",
      row.road_number || "",
      row.block_number || "",
      row.address_note || "",
      row.created_at,
      row.updated_at
    );
  }
  ensureColumn(db, "orders", "customer_address_id", "customer_address_id TEXT");
}
