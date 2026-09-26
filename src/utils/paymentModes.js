/**
 * Shared payment-mode helpers for multi-bank-account support.
 *
 * Dropdown values for specific accounts use `BANK:<accountId>`.
 * Persisted paymentMode on source docs is `BANK` + `bankAccountId`.
 * Transaction `mode` normalizes to `bank_transfer` so EOD keeps one Bank Balance.
 */

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
 * Build dropdown options: Cash (+ optional Petty/Credit), then active banks.
 * Card/QR are omitted — pick a bank account so the destination is unambiguous.
 * Legacy Card/QR/Bank Transfer can be shown only when editing an old saved value.
 */
export function buildPaymentModeOptions({
  bankAccounts = [],
  includeCredit = false,
  includePettyCash = false,
  includeLegacyBankTransfer = false,
  includeLegacyCard = false,
  includeLegacyQr = false,
} = {}) {
  const options = [{ value: "CASH", label: "Cash" }];
  if (includePettyCash) {
    options.push({ value: "PETTY_CASH", label: "Petty Cash" });
  }

  for (const account of bankAccounts) {
    if (!account?.id) continue;
    if (account.isActive === false) continue;
    options.push({
      value: bankAccountOptionValue(account.id),
      label: `Bank: ${account.accountName || "Account"}`,
    });
  }

  if (includeLegacyCard) {
    options.push({ value: "CARD", label: "Card (Legacy)" });
  }
  if (includeLegacyQr) {
    options.push({ value: "QR", label: "QR (Legacy)" });
  }
  if (includeLegacyBankTransfer) {
    options.push({
      value: "BANK_TRANSFER",
      label: "Bank Transfer (Legacy)",
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
