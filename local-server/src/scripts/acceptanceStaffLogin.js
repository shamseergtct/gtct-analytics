/**
 * Step 2 — first admin account and username login.
 * Uses a temporary database. Does not create an account in the restaurant database.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig, ensureDataDirs, WELL_KNOWN_ADMIN_TOKEN, WELL_KNOWN_DEV_TOKEN } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger, log } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import {
  clearLoginThrottle,
  createFirstAdmin,
  LOGIN_FAILURE_LIMIT,
  StaffAuthError,
  verifyPassword,
} from "../services/staffAuth.js";
import { createStaffUser } from "../services/staffUsers.js";
import { backupDatabase } from "./createFirstAdmin.js";
import { withSubmissionId } from "./orderRequest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const liveDbPath = path.join(root, "data", "gtct-local.sqlite");
const PORT = 18992;
const USERNAME = "first.admin";
const PASSWORD = "River-Stone-48";
const OTHER_PASSWORD = "Other-Stone-49";

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function liveSnapshot() {
  if (!fs.existsSync(liveDbPath)) return null;
  const db = new Database(liveDbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  try {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return {
      customers: count("shop_customers"),
      orders: count("orders"),
      menu: count("menu_items"),
    };
  } finally {
    db.close();
  }
}

function httpRaw(port, method, urlPath, { body, token, cookie, origin } = {}) {
  const payload = body == null ? null : JSON.stringify(withSubmissionId(body));
  return new Promise((resolve, reject) => {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cookie) headers.Cookie = `gtct_ls_session=${encodeURIComponent(cookie)}`;
    if (origin) headers.Origin = origin;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers },
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

function cookieHeader(res) {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw.join("\n") : String(raw || "");
}

function sessionCookie(res) {
  const match = /gtct_ls_session=([^;]+)/.exec(cookieHeader(res));
  if (!match?.[1]) return "";
  return decodeURIComponent(match[1]);
}

function listen(server, config) {
  return new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (err) => (err ? reject(err) : resolve()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function countTable(db, name) {
  const exists = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  if (!exists) return null;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
}

async function restartCheck() {
  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  let server;
  try {
    await runMigrations(getDb());
    server = createServer(config);
    await listen(server, config);
    const cookie = fs.readFileSync(process.env.GTCT_STAFF_COOKIE_FILE, "utf8").trim();
    const me = await httpRaw(config.port, "GET", "/v1/session/me", { cookie });
    const ok =
      me.status === 200 &&
      me.json?.authenticated === true &&
      me.json?.role === "admin" &&
      String(me.json?.deviceId || "").startsWith("staff:");
    if (!ok) {
      console.error("restart check failed");
      process.exitCode = 1;
    }
  } finally {
    if (server) await closeServer(server);
    closeDatabase();
  }
}

async function main() {
  const results = [];
  const pass = (name) => {
    results.push(name);
    log.info(`PASS ${name}`);
  };
  const liveBefore = liveSnapshot();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-staff-login-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = String(PORT);
  delete process.env.GTCT_ALLOW_LAN_BIND;
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_LOCAL_API_TOKEN;
  delete process.env.GTCT_LOCAL_ADMIN_TOKEN;

  const config = loadConfig({ mode: "script" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  const db = getDb();

  try {
    await runMigrations(db);
    assert(config.dbPath.startsWith(tempRoot), "test used the restaurant database");
    assert(db.prepare(`SELECT COUNT(*) AS n FROM staff_users`).get().n === 0, "users were seeded");

    let weak = false;
    try {
      createFirstAdmin({
        shopId: config.testTenantId,
        fullName: "First Admin",
        username: USERNAME,
        password: "short1",
      });
    } catch (err) {
      weak = err instanceof StaffAuthError && err.code === "weak_password";
    }
    assert(weak, "weak password was accepted");
    assert(db.prepare(`SELECT COUNT(*) AS n FROM staff_users`).get().n === 0, "weak password created a user");
    pass("weak-password-rejected");

    const created = createFirstAdmin({
      shopId: config.testTenantId,
      fullName: "First Admin",
      username: USERNAME,
      password: PASSWORD,
    });
    const stored = db
      .prepare(`SELECT password_hash, is_active, shop_id FROM staff_users WHERE user_id = ?`)
      .get(created.userId);
    assert(stored.shop_id === config.testTenantId, "admin was bound to the wrong shop");
    assert(stored.is_active === 1, "admin was inactive");
    assert(stored.password_hash.startsWith("scrypt$16384$8$1$"), "password hash method");
    assert(stored.password_hash.length >= 32, "password hash length");
    assert(!stored.password_hash.includes(PASSWORD), "password appeared in the hash");
    assert(verifyPassword(PASSWORD, stored.password_hash), "password did not verify");
    const grant = db
      .prepare(
        `SELECT role_id FROM staff_user_roles
         WHERE shop_id = ? AND user_id = ? AND revoked_at IS NULL`
      )
      .get(config.testTenantId, created.userId);
    assert(grant?.role_id === "role_admin", "admin role was not assigned");
    pass("first-admin-created");

    let duplicate = false;
    try {
      createFirstAdmin({
        shopId: config.testTenantId,
        fullName: "Second Admin",
        username: "second.admin",
        password: OTHER_PASSWORD,
      });
    } catch (err) {
      duplicate = err instanceof StaffAuthError && err.code === "active_admin_exists";
    }
    assert(duplicate, "second bootstrap admin was created");
    assert(db.prepare(`SELECT COUNT(*) AS n FROM staff_users`).get().n === 1, "user count changed");
    pass("duplicate-bootstrap-blocked");

    const hashBefore = stored.password_hash;
    db.prepare(`UPDATE staff_users SET is_active = 0 WHERE user_id = ?`).run(created.userId);
    let taken = false;
    try {
      createFirstAdmin({
        shopId: config.testTenantId,
        fullName: "First Admin",
        username: "First.Admin",
        password: OTHER_PASSWORD,
      });
    } catch (err) {
      taken = err instanceof StaffAuthError && err.code === "username_taken";
    }
    const hashAfter = db.prepare(`SELECT password_hash FROM staff_users WHERE user_id = ?`).get(created.userId)
      .password_hash;
    assert(taken, "duplicate username replaced an account");
    assert(hashAfter === hashBefore, "existing password hash was overwritten");
    assert(!verifyPassword(OTHER_PASSWORD, hashAfter), "replacement password was stored");
    db.prepare(`UPDATE staff_users SET is_active = 1 WHERE user_id = ?`).run(created.userId);
    pass("existing-account-not-overwritten");

    const backupPath = path.join(tempRoot, "backup.sqlite");
    await backupDatabase(config.dbPath, backupPath);
    const copy = new Database(backupPath, { readonly: true });
    try {
      assert(copy.prepare(`SELECT COUNT(*) AS n FROM staff_users`).get().n === 1, "backup missed the admin");
    } finally {
      copy.close();
    }
    pass("database-backup");

    const cli = spawn(process.execPath, [path.join(root, "src/scripts/createFirstAdmin.js")], {
      cwd: root,
      env: { ...process.env, GTCT_LOCAL_DATA_DIR: tempRoot },
    });
    let cliErr = "";
    cli.stderr.on("data", (chunk) => {
      cliErr += chunk;
    });
    const cliCode = await new Promise((resolve) => cli.on("close", resolve));
    assert(cliCode === 1, "non-interactive setup did not stop");
    assert(/terminal/i.test(cliErr), "non-interactive setup gave no terminal message");
    assert(!cliErr.includes(PASSWORD) && !cliErr.includes(OTHER_PASSWORD), "setup printed a password");
    assert(db.prepare(`SELECT COUNT(*) AS n FROM staff_users`).get().n === 1, "setup changed accounts");
    pass("setup-requires-a-terminal");

    for (const file of ["index.html", "menu.html", "shop-settings.html", "settings.html"]) {
      const text = fs.readFileSync(path.join(root, "public", file), "utf8");
      assert(text.includes("GTCT Restaurant"), `${file} missing restaurant name`);
      assert(text.includes(">Username<"), `${file} missing username`);
      assert(text.includes(">Password<"), `${file} missing password`);
      assert(text.includes("Sign in"), `${file} missing sign in`);
      assert(!/API token/i.test(text), `${file} still asks for a token`);
      assert(!text.includes(WELL_KNOWN_ADMIN_TOKEN), `${file} contains a development admin secret`);
      assert(!text.includes(WELL_KNOWN_DEV_TOKEN), `${file} contains a development device secret`);
    }
    for (const file of ["app.js", "menu.js", "shop-settings.js", "settings.js"]) {
      const text = fs.readFileSync(path.join(root, "public", file), "utf8");
      assert(text.includes("login-username"), `${file} missing username sign-in`);
      assert(text.includes("Signing in"), `${file} missing loading state`);
      assert(!text.includes("login-token"), `${file} still uses a token field`);
      assert(!text.includes(WELL_KNOWN_ADMIN_TOKEN), `${file} contains a development admin secret`);
      assert(!text.includes(WELL_KNOWN_DEV_TOKEN), `${file} contains a development device secret`);
    }
    pass("login-screens");

    const httpConfig = loadConfig({ mode: "http" });
    seedSampleData(httpConfig);
    const menuBefore = countTable(db, "menu_items");
    const customersBefore = countTable(db, "shop_customers");
    const ordersBefore = countTable(db, "orders");
    const blocksBefore = countTable(db, "shop_block_delivery_rates");
    const auditBefore = countTable(db, "audit_events");
    const shopNameBefore = db
      .prepare(`SELECT display_name FROM shop_settings WHERE shop_id = ?`)
      .get(config.testTenantId).display_name;

    clearLoginThrottle();
    const server = createServer(httpConfig);
    await listen(server, httpConfig);
    const origin = `http://127.0.0.1:${httpConfig.port}`;
    let restartCookie = "";
    try {
      const missingOrigin = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD },
      });
      assert(missingOrigin.status === 403, "password login allowed a missing origin");
      const evilOrigin = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD },
        origin: "http://evil.example",
      });
      assert(evilOrigin.status === 403, "password login allowed another site");
      const empty = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: "", password: "" },
        origin,
      });
      assert(empty.status === 400, "empty sign-in was not rejected");
      pass("login-origin-and-fields");

      const unknown = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: "nobody.user", password: "wrong-password-1" },
        origin,
      });
      const wrong = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: "wrong-password-1" },
        origin,
      });
      assert(unknown.status === 401 && wrong.status === 401, "invalid credentials were accepted");
      assert(unknown.json?.error === "Invalid username or password.", "invalid login message");
      assert(unknown.json?.error === wrong.json?.error, "errors revealed which username exists");
      assert(!JSON.stringify(unknown.json).includes("nobody.user"), "error revealed the username");
      assert(!JSON.stringify(unknown.json).includes(PASSWORD), "response contained a password");
      const mixed = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: {
          username: "nobody.user",
          password: "wrong-password-1",
          token: WELL_KNOWN_ADMIN_TOKEN,
          role: "admin",
        },
        origin,
      });
      assert(mixed.status === 401, "development token bypassed password login");
      pass("invalid-credentials-rejected");

      clearLoginThrottle();
      const login = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD, role: "device" },
        origin,
      });
      const cookie = sessionCookie(login);
      const setCookie = cookieHeader(login);
      assert(login.status === 200 && login.json?.role === "admin", "valid admin login failed");
      assert(String(login.json?.deviceId || "").startsWith("staff:"), "session was not a staff identity");
      assert(login.json?.deviceId !== "phase1-admin" && login.json?.deviceId !== "phase1-device", "shared device id was reused");
      assert(!JSON.stringify(login.json).includes(PASSWORD), "login response contained a password");
      assert(cookie && !setCookie.includes(PASSWORD), "cookie was missing or contained a password");
      assert(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), "cookie flags were weakened");
      assert(!/\bSecure\b/.test(setCookie), "Secure was set on this HTTP server");
      const sessions = db.prepare(`SELECT token_hash, revoked_at FROM staff_sessions`).all();
      assert(sessions.length === 1 && sessions[0].revoked_at == null, "login did not create one active session");
      assert(!JSON.stringify(sessions).includes(cookie), "session token was stored");
      const me = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie });
      assert(me.status === 200 && me.json?.role === "admin" && me.json?.canAdjustBasePrices === true, "admin session was not authorized");
      assert(me.json?.canAdjustAddonPrices === true, "admin add-on permission flag missing");
      pass("valid-login-and-session");

      db.prepare(`UPDATE staff_sessions SET last_activity_at = '2000-01-01T00:00:00.000Z' WHERE revoked_at IS NULL`).run();
      const touched = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie });
      const activity = db.prepare(`SELECT last_activity_at FROM staff_sessions WHERE revoked_at IS NULL`).get();
      assert(touched.status === 200 && activity?.last_activity_at !== "2000-01-01T00:00:00.000Z", "activity was not updated");
      pass("session-activity");

      const rotated = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD },
        origin,
      });
      const rotatedCookie = sessionCookie(rotated);
      const oldMe = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie });
      const newMe = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie: rotatedCookie });
      const openSessions = db.prepare(`SELECT COUNT(*) AS n FROM staff_sessions WHERE revoked_at IS NULL`).get().n;
      assert(oldMe.status === 200 && newMe.status === 200 && openSessions === 2, "second terminal sign-in revoked the first");
      pass("two-terminal-sessions");

      const blockedLogout = await httpRaw(httpConfig.port, "POST", "/v1/session/logout", {
        cookie: rotatedCookie,
      });
      const stillThere = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie: rotatedCookie });
      assert(blockedLogout.status === 403 && stillThere.status === 200, "logout ignored origin protection");
      const loggedOut = await httpRaw(httpConfig.port, "POST", "/v1/session/logout", {
        cookie: rotatedCookie,
        origin,
      });
      const afterLogout = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie: rotatedCookie });
      assert(/Max-Age=0/.test(cookieHeader(loggedOut)), "logout did not clear the cookie");
      const otherTerminal = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie });
      assert(afterLogout.status === 401 && otherTerminal.status === 200, "logout revoked the wrong terminal");
      const revoked = db.prepare(`SELECT COUNT(*) AS n FROM staff_sessions WHERE revoked_at IS NULL`).get().n;
      assert(revoked === 1, "logout did not revoke only this terminal");
      pass("logout-revokes-session");

      clearLoginThrottle();
      const again = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD },
        origin,
      });
      const liveCookie = sessionCookie(again);
      db.prepare(`UPDATE staff_sessions SET absolute_expires_at = '2000-01-01T00:00:00.000Z' WHERE revoked_at IS NULL`).run();
      const expired = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie: liveCookie });
      assert(expired.status === 401, "expired session was accepted");
      pass("expired-session-rejected");

      clearLoginThrottle();
      const idleLogin = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD },
        origin,
      });
      const idleCookie = sessionCookie(idleLogin);
      db.prepare(`UPDATE staff_sessions SET idle_expires_at = '2000-01-01T00:00:00.000Z' WHERE revoked_at IS NULL`).run();
      const idle = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie: idleCookie });
      assert(idle.status === 401, "idle session was accepted");
      pass("idle-session-rejected");

      clearLoginThrottle();
      const revokeLogin = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD },
        origin,
      });
      const revokeCookie = sessionCookie(revokeLogin);
      db.prepare(`UPDATE staff_sessions SET revoked_at = ? WHERE revoked_at IS NULL`).run(new Date().toISOString());
      const revokedMe = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie: revokeCookie });
      assert(revokedMe.status === 401, "revoked session was accepted");
      pass("revoked-session-rejected");

      clearLoginThrottle();
      const activeLogin = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD },
        origin,
      });
      const activeCookie = sessionCookie(activeLogin);
      db.prepare(`UPDATE staff_users SET is_active = 0 WHERE user_id = ?`).run(created.userId);
      const inactiveMe = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie: activeCookie });
      const inactiveLogin = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD },
        origin,
      });
      assert(inactiveMe.status === 401, "inactive session was accepted");
      assert(inactiveLogin.status === 401 && inactiveLogin.json?.error === wrong.json?.error, "inactive login revealed the account");
      db.prepare(`UPDATE staff_users SET is_active = 1 WHERE user_id = ?`).run(created.userId);
      const afterInactive = await httpRaw(httpConfig.port, "GET", "/v1/session/me", { cookie: activeCookie });
      assert(afterInactive.status === 401, "inactive session stayed valid");
      pass("inactive-user-rejected");

      clearLoginThrottle();
      for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
        const attempt = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
          body: { username: USERNAME, password: "wrong-password-1" },
          origin,
        });
        assert(attempt.status === 401, "throttle started too early");
      }
      const locked = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD },
        origin,
      });
      assert(locked.status === 429, "repeated failures were not throttled");
      clearLoginThrottle();
      const unlocked = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { username: USERNAME, password: PASSWORD },
        origin,
      });
      restartCookie = sessionCookie(unlocked);
      assert(unlocked.status === 200 && restartCookie, "login did not recover after throttle");
      pass("login-throttled");

      const blockedOrder = await httpRaw(httpConfig.port, "POST", "/v1/test-orders", {
        cookie: restartCookie,
        body: {
          orderNumber: `STAFF-CSRF-${Date.now()}`,
          orderType: "TAKEAWAY",
          lines: [{ itemId: "item_chicken_burger", quantity: 1 }],
        },
      });
      assert(blockedOrder.status === 403, "cookie mutation skipped origin protection");
      const order = await httpRaw(httpConfig.port, "POST", "/v1/test-orders", {
        cookie: restartCookie,
        origin,
        body: {
          orderNumber: `STAFF-LOGIN-${Date.now()}`,
          orderType: "TAKEAWAY",
          lines: [{ itemId: "item_chicken_burger", quantity: 1 }],
        },
      });
      assert(order.status === 201, order.json?.error || "admin order failed");
      const menu = await httpRaw(httpConfig.port, "GET", "/v1/menu-items", { cookie: restartCookie });
      const shop = await httpRaw(httpConfig.port, "GET", "/v1/shop-settings", { cookie: restartCookie });
      const printers = await httpRaw(httpConfig.port, "GET", "/v1/printers", { cookie: restartCookie });
      const customers = await httpRaw(httpConfig.port, "GET", "/v1/customers", { cookie: restartCookie });
      const orderTypes = await httpRaw(httpConfig.port, "GET", "/v1/order-types", { cookie: restartCookie });
      const audit = await httpRaw(httpConfig.port, "GET", "/v1/audit-events", { cookie: restartCookie });
      assert(menu.status === 200 && Array.isArray(menu.json?.menuItems), "menu failed");
      assert(shop.status === 200 && shop.json?.shop, "shop settings failed");
      assert(printers.status === 200, "printers failed");
      assert(customers.status === 200, "customers failed");
      assert(orderTypes.status === 200, "order types failed");
      assert(audit.status === 200 && Array.isArray(audit.json?.events), "audit failed");
      pass("admin-routes");

      const sessionsBeforeCashier = db.prepare(`SELECT COUNT(*) AS n FROM staff_sessions`).get().n;
      createStaffUser(
        config.testTenantId,
        {
          fullName: "Lane Cashier",
          username: "lane.cashier",
          password: "Market-Cedar-22",
          confirmPassword: "Market-Cedar-22",
          role: "cashier",
        },
        { role: "admin", userId: created.userId }
      );
      const cashierLogin = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        origin,
        body: { username: "lane.cashier", password: "Market-Cedar-22" },
      });
      assert(cashierLogin.status === 200 && cashierLogin.json?.role === "cashier", "cashier login failed");
      const cashierCookie = sessionCookie(cashierLogin);
      assert(
        db.prepare(`SELECT COUNT(*) AS n FROM staff_sessions`).get().n === sessionsBeforeCashier + 1,
        "cashier login did not create a staff session"
      );
      const bearerLogin = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { token: WELL_KNOWN_DEV_TOKEN },
      });
      const bearerAudit = await httpRaw(httpConfig.port, "GET", "/v1/audit-events", {
        token: WELL_KNOWN_DEV_TOKEN,
      });
      const bearerPrinters = await httpRaw(httpConfig.port, "PUT", "/v1/printers", {
        token: WELL_KNOWN_DEV_TOKEN,
        body: {},
      });
      const cashierAudit = await httpRaw(httpConfig.port, "GET", "/v1/audit-events", {
        cookie: cashierCookie,
      });
      const cashierPrinters = await httpRaw(httpConfig.port, "PUT", "/v1/printers", {
        cookie: cashierCookie,
        origin,
        body: {},
      });
      const cashierOrder = await httpRaw(httpConfig.port, "POST", "/v1/test-orders", {
        cookie: cashierCookie,
        origin,
        body: {
          orderNumber: `STAFF-CASHIER-${Date.now()}`,
          orderType: "TAKEAWAY",
          lines: [{ itemId: "item_chicken_burger", quantity: 1 }],
        },
      });
      assert(bearerLogin.status === 401, "shared device secret signed in");
      assert(bearerAudit.status === 401, "shared device secret reached audit");
      assert(bearerPrinters.status === 401, "shared device secret changed printers");
      assert(cashierAudit.status === 403, "cashier reached audit");
      assert(cashierPrinters.status === 403, "cashier changed printers");
      assert(cashierOrder.status === 201, "cashier order failed");
      pass("cashier-access-and-retired-device-secret");

      const sessionsAfterCashier = db.prepare(`SELECT COUNT(*) AS n FROM staff_sessions`).get().n;
      const legacy = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { token: WELL_KNOWN_ADMIN_TOKEN },
      });
      const legacyEvil = await httpRaw(httpConfig.port, "POST", "/v1/session/login", {
        body: { token: WELL_KNOWN_ADMIN_TOKEN },
        origin: "http://evil.example",
      });
      const legacyApi = await httpRaw(httpConfig.port, "GET", "/v1/printers", {
        token: WELL_KNOWN_ADMIN_TOKEN,
      });
      assert(legacy.status === 401, "shared admin secret signed in");
      assert(legacyEvil.status === 401, "shared admin secret accepted another site");
      assert(legacyApi.status === 401, "shared admin secret reached printers");
      assert(
        db.prepare(`SELECT COUNT(*) AS n FROM staff_sessions`).get().n === sessionsAfterCashier,
        "shared secret created a staff session"
      );
      pass("shared-secrets-rejected");

      assert(countTable(db, "menu_items") === menuBefore, "menu rows changed");
      assert(countTable(db, "shop_customers") === customersBefore, "customers changed");
      assert(countTable(db, "shop_block_delivery_rates") === blocksBefore, "delivery charges changed");
      assert(countTable(db, "orders") === ordersBefore + 2, "order count was unexpected");
      assert(countTable(db, "audit_events") >= auditBefore, "audit history shrank");
      const shopNameAfter = db
        .prepare(`SELECT display_name FROM shop_settings WHERE shop_id = ?`)
        .get(config.testTenantId).display_name;
      assert(shopNameAfter === shopNameBefore, "shop name changed");
      const hashEnd = db.prepare(`SELECT password_hash FROM staff_users WHERE user_id = ?`).get(created.userId)
        .password_hash;
      assert(hashEnd === hashBefore, "stored password changed");
      pass("restaurant-data-preserved");
    } finally {
      await closeServer(server);
    }

    closeDatabase();
    const cookieFile = path.join(tempRoot, "session-cookie.txt");
    fs.writeFileSync(cookieFile, restartCookie, { mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      env: {
        ...process.env,
        GTCT_STAFF_RESTART_CHECK: "1",
        GTCT_STAFF_COOKIE_FILE: cookieFile,
        GTCT_LOCAL_DATA_DIR: tempRoot,
        GTCT_ALLOW_DEV_TOKEN: "true",
        GTCT_LOCAL_HOST: "127.0.0.1",
        GTCT_LOCAL_PORT: String(PORT),
      },
    });
    let childErr = "";
    child.stderr.on("data", (chunk) => {
      childErr += chunk;
    });
    const childCode = await new Promise((resolve) => child.on("close", resolve));
    fs.rmSync(cookieFile, { force: true });
    assert(childCode === 0, childErr.includes(restartCookie) ? "session did not survive restart" : childErr || "session did not survive restart");
    pass("session-survives-restart");

    process.env.GTCT_LOCAL_HOST = "192.168.1.20";
    process.env.GTCT_ALLOW_LAN_BIND = "true";
    process.env.GTCT_ALLOW_DEV_TOKEN = "true";
    process.env.GTCT_LOCAL_API_TOKEN = WELL_KNOWN_DEV_TOKEN;
    process.env.GTCT_LOCAL_ADMIN_TOKEN = WELL_KNOWN_ADMIN_TOKEN;
    let lanBlocked = false;
    try {
      loadConfig({ mode: "http" });
    } catch (err) {
      lanBlocked = /well-known development tokens/i.test(String(err.message || ""));
    }
    assert(lanBlocked, "development credentials were accepted for LAN");
    pass("development-credentials-blocked-for-lan");

    const liveAfter = liveSnapshot();
    if (liveBefore && liveAfter) {
      assert(liveAfter.customers >= liveBefore.customers, "restaurant customers decreased");
      assert(liveAfter.orders >= liveBefore.orders, "restaurant orders decreased");
      assert(liveAfter.menu >= liveBefore.menu, "restaurant menu decreased");
      pass("live-restaurant-data-unchanged");
    } else if (liveBefore || liveAfter) {
      throw new Error("restaurant database snapshot could not be compared");
    }
  } finally {
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  log.info(`staff login ${results.length} passed`);
}

if (process.env.GTCT_STAFF_RESTART_CHECK === "1") {
  await restartCheck();
} else {
  await main();
}
