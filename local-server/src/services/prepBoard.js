import { createHash } from "node:crypto";
import { getDb } from "../db/db.js";
import { recordAudit } from "./audit.js";
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

function listPrepStations(allowedStationIds = null) {
  const stations = getDb()
    .prepare(
      `SELECT station_id, name
       FROM stations
       WHERE is_active = 1 AND station_id != ?
       ORDER BY name`
    )
    .all(CASHIER_STATION)
    .map((row) => ({ stationId: row.station_id, name: row.name }));
  return allowedStationIds === null ? stations : stations.filter((station) => allowedStationIds.includes(station.stationId));
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

function prepLineKey(line) {
  return [
    line.itemId || "",
    line.variantName || "",
    Number(line.quantity || 0),
    (line.instructions || []).join(","),
    (line.addons || []).map((addon) => `${addon.name}:${addon.quantity}`).join(","),
  ].join("|");
}

function snapshotLines(lines) {
  return (lines || []).map((line) => ({
    itemId: line.itemId || "",
    name: line.name || "",
    quantity: Number(line.quantity || 0),
    variantName: line.variantName || "",
    instructions: Array.isArray(line.instructions) ? line.instructions : [],
    addons: (line.addons || []).map((addon) => ({
      name: addon.name || "",
      quantity: Number(addon.quantity || 1),
    })),
  }));
}

function parseLinesSnapshot(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? snapshotLines(parsed) : [];
  } catch {
    return [];
  }
}

/** Previous station lines that disappeared after an order edit. */
function removedPrepLines(previous, current) {
  const remaining = (current || []).map(prepLineKey);
  const removed = [];
  for (const line of previous || []) {
    const key = prepLineKey(line);
    const index = remaining.indexOf(key);
    if (index >= 0) {
      remaining.splice(index, 1);
    } else {
      removed.push({ ...line, voided: true });
    }
  }
  return removed;
}

function loadStationLines(db, shopId, stationId, orderId = "") {
  const rows = db
    .prepare(
      `SELECT o.order_id, o.order_number, o.token_number, o.order_type_name, o.order_type,
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
        tokenNumber: row.token_number == null ? null : Number(row.token_number),
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
  const previous = parseLinesSnapshot(stored?.lines_snapshot_json);
  const voidedLines = changed ? removedPrepLines(previous, order.lines) : [];
  const lines = [
    ...(order.lines || []).map((line) => ({ ...line, voided: false })),
    ...voidedLines,
  ];
  // The revision covers the immutable station line content AND order edits.
  // A stale browser must not finish an older recipe after Sales changes it.
  const revision = createHash("sha256")
    .update(JSON.stringify([
      order.orderId,
      order.updatedAt,
      signature,
      stored?.status || "NEW",
      stored?.updated_at || "",
      voidedLines.map(prepLineKey),
    ]))
    .digest("hex");
  const editHighlight =
    changed || Number(stored?.edit_highlight || 0) === 1;
  return {
    ...order,
    lines,
    status,
    updated: changed,
    edited: editHighlight,
    signature,
    revision,
    finishedAt: changed ? "" : stored?.finished_at || "",
  };
}

export function listPrepBoard(shopId, stationId, allowedStationIds = null) {
  const stations = listPrepStations(allowedStationIds);
  if (allowedStationIds !== null && stationId && !allowedStationIds.includes(stationId)) {
    fail(403, "This preparation station is not assigned to you.", "STATION_FORBIDDEN");
  }
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
  // Keep FINISHED tickets visible for the whole active shift, including after midnight.
  // Never alter ticket statuses or order dates; this only changes the board's read filter.
  const openShift = db.prepare(`SELECT opened_at FROM shop_business_shifts
    WHERE shop_id = ? AND status = 'OPEN'`).get(shopId);
  if (openShift?.opened_at && (!dayStart || openShift.opened_at < dayStart)) {
    dayStart = openShift.opened_at;
  }
  const backfill = db.prepare(
    `UPDATE station_prep_tickets
     SET lines_snapshot_json = ?
     WHERE shop_id = ? AND order_id = ? AND station_id = ?
       AND (lines_snapshot_json IS NULL OR lines_snapshot_json = '' OR lines_snapshot_json = '[]')`
  );
  const tickets = orders
    .map((order) => {
      const row = stored.get(order.orderId);
      const view = ticketView(order, row);
      // Backfill snapshots for tickets accepted before this column existed,
      // so the next edit can show voided (removed) lines.
      if (
        row &&
        !view.updated &&
        view.status !== "NEW" &&
        !parseLinesSnapshot(row.lines_snapshot_json).length &&
        order.lines?.length
      ) {
        backfill.run(
          JSON.stringify(snapshotLines(order.lines)),
          shopId,
          order.orderId,
          selected.station_id
        );
      }
      return view;
    })
    .filter((ticket) => ticket.status !== "FINISHED" || !ticket.finishedAt || ticket.finishedAt >= dayStart)
    .map(({ signature, finishedAt, ...ticket }) => ticket);
  return {
    station: { stationId: selected.station_id, name: selected.name },
    stations,
    tickets,
  };
}

/**
 * Atomic, station-scoped state change.
 * A board client must send the status and revision it actually saw.
 * BEGIN IMMEDIATE serializes competing processes BEFORE checking the state.
 * Existing PREP ticket rows and historic orders remain unchanged.
 */
export function setPrepStatus(shopId, orderId, stationId, status, userId, expectedStatus, expectedRevision, actorRole = "") {
  const next = status === "FINISHED" ? "FINISHED" : status === "ACCEPTED" ? "ACCEPTED" : "";
  if (!next) fail(400, "Choose accept or finished.", "STATUS_REQUIRED");
  const before = String(expectedStatus || "");
  const revision = String(expectedRevision || "");
  if (!["NEW", "ACCEPTED"].includes(before) || !/^[a-f0-9]{64}$/.test(revision)) {
    fail(400, "Refresh the preparation board before updating this order.", "PREP_EXPECTATION_REQUIRED");
  }
  const id = String(orderId || "").trim();
  const station = requirePrepStation(stationId);
  const db = getDb();
  const change = db.transaction(() => {
    const order = db.prepare(
      `SELECT order_id, status, tenant_id FROM orders WHERE order_id = ?`
    ).get(id);
    if (!order || order.tenant_id !== shopId) fail(404, "Order not found.", "ORDER_NOT_FOUND");
    if (order.status !== "OPEN") fail(400, "This order is no longer open.", "ORDER_NOT_OPEN");
    const [current] = loadStationLines(db, shopId, station.station_id, id);
    if (!current) fail(400, "This order has no items for that station.", "STATION_EMPTY");
    const existing = db.prepare(
      `SELECT * FROM station_prep_tickets
       WHERE shop_id = ? AND order_id = ? AND station_id = ?`
    ).get(shopId, id, station.station_id);
    const view = ticketView(current, existing);
    if (view.status !== before || view.revision !== revision) {
      fail(409, "This preparation ticket changed. Refresh and review it again.", "PREP_STALE");
    }
    if (
      (next === "ACCEPTED" && view.status !== "NEW") ||
      (next === "FINISHED" && view.status !== "ACCEPTED")
    ) {
      fail(409, "Accept the current ticket before finishing it.", "PREP_INVALID_TRANSITION");
    }
    const ts = nowIso();
    const linesSnapshot = JSON.stringify(snapshotLines(current.lines));
    // Keep Edited visible in Preparing after Accept; clear only when Finished.
    const editHighlight =
      next === "FINISHED"
        ? 0
        : view.updated || Number(existing?.edit_highlight || 0) === 1
          ? 1
          : 0;
    db.prepare(
      `INSERT INTO station_prep_tickets (
         shop_id, order_id, station_id, status, line_signature,
         lines_snapshot_json, edit_highlight,
         accepted_at, finished_at, updated_by_user_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (shop_id, order_id, station_id) DO UPDATE SET
         status = excluded.status,
         line_signature = excluded.line_signature,
         lines_snapshot_json = excluded.lines_snapshot_json,
         edit_highlight = excluded.edit_highlight,
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
      view.signature,
      linesSnapshot,
      editHighlight,
      next === "ACCEPTED" ? ts : existing?.accepted_at || null,
      next === "FINISHED" ? ts : null,
      userId || null,
      ts
    );
    recordAudit({
      actorRole: actorRole || "",
      actorUserId: userId || "",
      action: next === "ACCEPTED" ? "prep.station.accept" : "prep.station.finish",
      entityType: "station_prep_ticket",
      entityId: `${id}:${station.station_id}`,
      detail: {
        shopId,
        orderId: id,
        stationId: station.station_id,
        fromStatus: view.status,
        toStatus: next,
        staffUserId: userId || "",
      },
    });
    return { orderId: id, stationId: station.station_id, status: next };
  });
  return change.immediate();
}


/**
 * P2-E1: Reuse the exact Kitchen board's signature/stale-state logic for
 * overall order monitoring. No prep mutations, no duplicate kitchen engine.
 * The cashier printer station is not a preparation station.
 */
export function getOrderPrepProgress(shopId, orderId) {
  const db = getDb();
  const stationRows = db.prepare(`
    SELECT DISTINCT l.station_id AS station_id, s.name AS station_name
    FROM order_lines l
    JOIN orders o ON o.order_id = l.order_id
    LEFT JOIN stations s ON s.station_id = l.station_id
    WHERE o.tenant_id = ? AND o.order_id = ?
      AND l.station_id IS NOT NULL AND l.station_id != '' AND l.station_id != ?
    ORDER BY l.station_id
  `).all(shopId, orderId, CASHIER_STATION);
  const unassigned = db.prepare(`
    SELECT COUNT(*) AS n FROM order_lines l
    JOIN orders o ON o.order_id = l.order_id
    WHERE o.tenant_id = ? AND o.order_id = ?
      AND (l.station_id IS NULL OR l.station_id = '' OR l.station_id = ?)
  `).get(shopId, orderId, CASHIER_STATION).n;

  const stations = stationRows.map(({ station_id, station_name }) => {
    const [order] = loadStationLines(db, shopId, station_id, orderId);
    if (!order) return { stationId: station_id, stationName: station_name || station_id, status: 'NEW', revision: '' };
    const stored = db.prepare(`
      SELECT * FROM station_prep_tickets
      WHERE shop_id = ? AND order_id = ? AND station_id = ?
    `).get(shopId, orderId, station_id);
    const view = ticketView(order, stored);
    return {
      stationId: station_id,
      stationName: station_name || station_id,
      status: view.status,
      revision: view.revision,
      updated: view.updated,
    };
  });
  const finishedCount = stations.filter((station) => station.status === 'FINISHED').length;
  const allFinished = stations.length > 0 && unassigned === 0 && finishedCount === stations.length;
  const stage = stations.length === 0 || unassigned > 0
    ? 'NOT_ROUTED'
    : allFinished ? 'FINISHED'
    : stations.every((s) => s.status === 'NEW') ? 'NEW'
    : stations.every((s) => s.status === 'ACCEPTED') ? 'ACCEPTED' : 'PREPARING';
  return {
    stage,
    allFinished,
    finishedCount,
    stationCount: stations.length,
    unassignedLineCount: Number(unassigned),
    stations,
  };
}
