// src/utils/reportCalculations.js

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function isSameDay(tsOrDate, yyyymmdd) {
  try {
    const d =
      tsOrDate?.toDate
        ? tsOrDate.toDate()
        : tsOrDate instanceof Date
        ? tsOrDate
        : new Date(tsOrDate);

    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}` === yyyymmdd;
  } catch {
    return false;
  }
}

function groupSum(rows, keyFn, amountFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r) || "Unknown";
    const cur = map.get(k) || 0;
    map.set(k, cur + amountFn(r));
  }
  return Array.from(map.entries()).map(([key, amount]) => ({ key, amount }));
}

/**
 * ✅ Daily Pulse Logic (Fixed)
 * - Credit Sales are NOT cash revenue received today (they are pending receivable)
 * - Revenue Generated = (Cash Sales + Bank Sales) + (Credit Recovery receipts from credit customers)
 * - Credit Recovery rule: Receipt from Customer/Both => recovered amount
 */
export function generateDailyPulseReport(
  txns,
  { selectedDate, openingCash = 0, openingBank = 0, actualCount = 0 } = {}
) {
  const dayTxns = selectedDate
    ? txns.filter((t) => isSameDay(t.date, selectedDate))
    : [...txns];

  // Prefer new fields, fallback to amountIn/amountOut
  const getTotal = (t) => {
    const total = n(t.totalAmount);
    if (total > 0) return total;
    // fallback:
    return n(t.amountIn) > 0 ? n(t.amountIn) : n(t.amountOut);
  };

  // -----------------------------
  // 1) REVENUE & INFLOW (FIXED)
  // -----------------------------
  const sales = dayTxns.filter((t) => t.type === "Sales");

  // Total Gross Sales (Z-Report) = ALL sales value (cash+bank+credit)
  const totalGrossSales = sales.reduce((s, t) => s + getTotal(t), 0);

  // Real money received from sales (only Cash/Bank)
  const cashSales = sales
    .filter((t) => t.mode === "Cash")
    .reduce((s, t) => s + getTotal(t), 0);

  const bankSales = sales
    .filter((t) => t.mode === "Bank")
    .reduce((s, t) => s + getTotal(t), 0);

  // Credit Sales are pending receivable (NOT received today)
  const creditSales = sales
    .filter((t) => t.mode === "Credit")
    .reduce((s, t) => s + getTotal(t), 0);

  // ✅ Credit Recovery (Old Debts) rule:
  // Any Receipt from Customer/Both is treated as recovered
  const receipts = dayTxns.filter((t) => t.type === "Receipt");

  const creditRecoveryRows = receipts.filter((t) => {
    const pt = String(t.partyType || "").toLowerCase();
    return pt === "customer" || pt === "both";
  });

  const creditRecoveryTotal = creditRecoveryRows.reduce((s, t) => s + getTotal(t), 0);

  const creditRecoveryCash = creditRecoveryRows
    .filter((t) => t.mode === "Cash")
    .reduce((s, t) => s + getTotal(t), 0);

  const creditRecoveryBank = creditRecoveryRows
    .filter((t) => t.mode === "Bank")
    .reduce((s, t) => s + getTotal(t), 0);

  // ✅ FIX: Total Revenue Generated = MONEY RECEIVED TODAY
  // (Cash Sales + Bank Sales) + Credit Recovery
  // Credit Sales pending is NOT included
  const totalRevenueGenerated = cashSales + bankSales + creditRecoveryTotal;

  // -----------------------------
  // 2) EXPENSES (Verified)
  // -----------------------------
  // Verified = cash/bank only
  const expensesVerifiedBase = dayTxns.filter(
    (t) => t.type === "Expense" && (t.mode === "Cash" || t.mode === "Bank")
  );

  const expensesVerified = groupSum(
    expensesVerifiedBase,
    (t) => t.category || t.description || "Expense",
    (t) => getTotal(t)
  ).sort((a, b) => b.amount - a.amount);

  const totalExpenseIncurred = expensesVerified.reduce((s, r) => s + n(r.amount), 0);

  // -----------------------------
  // 3) CREDIT PURCHASE / LIABILITY
  // -----------------------------
  const creditPurchases = dayTxns.filter(
    (t) => (t.type === "Purchase" || t.type === "Expense") && t.mode === "Credit"
  );

  const liabilities = groupSum(
    creditPurchases,
    (t) => t.partyName || "Unknown",
    (t) => getTotal(t)
  ).sort((a, b) => b.amount - a.amount);

  const totalNewLiability = liabilities.reduce((s, r) => s + n(r.amount), 0);

  // -----------------------------
  // Daily Cash / Bank flows
  // (depends on amountIn/amountOut being correct)
  // -----------------------------
  const cashIn = dayTxns
    .filter((t) => t.mode === "Cash")
    .reduce((s, t) => s + n(t.amountIn || 0), 0);

  const cashOut = dayTxns
    .filter((t) => t.mode === "Cash")
    .reduce((s, t) => s + n(t.amountOut || 0), 0);

  const bankIn = dayTxns
    .filter((t) => t.mode === "Bank")
    .reduce((s, t) => s + n(t.amountIn || 0), 0);

  const bankOut = dayTxns
    .filter((t) => t.mode === "Bank")
    .reduce((s, t) => s + n(t.amountOut || 0), 0);

  const expectedDrawer = n(openingCash) + (cashIn - cashOut);
  const variance = n(actualCount) - expectedDrawer;

  const closingCash = expectedDrawer;
  const closingBank = n(openingBank) + (bankIn - bankOut);

  // Simple receivable/payable placeholders
  const totalReceivable = creditSales; // pending credit sales (today)
  const totalPayable = totalNewLiability; // pending payables (today)

  const totalLiquidFunds = closingCash + closingBank;

  // Status
  const healthy = Math.abs(variance) < 0.01;
  const statusText = healthy ? "HEALTHY" : "ACTION REQUIRED";
  const statusSub = healthy
    ? "Cash is balanced. Expenses are verified."
    : "Variance detected or liabilities need review.";

  const notes = [];
  if (Math.abs(variance) >= 0.01) notes.push(`Cash variance detected: ${variance.toFixed(2)}`);
  if (totalNewLiability > 0) notes.push(`New credit liability: ${totalNewLiability.toFixed(2)}`);
  if (!notes.length) notes.push("No alerts for today.");

  return {
    selectedDate,
    status: { healthy, statusText, statusSub },

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
      items: expensesVerified,
      totalExpenseIncurred,
    },

    liabilities: {
      items: liabilities,
      totalNewLiability,
    },

    liquidity: {
      totalCashBalance: closingCash,
      totalBankBalance: closingBank,
      totalReceivable,
      totalPayable,
      totalLiquidFunds,
    },

    cashCheck: {
      openingCash: n(openingCash),
      netCashPosition: cashIn - cashOut,
      expectedDrawer,
      actualCount: n(actualCount),
      variance,
    },

    notes,
    meta: { count: dayTxns.length },
  };
}
