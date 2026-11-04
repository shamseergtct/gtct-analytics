import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { recordAudit } from "./audit.js";

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function boolFlag(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return Boolean(v);
}

function assertNonNegMinor(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || !Number.isFinite(n) || n < 0) {
    throw Object.assign(
      new Error(`${fieldName} must be a non-negative integer (minor units)`),
      { status: 400 }
    );
  }
  return n;
}

export function mapVariant(row) {
  return {
    variantId: row.variant_id,
    itemId: row.item_id,
    name: row.name,
    priceCents: Number(row.price_cents || 0),
    sku: row.sku || null,
    code: row.code || "",
    sortOrder: Number(row.sort_order || 0),
    isActive: Boolean(row.is_active),
    isSoldOut: Boolean(row.is_sold_out),
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listVariantsForItem(itemId, { activeOnly = false } = {}) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM menu_item_variants
       WHERE item_id = ? AND (? = 0 OR is_active = 1)
       ORDER BY sort_order ASC, name ASC`
    )
    .all(itemId, activeOnly ? 1 : 0)
    .map(mapVariant);
}

export function getVariant(variantId) {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM menu_item_variants WHERE variant_id = ?`)
    .get(variantId);
  return row ? mapVariant(row) : null;
}

/**
 * Resolve authoritative unit base price for an order line.
 * Returns { unitBaseCents, variant, displayName } or throws.
 */
export function resolveVariantForOrder(item, variantId, options = {}) {
  const hasVariants = Boolean(Number(item.has_variants || 0));
  if (!hasVariants) {
    if (variantId) {
      throw Object.assign(
        new Error(`Item ${item.name} does not have variants`),
        { status: 400 }
      );
    }
    return {
      unitBaseCents: Number(item.price_cents || 0),
      variant: null,
      displayName: item.name,
    };
  }

  if (!variantId) {
    throw Object.assign(
      new Error(`Variant required for ${item.name}`),
      { status: 400 }
    );
  }

  const variant = getVariant(variantId);
  if (!variant || variant.itemId !== item.item_id) {
    throw Object.assign(
      new Error(`Variant does not belong to ${item.name}`),
      { status: 400 }
    );
  }
  if (!options.allowUnavailable && !variant.isActive) {
    throw Object.assign(
      new Error(`Variant is inactive: ${variant.name}`),
      { status: 400 }
    );
  }
  if (!options.allowUnavailable && variant.isSoldOut) {
    throw Object.assign(
      new Error(`Variant is sold out: ${variant.name}`),
      { status: 400 }
    );
  }

  return {
    unitBaseCents: Number(variant.priceCents),
    variant,
    displayName: `${item.name} — ${variant.name}`,
  };
}

/**
 * Replace or upsert the full variant set for an item (admin).
 * Soft-deactivates variants omitted from the payload when they already exist.
 * Never hard-deletes variants (historical order references).
 */
export function setItemVariants(itemId, input = {}, { role } = {}) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin role required"), { status: 403 });
  }
  const db = getDb();
  const item = db
    .prepare(`SELECT * FROM menu_items WHERE item_id = ?`)
    .get(itemId);
  if (!item) {
    throw Object.assign(new Error("Menu item not found"), { status: 404 });
  }

  const hasVariants = boolFlag(input.hasVariants ?? input.has_variants, false);
  const rawList = Array.isArray(input.variants) ? input.variants : [];
  const ts = nowIso();

  if (hasVariants && rawList.length === 0) {
    throw Object.assign(
      new Error("At least one variant is required when Has Variants is ON"),
      { status: 400 }
    );
  }

  const seenNorm = new Set();
  const normalized = [];
  for (const raw of rawList) {
    const name = String(raw.name || "").trim();
    if (!name) {
      throw Object.assign(new Error("Variant name is required"), { status: 400 });
    }
    const nameNorm = normalizeName(name);
    if (seenNorm.has(nameNorm)) {
      throw Object.assign(
        new Error(`Duplicate variant name: ${name}`),
        { status: 409 }
      );
    }
    seenNorm.add(nameNorm);
    const priceCents = assertNonNegMinor(
      raw.priceCents ?? raw.price_cents,
      "variant priceCents"
    );
    const isActive = boolFlag(raw.isActive ?? raw.is_active, true);
    const isSoldOut = boolFlag(raw.isSoldOut ?? raw.is_sold_out, false);
    const isDefault = boolFlag(raw.isDefault ?? raw.is_default, false);
    const sortOrder =
      raw.sortOrder != null
        ? Number(raw.sortOrder)
        : raw.sort_order != null
          ? Number(raw.sort_order)
          : normalized.length;
    if (!Number.isInteger(sortOrder)) {
      throw Object.assign(new Error("sortOrder must be an integer"), {
        status: 400,
      });
    }
    normalized.push({
      variantId: String(raw.variantId || raw.variant_id || ""),
      name,
      nameNorm,
      priceCents,
      sku:
        raw.sku != null && String(raw.sku).trim()
          ? String(raw.sku).trim()
          : null,
      code: raw.code != null ? String(raw.code).trim() : "",
      sortOrder,
      isActive,
      isSoldOut,
      isDefault,
    });
  }

  if (hasVariants) {
    const defaults = normalized.filter((v) => v.isDefault && v.isActive);
    if (defaults.length > 1) {
      throw Object.assign(
        new Error("Only one default variant is allowed"),
        { status: 400 }
      );
    }
    const activeCount = normalized.filter((v) => v.isActive).length;
    if (activeCount < 1) {
      throw Object.assign(
        new Error("At least one active variant is required"),
        { status: 400 }
      );
    }
  }

  const existing = listVariantsForItem(itemId, { activeOnly: false });
  const existingById = new Map(existing.map((v) => [v.variantId, v]));
  const keptIds = new Set();

  const tx = db.transaction(() => {
    for (const v of normalized) {
      let variantId = v.variantId;
      let prev = variantId ? existingById.get(variantId) : null;
      if (variantId && prev && prev.itemId !== itemId) {
        throw Object.assign(
          new Error("Variant belongs to another item"),
          { status: 400 }
        );
      }
      if (!prev) {
        // Match by name_norm for stable re-save without id
        prev = existing.find((e) => normalizeName(e.name) === v.nameNorm);
        if (prev) variantId = prev.variantId;
      }
      if (!variantId) variantId = newId("var");

      keptIds.add(variantId);
      const dup = db
        .prepare(
          `SELECT variant_id FROM menu_item_variants
           WHERE item_id = ? AND name_norm = ? AND variant_id != ?`
        )
        .get(itemId, v.nameNorm, variantId);
      if (dup) {
        throw Object.assign(
          new Error(`Duplicate variant name: ${v.name}`),
          { status: 409 }
        );
      }

      if (prev) {
        db.prepare(
          `UPDATE menu_item_variants SET
             name = ?, name_norm = ?, price_cents = ?, sku = ?, code = ?,
             sort_order = ?, is_active = ?, is_sold_out = ?, is_default = ?,
             updated_at = ?
           WHERE variant_id = ?`
        ).run(
          v.name,
          v.nameNorm,
          v.priceCents,
          v.sku,
          v.code,
          v.sortOrder,
          v.isActive ? 1 : 0,
          v.isSoldOut ? 1 : 0,
          v.isDefault ? 1 : 0,
          ts,
          variantId
        );
        if (prev.priceCents !== v.priceCents) {
          recordAudit({
            actorRole: role,
            action: "variant.price_change",
            entityType: "menu_item_variant",
            entityId: variantId,
            detail: {
              itemId,
              name: v.name,
              oldPriceCents: prev.priceCents,
              newPriceCents: v.priceCents,
            },
          });
        }
      } else {
        db.prepare(
          `INSERT INTO menu_item_variants (
             variant_id, item_id, name, name_norm, price_cents, sku, code,
             sort_order, is_active, is_sold_out, is_default, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          variantId,
          itemId,
          v.name,
          v.nameNorm,
          v.priceCents,
          v.sku,
          v.code,
          v.sortOrder,
          v.isActive ? 1 : 0,
          v.isSoldOut ? 1 : 0,
          v.isDefault ? 1 : 0,
          ts,
          ts
        );
        recordAudit({
          actorRole: role,
          action: "variant.create",
          entityType: "menu_item_variant",
          entityId: variantId,
          detail: {
            itemId,
            name: v.name,
            priceCents: v.priceCents,
          },
        });
      }
    }

    // Soft-deactivate omitted variants (never hard-delete)
    for (const prev of existing) {
      if (!keptIds.has(prev.variantId)) {
        db.prepare(
          `UPDATE menu_item_variants SET
             is_active = 0, is_default = 0, updated_at = ?
           WHERE variant_id = ?`
        ).run(ts, prev.variantId);
        recordAudit({
          actorRole: role,
          action: "variant.deactivate",
          entityType: "menu_item_variant",
          entityId: prev.variantId,
          detail: { itemId, name: prev.name },
        });
      }
    }

    // Clear default on inactive / non-default rows when hasVariants off
    if (!hasVariants) {
      db.prepare(
        `UPDATE menu_item_variants SET is_default = 0, updated_at = ?
         WHERE item_id = ?`
      ).run(ts, itemId);
    }

    db.prepare(
      `UPDATE menu_items SET has_variants = ?, updated_at = ? WHERE item_id = ?`
    ).run(hasVariants ? 1 : 0, ts, itemId);
  });

  tx();
  return {
    hasVariants,
    variants: listVariantsForItem(itemId, { activeOnly: false }),
  };
}

/** Sales-facing: active, not sold out variants only when parent has_variants. */
export function salesVariantsForItem(item) {
  if (!item) return [];
  const has = Boolean(item.hasVariants ?? Number(item.has_variants || 0));
  if (!has) return [];
  return listVariantsForItem(item.item_id || item.itemId, {
    activeOnly: true,
  }).filter((v) => !v.isSoldOut);
}
