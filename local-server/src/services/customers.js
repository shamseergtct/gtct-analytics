import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { normalizeBlockNumber } from "./orderSetup.js";

function fail(status, message, extra = {}) {
  throw Object.assign(new Error(message), { status, ...extra });
}

function clipText(value, max, label) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (text.length > max) fail(400, `${label} is too long.`);
  return text;
}

/**
 * Keep the display form, including leading zeros and a leading +.
 * The key is digits only, with an international 00 prefix removed, for
 * search and duplicate detection inside one shop.
 */
export function parsePhone(value) {
  const phone = clipText(value, 30, "Contact number");
  if (!phone) fail(400, "Enter a contact number.");
  if (!/^[0-9+().\-\s]+$/.test(phone)) fail(400, "Enter a valid contact number.");
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 5 || digits.length > 20) fail(400, "Enter a valid contact number.");
  const phoneKey = digits.startsWith("00") ? digits.slice(2) : digits;
  if (phoneKey.length < 5) fail(400, "Enter a valid contact number.");
  return { phone, phoneKey };
}

function likeContains(value) {
  const escaped = String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

function mapAddress(row) {
  if (!row) return null;
  return {
    addressId: row.address_id,
    customerId: row.customer_id,
    label: row.label || "Home",
    buildingNumber: row.building_number || "",
    roadNumber: row.road_number || "",
    blockNumber: row.block_number || "",
    addressNote: row.address_note || "",
    isDefault: Boolean(row.is_default),
    isActive: Boolean(row.is_active),
  };
}

function mapCustomer(row, addresses = []) {
  if (!row) return null;
  const active = addresses.filter((item) => item.isActive);
  const preferred = active.find((item) => item.isDefault) || active[0] || null;
  return {
    customerId: row.customer_id,
    name: row.name,
    phone: row.phone,
    buildingNumber: preferred ? preferred.buildingNumber : row.building_number || "",
    roadNumber: preferred ? preferred.roadNumber : row.road_number || "",
    blockNumber: preferred ? preferred.blockNumber : row.block_number || "",
    addressNote: preferred ? preferred.addressNote : row.address_note || "",
    addressId: preferred ? preferred.addressId : "",
    addresses: active,
  };
}

function listAddressRows(shopId, customerId) {
  return getDb()
    .prepare(
      `SELECT * FROM shop_customer_addresses
       WHERE shop_id = ? AND customer_id = ? AND is_active = 1
       ORDER BY is_default DESC, created_at, address_id`
    )
    .all(shopId, customerId)
    .map(mapAddress);
}

function addressesByCustomer(shopId, customerIds) {
  const grouped = new Map();
  if (!customerIds.length) return grouped;
  const marks = customerIds.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT * FROM shop_customer_addresses
       WHERE shop_id = ? AND customer_id IN (${marks}) AND is_active = 1
       ORDER BY is_default DESC, created_at, address_id`
    )
    .all(shopId, ...customerIds);
  for (const row of rows) {
    const mapped = mapAddress(row);
    const list = grouped.get(row.customer_id) || [];
    list.push(mapped);
    grouped.set(row.customer_id, list);
  }
  return grouped;
}

function customerRow(shopId, customerId) {
  const id = String(customerId || "").trim();
  if (!id) return null;
  return getDb()
    .prepare(`SELECT * FROM shop_customers WHERE shop_id = ? AND customer_id = ?`)
    .get(shopId, id);
}

export function getCustomer(shopId, customerId) {
  const row = customerRow(shopId, customerId);
  if (!row) return null;
  return mapCustomer(row, listAddressRows(shopId, row.customer_id));
}

export function getCustomerAddress(shopId, customerId, addressId) {
  const id = String(addressId || "").trim();
  if (!id) return null;
  const row = getDb()
    .prepare(
      `SELECT * FROM shop_customer_addresses
       WHERE shop_id = ? AND customer_id = ? AND address_id = ? AND is_active = 1`
    )
    .get(shopId, String(customerId || "").trim(), id);
  return mapAddress(row);
}

export function searchCustomers(shopId, query) {
  const q = String(query ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!q) return [];
  const digits = q.replace(/\D/g, "");
  const key = digits.startsWith("00") ? digits.slice(2) : digits;
  const rows = getDb()
    .prepare(
      `SELECT * FROM shop_customers
       WHERE shop_id = ?
         AND (
           name LIKE ? ESCAPE '\\'
           OR phone LIKE ? ESCAPE '\\'
           OR (? != '' AND phone_key LIKE ? ESCAPE '\\')
         )
       ORDER BY name COLLATE NOCASE
       LIMIT 15`
    )
    .all(shopId, likeContains(q), likeContains(q), key, key ? likeContains(key) : "");
  const grouped = addressesByCustomer(
    shopId,
    rows.map((row) => row.customer_id)
  );
  return rows.map((row) => mapCustomer(row, grouped.get(row.customer_id) || []));
}

function normalizePhoneKey(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("00") ? digits.slice(2) : digits;
}

/**
 * Exact/suffix phone match for caller ID screen-pop.
 * Tries full key, then last 8 digits (common local mobile length).
 */
export function findCustomerByPhone(shopId, phone) {
  const key = normalizePhoneKey(phone);
  if (key.length < 5) return null;
  const db = getDb();
  const byExact = db
    .prepare(
      `SELECT * FROM shop_customers WHERE shop_id = ? AND phone_key = ? LIMIT 1`
    )
    .get(shopId, key);
  if (byExact) {
    return mapCustomer(byExact, listAddressRows(shopId, byExact.customer_id));
  }
  const candidates = [];
  if (key.length > 8) candidates.push(key.slice(-8));
  // Incoming local number may be shorter than a stored international key.
  const rows = db
    .prepare(
      `SELECT * FROM shop_customers
       WHERE shop_id = ?
         AND (
           phone_key = ?
           OR (? != '' AND phone_key LIKE ?)
           OR (? != '' AND ? LIKE '%' || phone_key)
         )
       ORDER BY length(phone_key) DESC
       LIMIT 5`
    )
    .all(
      shopId,
      key,
      candidates[0] || "",
      candidates[0] ? `%${candidates[0]}` : "",
      key,
      key
    );
  if (!rows.length) return null;
  // Prefer unique strong matches only when ambiguous.
  const strong = rows.filter(
    (row) =>
      row.phone_key === key ||
      row.phone_key.endsWith(key) ||
      key.endsWith(row.phone_key)
  );
  const row = (strong.length === 1 ? strong[0] : rows.length === 1 ? rows[0] : null);
  if (!row) return null;
  return mapCustomer(row, listAddressRows(shopId, row.customer_id));
}

function phoneOwner(shopId, phoneKey, exceptCustomerId = "") {
  return getDb()
    .prepare(
      `SELECT * FROM shop_customers
       WHERE shop_id = ? AND phone_key = ? AND customer_id != ?`
    )
    .get(shopId, phoneKey, exceptCustomerId || "");
}

function duplicatePhone(row) {
  const customer = getCustomer(row.shop_id, row.customer_id);
  fail(409, "Customer already exists. Select existing customer.", {
    code: "CUSTOMER_PHONE_EXISTS",
    customer,
  });
}

function mirrorDefaultAddress(shopId, customerId) {
  const address = getDb()
    .prepare(
      `SELECT * FROM shop_customer_addresses
       WHERE shop_id = ? AND customer_id = ? AND is_active = 1
       ORDER BY is_default DESC, created_at, address_id
       LIMIT 1`
    )
    .get(shopId, customerId);
  if (!address) return;
  getDb()
    .prepare(
      `UPDATE shop_customers SET
        building_number = ?,
        road_number = ?,
        block_number = ?,
        address_note = ?,
        updated_at = ?
       WHERE shop_id = ? AND customer_id = ?`
    )
    .run(
      address.building_number || "",
      address.road_number || "",
      address.block_number || "",
      address.address_note || "",
      nowIso(),
      shopId,
      customerId
    );
}

function clearDefault(shopId, customerId) {
  getDb()
    .prepare(
      `UPDATE shop_customer_addresses
       SET is_default = 0, updated_at = ?
       WHERE shop_id = ? AND customer_id = ?`
    )
    .run(nowIso(), shopId, customerId);
}

function readAddressInput(input, { labelFallback = "Home" } = {}) {
  const buildingNumber = clipText(input.buildingNumber, 20, "Building");
  const roadNumber = clipText(input.roadNumber, 20, "Road");
  const addressNote = clipText(input.addressNote, 120, "Address");
  const blockNumber = normalizeBlockNumber(input.blockNumber);
  let label = clipText(input.label, 40, "Address label");
  if (!label) label = labelFallback;
  return { label, buildingNumber, roadNumber, blockNumber, addressNote };
}

function nextLabel(shopId, customerId) {
  const count = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM shop_customer_addresses
       WHERE shop_id = ? AND customer_id = ? AND is_active = 1`
    )
    .get(shopId, customerId).n;
  if (count === 0) return "Home";
  if (count === 1) return "Office";
  return `Address ${count + 1}`;
}

function addressProvided(input) {
  return ["label", "buildingNumber", "roadNumber", "blockNumber", "addressNote"].some((key) =>
    String(input?.[key] ?? "").trim()
  );
}

function insertAddress(shopId, customerId, fields, { isDefault }) {
  const addressId = newId("addr");
  const now = nowIso();
  if (isDefault) clearDefault(shopId, customerId);
  getDb()
    .prepare(
      `INSERT INTO shop_customer_addresses (
        address_id, customer_id, shop_id, label,
        building_number, road_number, block_number, address_note,
        is_default, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .run(
      addressId,
      customerId,
      shopId,
      fields.label,
      fields.buildingNumber,
      fields.roadNumber,
      fields.blockNumber,
      fields.addressNote,
      isDefault ? 1 : 0,
      now,
      now
    );
  return addressId;
}

export function createCustomer(shopId, input = {}) {
  if (input.shopId && input.shopId !== shopId) {
    fail(403, "shopId is not allowed for this server instance");
  }
  const name = clipText(input.name, 80, "Customer name");
  if (!name) fail(400, "Enter a customer name.");
  const { phone, phoneKey } = parsePhone(input.phone);
  const existing = phoneOwner(shopId, phoneKey);
  if (existing) duplicatePhone(existing);
  const withAddress = addressProvided(input);
  const fields = withAddress ? readAddressInput(input, { labelFallback: "Home" }) : null;

  const customerId = newId("cust");
  const now = nowIso();
  const db = getDb();
  const tx = db.transaction(() => {
    const raced = phoneOwner(shopId, phoneKey);
    if (raced) duplicatePhone(raced);
    db.prepare(
      `INSERT INTO shop_customers (
        customer_id, shop_id, name, phone, phone_key,
        building_number, road_number, block_number, address_note,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '', '', '', '', ?, ?)`
    ).run(customerId, shopId, name, phone, phoneKey, now, now);
    if (fields) {
      insertAddress(shopId, customerId, fields, { isDefault: true });
      mirrorDefaultAddress(shopId, customerId);
    }
  });
  try {
    tx();
  } catch (err) {
    if (err?.status) throw err;
    if (/UNIQUE/i.test(String(err?.message || ""))) {
      const raced = phoneOwner(shopId, phoneKey);
      if (raced) duplicatePhone(raced);
    }
    throw err;
  }
  return getCustomer(shopId, customerId);
}

export function updateCustomerProfile(shopId, customerId, input = {}) {
  const row = customerRow(shopId, customerId);
  if (!row) fail(404, "Customer not found.");
  const name = clipText(input.name, 80, "Customer name");
  if (!name) fail(400, "Enter a customer name.");
  const { phone, phoneKey } = parsePhone(input.phone);
  const existing = phoneOwner(shopId, phoneKey, row.customer_id);
  if (existing) duplicatePhone(existing);
  try {
    getDb()
      .prepare(
        `UPDATE shop_customers
         SET name = ?, phone = ?, phone_key = ?, updated_at = ?
         WHERE shop_id = ? AND customer_id = ?`
      )
      .run(name, phone, phoneKey, nowIso(), shopId, row.customer_id);
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message || ""))) {
      const raced = phoneOwner(shopId, phoneKey, row.customer_id);
      if (raced) duplicatePhone(raced);
    }
    throw err;
  }
  return getCustomer(shopId, row.customer_id);
}

export function addCustomerAddress(shopId, customerId, input = {}) {
  const row = customerRow(shopId, customerId);
  if (!row) fail(404, "Customer not found.");
  const fields = readAddressInput(input, { labelFallback: nextLabel(shopId, row.customer_id) });
  const makeDefault = input.isDefault === true || listAddressRows(shopId, row.customer_id).length === 0;
  const db = getDb();
  db.transaction(() => {
    insertAddress(shopId, row.customer_id, fields, { isDefault: makeDefault });
    mirrorDefaultAddress(shopId, row.customer_id);
  })();
  return getCustomer(shopId, row.customer_id);
}

export function updateCustomerAddressById(shopId, customerId, addressId, input = {}) {
  const row = customerRow(shopId, customerId);
  if (!row) fail(404, "Customer not found.");
  const current = getCustomerAddress(shopId, row.customer_id, addressId);
  if (!current) fail(404, "Address not found.");
  const fields = readAddressInput(input, { labelFallback: current.label || "Home" });
  const makeDefault = input.isDefault === true || current.isDefault;
  const db = getDb();
  db.transaction(() => {
    if (makeDefault) clearDefault(shopId, row.customer_id);
    db.prepare(
      `UPDATE shop_customer_addresses SET
        label = ?,
        building_number = ?,
        road_number = ?,
        block_number = ?,
        address_note = ?,
        is_default = ?,
        updated_at = ?
       WHERE shop_id = ? AND customer_id = ? AND address_id = ?`
    ).run(
      fields.label,
      fields.buildingNumber,
      fields.roadNumber,
      fields.blockNumber,
      fields.addressNote,
      makeDefault ? 1 : 0,
      nowIso(),
      shopId,
      row.customer_id,
      current.addressId
    );
    mirrorDefaultAddress(shopId, row.customer_id);
  })();
  return getCustomer(shopId, row.customer_id);
}

/**
 * Updates the customer's default saved address. Does not change the phone
 * or any block-rate master, and does not rewrite other addresses.
 */
export function updateCustomerAddress(shopId, customerId, input = {}) {
  const customer = getCustomer(shopId, customerId);
  if (!customer) fail(404, "Customer not found.");
  const target =
    (input.addressId &&
      customer.addresses.find((item) => item.addressId === String(input.addressId))) ||
    customer.addresses.find((item) => item.isDefault) ||
    customer.addresses[0];
  if (!target) return addCustomerAddress(shopId, customer.customerId, { ...input, isDefault: true });
  return updateCustomerAddressById(shopId, customer.customerId, target.addressId, {
    ...input,
    label: input.label || target.label,
    isDefault: target.isDefault || input.isDefault === true,
  });
}
