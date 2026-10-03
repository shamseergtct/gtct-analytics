/**
 * Party outstanding balances from transaction rows (client-side).
 * Receivable = credit sales − receipts (excl. loans)
 * Payable    = credit purchases/expenses − payments (excl. loans)
 * Loan       = loan receipts − loan payments
 */

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normType(type) {
  const key = String(type || "").trim().toLowerCase();
  if (key.startsWith("sal")) return "sales";
  if (key.startsWith("pur")) return "purchase";
  if (key.startsWith("rec")) return "receipt";
  if (key.startsWith("pay")) return "payment";
  if (key.startsWith("exp")) return "expense";
  return key;
}

function normMode(mode) {
  return String(mode || "")
    .trim()
    .toLowerCase()
    .replaceAll(" ", "_");
}

function isLoanTxn(transaction) {
  if (String(transaction?.category || "").toLowerCase().includes("loan")) {
    return true;
  }
  return String(transaction?.liabilityType || "").toUpperCase() === "LOAN";
}

function isExcludedTxn(transaction) {
  const status = String(transaction?.status || "POSTED").toUpperCase();
  if (["DRAFT", "VOID", "CANCELLED", "REVERSED"].includes(status)) return true;
  if (transaction?.internalTransfer === true) return true;
  return false;
}

function txnAmount(transaction) {
  const inAmt = num(transaction?.amountIn);
  const outAmt = num(transaction?.amountOut);
  if (inAmt > 0) return inAmt;
  if (outAmt > 0) return outAmt;
  return num(transaction?.totalAmount);
}

export function computePartyBalances(transactions = []) {
  let creditSales = 0;
  let receipts = 0;
  let creditPurchases = 0;
  let creditExpenses = 0;
  let payments = 0;
  let loanIn = 0;
  let loanOut = 0;

  for (const transaction of transactions) {
    if (isExcludedTxn(transaction)) continue;

    const type = normType(transaction?.type);
    const mode = normMode(transaction?.mode || transaction?.paymentMode);
    const amount = txnAmount(transaction);

    if (isLoanTxn(transaction)) {
      if (type === "receipt") loanIn += amount;
      else if (type === "payment") loanOut += amount;
      continue;
    }

    if (type === "sales" && mode === "credit") creditSales += amount;
    else if (type === "receipt") receipts += amount;
    else if (type === "purchase" && mode === "credit") creditPurchases += amount;
    else if (type === "expense" && mode === "credit") creditExpenses += amount;
    else if (type === "payment") payments += amount;
  }

  return {
    receivable: creditSales - receipts,
    payable: creditPurchases + creditExpenses - payments,
    loanOutstanding: loanIn - loanOut,
  };
}

/**
 * Balance relevant to the payment/receipt form.
 * @returns {{ label: string, current: number, after: number, kind: string }}
 */
export function resolveFormPartyBalance({
  balances,
  entryMode,
  category,
  amount = 0,
}) {
  const isLoan = String(category || "").toUpperCase() === "LOAN";
  const parsedAmount = Math.max(0, num(amount));
  const isReceipt = entryMode === "receipt";

  if (isLoan) {
    const current = num(balances?.loanOutstanding);
    const after = isReceipt
      ? current + parsedAmount
      : current - parsedAmount;
    return {
      kind: "loan",
      label: "Loan outstanding",
      current,
      after,
    };
  }

  if (isReceipt) {
    const current = num(balances?.receivable);
    return {
      kind: "receivable",
      label: "Receivable (they owe you)",
      current,
      after: current - parsedAmount,
    };
  }

  const current = num(balances?.payable);
  return {
    kind: "payable",
    label: "Payable (you owe them)",
    current,
    after: current - parsedAmount,
  };
}
