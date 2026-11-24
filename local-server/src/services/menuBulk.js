import { getShopSettings } from "./shopSettings.js";
import { listStations } from "./stations.js";
import { listMenuItems, upsertMenuItem, getMenuItem } from "./menuMappings.js";
import { parseMoneyInput } from "../util/money.js";

export const BULK_COLUMNS = [
  "item_id",
  "name",
  "category",
  "subcategory",
  "variant",
  "price",
  "preparation_center",
];

const HEADER_ALIASES = {
  item_id: ["item_id", "item id", "itemid", "id"],
  name: ["name", "item name", "item_name"],
  category: ["category", "cat"],
  subcategory: ["subcategory", "sub category", "sub_category", "subcat"],
  variant: ["variant", "size", "option"],
  price: ["price", "amount"],
  preparation_center: [
    "preparation_center",
    "preparation center",
    "prep_center",
    "prep center",
    "station",
    "kitchen station",
    "prep station",
  ],
};

function shopMoney() {
  const shop = getShopSettings();
  return {
    shop,
    decimals: Number(shop.currencyDecimals ?? shop.currency_decimals ?? 2),
  };
}

function formatPrice(minor) {
  const { shop } = shopMoney();
  // Plain number without currency label for Excel editing.
  const decimals = Number(shop.currencyDecimals ?? 2);
  const factor = 10 ** decimals;
  const n = Number(minor || 0);
  const negative = n < 0;
  const abs = Math.abs(Math.trunc(n));
  const whole = Math.floor(abs / factor);
  const frac = abs % factor;
  const fracStr =
    decimals > 0 ? `.${String(frac).padStart(decimals, "0")}` : "";
  return `${negative ? "-" : ""}${whole}${fracStr}`;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function parseCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (ch === "\r") continue;
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c || "").trim() !== ""));
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ");
}

function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((raw, index) => {
    const norm = normalizeHeader(raw);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some((a) => normalizeHeader(a) === norm)) {
        map[field] = index;
      }
    }
  });
  if (map.name == null || map.price == null || map.category == null) {
    throw Object.assign(
      new Error(
        "CSV must include headers: item_id, name, category, subcategory, variant, price, preparation_center"
      ),
      { status: 400 }
    );
  }
  return map;
}

function cell(row, index) {
  if (index == null) return "";
  return String(row[index] ?? "").trim();
}

function isNoneStation(value) {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  return !v || v === "none" || v === "— none" || v === "- none" || v === "n/a";
}

function resolveStationId(nameOrId, stations) {
  if (isNoneStation(nameOrId)) return null;
  const raw = String(nameOrId).trim();
  const byId = stations.find((s) => s.station_id === raw);
  if (byId && byId.station_id !== "station_cashier") return byId.station_id;
  const needle = raw.toLowerCase();
  const byName = stations.find(
    (s) =>
      s.station_id !== "station_cashier" &&
      s.is_active &&
      String(s.name || "")
        .trim()
        .toLowerCase() === needle
  );
  if (byName) return byName.station_id;
  throw Object.assign(
    new Error(`Unknown preparation center: ${raw}`),
    { status: 400 }
  );
}

function stationName(stationId, stations) {
  if (!stationId) return "";
  const hit = stations.find((s) => s.station_id === stationId);
  return hit?.name || stationId;
}

/**
 * Build Excel-friendly CSV (UTF-8 BOM). One row per simple item;
 * one row per variant when the item has sizes.
 */
export function exportMenuItemsCsv() {
  const stations = listStations();
  const items = listMenuItems({ includeInactive: true });
  const lines = [BULK_COLUMNS.join(",")];

  for (const item of items) {
    const category = item.category || "";
    const subcategory = item.subcategory || "";
    const prep = stationName(item.stationIds?.[0], stations);
    const activeVariants = (item.variants || []).filter((v) => v.isActive);

    if (item.hasVariants && activeVariants.length) {
      for (const variant of activeVariants) {
        lines.push(
          [
            csvEscape(item.item_id),
            csvEscape(item.name),
            csvEscape(category),
            csvEscape(subcategory),
            csvEscape(variant.name),
            csvEscape(formatPrice(variant.priceCents)),
            csvEscape(prep),
          ].join(",")
        );
      }
    } else {
      lines.push(
        [
          csvEscape(item.item_id),
          csvEscape(item.name),
          csvEscape(category),
          csvEscape(subcategory),
          "",
          csvEscape(formatPrice(item.price_cents)),
          csvEscape(prep),
        ].join(",")
      );
    }
  }

  return `\uFEFF${lines.join("\n")}\n`;
}

function groupImportRows(parsedRows, headerMap) {
  const groups = new Map();
  parsedRows.forEach((row, index) => {
    const itemId = cell(row, headerMap.item_id);
    const name = cell(row, headerMap.name);
    const category = cell(row, headerMap.category);
    const subcategory = cell(row, headerMap.subcategory);
    const variant = cell(row, headerMap.variant);
    const price = cell(row, headerMap.price);
    const prep = cell(row, headerMap.preparation_center);
    const lineNo = index + 2; // header is line 1

    if (!name) {
      throw Object.assign(new Error(`Row ${lineNo}: name is required`), {
        status: 400,
      });
    }
    if (!category) {
      throw Object.assign(new Error(`Row ${lineNo}: category is required`), {
        status: 400,
      });
    }
    if (!price) {
      throw Object.assign(new Error(`Row ${lineNo}: price is required`), {
        status: 400,
      });
    }

    const key = itemId
      ? `id:${itemId}`
      : `new:${name.toLowerCase()}|${category.toLowerCase()}|${subcategory.toLowerCase()}|${prep.toLowerCase()}`;

    if (!groups.has(key)) {
      groups.set(key, {
        itemId: itemId || null,
        name,
        category,
        subcategory,
        preparationCenter: prep,
        rows: [],
      });
    }
    const group = groups.get(key);
    if (itemId && group.name !== name) {
      // Allow rename via first differing name — use latest non-empty.
      group.name = name;
    }
    if (category) group.category = category;
    if (subcategory || subcategory === "") group.subcategory = subcategory;
    if (prep || prep === "") group.preparationCenter = prep;
    group.rows.push({ lineNo, variant, price });
  });
  return [...groups.values()];
}

/**
 * Import Excel/CSV rows. Kitchen instructions are left on shop defaults
 * for new items and untouched for existing items.
 */
export function importMenuItemsCsv(csvText) {
  const table = parseCsv(csvText);
  if (table.length < 2) {
    throw Object.assign(
      new Error("CSV must include a header row and at least one data row"),
      { status: 400 }
    );
  }
  const headerMap = mapHeaders(table[0]);
  const groups = groupImportRows(table.slice(1), headerMap);
  const stations = listStations();
  const { decimals } = shopMoney();

  const summary = {
    created: 0,
    updated: 0,
    variants: 0,
    errors: [],
    items: [],
  };

  for (const group of groups) {
    try {
      let stationId = null;
      try {
        stationId = resolveStationId(group.preparationCenter, stations);
      } catch (err) {
        throw Object.assign(
          new Error(
            `Item “${group.name}”: ${err.message}. Use a station name from Settings, or leave blank for None.`
          ),
          { status: 400 }
        );
      }

      const variantRows = group.rows.filter((r) => r.variant);
      const plainRows = group.rows.filter((r) => !r.variant);
      if (variantRows.length && plainRows.length) {
        throw Object.assign(
          new Error(
            `Item “${group.name}”: mix of variant and non-variant rows is not allowed`
          ),
          { status: 400 }
        );
      }

      const hasVariants = variantRows.length > 0;
      let priceCents = 0;
      let variants = [];

      if (hasVariants) {
        const seen = new Set();
        variants = variantRows.map((r, i) => {
          const name = r.variant;
          const norm = name.toLowerCase();
          if (seen.has(norm)) {
            throw Object.assign(
              new Error(
                `Item “${group.name}”: duplicate variant “${name}” (row ${r.lineNo})`
              ),
              { status: 400 }
            );
          }
          seen.add(norm);
          let cents;
          try {
            cents = parseMoneyInput(r.price, decimals);
          } catch (err) {
            throw Object.assign(
              new Error(
                `Item “${group.name}” variant “${name}” (row ${r.lineNo}): ${err.message}`
              ),
              { status: 400 }
            );
          }
          if (cents < 0) {
            throw Object.assign(
              new Error(
                `Item “${group.name}” variant “${name}”: price cannot be negative`
              ),
              { status: 400 }
            );
          }
          return {
            name,
            priceCents: cents,
            sortOrder: i,
            isActive: true,
            isSoldOut: false,
            isDefault: i === 0,
          };
        });
        priceCents = Math.min(...variants.map((v) => v.priceCents));
        summary.variants += variants.length;
      } else {
        const priceRaw = plainRows[0]?.price || group.rows[0].price;
        try {
          priceCents = parseMoneyInput(priceRaw, decimals);
        } catch (err) {
          throw Object.assign(
            new Error(`Item “${group.name}”: ${err.message}`),
            { status: 400 }
          );
        }
        if (priceCents < 0) {
          throw Object.assign(
            new Error(`Item “${group.name}”: price cannot be negative`),
            { status: 400 }
          );
        }
      }

      const existing = group.itemId ? getMenuItem(group.itemId) : null;
      if (group.itemId && !existing) {
        throw Object.assign(
          new Error(`Unknown item_id: ${group.itemId}`),
          { status: 400 }
        );
      }

      // Match existing variants by name so Excel edits keep IDs stable.
      if (hasVariants && existing?.variants?.length) {
        variants = variants.map((v) => {
          const prev = existing.variants.find(
            (e) =>
              String(e.name || "")
                .trim()
                .toLowerCase() === v.name.toLowerCase()
          );
          return prev ? { ...v, variantId: prev.variantId } : v;
        });
      }

      const payload = {
        itemId: group.itemId || undefined,
        name: group.name,
        category: group.category,
        subcategory: group.subcategory || "",
        priceCents,
        stationIds: stationId ? [stationId] : [],
        hasVariants,
        variants: hasVariants ? variants : [],
        // Kitchen instructions: shop defaults for new; untouched for existing
        // (omit instruction fields so upsert does not rewrite them).
      };

      if (!existing) {
        payload.useShopDefaults = true;
        payload.instructionCustomize = false;
      }

      const saved = upsertMenuItem(payload);
      if (existing) summary.updated += 1;
      else summary.created += 1;
      summary.items.push({
        itemId: saved.item_id,
        name: saved.name,
        action: existing ? "updated" : "created",
        variantCount: hasVariants ? variants.length : 0,
      });
    } catch (err) {
      summary.errors.push(err.message || String(err));
    }
  }

  if (summary.errors.length && !summary.created && !summary.updated) {
    throw Object.assign(
      new Error(summary.errors.slice(0, 5).join("; ")),
      { status: 400, errors: summary.errors, summary }
    );
  }

  return summary;
}

/** Template CSV with header + sample rows. */
export function exportMenuItemsTemplateCsv() {
  const sample = [
    "",
    "Sample Burger",
    "Food",
    "Burgers",
    "",
    "25.00",
    "",
  ];
  const variantA = [
    "",
    "Sample Pizza",
    "Food",
    "Pizza",
    "Small",
    "20.00",
    "",
  ];
  const variantB = [
    "",
    "Sample Pizza",
    "Food",
    "Pizza",
    "Large",
    "35.00",
    "",
  ];
  return (
    `\uFEFF${BULK_COLUMNS.join(",")}\n` +
    `${sample.map(csvEscape).join(",")}\n` +
    `${variantA.map(csvEscape).join(",")}\n` +
    `${variantB.map(csvEscape).join(",")}\n`
  );
}
