import fs from "node:fs";
import path from "node:path";
import { nowIso } from "../../util/time.js";

/**
 * MOCK adapter: writes ticket text under print-output for inspection.
 * Never claims physical print confirmation.
 */
export async function dispatchMock(job, printer, renderedText, printOutputDir) {
  const dir = path.join(printOutputDir, "mock");
  fs.mkdirSync(dir, { recursive: true });
  const safeStation = String(job.station_id || job.job_type || "unknown")
    .replace(/[^\w.-]+/g, "_");
  const fileName = `${nowIso().replace(/[:.]/g, "-")}_${job.job_id}_${safeStation}.txt`;
  const filePath = path.join(dir, fileName);
  const body = [
    `=== MOCK PRINT ===`,
    `jobId: ${job.job_id}`,
    `printerId: ${printer.printer_id}`,
    `printerName: ${printer.display_name}`,
    `jobType: ${job.job_type}`,
    `orderId: ${job.order_id}`,
    `stationId: ${job.station_id || ""}`,
    `statusNote: Mock adapters only write files. Status becomes DISPATCHED, not CONFIRMED.`,
    ``,
    renderedText,
  ].join("\n");
  fs.writeFileSync(filePath, body, "utf8");
  return {
    outcome: "DISPATCHED",
    detail: `Mock ticket written to ${filePath}`,
    outputPath: filePath,
  };
}
