// src/utils/reportCalculations.js
// LIVE SAFE — Discount Netting + Existing Stable Engine
// Backward compatible. No DB writes. No assumptions.

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

  if (x.includes("salary")) return "Salary";
  if (x.includes("rent")) return "Rent";
  if (x.includes("util")) return "Utility";
  if (x.includes("bill")) return "Utility";
  if (x.includes("trans")) return "Transport";
  if (x.includes("comm")) return "Commodity";

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

// -------------------------------------------
// ✅ DISCOUNT (Backward compatible extraction)
// -------------------------------------------
function getDiscountInfo(t) {
  const enabled =
    Boolean(t?.enableDiscount) ||
    Boolean(t?.discountEnabled) ||
    Boolean(t?.isDiscountEnabled) ||
    num(t?.discountAmount) > 0 ||
    num(t?.discount?.amount) > 0;

  const amount =
    num(t?.discountAmount) ||
    num(t?.discount?.amount) ||
    num(t?.discount_value) ||
    0;

  const discountType = String(
    t?.discountType || t?.discount?.type || t?.discount_type || ""
  )
    .trim()
    .toLowerCase(); // invoice / settlement

  const side = String(
    t?.discountSide ||
      t?.discountPartySide ||
      t?.discount?.side ||
      t?.discount_side ||
      ""
  )
    .trim()
    .toLowerCase(); // customer / supplier

  // safe return
  return {
    enabled: enabled && amount > 0,
    amount: amount > 0 ? amount : 0,
    discountType: discountType || "",
    side: side || "",
  };
}

// Netting rules:
// - Customer-side discount reduces inflow / receivable (Sales/Receipt)
// - Supplier-side discount reduces outflow / payable (Purchase/Payment/Expense)
// NOTE: This is for “numbers clarity” (your request: show net amounts, avoid confusion)
function effectiveIn(t) {
  const base = inValue(t);
  if (!(base > 0)) return base;

  const ty = typeKey(t);
  const { enabled, amount, side } = getDiscountInfo(t);
  if (!enabled) return base;

  // customer discount -> reduces what we actually receive / what customer owes
  if (side === "customer" && (ty === "sales" || ty === "receipt" || ty === "income")) {
    return Math.max(0, base - amount);
  }

  return base;
}

function effectiveOut(t) {
  const base = num(t?.amountOut);
  if (!(base > 0)) return base;

  const ty = typeKey(t);
  const { enabled, amount, side } = getDiscountInfo(t);
  if (!enabled) return base;

  // supplier discount -> reduces what we pay / what we owe
  if (side === "supplier" && (ty === "purchase" || ty === "payment" || ty === "expense")) {
    return Math.max(0, base - amount);
  }

  return base;
}

// -------------------------------------------
// Receipt from Customer/Both = credit recovery
// -------------------------------------------
function isCreditRecovery(t) {
  return typeKey(t) === "receipt" && isCustomerParty(t) && effectiveIn(t) > 0;
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
  if (ty === "purchase" && m === "credit") return false;
  return effectiveOut(t) > 0;
}

// Supplier liability created (Credit Purchase/Credit Expense)
function isSupplierCreditLiability(t) {
  const ty = typeKey(t);
  const m = modeKey(t);
  if (!isSupplierParty(t)) return false;
  if (!(ty === "purchase" || ty === "expense")) return false;
  if (m !== "credit") return false;

  // credit purchase stored in amountIn (your system logic)
  // supplier discount on credit invoice reduces liability too
  const base = outValue(t);
  const { enabled, amount, side } = getDiscountInfo(t);
  if (enabled && side === "supplier") return Math.max(0, base - amount);

  return base > 0;
}

// Supplier payment reduces payable
function isSupplierPayment(t) {
  const ty = typeKey(t);
  if (!isSupplierParty(t)) return false;
  if (ty !== "payment") return false;
  return effectiveOut(t) > 0;
}

// ---------- Receivables (TILL DATE) ----------
function computeReceivablesTillDate(txnsTill) {
  const creditSales = txnsTill.filter(
    (t) =>
      typeKey(t) === "sales" &&
      modeKey(t) === "credit" &&
      isCustomerParty(t) &&
      effectiveIn(t) > 0
  );

  const receipts = txnsTill.filter(
    (t) => typeKey(t) === "receipt" && isCustomerParty(t) && effectiveIn(t) > 0
  );

  const createdMap = {};
  for (const t of creditSales) {
    const k = safeName(t?.partyName || t?.description, "Customer");
    createdMap[k] = (createdMap[k] || 0) + effectiveIn(t);
  }

  const settledMap = {};
  for (const t of receipts) {
    const k = safeName(t?.partyName || t?.description, "Customer");
    settledMap[k] = (settledMap[k] || 0) + effectiveIn(t);
  }

  const keys = Array.from(
    new Set([...Object.keys(createdMap), ...Object.keys(settledMap)])
  ).sort();

  const itemsNet = keys
    .map((k) => {
      const created = num(createdMap[k] || 0);
      const settled = num(settledMap[k] || 0);
      return { key: k, created, settled, balance: created - settled };
    })
    .filter((x) => Math.abs(x.created) > 0.0001 || Math.abs(x.settled) > 0.0001);

  const totalReceivable = itemsNet.reduce(
    (s, x) => s + (x.balance > 0 ? x.balance : 0),
    0
  );

  return { itemsNet, totalReceivable };
}

// ---------- Liabilities ----------
function computeLiabilities(txns) {
  const creditCreate = txns.filter(isSupplierCreditLiability);
  const supplierPay = txns.filter(isSupplierPayment);

  // created (credit) stored via outValue (amountIn fallback)
  const createdAmount = (t) => {
    const base = outValue(t);
    const { enabled, amount, side } = getDiscountInfo(t);
    if (enabled && side === "supplier") return Math.max(0, base - amount);
    return base;
  };

  const totalCreated = sum(creditCreate, (t) => createdAmount(t));
  const totalPaid = sum(supplierPay, (t) => effectiveOut(t));
  const net = totalCreated - totalPaid;

  const creditPurchasesList = creditCreate
    .map((t) => ({
      supplier: supplierKey(t),
      date: fmtDate(t),
      amount: createdAmount(t),
      type: typeKey(t),
    }))
    .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));

  const createdMap = {};
  for (const t of creditCreate) {
    const k = supplierKey(t);
    createdMap[k] = (createdMap[k] || 0) + createdAmount(t);
  }
  const paidMap = {};
  for (const t of supplierPay) {
    const k = supplierKey(t);
    paidMap[k] = (paidMap[k] || 0) + effectiveOut(t);
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
  const map = {};

  for (const t of txnsRange) {
    const ty = typeKey(t);
    const m = modeKey(t);

    // ✅ use effectiveOut for expense/payment/cash-bank purchase
    let amount = 0;
    if (ty === "purchase") {
      if (m === "credit") continue;
      amount = effectiveOut(t);
    } else if (ty === "payment" || ty === "expense") {
      amount = effectiveOut(t);
    } else {
      continue;
    }

    if (!(amount > 0)) continue;

    let category = normalizeCategory(t?.category);

    if (ty === "payment" && isSupplierParty(t)) category = "Supplier";
    if (!category) category = normalizeCategory(expenseKey(t)) || "Other";

    const key = `Total ${typeLabel(ty)} ${category} by ${modeLabel(m)}`;
    map[key] = (map[key] || 0) + amount;
  }

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
    txnsTillDate = null,
  } = inputs;

  const txnsTill = Array.isArray(txnsTillDate) ? txnsTillDate : txnsRange;

  // -------------------------
  // 1) SALES (NET) + INFLOW
  // -------------------------
  const sales = txnsRange.filter((t) => typeKey(t) === "sales");

  const totalGrossSales = sum(sales, (t) => inValue(t));
  const totalNetSales = sum(sales, (t) => effectiveIn(t)); // ✅ NEW

  const cashSales = sum(sales.filter((t) => modeKey(t) === "cash"), (t) => effectiveIn(t));
  const bankSales = sum(sales.filter((t) => modeKey(t) === "bank"), (t) => effectiveIn(t));
  const creditSales = sum(sales.filter((t) => modeKey(t) === "credit"), (t) => effectiveIn(t));

  const creditRecoveryTxns = txnsRange.filter(isCreditRecovery);
  const creditRecoveryTotal = sum(creditRecoveryTxns, (t) => effectiveIn(t));
  const creditRecoveryCash = sum(
    creditRecoveryTxns.filter((t) => modeKey(t) === "cash"),
    (t) => effectiveIn(t)
  );
  const creditRecoveryBank = sum(
    creditRecoveryTxns.filter((t) => modeKey(t) === "bank"),
    (t) => effectiveIn(t)
  );

  const incomeTxns = txnsRange.filter((t) => typeKey(t) === "income" && effectiveIn(t) > 0);

  const otherIncomeDetails = incomeTxns
    .map((t) => {
      const dt = fmtDate(t);
      const desc = safeName(t?.description || t?.category || t?.partyName, "Other Income");
      const label = dt ? `Other Income - ${desc} (${dt})` : `Other Income - ${desc}`;
      return { label, amount: effectiveIn(t), date: dt };
    })
    .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : a.label.localeCompare(b.label)));

  const totalIncome = sum(incomeTxns, (t) => effectiveIn(t));

  // ✅ Total Revenue Generated should reflect net sales
  const totalRevenueGenerated = cashSales + bankSales + creditRecoveryTotal + totalIncome;

  // -------------------------
  // 2) EXPENSE SUMMARY
  // -------------------------
  const expenseSummaryDetailed = buildExpenseSummaryDetailed(txnsRange);

  // -------------------------
  // 3) EXPENSES VERIFIED
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

      return { label, amount: effectiveOut(t), type: ty, date: dt };
    })
    .sort((a, b) => {
      if (a.date !== b.date) return (a.date || "9999-99-99").localeCompare(b.date || "9999-99-99");
      const order = { purchase: 1, payment: 2, expense: 3 };
      const oa = order[a.type] || 9;
      const ob = order[b.type] || 9;
      if (oa !== ob) return oa - ob;
      return String(a.label).localeCompare(String(b.label));
    });

  const totalExpenseIncurred = sum(expenseTxns, (t) => effectiveOut(t));

  // -------------------------
  // 4) LIABILITY (RANGE)
  // -------------------------
  const liabRange = computeLiabilities(txnsRange);

  // -------------------------
  // 5) RECEIVABLE / PAYABLE (TILL)
  // -------------------------
  const recvTill = computeReceivablesTillDate(txnsTill);
  const liabTill = computeLiabilities(txnsTill);

  // -------------------------
  // 6) LIQUIDITY (TILL DATE) — NETTED
  // -------------------------
  const cashInTill = sum(txnsTill.filter((t) => modeKey(t) === "cash"), (t) => effectiveIn(t));
  const cashOutTill = sum(txnsTill.filter((t) => modeKey(t) === "cash"), (t) => effectiveOut(t));

  const bankInTill = sum(txnsTill.filter((t) => modeKey(t) === "bank"), (t) => effectiveIn(t));
  const bankOutTill = sum(txnsTill.filter((t) => modeKey(t) === "bank"), (t) => effectiveOut(t));

  const totalCashBalance = num(openingCash) + (cashInTill - cashOutTill);
  const totalBankBalance = num(openingBank) + (bankInTill - bankOutTill);
  const totalLiquidFunds = totalCashBalance + totalBankBalance;

  // -------------------------
  // 7) DAILY CASH CHECK (RANGE) — NETTED
  // -------------------------
  const cashInRange = sum(txnsRange.filter((t) => modeKey(t) === "cash"), (t) => effectiveIn(t));
  const cashOutRange = sum(txnsRange.filter((t) => modeKey(t) === "cash"), (t) => effectiveOut(t));

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
      totalNetSales, // ✅ NEW (for quick report + clarity)

      cashSales,
      bankSales,
      creditSales,

      creditRecoveryTotal,
      creditRecoveryCash,
      creditRecoveryBank,

      totalIncome,
      otherIncomeDetails,

      totalRevenueGenerated,
    },

    expenseSummaryDetailed,

    expenses: {
      details: expenseDetails,
      totalExpenseIncurred,
    },

    liabilities: {
      creditPurchases: liabRange.creditPurchasesList,
      totalCreated: liabRange.totalCreated,
      totalSupplierPaid: liabRange.totalPaid,
      totalNewLiability: liabRange.net,
    },

    liquidity: {
      totalCashBalance,
      totalBankBalance,
      totalReceivable: recvTill.totalReceivable,
      totalPayable: liabTill.totalPayable,
      totalLiquidFunds,
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
