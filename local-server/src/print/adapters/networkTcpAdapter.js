import { renderMj330Raster } from "../mj330Raster.js";
import net from "node:net";
import { log } from "../../util/logger.js";
import { isValidIpv4OrHostname, isValidTcpPort } from "../../services/printers.js";

/**
 * Build a plain-text payload for thermal printers.
 * Intentionally avoids ESC/POS init, cutter, cash-drawer, and reset sequences —
 * POS-80 variants differ and those commands are unsafe without device confirmation.
 */
export function buildNetworkTcpPayload(renderedText, format = "TEXT") {
  if (format === "MJ330_RASTER") return renderMj330Raster(renderedText);
  if (format !== "TEXT") throw new Error("Unknown TCP printer format");
  const text = String(renderedText || "").replace(/\r\n/g, "\n");
  // LF feed only — no ESC/POS binary commands
  return Buffer.from(`${text}\n\n\n`, "utf8");
}

function parseCaps(printer) {
  if (printer?.capabilities && typeof printer.capabilities === "object") {
    return printer.capabilities;
  }
  try {
    return JSON.parse(printer?.capabilities_json || "{}");
  } catch {
    return {};
  }
}

/**
 * Connect-only probe (no write). Default disabled — never used by Mac automated tests.
 */
export function probeNetworkTcp(printer, { timeoutMs = 3000 } = {}) {
  const host = printer.host;
  const port = printer.port ?? 9100;
  if (!isValidIpv4OrHostname(host) || !isValidTcpPort(port)) {
    return Promise.resolve({
      ok: false,
      detail: "Invalid host or port",
    });
  }

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () =>
      finish({ ok: false, detail: "TCP connect timeout (no data sent)" })
    );
    socket.once("error", (err) =>
      finish({ ok: false, detail: `TCP error: ${err.message} (no data sent)` })
    );
    socket.connect(port, host, () => {
      finish({
        ok: true,
        detail: `TCP connect succeeded to ${host}:${port} (no print data sent)`,
      });
    });
  });
}

/**
 * NETWORK_TCP adapter for raw text over TCP (typical port 9100).
 *
 * Physical dispatch requires ALL of:
 * - process env GTCT_ENABLE_PHYSICAL_PRINT=true
 * - printer.capabilities.physicalDispatchEnabled
 * - options.allowPhysicalDispatch (caller authorization)
 * - options.confirmedHost / confirmedPort matching printer destination
 *
 * TCP write success ≠ CONFIRMED print.
 */
export async function dispatchNetworkTcp(job, printer, renderedText, options = {}) {
  const caps = parseCaps(printer);
  const physicalMaster = Boolean(options.physicalPrintEnabled);
  const physicalPrinter = Boolean(caps.physicalDispatchEnabled);
  const allow = Boolean(options.allowPhysicalDispatch);

  if (!physicalMaster || !physicalPrinter || !allow) {
    return {
      outcome: "FAILED",
      detail:
        "Physical NETWORK_TCP dispatch blocked. Requires GTCT_ENABLE_PHYSICAL_PRINT=true, per-printer physicalDispatchEnabled, and explicit authorized dispatch.",
    };
  }

  const host = printer.host;
  const port = printer.port ?? 9100;
  if (!isValidIpv4OrHostname(host) || !isValidTcpPort(port)) {
    return {
      outcome: "FAILED",
      detail: "Invalid printer host or port for NETWORK_TCP",
    };
  }

  const confirmedHost = String(options.confirmedHost || "").trim();
  const confirmedPort = Number(options.confirmedPort);
  if (confirmedHost !== host || confirmedPort !== Number(port)) {
    return {
      outcome: "FAILED",
      detail:
        "Destination confirmation mismatch. Admin must confirm exact host:port before physical dispatch.",
    };
  }

  if (!printer.is_active) {
    return { outcome: "FAILED", detail: "Printer is inactive" };
  }

  const payload = buildNetworkTcpPayload(renderedText, options.format);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    socket.setTimeout(8000);
    socket.once("timeout", () => {
      finish({
        outcome: "UNKNOWN",
        detail:
          "TCP timeout after connect/write attempt. Print may or may not have occurred — operator review required. No automatic retry.",
      });
    });
    socket.once("error", (err) => {
      finish({
        outcome: "FAILED",
        detail: `TCP error: ${err.message}`,
      });
    });

    socket.connect(port, host, () => {
      socket.write(payload, (writeErr) => {
        if (writeErr) {
          finish({
            outcome: "UNKNOWN",
            detail: `Write error after connect: ${writeErr.message}`,
          });
          return;
        }
        socket.end(() => {
          log.warn("NETWORK_TCP transmit completed without device confirmation", {
            jobId: job.job_id,
            host,
            port,
          });
          finish({
            outcome: "DISPATCHED",
            detail:
              "Plain text transmitted over TCP. Not CONFIRMED — no reliable printer ACK. No automatic retry.",
          });
        });
      });
    });
  });
}
