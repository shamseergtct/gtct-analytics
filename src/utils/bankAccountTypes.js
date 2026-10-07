/**
 * Bank account classification for selection control only.
 * Missing/unknown accountType is treated as OPERATIONAL (backward compatible).
 * Does not affect historical transactions or calculation logic.
 */

export const BANK_ACCOUNT_TYPE_OPERATIONAL = "OPERATIONAL";
export const BANK_ACCOUNT_TYPE_RESERVE = "RESERVE";

export const BANK_ACCOUNT_TYPES = [
  {
    value: BANK_ACCOUNT_TYPE_OPERATIONAL,
    label: "Operational Account",
    shortLabel: "Operational",
    description: "Used for normal business transactions and payments.",
  },
  {
    value: BANK_ACCOUNT_TYPE_RESERVE,
    label: "Reserve Account",
    shortLabel: "Reserve",
    description: "Used only for internal transfers.",
  },
];

/** Normalize stored value; missing field defaults to OPERATIONAL. */
export function normalizeBankAccountType(value) {
  const key = String(value || "")
    .trim()
    .toUpperCase();
  if (key === BANK_ACCOUNT_TYPE_RESERVE) return BANK_ACCOUNT_TYPE_RESERVE;
  return BANK_ACCOUNT_TYPE_OPERATIONAL;
}

export function isOperationalBankAccount(account) {
  return (
    normalizeBankAccountType(account?.accountType) ===
    BANK_ACCOUNT_TYPE_OPERATIONAL
  );
}

export function isReserveBankAccount(account) {
  return (
    normalizeBankAccountType(account?.accountType) === BANK_ACCOUNT_TYPE_RESERVE
  );
}

export function bankAccountTypeLabel(accountOrType) {
  const type =
    accountOrType && typeof accountOrType === "object"
      ? normalizeBankAccountType(accountOrType.accountType)
      : normalizeBankAccountType(accountOrType);
  return (
    BANK_ACCOUNT_TYPES.find((row) => row.value === type)?.shortLabel ||
    "Operational"
  );
}

/**
 * Filter accounts for a selection context.
 * - transaction: Operational only (Sales, Receipt, Payment, Expense, Purchase, Z, Collect, …)
 * - transfer: Operational + Reserve (Internal Transfer)
 * - all: no type filter (master lists / report filters)
 */
export function filterBankAccountsForPurpose(
  accounts = [],
  purpose = "transaction"
) {
  const list = Array.isArray(accounts) ? accounts : [];
  if (purpose === "all" || purpose === "transfer") return list;
  return list.filter((account) => isOperationalBankAccount(account));
}

/**
 * Validate a selected account for a purpose.
 * Returns { ok: true } or { ok: false, message }.
 */
export function validateBankAccountForPurpose(account, purpose = "transaction") {
  if (!account) {
    return {
      ok: false,
      message:
        purpose === "transaction"
          ? "Selected bank account is not available for this transaction. Reserve accounts can only be used for Internal Transfer."
          : "Selected bank account was not found.",
    };
  }
  if (purpose === "transfer" || purpose === "all") {
    return { ok: true };
  }
  if (!isOperationalBankAccount(account)) {
    return {
      ok: false,
      message:
        "Reserve accounts can only be used for Internal Transfer. Select an Operational Account.",
    };
  }
  return { ok: true };
}

export function findBankAccountById(accounts = [], bankAccountId) {
  const id = String(bankAccountId || "").trim();
  if (!id) return null;
  return accounts.find((account) => account.id === id) || null;
}

/** Convenience check for normal transaction saves (Sales, Receipt, etc.). */
export function assertOperationalBankAccount(accounts, bankAccountId) {
  const id = String(bankAccountId || "").trim();
  if (!id) return { ok: true };
  return validateBankAccountForPurpose(
    findBankAccountById(accounts, id),
    "transaction"
  );
}
