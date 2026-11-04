import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { log } from "../util/logger.js";
import { renderTicketText } from "./ticketFormat.js";
import { applyCashierCategories } from "../services/printQueue.js";
import { dispatchMock } from "./adapters/mockAdapter.js";
import { dispatchNetworkTcp } from "./adapters/networkTcpAdapter.js";
import { dispatchWindowsSpooler } from "./adapters/windowsSpoolerAdapter.js";

const ALLOWED_TRANSITIONS = {
  PENDING: ["DISPATCHING"],
  DISPATCHING: ["DISPATCHED", "FAILED", "UNKNOWN", "NEEDS_REVIEW"],
  DISPATCHED: ["CONFIRMED", "NEEDS_REVIEW"],
  FAILED: ["PENDING", "NEEDS_REVIEW"],
  UNKNOWN: ["NEEDS_REVIEW", "CONFIRMED"],
  NEEDS_REVIEW: ["PENDING", "CONFIRMED"],
  CONFIRMED: [],
};

function canTransition(from, to) {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

function recordEvent(db, jobId, fromStatus, toStatus, note) {
  db.prepare(
    `INSERT INTO print_job_events (event_id, job_id, from_status, to_status, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newId("evt"), jobId, fromStatus, toStatus, note || "", nowIso());
}

export function updateJobStatus(db, job, toStatus, fields = {}) {
  if (!canTransition(job.status, toStatus)) {
    throw new Error(
      `Invalid status transition ${job.status} → ${toStatus} for job ${job.job_id}`
    );
  }
  const updatedAt = nowIso();
  db.prepare(
    `UPDATE print_jobs
     SET status = ?,
         last_error = COALESCE(?, last_error),
         attempt_count = COALESCE(?, attempt_count),
         dispatched_at = COALESCE(?, dispatched_at),
         confirmed_at = COALESCE(?, confirmed_at),
         updated_at = ?
     WHERE job_id = ?`
  ).run(
    toStatus,
    fields.lastError ?? null,
    fields.attemptCount ?? null,
    fields.dispatchedAt ?? null,
    fields.confirmedAt ?? null,
    updatedAt,
    job.job_id
  );
  recordEvent(db, job.job_id, job.status, toStatus, fields.note || "");
  return { ...job, status: toStatus, updated_at: updatedAt };
}

async function dispatchToAdapter(job, printer, renderedText, config) {
  const type = printer.connection_type;
  if (type === "MOCK") {
    return dispatchMock(job, printer, renderedText, config.printOutputDir);
  }
  if (type === "NETWORK_TCP") {
    // Queue dispatch never auto-sends physical data. Physical requires a
    // future explicitly authorized path (allowPhysicalDispatch + host confirm).
    return dispatchNetworkTcp(job, printer, renderedText, {
      physicalPrintEnabled: config.physicalPrintEnabled,
      allowPhysicalDispatch: false,
    });
  }
  if (type === "WINDOWS_SPOOLER") {
    return dispatchWindowsSpooler(job, printer, renderedText, {
      physicalPrintEnabled: config.physicalPrintEnabled,
    });
  }
  return { outcome: "FAILED", detail: `Unknown connection_type: ${type}` };
}

function claimNextJob(db) {
  const job = db
    .prepare(
      `SELECT * FROM print_jobs
       WHERE status = 'PENDING'
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get();
  if (!job) return null;

  const tx = db.transaction(() => {
    const fresh = db
      .prepare(`SELECT * FROM print_jobs WHERE job_id = ?`)
      .get(job.job_id);
    if (!fresh || fresh.status !== "PENDING") return null;
    return updateJobStatus(db, fresh, "DISPATCHING", {
      attemptCount: fresh.attempt_count + 1,
      note: "Claimed by dispatcher",
    });
  });
  return tx();
}

/**
 * Process one PENDING job. Safe to call repeatedly.
 */
export async function processNextJob(config) {
  const db = getDb();
  const claimed = claimNextJob(db);
  if (!claimed) return null;

  const printer = db
    .prepare(`SELECT * FROM printers WHERE printer_id = ?`)
    .get(claimed.printer_id);

  if (!printer || !printer.is_active) {
    updateJobStatus(db, claimed, "FAILED", {
      lastError: "Printer missing or inactive",
      note: "Printer resolution failed",
    });
    return { jobId: claimed.job_id, status: "FAILED" };
  }

  let payload;
  try {
    payload = JSON.parse(claimed.payload_snapshot);
  } catch {
    updateJobStatus(db, claimed, "FAILED", {
      lastError: "Invalid payload_snapshot JSON",
      note: "Payload parse failed",
    });
    return { jobId: claimed.job_id, status: "FAILED" };
  }

  if (claimed.job_type === "CASHIER") payload = applyCashierCategories(payload);
  const renderedText = renderTicketText(claimed.job_type, payload, {
    paperWidthMm: printer.paper_width_mm,
  });

  let result;
  try {
    result = await dispatchToAdapter(claimed, printer, renderedText, config);
  } catch (err) {
    log.error("Dispatcher adapter threw", {
      jobId: claimed.job_id,
      error: err.message,
    });
    updateJobStatus(db, claimed, "UNKNOWN", {
      lastError: err.message,
      note: "Adapter exception — outcome uncertain",
    });
    return { jobId: claimed.job_id, status: "UNKNOWN" };
  }

  const outcome = result.outcome || "UNKNOWN";
  if (!canTransition("DISPATCHING", outcome)) {
    updateJobStatus(db, claimed, "NEEDS_REVIEW", {
      lastError: `Adapter returned unexpected outcome: ${outcome}`,
      note: result.detail || "",
    });
    return { jobId: claimed.job_id, status: "NEEDS_REVIEW" };
  }

  const fields = {
    lastError: outcome === "FAILED" || outcome === "UNKNOWN" || outcome === "NEEDS_REVIEW"
      ? result.detail
      : null,
    note: result.detail || "",
  };
  if (outcome === "DISPATCHED") {
    fields.dispatchedAt = nowIso();
  }

  updateJobStatus(db, claimed, outcome, fields);
  log.info("Print job processed", {
    jobId: claimed.job_id,
    status: outcome,
    printerId: printer.printer_id,
  });
  return { jobId: claimed.job_id, status: outcome, detail: result.detail };
}

export async function processAllPending(config, limit = 50) {
  const results = [];
  for (let i = 0; i < limit; i += 1) {
    const r = await processNextJob(config);
    if (!r) break;
    results.push(r);
  }
  return results;
}

export function startDispatchLoop(config) {
  let stopped = false;
  let timer = null;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await processNextJob(config);
    } catch (err) {
      log.error("Dispatch loop error", { error: err.message });
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(tick, config.dispatchIntervalMs);
      }
    }
  };

  timer = setTimeout(tick, config.dispatchIntervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Authorized operator confirmation only — never from printer TCP success alone.
 */
export function confirmJob(jobId, note = "Manually confirmed by operator") {
  const db = getDb();
  const job = db.prepare(`SELECT * FROM print_jobs WHERE job_id = ?`).get(jobId);
  if (!job) throw Object.assign(new Error("Job not found"), { status: 404 });
  if (!canTransition(job.status, "CONFIRMED")) {
    throw Object.assign(
      new Error(`Cannot confirm job in status ${job.status}`),
      { status: 409 }
    );
  }
  return updateJobStatus(db, job, "CONFIRMED", {
    confirmedAt: nowIso(),
    note,
  });
}

/**
 * Authorized reprint: creates a new job with is_reprint=1 and new idempotency key.
 */
export function requestReprint(jobId) {
  const db = getDb();
  const job = db.prepare(`SELECT * FROM print_jobs WHERE job_id = ?`).get(jobId);
  if (!job) throw Object.assign(new Error("Job not found"), { status: 404 });

  if (!["FAILED", "UNKNOWN", "NEEDS_REVIEW", "DISPATCHED", "CONFIRMED"].includes(job.status)) {
    throw Object.assign(
      new Error(`Cannot reprint job in status ${job.status}`),
      { status: 409 }
    );
  }

  let payload = JSON.parse(job.payload_snapshot);
  payload = {
    ...payload,
    isReprint: true,
    reprintOfJobId: job.job_id,
  };

  const newJobId = newId("job");
  const ts = nowIso();
  const idempotencyKey = `${job.idempotency_key}::reprint::${ts}`;

  db.prepare(
    `INSERT INTO print_jobs (
      job_id, tenant_id, order_id, station_id, printer_id, ticket_revision,
      job_type, idempotency_key, payload_snapshot, status, attempt_count,
      last_error, is_reprint, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, NULL, 1, ?, ?)`
  ).run(
    newJobId,
    job.tenant_id,
    job.order_id,
    job.station_id,
    job.printer_id,
    job.ticket_revision,
    job.job_type,
    idempotencyKey,
    JSON.stringify(payload),
    ts,
    ts
  );
  recordEvent(db, newJobId, null, "PENDING", `Reprint of ${job.job_id}`);
  return db.prepare(`SELECT * FROM print_jobs WHERE job_id = ?`).get(newJobId);
}
