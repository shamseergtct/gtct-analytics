import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";

const DEFAULT_SHOP = "test-tenant-phase1";

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function mapAddon(row) {
  const priceUnset = row.price_cents == null;
  const price = priceUnset ? null : Number(row.price_cents);
  const taxApplicable =
    row.tax_applicable == null ? true : Boolean(Number(row.tax_applicable));
  return {
    addonId: row.addon_id,
    shopId: row.shop_id,
    name: row.name,
    description: row.description || "",
    priceCents: price,
    priceUnset,
    isFree: price === 0,
    isCharge: price != null && price > 0,
    isReduction: price != null && price < 0,
    isPaid: price != null && price > 0,
    isActive: Boolean(row.is_active),
    taxApplicable,
    sortOrder: Number(row.sort_order || 0),
    maxQuantity: Number(row.max_quantity || 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function boolFlag(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return Boolean(v);
}

/** Changing a configured add-on price. Separate from item selling-price override. */
export function canAdjustAddonPrices(role) {
  return role === "admin";
}

/**
 * Order-line base unit selling-price override for a legacy role.
 * Staff sessions use the sales.price_override grant instead.
 * A shared device token never receives this privilege.
 */
export function canAdjustBasePrices(role) {
  return role === "admin";
}

function assertSignedMinor(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || !Number.isFinite(n)) {
    throw Object.assign(
      new Error(`${fieldName} must be a finite integer (minor units)`),
      { status: 400 }
    );
  }
  return n;
}

/**
 * Library price. null = not set (ask on the item or at sale).
 * 0 = explicit free. Omitted on update keeps the stored value.
 */
function readLibraryPrice(input, existing) {
  const hasPrice =
    Object.prototype.hasOwnProperty.call(input, "priceCents") ||
    Object.prototype.hasOwnProperty.call(input, "price_cents");
  if (!hasPrice) {
    if (!existing) return null;
    return existing.price_cents == null ? null : Number(existing.price_cents);
  }
  const raw = Object.prototype.hasOwnProperty.call(input, "priceCents")
    ? input.priceCents
    : input.price_cents;
  if (raw == null || raw === "") return null;
  return assertSignedMinor(raw, "priceCents");
}

export function listAddons(shopId = DEFAULT_SHOP, { includeInactive = true, q = "" } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM addons
       WHERE shop_id = ? AND (? = 1 OR is_active = 1)
       ORDER BY sort_order ASC, name ASC`
    )
    .all(shopId, includeInactive ? 1 : 0)
    .map(mapAddon);
  const query = String(q || "").trim().toLowerCase();
  if (!query) return rows;
  return rows.filter(
    (a) =>
      a.name.toLowerCase().includes(query) ||
      a.description.toLowerCase().includes(query)
  );
}

export function getAddon(addonId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM addons WHERE addon_id = ?`).get(addonId);
  return row ? mapAddon(row) : null;
}

export function upsertAddon(shopId, input = {}, { role } = {}) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin role required"), { status: 403 });
  }
  const db = getDb();
  const name = String(input.name || "").trim();
  if (!name) {
    throw Object.assign(new Error("Add-on name is required"), { status: 400 });
  }
  const nameNorm = normalizeName(name);
  const addonId = String(input.addonId || input.id || newId("addon"));
  const existing = db
    .prepare(`SELECT * FROM addons WHERE addon_id = ?`)
    .get(addonId);
  const dup = db
    .prepare(
      `SELECT addon_id FROM addons
       WHERE shop_id = ? AND name_norm = ? AND addon_id != ?`
    )
    .get(shopId, nameNorm, addonId);
  if (dup) {
    throw Object.assign(new Error(`Duplicate add-on name: ${name}`), {
      status: 409,
    });
  }

  const priceCents = readLibraryPrice(input, existing);

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
  let maxQuantity =
    input.maxQuantity != null
      ? Number(input.maxQuantity)
      : existing
        ? Number(existing.max_quantity || 1)
        : 1;
  if (!Number.isInteger(maxQuantity) || maxQuantity < 1) {
    throw Object.assign(new Error("maxQuantity must be an integer >= 1"), {
      status: 400,
    });
  }
  const description =
    input.description != null
      ? String(input.description).trim()
      : existing?.description || "";
  const taxApplicable = boolFlag(
    input.taxApplicable ?? input.tax_applicable,
    existing ? Boolean(Number(existing.tax_applicable ?? 1)) : true
  );
  const ts = nowIso();

  if (existing) {
    db.prepare(
      `UPDATE addons SET
         name = ?, name_norm = ?, description = ?, price_cents = ?,
         is_active = ?, tax_applicable = ?, sort_order = ?, max_quantity = ?, updated_at = ?
       WHERE addon_id = ?`
    ).run(
      name,
      nameNorm,
      description,
      priceCents,
      isActive ? 1 : 0,
      taxApplicable ? 1 : 0,
      sortOrder,
      maxQuantity,
      ts,
      addonId
    );
  } else {
    db.prepare(
      `INSERT INTO addons (
         addon_id, shop_id, name, name_norm, description, price_cents,
         is_active, tax_applicable, sort_order, max_quantity, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      addonId,
      shopId,
      name,
      nameNorm,
      description,
      priceCents,
      isActive ? 1 : 0,
      taxApplicable ? 1 : 0,
      sortOrder,
      maxQuantity,
      ts,
      ts
    );
  }
  return getAddon(addonId);
}

export function listAddonAssignments(addonId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT mi.item_id, mi.name, mia.price_override_cents
       FROM menu_item_addons mia
       JOIN menu_items mi ON mi.item_id = mia.item_id
       WHERE mia.addon_id = ?
       ORDER BY mi.name`
    )
    .all(addonId)
    .map((r) => ({
      itemId: r.item_id,
      name: r.name,
      priceOverrideCents:
        r.price_override_cents == null ? null : Number(r.price_override_cents),
    }));
}

/** Enabled add-ons for a menu item with effective price. */
export function getItemAddons(itemId, { activeOnly = true } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.*, mia.price_override_cents
       FROM menu_item_addons mia
       JOIN addons a ON a.addon_id = mia.addon_id
       WHERE mia.item_id = ?
         AND (? = 0 OR a.is_active = 1)
       ORDER BY a.sort_order ASC, a.name ASC`
    )
    .all(itemId, activeOnly ? 1 : 0);

  return rows.map((row) => {
    const base = mapAddon(row);
    const override =
      row.price_override_cents == null
        ? null
        : Number(row.price_override_cents);
    // Item price wins. Otherwise the library price. Both empty → ask at sale.
    const effective = override != null ? override : base.priceCents;
    const priceUnset = effective == null;
    return {
      ...base,
      priceOverrideCents: override,
      effectivePriceCents: effective,
      priceUnset,
      isFree: effective === 0,
      isCharge: effective != null && effective > 0,
      isReduction: effective != null && effective < 0,
      isPaid: effective != null && effective > 0,
      assigned: true,
    };
  });
}

/**
 * Replace item add-on assignments.
 * assignments: [{ addonId, priceOverrideCents: number|null }]
 * null override = use library default; 0 = explicit free override.
 */
export function setItemAddons(itemId, assignments = [], { role } = {}) {
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
  if (!Array.isArray(assignments)) {
    throw Object.assign(new Error("assignments must be an array"), {
      status: 400,
    });
  }

  const seen = new Set();
  const cleaned = [];
  for (const a of assignments) {
    const addonId = String(a.addonId || a.addon_id || "").trim();
    if (!addonId) continue;
    if (seen.has(addonId)) {
      throw Object.assign(new Error(`Duplicate add-on assignment: ${addonId}`), {
        status: 400,
      });
    }
    seen.add(addonId);
    const addon = db.prepare(`SELECT * FROM addons WHERE addon_id = ?`).get(addonId);
    if (!addon) {
      throw Object.assign(new Error(`Unknown add-on: ${addonId}`), {
        status: 400,
      });
    }
    let override = undefined;
    if (Object.prototype.hasOwnProperty.call(a, "priceOverrideCents")) {
      override = a.priceOverrideCents;
    } else if (Object.prototype.hasOwnProperty.call(a, "price_override_cents")) {
      override = a.price_override_cents;
    } else {
      override = null;
    }
    if (override != null) {
      override = assertSignedMinor(override, "priceOverrideCents");
    }
    cleaned.push({ addonId, priceOverrideCents: override });
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM menu_item_addons WHERE item_id = ?`).run(itemId);
    const ins = db.prepare(
      `INSERT INTO menu_item_addons (item_id, addon_id, price_override_cents)
       VALUES (?, ?, ?)`
    );
    for (const row of cleaned) {
      ins.run(itemId, row.addonId, row.priceOverrideCents);
    }
    db.prepare(`UPDATE menu_items SET updated_at = ? WHERE item_id = ?`).run(
      nowIso(),
      itemId
    );
  });
  tx();
  return getItemAddons(itemId, { activeOnly: false });
}

/**
 * Resolve and validate add-on selections for order creation.
 * A configured price is always resolved on the server.
 * Changing a configured price requires canAdjustAddonPrices(role).
 * If neither the library nor the item has a price, unitPriceCents is required
 * and any role that can place the order may supply it.
 * selections: [{ addonId, quantity?, unitPriceCents? | priceCents? }]
 */
export function resolveOrderAddons(
  itemId,
  selections = [],
  { role = "device", allowAdjust = null } = {}
) {
  if (!Array.isArray(selections) || selections.length === 0) return [];
  const allowed = getItemAddons(itemId, { activeOnly: true });
  const byId = new Map(allowed.map((a) => [a.addonId, a]));
  const seen = new Set();
  const resolved = [];
  const mayAdjust = allowAdjust == null ? canAdjustAddonPrices(role) : Boolean(allowAdjust);

  for (const sel of selections) {
    const addonId = String(sel.addonId || sel.addon_id || "").trim();
    if (!addonId) continue;
    if (seen.has(addonId)) {
      throw Object.assign(
        new Error(`Duplicate add-on on line: ${addonId}`),
        { status: 400 }
      );
    }
    seen.add(addonId);
    const cfg = byId.get(addonId);
    if (!cfg) {
      throw Object.assign(
        new Error(`Add-on not available for this item: ${addonId}`),
        { status: 400 }
      );
    }
    let qty = sel.quantity != null ? Number(sel.quantity) : 1;
    if (!Number.isInteger(qty) || qty < 1) {
      throw Object.assign(new Error("Add-on quantity must be an integer >= 1"), {
        status: 400,
      });
    }
    if (qty > cfg.maxQuantity) {
      throw Object.assign(
        new Error(`Add-on ${cfg.name} max quantity is ${cfg.maxQuantity}`),
        { status: 400 }
      );
    }

    const catalogUnset = cfg.priceUnset || cfg.effectivePriceCents == null;
    if (catalogUnset) {
      const raw =
        sel.unitPriceCents ?? sel.priceCents ?? sel.unit_price_cents;
      if (raw === null || raw === undefined || raw === "") {
        throw Object.assign(new Error(`Enter a price for ${cfg.name}`), {
          status: 400,
        });
      }
      const requested = assertSignedMinor(raw, "unitPriceCents");
      resolved.push({
        addonId: cfg.addonId,
        name: cfg.name,
        quantity: qty,
        configuredUnitPriceCents: requested,
        unitPriceCents: requested,
        linePriceCents: requested * qty,
        priceAdjusted: false,
        priceDeltaCents: 0,
        priceEnteredAtSale: true,
        taxApplicable: cfg.taxApplicable !== false,
      });
      continue;
    }

    const configured = Number(cfg.effectivePriceCents);
    let applied = configured;
    let priceAdjusted = false;

    const hasOverride =
      Object.prototype.hasOwnProperty.call(sel, "unitPriceCents") ||
      Object.prototype.hasOwnProperty.call(sel, "priceCents") ||
      Object.prototype.hasOwnProperty.call(sel, "unit_price_cents");

    if (hasOverride) {
      const raw =
        sel.unitPriceCents ?? sel.priceCents ?? sel.unit_price_cents;
      if (raw === null || raw === undefined || raw === "") {
        // Explicit null/empty → use configured (not an adjustment)
        applied = configured;
      } else {
        const requested = assertSignedMinor(raw, "unitPriceCents");
        if (requested !== configured) {
          if (!mayAdjust) {
            throw Object.assign(
              new Error(
                "Price adjustment permission required to override add-on prices"
              ),
              { status: 403 }
            );
          }
          applied = requested;
          priceAdjusted = true;
        }
      }
    }

    resolved.push({
      addonId: cfg.addonId,
      name: cfg.name,
      quantity: qty,
      configuredUnitPriceCents: configured,
      unitPriceCents: applied,
      linePriceCents: applied * qty,
      priceAdjusted,
      priceDeltaCents: applied - configured,
      priceEnteredAtSale: false,
      taxApplicable: cfg.taxApplicable !== false,
    });
  }
  return resolved;
}

export function sumAddonMinor(resolvedAddons) {
  let total = 0;
  for (const a of resolvedAddons || []) {
    total += Number(a.linePriceCents || 0);
  }
  return total;
}
