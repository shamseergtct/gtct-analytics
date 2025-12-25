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
  if (x.startsWith("cre")) return "credit";
  return x;
}

function normalizeType(t) {
  const x = String(t || "").trim().toLowerCase();
  if (!x) return "";

  // ✅ tolerate partial / typo inputs
  if (x.startsWith("sal")) return "sales";
  if (x.startsWith("rec")) return "receipt";
  if (x.startsWith("inc")) return "income"; // ✅ income should be treated as revenue/inflow
  if (x.startsWith("pur")) return "purchase";
  if (x.startsWith("pay")) return "payment";
  if (x.startsWith("exp")) return "expense"; // ✅ "expens" => expense
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

// Some forms store purchase/expense value in amountIn instead of amountOut.
// This helper safely extracts "outgoing value" when needed.
function outValue(t) {
  const out = num(t?.amountOut);
  if (out > 0) return out;
  return num(t?.amountIn);
}

function inValue(t) {
  return num(t?.amountIn);
}

// Receipt from Customer/Both = credit recovery (old debts / receivable recovery)
function isCreditRecovery(t) {
  return (
    typeKey(t) === "receipt" &&
    (partyTypeKey(t) === "Customer" || partyTypeKey(t) === "Both") &&
    inValue(t) > 0
  );
}

// ✅ Inflow types (varavu): Sales + Receipt + Income
function isInflow(t) {
  const ty = typeKey(t);
  return (ty === "sales" || ty === "receipt" || ty === "income") && inValue(t) > 0;
}

// ✅ Expense types (chilavu): Purchase + Payment + Expense
// (even if mode is CREDIT, it's still an expense incurred)
function isExpenseIncurred(t) {
  const ty = typeKey(t);
  if (!(ty === "purchase" || ty === "payment" || ty === "expense")) return false;

  // For payment/expense/purchase we expect out, but tolerate amountIn storage too
  return outValue(t) > 0;
}

function expenseKey(t) {
  return String(t?.category || t?.description || "Expense").trim() || "Expense";
}

function supplierKey(t) {
  return String(t?.partyName || t?.description || "Supplier").trim() || "Supplier";
}

// ✅ New liability created when:
// - party is Supplier/Both
// - type is Purchase OR Expense
// - mode is Credit
function isSupplierCreditLiability(t) {
  const ty = typeKey(t);
  const m = modeKey(t);
  const pt = partyTypeKey(t);
  if (!(pt === "Supplier" || pt === "Both")) return false;
  if (!(ty === "purchase" || ty === "expense")) return false;
  if (m !== "credit") return false;
  return outValue(t) > 0;
}

// ✅ Payment reduces payable when:
// - party is Supplier/Both
// - type is Payment
// - amountOut > 0
// (mode can be cash/bank, but allow any mode if amountOut exists)
function isSupplierPayment(t) {
  const ty = typeKey(t);
  const pt = partyTypeKey(t);
  if (!(pt === "Supplier" || pt === "Both")) return false;
  if (ty !== "payment") return false;
  return num(t?.amountOut) > 0 || outValue(t) > 0;
}

export function generateDailyPulseReport(txns = [], inputs = {}) {
  const {
    selectedDate,
    openingCash = 0,
    openingBank = 0,
    actualCount = 0,
    analystNotesText = "",
    // ✅ NEW: Reports.jsx will pass this
    isSingleDay = false,
  } = inputs;

  // -------------------------
  // 1) REVENUE & INFLOW
  // -------------------------
  const sales = txns.filter((t) => typeKey(t) === "sales");

  // Z-report style (shows all sales including credit)
  const totalGrossSales = sum(sales, (t) => inValue(t));

  const cashSales = sum(
    sales.filter((t) => modeKey(t) === "cash"),
    (t) => inValue(t)
  );

  const bankSales = sum(
    sales.filter((t) => modeKey(t) === "bank"),
    (t) => inValue(t)
  );

  const creditSales = sum(
    sales.filter((t) => modeKey(t) === "credit"),
    (t) => inValue(t)
  );

  const creditRecoveryTxns = txns.filter(isCreditRecovery);
  const creditRecoveryTotal = sum(creditRecoveryTxns, (t) => inValue(t));
  const creditRecoveryCash = sum(
    creditRecoveryTxns.filter((t) => modeKey(t) === "cash"),
    (t) => inValue(t)
  );
  const creditRecoveryBank = sum(
    creditRecoveryTxns.filter((t) => modeKey(t) === "bank"),
    (t) => inValue(t)
  );

  // ✅ Income as inflow (varavu)
  const incomeTxns = txns.filter((t) => typeKey(t) === "income" && inValue(t) > 0);
  const totalIncome = sum(incomeTxns, (t) => inValue(t));

  /**
   * ✅ Total Revenue Generated:
   * Cash Sales + Bank Sales + Credit Recovery + Income
   * (EXCLUDE credit sales pending)
   */
  const totalRevenueGenerated = cashSales + bankSales + creditRecoveryTotal + totalIncome;

  // -------------------------
  // 2) EXPENSES (Verified)
  // -------------------------
  // ✅ include purchase + payment + expense even if CREDIT
  const expenseTxns = txns.filter(isExpenseIncurred);

  const expenseMap = {};
  for (const t of expenseTxns) {
    const key = expenseKey(t);
    expenseMap[key] = (expenseMap[key] || 0) + outValue(t);
  }

  const expenseItems = Object.keys(expenseMap)
    .sort()
    .map((k) => ({ key: k, amount: num(expenseMap[k]) }));

  const totalExpenseIncurred = sum(expenseTxns, (t) => outValue(t));

  // -------------------------
  // 3) SUPPLIER LIABILITY (Purchase/Expense CREDIT) - Payments reduce payable
  // -------------------------
  const liabCreateTxns = txns.filter(isSupplierCreditLiability);
  const supplierPayTxns = txns.filter(isSupplierPayment);

  const createdMap = {};
  for (const t of liabCreateTxns) {
    const key = supplierKey(t);
    createdMap[key] = (createdMap[key] || 0) + outValue(t);
  }

  const paidMap = {};
  for (const t of supplierPayTxns) {
    const key = supplierKey(t);
    // payment amount should come from amountOut (or fallback)
    paidMap[key] = (paidMap[key] || 0) + outValue(t);
  }

  const totalNewLiability = sum(liabCreateTxns, (t) => outValue(t)); // created in this period
  const totalSupplierPaid = sum(supplierPayTxns, (t) => outValue(t)); // paid in this period

  // ✅ net payable change inside this period
  const payableNet = totalNewLiability - totalSupplierPaid;

  // ✅ build items as NET per supplier (created - paid) so it becomes correct
  const allKeys = Array.from(new Set([...Object.keys(createdMap), ...Object.keys(paidMap)])).sort();

  const liabilityItemsNet = allKeys
    .map((k) => ({
      key: k,
      created: num(createdMap[k] || 0),
      paid: num(paidMap[k] || 0),
      balance: num(createdMap[k] || 0) - num(paidMap[k] || 0),
    }))
    .filter((x) => Math.abs(x.created) > 0.0001 || Math.abs(x.paid) > 0.0001);

  // -------------------------
  // 4) LIQUIDITY (range movement + opening)
  // -------------------------
  const cashIn = sum(
    txns.filter((t) => modeKey(t) === "cash"),
    (t) => inValue(t)
  );
  const cashOut = sum(
    txns.filter((t) => modeKey(t) === "cash"),
    (t) => num(t?.amountOut)
  );

  const bankIn = sum(
    txns.filter((t) => modeKey(t) === "bank"),
    (t) => inValue(t)
  );
  const bankOut = sum(
    txns.filter((t) => modeKey(t) === "bank"),
    (t) => num(t?.amountOut)
  );

  const totalCashBalance = num(openingCash) + (cashIn - cashOut);
  const totalBankBalance = num(openingBank) + (bankIn - bankOut);

  // ✅ Receivable = new credit sales pending within this range
  const totalReceivable = num(creditSales);

  /**
   * ✅ Payable (Liability) for this report range:
   * created (credit purchase + credit expense) MINUS payments to suppliers
   */
  const totalPayable = num(payableNet);

  const totalLiquidFunds =
    totalCashBalance + totalBankBalance + totalReceivable - totalPayable;

  // -------------------------
  // 5) DAILY CASH CHECK (Range)
  // -------------------------
  const netCashPosition = cashIn - cashOut;
  const expectedDrawer = num(openingCash) + netCashPosition;
  const variance = num(actualCount) - expectedDrawer;

  const healthy = Math.abs(variance) < 0.01;

  const notes = [];
  if (Math.abs(variance) >= 0.01) notes.push("Cash variance detected. Please recheck drawer count.");
  if (creditSales > 0) notes.push("Credit sales pending. Ensure recovery tracking is updated.");

  if (totalNewLiability > 0) notes.push("New supplier liabilities created in this period.");
  if (totalSupplierPaid > 0) notes.push("Supplier payments recorded in this period.");
  if (totalPayable < 0) notes.push("Payments exceed new liabilities in this period (net payable decreased).");

  return {
    meta: { date: selectedDate, count: txns.length },

    flags: {
      isSingleDay: !!isSingleDay,
    },

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
      totalIncome,
      totalRevenueGenerated,
    },

    expenses: {
      items: expenseItems,
      totalExpenseIncurred,
    },

    liabilities: {
      itemsNet: liabilityItemsNet, // ✅ created/paid/balance per supplier
      totalNewLiability, // ✅ only show for single-day UI
      totalSupplierPaid,
      payableNet, // ✅ used for totals if needed
    },

    liquidity: {
      totalCashBalance,
      totalBankBalance,
      totalReceivable,
      totalPayable, // ✅ NET payable after payments
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
