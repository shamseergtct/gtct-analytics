import { randomBytes } from "node:crypto";
import { isLoopbackHost } from "./config.js";
import { isApprovedLanClient } from "./netPolicy.js";
import {
  authenticateStaffPassword,
  revokeStaffSessionToken,
  takeStaffSession,
} from "./services/staffAuth.js";

/**
 * Staff sessions are stored in SQLite and survive a restart.
 * Shared Admin and Device bearer secrets are retired. In-memory sessions
 * created from those secrets are not accepted. Recovery is the shop Admin
 * username and password on this computer. Do not add a shared secret.
 */
const sessions = new Map();

const COOKIE_NAME = "gtct_ls_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function isRequestLoopback(req) {
  const remote = String(req.socket?.remoteAddress || "");
  const normalized = remote.replace(/^::ffff:/, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function isTrustedBrowserOrigin(req, config) {
  const origin = String(req.headers.origin || "");
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const encrypted = Boolean(req.socket?.encrypted);
  if (encrypted && url.protocol !== "https:") return false;
  if (!encrypted && url.protocol !== "http:") return false;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (port !== String(config.port)) return false;
  if (config?.lanAccessReady) {
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === String(config.lanHostname || "").toLowerCase()
    );
  }
  return (
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1"
  );
}

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function purgeExpired() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

export function createSession({ role, deviceId }) {
  purgeExpired();
  const id = randomBytes(32).toString("hex");
  const now = Date.now();
  sessions.set(id, {
    role,
    deviceId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return id;
}

export function destroySession(sessionId) {
  if (sessionId) sessions.delete(sessionId);
}

export function getSession(sessionId) {
  if (!sessionId) return null;
  purgeExpired();
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

export function readSessionId(req) {
  return parseCookies(req)[COOKIE_NAME] || "";
}

export function sessionCookieHeader(sessionId, { clear = false, secure = false } = {}) {
  const secureAttr = secure ? "; Secure" : "";
  if (clear) {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureAttr}`;
  }
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secureAttr}`;
}

/**
 * Shared bearer sign-in is retired.
 * Recovery is the shop Admin username and password. Do not add a shared secret.
 */
export function loginWithToken() {
  return {
    ok: false,
    status: 401,
    error: "Sign in with your username and password.",
  };
}

export function loginWithPassword(req, config, credentials) {
  if (!isTrustedBrowserOrigin(req, config)) {
    return {
      ok: false,
      status: 403,
      error: "Sign-in must come from this computer’s restaurant page.",
    };
  }
  const result = authenticateStaffPassword(req, config, credentials);
  if (!result.ok) return result;
  const token = result.token;
  return {
    ok: true,
    role: result.role,
    deviceId: result.deviceId,
    userId: result.userId,
    staff: true,
    cookie: sessionCookieHeader(token, { secure: Boolean(req.socket?.encrypted) }),
  };
}

export function logoutRequest(req, config) {
  const id = readSessionId(req);
  destroySession(id);
  if (config?.testTenantId) revokeStaffSessionToken(id, config.testTenantId);
  return {
    cookie: sessionCookieHeader("", {
      clear: true,
      secure: Boolean(req.socket?.encrypted),
    }),
  };
}

export function authenticateSession(req, config) {
  const loopbackSession = Boolean(config.loopback) && isRequestLoopback(req);
  if (!loopbackSession && !isApprovedLanClient(req, config)) return null;
  const raw = readSessionId(req);
  if (!raw) return null;
  const staff = takeStaffSession(raw, config.testTenantId);
  if (staff === "invalid") return null;
  if (!staff) return null;
  return {
    ok: true,
    role: staff.role,
    deviceId: `staff:${staff.userId}`,
    userId: staff.userId,
    username: staff.username,
    fullName: staff.fullName,
    permissions: staff.permissions || [],
    via: "session",
    staff: true,
  };
}

export { COOKIE_NAME, isLoopbackHost };
