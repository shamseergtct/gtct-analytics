import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";

const CONNECTION_TYPES = new Set(["MOCK", "NETWORK_TCP", "WINDOWS_SPOOLER"]);

export function isValidIpv4OrHostname(host) {
  const h = String(host || "").trim();
  if (!h || h.length > 253) return false;
  if (h.includes("..") || /[^\w.-]/.test(h)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    return h.split(".").every((p) => {
      const n = Number(p);
      return Number.isInteger(n) && n >= 0 && n <= 255 && String(n) === p;
    });
  }
  return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(h);
}

export function isValidTcpPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function parseCapabilities(raw) {
  if (raw && typeof raw === "object") return { ...raw };
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function listPrinters() {
  const db = getDb();
  const printers = db
    .prepare(`SELECT * FROM printers ORDER BY display_name`)
    .all();
  const assign = db.prepare(
    `SELECT station_id FROM station_printers WHERE printer_id = ?`
  );
  return printers.map((p) => ({
    ...p,
    capabilities: parseCapabilities(p.capabilities_json),
    stationIds: assign.all(p.printer_id).map((r) => r.station_id),
  }));
}

export function getPrinter(printerId) {
  const row = getDb()
    .prepare(`SELECT * FROM printers WHERE printer_id = ?`)
    .get(printerId);
  if (!row) return null;
  const stationIds = getDb()
    .prepare(`SELECT station_id FROM station_printers WHERE printer_id = ?`)
    .all(printerId)
    .map((r) => r.station_id);
  return {
    ...row,
    capabilities: parseCapabilities(row.capabilities_json),
    stationIds,
  };
}

/**
 * Validate and normalize printer fields. Rejects unsafe / incomplete NETWORK_TCP config.
 */
export function validatePrinterInput(input) {
  const displayName = String(input.displayName || "").trim();
  const connectionType = String(input.connectionType || "").trim();
  const paperWidthMm = Number(input.paperWidthMm ?? 80);
  const isActive = input.isActive !== false;
  let host = input.host == null || input.host === "" ? null : String(input.host).trim();
  let port =
    input.port == null || input.port === "" ? null : Number(input.port);
  let windowsQueueName =
    input.windowsQueueName == null || input.windowsQueueName === ""
      ? null
      : String(input.windowsQueueName).trim();

  if (!displayName || displayName.length > 120) {
    throw Object.assign(new Error("displayName is required (max 120 chars)"), {
      status: 400,
    });
  }
  if (!CONNECTION_TYPES.has(connectionType)) {
    throw Object.assign(
      new Error(`Invalid connectionType: ${connectionType}`),
      { status: 400 }
    );
  }
  if (![58, 80].includes(paperWidthMm)) {
    throw Object.assign(new Error("paperWidthMm must be 58 or 80"), {
      status: 400,
    });
  }

  const capabilities = parseCapabilities(input.capabilities);
  // Never silently enable physical dispatch via client alone
  capabilities.physicalDispatchEnabled = Boolean(
    capabilities.physicalDispatchEnabled
  );
  capabilities.beepOnPrint = Boolean(capabilities.beepOnPrint);

  if (connectionType === "MOCK") {
    host = null;
    port = null;
    windowsQueueName = null;
  } else if (connectionType === "NETWORK_TCP") {
    windowsQueueName = null;
    if (!isValidIpv4OrHostname(host)) {
      throw Object.assign(
        new Error("NETWORK_TCP requires a valid IPv4 address or hostname"),
        { status: 400 }
      );
    }
    if (port == null) port = 9100;
    if (!isValidTcpPort(port)) {
      throw Object.assign(new Error("NETWORK_TCP requires a valid TCP port"), {
        status: 400,
      });
    }
  } else if (connectionType === "WINDOWS_SPOOLER") {
    host = null;
    port = null;
    if (!windowsQueueName || windowsQueueName.length > 200) {
      throw Object.assign(
        new Error("WINDOWS_SPOOLER requires windowsQueueName"),
        { status: 400 }
      );
    }
    if (/[<>:"/\\|?*\x00-\x1f]/.test(windowsQueueName) || windowsQueueName.includes("..")) {
      throw Object.assign(new Error("Invalid windowsQueueName"), {
        status: 400,
      });
    }
  }

  return {
    printerId: input.printerId ? String(input.printerId) : newId("prn"),
    displayName,
    connectionType,
    host,
    port,
    windowsQueueName,
    paperWidthMm,
    capabilities,
    isActive,
  };
}

export function upsertPrinter(input) {
  const normalized = validatePrinterInput(input);
  const db = getDb();
  const ts = nowIso();
  const existing = getDb()
    .prepare(`SELECT printer_id FROM printers WHERE printer_id = ?`)
    .get(normalized.printerId);
  const caps = JSON.stringify(normalized.capabilities || {});

  if (existing) {
    db.prepare(
      `UPDATE printers SET
        display_name = ?, connection_type = ?, host = ?, port = ?,
        windows_queue_name = ?, paper_width_mm = ?, capabilities_json = ?,
        is_active = ?, updated_at = ?
       WHERE printer_id = ?`
    ).run(
      normalized.displayName,
      normalized.connectionType,
      normalized.host,
      normalized.port,
      normalized.windowsQueueName,
      normalized.paperWidthMm,
      caps,
      normalized.isActive ? 1 : 0,
      ts,
      normalized.printerId
    );
  } else {
    db.prepare(
      `INSERT INTO printers (
        printer_id, display_name, connection_type, host, port,
        windows_queue_name, paper_width_mm, capabilities_json,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      normalized.printerId,
      normalized.displayName,
      normalized.connectionType,
      normalized.host,
      normalized.port,
      normalized.windowsQueueName,
      normalized.paperWidthMm,
      caps,
      normalized.isActive ? 1 : 0,
      ts,
      ts
    );
  }
  return getPrinter(normalized.printerId);
}

export function markPrinterTest(printerId, status, detail = "") {
  const db = getDb();
  const ts = nowIso();
  db.prepare(
    `UPDATE printers SET last_test_status = ?, last_test_at = ?, updated_at = ? WHERE printer_id = ?`
  ).run(
    `${status}${detail ? `: ${detail}` : ""}`.slice(0, 500),
    ts,
    ts,
    printerId
  );
  return getPrinter(printerId);
}

export function printerDestinationLabel(printer) {
  if (!printer) return "";
  if (printer.connection_type === "NETWORK_TCP") {
    return `${printer.host}:${printer.port ?? 9100}`;
  }
  if (printer.connection_type === "WINDOWS_SPOOLER") {
    return printer.windows_queue_name || "";
  }
  return "MOCK";
}
