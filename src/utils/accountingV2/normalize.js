// src/utils/accountingV2/normalize.js

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v) {
  return String(v ?? "").trim();
}

function toYYYYMMDDFromAnyDate(d) {
  try {
    if (!d) return "";
    // Firestore Timestamp
    if (d?.toDate && d.toDate() instanceof Date) return d.toDate().toISOString().slice(0, 10);
    // JS Date
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    // string "YYYY-MM-DD" or ISO
    if (typeof d === "string") return d.slice(0, 10);
    // number
    if (typeof d === "number") return new Date(d).toISOString().slice(0, 10);
    return "";
  } catch {
    return "";
  }
}

function normalizeMode(m) {
  const x = str(m).toLowerCase();
  if (!x) return "";
  if (x.startsWith("cas")) return "cash";
  if (x.startsWith("ban")) return "bank";
  if (x.startsWith("car")) return "bank"; // card -> bank
  if (x.startsWith("upi")) return "bank";
  if (x.startsWith("cre")) return "credit";
  if (x.startsWith("sys")) return "system";
  return x;
}

function normalizeType(t) {
  const x = str(t).toLowerCase();
  if (!x) return "";
  if (x.startsWith("sal")) return "sales";
  if (x.startsWith("rec")) return "receipt";
  if (x.startsWith("inc")) return "income";
  if (x.startsWith("pur")) return "purchase";
  if (x.startsWith("pay")) return "payment";
  if (x.startsWith("exp")) return "expense";
  return x;
}

// PartyType: your LIVE values are "Customer/Supplier/Both" (case sensitive)
// We convert to safe keys, but never assume new ones exist.
function normalizePartyType(pt) {
  const x = str(pt);
  if (!x) return "other";
  if (x.toLowerCase() === "customer") return "customer";
  if (x.toLowerCase() === "supplier") return "supplier";
  if (x.toLowerCase() === "both") return "both";

  // Phase-2: allow new
  if (x.toLowerCase().includes("employee")) return "employee";
  if (x.toLowerCase().includes("owner") || x.toLowerCase().includes("partner")) return "owner_partner";

  return "other";
}

/**
 * Normalize LIVE transaction shape (your current Firestore docs)
 * Expected current fields:
 * - type, mode, partyType, partyName, category, description, date
 * - amountIn, amountOut
 *
 * Phase-2 optional fields (if UI adds later):
 * - discountPct, discountAmount, discountType, discountSide
 * - asset: { assetId, assetName, assetValue, usefulLifeMonths, purchaseDate, method }
 */
export function normalizeTx(raw) {
  const r = raw || {};

  const id = str(r.id);
  const date = toYYYYMMDDFromAnyDate(r.date);

  const type = normalizeType(r.type);
  const mode = normalizeMode(r.mode);

  const partyType = normalizePartyType(r.partyType);
  const partyName = str(r.partyName || r.description || "");

  const categoryRaw = str(r.category);
  const category = categoryRaw ? categoryRaw.toLowerCase() : "";

  const amountIn = num(r.amountIn);
  const amountOut = num(r.amountOut);
  const amount = amountOut > 0 ? amountOut : amountIn;

  // Discount fields (optional — no assumptions)
  const discountPct = num(r.discountPct);
  const discountAmount = num(r.discountAmount);
  const discountType = str(r.discountType).toLowerCase();   // invoice / settlement
  const discountSide = str(r.discountSide).toLowerCase();   // customer / supplier

  // Asset block (optional)
  const asset = r.asset ? { ...r.asset } : null;

  return {
    __raw: r, // zero data loss
    id,
    date,
    type,
    mode,
    partyType,
    partyName,
    category,          // lowercase for internal comparisons
    categoryRaw,       // keep original
    amountIn,
    amountOut,
    amount,

    discount: {
      pct: discountPct,
      amount: discountAmount,
      discountType,
      discountSide,
    },

    asset,
  };
}

export function normalizeMany(list) {
  return Array.isArray(list) ? list.map(normalizeTx) : [];
}

export const _num = num;
export const _date = toYYYYMMDDFromAnyDate;
