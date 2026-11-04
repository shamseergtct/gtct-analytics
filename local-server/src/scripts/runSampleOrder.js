import { inspectExistingTestDatabase, stampMigratedTestDatabase } from "../db/testStartup.js";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger, log } from "../util/logger.js";
import { seedIfEmpty } from "../seed/sampleData.js";
import { createTestOrder } from "../services/orders.js";
import { processAllPending } from "../print/dispatcher.js";
import { getPrintJob } from "../services/printQueue.js";
import { renderTicketText } from "../print/ticketFormat.js";

const SAMPLE = {
  orderNumber: "TEST-001",
  submissionId: "sample-order-test-001",
  orderType: "TAKEAWAY",
  destination: "Counter 1",
  ticketRevision: 1,
  lines: [
    {
      itemId: "item_orange_juice",
      quantity: 2,
      instructions: ["Less sugar", "No ice"],
    },
    {
      itemId: "item_chicken_shawarma",
      quantity: 1,
      instructions: ["No onion", "Less sauce"],
    },
    {
      itemId: "item_chicken_burger",
      quantity: 1,
      instructions: ["Extra cheese", "No sauce"],
    },
  ],
};

async function main() {
  const config = loadConfig({ mode: "script" });
  inspectExistingTestDatabase(config);
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  stampMigratedTestDatabase(getDb(), config);
  seedIfEmpty(config);

  const result = createTestOrder(SAMPLE, config);
  log.info("Sample order result", {
    created: result.created,
    orderId: result.order.order_id,
    jobCount: result.jobs.length,
    unmapped: result.unmapped || [],
  });

  const processed = await processAllPending(config);
  log.info("Dispatch complete", { processed });

  // Acceptance summary: which items went to which station
  const jobs = result.jobs.map((j) => getPrintJob(j.job_id));
  const summary = jobs.map((job) => {
    const payload = JSON.parse(job.payload_snapshot);
    const text = renderTicketText(job.job_type, payload, { paperWidthMm: 80 });
    return {
      jobId: job.job_id,
      jobType: job.job_type,
      stationId: job.station_id,
      printerId: job.printer_id,
      status: job.status,
      itemNames: (payload.items || []).map((i) => i.name),
      preview: text.split("\n").slice(0, 12).join(" | "),
    };
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ order: result.order, jobs: summary }, null, 2));

  closeDatabase();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
