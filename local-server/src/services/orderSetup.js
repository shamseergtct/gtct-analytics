import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { getCustomer, getCustomerAddress } from "./customers.js";

const BEHAVIORS = {
  COUNTER: { label: "Counter", fields: [] },
  TAKEAWAY: { label: "Takeaway", fields: [] },
  DELIVERY: {
    label: "Delivery",
    fields: [{ key: "blockNumber", label: "Block number", required: true }],
  },
  TABLE: {
    label: "Table",
    fields: [{ key: "tableNumber", label: "Table number", required: true }],
  },
  CAR_HOP: {
    label: "Car-Hop",
    fields: [
      { key: "vehicleNumber", label: "Vehicle number", required: false },
      { key: "parkingLocation", label: "Parking location", required: false },
    ],
  },
};

const DEFAULT_TYPES = [
  ["otype_takeaway", "TAKEAWAY", "Takeaway", "TAKEAWAY", 1, 10],
  ["otype_dine_in", "DINE_IN", "Dine in", "TABLE", 1, 20],
  ["otype_counter", "COUNTER", "Counter", "COUNTER", 1, 30],
  ["otype_delivery", "DELIVERY", "Delivery", "DELIVERY", 1, 40],
  ["otype_car_hop", "CAR_HOP", "Car-Hop", "CAR_HOP", 1, 50],
];

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

export function behaviorFieldRequirements(behavior) {
  const spec = BEHAVIORS[behavior];
  if (!spec) return [];
  return spec.fields.map((field) => ({ ...field }));
}

function mapType(row, referenced) {
  return {
    orderTypeId: row.order_type_id,
    code: row.code,
    name: row.name,
    behavior: row.behavior,
    behaviorLabel: BEHAVIORS[row.behavior]?.label || row.behavior,
    fieldRequirements: behaviorFieldRequirements(row.behavior),
    isActive: Boolean(row.is_active),
    sortOrder: row.sort_order,
    behaviorLocked: referenced,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRate(row) {
  return {
    rateId: row.rate_id,
    blockNumber: row.block_number,
    chargeCents: row.charge_cents,
    taxApplicable: Boolean(row.tax_applicable),
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readTaxApplicable(input, existing) {
  if (input.taxApplicable == null) {
    return existing && existing.tax_applicable ? 1 : 0;
  }
  return input.taxApplicable === false || input.taxApplicable === 0 ? 0 : 1;
}

function normalizeName(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function normalizeBlockNumber(value) {
  const compact = String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9-]{1,20}$/.test(compact)) {
    fail(400, "Enter a block number using letters, numbers, or hyphens (max 20).");
  }
  return compact;
}

function displayBlockNumber(value, norm) {
  const trimmed = String(value ?? "").trim().replace(/\s+/g, " ");
  return trimmed || norm;
}

function isReferenced(db, shopId, code) {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM orders
       WHERE tenant_id = ? AND order_type = ?
       LIMIT 1`
    )
    .get(shopId, code);
  return Boolean(row);
}

export function ensureDefaultOrderTypes(shopId) {
  const db = getDb();
  const now = nowIso();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO shop_order_types (
      order_type_id, shop_id, code, name, name_norm, behavior,
      is_active, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of DEFAULT_TYPES) {
    insert.run(
      row[0],
      shopId,
      row[1],
      row[2],
      normalizeName(row[2]),
      row[3],
      row[4],
      row[5],
      now,
      now
    );
  }
}

export function listOrderTypes(shopId) {
  ensureDefaultOrderTypes(shopId);
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM shop_order_types
       WHERE shop_id = ?
       ORDER BY sort_order ASC, name COLLATE NOCASE ASC`
    )
    .all(shopId);
  return rows.map((row) => mapType(row, isReferenced(db, shopId, row.code)));
}

export function upsertOrderType(shopId, input = {}) {
  const db = getDb();
  ensureDefaultOrderTypes(shopId);
  const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 40) fail(400, "Enter a display name (max 40 characters).");
  const behavior = String(input.behavior || "").trim();
  if (!BEHAVIORS[behavior]) fail(400, "Choose a fulfillment behavior.");
  const isActive = input.isActive === false ? 0 : 1;
  const nameNorm = normalizeName(name);
  const now = nowIso();

  const existing = input.orderTypeId
    ? db
        .prepare(
          `SELECT * FROM shop_order_types WHERE shop_id = ? AND order_type_id = ?`
        )
        .get(shopId, input.orderTypeId)
    : null;
  if (input.orderTypeId && !existing) fail(404, "Order type not found.");

  const dup = db
    .prepare(
      `SELECT order_type_id FROM shop_order_types
       WHERE shop_id = ? AND name_norm = ? AND order_type_id != ?`
    )
    .get(shopId, nameNorm, existing?.order_type_id || "");
  if (dup) fail(409, "An order type with that name already exists.");

  if (existing) {
    if (behavior !== existing.behavior && isReferenced(db, shopId, existing.code)) {
      fail(409, "This order type is already used on orders. Its fulfillment behavior is locked.");
    }
    db.prepare(
      `UPDATE shop_order_types
       SET name = ?, name_norm = ?, behavior = ?, is_active = ?, updated_at = ?
       WHERE order_type_id = ?`
    ).run(name, nameNorm, behavior, isActive, now, existing.order_type_id);
    const row = db
      .prepare(`SELECT * FROM shop_order_types WHERE order_type_id = ?`)
      .get(existing.order_type_id);
    return mapType(row, isReferenced(db, shopId, row.code));
  }

  const orderTypeId = newId("otype");
  const code = `C${newId("").replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  const maxSort = db
    .prepare(`SELECT COALESCE(MAX(sort_order), 0) AS n FROM shop_order_types WHERE shop_id = ?`)
    .get(shopId).n;
  db.prepare(
    `INSERT INTO shop_order_types (
      order_type_id, shop_id, code, name, name_norm, behavior,
      is_active, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(orderTypeId, shopId, code, name, nameNorm, behavior, isActive, maxSort + 10, now, now);
  const row = db
    .prepare(`SELECT * FROM shop_order_types WHERE order_type_id = ?`)
    .get(orderTypeId);
  return mapType(row, false);
}

export function reorderOrderTypes(shopId, orderTypeIds) {
  if (!Array.isArray(orderTypeIds) || orderTypeIds.length === 0) {
    fail(400, "Provide the order type list.");
  }
  const db = getDb();
  ensureDefaultOrderTypes(shopId);
  const rows = db
    .prepare(`SELECT order_type_id FROM shop_order_types WHERE shop_id = ?`)
    .all(shopId);
  const known = new Set(rows.map((row) => row.order_type_id));
  if (orderTypeIds.length !== known.size || new Set(orderTypeIds).size !== known.size) {
    fail(400, "Reorder must include every order type once.");
  }
  for (const id of orderTypeIds) {
    if (!known.has(id)) fail(400, "Unknown order type.");
  }
  const now = nowIso();
  const update = db.prepare(
    `UPDATE shop_order_types SET sort_order = ?, updated_at = ? WHERE order_type_id = ? AND shop_id = ?`
  );
  db.transaction(() => {
    orderTypeIds.forEach((id, index) => {
      update.run((index + 1) * 10, now, id, shopId);
    });
  })();
  return listOrderTypes(shopId);
}

export function listBlockRates(shopId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM shop_block_delivery_rates
       WHERE shop_id = ?
       ORDER BY block_norm ASC`
    )
    .all(shopId)
    .map(mapRate);
}

export function upsertBlockRate(shopId, input = {}) {
  const db = getDb();
  const blockNorm = normalizeBlockNumber(input.blockNumber);
  const blockNumber = displayBlockNumber(input.blockNumber, blockNorm);
  if (input.chargeCents == null || input.chargeCents === "") {
    fail(400, "Enter a delivery charge.");
  }
  const charge = Number(input.chargeCents);
  if (!Number.isInteger(charge)) fail(400, "Delivery charge must be an integer minor-unit amount.");
  if (charge < 0) fail(400, "Delivery charge cannot be negative.");
  const isActive = input.isActive === false ? 0 : 1;
  const now = nowIso();

  const existing = input.rateId
    ? db
        .prepare(
          `SELECT * FROM shop_block_delivery_rates WHERE shop_id = ? AND rate_id = ?`
        )
        .get(shopId, input.rateId)
    : null;
  if (input.rateId && !existing) fail(404, "Block rate not found.");

  const dup = db
    .prepare(
      `SELECT rate_id FROM shop_block_delivery_rates
       WHERE shop_id = ? AND block_norm = ? AND rate_id != ?`
    )
    .get(shopId, blockNorm, existing?.rate_id || "");
  if (dup) fail(409, "That block number already has a delivery charge.");

  const taxApplicable = readTaxApplicable(input, existing);

  if (existing) {
    db.prepare(
      `UPDATE shop_block_delivery_rates
       SET block_number = ?, block_norm = ?, charge_cents = ?, tax_applicable = ?, is_active = ?, updated_at = ?
       WHERE rate_id = ?`
    ).run(blockNumber, blockNorm, charge, taxApplicable, isActive, now, existing.rate_id);
    return mapRate(
      db.prepare(`SELECT * FROM shop_block_delivery_rates WHERE rate_id = ?`).get(existing.rate_id)
    );
  }

  const rateId = newId("dblock");
  db.prepare(
    `INSERT INTO shop_block_delivery_rates (
      rate_id, shop_id, block_number, block_norm, charge_cents, tax_applicable,
      is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(rateId, shopId, blockNumber, blockNorm, charge, taxApplicable, isActive, now, now);
  return mapRate(
    db.prepare(`SELECT * FROM shop_block_delivery_rates WHERE rate_id = ?`).get(rateId)
  );
}

/** Approved shop policy: delivery fees are not taxed. Item and add-on tax is unchanged. */
export const DELIVERY_FEE_TAX_TREATMENT = "not_applied";

function clipText(value, max, label) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (text.length > max) fail(400, `${label} is too long.`);
  return text;
}

function readDeliveryCharge(value) {
  if (value == null || value === "") fail(400, "Enter a delivery charge.");
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) fail(400, "Enter a valid delivery charge.");
  if (!Number.isSafeInteger(n)) {
    fail(400, "Delivery charge must be an integer minor-unit amount.");
  }
  if (n < 0) fail(400, "Delivery charge cannot be negative.");
  return n;
}

function rejectStrayDeliveryCharge(fulfillment) {
  if (fulfillment.deliveryChargeCents == null || fulfillment.deliveryChargeCents === "") return;
  const n = Number(fulfillment.deliveryChargeCents);
  if (Number.isFinite(n) && n !== 0) {
    fail(400, "Delivery charge applies only to delivery orders.");
  }
}

function rememberCustomer(shopId, fulfillment, snapshot) {
  const customerId = String(fulfillment.customerId || "").trim();
  if (!customerId) return false;
  const customer = getCustomer(shopId, customerId);
  if (!customer) fail(400, "Select a customer.");
  snapshot.customerId = customer.customerId;
  snapshot.customerName = customer.name;
  snapshot.customerPhone = customer.phone || "";
  return true;
}

function findBlockRateRow(shopId, blockNumber) {
  const blockNorm = normalizeBlockNumber(blockNumber);
  const row = getDb()
    .prepare(
      `SELECT * FROM shop_block_delivery_rates
       WHERE shop_id = ? AND block_norm = ?`
    )
    .get(shopId, blockNorm);
  return { blockNorm, row };
}

export function getActiveBlockRate(shopId, blockNumber) {
  const { row } = findBlockRateRow(shopId, blockNumber);
  if (!row) fail(400, "No delivery charge is configured for this block.");
  if (!row.is_active) fail(400, "This block delivery charge is inactive.");
  return mapRate(row);
}

function resolveActiveOrderType(shopId, input) {
  ensureDefaultOrderTypes(shopId);
  const db = getDb();
  const orderTypeId = String(input.orderTypeId || "").trim();
  const code = String(input.orderType || "").trim();
  const row = orderTypeId
    ? db
        .prepare(
          `SELECT * FROM shop_order_types WHERE shop_id = ? AND order_type_id = ?`
        )
        .get(shopId, orderTypeId)
    : code
      ? db
          .prepare(`SELECT * FROM shop_order_types WHERE shop_id = ? AND code = ?`)
          .get(shopId, code)
      : null;
  if (!row) fail(400, "Choose an order type.");
  if (!row.is_active) fail(400, "This order type is inactive.");
  return mapType(row, false);
}

function rateChanged(rate) {
  throw Object.assign(
    new Error(
      "The block delivery rate changed. Review the new suggested charge before sending."
    ),
    {
      status: 409,
      code: "DELIVERY_RATE_CHANGED",
      configuredChargeCents: rate.chargeCents,
      blockNumber: rate.blockNumber,
    }
  );
}

/**
 * Resolve the order-type snapshot and any delivery fee for a new sale.
 * Display names are not used as identifiers. A manual delivery fee is
 * order-specific and does not change the block rate master.
 */
export function resolveSaleFulfillment(shopId, input = {}) {
  const type = resolveActiveOrderType(shopId, input);
  const fulfillment =
    input.fulfillment && typeof input.fulfillment === "object" ? input.fulfillment : {};
  const legacyDestination = clipText(input.destination, 160, "Destination");
  const snapshot = {
    orderTypeId: type.orderTypeId,
    code: type.code,
    name: type.name,
    behavior: type.behavior,
    customerName: "",
    customerPhone: "",
    buildingNumber: "",
    roadNumber: "",
    blockNumber: "",
    addressNote: "",
    addressLabel: "",
    tableNumber: "",
    vehicleNumber: "",
    parkingLocation: "",
    customerId: "",
    addressId: "",
    configuredChargeCents: null,
    deliveryChargeCents: 0,
    deliveryFeeOverride: false,
    deliveryRateSource: "",
    deliveryFeeTaxApplicable: false,
    deliveryFeeTaxTreatment: DELIVERY_FEE_TAX_TREATMENT,
    destination: legacyDestination,
  };

  if (type.behavior === "DELIVERY") {
    const customer = getCustomer(shopId, fulfillment.customerId);
    if (!customer) fail(400, "Select a customer.");
    if (!customer.phone) fail(400, "A contact number is required.");
    const requestedAddressId = String(fulfillment.addressId || "").trim();
    if (requestedAddressId) {
      const owned = getCustomerAddress(shopId, customer.customerId, requestedAddressId);
      if (!owned) fail(400, "That address does not belong to this customer.");
      snapshot.addressId = owned.addressId;
      snapshot.addressLabel = clipText(owned.label, 40, "Address type");
    }
    const { blockNorm, row } = findBlockRateRow(shopId, fulfillment.blockNumber);
    if (row && !row.is_active) fail(400, "This block delivery charge is inactive.");
    const rate = row ? mapRate(row) : null;
    const override = fulfillment.deliveryFeeOverride === true;
    let charge;
    if (rate) {
      const expected = fulfillment.expectedBlockRateCents;
      if (expected != null && expected !== "") {
        const quoted = readDeliveryCharge(expected);
        if (!override && quoted !== rate.chargeCents) rateChanged(rate);
      }
      charge = readDeliveryCharge(fulfillment.deliveryChargeCents);
      if (!override && charge !== rate.chargeCents) rateChanged(rate);
    } else if (!override) {
      fail(400, "No saved rate for this block. Enter a delivery charge.");
    } else {
      charge = readDeliveryCharge(fulfillment.deliveryChargeCents);
    }
    snapshot.customerId = customer.customerId;
    snapshot.customerName = customer.name;
    snapshot.customerPhone = customer.phone;
    snapshot.buildingNumber = clipText(fulfillment.buildingNumber, 20, "Building");
    snapshot.roadNumber = clipText(fulfillment.roadNumber, 20, "Road");
    snapshot.addressNote = clipText(fulfillment.addressNote, 120, "Address");
    snapshot.blockNumber = rate ? rate.blockNumber : blockNorm;
    snapshot.configuredChargeCents = rate ? rate.chargeCents : null;
    snapshot.deliveryChargeCents = charge;
    snapshot.deliveryFeeOverride = rate ? override : true;
    snapshot.deliveryFeeTaxApplicable = Boolean(rate?.taxApplicable);
    snapshot.deliveryFeeTaxTreatment = snapshot.deliveryFeeTaxApplicable
      ? "applied"
      : DELIVERY_FEE_TAX_TREATMENT;
    snapshot.deliveryRateSource = rate ? "master" : "unlisted";
    const parts = [`Block ${snapshot.blockNumber}`];
    if (snapshot.buildingNumber) parts.push(`Bldg ${snapshot.buildingNumber}`);
    if (snapshot.roadNumber) parts.push(`Road ${snapshot.roadNumber}`);
    if (snapshot.addressNote) parts.push(snapshot.addressNote);
    snapshot.destination = parts.join(", ").slice(0, 160);
    return snapshot;
  }

  rejectStrayDeliveryCharge(fulfillment);

  if (type.behavior === "TABLE") {
    const table = clipText(fulfillment.tableNumber, 20, "Table number");
    if (!table) fail(400, "Enter a table number.");
    rememberCustomer(shopId, fulfillment, snapshot);
    snapshot.tableNumber = table;
    snapshot.destination = `Table ${table}`;
    return snapshot;
  }

  if (type.behavior === "CAR_HOP") {
    rememberCustomer(shopId, fulfillment, snapshot);
    snapshot.vehicleNumber = clipText(fulfillment.vehicleNumber, 30, "Vehicle number");
    snapshot.parkingLocation = clipText(
      fulfillment.parkingLocation,
      80,
      "Parking location"
    );
    snapshot.destination = [snapshot.vehicleNumber, snapshot.parkingLocation]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 160);
    return snapshot;
  }

  if (type.behavior === "TAKEAWAY") {
    if (!rememberCustomer(shopId, fulfillment, snapshot)) {
      snapshot.customerName = clipText(fulfillment.customerName, 80, "Customer name");
      snapshot.customerPhone = clipText(fulfillment.customerPhone, 30, "Phone");
    }
    const parts = [snapshot.customerName, snapshot.customerPhone].filter(Boolean);
    snapshot.destination = (parts.join(" · ") || legacyDestination).slice(0, 160);
    return snapshot;
  }

  rememberCustomer(shopId, fulfillment, snapshot);
  snapshot.destination = clipText(
    fulfillment.counterLabel || legacyDestination,
    160,
    "Destination"
  );
  return snapshot;
}
