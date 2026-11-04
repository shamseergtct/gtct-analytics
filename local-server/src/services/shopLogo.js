import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/db.js";
import { nowIso } from "../util/time.js";
import { getShopSettings } from "./shopSettings.js";

const IMAGE_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function ensureShopAssetsDir(config) {
  const dir = config.shopAssetsDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveShopLogo(shopId, { mimeType, base64Data }, config, { role } = {}) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin role required"), { status: 403 });
  }
  const ext = IMAGE_MIME[String(mimeType || "").toLowerCase()];
  if (!ext) {
    throw Object.assign(
      new Error("Unsupported image type (use JPEG, PNG, or WebP)"),
      { status: 400 }
    );
  }
  const raw = String(base64Data || "").replace(/^data:[^;]+;base64,/, "");
  let buffer;
  try {
    buffer = Buffer.from(raw, "base64");
  } catch {
    throw Object.assign(new Error("Invalid base64 image data"), { status: 400 });
  }
  if (!buffer.length) {
    throw Object.assign(new Error("Empty image data"), { status: 400 });
  }
  if (buffer.length > 2_500_000) {
    throw Object.assign(new Error("Logo too large (max ~2MB)"), { status: 413 });
  }

  ensureShopAssetsDir(config);
  const safeId = String(shopId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `logo_${safeId}_${Date.now()}.${ext}`;
  const dest = path.join(config.shopAssetsDir, filename);
  fs.writeFileSync(dest, buffer);

  const db = getDb();
  const previous = db
    .prepare(`SELECT logo_filename FROM shop_settings WHERE shop_id = ?`)
    .get(shopId)?.logo_filename;
  db.prepare(
    `UPDATE shop_settings SET logo_filename = ?, updated_at = ? WHERE shop_id = ?`
  ).run(filename, nowIso(), shopId);

  if (previous && previous !== filename) {
    const oldPath = path.join(config.shopAssetsDir, previous);
    if (fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch {
        /* keep new logo */
      }
    }
  }
  return getShopSettings(shopId);
}

export function clearShopLogo(shopId, config, { role } = {}) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin role required"), { status: 403 });
  }
  const db = getDb();
  const row = db
    .prepare(`SELECT logo_filename FROM shop_settings WHERE shop_id = ?`)
    .get(shopId);
  if (!row) {
    throw Object.assign(new Error("Shop not found"), { status: 404 });
  }
  if (row.logo_filename) {
    const oldPath = path.join(config.shopAssetsDir, row.logo_filename);
    if (fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch {
        /* ignore */
      }
    }
  }
  db.prepare(
    `UPDATE shop_settings SET logo_filename = NULL, updated_at = ? WHERE shop_id = ?`
  ).run(nowIso(), shopId);
  return getShopSettings(shopId);
}

export function resolveShopLogoPath(filename, config) {
  if (
    !filename ||
    String(filename).includes("..") ||
    String(filename).includes("/") ||
    String(filename).includes("\\")
  ) {
    return null;
  }
  const candidate = path.normalize(
    path.join(config.shopAssetsDir, path.basename(filename))
  );
  if (!candidate.startsWith(path.normalize(config.shopAssetsDir + path.sep))) {
    return null;
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return null;
  }
  return candidate;
}
