import { numMoney } from "./money.js";
import { isAttentionStatus } from "./inventoryDailyReview.js";

/** Optional stock thresholds on an inventory item (on-hand qty). */
export function normalizeAttentionThresholds(item = {}) {
  return {
    low: Math.max(0, numMoney(item.attentionLowQty)),
    urgent: Math.max(0, numMoney(item.attentionUrgentQty)),
    veryUrgent: Math.max(0, numMoney(item.attentionVeryUrgentQty)),
  };
}

export function hasAttentionThresholds(item) {
  const t = normalizeAttentionThresholds(item);
  return t.low > 0 || t.urgent > 0 || t.veryUrgent > 0;
}

/**
 * Auto status from on-hand stock vs item thresholds.
 * Most severe match wins: very urgent → urgent → low → enough (above low).
 * Returns null when no thresholds are configured.
 */
export function autoAttentionStatus(item, stockOverride) {
  if (!hasAttentionThresholds(item)) return null;
  const stock = numMoney(
    stockOverride !== undefined && stockOverride !== null
      ? stockOverride
      : item?.currentStock
  );
  const { low, urgent, veryUrgent } = normalizeAttentionThresholds(item);

  if (veryUrgent > 0 && stock <= veryUrgent) return "VERY_URGENT";
  if (urgent > 0 && stock <= urgent) return "URGENT";
  if (low > 0 && stock <= low) return "LOW";
  return "ENOUGH";
}

/** Qty to order to restock up to the highest configured threshold (usually Low). */
export function suggestedReorderQty(item, stockOverride) {
  const stock = numMoney(
    stockOverride !== undefined && stockOverride !== null
      ? stockOverride
      : item?.currentStock
  );
  const { low, urgent, veryUrgent } = normalizeAttentionThresholds(item);
  const target =
    low > 0 ? low : urgent > 0 ? urgent : veryUrgent > 0 ? veryUrgent : 0;
  if (!(target > 0)) return 0;
  return Math.max(0, numMoney(target - stock));
}

/**
 * Staff-marked status always wins when present.
 * Otherwise fall back to automatic threshold status.
 */
export function resolveAttentionStatus(item, staffLine = null, stockOverride) {
  const staffStatus = String(staffLine?.attentionStatus || "")
    .trim()
    .toUpperCase();
  if (isAttentionStatus(staffStatus)) {
    return {
      status: staffStatus,
      source: "staff",
      requestedQty: numMoney(staffLine?.requestedQty),
      notes: String(staffLine?.notes || "").trim(),
    };
  }

  const auto = autoAttentionStatus(item, stockOverride);
  if (!auto) {
    return { status: "", source: "none", requestedQty: 0, notes: "" };
  }

  return {
    status: auto,
    source: "auto",
    requestedQty: suggestedReorderQty(item, stockOverride),
    notes: "",
  };
}
