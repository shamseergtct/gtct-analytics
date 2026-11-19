/**
 * Standalone password reset for a locked-out Admin on the restaurant PC.
 * Does not depend on newer staffUsers helpers — safe to copy onto an older install.
 *
 * Windows (installed pilot):
 *   set GTCT_LOCAL_DATA_DIR=%LOCALAPPDATA%\GTCT\RestaurantPilot
 *   cd /d "C:\Program Files\GTCT\Restaurant Pilot\app"
 *   ..\runtime\win-x64\node.exe src\scripts\emergencyResetPassword.mjs admin "NewPass12"
 *
 * Args: <username> <newPassword>
 */
import { randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SHOP_ID = "test-tenant-phase1";

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function validatePassword(password, username) {
  const value = String(password ?? "");
  const user = String(username || "").trim().toLowerCase();
  if (value.length < 8 || value.length > 128) return "Use a password of at least 8 characters.";
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return "Use a password with letters and numbers.";
  if (user && value.toLowerCase() === user) return "The password must be different from the username.";
  if (user.length >= 3 && value.toLowerCase().includes(user)) {
    return "The password must not contain the username.";
  }
  return "";
}

function resolveDbPath() {
  const override = String(process.env.GTCT_LOCAL_DATA_DIR || "").trim();
  if (override) return path.join(override, "gtct-local.sqlite");
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || "";
    return path.join(base, "GTCT", "RestaurantPilot", "gtct-local.sqlite");
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return path.join(root, "data", "gtct-local.sqlite");
}

const username = String(process.argv[2] || "").trim();
const password = String(process.argv[3] || "");
if (!username || !password) {
  console.error('Usage: node emergencyResetPassword.mjs <username> "<newPassword>"');
  process.exit(1);
}

const passwordError = validatePassword(password, username);
if (passwordError) {
  console.error(passwordError);
  process.exit(1);
}

const dbPath = resolveDbPath();
const db = new Database(dbPath);
try {
  const normalized = username.toLowerCase();
  const row = db
    .prepare(
      `SELECT user_id, username, is_active
       FROM staff_users
       WHERE shop_id = ? AND username_normalized = ?
       LIMIT 1`
    )
    .get(SHOP_ID, normalized);
  if (!row) {
    const all = db
      .prepare(`SELECT username FROM staff_users WHERE shop_id = ? ORDER BY username`)
      .all(SHOP_ID)
      .map((r) => r.username);
    console.error(`Username "${username}" not found. Known: ${all.join(", ") || "(none)"}`);
    process.exit(1);
  }
  if (!row.is_active) {
    console.error(`Account "${row.username}" is inactive.`);
    process.exit(1);
  }
  const now = new Date().toISOString();
  const passwordHash = hashPassword(password);
  db.prepare(
    `UPDATE staff_users SET password_hash = ?, updated_at = ? WHERE shop_id = ? AND user_id = ?`
  ).run(passwordHash, now, SHOP_ID, row.user_id);
  db.prepare(
    `UPDATE staff_sessions SET revoked_at = ? WHERE shop_id = ? AND user_id = ? AND revoked_at IS NULL`
  ).run(now, SHOP_ID, row.user_id);
  console.log(`Password reset for ${row.username}. Sign in on the restaurant page.`);
} finally {
  db.close();
}
