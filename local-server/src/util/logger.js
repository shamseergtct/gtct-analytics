import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./time.js";

let logFilePath = null;

export function initLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  logFilePath = path.join(logDir, "local-server.log");
}

function write(level, message, meta) {
  const line = JSON.stringify({
    at: nowIso(),
    level,
    message,
    ...(meta ? { meta } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(line);
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, `${line}\n`, "utf8");
    } catch {
      // ignore disk log failures
    }
  }
}

export const log = {
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta),
};
