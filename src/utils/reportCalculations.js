// src/utils/reportCalculations.js

function num(v) {
  return Number(v || 0);
}

function sum(arr, fn) {
  return arr.reduce((s, x) => s + num(fn(x)), 0);
}

function modeKey(t) {
  return String(t?.mode || "").trim().toLowerCase();
}

function typeKey(t) {
  return String(t?.type || "").trim().toLowerCase();
}

// Receipt from Customer/Both = credit recovery (old debts / receivable recovery)
function isCreditRecovery(t) {
  return (
    typeKey(t) === "receipt" &&
    (t?.partyType === "Customer" || t?.partyType === "Both") &&
    num(t?.amountIn) > 0
  );
}

// ✅ Expenses = ANY cash/bank out (regardless of type)
function isExpenseOut(t) {
  const m = modeKey(t);
  return (m === "cash" || m === "bank") && num(t?.amountOut) > 0;
}

// ✅ Liability = Purchase with mode Credit (new payable created, not paid yet)
function isCreditPurchase(t) {
  const m = modeKey(t);
  return typeKey(t) === "purchase" && m === "credit";
}

function expenseKey(t) {
  return String(t?.category || t?.description || "Expense").trim() || "Expense";
}

function liabilityKey(t) {
  return String(t?.partyName || t?.description || "Supplier").trim() || "Supplier";
}

export function generateDailyPulseReport(txns = [], inputs = {}) {
  const {
    selectedDate,
    openingCash = 0,
    openingBank = 0,
    actualCount = 0,
    analystNotesText = "",
  } = inputs;

  // -------------------------
  // 1) REVENUE & INFLOW
  // -------------------------
  const sales = txns.filter((t) => typeKey(t) === "sales");

  // Z-report style (shows all sales including credit)
  const totalGrossSales = sum(sales, (t) => t?.amountIn);

  const cashSales = sum(
    sales.filter((t) => modeKey(t) === "cash"),
    (t) => t?.amountIn
  );

  const bankSales = sum(
    sales.filter((t) => modeKey(t) === "bank"),
    (t) => t?.amountIn
  );

  const creditSales = sum(
    sales.filter((t) => modeKey(t) === "credit"),
    (t) => t?.amountIn
  );

  const creditRecoveryTxns = txns.filter(isCreditRecovery);

  const creditRecoveryTotal = sum(creditRecoveryTxns, (t) => t?.amountIn);

  const creditRecoveryCash = sum(
    creditRecoveryTxns.filter((t) => modeKey(t) === "cash"),
    (t) => t?.amountIn
  );

  const creditRecoveryBank = sum(
    creditRecoveryTxns.filter((t) => modeKey(t) === "bank"),
    (t) => t?.amountIn
  );

  /**
   * ✅ IMPORTANT FIX:
   * Total Revenue Generated must EXCLUDE credit sales (pending).
   * So it is: Cash Sales + Bank Sales + Credit Recovery.
   */
  const totalRevenueGenerated = cashSales + bankSales + creditRecoveryTotal;

  // -------------------------
  // 2) EXPENSES (Verified)
  // -------------------------
  const expenseTxns = txns.filter(isExpenseOut);

  const expenseMap = {};
  for (const t of expenseTxns) {
    const key = expenseKey(t);
    expenseMap[key] = (expenseMap[key] || 0) + num(t?.amountOut);
  }

  const expenseItems = Object.keys(expenseMap)
    .sort()
    .map((k) => ({ key: k, amount: num(expenseMap[k]) }));

  const totalExpenseIncurred = sum(expenseTxns, (t) => t?.amountOut);

  // -------------------------
  // 3) CREDIT PURCHASE / LIABILITY
  // -------------------------
  const liabTxns = txns.filter(isCreditPurchase);

  // credit purchase might be stored as amountIn or amountOut depending on your form
  const liabValue = (t) => (num(t?.amountOut) > 0 ? t?.amountOut : t?.amountIn);

  const liabMap = {};
  for (const t of liabTxns) {
    const key = liabilityKey(t);
    liabMap[key] = (liabMap[key] || 0) + num(liabValue(t));
  }

  const liabilityItems = Object.keys(liabMap)
    .sort()
    .map((k) => ({ key: k, amount: num(liabMap[k]) }));

  const totalNewLiability = sum(liabTxns, (t) => liabValue(t));

  // -------------------------
  // 4) LIQUIDITY (range movement + opening)
  // -------------------------
  const cashIn = sum(
    txns.filter((t) => modeKey(t) === "cash"),
    (t) => t?.amountIn
  );
  const cashOut = sum(
    txns.filter((t) => modeKey(t) === "cash"),
    (t) => t?.amountOut
  );

  const bankIn = sum(
    txns.filter((t) => modeKey(t) === "bank"),
    (t) => t?.amountIn
  );
  const bankOut = sum(
    txns.filter((t) => modeKey(t) === "bank"),
    (t) => t?.amountOut
  );

  const totalCashBalance = num(openingCash) + (cashIn - cashOut);
  const totalBankBalance = num(openingBank) + (bankIn - bankOut);

  /**
   * ✅ Receivable (Asset)
   * Without opening receivable balances, the most correct meaning for this report is:
   * "new credit sales pending" within this period.
   */
  const totalReceivable = num(creditSales);

  /**
   * ✅ Payable (Liability)
   * New credit purchases created in the period
   */
  const totalPayable = num(totalNewLiability);

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
  if (Math.abs(variance) >= 0.01)
    notes.push("Cash variance detected. Please recheck drawer count.");
  if (creditSales > 0)
    notes.push("Credit sales pending. Ensure recovery tracking is updated.");
  if (totalNewLiability > 0) notes.push("New supplier liabilities added in this period.");

  return {
    meta: { date: selectedDate, count: txns.length },

    status: {
      healthy,
      statusText: healthy ? "HEALTHY" : "ACTION REQUIRED",
      statusSub: healthy
        ? "Cash is balanced. Expenses are verified."
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
      totalRevenueGenerated,
    },

    expenses: {
      items: expenseItems,
      totalExpenseIncurred,
    },

    liabilities: {
      items: liabilityItems,
      totalNewLiability,
    },

    liquidity: {
      totalCashBalance,
      totalBankBalance,
      totalReceivable,
      totalPayable,
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
