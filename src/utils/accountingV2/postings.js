// src/utils/accountingV2/postings.js
import { _num, _date } from "./normalize.js";

function monthKey(yyyyMmDd) {
  if (!yyyyMmDd) return "";
  return yyyyMmDd.slice(0, 7); // YYYY-MM
}

function stableKey(parts) {
  return parts.filter(Boolean).join("|");
}

/**
 * DISCOUNT VIRTUAL POSTING
 * Accounting rule:
 * - Discount Allowed  => Expense  (customer side)
 * - Discount Received => Income   (supplier side)
 *
 * IMPORTANT: No assumptions.
 * We only post IF discountSide is explicitly present.
 */
export function deriveDiscountPostings(tx) {
  const d = tx?.discount || {};
  const amt = _num(d.amount);
  if (!(amt > 0)) return [];

  const side = String(d.discountSide || "").toLowerCase();
  if (side !== "customer" && side !== "supplier") return [];

  const posting =
    side === "customer"
      ? { txType: "expense", category: "discount_allowed" }
      : { txType: "income", category: "discount_received" };

  return [
    {
      id: "",
      date: tx.date,
      amount: amt,
      txType: posting.txType,
      category: posting.category,
      mode: "system",
      partyType: tx.partyType,
      partyName: tx.partyName,
      source: "system",
      systemKey: stableKey(["disc", tx.id, tx.date, side, d.discountType, String(amt)]),
      meta: {
        refTxId: tx.id,
        discountType: d.discountType || "",
        discountSide: side,
      },
    },
  ];
}

/**
 * ASSET ACQUISITIONS
 * - If category == "long-term asset" => treat as Asset, NOT Expense
 * - No assumptions: if tx.asset missing, we still create a derived record.
 */
export function deriveAssetRegister(normalizedAllTxns) {
  const assets = [];
  for (const tx of normalizedAllTxns || []) {
    if ((tx.category || "").toLowerCase() !== "long-term asset") continue;

    const assetValue = _num(tx.asset?.assetValue ?? tx.amount);
    const usefulLifeMonths = _num(tx.asset?.usefulLifeMonths);

    assets.push({
      assetId:
        tx.asset?.assetId ||
        stableKey(["asset", tx.id || "", tx.date || "", tx.partyName || "", String(assetValue)]),
      assetName: String(tx.asset?.assetName || tx.__raw?.description || tx.__raw?.category || "Asset").trim(),
      purchaseDate: _date(tx.asset?.purchaseDate) || tx.date,
      assetValue,
      usefulLifeMonths: usefulLifeMonths > 0 ? usefulLifeMonths : 0,
      method: String(tx.asset?.method || "straight_line").toLowerCase(),
      refTxId: tx.id,
    });
  }
  return assets;
}

/**
 * DEPRECIATION (virtual monthly)
 * - Straight line
 * - Type: expense
 * - Category: depreciation
 * - Mode: system
 * - NOT cashflow (system)
 *
 * No assumptions:
 * - If usefulLifeMonths missing/0 => skip depreciation for that asset.
 * - Posting date = YYYY-MM-01 for the month.
 */
export function deriveDepreciationPostings({ assets, rangeStart, rangeEnd }) {
  const out = [];
  const startMK = monthKey(rangeStart);
  const endMK = monthKey(rangeEnd);
  if (!startMK || !endMK) return out;

  function* monthsBetween(a, b) {
    const [ay, am] = a.split("-").map(Number);
    const [by, bm] = b.split("-").map(Number);
    let y = ay, m = am;
    while (y < by || (y === by && m <= bm)) {
      yield `${y}-${String(m).padStart(2, "0")}`;
      m += 1;
      if (m === 13) { m = 1; y += 1; }
    }
  }

  for (const a of assets || []) {
    const life = _num(a.usefulLifeMonths);
    if (!(life > 0)) continue;

    const purchaseMK = monthKey(a.purchaseDate);
    if (!purchaseMK) continue;

    const depPerMonth = _num(a.assetValue) / life;

    let count = 0;
    for (const mk of monthsBetween(startMK, endMK)) {
      if (mk < purchaseMK) continue;
      if (count >= life) break;

      out.push({
        id: "",
        date: `${mk}-01`,
        amount: depPerMonth,
        txType: "expense",
        category: "depreciation",
        mode: "system",
        partyType: "other",
        partyName: a.assetName,
        source: "system",
        systemKey: stableKey(["dep", a.assetId, mk, String(life), String(a.assetValue)]),
        meta: {
          assetId: a.assetId,
          assetName: a.assetName,
          depreciationMonth: mk,
          depreciationPerMonth: depPerMonth,
          method: a.method || "straight_line",
        },
      });

      count += 1;
    }
  }

  return out;
}
