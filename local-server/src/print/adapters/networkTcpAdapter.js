import { renderMj330Raster } from "../mj330Raster.js";
import net from "node:net";
import { log } from "../../util/logger.js";
import { isValidIpv4OrHostname, isValidTcpPort } from "../../services/printers.js";

/**
 * ESC B n t — common POS-80 / Ethernet thermal beeper (n beeps, t duration units).
 * Safe optional trailer; printers without a buzzer typically ignore it.
 */
export const NETWORK_TCP_BEEP = Buffer.from([0x1b, 0x42, 0x03, 0x02]);

/**
 * Build a plain-text / MJ330 payload for thermal printers.
 * Avoids ESC/POS init, cash-drawer, and reset sequences.
 * Optional beep (capabilities.beepOnPrint) is appended after the ticket.
 */
export function buildNetworkTcpPayload(renderedText, format = "TEXT", options = {}) {
  const beep = options.beepOnPrint === true;
  let body;
  if (format === "MJ330_RASTER") {
    body = renderMj330Raster(renderedText);
  } else if (format === "TEXT") {
    const text = String(renderedText || "").replace(/\r\n/g, "\n");
    // LF feed only — no ESC/POS binary commands in the body
    body = Buffer.from(`${text}\n\n\n`, "utf8");
  } else {
    throw new Error("Unknown TCP printer format");
  }
  return beep ? Buffer.concat([body, NETWORK_TCP_BEEP]) : body;
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
 * NETWORK_TCP adapter for raw ESC/POS / MJ330 raster over TCP (typical port 9100).
 *
 * Physical dispatch requires ALL of:
 * - effective physical master (env override or persistent auto-print setting)
 * - printer.capabilities.physicalDispatchEnabled
 * - options.allowPhysicalDispatch (dispatcher authorization for this job)
 * - options.confirmedHost / confirmedPort matching printer destination
 *
 * Lifecycle (MJ330 / raw-9100):
 * Many printers accept bytes and never send application data or a TCP FIN.
 * Awaiting socket.end(callback) / remote EOF therefore idles until setTimeout
 * fires UNKNOWN — even after the payload was fully written. After the write
 * callback confirms the payload was accepted by the kernel socket buffer, we
 * half-close locally (end, do not await peer FIN) and mark DISPATCHED.
 *
 * TCP write handoff = DISPATCHED only. Never CONFIRMED paper. No automatic retry.
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

  const beepOnPrint =
    options.beepOnPrint === true ||
    (options.beepOnPrint == null && caps.beepOnPrint === true);
  const payload = buildNetworkTcpPayload(renderedText, options.format, { beepOnPrint });
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    /** @type {'connecting' | 'writing' | 'written'} */
    let phase = "connecting";
    let bytesAccepted = 0;
    let cleanupTimer = null;

    const cleanupSocket = ({ immediateDestroy = false } = {}) => {
      try {
        socket.setTimeout(0);
      } catch {
        // ignore
      }
      if (immediateDestroy) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        return;
      }
      // After a successful write, prefer local half-close and a short grace
      // period so the kernel can finish transmitting before destroy/RST.
      try {
        if (!socket.destroyed) socket.end();
      } catch {
        // ignore
      }
      cleanupTimer = setTimeout(() => {
        try {
          if (!socket.destroyed) socket.destroy();
        } catch {
          // ignore
        }
      }, 500);
      if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();
    };

    const finish = (result, { immediateDestroy = false } = {}) => {
      if (settled) return;
      settled = true;
      if (cleanupTimer) {
        clearTimeout(cleanupTimer);
        cleanupTimer = null;
      }
      cleanupSocket({ immediateDestroy });
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => {
      if (phase === "connecting") {
        finish(
          {
            outcome: "FAILED",
            detail: `TCP connect timeout to ${host}:${port} (no data sent). No automatic retry.`,
          },
          { immediateDestroy: true }
        );
        return;
      }
      if (phase === "writing") {
        finish(
          {
            outcome: "UNKNOWN",
            detail:
              `TCP timeout while writing to ${host}:${port} after ${bytesAccepted}/${payload.length} bytes accepted by the socket. Print may or may not have occurred — operator review required. No automatic retry.`,
          },
          { immediateDestroy: true }
        );
        return;
      }
      finish(
        {
          outcome: "UNKNOWN",
          detail:
            "TCP timeout after write handoff. Print may or may not have occurred — operator review required. No automatic retry.",
        },
        { immediateDestroy: true }
      );
    });
    socket.once("error", (err) => {
      if (phase === "connecting") {
        finish(
          {
            outcome: "FAILED",
            detail: `TCP connect/error before write: ${err.message} (no data sent)`,
          },
          { immediateDestroy: true }
        );
        return;
      }
      if (phase === "writing") {
        finish(
          {
            outcome: "UNKNOWN",
            detail: `TCP error during write after ${bytesAccepted}/${payload.length} bytes: ${err.message}`,
          },
          { immediateDestroy: true }
        );
        return;
      }
      // Post-handoff errors are ambiguous; job already resolved as DISPATCHED.
    });

    socket.connect(port, host, () => {
      phase = "writing";
      const ok = socket.write(payload, (writeErr) => {
        if (settled) return;
        if (writeErr) {
          finish(
            {
              outcome: "UNKNOWN",
              detail: `Write error after connect (${bytesAccepted}/${payload.length} bytes): ${writeErr.message}`,
            },
            { immediateDestroy: true }
          );
          return;
        }
        // Write callback = payload accepted by the kernel send buffer.
        // Do NOT await socket.end(callback) / remote FIN: MJ330 raw-9100 printers
        // often keep the session open, which previously caused inactivity UNKNOWN.
        phase = "written";
        bytesAccepted = payload.length;
        log.warn("NETWORK_TCP write handoff completed without device confirmation", {
          jobId: job.job_id,
          host,
          port,
          bytes: payload.length,
        });
        finish({
          outcome: "DISPATCHED",
          detail:
            `Payload handed to TCP socket (${payload.length} bytes) for ${host}:${port}. Not CONFIRMED — printers often keep the session open and send no ACK. No automatic retry.`,
        });
      });
      if (ok) bytesAccepted = payload.length;
    });
  });
}
