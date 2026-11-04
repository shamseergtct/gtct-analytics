/**
 * Step 4C-B — prepared private LAN configuration.
 * Proves the opt-in rules and keeps the listener on 127.0.0.1.
 * Uses a temporary database and disposable certificates. Does not modify
 * the restaurant database, firewall, trust store, or virtual-machine network.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { isLoopbackHost, loadConfig, ensureDataDirs, WELL_KNOWN_DEV_TOKEN } from "../config.js";
import { openDatabase, runMigrations, closeDatabase, getDb } from "../db/db.js";
import { initLogger } from "../util/logger.js";
import { createServer } from "../http/server.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createFirstAdmin } from "../services/staffAuth.js";
import { createStaffUser } from "../services/staffUsers.js";
import { isApprovedLanClient } from "../netPolicy.js";
import {
  authenticateSession,
  isTrustedBrowserOrigin,
  sessionCookieHeader,
} from "../sessions.js";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
  TEST_CASHIER_PASSWORD,
  TEST_CASHIER_USERNAME,
} from "./testHttp.js";

const PORT = 18991;
const results = [];

function pass(name) {
  results.push(name);
  console.log(`PASS ${name}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}

function listen(server, config) {
  if (!isLoopbackHost(config.host)) {
    throw new Error("Refusing to listen outside 127.0.0.1");
  }
  return new Promise((resolve, reject) => {
    server.listen(config.port, config.host, (err) => (err ? reject(err) : resolve()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function writeCert(dir, name, san) {
  const keyPath = path.join(dir, `${name}-key.pem`);
  const certPath = path.join(dir, `${name}-cert.pem`);
  const configPath = path.join(dir, `${name}-openssl.cnf`);
  fs.writeFileSync(
    configPath,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = v3_req",
      "prompt = no",
      "[dn]",
      `CN = ${name}`,
      "[v3_req]",
      `subjectAltName = ${san}`,
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

function expectConfigError(mutate, pattern) {
  const keys = [
    "GTCT_LOCAL_HOST",
    "GTCT_LOCAL_PORT",
    "GTCT_LOCAL_DATA_DIR",
    "GTCT_ALLOW_LAN_BIND",
    "GTCT_ENABLE_LAN_LISTENER",
    "GTCT_LAN_BIND_ADDRESS",
    "GTCT_LAN_HOSTNAME",
    "GTCT_TLS_CERT_FILE",
    "GTCT_TLS_KEY_FILE",
    "GTCT_TLS_KEY_PASSPHRASE",
    "GTCT_ENABLE_PHYSICAL_PRINT",
    "GTCT_LOCAL_API_TOKEN",
    "GTCT_LOCAL_ADMIN_TOKEN",
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
  } finally {
    for (const key of keys) {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function requestJson(protocol, port, method, urlPath, { ca, cookie, origin, body, bearer } = {}) {
  const payload = body == null ? null : JSON.stringify(body);
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
        const raw = res.headers["set-cookie"];
        resolve({
          status: res.statusCode,
          json,
          setCookie: Array.isArray(raw) ? raw.join("\n") : String(raw || ""),
          protocol: res.socket?.getProtocol?.() || "",
        });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieValue(setCookie) {
  const match = /gtct_ls_session=([^;]+)/.exec(setCookie);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-lan-testing-"));
  const loopbackCert = writeCert(tempRoot, "loopback", "DNS:localhost,IP:127.0.0.1");
  const lanCert = writeCert(tempRoot, "lan", "DNS:gtct-pos");
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

  try {
    const defaults = loadConfig({ mode: "http" });
    assert(defaults.host === "127.0.0.1" && defaults.loopback, "default bind moved");
    assert(defaults.lanAccessReady === false && defaults.tlsReady === false, "default LAN or TLS was enabled");
    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "192.168.1.50";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "192.168.1.50";
      process.env.GTCT_TLS_CERT_FILE = lanCert.certPath;
      process.env.GTCT_TLS_KEY_FILE = lanCert.keyPath;
      process.env.GTCT_LAN_HOSTNAME = "gtct-pos";
    }, /LAN listening is not enabled/i);
    pass("default-lan-denied");

    expectConfigError(() => {
      process.env.GTCT_TLS_CERT_FILE = loopbackCert.certPath;
      delete process.env.GTCT_TLS_KEY_FILE;
    }, /will not fall back to HTTP/i);
    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "192.168.1.50";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_ENABLE_LAN_LISTENER = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "192.168.1.50";
      process.env.GTCT_LAN_HOSTNAME = "gtct-pos";
    }, /valid HTTPS certificate/i);
    pass("invalid-https-rejected");

    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "0.0.0.0";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_ENABLE_LAN_LISTENER = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "0.0.0.0";
      process.env.GTCT_TLS_CERT_FILE = lanCert.certPath;
      process.env.GTCT_TLS_KEY_FILE = lanCert.keyPath;
      process.env.GTCT_LAN_HOSTNAME = "gtct-pos";
    }, /0\.0\.0\.0 or :: is not allowed/i);
    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "8.8.8.8";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_ENABLE_LAN_LISTENER = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "8.8.8.8";
      process.env.GTCT_TLS_CERT_FILE = lanCert.certPath;
      process.env.GTCT_TLS_KEY_FILE = lanCert.keyPath;
      process.env.GTCT_LAN_HOSTNAME = "gtct-pos";
    }, /private IPv4 address/i);
    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "127.0.0.1";
      process.env.GTCT_ENABLE_LAN_LISTENER = "true";
    }, /cannot use the loopback address/i);
    pass("unapproved-address-rejected");

    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "192.168.1.50";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_ENABLE_LAN_LISTENER = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "192.168.1.50";
      process.env.GTCT_TLS_CERT_FILE = loopbackCert.certPath;
      process.env.GTCT_TLS_KEY_FILE = loopbackCert.keyPath;
      process.env.GTCT_LAN_HOSTNAME = "gtct-pos";
    }, /must name DNS:gtct-pos/i);
    expectConfigError(() => {
      process.env.GTCT_LOCAL_HOST = "192.168.1.50";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_ENABLE_LAN_LISTENER = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "192.168.1.50";
      process.env.GTCT_TLS_CERT_FILE = lanCert.certPath;
      process.env.GTCT_TLS_KEY_FILE = lanCert.keyPath;
      process.env.GTCT_LAN_HOSTNAME = "shop.example.com";
    }, /private name such as gtct-pos/i);
    expectConfigError(() => {
      process.env.GTCT_LOCAL_DATA_DIR = "\\\\guest\\share";
      process.env.GTCT_LOCAL_HOST = "192.168.1.50";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_ENABLE_LAN_LISTENER = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "192.168.1.50";
      process.env.GTCT_TLS_CERT_FILE = lanCert.certPath;
      process.env.GTCT_TLS_KEY_FILE = lanCert.keyPath;
      process.env.GTCT_LAN_HOSTNAME = "gtct-pos";
    }, /network folder is not allowed/i);
    expectConfigError(() => {
      process.env.GTCT_ENABLE_PHYSICAL_PRINT = "true";
      process.env.GTCT_LOCAL_HOST = "192.168.1.50";
      process.env.GTCT_ALLOW_LAN_BIND = "true";
      process.env.GTCT_ENABLE_LAN_LISTENER = "true";
      process.env.GTCT_LAN_BIND_ADDRESS = "192.168.1.50";
      process.env.GTCT_TLS_CERT_FILE = lanCert.certPath;
      process.env.GTCT_TLS_KEY_FILE = lanCert.keyPath;
      process.env.GTCT_LAN_HOSTNAME = "gtct-pos";
    }, /Physical printing stays off/i);
    pass("incomplete-lan-rejected");

    process.env.GTCT_LOCAL_HOST = "192.168.1.50";
    process.env.GTCT_LOCAL_PORT = "8787";
    process.env.GTCT_ALLOW_LAN_BIND = "true";
    process.env.GTCT_ENABLE_LAN_LISTENER = "true";
    process.env.GTCT_LAN_BIND_ADDRESS = "192.168.1.50";
    process.env.GTCT_LAN_HOSTNAME = "gtct-pos";
    process.env.GTCT_TLS_CERT_FILE = lanCert.certPath;
    process.env.GTCT_TLS_KEY_FILE = lanCert.keyPath;
    const prepared = loadConfig({ mode: "http" });
    assert(prepared.lanAccessReady === true, "complete private configuration was rejected");
    assert(prepared.host === "192.168.1.50" && prepared.loopback === false, "prepared bind");
    assert(prepared.lanHostname === "gtct-pos", "prepared hostname");
    assert(prepared.tls?.minVersion === "TLSv1.2", "TLS minimum");
    assert(prepared.physicalPrintEnabled === false, "physical print enabled");
    const originReq = (origin, encrypted = true) => ({
      headers: { origin },
      socket: { encrypted, remoteAddress: "192.168.64.1" },
    });
    assert(
      isTrustedBrowserOrigin(originReq("https://gtct-pos:8787"), prepared),
      "approved hostname was rejected"
    );
    assert(
      !isTrustedBrowserOrigin(originReq("https://192.168.1.50:8787"), prepared),
      "raw IP origin was accepted"
    );
    assert(
      !isTrustedBrowserOrigin(originReq("https://evil.example:8787"), prepared),
      "unapproved origin was accepted"
    );
    assert(
      !isTrustedBrowserOrigin(originReq("http://gtct-pos:8787", false), prepared),
      "HTTP origin was accepted"
    );
    assert(
      isApprovedLanClient(
        { socket: { encrypted: true, remoteAddress: "192.168.64.1" } },
        prepared
      ),
      "private LAN client was rejected"
    );
    assert(
      !isApprovedLanClient(
        { socket: { encrypted: true, remoteAddress: "8.8.8.8" } },
        prepared
      ),
      "public client was accepted"
    );
    assert(
      !isApprovedLanClient(
        { socket: { encrypted: false, remoteAddress: "192.168.64.1" } },
        prepared
      ),
      "plain HTTP LAN client was accepted"
    );
    const cookie = sessionCookieHeader("example-session", { secure: true });
    assert(/HttpOnly/i.test(cookie) && /SameSite=Strict/i.test(cookie) && /\bSecure\b/.test(cookie), "cookie flags");
    assert(!/SameSite=None/i.test(cookie), "cross-site cookies were allowed");
    pass("prepared-lan-config");

    process.env.GTCT_LOCAL_HOST = "127.0.0.1";
    process.env.GTCT_LOCAL_PORT = String(PORT);
    process.env.GTCT_TLS_CERT_FILE = loopbackCert.certPath;
    process.env.GTCT_TLS_KEY_FILE = loopbackCert.keyPath;
    delete process.env.GTCT_ALLOW_LAN_BIND;
    delete process.env.GTCT_ENABLE_LAN_LISTENER;
    delete process.env.GTCT_LAN_BIND_ADDRESS;
    delete process.env.GTCT_LAN_HOSTNAME;
    const httpsConfig = loadConfig({ mode: "http" });
    assert(httpsConfig.loopback && httpsConfig.lanAccessReady === false, "loopback server became a LAN listener");
    ensureDataDirs(httpsConfig);
    initLogger(httpsConfig.logDir);
    openDatabase(httpsConfig.dbPath);
    await runMigrations(getDb());
    seedSampleData(httpsConfig);
    createFirstAdmin({
      shopId: httpsConfig.testTenantId,
      fullName: "Test Admin",
      username: TEST_ADMIN_USERNAME,
      password: TEST_ADMIN_PASSWORD,
    });
    createStaffUser(
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
    const server = createServer(httpsConfig);
    await listen(server, httpsConfig);
    const origin = `https://127.0.0.1:${PORT}`;
    const ca = loopbackCert.certPem;
    try {
      const health = await requestJson("https", PORT, "GET", "/health", { ca });
      assert(health.status === 200 && health.json.lanAccessReady === false, "health opened LAN");
      assert(health.protocol === "TLSv1.2" || health.protocol === "TLSv1.3", `TLS version ${health.protocol}`);
      const badOrigin = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca,
        origin: "https://evil.example",
        body: { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
      });
      assert(badOrigin.status === 403, "unapproved origin reached login");
      const adminLogin = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca,
        origin,
        body: { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
      });
      const adminCookie = cookieValue(adminLogin.setCookie);
      assert(adminLogin.status === 200 && adminCookie, "admin login");
      assert(/HttpOnly/i.test(adminLogin.setCookie) && /SameSite=Strict/i.test(adminLogin.setCookie), "cookie flags");
      assert(/\bSecure\b/.test(adminLogin.setCookie), "Secure cookie missing");
      const cashierLogin = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca,
        origin,
        body: { username: TEST_CASHIER_USERNAME, password: TEST_CASHIER_PASSWORD },
      });
      const cashierCookie = cookieValue(cashierLogin.setCookie);
      assert(cashierLogin.status === 200 && cashierCookie && cashierCookie !== adminCookie, "cashier session");
      const cashierMe = await requestJson("https", PORT, "GET", "/v1/session/me", { ca, cookie: cashierCookie });
      assert(cashierMe.json?.role === "cashier", "cashier role");
      assert(cashierMe.json.permissions.includes("sales.order.create"), "cashier cannot sell");
      assert(!cashierMe.json.permissions.includes("sales.price_override"), "cashier gained a price permission");
      const bearer = await requestJson("https", PORT, "GET", "/v1/menu-items", {
        ca,
        bearer: WELL_KNOWN_DEV_TOKEN,
        cookie: adminCookie,
      });
      assert(bearer.status === 401, "bearer token was accepted");
      const printer = await requestJson("https", PORT, "PUT", "/v1/printers", {
        ca,
        cookie: adminCookie,
        origin,
        body: {
          printerId: "prn_lan_prep",
          displayName: "Stored Only",
          connectionType: "NETWORK_TCP",
          host: "10.1.1.10",
          port: 9100,
        },
      });
      assert(printer.status === 200, "admin printer save");
      const cashierPrinters = await requestJson("https", PORT, "GET", "/v1/printers", {
        ca,
        cookie: cashierCookie,
      });
      assert(!JSON.stringify(cashierPrinters.json).includes("10.1.1.10"), "cashier saw a printer address");
      pass("staff-auth-and-isolation");

      const lanShaped = {
        ...httpsConfig,
        loopback: false,
        lanAccessReady: true,
        lanHostname: "gtct-pos",
      };
      const publicClient = authenticateSession(
        {
          headers: { cookie: `gtct_ls_session=${encodeURIComponent(adminCookie)}` },
          socket: { encrypted: true, remoteAddress: "8.8.8.8" },
        },
        lanShaped
      );
      assert(!publicClient, "public client reused a staff session");
      const privateClient = authenticateSession(
        {
          headers: { cookie: `gtct_ls_session=${encodeURIComponent(adminCookie)}` },
          socket: { encrypted: true, remoteAddress: "192.168.64.1" },
        },
        lanShaped
      );
      assert(privateClient?.role === "admin" && privateClient.staff, "private client lost the staff session");
      const plainClient = authenticateSession(
        {
          headers: { cookie: `gtct_ls_session=${encodeURIComponent(adminCookie)}` },
          socket: { encrypted: false, remoteAddress: "192.168.64.1" },
        },
        lanShaped
      );
      assert(!plainClient, "plain HTTP reused a staff session");
      pass("lan-session-gate");

      const sharedNumber = "LAN-PREP-SAME";
      const firstBody = {
        orderNumber: sharedNumber,
        submissionId: "sub-lan-prep-admin",
        orderType: "TAKEAWAY",
        lines: [{ itemId: "item_orange_juice", quantity: 1 }],
      };
      const secondBody = {
        orderNumber: sharedNumber,
        submissionId: "sub-lan-prep-cashier",
        orderType: "TAKEAWAY",
        lines: [{ itemId: "item_chicken_shawarma", quantity: 1 }],
      };
      const [first, second] = await Promise.all([
        requestJson("https", PORT, "POST", "/v1/test-orders", { ca, cookie: adminCookie, origin, body: firstBody }),
        requestJson("https", PORT, "POST", "/v1/test-orders", { ca, cookie: cashierCookie, origin, body: secondBody }),
      ]);
      assert(first.status === 201 && second.status === 201, first.json?.error || second.json?.error || "distinct orders");
      assert(first.json.order.order_id !== second.json.order.order_id, "distinct orders shared an id");
      assert(first.json.order.order_number !== second.json.order.order_number, "distinct orders shared a number");
      const staffIds = getDb()
        .prepare(`SELECT created_by_user_id FROM orders WHERE order_id IN (?, ?)`)
        .all(first.json.order.order_id, second.json.order.order_id)
        .map((row) => row.created_by_user_id);
      assert(new Set(staffIds).size === 2, "distinct orders shared a staff identity");
      const jobsBefore = getDb()
        .prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ?`)
        .get(first.json.order.order_id).n;
      const retry = await requestJson("https", PORT, "POST", "/v1/test-orders", {
        ca,
        cookie: adminCookie,
        origin,
        body: firstBody,
      });
      assert(retry.status === 200 && retry.json.created === false, "retry created another sale");
      assert(retry.json.order.order_id === first.json.order.order_id, "retry returned a different order");
      const conflict = await requestJson("https", PORT, "POST", "/v1/test-orders", {
        ca,
        cookie: adminCookie,
        origin,
        body: {
          ...firstBody,
          lines: [{ itemId: "item_orange_juice", quantity: 3 }],
        },
      });
      assert(conflict.status === 409 && conflict.json.code === "SUBMISSION_CONFLICT", "conflicting retry was accepted");
      const jobsAfter = getDb()
        .prepare(`SELECT COUNT(*) AS n FROM print_jobs WHERE order_id = ?`)
        .get(first.json.order.order_id).n;
      assert(jobsAfter === jobsBefore, "retry or conflict added a kitchen job");
      const missing = await requestJson("https", PORT, "POST", "/v1/test-orders", {
        ca,
        cookie: adminCookie,
        origin,
        body: {
          orderNumber: "LAN-PREP-MISSING",
          orderType: "TAKEAWAY",
          lines: [{ itemId: "item_orange_juice", quantity: 1 }],
        },
      });
      assert(missing.status === 400 && missing.json.code === "SUBMISSION_REQUIRED", "missing submission id was accepted");
      pass("distinct-orders-and-retries");

      const dispatched = await requestJson("https", PORT, "POST", "/v1/dispatch/run", {
        ca,
        cookie: adminCookie,
        origin,
      });
      assert(
        dispatched.json?.processed?.some((row) => row.status === "DISPATCHED"),
        "MOCK printer did not dispatch"
      );
      assert(httpsConfig.physicalPrintEnabled === false, "physical printing ran");
      pass("mock-printing");
    } finally {
      await closeServer(server);
      closeDatabase();
    }

    openDatabase(httpsConfig.dbPath);
    await runMigrations(getDb());
    const restarted = createServer(httpsConfig);
    await listen(restarted, httpsConfig);
    try {
      const adminLogin = await requestJson("https", PORT, "POST", "/v1/session/login", {
        ca,
        origin,
        body: { username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD },
      });
      const adminCookie = cookieValue(adminLogin.setCookie);
      const again = await requestJson("https", PORT, "POST", "/v1/test-orders", {
        ca,
        cookie: adminCookie,
        origin,
        body: {
          orderNumber: "LAN-PREP-SAME",
          submissionId: "sub-lan-prep-admin",
          orderType: "TAKEAWAY",
          lines: [{ itemId: "item_orange_juice", quantity: 1 }],
        },
      });
      assert(again.status === 200 && again.json.created === false, "restart created a second order");
      const count = getDb()
        .prepare(`SELECT COUNT(*) AS n FROM orders WHERE submission_id = ?`)
        .get("sub-lan-prep-admin").n;
      assert(count === 1, "restart duplicated the submission");
      pass("restart-persistence");
    } finally {
      await closeServer(restarted);
      closeDatabase();
    }
  } finally {
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log(`lan testing ${results.length} passed`);
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
