import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import { buildTransactionPayload } from "./transactionContract.js";
import { roundMoney } from "./money.js";

export function defaultOpeningBalanceSide(partyType) {
  const type = String(partyType || "").trim().toLowerCase();
  return type === "supplier" || type === "lender" ? "payable" : "receivable";
}

/**
 * Create/update/delete the seed credit transaction so opening balance
 * flows into party ledgers, receivables/payables, and payment forms.
 */
export async function syncPartyOpeningBalanceTxn({
  clientId,
  partyId,
  partyName,
  partyType,
  amount,
  side,
  date,
  existingTxnId = "",
  userId = "",
}) {
  const partyKey = String(partyId || "").trim();
  if (!clientId || !partyKey) {
    throw new Error("Party is required for opening balance.");
  }

  const parsed = roundMoney(amount);
  const txnId = String(existingTxnId || "").trim();

  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (txnId) {
      await deleteDoc(doc(db, "transactions", txnId));
    }
    return "";
  }

  const balanceSide =
    String(side || "").trim().toLowerCase() === "payable"
      ? "payable"
      : "receivable";
  const isReceivable = balanceSide === "receivable";

  const payload = {
    ...buildTransactionPayload({
      clientId,
      date,
      type: isReceivable ? "sales" : "purchase",
      category: "Opening Balance",
      mode: "CREDIT",
      partyType: partyType || (isReceivable ? "Customer" : "Supplier"),
      partyId: partyKey,
      partyName: String(partyName || "").trim(),
      description: "Opening balance",
      amountBeforeTax: parsed,
      totalAmount: parsed,
      status: "POSTED",
      source: "party_opening_balance",
      refType: "party",
      refId: partyKey,
    }),
    updatedBy: userId || null,
    updatedAt: serverTimestamp(),
  };

  if (txnId) {
    await updateDoc(doc(db, "transactions", txnId), payload);
    return txnId;
  }

  const created = await addDoc(collection(db, "transactions"), {
    ...payload,
    createdBy: userId || null,
    createdAt: serverTimestamp(),
    createdAtMs: Date.now(),
  });
  return created.id;
}

export async function deletePartyOpeningBalanceTxn(txnId) {
  const id = String(txnId || "").trim();
  if (!id) return;
  await deleteDoc(doc(db, "transactions", id));
}
