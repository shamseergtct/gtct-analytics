import { getDb } from "../db/db.js";
import { nowIso } from "../util/time.js";
import {
  TAX_MODES,
  assertTaxRateBps,
  parseTaxPercentInput,
  formatTaxPercentFromBps,
} from "./tax.js";

const DEFAULT_SHOP_ID = "test-tenant-phase1";

const PRESETS = {
  BHD: { currency_code: "BHD", currency_label: "BHD", currency_decimals: 3 },
  QAR: { currency_code: "QAR", currency_label: "QR", currency_decimals: 2 },
  INR: { currency_code: "INR", currency_label: "₹", currency_decimals: 2 },
};

const DATE_FORMATS = new Set(["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MM-YYYY"]);

function parseJsonArray(raw, fallback) {
  try {
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [...fallback];
    return parsed.map((v) => String(v).trim()).filter(Boolean);
  } catch {
    return [...fallback];
  }
}

function flag(row, key, defaultVal = 0) {
  if (row[key] == null) return Boolean(defaultVal);
  return Boolean(Number(row[key]));
}

function clampStr(value, max, fallback = "") {
  const s = String(value ?? "").trim();
  if (!s) return fallback;
  return s.slice(0, max);
}

function validateEmail(email) {
  if (!email) return "";
  const s = String(email).trim();
  if (!s) return "";
  if (s.length > 120) {
    throw Object.assign(new Error("Email is too long"), { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    throw Object.assign(new Error("Invalid email address"), { status: 400 });
  }
  return s;
}

function mapRow(row) {
  const taxRateBps = Number(row.tax_rate_bps || 0);
  return {
    shopId: row.shop_id,
    displayName: row.display_name,
    legalName: row.legal_name || "",
    addressText: row.address_text || "",
    city: row.city || "",
    country: row.country || "",
    phone: row.phone || "",
    phoneSecondary: row.phone_secondary || "",
    whatsapp: row.whatsapp || "",
    email: row.email || "",
    registrationNumber: row.registration_number || "",
    logoFilename: row.logo_filename || null,
    logoUrl: row.logo_filename
      ? `/v1/shop-logo/${encodeURIComponent(row.logo_filename)}`
      : null,

    currencyCode: row.currency_code,
    currencyLabel: row.currency_label,
    currencyDecimals: Number(row.currency_decimals),

    cloudClientId: row.cloud_client_id || "",
    cloudBridgeEnabled: Boolean(Number(row.cloud_bridge_enabled || 0)),
    cloudBridgeUrl: row.cloud_bridge_url || "",

    taxEnabled: flag(row, "tax_enabled", 0),
    taxName: row.tax_name || "VAT",
    taxRateBps,
    taxRatePercent: formatTaxPercentFromBps(taxRateBps),
    taxMode: row.tax_mode === "inclusive" ? "inclusive" : "exclusive",
    taxRegistrationNumber: row.tax_registration_number || "",

    timezone: row.timezone || "UTC",
    dateFormat: row.date_format || "YYYY-MM-DD",

    receipt: {
      showDisplayName: flag(row, "receipt_show_display_name", 1),
      showLegalName: flag(row, "receipt_show_legal_name", 0),
      showAddress: flag(row, "receipt_show_address", 1),
      showPhone: flag(row, "receipt_show_phone", 1),
      showWhatsapp: flag(row, "receipt_show_whatsapp", 1),
      showTaxName: flag(row, "receipt_show_tax_name", 1),
      showTaxNumber: flag(row, "receipt_show_tax_number", 1),
      showRegistration: flag(row, "receipt_show_registration", 0),
      showLogo: flag(row, "receipt_show_logo", 1),
      footer: row.receipt_footer ?? "Thank you! Visit again.",
    },

    instructionModifiers: parseJsonArray(row.instruction_modifiers_json, [
      "Less",
      "More",
      "No",
      "Extra",
    ]),
    instructionTargets: parseJsonArray(row.instruction_targets_json, [
      "Sugar",
      "Sauce",
      "Onion",
      "Salt",
      "Ice",
      "Cheese",
    ]),

    // Internal shape for formatters
    currency_code: row.currency_code,
    currency_label: row.currency_label,
    currency_decimals: Number(row.currency_decimals),
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

function countMonetaryRecords(db) {
  const orders = db.prepare(`SELECT COUNT(*) AS c FROM orders`).get().c;
  const items = db.prepare(`SELECT COUNT(*) AS c FROM menu_items`).get().c;
  let addons = 0;
  try {
    addons = db.prepare(`SELECT COUNT(*) AS c FROM addons`).get().c;
  } catch {
    addons = 0;
  }
  return { orders, items, addons, total: orders + items + addons };
}

export function getShopSettings(shopId = DEFAULT_SHOP_ID) {
  const db = getDb();
  let row = db
    .prepare(`SELECT * FROM shop_settings WHERE shop_id = ?`)
    .get(shopId);
  if (!row) {
    const ts = nowIso();
    db.prepare(
      `INSERT INTO shop_settings (
         shop_id, display_name, currency_code, currency_label, currency_decimals,
         instruction_modifiers_json, instruction_targets_json, created_at, updated_at
       ) VALUES (?, 'GTCT Restaurant', 'QAR', 'QR', 2,
         '["Less","More","No","Extra"]',
         '["Sugar","Sauce","Onion","Salt","Ice","Cheese"]', ?, ?)`
    ).run(shopId, ts, ts);
    row = db
      .prepare(`SELECT * FROM shop_settings WHERE shop_id = ?`)
      .get(shopId);
  }
  return mapRow(row);
}

function boolInput(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return Boolean(v);
}

/**
 * Admin update of shop settings. Currency code/decimals blocked when monetary
 * records exist (no silent conversion/relabel).
 */
export function updateShopSettings(shopId, input = {}, { role = "admin" } = {}) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin role required"), { status: 403 });
  }
  const existing = getShopSettings(shopId);
  const db = getDb();
  const ts = nowIso();

  let currencyCode = existing.currencyCode;
  let currencyLabel = existing.currencyLabel;
  let currencyDecimals = existing.currencyDecimals;

  if (input.currencyPreset && PRESETS[String(input.currencyPreset).toUpperCase()]) {
    const p = PRESETS[String(input.currencyPreset).toUpperCase()];
    currencyCode = p.currency_code;
    currencyLabel = p.currency_label;
    currencyDecimals = p.currency_decimals;
  }

  if (input.currencyCode != null) {
    currencyCode =
      String(input.currencyCode).trim().toUpperCase() || currencyCode;
  }
  if (input.currencyLabel != null) {
    currencyLabel = String(input.currencyLabel).trim() || currencyLabel;
  }
  if (input.currencyDecimals != null && input.currencyDecimals !== "") {
    currencyDecimals = Number(input.currencyDecimals);
    if (![0, 1, 2, 3, 4].includes(currencyDecimals)) {
      throw Object.assign(new Error("currencyDecimals must be 0–4"), {
        status: 400,
      });
    }
  }

  const currencyChanged =
    currencyCode !== existing.currencyCode ||
    currencyDecimals !== existing.currencyDecimals;
  if (currencyChanged) {
    const counts = countMonetaryRecords(db);
    // Hard block once orders exist — historical money must not be relabeled.
    if (counts.orders > 0) {
      throw Object.assign(
        new Error(
          `Currency/precision cannot change while orders exist (${counts.orders}). ` +
            `Changing currency does not convert amounts. Historical order snapshots stay frozen.`
        ),
        { status: 409, code: "CURRENCY_LOCKED_ORDERS" }
      );
    }
    // Menu/add-ons present: require explicit confirmation (no silent relabel).
    if (
      (counts.items > 0 || counts.addons > 0) &&
      !input.confirmCurrencyChange
    ) {
      throw Object.assign(
        new Error(
          `Currency/precision change requires confirmCurrencyChange=true because ` +
            `menu/add-on prices exist (items=${counts.items}, addons=${counts.addons}). ` +
            `Amounts are not converted — only the display currency/precision changes.`
        ),
        { status: 409, code: "CURRENCY_CONFIRM_REQUIRED" }
      );
    }
  }

  const displayName =
    input.displayName != null
      ? clampStr(input.displayName, 120)
      : existing.displayName;
  if (!displayName) {
    throw Object.assign(new Error("Shop display name is required"), {
      status: 400,
    });
  }

  const legalName =
    input.legalName != null
      ? clampStr(input.legalName, 160)
      : existing.legalName;
  const addressText =
    input.addressText != null
      ? clampStr(input.addressText, 500)
      : existing.addressText;
  const city =
    input.city != null ? clampStr(input.city, 80) : existing.city;
  const country =
    input.country != null ? clampStr(input.country, 80) : existing.country;
  const phone =
    input.phone != null ? clampStr(input.phone, 40) : existing.phone;
  const phoneSecondary =
    input.phoneSecondary != null
      ? clampStr(input.phoneSecondary, 40)
      : existing.phoneSecondary;
  const whatsapp =
    input.whatsapp != null ? clampStr(input.whatsapp, 40) : existing.whatsapp;
  const email =
    input.email != null
      ? validateEmail(input.email)
      : existing.email;
  const registrationNumber =
    input.registrationNumber != null
      ? clampStr(input.registrationNumber, 80)
      : existing.registrationNumber;

  let taxEnabled = existing.taxEnabled;
  if (input.taxEnabled != null) taxEnabled = boolInput(input.taxEnabled, false);

  let taxName = existing.taxName;
  if (input.taxName != null) {
    taxName = clampStr(input.taxName, 40, "VAT") || "VAT";
  }

  let taxMode = existing.taxMode;
  if (input.taxMode != null) {
    const m = String(input.taxMode).trim().toLowerCase();
    if (!TAX_MODES.includes(m)) {
      throw Object.assign(
        new Error("taxMode must be exclusive or inclusive"),
        { status: 400 }
      );
    }
    taxMode = m;
  }

  let taxRateBps = existing.taxRateBps;
  if (input.taxRateBps != null && input.taxRateBps !== "") {
    taxRateBps = assertTaxRateBps(input.taxRateBps);
  } else if (input.taxRatePercent != null && input.taxRatePercent !== "") {
    taxRateBps = parseTaxPercentInput(input.taxRatePercent);
  }

  if (taxEnabled && taxRateBps < 0) {
    throw Object.assign(new Error("Tax rate cannot be negative"), {
      status: 400,
    });
  }
  if (taxEnabled && !taxName) {
    throw Object.assign(new Error("Tax name is required when tax is enabled"), {
      status: 400,
    });
  }

  const taxRegistrationNumber =
    input.taxRegistrationNumber != null
      ? clampStr(input.taxRegistrationNumber, 80)
      : existing.taxRegistrationNumber;

  let timezone = existing.timezone;
  if (input.timezone != null) {
    timezone = clampStr(input.timezone, 64, "UTC") || "UTC";
    // Soft check — accept IANA-like strings; do not require full Intl database.
    if (!/^[A-Za-z0-9_+\-/]+$/.test(timezone)) {
      throw Object.assign(new Error("Invalid timezone identifier"), {
        status: 400,
      });
    }
  }

  let dateFormat = existing.dateFormat;
  if (input.dateFormat != null) {
    dateFormat = String(input.dateFormat).trim();
    if (!DATE_FORMATS.has(dateFormat)) {
      throw Object.assign(
        new Error(
          `dateFormat must be one of: ${[...DATE_FORMATS].join(", ")}`
        ),
        { status: 400 }
      );
    }
  }

  const receiptIn = input.receipt || {};
  const receipt = {
    showDisplayName: boolInput(
      receiptIn.showDisplayName ?? input.receiptShowDisplayName,
      existing.receipt.showDisplayName
    ),
    showLegalName: boolInput(
      receiptIn.showLegalName ?? input.receiptShowLegalName,
      existing.receipt.showLegalName
    ),
    showAddress: boolInput(
      receiptIn.showAddress ?? input.receiptShowAddress,
      existing.receipt.showAddress
    ),
    showPhone: boolInput(
      receiptIn.showPhone ?? input.receiptShowPhone,
      existing.receipt.showPhone
    ),
    showWhatsapp: boolInput(
      receiptIn.showWhatsapp ?? input.receiptShowWhatsapp,
      existing.receipt.showWhatsapp
    ),
    showTaxName: boolInput(
      receiptIn.showTaxName ?? input.receiptShowTaxName,
      existing.receipt.showTaxName
    ),
    showTaxNumber: boolInput(
      receiptIn.showTaxNumber ?? input.receiptShowTaxNumber,
      existing.receipt.showTaxNumber
    ),
    showRegistration: boolInput(
      receiptIn.showRegistration ?? input.receiptShowRegistration,
      existing.receipt.showRegistration
    ),
    showLogo: boolInput(
      receiptIn.showLogo ?? input.receiptShowLogo,
      existing.receipt.showLogo
    ),
    footer:
      receiptIn.footer != null || input.receiptFooter != null
        ? clampStr(
            receiptIn.footer ?? input.receiptFooter,
            240,
            "Thank you! Visit again."
          )
        : existing.receipt.footer,
  };

  let modifiers = existing.instructionModifiers;
  let targets = existing.instructionTargets;
  if (Array.isArray(input.instructionModifiers)) {
    modifiers = [
      ...new Set(
        input.instructionModifiers.map((v) => String(v).trim()).filter(Boolean)
      ),
    ];
  }
  if (Array.isArray(input.instructionTargets)) {
    targets = [
      ...new Set(
        input.instructionTargets.map((v) => String(v).trim()).filter(Boolean)
      ),
    ];
  }

  db.prepare(
    `UPDATE shop_settings SET
       display_name = ?,
       legal_name = ?,
       address_text = ?,
       city = ?,
       country = ?,
       phone = ?,
       phone_secondary = ?,
       whatsapp = ?,
       email = ?,
       registration_number = ?,
       currency_code = ?,
       currency_label = ?,
       currency_decimals = ?,
       tax_enabled = ?,
       tax_name = ?,
       tax_rate_bps = ?,
       tax_mode = ?,
       tax_registration_number = ?,
       timezone = ?,
       date_format = ?,
       receipt_show_display_name = ?,
       receipt_show_legal_name = ?,
       receipt_show_address = ?,
       receipt_show_phone = ?,
       receipt_show_whatsapp = ?,
       receipt_show_tax_name = ?,
       receipt_show_tax_number = ?,
       receipt_show_registration = ?,
       receipt_show_logo = ?,
       receipt_footer = ?,
       instruction_modifiers_json = ?,
       instruction_targets_json = ?,
       updated_at = ?
     WHERE shop_id = ?`
  ).run(
    displayName,
    legalName,
    addressText,
    city,
    country,
    phone,
    phoneSecondary,
    whatsapp,
    email,
    registrationNumber,
    currencyCode,
    currencyLabel,
    currencyDecimals,
    taxEnabled ? 1 : 0,
    taxName,
    taxRateBps,
    taxMode,
    taxRegistrationNumber,
    timezone,
    dateFormat,
    receipt.showDisplayName ? 1 : 0,
    receipt.showLegalName ? 1 : 0,
    receipt.showAddress ? 1 : 0,
    receipt.showPhone ? 1 : 0,
    receipt.showWhatsapp ? 1 : 0,
    receipt.showTaxName ? 1 : 0,
    receipt.showTaxNumber ? 1 : 0,
    receipt.showRegistration ? 1 : 0,
    receipt.showLogo ? 1 : 0,
    receipt.footer,
    JSON.stringify(modifiers),
    JSON.stringify(targets),
    ts,
    shopId
  );

  if (
    Object.prototype.hasOwnProperty.call(input, "cloudClientId") ||
    Object.prototype.hasOwnProperty.call(input, "cloudBridgeEnabled") ||
    Object.prototype.hasOwnProperty.call(input, "cloudBridgeUrl")
  ) {
    const cloudClientId =
      input.cloudClientId != null
        ? String(input.cloudClientId).trim()
        : existing.cloudClientId || "";
    const cloudBridgeEnabled =
      input.cloudBridgeEnabled != null
        ? boolInput(input.cloudBridgeEnabled, false)
        : Boolean(existing.cloudBridgeEnabled);
    const cloudBridgeUrl =
      input.cloudBridgeUrl != null
        ? String(input.cloudBridgeUrl).trim()
        : existing.cloudBridgeUrl || "";
    db.prepare(
      `UPDATE shop_settings SET
         cloud_client_id = ?,
         cloud_bridge_enabled = ?,
         cloud_bridge_url = ?,
         updated_at = ?
       WHERE shop_id = ?`
    ).run(
      cloudClientId,
      cloudBridgeEnabled ? 1 : 0,
      cloudBridgeUrl,
      ts,
      shopId
    );
  }

  return getShopSettings(shopId);
}

/** Diff of sensitive fields for audit logging. */
export function shopSettingsAuditDetail(before, after) {
  const keys = [
    "displayName",
    "legalName",
    "currencyCode",
    "currencyLabel",
    "currencyDecimals",
    "taxEnabled",
    "taxName",
    "taxRateBps",
    "taxMode",
    "taxRegistrationNumber",
    "registrationNumber",
    "timezone",
    "dateFormat",
  ];
  const changed = {};
  for (const k of keys) {
    if (before[k] !== after[k]) {
      changed[k] = { from: before[k], to: after[k] };
    }
  }
  if (JSON.stringify(before.receipt) !== JSON.stringify(after.receipt)) {
    changed.receipt = { to: after.receipt };
  }
  return changed;
}

export function applyEnvShopOverrides(shop, config) {
  const code = String(process.env.GTCT_SHOP_CURRENCY || "").trim().toUpperCase();
  const label = String(process.env.GTCT_SHOP_CURRENCY_LABEL || "").trim();
  const decimalsRaw = process.env.GTCT_SHOP_CURRENCY_DECIMALS;
  const out = { ...shop };
  if (code) out.currencyCode = code;
  if (label) out.currencyLabel = label;
  if (decimalsRaw != null && String(decimalsRaw).trim() !== "") {
    const d = Number(decimalsRaw);
    if ([0, 1, 2, 3, 4].includes(d)) out.currencyDecimals = d;
  }
  out.currency_code = out.currencyCode;
  out.currency_label = out.currencyLabel;
  out.currency_decimals = out.currencyDecimals;
  out.shopId = config?.testTenantId || shop.shopId;
  return out;
}

export { DEFAULT_SHOP_ID, PRESETS, DATE_FORMATS };
