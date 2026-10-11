import { numMoney, roundMoney } from "./money.js";
import { STOCK_USAGE_SOURCE } from "./inventoryStockUsage.js";

/**
 * Aggregate STOCK_USAGE movements into one row per item for a business date.
 * Prefers movement unitCost/amount snapshots; falls back to live inventory cost.
 */
export function buildDailyInventoryExpenseRows({
  movements = [],
  inventoryById = new Map(),
  currencyDecimals = 3,
} = {}) {
  const byItem = new Map();

  for (const row of movements) {
    if (String(row?.source || "") !== STOCK_USAGE_SOURCE) continue;
    const itemId = String(row.itemId || "").trim();
    if (!itemId) continue;

    const inv = inventoryById.get(itemId) || {};
    const qty = numMoney(row.qty);
    const unitCost =
      row.unitCost != null
        ? Math.max(0, numMoney(row.unitCost))
        : Math.max(0, numMoney(inv.cost));
    const amount =
      row.amount != null
        ? Math.max(0, numMoney(row.amount))
        : roundMoney(qty * unitCost, currencyDecimals);

    if (!byItem.has(itemId)) {
      byItem.set(itemId, {
        itemId,
        itemCode: String(row.itemCode || inv.itemCode || "").trim(),
        itemName: String(row.itemName || inv.itemName || "").trim() || "—",
        qty: 0,
        amount: 0,
        unitCost,
        movementCount: 0,
      });
    }

    const agg = byItem.get(itemId);
    agg.qty = roundMoney(agg.qty + qty, currencyDecimals);
    agg.amount = roundMoney(agg.amount + amount, currencyDecimals);
    agg.movementCount += 1;
    // Weighted average unit cost for display when multiple lines exist.
    agg.unitCost =
      agg.qty > 0
        ? roundMoney(agg.amount / agg.qty, currencyDecimals)
        : unitCost;
    if (!agg.itemName || agg.itemName === "—") {
      agg.itemName = String(inv.itemName || row.itemName || "—").trim();
    }
    if (!agg.itemCode) {
      agg.itemCode = String(inv.itemCode || row.itemCode || "").trim();
    }
  }

  return [...byItem.values()].sort((a, b) =>
    String(a.itemName).localeCompare(String(b.itemName))
  );
}

export function sumExpenseAmount(rows = []) {
  return roundMoney(
    rows.reduce((sum, row) => sum + numMoney(row.amount), 0)
  );
}

export function sumExpenseQty(rows = []) {
  return roundMoney(rows.reduce((sum, row) => sum + numMoney(row.qty), 0));
}
