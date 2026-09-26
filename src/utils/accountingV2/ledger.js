// src/utils/accountingV2/ledger.js
import { normalizeMany, _num } from "./normalize.js";
import { deriveDiscountPostings, deriveAssetRegister, deriveDepreciationPostings } from "./postings.js";

function inRange(d, start, end) {
  if (!d) return false;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

function sum(list, pick) {
  let s = 0;
  for (const x of list || []) s += _num(pick(x));
  return s;
}

function mapBaseToLedger(tx) {
  // Map normalized LIVE tx => unified ledger line
  // No assumptions: we only map what exists.
  let txType = "expense";
  // LIVE: sales/receipt/income are inflow; purchase/payment/expense are outflow
  if (tx.type === "sales" || tx.type === "receipt" || tx.type === "income") txType = "income";
  if (tx.type === "purchase" || tx.type === "payment" || tx.type === "expense") txType = "expense";

  return {
    id: tx.id,
    date: tx.date,
    amount: tx.amount,
    txType,
    category: tx.category || "",
    mode: tx.mode || "",
    partyType: tx.partyType || "other",
    partyName: tx.partyName || "",
    source: "user",
    systemKey: "",
    meta: {
      type: tx.type,
      amountIn: tx.amountIn,
      amountOut: tx.amountOut,
      categoryRaw: tx.categoryRaw,
      discount: tx.discount,
      asset: tx.asset,
      __raw: tx.__raw,
    },
  };
}

/**
 * Build unified ledger (base + virtual postings)
 * SAFE: base transactions never altered.
 */
export function buildLedger({
  rawTransactions,
  rangeStart,
  rangeEnd,
  includeVirtualDiscount = true,
  includeVirtualDepreciation = true,
}) {
  const all = normalizeMany(rawTransactions || []);
  const baseRange = all.filter((t) => inRange(t.date, rangeStart, rangeEnd));
  const baseLedger = baseRange.map(mapBaseToLedger);

  const discountPosts = [];
  if (includeVirtualDiscount) {
    for (const t of baseRange) discountPosts.push(...deriveDiscountPostings(t));
  }

  const assets = deriveAssetRegister(all);

  const depreciationPosts = includeVirtualDepreciation
    ? deriveDepreciationPostings({ assets, rangeStart, rangeEnd })
    : [];

  // IMPORTANT: long-term asset purchase must NOT inflate expense
  // We do NOT delete it (no data loss). We keep it in baseLedger but you can exclude in reports.
  const ledger = [...baseLedger, ...discountPosts, ...depreciationPosts];

  const income = sum(ledger.filter((x) => x.txType === "income"), (x) => x.amount);

  const expense = sum(
    ledger.filter(
      (x) =>
        x.txType === "expense" &&
        String(x.category || "").toLowerCase() !== "long-term asset"
    ),
    (x) => x.amount
  );

  return {
    ledger,
    base: baseLedger,
    virtual: { discountPosts, depreciationPosts },
    registers: { assets },
    totals: {
      income,
      expense,
      profit: income - expense,
    },
  };
}
