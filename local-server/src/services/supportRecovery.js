import { createHash, timingSafeEqual } from "node:crypto";
import { clearLoginThrottle } from "./staffAuth.js";
import {
  findStaffUserIdByUsername,
  resetStaffPassword,
} from "./staffUsers.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const attempts = new Map();

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function prune(now) {
  for (const [key, entry] of attempts) {
    if (now - entry.first > WINDOW_MS) attempts.delete(key);
  }
}

function noteAttempt(key, now) {
  prune(now);
  const entry = attempts.get(key);
  if (!entry || now - entry.first > WINDOW_MS) {
    attempts.set(key, { first: now, count: 1 });
    return;
  }
  entry.count += 1;
}

function isLocked(key, now) {
  prune(now);
  const entry = attempts.get(key);
  return Boolean(entry && entry.count >= MAX_ATTEMPTS && now - entry.first <= WINDOW_MS);
}

export function supportMasterKeyConfigured(config) {
  const key = String(config?.supportMasterKey || "").trim();
  return key.length >= 24;
}

export function verifySupportMasterKey(provided, expected) {
  const exp = String(expected || "");
  if (exp.length < 24) return false;
  const a = createHash("sha256").update(String(provided || "")).digest();
  const b = createHash("sha256").update(exp).digest();
  return timingSafeEqual(a, b);
}

/**
 * GTCT support / shop-owner recovery using GTCT_SUPPORT_MASTER_KEY.
 * Only available when that env var is set on the restaurant server.
 */
export function resetPasswordWithSupportMasterKey(req, config, body) {
  const now = Date.now();
  const key = `support:${clientKey(req)}`;
  if (isLocked(key, now)) {
    return {
      ok: false,
      status: 429,
      error: "Too many recovery attempts. Wait a few minutes and try again.",
    };
  }
  if (!supportMasterKeyConfigured(config)) {
    noteAttempt(key, now);
    return {
      ok: false,
      status: 503,
      error: "Support recovery is not enabled on this restaurant PC. Use Reset Staff Password on the server.",
    };
  }

  const record = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const masterKey = String(record.masterKey || record.master_key || "");
  const username = String(record.username || "").trim();
  const password = record.password;
  const confirmPassword = record.confirmPassword ?? record.confirm_password;

  if (!verifySupportMasterKey(masterKey, config.supportMasterKey)) {
    noteAttempt(key, now);
    return { ok: false, status: 401, error: "Invalid recovery key." };
  }

  const found = findStaffUserIdByUsername(config.testTenantId, username);
  if (!found || !found.isActive) {
    noteAttempt(key, now);
    return { ok: false, status: 404, error: "That username was not found or is inactive." };
  }

  try {
    const result = resetStaffPassword(
      config.testTenantId,
      found.userId,
      { password, confirmPassword },
      { role: "support_master", userId: "support:master-key" }
    );
    clearLoginThrottle();
    attempts.delete(key);
    return { ok: true, username: result.username };
  } catch (err) {
    noteAttempt(key, now);
    return {
      ok: false,
      status: err.status || 400,
      error: err instanceof Error ? err.message : "Password could not be reset.",
    };
  }
}
