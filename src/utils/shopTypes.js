/** Business vertical / shop type for clients. */

export const DEFAULT_SHOP_TYPE = "retail";

export const SHOP_TYPE_OPTIONS = [
  { value: "retail", label: "Grocery / Stationery" },
  { value: "cafe", label: "Small Café" },
  { value: "restaurant", label: "Restaurant / F&B" },
  { value: "wholesale_retail", label: "Wholesale & Retail Hybrid" },
];

const VALID_SHOP_TYPES = new Set(SHOP_TYPE_OPTIONS.map((o) => o.value));

/** Normalize unknown/missing values to the safe default `'retail'`. */
export function normalizeShopType(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_SHOP_TYPES.has(key) ? key : DEFAULT_SHOP_TYPE;
}

export function shopTypeLabel(value) {
  const key = normalizeShopType(value);
  return SHOP_TYPE_OPTIONS.find((o) => o.value === key)?.label || key;
}
