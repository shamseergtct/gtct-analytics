// src/utils/reportCalculations.js

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sum(arr, fn) {
  return arr.reduce((s, x) => s + num(fn(x)), 0);
}

function normalizeMode(m) {
  const x = String(m || "").trim().toLowerCase();
  if (!x) return "";
  if (x.startsWith("cas")) return "cash";
  if (x.startsWith("ban")) return "bank";
  if (x.startsWith("car")) return "bank"; // card -> bank bucket
  if (x.startsWith("upi")) return "bank";
  if (x.startsWith("cre")) return "credit";
  return x;
}

function normalizeType(t) {
  const x = String(t || "").trim().toLowerCase();
  if (!x) return "";
  if (x.startsWith("sal")) return "sales";
  if (x.startsWith("rec")) return "receipt";
  if (x.startsWith("inc")) return "income";
  if (x.startsWith("pur")) return "purchase";
  if (x.startsWith("pay")) return "payment";
  if (x.startsWith("exp")) return "expense";
  return x;
}

function modeKey(t) {
  return normalizeMode(t?.mode);
}
function typeKey(t) {
  return normalizeType(t?.type);
}
function partyTypeKey(t) {
  return String(t?.partyType || "").trim();
}

function isCustomerParty(t) {
  const pt = partyTypeKey(t);
  return pt === "Customer" || pt === "Both";
}
function isSupplierParty(t) {
  const pt = partyTypeKey(t);
  return pt === "Supplier" || pt === "Both";
}

function outValue(t) {
  const out = num(t?.amountOut);
  if (out > 0) return out;
  return num(t?.amountIn);
}
function inValue(t) {
  return num(t?.amountIn);
}

function safeName(v, fallback) {
  const s = String(v || "").trim();
  return s || fallback;
}

function expenseKey(t) {
  return safeName(t?.category || t?.description || t?.partyName, "Expense");
}
function supplierKey(t) {
  return safeName(t?.partyName || t?.description, "Supplier");
}

function fmtDate(t) {
  try {
    const d =
      t?.date?.toDate?.() instanceof Date
        ? t.date.toDate()
        : t?.date instanceof Date
        ? t.date
        : null;
    if (!d) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  } catch {
    return "";
  }
}

function normalizeCategory(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const x = s.toLowerCase();

  // keep your real category text, but standardize common ones
  if (x.includes("salary")) return "Salary";
  if (x.includes("rent")) return "Rent";
  if (x.includes("util")) return "Utility";
  if (x.includes("bill")) return "Utility";
  if (x.includes("trans")) return "Transport";
  if (x.includes("comm")) return "Commodity";

  // title-ish
  return s;
}

function modeLabel(m) {
  if (m === "cash") return "Cash";
  if (m === "bank") return "Bank";
  if (m === "credit") return "Credit";
  return m ? m.toUpperCase() : "Unknown";
}

function typeLabel(ty) {
  if (ty === "purchase") return "Purchase";
  if (ty === "payment") return "Payment";
  if (ty === "expense") return "Expense";
  if (ty === "income") return "Other Income";
  return ty ? ty.toUpperCase() : "Unknown";
}

// Receipt from Customer/Both = credit recovery
function isCreditRecovery(t) {
  return typeKey(t) === "receipt" && isCustomerParty(t) && inValue(t) > 0;
}

/**
 * ✅ EXPENSE VERIFIED LIST (RANGE)
 * Include: Payment + Expense + Purchase (ONLY cash/bank purchases)
 * Exclude: Credit Purchase
 */
function isExpenseIncurred_RANGE(t) {
  const ty = typeKey(t);
  const m = modeKey(t);
  if (!(ty === "purchase" || ty === "payment" || ty === "expense")) return false;
  if (ty === "purchase" && m === "credit") return false; // exclude credit purchase from verified expense list
  return outValue(t) > 0;
}

// Supplier liability created (Credit Purchase/Credit Expense)
function isSupplierCreditLiability(t) {
  const ty = typeKey(t);
  const m = modeKey(t);
  if (!isSupplierParty(t)) return false;
  if (!(ty === "purchase" || ty === "expense")) return false;
  if (m !== "credit") return false;
  return outValue(t) > 0;
}

// Supplier payment reduces payable
function isSupplierPayment(t) {
  const ty = typeKey(t);
  if (!isSupplierParty(t)) return false;
  if (ty !== "payment") return false;
  return outValue(t) > 0;
}

// ---------- Party-based receivables (TILL DATE) ----------
function computeReceivablesTillDate(txnsTill) {
  const creditSales = txnsTill.filter(
    (t) =>
      typeKey(t) === "sales" &&
      modeKey(t) === "credit" &&
      isCustomerParty(t) &&
      inValue(t) > 0
  );

  const receipts = txnsTill.filter(
    (t) => typeKey(t) === "receipt" && isCustomerParty(t) && inValue(t) > 0
  );

  const createdMap = {};
  for (const t of creditSales) {
    const k = safeName(t?.partyName || t?.description, "Customer");
    createdMap[k] = (createdMap[k] || 0) + inValue(t);
  }

  const settledMap = {};
  for (const t of receipts) {
    const k = safeName(t?.partyName || t?.description, "Customer");
    settledMap[k] = (settledMap[k] || 0) + inValue(t);
  }

  const keys = Array.from(new Set([...Object.keys(createdMap), ...Object.keys(settledMap)])).sort();

  const itemsNet = keys
    .map((k) => {
      const created = num(createdMap[k] || 0);
      const settled = num(settledMap[k] || 0);
      return { key: k, created, settled, balance: created - settled };
    })
    .filter((x) => Math.abs(x.created) > 0.0001 || Math.abs(x.settled) > 0.0001);

  const totalReceivable = itemsNet.reduce((s, x) => s + (x.balance > 0 ? x.balance : 0), 0);

  return { itemsNet, totalReceivable };
}

// ---------- Party-based liabilities (TILL DATE or RANGE) ----------
function computeLiabilities(txns) {
  const creditCreate = txns.filter(isSupplierCreditLiability);
  const supplierPay = txns.filter(isSupplierPayment);

  const totalCreated = sum(creditCreate, (t) => outValue(t));
  const totalPaid = sum(supplierPay, (t) => outValue(t));
  const net = totalCreated - totalPaid;

  // ✅ For list display: ONLY credit purchases/credit expenses (created)
  const creditPurchasesList = creditCreate
    .map((t) => ({
      supplier: supplierKey(t),
      date: fmtDate(t),
      amount: outValue(t),
      type: typeKey(t), // purchase/expense
    }))
    .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0)); // ascending

  // ✅ Till-date payable = sum of positive net per supplier (optional, for liquidity)
  const createdMap = {};
  for (const t of creditCreate) {
    const k = supplierKey(t);
    createdMap[k] = (createdMap[k] || 0) + outValue(t);
  }
  const paidMap = {};
  for (const t of supplierPay) {
    const k = supplierKey(t);
    paidMap[k] = (paidMap[k] || 0) + outValue(t);
  }

  const keys = Array.from(new Set([...Object.keys(createdMap), ...Object.keys(paidMap)])).sort();
  const itemsNet = keys
    .map((k) => ({
      key: k,
      created: num(createdMap[k] || 0),
      paid: num(paidMap[k] || 0),
      balance: num(createdMap[k] || 0) - num(paidMap[k] || 0),
    }))
    .filter((x) => Math.abs(x.created) > 0.0001 || Math.abs(x.paid) > 0.0001);

  const totalPayable = itemsNet.reduce((s, x) => s + (x.balance > 0 ? x.balance : 0), 0);

  return {
    creditPurchasesList,
    totalCreated,
    totalPaid,
    net,
    itemsNet,
    totalPayable,
  };
}

function buildExpenseSummaryDetailed(txnsRange) {
  // Requirement:
  // - Split by type + category + mode
  // - Print only if exists (no "No data")
  // - Examples:
  //   Total Purchase Commodity by Cash
  //   Total Purchase Commodity by Credit
  //   Total Payment Supplier by Bank
  //   Total Expense Salary by Cash

  const map = {}; // key -> amount

  for (const t of txnsRange) {
    const ty = typeKey(t);
    const m = modeKey(t);
    const amount = outValue(t);
    if (!(amount > 0)) continue;

    if (!(ty === "purchase" || ty === "payment" || ty === "expense")) continue;

    let category = normalizeCategory(t?.category);

    // payment: show Supplier separately when partyType is Supplier/Both
    if (ty === "payment" && isSupplierParty(t)) category = "Supplier";

    // fallback category
    if (!category) category = normalizeCategory(expenseKey(t)) || "Other";

    const key = `Total ${typeLabel(ty)} ${category} by ${modeLabel(m)}`;
    map[key] = (map[key] || 0) + amount;
  }

  // stable sorted output (ascending): type then category then mode label
  const rows = Object.keys(map)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => ({ label: k, amount: map[k] }));

  const total = rows.reduce((s, r) => s + num(r.amount), 0);

  return { rows, total };
}

export function generateDailyPulseReport(txnsRange = [], inputs = {}) {
  const {
    selectedDate,
    openingCash = 0,
    openingBank = 0,
    actualCount = 0,
    analystNotesText = "",
    isSingleDay = false,

    // ✅ transactions till To-date for liquidity
    txnsTillDate = null,
  } = inputs;

  const txnsTill = Array.isArray(txnsTillDate) ? txnsTillDate : txnsRange;

  // -------------------------
  // 1) REVENUE & INFLOW (RANGE)
  // -------------------------
  const sales = txnsRange.filter((t) => typeKey(t) === "sales");
  const totalGrossSales = sum(sales, (t) => inValue(t));
  const cashSales = sum(sales.filter((t) => modeKey(t) === "cash"), (t) => inValue(t));
  const bankSales = sum(sales.filter((t) => modeKey(t) === "bank"), (t) => inValue(t));
  const creditSales = sum(sales.filter((t) => modeKey(t) === "credit"), (t) => inValue(t));

  const creditRecoveryTxns = txnsRange.filter(isCreditRecovery);
  const creditRecoveryTotal = sum(creditRecoveryTxns, (t) => inValue(t));
  const creditRecoveryCash = sum(
    creditRecoveryTxns.filter((t) => modeKey(t) === "cash"),
    (t) => inValue(t)
  );
  const creditRecoveryBank = sum(
    creditRecoveryTxns.filter((t) => modeKey(t) === "bank"),
    (t) => inValue(t)
  );

  // ✅ Other income list with description (so "Collected from MD" shows as a row)
  const incomeTxns = txnsRange.filter((t) => typeKey(t) === "income" && inValue(t) > 0);
  const otherIncomeDetails = incomeTxns
    .map((t) => {
      const dt = fmtDate(t);
      const desc = safeName(t?.description || t?.category || t?.partyName, "Other Income");
      // example: "COLLECTED FROM MD"
      const label = dt ? `Other Income - ${desc} (${dt})` : `Other Income - ${desc}`;
      return { label, amount: inValue(t), date: dt };
    })
    .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : a.label.localeCompare(b.label)));

  const totalIncome = sum(incomeTxns, (t) => inValue(t));

  const totalRevenueGenerated = cashSales + bankSales + creditRecoveryTotal + totalIncome;

  // -------------------------
  // 2) EXPENSE SUMMARY (DETAILED) (RANGE) ✅
  // -------------------------
  const expenseSummaryDetailed = buildExpenseSummaryDetailed(txnsRange);

  // -------------------------
  // 3) EXPENSES (VERIFIED LIST) (RANGE) ✅
  // - add party name
  // - ascending order
  // -------------------------
  const expenseTxns = txnsRange.filter(isExpenseIncurred_RANGE);

  const expenseDetails = expenseTxns
    .map((t) => {
      const ty = typeKey(t);
      const dt = fmtDate(t);
      const cat = normalizeCategory(t?.category) || normalizeCategory(expenseKey(t)) || "Other";
      const party = safeName(t?.partyName, "");
      const partyPart = party ? ` - ${party}` : "";
      const labelBase = `${typeLabel(ty)} - ${cat}${partyPart}`;
      const label = dt ? `${labelBase} (${dt})` : labelBase;

      return { label, amount: outValue(t), type: ty, date: dt };
    })
    .sort((a, b) => {
      // ascending date
      if (a.date !== b.date) return (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99");
      // then type order: Purchase -> Payment -> Expense
      const order = { purchase: 1, payment: 2, expense: 3 };
      const oa = order[a.type] || 9;
      const ob = order[b.type] || 9;
      if (oa !== ob) return oa - ob;
      // then label
      return String(a.label).localeCompare(String(b.label));
    });

  const totalExpenseIncurred = sum(expenseTxns, (t) => outValue(t));

  // -------------------------
  // 4) LIABILITY (RANGE) ✅ list ONLY credit purchases + date
  // TOTAL NEW LIABILITY = created - paid
  // -------------------------
  const liabRange = computeLiabilities(txnsRange);

  // -------------------------
  // 5) RECEIVABLE / PAYABLE (TILL DATE) ✅ for Liquidity section
  // -------------------------
  const recvTill = computeReceivablesTillDate(txnsTill);
  const liabTill = computeLiabilities(txnsTill);

  // -------------------------
  // 6) LIQUIDITY (TILL DATE)
  // Total Liquid Funds = cash + bank only
  // -------------------------
  const cashInTill = sum(txnsTill.filter((t) => modeKey(t) === "cash"), (t) => inValue(t));
  const cashOutTill = sum(txnsTill.filter((t) => modeKey(t) === "cash"), (t) => num(t?.amountOut));

  const bankInTill = sum(txnsTill.filter((t) => modeKey(t) === "bank"), (t) => inValue(t));
  const bankOutTill = sum(txnsTill.filter((t) => modeKey(t) === "bank"), (t) => num(t?.amountOut));

  const totalCashBalance = num(openingCash) + (cashInTill - cashOutTill);
  const totalBankBalance = num(openingBank) + (bankInTill - bankOutTill);
  const totalLiquidFunds = totalCashBalance + totalBankBalance;

  // -------------------------
  // 7) DAILY CASH CHECK (RANGE)
  // -------------------------
  const cashInRange = sum(txnsRange.filter((t) => modeKey(t) === "cash"), (t) => inValue(t));
  const cashOutRange = sum(txnsRange.filter((t) => modeKey(t) === "cash"), (t) => num(t?.amountOut));

  const netCashPosition = cashInRange - cashOutRange;
  const expectedDrawer = num(openingCash) + netCashPosition;
  const variance = num(actualCount) - expectedDrawer;

  const healthy = Math.abs(variance) < 0.01;

  const notes = [];
  if (Math.abs(variance) >= 0.01) notes.push("Cash variance detected. Please recheck drawer count.");
  if (recvTill.totalReceivable > 0) notes.push("Receivable pending till date. Verify party recovery tracking.");
  if (liabTill.totalPayable > 0) notes.push("Payable pending till date. Verify supplier payment tracking.");

  return {
    meta: { date: selectedDate, count: txnsRange.length },
    flags: { isSingleDay: !!isSingleDay },

    status: {
      healthy,
      statusText: healthy ? "HEALTHY" : "ACTION REQUIRED",
      statusSub: healthy
        ? "Cash is balanced. Key movements are verified."
        : "Review variance / pending credits / liabilities.",
    },

    revenue: {
      totalGrossSales,
      cashSales,
      bankSales,
      creditSales,
      creditRecoveryTotal,
      creditRecoveryCash,
      creditRecoveryBank,

      // ✅ keep totals
      totalIncome,

      // ✅ new: list rows for PDF (Collected from MD etc.)
      otherIncomeDetails,

      totalRevenueGenerated,
    },

    // ✅ new section
    expenseSummaryDetailed, // { rows:[{label,amount}], total }

    expenses: {
      details: expenseDetails, // ✅ type + category + party + date (ascending)
      totalExpenseIncurred,
    },

    liabilities: {
      creditPurchases: liabRange.creditPurchasesList, // ✅ ONLY credit purchase/credit expense list + date
      totalCreated: liabRange.totalCreated,
      totalSupplierPaid: liabRange.totalPaid,
      totalNewLiability: liabRange.net, // ✅ created - paid (range)
    },

    liquidity: {
      totalCashBalance,
      totalBankBalance,
      totalReceivable: recvTill.totalReceivable,
      totalPayable: liabTill.totalPayable,
      totalLiquidFunds, // ✅ cash + bank only
    },

    cashCheck: {
      openingCash: num(openingCash),
      netCashPosition,
      expectedDrawer,
      actualCount: num(actualCount),
      variance,
    },

    notes,
    analystNotesText: String(analystNotesText || ""),
  };
}
