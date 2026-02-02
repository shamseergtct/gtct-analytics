// src/utils/reportCalculations.js
// LIVE SAFE — Discount Netting + Existing Stable Engine
// Backward compatible. No DB writes. No assumptions.
// ✅ Added: Petti Cash + Internal Transfer (Refill) support
// ✅ Added: Loan Report (Range + Till-date outstanding)

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

  // ✅ Petti mapping
  if (x.startsWith("petti")) return "petti";
  if (x.startsWith("petty")) return "petti";
  if (x.includes("petti cash")) return "petti";
  if (x.includes("petty cash")) return "petti";

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

  // ✅ transfer/refill types
  if (x.startsWith("tra")) return "transfer";
  if (x.startsWith("ref")) return "refill";

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

  // ✅ fallback ONLY for outflow types (legacy)
  const ty = typeKey(t);
  if (ty === "purchase" || ty === "payment" || ty === "expense") {
    return num(t?.amountIn);
  }
  return 0;
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
  if (x.includes("loan")) return "Loan";

  if (x.includes("petti refill") || x.includes("petty refill")) return "Petti Refill";

  return s;
}

function modeLabel(m) {
  if (m === "cash") return "Cash";
  if (m === "bank") return "Bank";
  if (m === "credit") return "Credit";
  if (m === "petti") return "Petti Cash";
  return m ? m.toUpperCase() : "Unknown";
}

function typeLabel(ty) {
  if (ty === "purchase") return "Purchase";
  if (ty === "payment") return "Payment";
  if (ty === "expense") return "Expense";
  if (ty === "income") return "Other Income";
  if (ty === "transfer") return "Transfer";
  if (ty === "refill") return "Refill";
  return ty ? ty.toUpperCase() : "Unknown";
}

function categoryKey(t) {
  return normalizeCategory(t?.category);
}

// -------------------------------------------
// ✅ INTERNAL TRANSFER (Petti Refill) detector
// -------------------------------------------
function internalTransferAmount(t) {
  return (
    num(t?.totalAmount) ||
    num(t?.amountIn) ||
    num(t?.amountOut) ||
    num(t?.amount) ||
    0
  );
}

function isInternalTransfer(t) {
  if (!t) return false;
  if (t?.internalTransfer === true) return true;

  const ty = typeKey(t);
  const m = modeKey(t);
  const cat = String(t?.category || "").trim().toLowerCase();
  const desc = String(t?.description || "").trim().toLowerCase();
  const src = String(t?.sourceMode || "").trim();

  if ((ty === "transfer" || ty === "refill") && m === "petti" && src) return true;
  if (m === "petti" && (cat.includes("petti refill") || cat.includes("petty refill"))) return true;
  if (m === "petti" && desc.includes("refill")) return true;

  return false;
}

// -------------------------
// LOAN Helpers (Q1 fixed)
// - Loan acquired: Income + Loan
// - Loan repaid: Payment + Loan
// -------------------------
function isLoanIncome(t) {
  return typeKey(t) === "income" && categoryKey(t) === "Loan" && effectiveIn(t) > 0;
}
function isLoanPayment(t) {
  return typeKey(t) === "payment" && categoryKey(t) === "Loan" && effectiveOut(t) > 0;
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
    .toLowerCase();

  const side = String(
    t?.discountSide ||
      t?.discountPartySide ||
      t?.discount?.side ||
      t?.discount_side ||
      ""
  )
    .trim()
    .toLowerCase();

  return {
    enabled: enabled && amount > 0,
    amount: amount > 0 ? amount : 0,
    discountType: discountType || "",
    side: side || "",
  };
}

function effectiveIn(t) {
  const base = inValue(t);
  if (!(base > 0)) return base;

  const ty = typeKey(t);
  const { enabled, amount, side } = getDiscountInfo(t);
  if (!enabled) return base;

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

  if (side === "supplier" && (ty === "purchase" || ty === "payment" || ty === "expense")) {
    return Math.max(0, base - amount);
  }
  return base;
}

function isCreditRecovery(t) {
  if (isInternalTransfer(t)) return false;
  return typeKey(t) === "receipt" && isCustomerParty(t) && effectiveIn(t) > 0;
}

function isExpenseIncurred_RANGE(t) {
  if (isInternalTransfer(t)) return false;

  const ty = typeKey(t);
  const m = modeKey(t);

  if (!(ty === "purchase" || ty === "payment" || ty === "expense")) return false;
  if (ty === "purchase" && m === "credit") return false;

  // ✅ Loan Payment is NOT an expense
  if (ty === "payment" && categoryKey(t) === "Loan") return false;

  return effectiveOut(t) > 0;
}

function isSupplierCreditLiability(t) {
  if (isInternalTransfer(t)) return false;

  const ty = typeKey(t);
  const m = modeKey(t);
  if (!isSupplierParty(t)) return false;
  if (!(ty === "purchase" || ty === "expense")) return false;
  if (m !== "credit") return false;

  const base = outValue(t);
  const { enabled, amount, side } = getDiscountInfo(t);
  if (enabled && side === "supplier") return Math.max(0, base - amount);

  return base > 0;
}

function isSupplierPayment(t) {
  if (isInternalTransfer(t)) return false;

  const ty = typeKey(t);
  if (!isSupplierParty(t)) return false;
  if (ty !== "payment") return false;
  return effectiveOut(t) > 0;
}

function computeReceivablesTillDate(txnsTill) {
  const creditSales = txnsTill.filter(
    (t) =>
      !isInternalTransfer(t) &&
      typeKey(t) === "sales" &&
      modeKey(t) === "credit" &&
      isCustomerParty(t) &&
      effectiveIn(t) > 0
  );

  const receipts = txnsTill.filter(
    (t) =>
      !isInternalTransfer(t) &&
      typeKey(t) === "receipt" &&
      isCustomerParty(t) &&
      effectiveIn(t) > 0
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

function computeLiabilities(txns) {
  const creditCreate = txns.filter(isSupplierCreditLiability);
  const supplierPay = txns.filter(isSupplierPayment);

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
    if (isInternalTransfer(t)) continue;

    const ty = typeKey(t);
    const m = modeKey(t);

    if (ty === "payment" && normalizeCategory(t?.category) === "Loan") continue;

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
    openingPetti = 0,
    actualCount = 0,
    analystNotesText = "",
    isSingleDay = false,
    txnsTillDate = null,
  } = inputs;

  const txnsTill = Array.isArray(txnsTillDate) ? txnsTillDate : txnsRange;

  // -------------------------
  // ✅ LOAN (Range + Till)
  // -------------------------
  const loanInRange = sum(txnsRange.filter((t) => !isInternalTransfer(t) && isLoanIncome(t)), (t) =>
    effectiveIn(t)
  );
  const loanOutRange = sum(txnsRange.filter((t) => !isInternalTransfer(t) && isLoanPayment(t)), (t) =>
    effectiveOut(t)
  );
  const loanNetRange = loanInRange - loanOutRange;

  const loanInTill = sum(txnsTill.filter((t) => !isInternalTransfer(t) && isLoanIncome(t)), (t) =>
    effectiveIn(t)
  );
  const loanOutTill = sum(txnsTill.filter((t) => !isInternalTransfer(t) && isLoanPayment(t)), (t) =>
    effectiveOut(t)
  );
  const loanOutstandingTill = loanInTill - loanOutTill;

  // -------------------------
  // 1) SALES (NET) + INFLOW
  // -------------------------
  const sales = txnsRange.filter((t) => !isInternalTransfer(t) && typeKey(t) === "sales");

  const totalGrossSales = sum(sales, (t) => inValue(t));
  const totalNetSales = sum(sales, (t) => effectiveIn(t));

  const cashSales = sum(sales.filter((t) => modeKey(t) === "cash"), (t) => effectiveIn(t));
  const bankSales = sum(sales.filter((t) => modeKey(t) === "bank"), (t) => effectiveIn(t));
  const pettiSales = sum(sales.filter((t) => modeKey(t) === "petti"), (t) => effectiveIn(t));
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

  const incomeTxns = txnsRange.filter(
    (t) =>
      !isInternalTransfer(t) &&
      typeKey(t) === "income" &&
      categoryKey(t) !== "Loan" &&
      effectiveIn(t) > 0
  );

  const otherIncomeDetails = incomeTxns
    .map((t) => {
      const dt = fmtDate(t);
      const desc = safeName(t?.description || t?.category || t?.partyName, "Other Income");
      const label = dt ? `Other Income - ${desc} (${dt})` : `Other Income - ${desc}`;
      return { label, amount: effectiveIn(t), date: dt };
    })
    .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : a.label.localeCompare(b.label)));

  const totalIncome = sum(incomeTxns, (t) => effectiveIn(t));

  const totalRevenueGenerated =
    cashSales + bankSales + pettiSales + creditRecoveryTotal + totalIncome;

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
  // 6) LIQUIDITY (TILL DATE)
  // -------------------------
  const normalTill = txnsTill.filter((t) => !isInternalTransfer(t));

  const cashInTill = sum(normalTill.filter((t) => modeKey(t) === "cash"), (t) => effectiveIn(t));
  const cashOutTill = sum(normalTill.filter((t) => modeKey(t) === "cash"), (t) => effectiveOut(t));

  const bankInTill = sum(normalTill.filter((t) => modeKey(t) === "bank"), (t) => effectiveIn(t));
  const bankOutTill = sum(normalTill.filter((t) => modeKey(t) === "bank"), (t) => effectiveOut(t));

  const pettiInTill = sum(normalTill.filter((t) => modeKey(t) === "petti"), (t) => effectiveIn(t));
  const pettiOutTill = sum(normalTill.filter((t) => modeKey(t) === "petti"), (t) => effectiveOut(t));

  let totalCashBalance = num(openingCash) + (cashInTill - cashOutTill);
  let totalBankBalance = num(openingBank) + (bankInTill - bankOutTill);
  let totalPettiBalance = num(openingPetti) + (pettiInTill - pettiOutTill);

  const internalTransfersTill = txnsTill.filter(isInternalTransfer);
  for (const t of internalTransfersTill) {
    const amt = internalTransferAmount(t);
    if (!(amt > 0)) continue;

    const src = normalizeMode(t?.sourceMode || "");
    if (src === "cash") totalCashBalance -= amt;
    else if (src === "bank") totalBankBalance -= amt;

    totalPettiBalance += amt;
  }

  const totalBalance = totalCashBalance + totalBankBalance + totalPettiBalance;
  const totalLiquidFunds = totalBalance;

  // -------------------------
  // 7) DAILY CASH CHECK (RANGE)
  // -------------------------
  const rangeNormal = txnsRange.filter((t) => !isInternalTransfer(t));

  const cashInRange = sum(rangeNormal.filter((t) => modeKey(t) === "cash"), (t) => effectiveIn(t));
  const cashOutRange = sum(rangeNormal.filter((t) => modeKey(t) === "cash"), (t) => effectiveOut(t));

  let cashToPettiRange = 0;
  const internalTransfersRange = txnsRange.filter(isInternalTransfer);
  for (const t of internalTransfersRange) {
    const amt = internalTransferAmount(t);
    if (!(amt > 0)) continue;
    const src = normalizeMode(t?.sourceMode || "");
    if (src === "cash") cashToPettiRange += amt;
  }

  const netCashPosition = (cashInRange - cashOutRange) - cashToPettiRange;
  const expectedDrawer = num(openingCash) + netCashPosition;
  const variance = num(actualCount) - expectedDrawer;

  const healthy = Math.abs(variance) < 0.01;

  const notes = [];
  if (Math.abs(variance) >= 0.01) notes.push("Cash variance detected. Please recheck drawer count.");
  if (recvTill.totalReceivable > 0) notes.push("Receivable pending till date. Verify party recovery tracking.");
  if (liabTill.totalPayable > 0) notes.push("Payable pending till date. Verify supplier payment tracking.");
  if (loanOutstandingTill > 0) notes.push("Loan outstanding exists till date. Verify loan repayment plan.");

  return {
    meta: { date: selectedDate, count: txnsRange.length },
    flags: { isSingleDay: !!isSingleDay },

    loan: {
      acquiredRange: loanInRange,
      repaidRange: loanOutRange,
      netRange: loanNetRange,
      acquiredTillDate: loanInTill,
      repaidTillDate: loanOutTill,
      outstandingTillDate: loanOutstandingTill,
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
      totalNetSales,
      cashSales,
      bankSales,
      creditSales,
      pettiSales,
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
      totalPettiBalance,
      totalBalance,

      totalReceivable: recvTill.totalReceivable,
      // ✅ totalPayable now includes supplier payable + loan outstanding
      totalPayable: liabTill.totalPayable + loanOutstandingTill,

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
