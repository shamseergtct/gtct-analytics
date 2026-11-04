/**
 * Step 4A — shared bearer secrets are retired.
 * Uses a temporary database. Does not modify the restaurant database.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadConfig, ensureDataDirs, WELL_KNOWN_ADMIN_TOKEN, WELL_KNOWN_DEV_TOKEN } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger, log } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { httpJson, openRoleSessions, TEST_ADMIN_PASSWORD, TEST_ADMIN_USERNAME } from "./testHttp.js";
import http from "node:http";
import { withSubmissionId } from "./orderRequest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const liveDbPath = path.join(root, "data", "gtct-local.sqlite");
const PORT = 18996;

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function liveSnapshot() {
  if (!fs.existsSync(liveDbPath)) return null;
  const db = new Database(liveDbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  try {
    const count = (table) => {
      const exists = db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table);
      return exists ? db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n : null;
    };
    return {
      customers: count("shop_customers"),
      orders: count("orders"),
      menu: count("menu_items"),
      staff: count("staff_users"),
    };
  } finally {
    db.close();
  }
}

function listen(server, config) {
  return new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (err) => (err ? reject(err) : resolve()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function bearerStatus(port, method, urlPath, secret, body) {
  const payload = body == null ? null : JSON.stringify(withSubmissionId(body));
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${secret}`,
    Origin: `http://127.0.0.1:${port}`,
  };
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: urlPath, method, headers, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieFrom(res) {
  const raw = res.headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const match = /gtct_ls_session=([^;]+)/.exec(joined);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
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
    const cookie = fs.readFileSync(process.env.GTCT_AUTH_COOKIE_FILE, "utf8").trim();
    const me = await httpJson(config.port, "GET", "/v1/session/me", cookie);
    const ok = me.status === 200 && me.json?.role === "admin" && me.json?.staff === true;
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
  if (process.env.GTCT_AUTH_RESTART_CHECK === "1") {
    await restartCheck();
    return;
  }

  const results = [];
  const pass = (name) => {
    results.push(name);
    log.info(`PASS ${name}`);
  };
  const before = liveSnapshot();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-auth-hardening-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = String(PORT);
  delete process.env.GTCT_ALLOW_LAN_BIND;
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_ALLOW_DEV_TOKEN;
  delete process.env.GTCT_LOCAL_API_TOKEN;
  delete process.env.GTCT_LOCAL_ADMIN_TOKEN;

  const config = loadConfig({ mode: "http" });
  assert(config.loopback && !config.apiToken && !config.adminToken, "loopback still required a shared secret");
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);
  const server = createServer(config);
  await listen(server, config);
  const port = config.port;
  const origin = `http://127.0.0.1:${port}`;

  try {
    const health = await httpJson(port, "GET", "/health");
    assert(health.status === 200 && health.json.ok === true, "health");
    const anon = await httpJson(port, "GET", "/v1/menu-items");
    assert(anon.status === 401, "anonymous API access was allowed");
    pass("unauthorized-rejected");

    const sessions = await openRoleSessions(port, config.testTenantId);
    const adminMe = await httpJson(port, "GET", "/v1/session/me", sessions.admin);
    const cashierMe = await httpJson(port, "GET", "/v1/session/me", sessions.device);
    assert(adminMe.status === 200 && adminMe.json.role === "admin" && adminMe.json.staff === true, "admin login");
    assert(cashierMe.status === 200 && cashierMe.json.role === "cashier", "cashier login");
    assert(cashierMe.json.permissions.includes("sales.order.create"), "cashier can sell");
    assert(!cashierMe.json.permissions.includes("staff.manage"), "cashier cannot manage staff");
    pass("admin-and-cashier-login");

    const longBearer = "c".repeat(40);
    for (const secret of [WELL_KNOWN_ADMIN_TOKEN, WELL_KNOWN_DEV_TOKEN, longBearer]) {
      assert(await bearerStatus(port, "GET", "/v1/menu-items", secret) === 401, "bearer read was accepted");
      assert(await bearerStatus(port, "GET", "/v1/session/me", secret) === 401, "bearer session was accepted");
      assert(
        await bearerStatus(port, "POST", "/v1/test-orders", secret, {
          orderNumber: "AUTH-BEARER",
          orderType: "TAKEAWAY",
          lines: [{ itemId: "item_chicken_burger", quantity: 1 }],
        }) === 401,
        "bearer order was accepted"
      );
    }
    const tokenLogin = await httpJson(
      port,
      "POST",
      "/v1/session/login",
      null,
      { token: WELL_KNOWN_ADMIN_TOKEN },
      { origin: true }
    );
    assert(tokenLogin.status === 401, "shared secret signed in");
    assert(await bearerStatus(port, "GET", "/v1/session/me", longBearer) === 401, "bearer reached session");
    const mixed = await new Promise((resolve, reject) => {
      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${longBearer}`,
        Cookie: `gtct_ls_session=${encodeURIComponent(sessions.admin)}`,
        Origin: origin,
      };
      const req = http.request(
        { host: "127.0.0.1", port, path: "/v1/session/me", method: "GET", headers, agent: false },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert(mixed === 401, "bearer token bypassed a staff session");
    const stillAdmin = await httpJson(port, "GET", "/v1/session/me", sessions.admin);
    assert(stillAdmin.status === 200 && stillAdmin.json.role === "admin", "staff session was damaged");
    pass("shared-secrets-rejected");

    const menu = await httpJson(port, "GET", "/v1/menu-items", sessions.admin);
    const burger = menu.json.menuItems.find((item) => item.item_id === "item_chicken_burger");
    const menuPrice = Number(burger.price_cents);
    const granted = await httpJson(
      port,
      "PATCH",
      `/v1/staff-users/${encodeURIComponent(sessions.cashierUserId)}`,
      sessions.admin,
      { permissions: ["sales.price_override"] }
    );
    assert(granted.status === 200, "grant price permission");
    const priced = await httpJson(port, "POST", "/v1/test-orders", sessions.device, {
      orderNumber: "AUTH-PRICE",
      orderType: "TAKEAWAY",
      lines: [
        {
          itemId: "item_chicken_burger",
          quantity: 1,
          unitBasePriceCents: menuPrice + 50,
          basePriceOverride: true,
        },
      ],
    });
    assert(priced.status === 201, priced.json?.error || "permitted override");
    const revoked = await httpJson(
      port,
      "PATCH",
      `/v1/staff-users/${encodeURIComponent(sessions.cashierUserId)}`,
      sessions.admin,
      { permissions: [] }
    );
    assert(revoked.status === 200, "revoke price permission");
    const pricedAgain = await httpJson(port, "POST", "/v1/test-orders", sessions.device, {
      orderNumber: "AUTH-PRICE-AGAIN",
      orderType: "TAKEAWAY",
      lines: [
        {
          itemId: "item_chicken_burger",
          quantity: 1,
          unitBasePriceCents: menuPrice + 50,
          basePriceOverride: true,
        },
      ],
    });
    assert(pricedAgain.status === 403, "revoked permission still worked");
    pass("revoked-permission");

    const deactivated = await httpJson(
      port,
      "PATCH",
      `/v1/staff-users/${encodeURIComponent(sessions.cashierUserId)}`,
      sessions.admin,
      { isActive: false }
    );
    assert(deactivated.status === 200, "deactivate cashier");
    const inactive = await httpJson(port, "GET", "/v1/menu-items", sessions.device);
    assert(inactive.status === 401, "inactive staff still had access");
    pass("inactive-staff-rejected");

    const logout = await httpJson(port, "POST", "/v1/session/logout", sessions.admin, {});
    assert(logout.status === 200, "logout");
    const afterLogout = await httpJson(port, "GET", "/v1/session/me", sessions.admin);
    assert(afterLogout.status === 401, "logged-out session still worked");
    pass("logout-revokes-session");
  } finally {
    await closeServer(server);
    closeDatabase();
  }

  const cookieFile = path.join(tempRoot, "session-cookie.txt");
  const reopen = loadConfig({ mode: "http" });
  ensureDataDirs(reopen);
  openDatabase(reopen.dbPath);
  await runMigrations(getDb());
  const restartServer = createServer(reopen);
  await listen(restartServer, reopen);
  let adminCookie = "";
  try {
    const login = await httpJson(
      reopen.port,
      "POST",
      "/v1/session/login",
      null,
      { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
      { origin: true }
    );
    adminCookie = cookieFrom(login);
    assert(login.status === 200 && adminCookie, "admin could not sign in again");
  } finally {
    await closeServer(restartServer);
    closeDatabase();
  }
  fs.writeFileSync(cookieFile, adminCookie, { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: root,
    env: {
      ...process.env,
      GTCT_AUTH_RESTART_CHECK: "1",
      GTCT_AUTH_COOKIE_FILE: cookieFile,
      GTCT_LOCAL_DATA_DIR: tempRoot,
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
  assert(childCode === 0, childErr || "session did not survive restart");
  pass("session-survives-restart");

  const after = liveSnapshot();
  if (before && after) {
    assert(after.customers === before.customers, "live customers changed");
    assert(after.orders === before.orders, "live orders changed");
    assert(after.menu === before.menu, "live menu changed");
    assert(after.staff === before.staff, "live staff changed");
  }
  pass("live-database-unchanged");
  log.info(`auth hardening ${results.length} passed`);
}

const started = process.env.GTCT_AUTH_RESTART_CHECK === "1" ? restartCheck() : main();
started.catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
