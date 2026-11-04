/**
 * Step 4C-A — HTTPS foundation and LAN gates.
 * Uses a temporary database and a temporary test certificate.
 * Does not listen outside 127.0.0.1 and does not modify the restaurant database.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDataDirs, WELL_KNOWN_ADMIN_TOKEN, WELL_KNOWN_DEV_TOKEN } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createFirstAdmin } from "../services/staffAuth.js";
import { createStaffUser } from "../services/staffUsers.js";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
  TEST_CASHIER_PASSWORD,
  TEST_CASHIER_USERNAME,
} from "./testHttp.js";
import { withSubmissionId } from "./orderRequest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 18997;
const results = [];

function pass(name) {
  results.push(name);
  console.log(`PASS ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function listen(server, config) {
  return new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (err) => (err ? reject(err) : resolve()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function writeTestCert(dir) {
  const keyPath = path.join(dir, "test-key.pem");
  const certPath = path.join(dir, "test-cert.pem");
  const configPath = path.join(dir, "openssl.cnf");
  fs.writeFileSync(
    configPath,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3_req",
      "prompt = no",
      "[dn]",
      "CN = 127.0.0.1",
      "[v3_req]",
      "subjectAltName = DNS:localhost,IP:127.0.0.1",
      "basicConstraints = CA:FALSE",
      "keyUsage = digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "",
    ].join("\n")
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-nodes",
      "-config",
      configPath,
    ],
    { stdio: "ignore" }
  );
  return { keyPath, certPath, certPem: fs.readFileSync(certPath) };
}

function cookieFrom(res) {
  const raw = res.headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const match = /gtct_ls_session=([^;]+)/.exec(joined);
  return {
    joined,
    value: match?.[1] ? decodeURIComponent(match[1]) : "",
  };
}

function requestJson(protocol, port, method, urlPath, { ca, cookie, origin, body, bearer } = {}) {
  const payload = body == null ? null : JSON.stringify(withSubmissionId(body));
  const headers = { Accept: "application/json" };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = `gtct_ls_session=${encodeURIComponent(cookie)}`;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  const lib = protocol === "https" ? https : http;
  const options = {
    host: "127.0.0.1",
    port,
    path: urlPath,
    method,
    headers,
    agent: false,
  };
  if (protocol === "https") {
    options.ca = ca;
    options.servername = "localhost";
    options.minVersion = "TLSv1.2";
    options.rejectUnauthorized = true;
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(options, (res) => {
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
        resolve({
          status: res.statusCode,
          json,
          headers: res.headers,
          protocol: res.socket?.getProtocol?.() || "",
        });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function expectConfigError(mutate, pattern) {
  const keys = [
    "GTCT_LOCAL_HOST",
    "GTCT_ALLOW_LAN_BIND",
    "GTCT_ENABLE_LAN_LISTENER",
    "GTCT_LAN_BIND_ADDRESS",
    "GTCT_LAN_HOSTNAME",
    "GTCT_TLS_CERT_FILE",
    "GTCT_TLS_KEY_FILE",
    "GTCT_TLS_KEY_PASSPHRASE",
    "GTCT_LOCAL_API_TOKEN",
    "GTCT_LOCAL_ADMIN_TOKEN",
    "GTCT_ENABLE_PHYSICAL_PRINT",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    mutate();
    let thrown = null;
    try {
      loadConfig({ mode: "http" });
    } catch (err) {
      thrown = err;
    }
    assert(thrown, "server configuration was accepted");
    assert(pattern.test(String(thrown.message || "")), thrown.message);
    assert(!/BEGIN [A-Z ]*PRIVATE KEY/.test(String(thrown.message || "")), "private key appeared in an error");
    return thrown;
  } finally {
    for (const key of keys) {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

async function restartCheck() {
  const port = Number(process.env.GTCT_LOCAL_PORT);
  const ca = fs.readFileSync(process.env.GTCT_TLS_CERT_FILE);
  const cookie = fs.readFileSync(process.env.GTCT_LAN_COOKIE_FILE, "utf8").trim();
  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  const server = createServer(config);
  await listen(server, config);
  try {
    const me = await requestJson("https", port, "GET", "/v1/session/me", { ca, cookie });
    if (me.status !== 200 || me.json?.role !== "admin") process.exit(1);
  } finally {
    await closeServer(server);
    closeDatabase();
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-lan-foundation-"));
  const { keyPath, certPath, certPem } = writeTestCert(tempRoot);
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = String(PORT);
  delete process.env.GTCT_TLS_CERT_FILE;
  delete process.env.GTCT_TLS_KEY_FILE;
  delete process.env.GTCT_TLS_KEY_PASSPHRASE;
  delete process.env.GTCT_ALLOW_LAN_BIND;
  delete process.env.GTCT_ENABLE_LAN_LISTENER;
  delete process.env.GTCT_LAN_BIND_ADDRESS;
  delete process.env.GTCT_LAN_HOSTNAME;
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_LOCAL_API_TOKEN;
  delete process.env.GTCT_LOCAL_ADMIN_TOKEN;
  delete process.env.GTCT_ALLOW_DEV_TOKEN;

  try {
    const httpConfig = loadConfig({ mode: "http" });
    assert(httpConfig.host === "127.0.0.1" && httpConfig.loopback, "default bind moved");
    assert(!httpConfig.tls && httpConfig.tlsReady === false && httpConfig.lanAccessReady === false, "default TLS or LAN was enabled");
    assert(httpConfig.physicalPrintEnabled === false, "physical print on");
    const httpServer = createServer(httpConfig);
    await listen(httpServer, httpConfig);
    try {
      const health = await requestJson("http", PORT, "GET", "/health");
      assert(health.status === 200 && health.json.ok === true, "loopback health");
      assert(health.json.lanAccessReady === false && health.json.tlsReady === false, "health flags");
      assert(!("dataDir" in health.json) && !("menuImagesDir" in health.json), "health exposed a path");
      assert(!("node" in health.json) && !("platform" in health.json), "health exposed runtime details");
      const anon = await requestJson("http", PORT, "GET", "/v1/menu-items");
      assert(anon.status === 401, "anonymous HTTP API was allowed");
    } finally {
      await closeServer(httpServer);
    }
    pass("loopback-http");

    expectConfigError(() => {
      process.env.GTCT_TLS_CERT_FILE = certPath;
      delete process.env.GTCT_TLS_KEY_FILE;
    }, /will not fall back to HTTP/i);
    const badCert = path.join(tempRoot, "bad-cert.pem");
    const badKey = path.join(tempRoot, "bad-key.pem");
    fs.writeFileSync(badCert, "not-a-certificate");
    fs.writeFileSync(badKey, "not-a-private-key");
    expectConfigError(() => {
      process.env.GTCT_TLS_CERT_FILE = badCert;
      process.env.GTCT_TLS_KEY_FILE = badKey;
    }, /could not be loaded/i);
    pass("https-rejects-invalid-material");

    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "0.0.0.0";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "0.0.0.0";
      process.env.GTCT_TLS_CERT_FILE = certPath;
      process.env.GTCT_TLS_KEY_FILE = keyPath;
    }, /0\.0\.0\.0 or :: is not allowed/i);
    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "192.168.1.50";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "192.168.1.50";
    }, /valid HTTPS certificate/i);
    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "192.168.1.50";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_TLS_CERT_FILE = certPath;
      process.env.GTCT_TLS_KEY_FILE = keyPath;
    }, /same specific IPv4 address/i);
    const stillOff = expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "192.168.1.50";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "192.168.1.50";
      process.env.GTCT_TLS_CERT_FILE = certPath;
      process.env.GTCT_TLS_KEY_FILE = keyPath;
    }, /LAN listening is not enabled/i);
    assert(/not enabled/i.test(stillOff.message), "approved LAN settings started a listener");
    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "192.168.1.20";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_LOCAL_API_TOKEN = WELL_KNOWN_DEV_TOKEN;
      process.env.GTCT_LOCAL_ADMIN_TOKEN = WELL_KNOWN_ADMIN_TOKEN;
    }, /well-known development tokens/i);
    pass("lan-binding-stays-off");

    process.env.GTCT_LOCAL_HOST = "127.0.0.1";
    process.env.GTCT_TLS_CERT_FILE = certPath;
    process.env.GTCT_TLS_KEY_FILE = keyPath;
    delete process.env.GTCT_ALLOW_LAN_BIND;
    delete process.env.GTCT_LAN_BIND_ADDRESS;
    const httpsConfig = loadConfig({ mode: "http" });
    assert(httpsConfig.tlsReady === true && httpsConfig.loopback && httpsConfig.lanAccessReady === false, "HTTPS loopback config");
    assert(httpsConfig.physicalPrintEnabled === false, "physical print enabled with HTTPS");
    ensureDataDirs(httpsConfig);
    initLogger(httpsConfig.logDir);
    openDatabase(httpsConfig.dbPath);
    await runMigrations(getDb());
    seedSampleData(httpsConfig);
    const server = createServer(httpsConfig);
    await listen(server, httpsConfig);
    const origin = `https://127.0.0.1:${PORT}`;
    let adminCookie = "";
    let cashierCookie = "";
    try {
      const health = await requestJson("https", PORT, "GET", "/health", { ca: certPem });
      assert(health.status === 200 && health.json.tlsReady === true && health.json.lanAccessReady === false, "HTTPS health");
      assert(health.protocol === "TLSv1.2" || health.protocol === "TLSv1.3", `TLS version ${health.protocol}`);
      const missingOrigin = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca: certPem,
        body: { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
      });
      assert(missingOrigin.status === 403, "HTTPS login allowed a missing origin");
      const badOrigin = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca: certPem,
        origin: "https://evil.example",
        body: { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
      });
      assert(badOrigin.status === 403, "HTTPS login allowed another site");
      const httpOrigin = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca: certPem,
        origin: `http://127.0.0.1:${PORT}`,
        body: { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
      });
      assert(httpOrigin.status === 403, "HTTPS login allowed an HTTP origin");

      createFirstAdmin({
        shopId: httpsConfig.testTenantId,
        fullName: "Test Admin",
        username: TEST_ADMIN_USERNAME,
        password: TEST_ADMIN_PASSWORD,
      });
      const cashier = createStaffUser(
        httpsConfig.testTenantId,
        {
          fullName: "Test Cashier",
          username: TEST_CASHIER_USERNAME,
          password: TEST_CASHIER_PASSWORD,
          confirmPassword: TEST_CASHIER_PASSWORD,
          role: "cashier",
        },
        { role: "admin", userId: "pending" }
      );
      const adminLogin = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca: certPem,
        origin,
        body: { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
      });
      const adminSet = cookieFrom(adminLogin);
      adminCookie = adminSet.value;
      assert(adminLogin.status === 200 && adminCookie, "admin HTTPS login");
      assert(/HttpOnly/i.test(adminSet.joined) && /SameSite=Strict/i.test(adminSet.joined), "cookie flags");
      assert(/\bSecure\b/.test(adminSet.joined), "Secure cookie missing on HTTPS");
      assert(!adminSet.joined.includes(TEST_ADMIN_PASSWORD), "cookie contained a password");

      const cashierLogin = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca: certPem,
        origin,
        body: { username: TEST_CASHIER_USERNAME, password: TEST_CASHIER_PASSWORD },
      });
      cashierCookie = cookieFrom(cashierLogin).value;
      assert(cashierLogin.status === 200 && cashierCookie, "cashier HTTPS login");
      const cashierMe = await requestJson("https", PORT, "GET", "/v1/session/me", {
        ca: certPem,
        cookie: cashierCookie,
      });
      assert(cashierMe.json?.role === "cashier", "cashier session");
      assert(!cashierMe.json.permissions.includes("sales.price_override"), "cashier gained price override");
      assert(cashierMe.json.permissions.includes("sales.order.create"), "cashier cannot sell");

      const tokenLogin = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca: certPem,
        origin,
        body: { token: WELL_KNOWN_ADMIN_TOKEN },
      });
      assert(tokenLogin.status === 401, "legacy token login was accepted");
      const bearer = await requestJson("https", PORT, "GET", "/v1/menu-items", {
        ca: certPem,
        bearer: WELL_KNOWN_DEV_TOKEN,
      });
      assert(bearer.status === 401, "legacy bearer was accepted");
      const anon = await requestJson("https", PORT, "GET", "/v1/customers", { ca: certPem });
      assert(anon.status === 401, "customer API was public");

      const cfg = await requestJson("https", PORT, "GET", "/v1/config", {
        ca: certPem,
        cookie: adminCookie,
      });
      assert(cfg.status === 200 && cfg.json?.shop?.currencyDecimals != null, "shop config");
      assert(!("dataDir" in cfg.json) && !("printOutputDir" in cfg.json), "config exposed a filesystem path");

      const printer = await requestJson("https", PORT, "PUT", "/v1/printers", {
        ca: certPem,
        cookie: adminCookie,
        origin,
        body: {
          printerId: "prn_lan_test",
          displayName: "Stored Only",
          connectionType: "NETWORK_TCP",
          host: "10.1.1.10",
          port: 9100,
        },
      });
      assert(printer.status === 200, "admin printer save");
      const cashierPrinters = await requestJson("https", PORT, "GET", "/v1/printers", {
        ca: certPem,
        cookie: cashierCookie,
      });
      assert(!JSON.stringify(cashierPrinters.json).includes("10.1.1.10"), "cashier saw a printer address");
      const adminPrinters = await requestJson("https", PORT, "GET", "/v1/printers", {
        ca: certPem,
        cookie: adminCookie,
      });
      assert(JSON.stringify(adminPrinters.json).includes("10.1.1.10"), "admin lost printer address");

      const order = await requestJson("https", PORT, "POST", "/v1/test-orders", {
        ca: certPem,
        cookie: cashierCookie,
        origin,
        body: {
          orderNumber: "LAN-FOUNDATION-1",
          orderType: "TAKEAWAY",
          lines: [{ itemId: "item_orange_juice", quantity: 1 }],
        },
      });
      assert(order.status === 201 && order.json?.created === true, "order was not created");
      const replay = await requestJson("https", PORT, "POST", "/v1/test-orders", {
        ca: certPem,
        cookie: cashierCookie,
        origin,
        body: {
          orderNumber: "LAN-FOUNDATION-1",
          orderType: "TAKEAWAY",
          lines: [{ itemId: "item_orange_juice", quantity: 1 }],
        },
      });
      assert(replay.status === 200 && replay.json?.created === false, "duplicate order number created a second order");
      const jobs = await requestJson("https", PORT, "GET", "/v1/print-jobs", {
        ca: certPem,
        cookie: cashierCookie,
      });
      assert(
        (jobs.json?.jobs || []).some((job) => job.printer_id === "prn_mock_juice" || job.printer_id === "prn_mock_cashier"),
        "mock ticket was not queued"
      );

      const audit = await requestJson("https", PORT, "GET", "/v1/audit-events", {
        ca: certPem,
        cookie: cashierCookie,
      });
      assert(audit.status === 403, "cashier read the audit log");

      const deactivated = await requestJson("https", PORT, "PATCH", `/v1/staff-users/${cashier.userId}`, {
        ca: certPem,
        cookie: adminCookie,
        origin,
        body: { isActive: false },
      });
      assert(deactivated.status === 200, "cashier deactivation");
      const revoked = await requestJson("https", PORT, "GET", "/v1/session/me", {
        ca: certPem,
        cookie: cashierCookie,
      });
      assert(revoked.status === 401, "revoked cashier session still worked");

      const loggedOut = await requestJson("https", PORT, "POST", "/v1/session/logout", {
        ca: certPem,
        cookie: adminCookie,
        origin,
      });
      assert(/Secure/.test(cookieFrom(loggedOut).joined), "logout cookie was not Secure");
      const afterLogout = await requestJson("https", PORT, "GET", "/v1/session/me", {
        ca: certPem,
        cookie: adminCookie,
      });
      assert(afterLogout.status === 401, "logged-out admin session still worked");
    } finally {
      await closeServer(server);
      closeDatabase();
    }
    pass("https-sessions-and-protections");

    const reloginConfig = loadConfig({ mode: "http" });
    ensureDataDirs(reloginConfig);
    openDatabase(reloginConfig.dbPath);
    await runMigrations(getDb());
    const reloginServer = createServer(reloginConfig);
    await listen(reloginServer, reloginConfig);
    try {
      const login = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca: certPem,
        origin: `https://127.0.0.1:${PORT}`,
        body: { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
      });
      adminCookie = cookieFrom(login).value;
      assert(login.status === 200 && adminCookie, "admin could not sign in for restart");
    } finally {
      await closeServer(reloginServer);
      closeDatabase();
    }
    const cookieFile = path.join(tempRoot, "session-cookie.txt");
    fs.writeFileSync(cookieFile, adminCookie, { mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      env: {
        ...process.env,
        GTCT_LAN_RESTART_CHECK: "1",
        GTCT_LAN_COOKIE_FILE: cookieFile,
        GTCT_LOCAL_DATA_DIR: tempRoot,
        GTCT_LOCAL_HOST: "127.0.0.1",
        GTCT_LOCAL_PORT: String(PORT),
        GTCT_TLS_CERT_FILE: certPath,
        GTCT_TLS_KEY_FILE: keyPath,
      },
    });
    let childErr = "";
    child.stderr.on("data", (chunk) => {
      childErr += chunk;
    });
    const childCode = await new Promise((resolve) => child.on("close", resolve));
    fs.rmSync(cookieFile, { force: true });
    assert(childCode === 0, childErr || "session did not survive restart");
    pass("https-session-survives-restart");

    console.log(`lan foundation ${results.length} passed`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const started = process.env.GTCT_LAN_RESTART_CHECK === "1" ? restartCheck() : main();
started.catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
