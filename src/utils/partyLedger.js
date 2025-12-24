// src/utils/partyLedger.js
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  Timestamp,
} from "firebase/firestore";
import { db } from "../firebase";

function startOfDay(yyyyMMdd) {
  const [y, m, d] = yyyyMMdd.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function endOfDay(yyyyMMdd) {
  const [y, m, d] = yyyyMMdd.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}
function num(v) {
  return Number(v || 0);
}
function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// ✅ safer “amount” for any txn
function txnAmount(t) {
  const ai = num(t?.amountIn);
  const ao = num(t?.amountOut);
  if (ai > 0) return ai;
  if (ao > 0) return ao;
  const total = num(t?.totalAmount);
  if (total > 0) return total;
  return 0;
}

// ✅ credit purchase can be stored in amountIn OR amountOut OR totalAmount
function creditPurchaseAmount(t) {
  const ai = num(t?.amountIn);
  const ao = num(t?.amountOut);
  if (ai > 0) return ai;
  if (ao > 0) return ao;
  return num(t?.totalAmount);
}

export async function fetchPartyLedger({
  clientId,
  partyId,
  partyName,       // ✅ add this (pass selectedParty?.name)
  fromYYYYMMDD,
  toYYYYMMDD,
}) {
  if (!clientId) throw new Error("Missing clientId");
  if (!fromYYYYMMDD || !toYYYYMMDD) throw new Error("Missing date range");

  const from = Timestamp.fromDate(startOfDay(fromYYYYMMDD));
  const to = Timestamp.fromDate(endOfDay(toYYYYMMDD));

  /**
   * ✅ IMPORTANT CHANGE:
   * We DO NOT filter by partyId in Firestore query, because:
   * - old txns might miss partyId
   * - cash/legacy entries may only have partyName
   * This caused “incomplete” party report.
   *
   * We fetch client+date range (you already have index for this),
   * then filter locally by partyId OR partyName.
   */
  const qy = query(
    collection(db, "transactions"),
    where("clientId", "==", clientId),
    where("date", ">=", from),
    where("date", "<=", to),
    orderBy("date", "desc")
  );

  const snap = await getDocs(qy);
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const pid = String(partyId || "").trim();
  const pnm = norm(partyName);

  // ✅ local filter — matches by partyId OR exact partyName (case-insensitive)
  const filtered = all.filter((t) => {
    if (pid && t?.partyId === pid) return true;
    if (pnm && norm(t?.partyName) === pnm) return true;
    return false;
  });

  return filtered;
}

export function buildPartyReport({ txns = [], partyType = "Customer" }) {
  const isCustomer = norm(partyType) === "customer";

  const rows = (txns || []).map((t) => {
    const inAmt = num(t?.amountIn);
    const outAmt = num(t?.amountOut);

    return {
      ...t,
      _in: inAmt,
      _out: outAmt,
      _total: txnAmount(t),
      _dateObj:
        t?.date?.toDate?.()
          ? t.date.toDate()
          : t?.date instanceof Date
          ? t.date
          : null,
    };
  });

  // ✅ Credit Given
  // Customer: Sales (Credit)
  // Supplier: Purchase (Credit)
  const creditGiven = isCustomer
    ? rows
        .filter(
          (t) => norm(t?.type) === "sales" && norm(t?.mode) === "credit"
        )
        .reduce((s, t) => s + txnAmount(t), 0)
    : rows
        .filter(
          (t) => norm(t?.type) === "purchase" && norm(t?.mode) === "credit"
        )
        .reduce((s, t) => s + creditPurchaseAmount(t), 0);

  // ✅ Settled
  // Customer: Receipt (in)
  // Supplier: Payment (out)
  const settled = isCustomer
    ? rows
        .filter((t) => norm(t?.type) === "receipt")
        .reduce((s, t) => s + num(t?.amountIn || t?._total), 0)
    : rows
        .filter((t) => norm(t?.type) === "payment")
        .reduce((s, t) => s + num(t?.amountOut || t?._total), 0);

  const pending = creditGiven - settled;

  return {
    rows,
    count: rows.length,
    creditGiven,
    settled,
    pending,
  };
}
