// src/utils/partyLedger.js
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function toDateObj(tsOrDate) {
  if (!tsOrDate) return null;
  if (tsOrDate?.toDate) return tsOrDate.toDate();
  if (tsOrDate instanceof Date) return tsOrDate;
  const d = new Date(tsOrDate);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function endOfDay(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

function getTotal(t) {
  // prefer your "totalAmount"
  const total = n(t.totalAmount);
  if (total > 0) return total;

  // fallback for older data
  const inAmt = n(t.amountIn);
  const outAmt = n(t.amountOut);

  if (inAmt > 0) return inAmt;
  if (outAmt > 0) return outAmt;
  return 0;
}

/**
 * Fetch transactions for a party within a date range
 * Uses composite index: transactions (clientId ASC, partyId ASC, date DESC, __name__ DESC)
 */
export async function fetchPartyLedger({
  clientId,
  partyId,
  fromYYYYMMDD,
  toYYYYMMDD,
}) {
  if (!clientId || !partyId) return [];

  const from = startOfDay(fromYYYYMMDD);
  const to = endOfDay(toYYYYMMDD);

  const qy = query(
    collection(db, "transactions"),
    where("clientId", "==", clientId),
    where("partyId", "==", partyId),
    where("date", ">=", from),
    where("date", "<=", to),
    orderBy("date", "desc")
  );

  const snap = await getDocs(qy);

  return snap.docs.map((d) => {
    const data = d.data();
    const dateObj = toDateObj(data.date);
    return {
      id: d.id,
      ...data,
      _dateObj: dateObj,
      _total: getTotal(data),
    };
  });
}

/**
 * Build report summary and rows
 * Customer:
 *  - creditGiven = Sales (Credit)
 *  - settled     = Receipt (any mode)
 *
 * Supplier:
 *  - creditGiven = Purchase/Expense (Credit)
 *  - settled     = Payment (any mode)
 */
export function buildPartyReport({ txns = [], partyType = "Customer" }) {
  const rows = [...txns].sort((a, b) => {
    const ad = a._dateObj?.getTime?.() || 0;
    const bd = b._dateObj?.getTime?.() || 0;
    return bd - ad;
  });

  let creditGiven = 0;
  let settled = 0;

  if (partyType === "Customer") {
    // Credit given to customer = Credit Sales only
    creditGiven = rows
      .filter((t) => t.type === "Sales" && t.mode === "Credit")
      .reduce((s, t) => s + n(t._total), 0);

    // Settled/Recovered from customer = Receipt (any mode)
    settled = rows
      .filter((t) => t.type === "Receipt")
      .reduce((s, t) => s + n(t._total), 0);
  } else {
    // Supplier credit = Credit Purchases & Credit Expenses
    creditGiven = rows
      .filter(
        (t) =>
          (t.type === "Purchase" || t.type === "Expense") && t.mode === "Credit"
      )
      .reduce((s, t) => s + n(t._total), 0);

    // Settled/Paid = Payment (any mode)
    settled = rows
      .filter((t) => t.type === "Payment")
      .reduce((s, t) => s + n(t._total), 0);
  }

  const pending = Math.max(0, creditGiven - settled);

  return {
    count: rows.length,
    creditGiven,
    settled,
    pending,
    rows,
  };
}
