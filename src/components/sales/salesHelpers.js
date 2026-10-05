/** Shared display helpers for sales layout components. */

import {
  formatMoney,
  numMoney,
  roundMoney as roundMoneyAmount,
} from "../../utils/money.js";

export function num(v) {
  return numMoney(v);
}

export function money(v, decimals) {
  return formatMoney(v, decimals);
}

export function roundMoney(v, decimals) {
  return roundMoneyAmount(v, decimals);
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
  decimals,
} = {}) {
  const total = roundMoney(grandTotal, decimals);

  if (String(settlement || "full").toLowerCase() !== "split") {
    const mode = String(paymentMode || "CASH").trim().toUpperCase() || "CASH";
    const isBank =
      mode === "BANK" ||
      mode === "BANK_TRANSFER" ||
      mode.startsWith("BANK:");
    const isCredit = mode === "CREDIT";
    const line = {
      key: isCredit ? "credit" : isBank ? "bank" : "cash",
      mode: isCredit ? "CREDIT" : isBank ? "BANK" : mode,
      bankAccountId: isBank ? String(bankAccountId || "").trim() : "",
      bankAccountName: isBank ? String(bankAccountName || "").trim() : "",
      amount: total,
    };
    // Keep a zero-amount line for FOC / free bills so payment mode is recorded.
    return total === 0 ? [line] : line.amount > 0 ? [line] : [];
  }

  const cash = roundMoney(cashAmount, decimals);
  const bank = roundMoney(bankAmount, decimals);
  const credit = roundMoney(creditAmount, decimals);
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

  // FOC / zero-total with Split selected still needs one tender line for save.
  if (total === 0 && lines.length === 0) {
    return [
      {
        key: "cash",
        mode: "CASH",
        bankAccountId: "",
        bankAccountName: "",
        amount: 0,
      },
    ];
  }

  return lines;
}

export function tenderTotals(tenders = [], decimals) {
  let cash = 0;
  let bank = 0;
  let credit = 0;
  for (const line of tenders) {
    const amount = roundMoney(line?.amount, decimals);
    const mode = String(line?.mode || "").toUpperCase();
    if (mode === "CREDIT") credit += amount;
    else if (mode === "BANK" || mode === "BANK_TRANSFER" || mode.startsWith("BANK:")) {
      bank += amount;
    } else cash += amount;
  }
  return {
    cash: roundMoney(cash, decimals),
    bank: roundMoney(bank, decimals),
    credit: roundMoney(credit, decimals),
    paid: roundMoney(cash + bank, decimals),
    allocated: roundMoney(cash + bank + credit, decimals),
  };
}

export function formatPaymentLabel(invoiceOrTenders, decimals) {
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
        return `${label} ${money(line.amount, decimals)}`;
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

export function calcLineTotal(qty, sellingPrice, taxPct, decimals) {
  return roundMoney(
    calcBaseTotal(qty, sellingPrice) + calcTaxAmount(qty, sellingPrice, taxPct),
    decimals
  );
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
