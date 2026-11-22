import fs from "node:fs";
import path from "node:path";
import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { listCategories, resolveCategoryAssignment } from "./categories.js";
import { getShopSettings } from "./shopSettings.js";
import {
  getItemInstructionConfig,
  setItemInstructionConfig,
} from "./kitchenLibrary.js";
import { getItemAddons, setItemAddons } from "./addons.js";
import { listVariantsForItem, setItemVariants } from "./variants.js";
import { upsertProductKnowledge } from "./productKnowledge.js";

export const DEFAULT_INSTRUCTION_MODIFIERS = ["Less", "More", "No", "Extra"];
export const DEFAULT_INSTRUCTION_TARGETS = [
  "Sugar",
  "Sauce",
  "Onion",
  "Salt",
  "Ice",
  "Cheese",
];

function shopInstructionDefaults() {
  try {
    const shop = getShopSettings();
    return {
      modifiers: shop.instructionModifiers?.length
        ? shop.instructionModifiers
        : [...DEFAULT_INSTRUCTION_MODIFIERS],
      targets: shop.instructionTargets?.length
        ? shop.instructionTargets
        : [...DEFAULT_INSTRUCTION_TARGETS],
    };
  } catch {
    return {
      modifiers: [...DEFAULT_INSTRUCTION_MODIFIERS],
      targets: [...DEFAULT_INSTRUCTION_TARGETS],
    };
  }
}

function parseJsonArray(raw, fallback = []) {
  if (!raw) return [...fallback];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...fallback];
    return parsed.map((v) => String(v).trim()).filter(Boolean);
  } catch {
    return [...fallback];
  }
}

function normalizeStringList(value, { allowEmpty = true } = {}) {
  if (value == null) return allowEmpty ? [] : null;
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("Expected a string array"), { status: 400 });
  }
  return [...new Set(value.map((v) => String(v).trim()).filter(Boolean))];
}

/** Blank SKU → null (multiple nulls allowed; non-blank remain unique). */
export function normalizeSku(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function mapItemRow(item, stationIds) {
  const defaults = shopInstructionDefaults();
  const prepStationId = stationIds[0] || null;
  const isActive = Number(item.is_active || 0);
  const isSoldOut = Number(item.is_sold_out || 0);
  let effectiveStatus = "active";
  if (!isActive) effectiveStatus = "inactive";
  else if (isSoldOut) effectiveStatus = "sold_out";

  let instrCfg = null;
  let addons = [];
  try {
    instrCfg = getItemInstructionConfig(item.item_id);
  } catch {
    instrCfg = null;
  }
  try {
    addons = getItemAddons(item.item_id, { activeOnly: false });
  } catch {
    addons = [];
  }

  let variants = [];
  try {
    variants = listVariantsForItem(item.item_id, { activeOnly: false });
  } catch {
    variants = [];
  }

  const instructionModifiers = instrCfg?.instructionModifiers?.length
    ? instrCfg.instructionModifiers
    : defaults.modifiers;
  const instructionTargets = instrCfg?.instructionTargets?.length
    ? instrCfg.instructionTargets
    : defaults.targets;

  return {
    item_id: item.item_id,
    sku: item.sku || null,
    name: item.name,
    is_active: item.is_active,
    category_id: item.category_id || null,
    subcategory_id: item.subcategory_id || null,
    category: item.category || "",
    subcategory: item.subcategory || "",
    description: item.description || "",
    price_cents: Number(item.price_cents || 0),
    code: item.code || "",
    image_filename: item.image_filename || null,
    image_url: item.image_filename
      ? `/v1/menu-images/${encodeURIComponent(item.image_filename)}`
      : null,
    is_sold_out: isSoldOut,
    tax_applicable:
      item.tax_applicable == null
        ? true
        : Boolean(Number(item.tax_applicable)),
    taxApplicable:
      item.tax_applicable == null
        ? true
        : Boolean(Number(item.tax_applicable)),
    has_variants: Boolean(Number(item.has_variants || 0)),
    hasVariants: Boolean(Number(item.has_variants || 0)),
    variants,
    startingPriceCents: (() => {
      const has = Boolean(Number(item.has_variants || 0));
      if (!has) return Number(item.price_cents || 0);
      const active = variants.filter((v) => v.isActive && !v.isSoldOut);
      if (!active.length) return Number(item.price_cents || 0);
      return Math.min(...active.map((v) => v.priceCents));
    })(),
    variantCount: variants.filter((v) => v.isActive).length,
    sort_order: Number(item.sort_order || 0),
    instructionModifiers,
    instructionTargets,
    instructionStandalone: instrCfg?.instructionStandalone || [],
    instructionCustomized: Boolean(instrCfg?.customized),
    instructionConfig: instrCfg
      ? {
          customized: instrCfg.customized,
          modifiers: instrCfg.modifiers,
          targets: instrCfg.targets,
          standalone: instrCfg.standalone,
          blockedPairs: instrCfg.blockedPairs,
        }
      : null,
    hasCustomInstructions: Boolean(instrCfg?.customized),
    instruction_modifiers_json: item.instruction_modifiers_json,
    instruction_targets_json: item.instruction_targets_json,
    addons,
    stationIds,
    prepStationId,
    requiresPreparation: Boolean(prepStationId),
    effectiveStatus,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

export function listMenuItems({ includeInactive = true } = {}) {
  const db = getDb();
  const items = db
    .prepare(
      `SELECT * FROM menu_items
       WHERE (? = 1 OR is_active = 1)
       ORDER BY sort_order ASC, name ASC`
    )
    .all(includeInactive ? 1 : 0);
  const mapStmt = db.prepare(
    `SELECT station_id FROM item_stations WHERE item_id = ?`
  );
  return items.map((item) =>
    mapItemRow(
      item,
      mapStmt.all(item.item_id).map((r) => r.station_id)
    )
  );
}

/**
 * Reorder a subset (or all) of menu items by id list.
 * Preserves the sort_order slots used by those items when they are unique;
 * otherwise assigns a fresh stepped sequence from the current minimum.
 */
export function reorderMenuItems(itemIds) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    throw Object.assign(new Error("Provide the item id list."), {
      status: 400,
      code: "REORDER_REQUIRED",
    });
  }
  const ordered = itemIds.map((id) => String(id || "").trim()).filter(Boolean);
  if (ordered.length !== itemIds.length || new Set(ordered).size !== ordered.length) {
    throw Object.assign(new Error("Reorder must list each item once."), {
      status: 400,
      code: "REORDER_INVALID",
    });
  }

  const db = getDb();
  const getRow = db.prepare(
    `SELECT item_id, sort_order FROM menu_items WHERE item_id = ?`
  );
  const rows = ordered.map((id) => {
    const row = getRow.get(id);
    if (!row) {
      throw Object.assign(new Error(`Unknown menu item: ${id}`), {
        status: 404,
        code: "MENU_ITEM_NOT_FOUND",
      });
    }
    return row;
  });

  const existing = rows.map((row) => Number(row.sort_order || 0));
  const uniqueSlots = new Set(existing).size === existing.length;
  const slots = uniqueSlots
    ? [...existing].sort((a, b) => a - b)
    : (() => {
        const base = existing.length ? Math.min(...existing) : 0;
        return ordered.map((_, index) => base + index * 10);
      })();

  const now = nowIso();
  const update = db.prepare(
    `UPDATE menu_items SET sort_order = ?, updated_at = ? WHERE item_id = ?`
  );
  db.transaction(() => {
    ordered.forEach((id, index) => {
      update.run(slots[index], now, id);
    });
  })();

  return listMenuItems({ includeInactive: true });
}

export function getMenuItem(itemId) {
  const db = getDb();
  const item = db
    .prepare(`SELECT * FROM menu_items WHERE item_id = ?`)
    .get(itemId);
  if (!item) return null;
  const stationIds = db
    .prepare(`SELECT station_id FROM item_stations WHERE item_id = ?`)
    .all(itemId)
    .map((r) => r.station_id);
  return mapItemRow(item, stationIds);
}

/** @deprecated Prefer listCategories from categories.js — kept for API compat. */
export function listMenuCategories() {
  return listCategories({ includeInactive: true });
}

function validateMenuPayload(input, { partial = false } = {}) {
  const errors = [];
  const name = input.name != null ? String(input.name).trim() : null;
  const skuProvided = Object.prototype.hasOwnProperty.call(input, "sku");
  const sku = skuProvided ? normalizeSku(input.sku) : undefined;

  if (!partial || input.name != null) {
    if (!name) errors.push("name is required");
  }

  let priceCents = input.priceCents ?? input.price_cents;
  if (priceCents != null && priceCents !== "") {
    priceCents = Number(priceCents);
    if (!Number.isFinite(priceCents) || priceCents < 0 || !Number.isInteger(priceCents)) {
      errors.push("priceCents must be a non-negative integer (cents)");
    }
  } else if (!partial) {
    priceCents = 0;
  } else {
    priceCents = undefined;
  }

  let sortOrder = input.sortOrder ?? input.sort_order;
  if (sortOrder != null && sortOrder !== "") {
    sortOrder = Number(sortOrder);
    if (!Number.isFinite(sortOrder) || !Number.isInteger(sortOrder)) {
      errors.push("sortOrder must be an integer");
    }
  } else if (!partial) {
    sortOrder = 0;
  } else {
    sortOrder = undefined;
  }

  if (errors.length) {
    throw Object.assign(new Error(errors.join("; ")), { status: 400, errors });
  }

  let stationIds;
  if (Object.prototype.hasOwnProperty.call(input, "stationIds")) {
    const raw = Array.isArray(input.stationIds) ? input.stationIds : [];
    stationIds = [
      ...new Set(
        raw
          .map((v) => String(v || "").trim())
          .filter((v) => v && v !== "NONE" && v !== "__none__")
      ),
    ];
  } else if (Object.prototype.hasOwnProperty.call(input, "stationId")) {
    const raw = String(input.stationId || "").trim();
    stationIds =
      !raw || raw === "NONE" || raw === "__none__" ? [] : [raw];
  }

  return {
    name,
    sku,
    skuProvided,
    categoryId: input.categoryId ?? input.category_id,
    subcategoryId: input.subcategoryId ?? input.subcategory_id,
    category:
      input.category != null ? String(input.category).trim() : undefined,
    subcategory:
      input.subcategory != null ? String(input.subcategory).trim() : undefined,
    description:
      input.description != null ? String(input.description).trim() : undefined,
    priceCents,
    code:
      input.code != null ? String(input.code).trim() || null : undefined,
    isActive:
      input.isActive != null
        ? input.isActive !== false && input.isActive !== 0
        : undefined,
    isSoldOut:
      input.isSoldOut != null
        ? Boolean(input.isSoldOut)
        : input.is_sold_out != null
          ? Boolean(input.is_sold_out)
          : undefined,
    taxApplicable:
      input.taxApplicable != null
        ? Boolean(input.taxApplicable)
        : input.tax_applicable != null
          ? Boolean(input.tax_applicable)
          : undefined,
    sortOrder,
    stationIds,
    instructionModifiers:
      input.instructionModifiers != null
        ? normalizeStringList(input.instructionModifiers)
        : undefined,
    instructionTargets:
      input.instructionTargets != null
        ? normalizeStringList(input.instructionTargets)
        : undefined,
  };
}

export function upsertMenuItem(input = {}) {
  const db = getDb();
  const itemId = String(input.itemId || input.item_id || newId("item"));
  const existing = db
    .prepare(`SELECT * FROM menu_items WHERE item_id = ?`)
    .get(itemId);
  const parsed = validateMenuPayload(input, { partial: Boolean(existing) });
  const ts = nowIso();

  const name = parsed.name ?? existing?.name;
  if (!name) {
    throw Object.assign(new Error("name is required"), { status: 400 });
  }

  let sku;
  if (parsed.skuProvided) {
    sku = parsed.sku; // may be null
  } else if (existing) {
    sku = normalizeSku(existing.sku);
  } else {
    sku = null;
  }

  if (sku) {
    const skuOwner = db
      .prepare(
        `SELECT item_id FROM menu_items
         WHERE sku = ? AND item_id != ?`
      )
      .get(sku, itemId);
    if (skuOwner) {
      throw Object.assign(new Error(`SKU already in use: ${sku}`), {
        status: 409,
      });
    }
  }

  const createCats = true;
  let categoryAssignment;
  const hasCategoryInput =
    parsed.categoryId != null ||
    parsed.subcategoryId != null ||
    parsed.category !== undefined ||
    parsed.subcategory !== undefined;

  if (hasCategoryInput) {
    categoryAssignment = resolveCategoryAssignment(
      {
        categoryId: parsed.categoryId || null,
        subcategoryId: parsed.subcategoryId || null,
        categoryName: parsed.category ?? null,
        subcategoryName: parsed.subcategory ?? null,
      },
      { createIfMissing: createCats }
    );
  } else if (existing) {
    categoryAssignment = {
      categoryId: existing.category_id || null,
      subcategoryId: existing.subcategory_id || null,
      category: existing.category || "",
      subcategory: existing.subcategory || "",
    };
  } else {
    categoryAssignment = {
      categoryId: null,
      subcategoryId: null,
      category: "",
      subcategory: "",
    };
  }

  const description =
    parsed.description !== undefined
      ? parsed.description
      : existing?.description || "";
  const priceCents =
    parsed.priceCents !== undefined
      ? parsed.priceCents
      : Number(existing?.price_cents || 0);
  const code =
    parsed.code !== undefined ? parsed.code : existing?.code || null;
  const isActive =
    parsed.isActive !== undefined
      ? parsed.isActive
      : existing
        ? Boolean(existing.is_active)
        : true;
  const isSoldOut =
    parsed.isSoldOut !== undefined
      ? parsed.isSoldOut
      : existing
        ? Boolean(existing.is_sold_out)
        : false;
  const taxApplicable =
    parsed.taxApplicable !== undefined
      ? parsed.taxApplicable
      : existing
        ? existing.tax_applicable == null
          ? true
          : Boolean(Number(existing.tax_applicable))
        : true;
  const sortOrder =
    parsed.sortOrder !== undefined
      ? parsed.sortOrder
      : Number(existing?.sort_order || 0);
  const modifiersJson =
    parsed.instructionModifiers !== undefined
      ? JSON.stringify(parsed.instructionModifiers)
      : existing?.instruction_modifiers_json || "[]";
  const targetsJson =
    parsed.instructionTargets !== undefined
      ? JSON.stringify(parsed.instructionTargets)
      : existing?.instruction_targets_json || "[]";

  const stationIds =
    parsed.stationIds !== undefined
      ? parsed.stationIds
      : existing
        ? db
            .prepare(`SELECT station_id FROM item_stations WHERE item_id = ?`)
            .all(itemId)
            .map((r) => r.station_id)
        : [];

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(
        `UPDATE menu_items SET
           sku = ?, name = ?, is_active = ?,
           category = ?, subcategory = ?, category_id = ?, subcategory_id = ?,
           description = ?, price_cents = ?, code = ?, is_sold_out = ?, tax_applicable = ?,
           sort_order = ?,
           instruction_modifiers_json = ?, instruction_targets_json = ?,
           updated_at = ?
         WHERE item_id = ?`
      ).run(
        sku,
        name,
        isActive ? 1 : 0,
        categoryAssignment.category,
        categoryAssignment.subcategory,
        categoryAssignment.categoryId,
        categoryAssignment.subcategoryId,
        description,
        priceCents,
        code,
        isSoldOut ? 1 : 0,
        taxApplicable ? 1 : 0,
        sortOrder,
        modifiersJson,
        targetsJson,
        ts,
        itemId
      );
    } else {
      db.prepare(
        `INSERT INTO menu_items (
           item_id, sku, name, is_active, created_at, updated_at,
           category, subcategory, category_id, subcategory_id,
           description, price_cents, code,
           image_filename, is_sold_out, tax_applicable, sort_order,
           instruction_modifiers_json, instruction_targets_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
      ).run(
        itemId,
        sku,
        name,
        isActive ? 1 : 0,
        ts,
        ts,
        categoryAssignment.category,
        categoryAssignment.subcategory,
        categoryAssignment.categoryId,
        categoryAssignment.subcategoryId,
        description,
        priceCents,
        code,
        isSoldOut ? 1 : 0,
        taxApplicable ? 1 : 0,
        sortOrder,
        modifiersJson,
        targetsJson
      );
    }

    db.prepare(`DELETE FROM item_stations WHERE item_id = ?`).run(itemId);
    const insert = db.prepare(
      `INSERT INTO item_stations (item_id, station_id) VALUES (?, ?)`
    );
    for (const stationId of stationIds) {
      const station = db
        .prepare(
          `SELECT station_id FROM stations WHERE station_id = ? AND station_id != 'station_cashier'`
        )
        .get(stationId);
      if (!station) {
        throw Object.assign(new Error(`Unknown prep stationId: ${stationId}`), {
          status: 400,
        });
      }
      insert.run(itemId, stationId);
    }
  });
  tx();

  // Optional Phase 1.5 customization payloads (admin upsert only — caller enforces role).
  if (
    Object.prototype.hasOwnProperty.call(input, "instructionCustomize") ||
    Object.prototype.hasOwnProperty.call(input, "modifierIds") ||
    Object.prototype.hasOwnProperty.call(input, "targetIds") ||
    Object.prototype.hasOwnProperty.call(input, "standaloneIds") ||
    Object.prototype.hasOwnProperty.call(input, "useShopDefaults") ||
    Object.prototype.hasOwnProperty.call(input, "blockedPairs")
  ) {
    setItemInstructionConfig(
      itemId,
      {
        customized: input.instructionCustomize,
        useShopDefaults: input.useShopDefaults,
        modifierIds: input.modifierIds,
        targetIds: input.targetIds,
        standaloneIds: input.standaloneIds,
        blockedPairs: input.blockedPairs,
      },
      { role: "admin" }
    );
  }
  if (Object.prototype.hasOwnProperty.call(input, "addonAssignments")) {
    setItemAddons(itemId, input.addonAssignments || [], { role: "admin" });
  }
  if (
    Object.prototype.hasOwnProperty.call(input, "hasVariants") ||
    Object.prototype.hasOwnProperty.call(input, "has_variants") ||
    Object.prototype.hasOwnProperty.call(input, "variants")
  ) {
    setItemVariants(
      itemId,
      {
        hasVariants: input.hasVariants ?? input.has_variants,
        variants: input.variants || [],
      },
      { role: "admin" }
    );
  }

  // Phase 2.0 Product Knowledge (optional; admin upsert only).
  if (
    Object.prototype.hasOwnProperty.call(input, "productKnowledge") ||
    Object.prototype.hasOwnProperty.call(input, "product_knowledge")
  ) {
    upsertProductKnowledge(
      itemId,
      input.productKnowledge ?? input.product_knowledge ?? {},
      { role: "admin" }
    );
  }

  return getMenuItem(itemId);
}

/**
 * Quick availability update.
 * - Admin: may set isActive and/or isSoldOut
 * - Device (staff): may set isSoldOut only
 */
export function updateMenuItemAvailability(
  itemId,
  { isActive, isSoldOut } = {},
  { role = "admin" } = {}
) {
  const db = getDb();
  const existing = db
    .prepare(`SELECT * FROM menu_items WHERE item_id = ?`)
    .get(itemId);
  if (!existing) {
    throw Object.assign(new Error("Menu item not found"), { status: 404 });
  }

  let nextActive = existing.is_active;
  let nextSoldOut = existing.is_sold_out;

  if (isSoldOut !== undefined) {
    nextSoldOut = isSoldOut ? 1 : 0;
  }
  if (isActive !== undefined) {
    if (role !== "admin") {
      throw Object.assign(
        new Error("Only admin can change Active/Inactive"),
        { status: 403 }
      );
    }
    nextActive = isActive ? 1 : 0;
  }

  db.prepare(
    `UPDATE menu_items SET is_active = ?, is_sold_out = ?, updated_at = ? WHERE item_id = ?`
  ).run(nextActive, nextSoldOut, nowIso(), itemId);

  return getMenuItem(itemId);
}

export function getStationsForItem(itemId) {
  return getDb()
    .prepare(`SELECT station_id FROM item_stations WHERE item_id = ?`)
    .all(itemId)
    .map((r) => r.station_id);
}

const IMAGE_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function ensureMenuImagesDir(config) {
  fs.mkdirSync(config.menuImagesDir, { recursive: true });
  return config.menuImagesDir;
}

export function saveMenuItemImage(itemId, { mimeType, base64Data }, config) {
  const item = getMenuItem(itemId);
  if (!item) {
    throw Object.assign(new Error("Menu item not found"), { status: 404 });
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
  if (buffer.length > 4_500_000) {
    throw Object.assign(new Error("Image too large (max ~3.3MB)"), {
      status: 413,
    });
  }

  ensureMenuImagesDir(config);
  const safeId = String(itemId).replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${safeId}_${Date.now()}.${ext}`;
  const dest = path.join(config.menuImagesDir, filename);
  fs.writeFileSync(dest, buffer);

  const db = getDb();
  const previous = db
    .prepare(`SELECT image_filename FROM menu_items WHERE item_id = ?`)
    .get(itemId)?.image_filename;
  try {
    db.prepare(
      `UPDATE menu_items SET image_filename = ?, updated_at = ? WHERE item_id = ?`
    ).run(filename, nowIso(), itemId);
  } catch (err) {
    removeUnreferencedImageFile(filename, config);
    throw err;
  }

  if (previous && previous !== filename) {
    removeUnreferencedImageFile(previous, config);
  }

  return getMenuItem(itemId);
}

export function clearMenuItemImage(itemId, config) {
  const db = getDb();
  const row = db
    .prepare(`SELECT image_filename FROM menu_items WHERE item_id = ?`)
    .get(itemId);
  if (!row) {
    throw Object.assign(new Error("Menu item not found"), { status: 404 });
  }
  const previous = row.image_filename || "";
  db.prepare(
    `UPDATE menu_items SET image_filename = NULL, updated_at = ? WHERE item_id = ?`
  ).run(nowIso(), itemId);
  if (previous) removeUnreferencedImageFile(previous, config);
  return getMenuItem(itemId);
}

/** Delete a stored image only after no menu item still points at it. */
function removeUnreferencedImageFile(filename, config) {
  if (!filename) return;
  const stillUsed = getDb()
    .prepare(`SELECT 1 FROM menu_items WHERE image_filename = ? LIMIT 1`)
    .get(filename);
  if (stillUsed) return;
  const filePath = resolveMenuImagePath(filename, config);
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // The item record no longer points here. A leftover file is safer than a broken reference.
  }
}

export function resolveMenuImagePath(filename, config) {
  if (
    !filename ||
    String(filename).includes("..") ||
    String(filename).includes("/")
  ) {
    return null;
  }
  const candidate = path.normalize(
    path.join(config.menuImagesDir, path.basename(filename))
  );
  if (!candidate.startsWith(path.normalize(config.menuImagesDir + path.sep))) {
    return null;
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return null;
  }
  return candidate;
}

export function buildInstructionLabel(modifier, target) {
  const m = String(modifier || "").trim();
  const t = String(target || "").trim();
  if (!m || !t) return "";
  return `${m} ${t}`;
}

export function dedupeInstructions(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const label = String(raw || "").trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}
