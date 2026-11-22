/**
 * Lightweight incoming-call buffer for TEST pilot screen-pop.
 * A USB modem / softphone agent can POST here; Sales polls latest.
 */
import { getDb } from "../db/db.js";
import { nowIso } from "../util/time.js";
import { findCustomerByPhone, parsePhone } from "./customers.js";

const META_KEY = "gtct.caller_id.latest.v1";

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

function readLatest(shopId) {
  const row = getDb()
    .prepare(`SELECT value FROM meta WHERE key = ?`)
    .get(`${META_KEY}:${shopId}`);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed?.phone || !parsed?.receivedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLatest(shopId, payload) {
  const key = `${META_KEY}:${shopId}`;
  const value = JSON.stringify(payload);
  getDb()
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

export function getLatestCaller(shopId) {
  const latest = readLatest(shopId);
  if (!latest) return { call: null, customer: null };
  const customer = findCustomerByPhone(shopId, latest.phone);
  return {
    call: {
      phone: latest.phone,
      phoneKey: latest.phoneKey,
      receivedAt: latest.receivedAt,
      source: latest.source || "manual",
    },
    customer,
  };
}

export function recordIncomingCaller(shopId, { phone, source = "manual" } = {}) {
  let parsed;
  try {
    parsed = parsePhone(phone);
  } catch (err) {
    fail(err.status || 400, err.message || "Enter a valid phone number.", "CALLER_PHONE");
  }
  const payload = {
    phone: parsed.phone,
    phoneKey: parsed.phoneKey,
    receivedAt: nowIso(),
    source: String(source || "manual").slice(0, 40),
  };
  writeLatest(shopId, payload);
  const customer = findCustomerByPhone(shopId, parsed.phone);
  return {
    call: {
      phone: payload.phone,
      phoneKey: payload.phoneKey,
      receivedAt: payload.receivedAt,
      source: payload.source,
    },
    customer,
  };
}

export function clearLatestCaller(shopId) {
  getDb()
    .prepare(`DELETE FROM meta WHERE key = ?`)
    .run(`${META_KEY}:${shopId}`);
  return { cleared: true };
}
