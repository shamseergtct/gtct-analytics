/**
 * Isolated test staff for acceptance scripts.
 * Creates accounts only in the database that is already open.
 * Never reads or writes the restaurant database.
 */
import http from "node:http";
import { createFirstAdmin } from "../services/staffAuth.js";
import { createStaffUser } from "../services/staffUsers.js";
import { withSubmissionId } from "./orderRequest.js";

export const TEST_ADMIN_USERNAME = "test.admin";
export const TEST_ADMIN_PASSWORD = "Harbor-Cedar-21";
export const TEST_CASHIER_USERNAME = "test.cashier";
export const TEST_CASHIER_PASSWORD = "Market-Cedar-22";

export function httpJson(port, method, urlPath, session, body, { origin = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(withSubmissionId(body)) : null;
    const headers = { Accept: "application/json" };
    if (session || origin) headers.Origin = `http://127.0.0.1:${port}`;
    if (session) headers.Cookie = `gtct_ls_session=${encodeURIComponent(session)}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { raw: text };
          }
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sessionCookie(res) {
  const raw = res.headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const match = /gtct_ls_session=([^;]+)/.exec(joined);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

async function login(port, username, password) {
  const res = await httpJson(
    port,
    "POST",
    "/v1/session/login",
    null,
    { username, password },
    { origin: true }
  );
  const cookie = sessionCookie(res);
  if (res.status !== 200 || !cookie) {
    throw new Error(res.json?.error || "test staff sign-in failed");
  }
  return cookie;
}

/**
 * Admin and Cashier sessions for one temporary shop database.
 * `device` is the Cashier cookie so older tests keep their variable name.
 */
export async function openRoleSessions(port, shopId) {
  const adminUser = createFirstAdmin({
    shopId,
    fullName: "Test Admin",
    username: TEST_ADMIN_USERNAME,
    password: TEST_ADMIN_PASSWORD,
  });
  const cashier = createStaffUser(
    shopId,
    {
      fullName: "Test Cashier",
      username: TEST_CASHIER_USERNAME,
      password: TEST_CASHIER_PASSWORD,
      confirmPassword: TEST_CASHIER_PASSWORD,
      role: "cashier",
      isActive: true,
      permissions: [],
    },
    { role: "admin", userId: adminUser.userId }
  );
  const admin = await login(port, TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);
  const device = await login(port, TEST_CASHIER_USERNAME, TEST_CASHIER_PASSWORD);
  return {
    admin,
    device,
    adminUserId: adminUser.userId,
    cashierUserId: cashier.userId,
    cashierDeviceId: `staff:${cashier.userId}`,
  };
}
