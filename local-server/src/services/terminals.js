/**
 * TEST shop terminals — named devices for multi-user LAN / Wi-Fi use.
 * Pairing issues an HttpOnly browser cookie; staff login stays username/password.
 * Multiple concurrent staff sessions (same user on many terminals) are allowed.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { recordAudit } from "./audit.js";

export const TERMINAL_COOKIE = "gtct_ls_terminal";
const PAIR_TTL_MS = 15 * 60 * 1000;
const PURPOSES = new Set(["any", "sales", "monitor", "prep"]);

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

function hashToken(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function normalizeCode(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .slice(0, 24);
}

function normalizeName(raw) {
  const name = String(raw || "").trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) {
    fail(400, "Terminal name must be 2–60 characters.", "INVALID_NAME");
  }
  return name;
}

function normalizePurpose(raw) {
  const purpose = String(raw || "any").trim().toLowerCase();
  if (!PURPOSES.has(purpose)) {
    fail(400, "Purpose must be any, sales, monitor, or prep.", "INVALID_PURPOSE");
  }
  return purpose;
}

function rowView(row) {
  return {
    terminalId: row.terminal_id,
    code: row.code,
    displayName: row.display_name,
    purpose: row.purpose,
    isActive: Boolean(row.is_active),
    paired: Boolean(row.pair_token_hash),
    pairedAt: row.paired_at || null,
    lastSeenAt: row.last_seen_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listTerminals(shopId) {
  return getDb()
    .prepare(
      `SELECT * FROM shop_terminals
       WHERE shop_id = ?
       ORDER BY is_active DESC, display_name COLLATE NOCASE ASC`
    )
    .all(shopId)
    .map(rowView);
}

export function getTerminal(shopId, terminalId) {
  const row = getDb()
    .prepare(`SELECT * FROM shop_terminals WHERE shop_id = ? AND terminal_id = ?`)
    .get(shopId, String(terminalId || "").trim());
  return row ? rowView(row) : null;
}

export function upsertTerminal(shopId, input, actor) {
  const displayName = normalizeName(input?.displayName);
  const purpose = normalizePurpose(input?.purpose);
  const isActive = input?.isActive === false ? 0 : 1;
  let code = normalizeCode(input?.code);
  if (!code) {
    code = displayName
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 16);
  }
  if (!/^[A-Z0-9][A-Z0-9-]{1,23}$/.test(code)) {
    fail(400, "Terminal code must be letters, numbers, or dashes.", "INVALID_CODE");
  }

  const db = getDb();
  const ts = nowIso();
  const existingId = String(input?.terminalId || "").trim();
  if (existingId) {
    const current = db
      .prepare(`SELECT * FROM shop_terminals WHERE shop_id = ? AND terminal_id = ?`)
      .get(shopId, existingId);
    if (!current) fail(404, "Terminal not found.", "NOT_FOUND");
    const clash = db
      .prepare(
        `SELECT terminal_id FROM shop_terminals
         WHERE shop_id = ? AND code = ? AND terminal_id != ?`
      )
      .get(shopId, code, existingId);
    if (clash) fail(409, "Another terminal already uses that code.", "CODE_TAKEN");
    db.prepare(
      `UPDATE shop_terminals
       SET code = ?, display_name = ?, purpose = ?, is_active = ?, updated_at = ?
       WHERE shop_id = ? AND terminal_id = ?`
    ).run(code, displayName, purpose, isActive, ts, shopId, existingId);
    recordAudit({
      actorRole: actor?.role || "admin",
      actorUserId: actor?.userId || "",
      action: "terminal.update",
      entityType: "shop_terminal",
      entityId: existingId,
      detail: { shopId, code, displayName, purpose, isActive: Boolean(isActive) },
    });
    return getTerminal(shopId, existingId);
  }

  const clash = db
    .prepare(`SELECT terminal_id FROM shop_terminals WHERE shop_id = ? AND code = ?`)
    .get(shopId, code);
  if (clash) fail(409, "Another terminal already uses that code.", "CODE_TAKEN");
  const terminalId = newId("term");
  db.prepare(
    `INSERT INTO shop_terminals (
       terminal_id, shop_id, code, display_name, purpose, is_active,
       pair_token_hash, paired_at, last_seen_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
  ).run(terminalId, shopId, code, displayName, purpose, isActive, ts, ts);
  recordAudit({
    actorRole: actor?.role || "admin",
    actorUserId: actor?.userId || "",
    action: "terminal.create",
    entityType: "shop_terminal",
    entityId: terminalId,
    detail: { shopId, code, displayName, purpose },
  });
  return getTerminal(shopId, terminalId);
}

export function createPairingCode(shopId, terminalId, actor) {
  const db = getDb();
  const terminal = db
    .prepare(`SELECT * FROM shop_terminals WHERE shop_id = ? AND terminal_id = ?`)
    .get(shopId, String(terminalId || "").trim());
  if (!terminal) fail(404, "Terminal not found.", "NOT_FOUND");
  if (!terminal.is_active) fail(409, "Activate the terminal before pairing.", "INACTIVE");

  const raw = randomBytes(3).toString("hex").toUpperCase(); // 6 hex chars
  const displayCode = `${raw.slice(0, 3)}-${raw.slice(3)}`;
  const codeId = newId("tpair");
  const ts = nowIso();
  const expiresAt = new Date(Date.now() + PAIR_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO shop_terminal_pairing_codes (
       code_id, shop_id, terminal_id, code_hash, expires_at, consumed_at,
       created_by_user_id, created_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(codeId, shopId, terminal.terminal_id, hashToken(displayCode), expiresAt, actor.userId, ts);

  recordAudit({
    actorRole: actor.role,
    actorUserId: actor.userId,
    action: "terminal.pairing_code",
    entityType: "shop_terminal",
    entityId: terminal.terminal_id,
    detail: { shopId, codeId, expiresAt },
  });

  return {
    terminalId: terminal.terminal_id,
    displayName: terminal.display_name,
    code: displayCode,
    expiresAt,
    note: "Enter this code on the tablet or PC within 15 minutes. It is shown once.",
  };
}

export function revokeTerminalPairing(shopId, terminalId, actor) {
  const db = getDb();
  const terminal = db
    .prepare(`SELECT * FROM shop_terminals WHERE shop_id = ? AND terminal_id = ?`)
    .get(shopId, String(terminalId || "").trim());
  if (!terminal) fail(404, "Terminal not found.", "NOT_FOUND");
  const ts = nowIso();
  db.prepare(
    `UPDATE shop_terminals
     SET pair_token_hash = NULL, paired_at = NULL, last_seen_at = NULL, updated_at = ?
     WHERE shop_id = ? AND terminal_id = ?`
  ).run(ts, shopId, terminal.terminal_id);
  db.prepare(
    `UPDATE shop_terminal_pairing_codes
     SET consumed_at = COALESCE(consumed_at, ?)
     WHERE shop_id = ? AND terminal_id = ? AND consumed_at IS NULL`
  ).run(ts, shopId, terminal.terminal_id);
  db.prepare(
    `UPDATE staff_sessions
     SET terminal_id = NULL
     WHERE shop_id = ? AND terminal_id = ? AND revoked_at IS NULL`
  ).run(shopId, terminal.terminal_id);
  recordAudit({
    actorRole: actor.role,
    actorUserId: actor.userId,
    action: "terminal.revoke_pairing",
    entityType: "shop_terminal",
    entityId: terminal.terminal_id,
    detail: { shopId },
  });
  return getTerminal(shopId, terminal.terminal_id);
}

export function pairTerminalWithCode(shopId, rawCode) {
  const displayCode = String(rawCode || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (!/^[A-F0-9]{3}-?[A-F0-9]{3}$/.test(displayCode)) {
    fail(400, "Enter the 6-character pairing code from Admin.", "INVALID_CODE");
  }
  const normalized = displayCode.includes("-")
    ? displayCode
    : `${displayCode.slice(0, 3)}-${displayCode.slice(3)}`;
  const db = getDb();
  const now = nowIso();
  const row = db
    .prepare(
      `SELECT c.*, t.display_name, t.is_active, t.purpose, t.code AS terminal_code
       FROM shop_terminal_pairing_codes c
       JOIN shop_terminals t ON t.terminal_id = c.terminal_id AND t.shop_id = c.shop_id
       WHERE c.shop_id = ? AND c.code_hash = ?`
    )
    .get(shopId, hashToken(normalized));
  if (!row || row.consumed_at || row.expires_at <= now) {
    fail(400, "That pairing code is invalid or expired.", "PAIRING_FAILED");
  }
  if (!row.is_active) fail(409, "This terminal is inactive.", "INACTIVE");

  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE shop_terminal_pairing_codes
       SET consumed_at = ?
       WHERE code_id = ? AND consumed_at IS NULL`
    ).run(now, row.code_id);
    db.prepare(
      `UPDATE shop_terminals
       SET pair_token_hash = ?, paired_at = ?, last_seen_at = ?, updated_at = ?
       WHERE shop_id = ? AND terminal_id = ?`
    ).run(tokenHash, now, now, now, shopId, row.terminal_id);
  });
  tx();

  return {
    token,
    terminal: {
      terminalId: row.terminal_id,
      code: row.terminal_code,
      displayName: row.display_name,
      purpose: row.purpose,
    },
  };
}

export function readTerminalCookie(req) {
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== TERMINAL_COOKIE) continue;
    return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

export function terminalCookieHeader(token, { clear = false, secure = false } = {}) {
  const secureAttr = secure ? "; Secure" : "";
  if (clear || !token) {
    return `${TERMINAL_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureAttr}`;
  }
  // Long-lived device binding; Admin revoke clears server side.
  const maxAge = 60 * 60 * 24 * 400;
  return `${TERMINAL_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureAttr}`;
}

export function resolvePairedTerminal(shopId, req) {
  const token = readTerminalCookie(req);
  if (!token) return null;
  const row = getDb()
    .prepare(
      `SELECT * FROM shop_terminals
       WHERE shop_id = ? AND pair_token_hash = ? AND is_active = 1`
    )
    .get(shopId, hashToken(token));
  if (!row || !safeEqualHex(row.pair_token_hash, hashToken(token))) return null;
  getDb()
    .prepare(
      `UPDATE shop_terminals SET last_seen_at = ?, updated_at = ?
       WHERE shop_id = ? AND terminal_id = ?`
    )
    .run(nowIso(), nowIso(), shopId, row.terminal_id);
  return rowView(row);
}

export function attachTerminalToSession(shopId, sessionId, terminalId) {
  if (!sessionId || !terminalId) return;
  getDb()
    .prepare(
      `UPDATE staff_sessions
       SET terminal_id = ?
       WHERE shop_id = ? AND session_id = ? AND revoked_at IS NULL`
    )
    .run(terminalId, shopId, sessionId);
}

export function lanTerminalStatus(requestConfig) {
  // A request on this PC's loopback listener still reports the restaurant-network
  // address (lanPeer) so the Terminals page can show the QR codes for tablets.
  const config = requestConfig?.lanPeer
    ? { ...requestConfig, ...requestConfig.lanPeer, lanAccessReady: true, tlsReady: true }
    : requestConfig;
  return {
    loopback: Boolean(config.loopback),
    lanAccessReady: config.lanAccessReady === true,
    tlsReady: config.tlsReady === true,
    host: config.host,
    port: config.port,
    lanHostname: config.lanHostname || "",
    physicalPrintEnabled: Boolean(config.physicalPrintEnabled),
    browseUrl: config.lanAccessReady
      ? `https://${config.host}:${config.port}`
      : config.loopback
        ? `http://127.0.0.1:${config.port}`
        : "",
    pairUrl: config.lanAccessReady
      ? `https://${config.host}:${config.port}/pair.html`
      : config.loopback
        ? `http://127.0.0.1:${config.port}/pair.html`
        : "",
    namedUrl: config.lanAccessReady
      ? `https://${config.lanHostname}:${config.port}`
      : "",
    note: config.lanAccessReady
      ? "Phones: use the IP https URL (iOS cannot edit hosts). PCs may use gtct-pos after a hosts entry. Trust the certificate warning once for TEST."
      : "LAN listener is off. This computer only serves loopback until Mac LAN HTTPS is started.",
  };
}
