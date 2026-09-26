import { Timestamp } from "firebase/firestore";

export const TRANSACTION_SCHEMA_VERSION = 1;

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value) {
  return String(value ?? "").trim();
}

export function normalizeTransactionType(value) {
  const type = text(value).toLowerCase();
  if (type.startsWith("sal")) return "sales";
  if (type.startsWith("pur")) return "purchase";
  if (type.startsWith("rec")) return "receipt";
  if (type.startsWith("pay")) return "payment";
  if (type.startsWith("exp")) return "expense";
  if (type.startsWith("inc")) return "income";
  if (type.startsWith("tra")) return "transfer";
  if (type.startsWith("ref")) return "refill";
  return type;
}

export function normalizeTransactionMode(value) {
  const mode = text(value).toLowerCase();
  if (mode.startsWith("cas")) return "cash";
  if (mode.startsWith("car")) return "card";
  if (mode.startsWith("qr") || mode.startsWith("upi")) return "qr";
  // Bank, Bank Transfer, Bank: Salary Account, BANK:<id>
  if (
    mode === "bank" ||
    mode.startsWith("bank:") ||
    mode.startsWith("bank_transfer") ||
    mode.startsWith("ban")
  ) {
    return "bank_transfer";
  }
  if (mode.startsWith("cre")) return "credit";
  if (mode.includes("petti") || mode.includes("petty")) return "petti";
  if (mode.includes("locker") || mode.includes("lokker") || mode.includes("loker")) {
    return "locker";
  }
  if (mode.startsWith("sys")) return "system";
  return mode;
}

/** True when mode is any bank-rail tender (card/QR/bank/account). */
export function isBankRailMode(value) {
  const mode = normalizeTransactionMode(value);
  return mode === "card" || mode === "qr" || mode === "bank_transfer";
}

export function toBusinessDate(value) {
  if (value instanceof Timestamp) return value;
  if (value?.toDate instanceof Function) return Timestamp.fromDate(value.toDate());
  if (value instanceof Date) return Timestamp.fromDate(value);

  if (typeof value === "string") {
    const date = new Date(`${value.slice(0, 10)}T12:00:00`);
    if (!Number.isNaN(date.getTime())) return Timestamp.fromDate(date);
  }

  if (typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return Timestamp.fromDate(date);
  }

  throw new Error("A valid transaction business date is required.");
}

export function calculateTransactionFlow({ type, totalAmount }) {
  const typeKey = normalizeTransactionType(type);
  const total = num(totalAmount);

  if (typeKey === "sales" || typeKey === "receipt" || typeKey === "income") {
    return { amountIn: total, amountOut: 0 };
  }
  if (typeKey === "purchase" || typeKey === "payment" || typeKey === "expense") {
    return { amountIn: 0, amountOut: total };
  }
  return { amountIn: 0, amountOut: 0 };
}

/**
 * Canonical shape for every new accounting event.
 * Server timestamps and actor fields are supplied by the caller so this helper
 * can be used by addDoc, write batches, and Firestore transactions.
 */
export function buildTransactionPayload(input) {
  const businessDate = toBusinessDate(input.date);
  const totalAmount = num(input.totalAmount);
  const explicitFlow =
    input.amountIn !== undefined || input.amountOut !== undefined
      ? { amountIn: num(input.amountIn), amountOut: num(input.amountOut) }
      : calculateTransactionFlow({
          type: input.type,
          mode: input.mode,
          totalAmount,
        });

  return {
    schemaVersion: TRANSACTION_SCHEMA_VERSION,
    clientId: text(input.clientId),
    date: businessDate,
    dateMs: businessDate.toMillis(),

    type: normalizeTransactionType(input.type),
    category: text(input.category),
    mode: normalizeTransactionMode(input.mode),

    partyType: text(input.partyType) || "Other",
    partyId: input.partyId ? text(input.partyId) : null,
    partyName: text(input.partyName),
    description: text(input.description),

    amountBeforeTax: num(input.amountBeforeTax),
    vatPercent: num(input.vatPercent),
    taxAmount: num(input.taxAmount),
    totalAmount,
    amountIn: explicitFlow.amountIn,
    amountOut: explicitFlow.amountOut,

    discountEnabled: Boolean(input.discountEnabled),
    discountPct: num(input.discountPct),
    discountAmount: num(input.discountAmount),
    discountType: text(input.discountType).toLowerCase(),
    discountSide: text(input.discountSide).toLowerCase(),

    status: text(input.status || "POSTED").toUpperCase(),
    source: text(input.source || "manual").toLowerCase(),
    refType: text(input.refType),
    refId: text(input.refId),
    shiftId: text(input.shiftId),
    reversalOf: text(input.reversalOf),
    invoiceNo: text(input.invoiceNo),
    orderType: text(input.orderType),
    internalTransfer: Boolean(input.internalTransfer),
    sourceMode: input.sourceMode
      ? normalizeTransactionMode(input.sourceMode)
      : "",
    destinationMode: input.destinationMode
      ? normalizeTransactionMode(input.destinationMode)
      : "",
    transferType: text(input.transferType),
    bankAccountId: text(input.bankAccountId),
    bankAccountName: text(input.bankAccountName),
    destinationBankAccountId: text(input.destinationBankAccountId),
    destinationBankAccountName: text(input.destinationBankAccountName),
  };
}
