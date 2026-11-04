import { getDb } from "../db/db.js";
import { nowIso } from "../util/time.js";
import { getShopSettings } from "./shopSettings.js";
import { getStation } from "./stations.js";

const CASHIER_STATION = "station_cashier";

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

function startOfShopDay(timeZone) {
  const zone = timeZone || "UTC";
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const utcGuess = new Date(`${dateStr}T00:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(utcGuess)
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
  return new Date(utcGuess.getTime() - (asUtc - utcGuess.getTime())).toISOString();
}

function listPrepStations() {
  return getDb()
    .prepare(
      `SELECT station_id, name
       FROM stations
       WHERE is_active = 1 AND station_id != ?
       ORDER BY name`
    )
    .all(CASHIER_STATION)
    .map((row) => ({ stationId: row.station_id, name: row.name }));
}

function requirePrepStation(stationId) {
  const id = String(stationId || "").trim();
  if (!id || id === CASHIER_STATION) fail(400, "Choose a preparation station.", "STATION_REQUIRED");
  const station = getStation(id);
  if (!station || !station.is_active) fail(404, "Preparation station not found.", "STATION_NOT_FOUND");
  return station;
}

function lineSignature(lines) {
  return lines
    .map((line) =>
      [
        line.itemId,
        line.variantName,
        line.quantity,
        (line.instructions || []).join(","),
        (line.addons || []).map((addon) => `${addon.name}:${addon.quantity}`).join(","),
      ].join("|")
    )
    .join("\n");
}

function loadStationLines(db, shopId, stationId, orderId = "") {
  const rows = db
    .prepare(
      `SELECT o.order_id, o.order_number, o.order_type_name, o.order_type,
              o.fulfillment_behavior, o.destination, o.customer_name, o.customer_phone,
              o.table_number, o.vehicle_number, o.parking_location,
              o.block_number, o.building_number, o.road_number, o.address_note,
              o.created_at, o.updated_at,
              l.line_id, l.item_id, l.item_name, l.quantity, l.variant_name, l.line_index
       FROM orders o
       JOIN order_lines l ON l.order_id = o.order_id
       WHERE o.tenant_id = ? AND o.status = 'OPEN' AND l.station_id = ?
         AND (? = '' OR o.order_id = ?)
       ORDER BY o.created_at, l.line_index`
    )
    .all(shopId, stationId, orderId, orderId);
  const instructions = db.prepare(
    `SELECT label FROM order_line_instructions WHERE line_id = ? ORDER BY sort_index`
  );
  const addons = db.prepare(
    `SELECT addon_name, quantity FROM order_line_addons WHERE line_id = ? ORDER BY sort_index`
  );
  const byOrder = new Map();
  for (const row of rows) {
    if (!byOrder.has(row.order_id)) {
      byOrder.set(row.order_id, {
        orderId: row.order_id,
        orderNumber: row.order_number,
        orderTypeName: row.order_type_name || row.order_type || "",
        fulfillmentBehavior: row.fulfillment_behavior || "",
        destination: row.destination || "",
        customerName: row.customer_name || "",
        customerPhone: row.customer_phone || "",
        tableNumber: row.table_number || "",
        vehicleNumber: row.vehicle_number || "",
        parkingLocation: row.parking_location || "",
        blockNumber: row.block_number || "",
        buildingNumber: row.building_number || "",
        roadNumber: row.road_number || "",
        addressNote: row.address_note || "",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lines: [],
      });
    }
    byOrder.get(row.order_id).lines.push({
      itemId: row.item_id,
      name: row.item_name,
      quantity: Number(row.quantity || 0),
      variantName: row.variant_name || "",
      instructions: instructions.all(row.line_id).map((item) => item.label),
      addons: addons.all(row.line_id).map((item) => ({
        name: item.addon_name,
        quantity: Number(item.quantity || 1),
      })),
    });
  }
  return [...byOrder.values()];
}

function ticketView(order, stored) {
  const signature = lineSignature(order.lines);
  const changed = Boolean(stored && stored.line_signature && stored.line_signature !== signature);
  const status = !stored || changed ? "NEW" : stored.status;
  return {
    ...order,
    status,
    updated: changed,
    signature,
    finishedAt: stored?.finished_at || "",
  };
}

export function listPrepBoard(shopId, stationId) {
  const stations = listPrepStations();
  const selected = stationId
    ? requirePrepStation(stationId)
    : stations[0]
      ? requirePrepStation(stations[0].stationId)
      : null;
  if (!selected) {
    return { station: null, stations, tickets: [] };
  }
  const db = getDb();
  const orders = loadStationLines(db, shopId, selected.station_id);
  const storedRows = db
    .prepare(
      `SELECT * FROM station_prep_tickets WHERE shop_id = ? AND station_id = ?`
    )
    .all(shopId, selected.station_id);
  const stored = new Map(storedRows.map((row) => [row.order_id, row]));
  let dayStart = "";
  try {
    dayStart = startOfShopDay(getShopSettings(shopId).timezone);
  } catch {
    dayStart = startOfShopDay("UTC");
  }
  const tickets = orders
    .map((order) => ticketView(order, stored.get(order.orderId)))
    .filter((ticket) => ticket.status !== "FINISHED" || !ticket.finishedAt || ticket.finishedAt >= dayStart)
    .map(({ signature, finishedAt, ...ticket }) => ticket);
  return {
    station: { stationId: selected.station_id, name: selected.name },
    stations,
    tickets,
  };
}

export function setPrepStatus(shopId, orderId, stationId, status, userId) {
  const next = status === "FINISHED" ? "FINISHED" : status === "ACCEPTED" ? "ACCEPTED" : "";
  if (!next) fail(400, "Choose accept or finished.", "STATUS_REQUIRED");
  const station = requirePrepStation(stationId);
  const id = String(orderId || "").trim();
  const db = getDb();
  const order = db
    .prepare(`SELECT order_id, status, tenant_id FROM orders WHERE order_id = ?`)
    .get(id);
  if (!order || order.tenant_id !== shopId) fail(404, "Order not found.", "ORDER_NOT_FOUND");
  if (order.status !== "OPEN") fail(400, "This order is no longer open.", "ORDER_NOT_OPEN");
  const [current] = loadStationLines(db, shopId, station.station_id, id);
  if (!current) fail(400, "This order has no items for that station.", "STATION_EMPTY");
  const signature = lineSignature(current.lines);
  const ts = nowIso();
  const existing = db
    .prepare(
      `SELECT * FROM station_prep_tickets
       WHERE shop_id = ? AND order_id = ? AND station_id = ?`
    )
    .get(shopId, id, station.station_id);
  db.prepare(
    `INSERT INTO station_prep_tickets (
       shop_id, order_id, station_id, status, line_signature,
       accepted_at, finished_at, updated_by_user_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (shop_id, order_id, station_id) DO UPDATE SET
       status = excluded.status,
       line_signature = excluded.line_signature,
       accepted_at = CASE
         WHEN excluded.status = 'ACCEPTED' THEN excluded.accepted_at
         ELSE station_prep_tickets.accepted_at
       END,
       finished_at = CASE
         WHEN excluded.status = 'FINISHED' THEN excluded.finished_at
         ELSE NULL
       END,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_at = excluded.updated_at`
  ).run(
    shopId,
    id,
    station.station_id,
    next,
    signature,
    next === "ACCEPTED" ? ts : existing?.accepted_at || null,
    next === "FINISHED" ? ts : null,
    userId || null,
    ts
  );
  return { orderId: id, stationId: station.station_id, status: next };
}
