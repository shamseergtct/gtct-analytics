import { getDb } from "../db/db.js";
import { getShopSettings } from "./shopSettings.js";
import { listOrderTypes } from "./orderSetup.js";
import { getOrder } from "./orders.js";
import { getOrderPayment } from "./settlements.js";
import { readOrderOperationalState } from "./orderOperationalState.js";

const BEHAVIORS = new Set(["COUNTER", "TAKEAWAY", "DELIVERY", "TABLE", "CAR_HOP"]);
const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 80;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function clean(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function likePattern(value) {
  return `%${clean(value, 80).replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Tokens reset per business shift and are stored as integers. UI displays 001,
 * while SQLite stores 1; CAST(token_number AS TEXT) LIKE '%001%' misses it.
 * An explicit "Token 001" / "#001" query searches only the token field.
 * A bare "001" also matches the exact token, alongside existing text search.
 */
function tokenSearch(query) {
  const q = clean(query, 80);
  const tagged = /^(?:token(?:\s*(?:number|no\.?))?\s*[:#-]?\s*|#)(\d+)$/i.exec(q);
  const bare = /^\d+$/.test(q);
  if (!tagged && !bare) return { explicit: false, number: null };
  const digits = tagged ? tagged[1] : q;
  // Reject invalid/unsafe numbers instead of silently rounding a token.
  const number = Number(digits);
  return {
    explicit: !!tagged,
    number: Number.isSafeInteger(number) && number > 0 ? number : null,
  };
}

function dayRange(dateStr, timeZone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) fail(400, "Choose a valid date.");
  const zone = timeZone || "UTC";
  const start = zonedInstant(dateStr, "00:00:00", zone);
  const next = new Date(`${dateStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const end = zonedInstant(next.toISOString().slice(0, 10), "00:00:00", zone);
  return { start, end };
}

function zonedInstant(dateStr, time, timeZone) {
  const utc = new Date(`${dateStr}T${time}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(utc)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second)
  );
  return new Date(utc.getTime() - (asUtc - utc.getTime())).toISOString();
}

function numericRank(column) {
  const value = `TRIM(COALESCE(${column}, ''))`;
  return `
    CASE WHEN ${value} = '' THEN 1 ELSE 0 END,
    CASE WHEN ${value} GLOB '[0-9]*' THEN CAST(${column} AS INTEGER) ELSE 2147483647 END,
    LOWER(${value})
  `;
}

function summary(row) {
  return {
    orderId: row.order_id,
    orderNumber: row.order_number,
    // Existing unique shop sequence is the permanent TEST invoice reference.
    invoiceNumber: row.order_number,
    businessDate: row.business_date || "",
    businessShiftId: row.business_shift_id || "",
    tokenNumber: row.token_number == null ? null : Number(row.token_number),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orderTypeName: row.order_type_name || row.order_type || "",
    orderTypeCode: row.order_type || "",
    fulfillmentBehavior: row.fulfillment_behavior || "",
    fulfillmentStatus: row.status || "",
    customerName: row.customer_name || "",
    customerPhone: row.customer_phone || "",
    totalCents: Number(row.total_cents || 0),
    currencyCode: row.currency_code || "",
    currencyLabel: row.currency_label || row.currency_code || "",
    currencyDecimals: Number(row.currency_decimals != null ? row.currency_decimals : 2),
    paymentStatus: row.payment_status || "UNPAID",
    paymentTender: row.tender || "",
    bankAccountLabel: row.bank_account_label || "",
    createdByName: row.created_by_name || "",
    blockNumber: row.block_number || "",
    roadNumber: row.road_number || "",
    buildingNumber: row.building_number || "",
    addressNote: row.address_note || "",
    addressLabel: row.address_label || "",
    tableNumber: row.table_number || "",
    vehicleNumber: row.vehicle_number || "",
    parkingLocation: row.parking_location || "",
    deliveryChargeCents: Number(row.delivery_charge_cents || 0),
  };
}

function groupDelivery(orders) {
  const blocks = [];
  const incomplete = [];
  const byBlock = new Map();
  for (const order of orders) {
    if (!order.blockNumber) {
      incomplete.push(order);
      continue;
    }
    let block = byBlock.get(order.blockNumber);
    if (!block) {
      block = { blockNumber: order.blockNumber, roads: [], byRoad: new Map() };
      byBlock.set(order.blockNumber, block);
      blocks.push(block);
    }
    const roadKey = order.roadNumber || "";
    let road = block.byRoad.get(roadKey);
    if (!road) {
      road = { roadNumber: order.roadNumber, buildings: [], byBuilding: new Map() };
      block.byRoad.set(roadKey, road);
      block.roads.push(road);
    }
    const buildingKey = order.buildingNumber || "";
    let building = road.byBuilding.get(buildingKey);
    if (!building) {
      building = { buildingNumber: order.buildingNumber, orders: [] };
      road.byBuilding.set(buildingKey, building);
      road.buildings.push(building);
    }
    building.orders.push(order);
  }
  return {
    blocks: blocks.map(({ blockNumber, roads }) => ({
      blockNumber,
      roads: roads.map(({ roadNumber, buildings }) => ({
        roadNumber,
        buildings,
      })),
    })),
    incomplete,
  };
}

function filtersFrom(shopId, query) {
  const behavior = clean(query.get("behavior"), 20).toUpperCase();
  if (behavior && !BEHAVIORS.has(behavior)) fail(400, "Unknown order type.");
  const page = Math.max(1, Number(query.get("page")) || 1);
  const requestedSize = Number(query.get("pageSize")) || DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(requestedSize) || requestedSize < 1) {
    fail(400, "Page size is invalid.");
  }
  const pageSize = Math.min(requestedSize, MAX_PAGE_SIZE);
  const date = clean(query.get("date"), 10);
  let range = null;
  if (date) {
    const shop = getShopSettings(shopId);
    range = dayRange(date, shop.timezone);
  }
  return {
    behavior,
    orderTypeId: clean(query.get("orderTypeId"), 80),
    q: clean(query.get("q"), 80),
    block: clean(query.get("block"), 20),
    road: clean(query.get("road"), 20),
    building: clean(query.get("building"), 20),
    addressLabel: clean(query.get("addressLabel"), 40),
    page,
    pageSize,
    range,
    businessDate: date,
  };
}

function whereClause(shopId, filters) {
  const clauses = ["o.tenant_id = ?"];
  const params = [shopId];
  if (filters.behavior) {
    clauses.push("o.fulfillment_behavior = ?");
    params.push(filters.behavior);
  }
  if (filters.orderTypeId) {
    clauses.push("o.order_type_id = ?");
    params.push(filters.orderTypeId);
  }
  if (filters.block) {
    clauses.push("o.block_number = ?");
    params.push(filters.block);
  }
  if (filters.road) {
    clauses.push("o.road_number = ?");
    params.push(filters.road);
  }
  if (filters.building) {
    clauses.push("o.building_number = ?");
    params.push(filters.building);
  }
  if (filters.addressLabel) {
    clauses.push("LOWER(COALESCE(o.address_label, '')) = LOWER(?)");
    params.push(filters.addressLabel);
  }
  if (filters.range) {
    // New orders belong to the opening shift business date even after midnight.
    // Historical pre-shift orders remain searchable by their creation date.
    clauses.push("(o.business_date = ? OR (o.business_date IS NULL AND o.created_at >= ? AND o.created_at < ?))");
    const shiftBusinessDate = filters.businessDate;
    params.push(shiftBusinessDate, filters.range.start, filters.range.end);
  }
  if (filters.q) {
    const token = tokenSearch(filters.q);
    if (token.explicit) {
      // Exact shift token search, including padded input such as "Token 001".
      clauses.push(token.number == null ? "1 = 0" : "o.token_number = ?");
      if (token.number != null) params.push(token.number);
    } else {
      // Keep invoice/customer/phone/address search intact. Bare digits also
      // match the EXACT token; "001" correctly finds token_number = 1.
      const pattern = likePattern(filters.q);
      const textMatch = `(
        o.order_number LIKE ? ESCAPE '\\' OR
        o.customer_name LIKE ? ESCAPE '\\' OR
        o.customer_phone LIKE ? ESCAPE '\\' OR
        o.block_number LIKE ? ESCAPE '\\' OR
        o.road_number LIKE ? ESCAPE '\\' OR
        o.building_number LIKE ? ESCAPE '\\'
      )`;
      if (token.number != null) {
        clauses.push(`(o.token_number = ? OR ${textMatch})`);
        params.push(token.number);
      } else {
        clauses.push(textMatch);
      }
      params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }
  }
  return { sql: clauses.join(" AND "), params };
}

const LIST_FROM = `
  FROM orders o
  LEFT JOIN staff_users u
    ON u.user_id = o.created_by_user_id AND u.shop_id = o.tenant_id
  LEFT JOIN order_payment_balances b
    ON b.shop_id = o.tenant_id AND b.order_id = o.order_id
  LEFT JOIN order_settlements s
    ON s.shop_id = o.tenant_id AND s.order_id = o.order_id
  LEFT JOIN shop_bank_accounts a
    ON a.account_id = s.bank_account_id AND a.shop_id = o.tenant_id
`;

const LIST_SELECT = `
  SELECT o.*,
         u.full_name AS created_by_name,
         b.payment_status AS payment_status,
         s.tender AS tender,
         CASE
           WHEN a.account_id IS NULL THEN ''
           ELSE a.display_name || ' · ' || a.bank_name || ' ' || a.masked_reference
         END AS bank_account_label
`;

export function listOrderRegister(shopId, query) {
  const filters = filtersFrom(shopId, query);
  const db = getDb();
  const where = whereClause(shopId, filters);
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE ${where.sql}`).get(...where.params).n
  );
  const orderBy =
    filters.behavior === "DELIVERY"
      ? `${numericRank("o.block_number")}, ${numericRank("o.road_number")}, ${numericRank("o.building_number")}, o.created_at DESC`
      : "o.created_at DESC";
  const offset = (filters.page - 1) * filters.pageSize;
  const rows = db
    .prepare(
      `${LIST_SELECT} ${LIST_FROM} WHERE ${where.sql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    )
    .all(...where.params, filters.pageSize, offset)
    .map((row) => {
      const stage = readOrderOperationalState(db, shopId, row);
      const payment = getOrderPayment(row.order_id,shopId);
      return { ...summary(row), paymentStatus:payment.paymentStatus,
        cashCents:payment.cashCents, bankCents:payment.bankCents,
        creditCents:payment.creditCents, unallocatedCents:payment.unallocatedCents,
        hasAllocations:payment.hasAllocations, operationalStatus: stage.operationalStatus,
        kitchenStatus: stage.kitchenStatus, dispatchStatus: stage.dispatchStatus,
        deliveryBoyName: stage.deliveryBoyName, deliveryPaymentReport: stage.deliveryPaymentReport };
    });
  const labels = db
    .prepare(
      `SELECT DISTINCT address_label AS label
       FROM orders
       WHERE tenant_id = ? AND TRIM(COALESCE(address_label, '')) != ''
       ORDER BY LOWER(address_label)`
    )
    .all(shopId)
    .map((row) => row.label);
  const types = listOrderTypes(shopId)
    .filter((type) => type.isActive)
    .map((type) => ({
      orderTypeId: type.orderTypeId,
      code: type.code,
      name: type.name,
      behavior: type.behavior,
    }));
  return {
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    orderTypes: types,
    addressLabels: labels,
    orders: rows,
    deliveryGroups: filters.behavior === "DELIVERY" ? groupDelivery(rows) : null,
  };
}

export function getOrderRegisterDetail(shopId, orderId) {
  const db = getDb();
  const row = db
    .prepare(
      `${LIST_SELECT} ${LIST_FROM} WHERE o.tenant_id = ? AND o.order_id = ?`
    )
    .get(shopId, String(orderId || "").trim());
  if (!row) fail(404, "Order not found.");
  const order = getOrder(row.order_id);
  const payment = getOrderPayment(row.order_id, shopId);
  return {
    ...summary(row),
    ...(() => {
      const stage = readOrderOperationalState(db, shopId, row);
      return { operationalStatus: stage.operationalStatus, kitchenStatus: stage.kitchenStatus,
        dispatchStatus: stage.dispatchStatus, deliveryBoyName: stage.deliveryBoyName, deliveryPaymentReport: stage.deliveryPaymentReport };
    })(),
    goodsCents: Number(order.goods_cents || 0),
    taxCents: Number(order.tax_cents || 0),
    taxName: order.tax_name || "",
    destination: order.destination || "",
    paymentStatus: payment.paymentStatus,
    paidCents: payment.paidCents,
    balanceCents: payment.balanceCents,
    cashCents: payment.cashCents,
    bankCents: payment.bankCents,
    creditCents: payment.creditCents,
    unallocatedCents: payment.unallocatedCents,
    hasAllocations: payment.hasAllocations,
    paymentTender: payment.settlement?.tender || "",
    bankAccountLabel: payment.settlement?.bankAccountLabel || "",
    lines: (order.lines || []).map((line) => ({
      itemName: line.item_name,
      quantity: line.quantity,
      variantName: line.variant_name || "",
      instructions: line.instructions || [],
      addons: (line.addons || []).map((addon) => ({
        name: addon.name,
        quantity: addon.quantity,
      })),
      unitTotalCents: Number(line.unit_total_cents || 0),
      lineTotalCents: Number(line.line_total_cents || 0),
    })),
  };
}
