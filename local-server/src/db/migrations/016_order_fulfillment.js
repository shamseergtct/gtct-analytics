function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function up(db) {
  const columns = [
    ["order_type_id", "order_type_id TEXT"],
    ["order_type_name", "order_type_name TEXT"],
    ["fulfillment_behavior", "fulfillment_behavior TEXT"],
    ["customer_name", "customer_name TEXT"],
    ["customer_phone", "customer_phone TEXT"],
    ["building_number", "building_number TEXT"],
    ["road_number", "road_number TEXT"],
    ["block_number", "block_number TEXT"],
    ["address_note", "address_note TEXT"],
    ["table_number", "table_number TEXT"],
    ["vehicle_number", "vehicle_number TEXT"],
    ["parking_location", "parking_location TEXT"],
    ["configured_delivery_cents", "configured_delivery_cents INTEGER"],
    ["delivery_charge_cents", "delivery_charge_cents INTEGER NOT NULL DEFAULT 0"],
    ["delivery_fee_override", "delivery_fee_override INTEGER NOT NULL DEFAULT 0"],
    ["delivery_fee_tax_treatment", "delivery_fee_tax_treatment TEXT NOT NULL DEFAULT ''"],
    ["created_by_role", "created_by_role TEXT"],
    ["created_by_device_id", "created_by_device_id TEXT"],
  ];
  for (const [name, ddl] of columns) {
    ensureColumn(db, "orders", name, ddl);
  }
}
