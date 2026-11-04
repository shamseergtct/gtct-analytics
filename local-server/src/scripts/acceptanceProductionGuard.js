/** Phase P2-A1 safety checks; does not start a listener or open SQLite. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config.js";
import { TEST_MODE, DB_IDENTITY_KEY, assertTestDatabaseIdentity, markTestDatabaseIdentity } from "../operatingMode.js";

const envKeys = [
  "GTCT_OPERATING_MODE", "GTCT_PRODUCTION_DATA_DIR", "GTCT_LOCAL_DATA_DIR",
  "GTCT_LOCAL_HOST", "GTCT_ENABLE_LAN_LISTENER", "GTCT_ALLOW_LAN_BIND",
  "GTCT_TLS_CERT_FILE", "GTCT_TLS_KEY_FILE", "GTCT_TLS_KEY_PASSPHRASE",
  "GTCT_ENABLE_PHYSICAL_PRINT", "GTCT_LAN_HOSTNAME", "GTCT_LAN_BIND_ADDRESS",
];
const original = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let passed = 0;
function pass(label) {
  console.log(`PASS ${label}`);
  passed++;
}

function fakeDb({ hasOrders = false, orders = [], identity = null, columns = ["is_test"] } = {}) {
  const rows = new Map();
  if (identity != null) rows.set(DB_IDENTITY_KEY, identity);
  return {
    rows,
    prepare(query) {
      return {
        get(...args) {
          if (query.includes("sqlite_master")) {
            const name = args[0];
            return name === "meta" || (name === "orders" && hasOrders) ? { exists: 1 } : undefined;
          }
          if (query.includes("SELECT value FROM meta")) {
            return rows.has(args[0]) ? { value: rows.get(args[0]) } : undefined;
          }
          if (query.includes("COUNT(*) AS count FROM orders")) {
            return { count: orders.filter((value) => value !== 1).length };
          }
          throw new Error(`unexpected query: ${query}`);
        },
        all() {
          if (query.includes("PRAGMA table_info(orders)")) return columns.map((name) => ({ name }));
          throw new Error(`unexpected query: ${query}`);
        },
        run(key, value) {
          if (!query.includes("INSERT OR IGNORE INTO meta")) throw new Error("unexpected write");
          if (!rows.has(key)) rows.set(key, value);
          return { changes: 1 };
        },
      };
    },
  };
}

try {
  for (const key of envKeys) delete process.env[key];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-prod-guard-"));
  try {
    process.env.GTCT_LOCAL_DATA_DIR = path.join(temp, "test-data");
    const config = loadConfig({ mode: "http" });
    assert.equal(config.operatingMode, "TEST");
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.lanAccessReady, false);
    pass("legacy default remains loopback TEST");

    for (const requested of ["REAL", "PRODUCTION", "LIVE", "invalid"]) {
      process.env.GTCT_OPERATING_MODE = requested;
      assert.throws(() => loadConfig({ mode: "http" }), /Only TEST operating mode/);
      assert.throws(() => loadConfig({ mode: "script" }), /Only TEST operating mode/);
    }
    delete process.env.GTCT_OPERATING_MODE;
    pass("all real and unknown operating modes fail closed for HTTP and scripts");

    process.env.GTCT_PRODUCTION_DATA_DIR = path.join(temp, "production");
    process.env.GTCT_LOCAL_DATA_DIR = path.join(temp, "production");
    assert.throws(() => loadConfig({ mode: "http" }), /reserved production data directory/);
    process.env.GTCT_LOCAL_DATA_DIR = path.join(temp, "production", "nested");
    assert.throws(() => loadConfig({ mode: "script" }), /reserved production data directory/);
    process.env.GTCT_LOCAL_DATA_DIR = path.join(temp, "test-data");
    assert.doesNotThrow(() => loadConfig({ mode: "http" }));
    pass("reserved production path is rejected without breaking isolated TEST data");

    const identityConfig = loadConfig({ mode: "http" });
    const fresh = fakeDb();
    assert.equal(assertTestDatabaseIdentity(fresh, identityConfig).identified, false);
    markTestDatabaseIdentity(fresh, identityConfig);
    assert.equal(assertTestDatabaseIdentity(fresh, identityConfig).identified, true);
    pass("fresh TEST identity is stamped and verified");

    const legacy = fakeDb({ hasOrders: true, orders: [1, 1, 1] });
    assert.equal(assertTestDatabaseIdentity(legacy, identityConfig).identified, false);
    markTestDatabaseIdentity(legacy, identityConfig);
    assert.equal(assertTestDatabaseIdentity(legacy, identityConfig).identified, true);
    pass("legacy test orders accepted without rewriting orders");

    assert.throws(
      () => assertTestDatabaseIdentity(fakeDb({ hasOrders: true, orders: [1, 0] }), identityConfig),
      /Non-test orders exist/
    );
    pass("database containing a non-test order is rejected");

    assert.throws(
      () => assertTestDatabaseIdentity(fakeDb({ hasOrders: true, columns: ["order_id"] }), identityConfig),
      /Unknown orders schema/
    );
    pass("unknown orders schema is rejected");

    const mismatch = JSON.stringify({ version: 1, operatingMode: TEST_MODE, testTenantId: "different-shop" });
    assert.throws(() => assertTestDatabaseIdentity(fakeDb({ identity: mismatch }), identityConfig), /identity does not match/);
    assert.throws(() => assertTestDatabaseIdentity(fakeDb({ identity: "not json" }), identityConfig), /identity is invalid/);
    pass("mismatched or corrupt operating identities are rejected");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} finally {
  for (const key of envKeys) {
    if (original[key] == null) delete process.env[key];
    else process.env[key] = original[key];
  }
}
console.log(`Production/test foundation: ${passed} passed (no SQLite or live listener opened)`);
