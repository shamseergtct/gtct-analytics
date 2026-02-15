// src/utils/txnReportsApi.js
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";

// Accepts "YYYY-MM-DD" OR "DD-MM-YYYY"
function parseYYYYMMDD_or_DDMMYYYY(s) {
  const x = String(s || "").trim();
  if (!x) return null;

  const parts = x.split("-").map((p) => p.trim());
  if (parts.length !== 3) return null;

  if (parts[0].length === 4) {
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    const d = Number(parts[2]);
    if (!y || !m || !d) return null;
    return { y, m, d };
  }

  const d = Number(parts[0]);
  const m = Number(parts[1]);
  const y = Number(parts[2]);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function startOfDay(dateStr) {
  const p = parseYYYYMMDD_or_DDMMYYYY(dateStr);
  if (!p) return null;
  return new Date(p.y, p.m - 1, p.d, 0, 0, 0, 0);
}

function endOfDay(dateStr) {
  const p = parseYYYYMMDD_or_DDMMYYYY(dateStr);
  if (!p) return null;
  return new Date(p.y, p.m - 1, p.d, 23, 59, 59, 999);
}

function num(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function normType(t) {
  const x = String(t || "").trim().toLowerCase();
  if (!x) return "";
  if (x.startsWith("sal")) return "sales";
  if (x.startsWith("pur")) return "purchase";
  if (x.startsWith("rec")) return "receipt";
  if (x.startsWith("pay")) return "payment";
  if (x.startsWith("exp")) return "expense";
  if (x.startsWith("inc")) return "income";
  if (x.startsWith("tra")) return "transfer";
  if (x.startsWith("ref")) return "refill";
  return x;
}

function normMode(m) {
  const x = String(m || "").trim().toLowerCase();
  if (!x) return "";
  if (x.startsWith("cas")) return "cash";
  if (x.startsWith("ban")) return "bank";
  if (x.startsWith("upi")) return "bank";
  if (x.startsWith("car")) return "bank";
  if (x.startsWith("cre")) return "credit";
  if (x.includes("petti") || x.includes("petty")) return "petti cash";
  return x;
}

function normCategory(c) {
  return String(c || "").trim().toLowerCase();
}

function isExcludedTxn(t) {
  if (!t) return true;
  if (t?.internalTransfer === true) return true;

  const ty = normType(t?.type);
  if (ty === "transfer" || ty === "refill") return true;

  return false;
}

/**
 * ✅ Amount extraction (same idea as TxnReports.jsx)
 * 1) Prefer totalAmount if >0
 * 2) else fallback with purchase-credit fix
 */
function getTxnAmountByType(typeKey, row) {
  const total = num(row?.totalAmount);
  if (total > 0) return total;

  const amtIn = num(row?.amountIn);
  const amtOut = num(row?.amountOut);

  const ty = String(typeKey || "").toLowerCase();

  // purchase special case
  if (ty === "purchase") {
    const m = normMode(row?.mode);
    if (m === "credit") return amtIn > 0 ? amtIn : amtOut;
    return amtOut > 0 ? amtOut : amtIn;
  }

  // default:
  // in: sales/receipt/income
  // out: payment/expense
  const isIn = ty === "sales" || ty === "receipt" || ty === "income";
  return isIn ? (amtIn > 0 ? amtIn : amtOut) : (amtOut > 0 ? amtOut : amtIn);
}

/**
 * Fetch by client + date range only, then filter in JS.
 */
export async function fetchTxnRange({
  clientId,
  fromDate,
  toDate,
  typeKey,
  mode,
  partyId,
  category,
}) {
  if (!clientId) throw new Error("No active client selected");
  if (!fromDate || !toDate) throw new Error("Select From and To dates");

  const from = startOfDay(fromDate);
  const to = endOfDay(toDate);

  if (!from || !to) throw new Error("Invalid date format. Use YYYY-MM-DD.");
  if (from > to) throw new Error("From date cannot be after To date.");

  const qy = query(
    collection(db, "transactions"),
    where("clientId", "==", clientId),
    where("date", ">=", from),
    where("date", "<=", to),
    orderBy("date", "desc")
  );

  const snap = await getDocs(qy);

  const wantType = String(typeKey || "").trim().toLowerCase();
  const wantMode = mode ? normMode(mode) : "";
  const wantPartyId = partyId ? String(partyId).trim() : "";
  const wantCategory = category ? normCategory(category) : "";

  const rows = [];
  snap.forEach((docSnap) => {
    const d = docSnap.data();
    if (isExcludedTxn(d)) return;

    if (wantType && normType(d?.type) !== wantType) return;

    if (wantMode) {
      if (normMode(d?.mode) !== wantMode) return;
    }

    if (wantPartyId) {
      if (String(d?.partyId || "") !== wantPartyId) return;
    }

    if (wantCategory) {
      if (normCategory(d?.category) !== wantCategory) return;
    }

    rows.push({ id: docSnap.id, ...d });
  });

  return rows;
}

/**
 * ✅ Receivable/Payable list FROM TRANSACTIONS (same logic as Party Report)
 *
 * Receivable:
 *   creditSales (mode=credit) - receipts (any mode)
 *
 * Payable:
 *   creditPurchases (mode=credit)
 * + creditExpenses (mode=credit)
 * + loanIncome (income with category="loan")   // loan should be payable
 * - payments (any mode)
 *
 * Returns [{ partyId, partyName, amount }]
 */
export async function fetchPartyDueFromTransactions({
  clientId,
  toDate,
  kind, // "receivable" | "payable"
  partyId = "",
}) {
  if (!clientId) throw new Error("No active client selected");
  if (!toDate) throw new Error("Select To date");

  const to = endOfDay(toDate);
  if (!to) throw new Error("Invalid date format. Use YYYY-MM-DD.");

  const qy = query(
    collection(db, "transactions"),
    where("clientId", "==", clientId),
    where("date", "<=", to),
    orderBy("date", "desc")
  );

  const snap = await getDocs(qy);

  const k = String(kind || "").trim().toLowerCase();
  const wantPartyId = partyId ? String(partyId).trim() : "";

  // partyId -> { name, creditSales, receipts, creditPurchases, creditExpenses, loanIncome, payments }
  const map = new Map();

  function ensure(pid, pname) {
    if (!pid) return null;
    if (!map.has(pid)) {
      map.set(pid, {
        partyId: pid,
        partyName: pname || "-",
        creditSales: 0,
        receipts: 0,
        creditPurchases: 0,
        creditExpenses: 0,
        loanIncome: 0,
        payments: 0,
      });
    } else {
      const r = map.get(pid);
      if ((!r.partyName || r.partyName === "-") && pname) r.partyName = pname;
    }
    return map.get(pid);
  }

  snap.forEach((docSnap) => {
    const t = docSnap.data();
    if (isExcludedTxn(t)) return;

    const pid = String(t?.partyId || "").trim();
    if (!pid) return;
    if (wantPartyId && pid !== wantPartyId) return;

    const pname = t?.partyName || "-";
    const ty = normType(t?.type);
    const mode = normMode(t?.mode);
    const cat = normCategory(t?.category);

    const row = ensure(pid, pname);
    if (!row) return;

    if (ty === "sales") {
      // credit-only sales create receivable
      if (mode !== "credit") return;
      row.creditSales += getTxnAmountByType("sales", t);
      return;
    }

    if (ty === "receipt") {
      // any receipt settles receivable
      row.receipts += getTxnAmountByType("receipt", t);
      return;
    }

    if (ty === "purchase") {
      // credit-only purchases create payable
      if (mode !== "credit") return;
      row.creditPurchases += getTxnAmountByType("purchase", t);
      return;
    }

    if (ty === "expense") {
      // credit-only party-linked expense create payable
      if (mode !== "credit") return;
      row.creditExpenses += getTxnAmountByType("expense", t);
      return;
    }

    if (ty === "income") {
      // income category loan => payable
      if (cat !== "loan") return;
      row.loanIncome += getTxnAmountByType("income", t);
      return;
    }

    if (ty === "payment") {
      // any payment settles payable
      row.payments += getTxnAmountByType("payment", t);
      return;
    }
  });

  const out = [];

  for (const r of map.values()) {
    const receivable = num(r.creditSales) - num(r.receipts);
    const payable =
      num(r.creditPurchases) + num(r.creditExpenses) + num(r.loanIncome) - num(r.payments);

    if (k === "receivable") {
      if (receivable > 0) {
        out.push({ partyId: r.partyId, partyName: r.partyName, amount: receivable });
      }
    } else if (k === "payable") {
      if (payable > 0) {
        out.push({ partyId: r.partyId, partyName: r.partyName, amount: payable });
      }
    }
  }

  out.sort((a, b) => num(b.amount) - num(a.amount));
  return out;
}
