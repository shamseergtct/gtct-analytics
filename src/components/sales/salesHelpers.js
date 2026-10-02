/** Shared display helpers for sales layout components. */

export function num(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

export function money(v) {
  return num(v).toFixed(2);
}

export function roundMoney(v) {
  return Math.round(num(v) * 100) / 100;
}

/** Stable Firestore id for a POS tender line on an invoice. */
export function saleTenderTxnId(invoiceId, modeKey) {
  const key = String(modeKey || "cash").toLowerCase();
  return `sales_invoice_${invoiceId}_${key}`;
}

/**
 * Resolve cash / bank / credit tender lines for a sale.
 * Full settlement → one line for the selected payment mode.
 * Split / partial → non-zero cash, bank, and credit amounts (must sum to total).
 */
export function resolveSaleTenders({
  settlement = "full",
  paymentMode,
  bankAccountId = "",
  bankAccountName = "",
  cashAmount = 0,
  bankAmount = 0,
  creditAmount = 0,
  grandTotal = 0,
} = {}) {
  const total = roundMoney(grandTotal);

  if (String(settlement || "full").toLowerCase() !== "split") {
    const mode = String(paymentMode || "CASH").trim().toUpperCase() || "CASH";
    const isBank =
      mode === "BANK" ||
      mode === "BANK_TRANSFER" ||
      mode.startsWith("BANK:");
    const isCredit = mode === "CREDIT";
    return [
      {
        key: isCredit ? "credit" : isBank ? "bank" : "cash",
        mode: isCredit ? "CREDIT" : isBank ? "BANK" : mode,
        bankAccountId: isBank ? String(bankAccountId || "").trim() : "",
        bankAccountName: isBank ? String(bankAccountName || "").trim() : "",
        amount: total,
      },
    ].filter((line) => line.amount > 0);
  }

  const cash = roundMoney(cashAmount);
  const bank = roundMoney(bankAmount);
  const credit = roundMoney(creditAmount);
  const lines = [];

  if (cash > 0) {
    lines.push({
      key: "cash",
      mode: "CASH",
      bankAccountId: "",
      bankAccountName: "",
      amount: cash,
    });
  }
  if (bank > 0) {
    lines.push({
      key: "bank",
      mode: "BANK",
      bankAccountId: String(bankAccountId || "").trim(),
      bankAccountName: String(bankAccountName || "").trim(),
      amount: bank,
    });
  }
  if (credit > 0) {
    lines.push({
      key: "credit",
      mode: "CREDIT",
      bankAccountId: "",
      bankAccountName: "",
      amount: credit,
    });
  }

  return lines;
}

export function tenderTotals(tenders = []) {
  let cash = 0;
  let bank = 0;
  let credit = 0;
  for (const line of tenders) {
    const amount = roundMoney(line?.amount);
    const mode = String(line?.mode || "").toUpperCase();
    if (mode === "CREDIT") credit += amount;
    else if (mode === "BANK" || mode === "BANK_TRANSFER" || mode.startsWith("BANK:")) {
      bank += amount;
    } else cash += amount;
  }
  return {
    cash: roundMoney(cash),
    bank: roundMoney(bank),
    credit: roundMoney(credit),
    paid: roundMoney(cash + bank),
    allocated: roundMoney(cash + bank + credit),
  };
}

export function formatPaymentLabel(invoiceOrTenders) {
  const tenders = Array.isArray(invoiceOrTenders)
    ? invoiceOrTenders
    : Array.isArray(invoiceOrTenders?.paymentTenders)
      ? invoiceOrTenders.paymentTenders
      : null;

  if (tenders?.length) {
    return tenders
      .map((line) => {
        const mode = String(line.mode || "").toUpperCase();
        const label =
          mode === "CREDIT"
            ? "Credit"
            : mode === "BANK" || mode === "BANK_TRANSFER" || mode.startsWith("BANK:")
              ? line.bankAccountName
                ? `Bank (${line.bankAccountName})`
                : "Bank"
              : mode === "CARD"
                ? "Card"
                : mode === "QR"
                  ? "QR"
                  : "Cash";
        return `${label} ${money(line.amount)}`;
      })
      .join(" + ");
  }

  const mode = String(
    invoiceOrTenders?.paymentMode || invoiceOrTenders || "-"
  ).trim();
  return mode || "-";
}

export function calcBaseTotal(qty, sellingPrice) {
  return Math.max(0, num(qty) * num(sellingPrice));
}

export function calcTaxAmount(qty, sellingPrice, taxPct) {
  const base = calcBaseTotal(qty, sellingPrice);
  return Math.max(0, (base * num(taxPct)) / 100);
}

export function calcLineTotal(qty, sellingPrice, taxPct) {
  return calcBaseTotal(qty, sellingPrice) + calcTaxAmount(qty, sellingPrice, taxPct);
}

export function getItemBaseCode(item) {
  return item?.itemCode || item?.code || item?.sku || "";
}

export function getItemBarcode(item) {
  return String(item?.barcode || "").trim();
}

/** Case-insensitive exact match for scanner Enter (item code or inventory barcode). */
export function itemMatchesScanCode(item, code) {
  const q = String(code || "").trim().toLowerCase();
  if (!q || !item) return false;
  const base = getItemBaseCode(item).trim().toLowerCase();
  const barcode = getItemBarcode(item).toLowerCase();
  return base === q || (barcode.length > 0 && barcode === q);
}

export function itemMatchesSearchQuery(item, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return false;
  const hay = `${getItemBaseCode(item)} ${item?.itemName || ""} ${getItemBarcode(item)}`.toLowerCase();
  return hay.includes(q);
}

export function unitsPerCarton(item) {
  const raw =
    item?.unitsPerCarton ??
    item?.pcsPerCarton ??
    item?.cartonSize ??
    item?.packSize ??
    12;
  const n = num(raw);
  return n > 0 ? n : 12;
}

export function itemWholesalePrice(item) {
  const wholesale = num(item?.wholesalePrice ?? item?.wholesale_price);
  if (wholesale > 0) return wholesale;
  return num(item?.sellingPrice);
}

export function itemRetailPrice(item) {
  return num(item?.sellingPrice);
}
