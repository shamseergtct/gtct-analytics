import { log } from "../../util/logger.js";

function isValidQueueName(name) {
  const n = String(name || "").trim();
  if (!n || n.length > 200) return false;
  // Reject path/shell metacharacters; queue names are Windows printer names.
  if (/[<>:"/\\|?*\x00-\x1f]/.test(n)) return false;
  if (n.includes("..")) return false;
  return true;
}

/**
 * WINDOWS_SPOOLER adapter architecture.
 *
 * Phase 1 does not invoke shell commands or bind a native print library yet.
 * Physical Windows testing is required before enabling real spooler dispatch.
 * When physical printing is disabled (default), this adapter fails safely.
 *
 * Future: use a supported Node printing package or Win32 APIs after validation
 * on Windows 10 22H2 and Windows 11 — never arbitrary shell execution.
 */
export async function dispatchWindowsSpooler(job, printer, renderedText, options = {}) {
  if (!options.physicalPrintEnabled) {
    return {
      outcome: "FAILED",
      detail:
        "Physical WINDOWS_SPOOLER print disabled. Set GTCT_ENABLE_PHYSICAL_PRINT=true only after Windows validation. Phase 1 default is MOCK.",
    };
  }

  if (process.platform !== "win32") {
    return {
      outcome: "FAILED",
      detail: "WINDOWS_SPOOLER adapter requires Windows. Current platform is not win32.",
    };
  }

  const queue = printer.windows_queue_name;
  if (!isValidQueueName(queue)) {
    return {
      outcome: "FAILED",
      detail: "Invalid or missing windows_queue_name",
    };
  }

  // Intentionally not implemented for Phase 1 without Windows hardware validation.
  log.warn("WINDOWS_SPOOLER physical path not implemented in Phase 1", {
    jobId: job.job_id,
    queue,
  });

  return {
    outcome: "NEEDS_REVIEW",
    detail:
      "WINDOWS_SPOOLER adapter is prepared but not wired to a validated print API in Phase 1. Use MOCK for development. Documented limitation: requires Windows 10/11 hardware test before production use.",
  };
}
