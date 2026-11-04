/**
 * Phase 2.1.1 — photo changes commit only through the existing image API,
 * and a failed or abandoned change does not remove the saved file.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ensureDataDirs } from "../config.js";
import { openRoleSessions } from "./testHttp.js";
import { openDatabase, closeDatabase, runMigrations, getDb } from "../db/db.js";
import { seedSampleData } from "../seed/sampleData.js";
import { createServer } from "../http/server.js";
import { initLogger, log } from "../util/logger.js";
import { withSubmissionId } from "./orderRequest.js";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const html = fs.readFileSync(path.join(root, "public/menu.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "public/menu.js"), "utf8");
  try {
    assert(!html.includes("upload-photo-btn"), "immediate upload button removed");
    assert(html.includes('id="restore-photo-btn"'), "restore control present");
    assert(
      html.includes("Cancel leaves the saved photo unchanged"),
      "cancel note present"
    );
    const saveAt = js.indexOf("async function saveItem");
    const putAt = js.indexOf('"/v1/menu-items"', saveAt);
    const photoAt = js.indexOf("applyPendingPhoto", saveAt);
    assert(saveAt > 0 && putAt > saveAt && photoAt > putAt, "photo applies after item save");
    assert(js.includes("resetPhotoDraft"), "cancel drops the photo draft");
    assert(!js.includes("Uploads apply immediately"), "old immediate-upload copy removed");
    pass("editor-draft-markup");
  } catch (err) {
    fail("editor-draft-markup", err);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gtct-photo-draft-"));
  process.env.GTCT_LOCAL_DATA_DIR = tempRoot;
  process.env.GTCT_ALLOW_DEV_TOKEN = "true";
  process.env.GTCT_LOCAL_HOST = "127.0.0.1";
  process.env.GTCT_LOCAL_PORT = "18823";
  delete process.env.GTCT_ENABLE_PHYSICAL_PRINT;
  delete process.env.GTCT_LOCAL_ADMIN_TOKEN;
  delete process.env.GTCT_LOCAL_API_TOKEN;

  const config = loadConfig({ mode: "http" });
  ensureDataDirs(config);
  initLogger(config.logDir);
  openDatabase(config.dbPath);
  await runMigrations(getDb());
  seedSampleData(config);

  const server = createServer(config);
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const port = config.port;
  const sessions = await openRoleSessions(port, config.testTenantId);
  const admin = sessions.admin;
  const device = sessions.device;

  try {
    let itemId;
    let priceCents;
    let taxApplicable;
    let filenameA;

    try {
      const created = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Photo Draft Burger",
        priceCents: 1250,
        category: "Food",
        taxApplicable: true,
      });
      assert(created.status === 200, `create ${created.status}`);
      itemId = created.json.menuItem.item_id;
      priceCents = created.json.menuItem.price_cents;
      taxApplicable = created.json.menuItem.taxApplicable;
      assert(!created.json.menuItem.image_filename, "starts without photo");

      const denied = await httpJson(
        port,
        "POST",
        `/v1/menu-items/${encodeURIComponent(itemId)}/image`,
        device,
        { mimeType: "image/png", base64Data: TINY_PNG_B64 }
      );
      assert(denied.status === 403, "device cannot upload");

      const bad = await httpJson(
        port,
        "POST",
        `/v1/menu-items/${encodeURIComponent(itemId)}/image`,
        admin,
        { mimeType: "image/gif", base64Data: TINY_PNG_B64 }
      );
      assert(bad.status === 400, `invalid type ${bad.status}`);
      const afterBad = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(itemId)}`,
        admin
      );
      assert(!afterBad.json.menuItem.image_filename, "invalid upload stored nothing");
      pass("invalid-upload-leaves-item");
    } catch (err) {
      fail("invalid-upload-leaves-item", err);
    }

    try {
      const first = await httpJson(
        port,
        "POST",
        `/v1/menu-items/${encodeURIComponent(itemId)}/image`,
        admin,
        { mimeType: "image/png", base64Data: TINY_PNG_B64 }
      );
      assert(first.status === 200, "first photo saved");
      filenameA = first.json.menuItem.image_filename;
      const pathA = path.join(config.menuImagesDir, filenameA);
      assert(fs.existsSync(pathA), "first file on disk");
      assert(first.json.menuItem.price_cents === priceCents, "price unchanged");
      assert(first.json.menuItem.taxApplicable === taxApplicable, "tax unchanged");

      const stillBad = await httpJson(
        port,
        "POST",
        `/v1/menu-items/${encodeURIComponent(itemId)}/image`,
        admin,
        { mimeType: "text/plain", base64Data: TINY_PNG_B64 }
      );
      assert(stillBad.status === 400, "replacement rejected");
      const kept = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(itemId)}`,
        admin
      );
      assert(kept.json.menuItem.image_filename === filenameA, "original filename kept");
      assert(fs.existsSync(pathA), "original file kept");

      await sleep(5);
      const second = await httpJson(
        port,
        "POST",
        `/v1/menu-items/${encodeURIComponent(itemId)}/image`,
        admin,
        { mimeType: "image/png", base64Data: TINY_PNG_B64 }
      );
      assert(second.status === 200, "replacement saved");
      const filenameB = second.json.menuItem.image_filename;
      assert(filenameB && filenameB !== filenameA, "new filename");
      assert(fs.existsSync(path.join(config.menuImagesDir, filenameB)), "new file exists");
      assert(!fs.existsSync(pathA), "old file removed after commit");
      const fetched = await httpJson(
        port,
        "GET",
        `/v1/menu-images/${encodeURIComponent(filenameB)}`,
        admin
      );
      assert(fetched.status === 200, "new image is served");
      pass("replace-only-after-commit");
    } catch (err) {
      fail("replace-only-after-commit", err);
    }

    try {
      const other = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        name: "Photo Share Guard",
        priceCents: 800,
        category: "Food",
      });
      const otherId = other.json.menuItem.item_id;
      const current = await httpJson(
        port,
        "GET",
        `/v1/menu-items/${encodeURIComponent(itemId)}`,
        admin
      );
      const sharedName = current.json.menuItem.image_filename;
      getDb()
        .prepare(`UPDATE menu_items SET image_filename = ? WHERE item_id = ?`)
        .run(sharedName, otherId);
      const cleared = await httpJson(
        port,
        "DELETE",
        `/v1/menu-items/${encodeURIComponent(itemId)}/image`,
        admin
      );
      assert(cleared.status === 200, "clear first reference");
      assert(!cleared.json.menuItem.image_filename, "first item cleared");
      assert(
        fs.existsSync(path.join(config.menuImagesDir, sharedName)),
        "file kept while another item references it"
      );
      const clearedOther = await httpJson(
        port,
        "DELETE",
        `/v1/menu-items/${encodeURIComponent(otherId)}/image`,
        admin
      );
      assert(clearedOther.status === 200, "clear last reference");
      assert(
        !fs.existsSync(path.join(config.menuImagesDir, sharedName)),
        "file removed when unused"
      );
      const retry = await httpJson(port, "PUT", "/v1/menu-items", admin, {
        itemId,
        name: "Photo Draft Burger",
        priceCents,
        category: "Food",
        taxApplicable: true,
      });
      assert(retry.status === 200, "retry save");
      assert(retry.json.menuItem.item_id === itemId, "same item id");
      const rows = getDb()
        .prepare(`SELECT COUNT(*) AS n FROM menu_items WHERE item_id = ?`)
        .get(itemId);
      assert(rows.n === 1, "no duplicate item");
      pass("cleanup-and-same-item-retry");
    } catch (err) {
      fail("cleanup-and-same-item-retry", err);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  log.info(`phase 2.1.1 photo draft ${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
