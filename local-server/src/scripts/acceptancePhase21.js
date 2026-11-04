/**
 * Phase 2.1 — Menu Setup popup editor structure + persistence smoke.
 * Visual/responsive checks are manual and are not claimed here.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openRoleSessions } from "./testHttp.js";
import { openDatabase, closeDatabase, runMigrations, getDb } from "../db/db.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createServer } from "../http/server.js";
import { initLogger, log } from "../util/logger.js";
import { withSubmissionId } from "./orderRequest.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function httpJson(port, method, pathName, token, body) {
  const payload = body == null ? null : JSON.stringify(withSubmissionId(body));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers: {
          Accept: "application/json",
          ...(token
            ? {
                Cookie: `gtct_ls_session=${encodeURIComponent(token)}`,
                Origin: `http://127.0.0.1:${port}`,
              }
            : {}),
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { raw: text };
          }
          resolve({ ok: res.statusCode < 300, status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpText(port, pathName) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: pathName }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") })
        );
      })
      .on("error", reject);
  });
}

async function main() {
  const results = [];
  const pass = (name) => {
    results.push({ name, ok: true });
    log.info(`PASS ${name}`);
  };
  const fail = (name, err) => {
    results.push({ name, ok: false, error: String(err?.message || err) });
    log.error(`FAIL ${name}`, { error: String(err?.message || err) });
  };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-phase21-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18821";
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;

  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);
  const server = createServer(config);
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const sessions = await openRoleSessions(config.port, config.testTenantId);
  const admin = sessions.admin;
  const device = sessions.device;

  try {
    try {
      const html = await httpText(config.port, "/menu.html");
      const js = await httpText(config.port, "/menu.js");
      assert(html.text.includes('id="item-editor-dialog"'), "dialog");
      for (const tab of ["basic", "variants", "kitchen", "knowledge"]) {
        assert(html.text.includes(`data-editor-tab="${tab}"`), tab);
        assert(html.text.includes(`data-editor-panel="${tab}"`), `${tab} panel`);
      }
      assert(html.text.includes("What should the salesman tell the customer?"), "quick label");
      assert(html.text.includes('id="save-btn"'), "one save");
      assert(js.text.includes("setEditorTab"), "tab switch");
      assert(js.text.includes("Discard unsaved changes?"), "unsaved warning");
      assert(js.text.includes("listPriceLabel"), "list price helper");
      assert(js.text.includes("keepTab"), "draft tab preserved on save");
      assert(!html.text.includes('id="editor-pane"'), "side editor removed");
      pass("editor shell and four tabs present");
    } catch (err) {
      fail("editor shell and four tabs present", err);
    }

    try {
      const before = await httpJson(
        config.port,
        "GET",
        "/v1/menu-items?includeInactive=1",
        admin
      );
      const item = before.json.menuItems.find((i) => i.item_id === "item_orange_juice");
      const countBefore = before.json.menuItems.length;
      const saved = await httpJson(config.port, "PUT", "/v1/menu-items", admin, {
        itemId: item.item_id,
        name: item.name,
        priceCents: item.price_cents,
        categoryId: item.category_id,
        subcategoryId: item.subcategory_id,
        stationIds: item.stationIds || [],
        description: item.description || "",
        isActive: true,
        isSoldOut: false,
        taxApplicable: item.taxApplicable !== false,
        productKnowledge: {
          salesmanQuickAnswer: "Fresh orange juice, served chilled.",
        },
      });
      assert(saved.ok, saved.json?.error || "save");
      assert(saved.json.menuItem.item_id === item.item_id, "same id");
      assert(Number(saved.json.menuItem.price_cents) === Number(item.price_cents), "price");
      const after = await httpJson(
        config.port,
        "GET",
        "/v1/menu-items?includeInactive=1",
        admin
      );
      assert(after.json.menuItems.length === countBefore, "no duplicate item");
      const denied = await httpJson(config.port, "PUT", "/v1/menu-items", device, {
        itemId: item.item_id,
        name: "Nope",
        priceCents: 1,
      });
      assert(denied.status === 401 || denied.status === 403, `device ${denied.status}`);
      pass("save updates same item; device cannot edit");
    } catch (err) {
      fail("save updates same item; device cannot edit", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ phase: "2.1", passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
