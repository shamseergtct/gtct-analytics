/**
 * Shop-level delivery charge presets (client_settings).
 * Dropdown always includes "None" (0); configurable amounts + default live in settings.
 */
import { formatMoney, numMoney, roundMoney } from "./money.js";

export const DEFAULT_DELIVERY_CHARGE_OPTIONS = [0.1, 0.2, 0.3];
export const DEFAULT_DELIVERY_CHARGE = 0.1;

function uniqueSortedAmounts(amounts, decimals) {
  const seen = new Set();
  const out = [];
  for (const raw of amounts || []) {
    const n = roundMoney(numMoney(raw), decimals);
    if (!Number.isFinite(n) || n < 0) continue;
    // "None" is always offered separately; skip storing zero in the options list.
    if (n === 0) continue;
    const key = formatMoney(n, decimals);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Normalize settings from Firestore (or defaults when missing).
 * @returns {{ options: number[], defaultCharge: number }}
 */
export function normalizeDeliveryChargeSettings(
  data = null,
  currencyDecimals = 3
) {
  const fromDoc = Array.isArray(data?.deliveryChargeOptions)
    ? data.deliveryChargeOptions
    : null;
  const options = uniqueSortedAmounts(
    fromDoc && fromDoc.length
      ? fromDoc
      : DEFAULT_DELIVERY_CHARGE_OPTIONS,
    currencyDecimals
  );

  let defaultCharge = roundMoney(
    data?.defaultDeliveryCharge != null && data?.defaultDeliveryCharge !== ""
      ? numMoney(data.defaultDeliveryCharge)
      : DEFAULT_DELIVERY_CHARGE,
    currencyDecimals
  );
  if (!Number.isFinite(defaultCharge) || defaultCharge < 0) {
    defaultCharge = roundMoney(DEFAULT_DELIVERY_CHARGE, currencyDecimals);
  }
  // Default must be None (0) or one of the configured amounts.
  if (defaultCharge !== 0) {
    const match = options.find(
      (amount) =>
        formatMoney(amount, currencyDecimals) ===
        formatMoney(defaultCharge, currencyDecimals)
    );
    defaultCharge = match != null
      ? match
      : options[0] != null
        ? options[0]
        : 0;
  }

  return { options, defaultCharge };
}

/** Select value string for a charge amount ("" for None / 0). */
export function deliveryChargeSelectValue(amount, currencyDecimals = 3) {
  const n = roundMoney(numMoney(amount), currencyDecimals);
  if (!n) return "";
  return formatMoney(n, currencyDecimals);
}

/** Parse select value back to a number. */
export function parseDeliveryChargeSelectValue(value) {
  if (value === "" || value == null) return 0;
  return numMoney(value);
}

/**
 * Options for a <select>: None + configured amounts (+ extra if editing an
 * amount that is no longer in settings).
 */
export function buildDeliveryChargeSelectOptions({
  options = DEFAULT_DELIVERY_CHARGE_OPTIONS,
  currencyDecimals = 3,
  includeAmount = null,
  currency = "",
} = {}) {
  const amounts = uniqueSortedAmounts(options, currencyDecimals);
  if (includeAmount != null && includeAmount !== "") {
    const extra = roundMoney(numMoney(includeAmount), currencyDecimals);
    if (extra > 0) {
      const key = formatMoney(extra, currencyDecimals);
      if (!amounts.some((a) => formatMoney(a, currencyDecimals) === key)) {
        amounts.push(extra);
        amounts.sort((a, b) => a - b);
      }
    }
  }

  const suffix = currency ? ` ${currency}` : "";
  return [
    { value: "", label: "None", amount: 0 },
    ...amounts.map((amount) => {
      const value = formatMoney(amount, currencyDecimals);
      return {
        value,
        label: `${value}${suffix}`,
        amount,
      };
    }),
  ];
}

export function formatDeliveryChargeDefaultLabel(
  defaultCharge,
  currencyDecimals = 3,
  currency = ""
) {
  const n = roundMoney(numMoney(defaultCharge), currencyDecimals);
  if (!n) return "None";
  const money = formatMoney(n, currencyDecimals);
  return currency ? `${money} ${currency}` : money;
}
