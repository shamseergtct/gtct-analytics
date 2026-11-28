import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { getShopSettings, updateShopSettings } from "./shopSettings.js";

const DEFAULT_SHOP = "test-tenant-phase1";

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function mapMod(row) {
  return {
    modifierId: row.modifier_id,
    shopId: row.shop_id,
    name: row.name,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTgt(row) {
  return {
    targetId: row.target_id,
    shopId: row.shop_id,
    name: row.name,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStand(row) {
  return {
    standaloneId: row.standalone_id,
    shopId: row.shop_id,
    name: row.name,
    isActive: Boolean(row.is_active),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function syncShopJson(shopId) {
  const db = getDb();
  const mods = db
    .prepare(
      `SELECT name FROM kitchen_modifiers
       WHERE shop_id = ? AND is_active = 1
       ORDER BY sort_order, name`
    )
    .all(shopId)
    .map((r) => r.name);
  const tgts = db
    .prepare(
      `SELECT name FROM kitchen_targets
       WHERE shop_id = ? AND is_active = 1
       ORDER BY sort_order, name`
    )
    .all(shopId)
    .map((r) => r.name);
  updateShopSettings(
    shopId,
    { instructionModifiers: mods, instructionTargets: tgts },
    { role: "admin" }
  );
}

export function listModifiers(shopId = DEFAULT_SHOP, { includeInactive = true } = {}) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM kitchen_modifiers
       WHERE shop_id = ? AND (? = 1 OR is_active = 1)
       ORDER BY sort_order ASC, name ASC`
    )
    .all(shopId, includeInactive ? 1 : 0)
    .map(mapMod);
}

export function listTargets(shopId = DEFAULT_SHOP, { includeInactive = true } = {}) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM kitchen_targets
       WHERE shop_id = ? AND (? = 1 OR is_active = 1)
       ORDER BY sort_order ASC, name ASC`
    )
    .all(shopId, includeInactive ? 1 : 0)
    .map(mapTgt);
}

export function listStandalone(shopId = DEFAULT_SHOP, { includeInactive = true } = {}) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM kitchen_standalone
       WHERE shop_id = ? AND (? = 1 OR is_active = 1)
       ORDER BY sort_order ASC, name ASC`
    )
    .all(shopId, includeInactive ? 1 : 0)
    .map(mapStand);
}

export function getKitchenLibrary(shopId = DEFAULT_SHOP, opts = {}) {
  return {
    modifiers: listModifiers(shopId, opts),
    targets: listTargets(shopId, opts),
    standalone: listStandalone(shopId, opts),
  };
}

/**
 * New kitchen-library options are on for every item by default.
 * Staff hide them later by unchecking in each item's Menu editor.
 * - modifiers/targets: attach to customized items (shop-default items already inherit all active)
 * - standalone: attach to every item (shop defaults also inherit all active standalones)
 */
function enableNewKitchenOptionOnItems(kind, optionId) {
  const db = getDb();
  if (kind === "modifier") {
    const items = db
      .prepare(
        `SELECT item_id FROM menu_items WHERE COALESCE(instruction_customized, 0) = 1`
      )
      .all();
    const link = db.prepare(
      `INSERT OR IGNORE INTO menu_item_allowed_modifiers (item_id, modifier_id) VALUES (?, ?)`
    );
    for (const row of items) link.run(row.item_id, optionId);
    return;
  }
  if (kind === "target") {
    const items = db
      .prepare(
        `SELECT item_id FROM menu_items WHERE COALESCE(instruction_customized, 0) = 1`
      )
      .all();
    const link = db.prepare(
      `INSERT OR IGNORE INTO menu_item_allowed_targets (item_id, target_id) VALUES (?, ?)`
    );
    for (const row of items) link.run(row.item_id, optionId);
    return;
  }
  if (kind === "standalone") {
    const items = db.prepare(`SELECT item_id FROM menu_items`).all();
    const link = db.prepare(
      `INSERT OR IGNORE INTO menu_item_allowed_standalone (item_id, standalone_id) VALUES (?, ?)`
    );
    for (const row of items) link.run(row.item_id, optionId);
  }
}

function upsertNamed(table, idCol, prefix, shopId, input, { role } = {}) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin role required"), { status: 403 });
  }
  const db = getDb();
  const name = String(input.name || "").trim();
  if (!name) {
    throw Object.assign(new Error("Name is required"), { status: 400 });
  }
  const nameNorm = normalizeName(name);
  const id = String(input.id || input[idCol] || newId(prefix));
  const ts = nowIso();
  const existing = db
    .prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`)
    .get(id);
  const dup = db
    .prepare(
      `SELECT ${idCol} AS id FROM ${table}
       WHERE shop_id = ? AND name_norm = ? AND ${idCol} != ?`
    )
    .get(shopId, nameNorm, id);
  if (dup) {
    throw Object.assign(new Error(`Duplicate name: ${name}`), { status: 409 });
  }

  const isActive =
    input.isActive != null
      ? input.isActive !== false && input.isActive !== 0
      : existing
        ? Boolean(existing.is_active)
        : true;
  const sortOrder =
    input.sortOrder != null
      ? Number(input.sortOrder)
      : existing
        ? Number(existing.sort_order || 0)
        : 0;

  const created = !existing;
  if (existing) {
    db.prepare(
      `UPDATE ${table} SET name = ?, name_norm = ?, is_active = ?, sort_order = ?, updated_at = ?
       WHERE ${idCol} = ?`
    ).run(name, nameNorm, isActive ? 1 : 0, sortOrder, ts, id);
  } else {
    db.prepare(
      `INSERT INTO ${table} (
         ${idCol}, shop_id, name, name_norm, is_active, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, shopId, name, nameNorm, isActive ? 1 : 0, sortOrder, ts, ts);
  }
  syncShopJson(shopId);
  return {
    row: db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id),
    created,
  };
}

function findIdByName(table, idCol, shopId, name) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT ${idCol} AS id FROM ${table} WHERE shop_id = ? AND name_norm = ?`
    )
    .get(shopId, normalizeName(name));
  return row?.id || null;
}

export function upsertModifier(shopId, input, opts) {
  const name = input.name != null ? String(input.name).trim() : "";
  const id =
    input.modifierId ||
    input.id ||
    (name ? findIdByName("kitchen_modifiers", "modifier_id", shopId, name) : null);
  const { row, created } = upsertNamed(
    "kitchen_modifiers",
    "modifier_id",
    "mod",
    shopId,
    { ...input, id },
    opts
  );
  if (created) enableNewKitchenOptionOnItems("modifier", row.modifier_id);
  return mapMod(row);
}

export function upsertTarget(shopId, input, opts) {
  const name = input.name != null ? String(input.name).trim() : "";
  const id =
    input.targetId ||
    input.id ||
    (name ? findIdByName("kitchen_targets", "target_id", shopId, name) : null);
  const { row, created } = upsertNamed(
    "kitchen_targets",
    "target_id",
    "tgt",
    shopId,
    { ...input, id },
    opts
  );
  if (created) enableNewKitchenOptionOnItems("target", row.target_id);
  return mapTgt(row);
}

export function upsertStandalone(shopId, input, opts) {
  const name = input.name != null ? String(input.name).trim() : "";
  const id =
    input.standaloneId ||
    input.id ||
    (name ? findIdByName("kitchen_standalone", "standalone_id", shopId, name) : null);
  const { row, created } = upsertNamed(
    "kitchen_standalone",
    "standalone_id",
    "std",
    shopId,
    { ...input, id },
    opts
  );
  if (created) enableNewKitchenOptionOnItems("standalone", row.standalone_id);
  return mapStand(row);
}

export function setOptionActive(table, idCol, id, isActive, { role } = {}) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin role required"), { status: 403 });
  }
  const db = getDb();
  const row = db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id);
  if (!row) {
    throw Object.assign(new Error("Not found"), { status: 404 });
  }
  db.prepare(
    `UPDATE ${table} SET is_active = ?, updated_at = ? WHERE ${idCol} = ?`
  ).run(isActive ? 1 : 0, nowIso(), id);
  syncShopJson(row.shop_id);
  return db.prepare(`SELECT * FROM ${table} WHERE ${idCol} = ?`).get(id);
}

/** Resolve allowed options for a menu item (names + ids). */
export function getItemInstructionConfig(itemId, shopId = DEFAULT_SHOP) {
  const db = getDb();
  const item = db
    .prepare(`SELECT * FROM menu_items WHERE item_id = ?`)
    .get(itemId);
  if (!item) return null;

  const allMods = listModifiers(shopId, { includeInactive: false });
  const allTgts = listTargets(shopId, { includeInactive: false });
  const allStand = listStandalone(shopId, { includeInactive: false });

  const customized = Boolean(item.instruction_customized);
  let modifiers = allMods;
  let targets = allTgts;
  let standalone = [];

  if (customized) {
    const modIds = new Set(
      db
        .prepare(
          `SELECT modifier_id FROM menu_item_allowed_modifiers WHERE item_id = ?`
        )
        .all(itemId)
        .map((r) => r.modifier_id)
    );
    const tgtIds = new Set(
      db
        .prepare(
          `SELECT target_id FROM menu_item_allowed_targets WHERE item_id = ?`
        )
        .all(itemId)
        .map((r) => r.target_id)
    );
    const stdIds = new Set(
      db
        .prepare(
          `SELECT standalone_id FROM menu_item_allowed_standalone WHERE item_id = ?`
        )
        .all(itemId)
        .map((r) => r.standalone_id)
    );
    modifiers = allMods.filter((m) => modIds.has(m.modifierId));
    targets = allTgts.filter((t) => tgtIds.has(t.targetId));
    // Empty standalone links = inherit shop library (same as defaults).
    // Once any standalone is saved on the item, only those stay available.
    standalone =
      stdIds.size === 0
        ? allStand
        : allStand.filter((s) => stdIds.has(s.standaloneId));
  } else {
    // Shop defaults: every active modifier, target, and standalone note.
    // Uncheck per item only after switching that item to Customize.
    standalone = allStand;
  }

  const blocked = db
    .prepare(
      `SELECT modifier_id, target_id FROM menu_item_blocked_pairs WHERE item_id = ?`
    )
    .all(itemId)
    .map((r) => ({ modifierId: r.modifier_id, targetId: r.target_id }));

  return {
    customized,
    modifiers,
    targets,
    standalone,
    blockedPairs: blocked,
    instructionModifiers: modifiers.map((m) => m.name),
    instructionTargets: targets.map((t) => t.name),
    instructionStandalone: standalone.map((s) => s.name),
  };
}

/**
 * Save item-level instruction selections.
 * useShopDefaults=true clears customization and inherits active shop library.
 */
export function setItemInstructionConfig(itemId, input = {}, { role } = {}) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin role required"), { status: 403 });
  }
  const db = getDb();
  const item = db
    .prepare(`SELECT item_id FROM menu_items WHERE item_id = ?`)
    .get(itemId);
  if (!item) {
    throw Object.assign(new Error("Menu item not found"), { status: 404 });
  }

  const useShopDefaults =
    input.useShopDefaults === true || input.customized === false;
  const ts = nowIso();

  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM menu_item_allowed_modifiers WHERE item_id = ?`
    ).run(itemId);
    db.prepare(
      `DELETE FROM menu_item_allowed_targets WHERE item_id = ?`
    ).run(itemId);
    db.prepare(
      `DELETE FROM menu_item_allowed_standalone WHERE item_id = ?`
    ).run(itemId);
    db.prepare(
      `DELETE FROM menu_item_blocked_pairs WHERE item_id = ?`
    ).run(itemId);

    if (useShopDefaults) {
      db.prepare(
        `UPDATE menu_items SET instruction_customized = 0,
           instruction_modifiers_json = '[]', instruction_targets_json = '[]',
           updated_at = ?
         WHERE item_id = ?`
      ).run(ts, itemId);
      // Optional standalones still allowed under shop defaults
      const stdIds = Array.isArray(input.standaloneIds)
        ? [...new Set(input.standaloneIds.map(String))]
        : [];
      const linkStd = db.prepare(
        `INSERT OR IGNORE INTO menu_item_allowed_standalone (item_id, standalone_id) VALUES (?, ?)`
      );
      for (const id of stdIds) linkStd.run(itemId, id);
    } else {
      const modIds = Array.isArray(input.modifierIds)
        ? [...new Set(input.modifierIds.map(String))]
        : [];
      const tgtIds = Array.isArray(input.targetIds)
        ? [...new Set(input.targetIds.map(String))]
        : [];
      const stdIds = Array.isArray(input.standaloneIds)
        ? [...new Set(input.standaloneIds.map(String))]
        : [];
      const linkMod = db.prepare(
        `INSERT OR IGNORE INTO menu_item_allowed_modifiers (item_id, modifier_id) VALUES (?, ?)`
      );
      const linkTgt = db.prepare(
        `INSERT OR IGNORE INTO menu_item_allowed_targets (item_id, target_id) VALUES (?, ?)`
      );
      const linkStd = db.prepare(
        `INSERT OR IGNORE INTO menu_item_allowed_standalone (item_id, standalone_id) VALUES (?, ?)`
      );
      for (const id of modIds) linkMod.run(itemId, id);
      for (const id of tgtIds) linkTgt.run(itemId, id);
      for (const id of stdIds) linkStd.run(itemId, id);

      const blocked = Array.isArray(input.blockedPairs) ? input.blockedPairs : [];
      const linkBlock = db.prepare(
        `INSERT OR IGNORE INTO menu_item_blocked_pairs (item_id, modifier_id, target_id) VALUES (?, ?, ?)`
      );
      for (const p of blocked) {
        if (p?.modifierId && p?.targetId) {
          linkBlock.run(itemId, String(p.modifierId), String(p.targetId));
        }
      }

      const modNames = modIds
        .map((id) =>
          db
            .prepare(`SELECT name FROM kitchen_modifiers WHERE modifier_id = ?`)
            .get(id)?.name
        )
        .filter(Boolean);
      const tgtNames = tgtIds
        .map((id) =>
          db
            .prepare(`SELECT name FROM kitchen_targets WHERE target_id = ?`)
            .get(id)?.name
        )
        .filter(Boolean);

      db.prepare(
        `UPDATE menu_items SET instruction_customized = 1,
           instruction_modifiers_json = ?, instruction_targets_json = ?,
           updated_at = ?
         WHERE item_id = ?`
      ).run(JSON.stringify(modNames), JSON.stringify(tgtNames), ts, itemId);
    }
  });
  tx();
  return getItemInstructionConfig(itemId);
}

/**
 * Validate instruction labels for an order line.
 * Allows configured combos, standalones, and free-form notes.
 * Rejects explicitly blocked modifier+target pairs for the item.
 */
export function validateOrderInstructions(itemId, instructions = []) {
  const cfg = getItemInstructionConfig(itemId);
  if (!cfg) {
    throw Object.assign(new Error("Unknown menu item"), { status: 400 });
  }
  const blockedLabels = new Set();
  for (const p of cfg.blockedPairs || []) {
    const m = cfg.modifiers.find((x) => x.modifierId === p.modifierId);
    const t = cfg.targets.find((x) => x.targetId === p.targetId);
    if (m && t) {
      blockedLabels.add(`${m.name} ${t.name}`.toLowerCase());
    }
  }
  for (const label of instructions) {
    const text = String(label || "").trim();
    if (!text) continue;
    if (blockedLabels.has(text.toLowerCase())) {
      throw Object.assign(
        new Error(`Instruction combination not allowed: ${text}`),
        { status: 400 }
      );
    }
  }
  return instructions;
}

export function legacyKitchenNotesFromLibrary(shopId = DEFAULT_SHOP) {
  try {
    const lib = getKitchenLibrary(shopId, { includeInactive: false });
    return {
      modifiers: lib.modifiers.map((m) => m.name),
      targets: lib.targets.map((t) => t.name),
    };
  } catch {
    const shop = getShopSettings(shopId);
    return {
      modifiers: shop.instructionModifiers,
      targets: shop.instructionTargets,
    };
  }
}
