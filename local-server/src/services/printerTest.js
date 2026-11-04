import { renderTicketText } from "../print/ticketFormat.js";
import { dispatchMock } from "../print/adapters/mockAdapter.js";
import { probeNetworkTcp } from "../print/adapters/networkTcpAdapter.js";
import {
  getPrinter,
  markPrinterTest,
  printerDestinationLabel,
} from "./printers.js";
import { recordAudit } from "./audit.js";
import { nowIso } from "../util/time.js";

export function buildSampleTicketPayload(printer, config) {
  return {
    restaurantDisplayName: config.restaurantDisplayName,
    orderNumber: "TEST-PREVIEW",
    ticketId: `PREVIEW-${printer.printer_id}`,
    stationName: "PREVIEW",
    orderType: "TAKEAWAY",
    destination: "Counter 1",
    createdAt: nowIso(),
    ticketRevision: 1,
    isReprint: false,
    items: [
      {
        name: "Sample Item",
        quantity: 1,
        instructions: ["Test preview only", "Not a real order"],
      },
    ],
  };
}

export function previewPrinterTicket(printer, config) {
  const payload = buildSampleTicketPayload(printer, config);
  const jobType = "KITCHEN";
  const text = renderTicketText(jobType, payload, {
    paperWidthMm: printer.paper_width_mm || 80,
  });
  return {
    printerId: printer.printer_id,
    connectionType: printer.connection_type,
    destination: printerDestinationLabel(printer),
    physicalPrintEnabled: Boolean(config.physicalPrintEnabled),
    physicalDispatchEnabled: Boolean(
      printer.capabilities?.physicalDispatchEnabled
    ),
    text,
    payload,
  };
}

/**
 * Admin printer test actions.
 * Modes:
 * - preview: render only (always safe)
 * - mock_file: MOCK adapter write only
 * - tcp_probe: connect-only, no payload (requires GTCT_ALLOW_TCP_PROBE=true)
 * - physical: REJECTED in Phase 1.2 Mac workflow (must be explicitly approved later)
 */
export async function runPrinterTest({
  printer,
  config,
  mode = "preview",
  actorRole = "admin",
}) {
  if (mode === "preview") {
    const preview = previewPrinterTicket(printer, config);
    recordAudit({
      actorRole,
      action: "printer.preview",
      entityType: "printer",
      entityId: printer.printer_id,
      detail: { connectionType: printer.connection_type },
    });
    const updated = markPrinterTest(
      printer.printer_id,
      "PREVIEW",
      "Ticket preview generated"
    );
    return {
      ok: true,
      mode,
      physicalDataSent: false,
      ...preview,
      printer: updated,
    };
  }

  if (mode === "mock_file") {
    if (printer.connection_type !== "MOCK") {
      return {
        ok: false,
        mode,
        physicalDataSent: false,
        error: "mock_file mode is only valid for MOCK printers",
      };
    }
    const preview = previewPrinterTicket(printer, config);
    const job = {
      job_id: `preview_${printer.printer_id}`,
      job_type: "KITCHEN",
      order_id: "preview",
      station_id: "preview",
    };
    const result = await dispatchMock(
      job,
      printer,
      preview.text,
      config.printOutputDir
    );
    markPrinterTest(printer.printer_id, "OK", "Mock file written");
    recordAudit({
      actorRole,
      action: "printer.test_mock",
      entityType: "printer",
      entityId: printer.printer_id,
      detail: { outputPath: result.outputPath },
    });
    return {
      ok: true,
      mode,
      physicalDataSent: false,
      detail: result.detail,
      text: preview.text,
      printer: markPrinterTest(printer.printer_id, "OK", "Mock file written"),
    };
  }

  if (mode === "tcp_probe") {
    if (printer.connection_type !== "NETWORK_TCP") {
      return {
        ok: false,
        mode,
        physicalDataSent: false,
        error: "tcp_probe is only valid for NETWORK_TCP printers",
      };
    }
    if (!config.allowTcpProbe) {
      markPrinterTest(
        printer.printer_id,
        "SKIPPED",
        "TCP probe disabled (GTCT_ALLOW_TCP_PROBE not true)"
      );
      recordAudit({
        actorRole,
        action: "printer.tcp_probe_blocked",
        entityType: "printer",
        entityId: printer.printer_id,
        detail: { host: printer.host, port: printer.port },
      });
      return {
        ok: false,
        mode,
        physicalDataSent: false,
        error:
          "TCP probe is disabled. Set GTCT_ALLOW_TCP_PROBE=true only when intentionally testing LAN reachability. No print data is ever sent by probe mode.",
        printer: markPrinterTest(
          printer.printer_id,
          "SKIPPED",
          "TCP probe disabled"
        ),
      };
    }
    const probe = await probeNetworkTcp(printer);
    markPrinterTest(
      printer.printer_id,
      probe.ok ? "PROBE_OK" : "PROBE_FAIL",
      probe.detail
    );
    recordAudit({
      actorRole,
      action: "printer.tcp_probe",
      entityType: "printer",
      entityId: printer.printer_id,
      detail: { ok: probe.ok, detail: probe.detail, physicalDataSent: false },
    });
    return {
      ok: probe.ok,
      mode,
      physicalDataSent: false,
      detail: probe.detail,
      printer: getPrinter(printer.printer_id),
    };
  }

  if (mode === "physical") {
    recordAudit({
      actorRole,
      action: "printer.physical_test_rejected",
      entityType: "printer",
      entityId: printer.printer_id,
      detail: { reason: "Phase 1.2 blocks physical test prints until approval" },
    });
    markPrinterTest(
      printer.printer_id,
      "BLOCKED",
      "Physical test print not approved for Phase 1.2"
    );
    return {
      ok: false,
      mode,
      physicalDataSent: false,
      error:
        "Physical test printing is blocked in Phase 1.2. Use preview or MOCK. Await explicit approval before any real POS-80 job.",
      printer: getPrinter(printer.printer_id),
    };
  }

  return {
    ok: false,
    mode,
    physicalDataSent: false,
    error: `Unknown test mode: ${mode}`,
  };
}
