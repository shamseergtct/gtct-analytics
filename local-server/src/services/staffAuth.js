import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { getDb } from "../db/db.js";
import { isApprovedLanClient } from "../netPolicy.js";
import { newId } from "../util/ids.js";

const ADMIN_ROLE_ID = "role_admin";
const CASHIER_ROLE_ID = "role_cashier";
const SESSION_ROLE = {
  [ADMIN_ROLE_ID]: "admin",
  [CASHIER_ROLE_ID]: "cashier",
};

const DEVICE_PERMISSIONS = new Set([
  "sales.order.create",
  "customers.manage",
  "sales.delivery_fee.edit",
  "menu.sold_out.update",
]);
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const LOGIN_FAILURE_LIMIT = 8;
export const LOGIN_IP_FAILURE_LIMIT = 40;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCK_MS = 60 * 1000;
const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 2 * 60 * 60 * 1000;

const loginFailures = new Map();
let dummyStored = "";

export class StaffAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "StaffAuthError";
    this.code = code;
  }
}

export function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

export function validatePassword(password, username) {
  const value = String(password ?? "");
  const user = normalizeUsername(username);
  if (value.length < 8 || value.length > 128) {
    return "Use a password of at least 8 characters.";
  }
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return "Use a password with letters and numbers.";
  }
  if (user && value.toLowerCase() === user) {
    return "The password must be different from the username.";
  }
  if (user.length >= 3 && value.toLowerCase().includes(user)) {
    return "The password must not contain the username.";
  }
  return "";
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
    const salt = Buffer.from(parts[4], "base64url");
    const expected = Buffer.from(parts[5], "base64url");
    if (salt.length < 16 || expected.length !== SCRYPT_KEYLEN) return false;
    const actual = scryptSync(String(password), salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function dummyHash() {
  if (!dummyStored) dummyStored = hashPassword(randomBytes(32).toString("base64url"));
  return dummyStored;
}

export function hashSessionToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function clearLoginThrottle() {
  loginFailures.clear();
}

function clientAddress(req) {
  return String(req.socket?.remoteAddress || "")
    .replace(/^::ffff:/, "")
    .slice(0, 80);
}

function failureKeys(req, username) {
  const ip = clientAddress(req);
  return [
    { key: `${ip}|${username}`, limit: LOGIN_FAILURE_LIMIT },
    { key: `${ip}|*`, limit: LOGIN_IP_FAILURE_LIMIT },
  ];
}

function isLocked(key, now) {
  const row = loginFailures.get(key);
  if (!row) return false;
  if (row.lockedUntil && row.lockedUntil > now) return true;
  if (row.lockedUntil && row.lockedUntil <= now) {
    loginFailures.delete(key);
    return false;
  }
  if (now - row.windowStart > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return false;
}

function recordFailure(key, now, limit) {
  let row = loginFailures.get(key);
  if (!row || now - row.windowStart > LOGIN_WINDOW_MS) {
    row = { windowStart: now, count: 0, lockedUntil: 0 };
  }
  row.count += 1;
  if (row.count >= limit) row.lockedUntil = now + LOGIN_LOCK_MS;
  loginFailures.set(key, row);
}

function invalidCredentials() {
  return { ok: false, status: 401, error: "Invalid username or password." };
}

function noteFailure(req, username) {
  const now = Date.now();
  for (const item of failureKeys(req, username)) {
    recordFailure(item.key, now, item.limit);
  }
}

function lockedOut(req, username) {
  const now = Date.now();
  return failureKeys(req, username).some((item) => isLocked(item.key, now));
}

export function createFirstAdmin({ shopId, fullName, username, password }) {
  const shop = String(shopId || "").trim();
  const name = String(fullName || "").trim();
  const rawUsername = String(username || "").trim();
  const normalized = normalizeUsername(rawUsername);
  if (!shop) throw new StaffAuthError("This shop was not found.", "shop_missing");
  if (!name || name.length > 80) {
    throw new StaffAuthError("Enter the administrator’s name.", "invalid_name");
  }
  if (!/^[a-z0-9._-]{3,40}$/.test(normalized)) {
    throw new StaffAuthError(
      "Use a username of 3–40 letters, numbers, dots, underscores, or hyphens.",
      "invalid_username"
    );
  }
  const passwordError = validatePassword(password, rawUsername);
  if (passwordError) throw new StaffAuthError(passwordError, "weak_password");

  const passwordHash = hashPassword(password);
  if (
    passwordHash.length < 32 ||
    passwordHash.includes(String(password)) ||
    !passwordHash.startsWith(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$`)
  ) {
    throw new StaffAuthError("Password could not be stored safely.", "weak_password");
  }

  const db = getDb();
  const now = new Date().toISOString();
  const userId = newId("user");
  const run = db.transaction(() => {
    const shopRow = db.prepare(`SELECT shop_id FROM shop_settings WHERE shop_id = ?`).get(shop);
    if (!shopRow) throw new StaffAuthError("This shop was not found.", "shop_missing");
    const active = db
      .prepare(
        `SELECT u.user_id
         FROM staff_users u
         JOIN staff_user_roles r
           ON r.user_id = u.user_id AND r.shop_id = u.shop_id
         WHERE u.shop_id = ?
           AND u.is_active = 1
           AND r.role_id = ?
           AND r.revoked_at IS NULL
         LIMIT 1`
      )
      .get(shop, ADMIN_ROLE_ID);
    if (active) {
      throw new StaffAuthError("An active admin already exists for this shop.", "active_admin_exists");
    }
    const taken = db
      .prepare(`SELECT user_id FROM staff_users WHERE shop_id = ? AND username_normalized = ?`)
      .get(shop, normalized);
    if (taken) throw new StaffAuthError("That username is already in use.", "username_taken");
    db.prepare(
      `INSERT INTO staff_users (
         user_id, shop_id, full_name, username, username_normalized, password_hash,
         is_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(userId, shop, name, rawUsername, normalized, passwordHash, now, now);
    db.prepare(
      `INSERT INTO staff_user_roles (shop_id, user_id, role_id, assigned_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`
    ).run(shop, userId, ADMIN_ROLE_ID, now);
  });

  try {
    run.immediate();
  } catch (err) {
    if (err instanceof StaffAuthError) throw err;
    if (/UNIQUE/i.test(String(err.message))) {
      throw new StaffAuthError("That username is already in use.", "username_taken");
    }
    throw err;
  }

  return { userId, username: rawUsername, shopId: shop };
}

function lookupStaffUser(shopId, normalized) {
  return getDb()
    .prepare(
      `SELECT u.user_id, u.password_hash, u.is_active, u.username, u.full_name, r.role_id
       FROM staff_users u
       LEFT JOIN staff_user_roles r
         ON r.user_id = u.user_id
        AND r.shop_id = u.shop_id
        AND r.revoked_at IS NULL
        AND r.role_id IN (?, ?)
       WHERE u.shop_id = ? AND u.username_normalized = ?
       ORDER BY CASE WHEN r.role_id = ? THEN 0 ELSE 1 END
       LIMIT 1`
    )
    .get(ADMIN_ROLE_ID, CASHIER_ROLE_ID, shopId, normalized, ADMIN_ROLE_ID);
}

export function loadStaffPermissions(shopId, userId, roleId) {
  if (!shopId || !userId || !roleId) return [];
  return getDb()
    .prepare(
      `SELECT permission_code FROM staff_role_permissions
       WHERE role_id = ? AND revoked_at IS NULL
       UNION
       SELECT permission_code FROM staff_user_permissions
       WHERE shop_id = ? AND user_id = ? AND revoked_at IS NULL`
    )
    .all(roleId, shopId, userId)
    .map((row) => row.permission_code);
}

export function authAllows(auth, code) {
  if (!auth?.ok) return false;
  if (auth.staff) return (auth.permissions || []).includes(code);
  if (auth.role === "admin") return true;
  if (auth.role === "device") return DEVICE_PERMISSIONS.has(code);
  return (auth.permissions || []).includes(code);
}

export function revokeStaffSessions(shopId, userId) {
  if (!shopId || !userId) return;
  getDb()
    .prepare(
      `UPDATE staff_sessions
       SET revoked_at = ?
       WHERE shop_id = ? AND user_id = ? AND revoked_at IS NULL`
    )
    .run(new Date().toISOString(), shopId, userId);
}

/**
 * Username and password check for the shop’s active Admin.
 * The caller must already have required a trusted browser Origin.
 * Legacy bearer secrets are not accepted here.
 */
export function authenticateStaffPassword(req, config, credentials) {
  const lanClient = isApprovedLanClient(req, config);
  if (!config.loopback && !lanClient) {
    return {
      ok: false,
      status: 403,
      error: "Browser sessions are only available on loopback-bound servers",
    };
  }
  const remote = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (
    !lanClient &&
    remote !== "127.0.0.1" &&
    remote !== "::1" &&
    remote !== "localhost"
  ) {
    return {
      ok: false,
      status: 403,
      error: "Browser sessions are only available from loopback clients",
    };
  }

  const username = credentials?.username;
  const password = credentials?.password;
  if (typeof username !== "string" || typeof password !== "string" || !username.trim() || !password) {
    return { ok: false, status: 400, error: "Enter your username and password." };
  }

  const normalized = normalizeUsername(username).slice(0, 80);
  if (lockedOut(req, normalized)) {
    return {
      ok: false,
      status: 429,
      error: "Too many sign-in attempts. Wait a moment and try again.",
    };
  }

  const shaped = /^[a-z0-9._-]{3,40}$/.test(normalized);
  const user = shaped ? lookupStaffUser(config.testTenantId, normalized) : null;
  const sessionRole = SESSION_ROLE[user?.role_id] || "";
  const match = verifyPassword(password, user?.password_hash || dummyHash());
  const allowed = Boolean(user) && user.is_active === 1 && Boolean(sessionRole) && match;
  if (!allowed) {
    noteFailure(req, normalized);
    return invalidCredentials();
  }

  loginFailures.delete(`${clientAddress(req)}|${normalized}`);
  const issued = issueStaffSession({ shopId: config.testTenantId, userId: user.user_id });
  return {
    ok: true,
    role: sessionRole,
    deviceId: issued.deviceId,
    userId: issued.userId,
    token: issued.token,
  };
}

export function issueStaffSession({ shopId, userId }) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const nowIso = now.toISOString();
  const absolute = new Date(now.getTime() + ABSOLUTE_MS).toISOString();
  const idle = new Date(now.getTime() + IDLE_MS).toISOString();
  const sessionId = newId("sess");
  const db = getDb();
  db.prepare(
    `INSERT INTO staff_sessions (
       session_id, shop_id, user_id, token_hash, created_at, last_activity_at,
       absolute_expires_at, idle_expires_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
  ).run(sessionId, shopId, userId, tokenHash, nowIso, nowIso, absolute, idle);
  return { token, sessionId, userId, deviceId: `staff:${userId}` };
}

function isFuture(iso, nowMs) {
  const time = Date.parse(iso);
  return Number.isFinite(time) && time > nowMs;
}

/**
 * Returns the staff session, "invalid" when the token is known but unusable,
 * or null when this cookie is not a staff session.
 */
export function takeStaffSession(rawToken, shopId) {
  if (!rawToken || !shopId) return null;
  const tokenHash = hashSessionToken(rawToken);
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.session_id, s.user_id, s.shop_id, s.absolute_expires_at, s.idle_expires_at,
              s.revoked_at, u.username, u.full_name, u.is_active, r.role_id
       FROM staff_sessions s
       JOIN staff_users u ON u.user_id = s.user_id AND u.shop_id = s.shop_id
       LEFT JOIN staff_user_roles r
         ON r.user_id = u.user_id
        AND r.shop_id = u.shop_id
        AND r.revoked_at IS NULL
        AND r.role_id IN (?, ?)
       WHERE s.token_hash = ? AND s.shop_id = ?
       ORDER BY CASE WHEN r.role_id = ? THEN 0 ELSE 1 END
       LIMIT 1`
    )
    .get(ADMIN_ROLE_ID, CASHIER_ROLE_ID, tokenHash, shopId, ADMIN_ROLE_ID);
  if (!row) return null;

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const sessionRole = SESSION_ROLE[row.role_id] || "";
  const usable =
    !row.revoked_at &&
    row.is_active === 1 &&
    Boolean(sessionRole) &&
    isFuture(row.absolute_expires_at, now) &&
    isFuture(row.idle_expires_at, now);
  if (!usable) {
    if (!row.revoked_at && (row.is_active !== 1 || !sessionRole)) {
      db.prepare(
        `UPDATE staff_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL`
      ).run(nowIso, row.session_id);
    }
    return "invalid";
  }

  const idleExpires = new Date(now + IDLE_MS).toISOString();
  const updated = db
    .prepare(
      `UPDATE staff_sessions
       SET last_activity_at = ?, idle_expires_at = ?
       WHERE session_id = ?
         AND revoked_at IS NULL
         AND absolute_expires_at > ?
         AND idle_expires_at > ?`
    )
    .run(nowIso, idleExpires, row.session_id, nowIso, nowIso);
  if (updated.changes !== 1) return "invalid";
  return {
    userId: row.user_id,
    username: row.username,
    fullName: row.full_name,
    shopId: row.shop_id,
    role: sessionRole,
    roleId: row.role_id,
    permissions: loadStaffPermissions(row.shop_id, row.user_id, row.role_id),
  };
}

export function revokeStaffSessionToken(rawToken, shopId) {
  if (!rawToken || !shopId) return;
  getDb()
    .prepare(
      `UPDATE staff_sessions
       SET revoked_at = ?
       WHERE token_hash = ? AND shop_id = ? AND revoked_at IS NULL`
    )
    .run(new Date().toISOString(), hashSessionToken(rawToken), shopId);
}
