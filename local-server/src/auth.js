import { createHash } from "node:crypto";
import { authenticateSession } from "./sessions.js";

function extractBearer(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

/**
 * Authenticate a loopback HttpOnly staff session cookie.
 * Shared Admin and Device bearer secrets are retired. Any Authorization
 * bearer is rejected and is not allowed to fall through to a cookie.
 * Recovery is the shop Admin username and password. Do not add a shared secret.
 */
export function authenticateRequest(req, config) {
  if (extractBearer(req)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const sessionAuth = authenticateSession(req, config);
  if (sessionAuth?.ok) return sessionAuth;

  return { ok: false, status: 401, error: "Unauthorized" };
}

export function requireRole(auth, roles) {
  if (!auth?.ok) return auth;
  if (!roles.includes(auth.role)) {
    return {
      ok: false,
      status: 403,
      error: "Administrator privileges required",
    };
  }
  return auth;
}

export function hashApiToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}
