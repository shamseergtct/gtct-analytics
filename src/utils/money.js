/**
 * Currency amount helpers — decimals are per-business (client), not hardcoded.
 *
 * Examples:
 *   INR / AED / USD → 2 → 1.00
 *   BHD / KWD / OMR → 3 → 1.000
 *   JPY             → 0 → 1
 */

const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL = new Set([
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
]);

export const MIN_CURRENCY_DECIMALS = 0;
export const MAX_CURRENCY_DECIMALS = 4;
export const DEFAULT_CURRENCY_DECIMALS = 2;

/** Runtime default for the active shop (set by ClientContext). */
let activeCurrencyDecimals = DEFAULT_CURRENCY_DECIMALS;

export function setActiveCurrencyDecimals(decimals) {
  activeCurrencyDecimals = clampCurrencyDecimals(
    decimals,
    DEFAULT_CURRENCY_DECIMALS
  );
  return activeCurrencyDecimals;
}

export function getActiveCurrencyDecimals() {
  return activeCurrencyDecimals;
}

function resolvedDecimals(decimals) {
  if (decimals === undefined || decimals === null || decimals === "") {
    return activeCurrencyDecimals;
  }
  return clampCurrencyDecimals(decimals, activeCurrencyDecimals);
}

export function normalizeCurrencyCode(currency) {
  return String(currency || "")
    .trim()
    .toUpperCase();
}

/** ISO-style default fraction digits for a currency code. */
export function defaultDecimalsForCurrency(currency) {
  const code = normalizeCurrencyCode(currency);
  if (!code) return DEFAULT_CURRENCY_DECIMALS;
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return DEFAULT_CURRENCY_DECIMALS;
}

export function clampCurrencyDecimals(value, fallback = DEFAULT_CURRENCY_DECIMALS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(
    MAX_CURRENCY_DECIMALS,
    Math.max(MIN_CURRENCY_DECIMALS, Math.round(n))
  );
}

/**
 * Resolve decimals from a client doc, explicit override, and/or currency code.
 * Priority: explicit currencyDecimals on client → override arg → currency default.
 */
export function resolveCurrencyDecimals(source, fallbackCurrency) {
  if (typeof source === "number" || typeof source === "string") {
    // Called as resolveCurrencyDecimals(decimals) or resolveCurrencyDecimals(currencyCode)
    const asNum = Number(source);
    if (Number.isFinite(asNum) && String(source).trim() !== "" && !/[A-Za-z]/.test(String(source))) {
      return clampCurrencyDecimals(asNum);
    }
    return defaultDecimalsForCurrency(source || fallbackCurrency);
  }

  const client = source && typeof source === "object" ? source : null;
  if (client && client.currencyDecimals != null && client.currencyDecimals !== "") {
    return clampCurrencyDecimals(
      client.currencyDecimals,
      defaultDecimalsForCurrency(client.currency || fallbackCurrency)
    );
  }

  return defaultDecimalsForCurrency(
    client?.currency || fallbackCurrency || ""
  );
}

export function numMoney(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Round half-up to the business currency precision. */
export function roundMoney(amount, decimals) {
  const d = resolvedDecimals(decimals);
  const n = numMoney(amount);
  if (d === 0) return Math.round(n);
  const factor = 10 ** d;
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

/** Fixed-fraction display string (no thousands separators). */
export function formatMoney(amount, decimals) {
  const d = resolvedDecimals(decimals);
  return roundMoney(amount, d).toFixed(d);
}

/** Locale display with fixed fraction digits (reports / hints). */
export function formatMoneyLocale(amount, decimals) {
  const d = resolvedDecimals(decimals);
  return roundMoney(amount, d).toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

/** Convert to integer minor units for exact equality checks. */
export function toMinorUnits(amount, decimals) {
  const d = resolvedDecimals(decimals);
  return Math.round(numMoney(amount) * 10 ** d);
}

/** HTML number input step for the currency. */
export function moneyInputStep(decimals) {
  const d = resolvedDecimals(decimals);
  if (d <= 0) return "1";
  return (1 / 10 ** d).toFixed(d);
}

/** Preview string shown in setup UI, e.g. "1.000". */
export function moneyPreviewSample(decimals) {
  return formatMoney(1, resolvedDecimals(decimals));
}
