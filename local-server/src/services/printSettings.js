/**
 * Persistent automatic physical-print configuration (TEST PILOT).
 * Env GTCT_ENABLE_PHYSICAL_PRINT remains an optional hard override:
 *   true  → force enable (still requires per-printer physicalDispatchEnabled)
 *   false → force disable (kill switch)
 *   unset → use the saved shop setting
 */
import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { recordAudit } from "./audit.js";

export const PRINT_SETTINGS_KEY = "gtct.print.settings.v1";

function defaultSettings() {
  return {
    version: 2,
    autoPhysicalPrintEnabled: false,
    autoPhysicalPrintEnabledAt: null,
    kitchenAutoPrint: true,
    cashierAutoPrint: true,
    /** @deprecated kept for older saved JSON; mirrored into cashierAutoPrint */
    cashierAutoPrintOnPayment: true,
    askBeforePrint: true,
    updatedAt: null,
  };
}

function parseSettings(raw) {
  const base = defaultSettings();
  if (!raw) return base;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  // Older builds used cashierAutoPrintOnPayment as the cashier on/off switch.
  const cashierEnabled =
    parsed.cashierAutoPrint != null
      ? Boolean(parsed.cashierAutoPrint)
      : parsed.cashierAutoPrintOnPayment !== false;
  return {
    ...base,
    autoPhysicalPrintEnabled: Boolean(parsed.autoPhysicalPrintEnabled),
    autoPhysicalPrintEnabledAt: parsed.autoPhysicalPrintEnabledAt || null,
    kitchenAutoPrint: parsed.kitchenAutoPrint !== false,
    cashierAutoPrint: cashierEnabled,
    cashierAutoPrintOnPayment: cashierEnabled,
    askBeforePrint: parsed.askBeforePrint !== false,
    updatedAt: parsed.updatedAt || null,
    version: 2,
  };
}

export function getPrintSettings() {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(PRINT_SETTINGS_KEY);
  return parseSettings(row?.value);
}

export function envPhysicalPrintOverride() {
  const raw = process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  if (raw == null || String(raw).trim() === "") return null;
  return String(raw).toLowerCase() === "true";
}

/** Effective master switch used by the dispatcher and /v1/config. */
export function isPhysicalPrintEffectivelyEnabled(config = {}) {
  const envOverride = envPhysicalPrintOverride();
  if (envOverride != null) return envOverride;
  if (config.physicalPrintEnabled === true) return true;
  return getPrintSettings().autoPhysicalPrintEnabled === true;
}

/**
 * Prevent old PENDING queue jobs from transmitting when automatic physical
 * printing is turned on for the first time (or re-enabled).
 */
export function holdPendingJobsCreatedBefore(enabledAt) {
  if (!enabledAt) return { held: 0 };
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT job_id FROM print_jobs
       WHERE status = 'PENDING' AND created_at < ?`
    )
    .all(enabledAt);
  const update = db.prepare(
    `UPDATE print_jobs
     SET status = 'NEEDS_REVIEW',
         last_error = ?,
         updated_at = ?
     WHERE job_id = ? AND status = 'PENDING'`
  );
  const event = db.prepare(
    `INSERT INTO print_job_events (event_id, job_id, from_status, to_status, note, created_at)
     VALUES (?, ?, 'PENDING', 'NEEDS_REVIEW', ?, ?)`
  );
  const ts = nowIso();
  const note =
    "Held: created before automatic physical printing was enabled. Not dispatched.";
  let held = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const result = update.run(note, ts, row.job_id);
      if (result.changes) {
        event.run(newId("evt"), row.job_id, note, ts);
        held += 1;
      }
    }
  });
  tx();
  return { held };
}

export function updatePrintSettings(input = {}, actor = {}) {
  if (actor.role !== "admin") {
    throw Object.assign(new Error("Administrator role required."), { status: 403 });
  }
  const current = getPrintSettings();
  const next = { ...current };
  const enabling =
    Object.prototype.hasOwnProperty.call(input, "autoPhysicalPrintEnabled") &&
    Boolean(input.autoPhysicalPrintEnabled) &&
    !current.autoPhysicalPrintEnabled;

  if (Object.prototype.hasOwnProperty.call(input, "autoPhysicalPrintEnabled")) {
    next.autoPhysicalPrintEnabled = Boolean(input.autoPhysicalPrintEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(input, "kitchenAutoPrint")) {
    next.kitchenAutoPrint = Boolean(input.kitchenAutoPrint);
  }
  if (Object.prototype.hasOwnProperty.call(input, "cashierAutoPrint")) {
    next.cashierAutoPrint = Boolean(input.cashierAutoPrint);
  } else if (Object.prototype.hasOwnProperty.call(input, "cashierAutoPrintOnPayment")) {
    // Accept old field name from earlier UI builds.
    next.cashierAutoPrint = Boolean(input.cashierAutoPrintOnPayment);
  }
  if (Object.prototype.hasOwnProperty.call(input, "askBeforePrint")) {
    next.askBeforePrint = Boolean(input.askBeforePrint);
  }
  next.cashierAutoPrintOnPayment = next.cashierAutoPrint;

  if (enabling) {
    next.autoPhysicalPrintEnabledAt = nowIso();
  }
  next.updatedAt = nowIso();
  next.version = 2;

  const db = getDb();
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(PRINT_SETTINGS_KEY, JSON.stringify(next));

  let held = 0;
  if (enabling) {
    held = holdPendingJobsCreatedBefore(next.autoPhysicalPrintEnabledAt).held;
  }

  recordAudit({
    actorRole: actor.role || "",
    actorUserId: actor.userId || "",
    action: "print.settings.update",
    entityType: "print_settings",
    entityId: PRINT_SETTINGS_KEY,
    detail: {
      autoPhysicalPrintEnabled: next.autoPhysicalPrintEnabled,
      autoPhysicalPrintEnabledAt: next.autoPhysicalPrintEnabledAt,
      kitchenAutoPrint: next.kitchenAutoPrint,
      cashierAutoPrint: next.cashierAutoPrint,
      askBeforePrint: next.askBeforePrint,
      heldPendingJobs: held,
      envOverride: envPhysicalPrintOverride(),
    },
  });

  return { ...next, heldPendingJobs: held };
}
