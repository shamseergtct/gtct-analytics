/**
 * Focused NETWORK_TCP lifecycle test against a local mock printer.
 * Simulates MJ330 behavior: accept bytes, never send data, never close.
 * Does not contact any physical printer.
 */
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import {
  buildNetworkTcpPayload,
  dispatchNetworkTcp,
  NETWORK_TCP_BEEP,
} from "../print/adapters/networkTcpAdapter.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function listenKeepOpen() {
  return new Promise((resolve) => {
    const received = [];
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => received.push(Buffer.from(chunk)));
      // Intentionally never end/destroy — mimics raw-9100 printers.
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        received,
        totalBytes: () => received.reduce((n, b) => n + b.length, 0),
        close: () =>
          new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

function listenThenClose() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve({ port }));
    });
  });
}

function printerFor(port) {
  return {
    printer_id: "mock-mj330",
    host: "127.0.0.1",
    port,
    is_active: 1,
    capabilities: { physicalDispatchEnabled: true, format: "TEXT" },
  };
}

const opts = {
  physicalPrintEnabled: true,
  allowPhysicalDispatch: true,
  confirmedHost: "127.0.0.1",
  format: "TEXT",
  timeoutMs: 1500,
};

const keepOpen = await listenKeepOpen();
opts.confirmedPort = keepOpen.port;

const t0 = Date.now();
const okResult = await dispatchNetworkTcp(
  { job_id: "job_keepopen" },
  printerFor(keepOpen.port),
  "KITCHEN TEST\nLINE 2",
  opts
);
const elapsed = Date.now() - t0;
assert(okResult.outcome === "DISPATCHED", `expected DISPATCHED, got ${okResult.outcome}: ${okResult.detail}`);
assert(elapsed < 1200, `handoff took too long (${elapsed}ms) — still waiting on remote close?`);

// Allow kernel/grace period to deliver bytes to the keep-open peer.
for (let i = 0; i < 20 && keepOpen.totalBytes() === 0; i += 1) {
  await sleep(25);
}
assert(keepOpen.totalBytes() > 0, "mock server did not receive payload");
assert(
  Buffer.concat(keepOpen.received).toString("utf8").includes("KITCHEN TEST"),
  "payload content missing"
);
await keepOpen.close();

const closed = await listenThenClose();
const refused = await dispatchNetworkTcp(
  { job_id: "job_refused" },
  printerFor(closed.port),
  "SHOULD FAIL",
  { ...opts, confirmedPort: closed.port, timeoutMs: 1000 }
);
assert(refused.outcome === "FAILED", `connect refuse should be FAILED, got ${refused.outcome}: ${refused.detail}`);
assert(/no data sent|connect/i.test(refused.detail), `unexpected refuse detail: ${refused.detail}`);

const quiet = buildNetworkTcpPayload("LINE", "TEXT", { beepOnPrint: false });
const noisy = buildNetworkTcpPayload("LINE", "TEXT", { beepOnPrint: true });
assert(!quiet.includes(NETWORK_TCP_BEEP), "quiet payload must not beep");
assert(noisy.includes(NETWORK_TCP_BEEP), "beep payload missing ESC B trailer");
assert(noisy.length === quiet.length + NETWORK_TCP_BEEP.length, "beep length wrong");

console.log(
  JSON.stringify({
    ok: true,
    keepOpenPrinterNeverCloses: {
      outcome: okResult.outcome,
      elapsedMs: elapsed,
      bytesReceived: keepOpen.totalBytes(),
    },
    connectRefused: { outcome: refused.outcome },
    beepTrailer: true,
  })
);
