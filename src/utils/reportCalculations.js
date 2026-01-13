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

function partyKey(t) {
  return String(t?.partyName || t?.description || "Party").trim() || "Party";
}
function supplierKey(t) {
  return String(t?.partyName || t?.description || "Supplier").trim() || "Supplier";
}
function expenseKey(t) {
  return String(t?.category || t?.description || "Expense").trim() || "Expense";
}

// Receipt from Customer/Both = credit recovery
function isCreditRecovery(t) {
  return typeKey(t) === "receipt" && isCustomerParty(t) && inValue(t) > 0;
}

/**
 * ✅ EXPENSE RULE (RANGE)
 * Include: Payment + Expense + Purchase (ONLY cash/bank purchases)
 * Exclude: Credit Purchase
 */
function isExpenseIncurred_RANGE(t) {
  const ty = typeKey(t);
  const m = modeKey(t);
  if (!(ty === "purchase" || ty === "payment" || ty === "expense")) return false;

  // ✅ exclude CREDIT PURCHASE
  if (ty === "purchase" && m === "credit") return false;

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
function computeReceivablesParty(txns) {
  const creditSales = txns.filter(
    (t) => typeKey(t) === "sales" && modeKey(t) === "credit" && isCustomerParty(t) && inValue(t) > 0
  );
  const receipts = txns.filter(
    (t) => typeKey(t) === "receipt" && isCustomerParty(t) && inValue(t) > 0
  );

  const createdMap = {};
  for (const t of creditSales) {
    const k = partyKey(t);
    createdMap[k] = (createdMap[k] || 0) + inValue(t);
  }

  const settledMap = {};
  for (const t of receipts) {
    const k = partyKey(t);
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

// ---------- Party-based liabilities (works for range OR till-date) ----------
function computeLiabilitiesParty(txns) {
  const createdTxns = txns.filter(isSupplierCreditLiability);
  const paidTxns = txns.filter(isSupplierPayment);

  const createdMap = {};
  for (const t of createdTxns) {
    const k = supplierKey(t);
    createdMap[k] = (createdMap[k] || 0) + outValue(t);
  }

  const paidMap = {};
  for (const t of paidTxns) {
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

  // Total payable = sum of positive balances
  const totalPayable = itemsNet.reduce((s, x) => s + (x.balance > 0 ? x.balance : 0), 0);

  const totalCreated = sum(createdTxns, (t) => outValue(t));
  const totalPaid = sum(paidTxns, (t) => outValue(t));

  return { itemsNet, totalPayable, totalCreated, totalPaid };
}

export function generateDailyPulseReport(txnsRange = [], inputs = {}) {
  const {
    selectedDate,
    openingCash = 0,
    openingBank = 0,
    actualCount = 0,
    analystNotesText = "",
    isSingleDay = false,

    // ✅ transactions till To-date for Liquidity section
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

  const incomeTxns = txnsRange.filter((t) => typeKey(t) === "income" && inValue(t) > 0);
  const totalIncome = sum(incomeTxns, (t) => inValue(t));

  const totalRevenueGenerated = cashSales + bankSales + creditRecoveryTotal + totalIncome;

  // -------------------------
  // 2) EXPENSES (RANGE)
  // -------------------------
  const expenseTxns = txnsRange.filter(isExpenseIncurred_RANGE);

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
  // 3) LIABILITY SECTION (RANGE) ✅ (as you asked now)
  // -------------------------
  const liabRange = computeLiabilitiesParty(txnsRange);

  // Total New Liability shown in section 3 = sum of positive (created - paid) per supplier within range
  const totalNewLiability_RANGE = liabRange.itemsNet.reduce(
    (s, x) => s + (x.balance > 0 ? x.balance : 0),
    0
  );

  // -------------------------
  // 4) RECEIVABLE / PAYABLE (TILL DATE) ✅ (Liquidity section)
  // -------------------------
  const recvTill = computeReceivablesParty(txnsTill);
  const liabTill = computeLiabilitiesParty(txnsTill);

  // -------------------------
  // 5) LIQUIDITY CASH+BANK (TILL DATE)
  // -------------------------
  const cashInTill = sum(txnsTill.filter((t) => modeKey(t) === "cash"), (t) => inValue(t));
  const cashOutTill = sum(txnsTill.filter((t) => modeKey(t) === "cash"), (t) => num(t?.amountOut));

  const bankInTill = sum(txnsTill.filter((t) => modeKey(t) === "bank"), (t) => inValue(t));
  const bankOutTill = sum(txnsTill.filter((t) => modeKey(t) === "bank"), (t) => num(t?.amountOut));

  const totalCashBalance = num(openingCash) + (cashInTill - cashOutTill);
  const totalBankBalance = num(openingBank) + (bankInTill - bankOutTill);

  // ✅ Total Liquid Funds = cash + bank ONLY
  const totalLiquidFunds = totalCashBalance + totalBankBalance;

  // -------------------------
  // 6) DAILY CASH CHECK (RANGE)
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
      totalIncome,
      totalRevenueGenerated,
    },

    expenses: {
      items: expenseItems,
      totalExpenseIncurred,
    },

    // ✅ Section 3 is RANGE
    liabilities: {
      itemsNet: liabRange.itemsNet,
      totalNewLiability: totalNewLiability_RANGE,
      totalSupplierPaid: liabRange.totalPaid, // range paid
      payableNet: liabRange.totalCreated - liabRange.totalPaid,
    },

    // ✅ Liquidity is TILL DATE
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
