import { formatMoney, numMoney } from "./money.js";

/** Common purchase / pack unit labels (optional on items). */
export const PURCHASE_UNITS = [
  "box",
  "carton",
  "pack",
  "case",
  "bag",
  "dozen",
  "tray",
  "bundle",
];

/**
 * True when the item has a pack conversion (1 purchase unit = N base units).
 * @param {object|null|undefined} item
 */
export function hasPackConversion(item) {
  const purchaseUnit = String(item?.purchaseUnit || "").trim();
  const subQty = numMoney(item?.subQty);
  return Boolean(purchaseUnit) && subQty > 0;
}

/**
 * Unit used when ordering (purchase pack if set, else base/usage unit).
 * @param {object|null|undefined} item
 */
export function resolveOrderUnit(item) {
  const purchaseUnit = String(item?.purchaseUnit || "").trim();
  if (purchaseUnit && numMoney(item?.subQty) > 0) return purchaseUnit;
  return String(item?.baseUnit || item?.unit || "").trim();
}

/**
 * Human-readable pack hint, e.g. "1 box = 12 pcs". Empty if not configured.
 * @param {object|null|undefined} item
 */
export function formatPackHint(item) {
  if (!hasPackConversion(item)) return "";
  const purchaseUnit = String(item.purchaseUnit || "").trim();
  const subQty = numMoney(item.subQty);
  const baseUnit = String(item.baseUnit || "pcs").trim() || "pcs";
  const qtyLabel =
    Number.isInteger(subQty) || Math.abs(subQty - Math.round(subQty)) < 1e-9
      ? String(Math.round(subQty))
      : String(subQty);
  return `1 ${purchaseUnit} = ${qtyLabel} ${baseUnit}`;
}

/**
 * Snapshot pack fields onto a PO line from an inventory item.
 * @param {object|null|undefined} item
 */
export function packFieldsFromItem(item) {
  const purchaseUnit = String(item?.purchaseUnit || "").trim();
  const baseUnit = String(item?.baseUnit || "").trim();
  const subQty = numMoney(item?.subQty);
  const hasPack = Boolean(purchaseUnit) && subQty > 0;
  return {
    unit: hasPack ? purchaseUnit : baseUnit,
    baseUnit,
    purchaseUnit: hasPack ? purchaseUnit : "",
    subQty: hasPack ? subQty : 0,
  };
}

function resolveSubQty(itemOrSubQty) {
  return typeof itemOrSubQty === "object" && itemOrSubQty != null
    ? numMoney(itemOrSubQty.subQty)
    : numMoney(itemOrSubQty);
}

/** Convert purchase-unit qty → on-hand stock in base units. */
export function purchaseQtyToBaseStock(purchaseQty, itemOrSubQty) {
  const qty = numMoney(purchaseQty);
  const subQty = resolveSubQty(itemOrSubQty);
  if (!(subQty > 0)) return qty;
  return numMoney(qty * subQty);
}

/** Convert on-hand base stock → purchase-unit qty for the entry form. */
export function baseStockToPurchaseQty(baseStock, itemOrSubQty) {
  const stock = numMoney(baseStock);
  const subQty = resolveSubQty(itemOrSubQty);
  if (!(subQty > 0)) return stock;
  return numMoney(stock / subQty);
}

/**
 * Inventory `cost` is per base/stock unit. PO `unitRate` is per purchase unit.
 * Convert base cost → purchase-unit rate for PO lines.
 */
export function purchaseUnitRateFromBaseCost(baseCost, itemOrSubQty) {
  const cost = Math.max(0, numMoney(baseCost));
  const subQty = resolveSubQty(itemOrSubQty);
  if (!(subQty > 0)) return cost;
  return numMoney(cost * subQty);
}

/** Convert purchase-unit rate → base/stock unit cost for inventory. */
export function baseCostFromPurchaseUnitRate(unitRate, itemOrSubQty) {
  const rate = Math.max(0, numMoney(unitRate));
  const subQty = resolveSubQty(itemOrSubQty);
  if (!(subQty > 0)) return rate;
  return numMoney(rate / subQty);
}

/**
 * When pack settings toggle on/off, convert the qty field so the same on-hand
 * amount is preserved (purchase units ↔ base units).
 */
export function convertStockQtyForPackToggle({
  qty,
  wasPackActive,
  nextPackActive,
  fromSubQty,
  toSubQty,
}) {
  const value = numMoney(qty);
  if (!Number.isFinite(value)) return qty;
  if (wasPackActive === nextPackActive) {
    if (
      wasPackActive &&
      nextPackActive &&
      numMoney(fromSubQty) > 0 &&
      numMoney(toSubQty) > 0 &&
      Math.abs(numMoney(fromSubQty) - numMoney(toSubQty)) > 0.000001
    ) {
      const base = purchaseQtyToBaseStock(value, fromSubQty);
      return String(baseStockToPurchaseQty(base, toSubQty));
    }
    return qty;
  }
  if (wasPackActive && !nextPackActive) {
    return String(purchaseQtyToBaseStock(value, fromSubQty));
  }
  if (!wasPackActive && nextPackActive) {
    return String(baseStockToPurchaseQty(value, toSubQty));
  }
  return qty;
}

/**
 * Format on-hand stock for staff lists, including purchase equivalent when set.
 * e.g. "12.000 pcs (2.000 box)"
 */
export function formatStockDisplay(item, decimals = 3) {
  const stock = numMoney(item?.currentStock);
  const baseUnit = String(item?.baseUnit || "pcs").trim() || "pcs";
  const stockText = `${formatMoney(stock, decimals)} ${baseUnit}`;
  if (!hasPackConversion(item)) {
    return { label: stockText, packHint: "", purchaseEquiv: "" };
  }
  const purchaseQty = baseStockToPurchaseQty(stock, item);
  const purchaseUnit = String(item.purchaseUnit || "").trim();
  const purchaseText = `${formatMoney(purchaseQty, decimals)} ${purchaseUnit}`;
  return {
    label: `${stockText} (${purchaseText})`,
    packHint: formatPackHint(item),
    purchaseEquiv: purchaseText,
  };
}
