/**
 * Shared payment-mode helpers for multi-bank-account support.
 *
 * Dropdown values for specific accounts use `BANK:<accountId>`.
 * Persisted paymentMode on source docs is `BANK` + `bankAccountId`.
 * Transaction `mode` normalizes to `bank_transfer` so EOD keeps one Bank Balance.
 *
 * Bank account options default to Operational accounts only.
 * Reserve accounts are excluded unless includeReserveAccounts is true.
 */

import { isOperationalBankAccount } from "./bankAccountTypes.js";

export const BANK_ACCOUNT_PREFIX = "BANK:";

export function bankAccountOptionValue(accountId) {
  return `${BANK_ACCOUNT_PREFIX}${String(accountId || "").trim()}`;
}

export function isBankAccountSelection(value) {
  const key = String(value || "").trim().toUpperCase();
  return key.startsWith("BANK:");
}

export function parsePaymentModeSelection(value) {
  const raw = String(value || "").trim();
  const upper = raw.toUpperCase();

  if (upper.startsWith("BANK:")) {
    const bankAccountId = raw.slice(raw.indexOf(":") + 1).trim();
    return {
      selectionValue: raw,
      paymentMode: "BANK",
      bankAccountId,
      isBankAccount: true,
    };
  }

  if (upper === "BANK") {
    return {
      selectionValue: raw,
      paymentMode: "BANK",
      bankAccountId: "",
      isBankAccount: true,
    };
  }

  if (upper === "BANK_TRANSFER") {
    return {
      selectionValue: raw,
      paymentMode: "BANK_TRANSFER",
      bankAccountId: "",
      isBankAccount: true,
    };
  }

  return {
    selectionValue: raw,
    paymentMode: raw,
    bankAccountId: "",
    isBankAccount: false,
  };
}

export function paymentModeSelectionFromSaved(paymentMode, bankAccountId) {
  const id = String(bankAccountId || "").trim();
  if (id) return bankAccountOptionValue(id);
  const mode = String(paymentMode || "").trim();
  if (!mode) return "CASH";
  if (mode.toUpperCase() === "BANK") return "BANK_TRANSFER";
  return mode;
}

/**
 * Build dropdown options for payment mode.
 * Base: Cash. Optional Card / QR / Petti / Bank Transfer / Credit, then active banks.
 * Legacy Card/QR/Bank Transfer can also be forced when editing an old saved value.
 */
export function buildPaymentModeOptions({
  bankAccounts = [],
  includeCredit = false,
  includePettyCash = false,
  includeCard = false,
  includeQr = false,
  includeBankTransfer = false,
  includeLegacyBankTransfer = false,
  includeLegacyCard = false,
  includeLegacyQr = false,
  includeReserveAccounts = false,
} = {}) {
  const options = [{ value: "CASH", label: "Cash" }];

  if (includeCard || includeLegacyCard) {
    options.push({
      value: "CARD",
      label: includeCard ? "Card" : "Card (Legacy)",
    });
  }
  if (includeQr || includeLegacyQr) {
    options.push({
      value: "QR",
      label: includeQr ? "QR" : "QR (Legacy)",
    });
  }
  if (includePettyCash) {
    options.push({ value: "PETTI", label: "Petti Cash" });
  }
  if (includeBankTransfer || includeLegacyBankTransfer) {
    options.push({
      value: "BANK_TRANSFER",
      label: includeBankTransfer ? "Bank Transfer" : "Bank Transfer (Legacy)",
    });
  }

  for (const account of bankAccounts) {
    if (!account?.id) continue;
    if (account.isActive === false) continue;
    if (!includeReserveAccounts && !isOperationalBankAccount(account)) continue;
    options.push({
      value: bankAccountOptionValue(account.id),
      label: account.accountName || "Account",
    });
  }

  if (includeCredit) {
    options.push({ value: "CREDIT", label: "Credit" });
  }

  return options;
}

/** Flags for showing legacy payment modes while editing historical rows. */
export function legacyPaymentModeFlags(selectionValue) {
  const key = String(selectionValue || "").trim().toUpperCase();
  return {
    includeLegacyCard: key === "CARD",
    includeLegacyQr: key === "QR",
    includeLegacyBankTransfer: key === "BANK_TRANSFER",
  };
}

export function findBankAccountName(bankAccounts, bankAccountId) {
  const id = String(bankAccountId || "").trim();
  if (!id) return "";
  const match = bankAccounts.find((account) => account.id === id);
  return String(match?.accountName || "").trim();
}
