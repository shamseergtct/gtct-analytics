/**
 * Shared POS invoice create path (immediate bill).
 * Logic mirrors Sales.jsx finishAndBilling create branch — keep in sync when editing either.
 */
import {
  collection,
  doc,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import {
  isDirectSaleItem,
  isInventoryItemActive,
  resolveSaleTenders,
  saleTenderTxnId,
  tenderTotals,
} from "../components/sales/salesHelpers.js";
import { buildTransactionPayload } from "./transactionContract.js";
import { assertOperationalBankAccount } from "./bankAccountTypes.js";
import { findBankAccountName } from "./paymentModes.js";
import { formatMoney, numMoney, roundMoney, toMinorUnits } from "./money.js";

function num(v) {
  return numMoney(v);
}

function dateStrToMsMidday(dateStr) {
  if (!dateStr) return Date.now();
  const d = new Date(`${dateStr}T12:00:00`);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function quantitiesByItem(rows) {
  const totals = new Map();
  for (const row of rows || []) {
    if (!row?.itemId) continue;
    totals.set(row.itemId, num(totals.get(row.itemId)) + num(row.qty));
  }
  return totals;
}

/**
 * Create a new POS sales invoice + tenders + stock (no edit/cancel).
 * @returns {{ invoiceId: string, invoicePayload: object }}
 */
export async function submitPosSaleInvoice({
  user,
  clientId,
  clientName = "",
  activeShift,
  bankAccounts = [],
  cart = [],
  totals,
  invoiceNo,
  orderType = "COUNTER",
  destinationNote = "",
  paymentMode = "CASH",
  bankAccountId = "",
  bankAccountName = "",
  settlementMode = "full",
  payCash = "",
  payBank = "",
  payCredit = "",
  customerId = null,
  customerName = "",
  customerPhone = "",
  address1 = "",
  address2 = "",
  address3 = "",
  printerMode = "THERMAL",
  decimals,
  entrySource = "pos",
  allowCredit = true,
  /** When false (Restaurant Sales), allow sale even if stock would go negative. */
  enforceStockAvailability = true,
}) {
  if (!clientId) throw new Error("Select an active shop first.");
  if (!activeShift?.id || activeShift.status !== "OPEN") {
    throw new Error("Open a shift before recording a POS sale.");
  }
  if (!String(invoiceNo || "").trim()) {
    throw new Error("Invoice No required.");
  }
  if (!cart.length) throw new Error("Add at least one item.");
  if (cart.some((item) => num(item.qty) <= 0)) {
    throw new Error("Every item quantity must be greater than zero.");
  }
  if (cart.some((item) => num(item.sellingPrice) < 0)) {
    throw new Error("Every item Selling Price must be zero or greater.");
  }

  const saleTenders = resolveSaleTenders({
    settlement: settlementMode,
    paymentMode,
    bankAccountId,
    bankAccountName:
      bankAccountName || findBankAccountName(bankAccounts, bankAccountId),
    cashAmount: payCash,
    bankAmount: payBank,
    creditAmount: payCredit,
    grandTotal: totals.grandTotal,
    decimals,
  });
  const tenderSummary = tenderTotals(saleTenders, decimals);
  const grandRounded = roundMoney(totals.grandTotal, decimals);

  if (!allowCredit && tenderSummary.credit > 0) {
    throw new Error("Credit sales are not available in Restaurant Sales.");
  }

  if (grandRounded > 0 && saleTenders.length === 0) {
    throw new Error("Enter at least one payment amount.");
  }
  if (
    toMinorUnits(tenderSummary.allocated, decimals) !==
    toMinorUnits(grandRounded, decimals)
  ) {
    throw new Error(
      `Payment amounts must equal total (${formatMoney(
        grandRounded,
        decimals
      )}). Allocated ${formatMoney(tenderSummary.allocated, decimals)}.`
    );
  }
  if (tenderSummary.bank > 0 && !String(bankAccountId || "").trim()) {
    throw new Error("Select a bank account for bank payments.");
  }
  if (tenderSummary.bank > 0 && bankAccountId) {
    const bankCheck = assertOperationalBankAccount(bankAccounts, bankAccountId);
    if (!bankCheck.ok) throw new Error(bankCheck.message);
  }
  if (tenderSummary.credit > 0 && !customerId && !String(customerName || "").trim()) {
    throw new Error(
      "Credit sale requires a customer. Select or enter a customer."
    );
  }
  if (orderType === "DELIVERY") {
    if (!String(customerName || "").trim()) {
      throw new Error("Delivery: Customer Name is required.");
    }
    if (!String(customerPhone || "").trim()) {
      throw new Error("Delivery: Mobile Number is required.");
    }
    if (!String(address1 || "").trim()) {
      throw new Error("Delivery: Address 1 is required.");
    }
  }

  const lockedSaleDate = activeShift.businessDate;
  const chosenMs = dateStrToMsMidday(lockedSaleDate);
  const linkedCustomerId = customerId || null;

  if (tenderSummary.credit > 0 && !linkedCustomerId) {
    throw new Error(
      "Credit sale requires a saved customer. Select a customer from the list."
    );
  }

  const invoiceRef = doc(collection(db, "sales_invoices"));
  const shiftRef = doc(db, "shifts", activeShift.id);
  const primaryMode =
    saleTenders.length === 1 ? saleTenders[0].mode : "SPLIT";
  const primaryBank = saleTenders.find((line) => line.key === "bank") || null;
  const primaryAccountingRef = doc(
    db,
    "transactions",
    saleTenderTxnId(invoiceRef.id, saleTenders[0].key)
  );

  const tenderPayloads = saleTenders.map((line) => {
    const txnRef = doc(
      db,
      "transactions",
      saleTenderTxnId(invoiceRef.id, line.key)
    );
    return {
      ref: txnRef,
      line,
      payload: buildTransactionPayload({
        clientId,
        date: lockedSaleDate,
        type: "sales",
        category: "Sales",
        mode: line.mode,
        bankAccountId: line.bankAccountId || "",
        bankAccountName: line.bankAccountName || "",
        partyType: "Customer",
        partyId: linkedCustomerId,
        partyName: String(customerName || "").trim() || "Walk-in",
        description: `Sales invoice ${String(invoiceNo).trim()}`,
        amountBeforeTax: line.amount,
        taxAmount: 0,
        totalAmount: line.amount,
        source: "pos",
        refType: "sales_invoice",
        refId: invoiceRef.id,
        shiftId: activeShift.id,
        invoiceNo: String(invoiceNo).trim(),
        orderType,
        status: "POSTED",
      }),
    };
  });

  const dest = String(destinationNote || "").trim();
  const invoicePayload = {
    clientId,
    clientName: clientName || "",
    invoiceNo: String(invoiceNo).trim(),
    saleAtMs: chosenMs,
    saleAt: tenderPayloads[0].payload.date,
    customerId: linkedCustomerId || null,
    customerName: String(customerName || "").trim() || "",
    customerPhone: String(customerPhone || "").trim() || "",
    address1: String(address1 || "").trim() || "",
    address2: String(address2 || "").trim() || "",
    address3: String(address3 || "").trim() || "",
    destinationNote: dest,
    orderType,
    paymentMode: primaryMode,
    bankAccountId: primaryBank?.bankAccountId || "",
    bankAccountName: primaryBank?.bankAccountName || "",
    paymentTenders: saleTenders.map((line) => ({
      mode: line.mode,
      amount: line.amount,
      bankAccountId: line.bankAccountId || "",
      bankAccountName: line.bankAccountName || "",
    })),
    settlementMode: saleTenders.length > 1 ? "split" : "full",
    amountPaid: tenderSummary.paid,
    amountCredit: tenderSummary.credit,
    balanceDue: tenderSummary.credit,
    printerMode,
    subTotal: totals.subTotal,
    discountTotal: totals.discountTotal,
    taxType: "ITEM_WISE",
    taxAmount: totals.taxAmount,
    grandTotalBeforeTax: totals.grandTotalBeforeTax,
    grandTotal: totals.grandTotal,
    itemCount: cart.length,
    status: "ACTIVE",
    stockPosted: true,
    shiftId: activeShift.id,
    accountingTransactionId: primaryAccountingRef.id,
    entrySource: entrySource || "pos",
    updatedAt: serverTimestamp(),
    updatedAtMs: Date.now(),
    updatedBy: user?.uid || null,
  };

  const itemsCol = collection(db, "sales_invoices", invoiceRef.id, "items");
  const newLineRefs = cart.map(() => doc(itemsCol));
  const newQty = quantitiesByItem(cart);
  const itemIds = [...newQty.keys()];
  const itemRefs = itemIds.map((id) => doc(db, "inventory", id));
  const movementRefs = itemIds.map(() =>
    doc(collection(db, "inventory_movements"))
  );

  await runTransaction(db, async (tx) => {
    const shiftSnap = await tx.get(shiftRef);
    const inventorySnaps = [];
    for (const itemRef of itemRefs) {
      inventorySnaps.push(await tx.get(itemRef));
    }
    const tenderSnaps = [];
    for (const entry of tenderPayloads) {
      tenderSnaps.push(await tx.get(entry.ref));
    }

    if (
      !shiftSnap.exists() ||
      shiftSnap.data()?.status !== "OPEN" ||
      shiftSnap.data()?.clientId !== clientId
    ) {
      throw new Error("The active shift is no longer open.");
    }

    inventorySnaps.forEach((snap, index) => {
      if (!snap.exists()) {
        throw new Error(`Inventory item not found: ${itemIds[index]}`);
      }
      if (snap.data()?.clientId !== clientId) {
        throw new Error("Inventory item belongs to another client.");
      }
      if (!isInventoryItemActive(snap.data())) {
        throw new Error(
          `${snap.data()?.itemName || itemIds[index]} is inactive and cannot be sold.`
        );
      }
      const itemId = itemIds[index];
      const deductedQty = isDirectSaleItem(snap.data())
        ? num(newQty.get(itemId))
        : 0;
      if (deductedQty === 0) return;
      const nextStock = num(snap.data()?.currentStock) - deductedQty;
      if (enforceStockAvailability && nextStock < 0) {
        throw new Error(
          `Insufficient stock for ${snap.data()?.itemName || itemId}.`
        );
      }
    });

    tx.set(invoiceRef, {
      ...invoicePayload,
      createdAt: serverTimestamp(),
      createdAtMs: Date.now(),
      createdBy: user?.uid || null,
    });

    cart.forEach((row, idx) => {
      tx.set(newLineRefs[idx], {
        clientId,
        invoiceId: invoiceRef.id,
        invoiceNo: invoicePayload.invoiceNo,
        saleAtMs: chosenMs,
        sn: idx + 1,
        itemId: row.itemId,
        itemCode: row.itemCode || "",
        itemName: row.itemName || "",
        qty: num(row.qty),
        cost: num(row.cost),
        sellingPrice: num(row.sellingPrice),
        taxPct: num(row.taxPct),
        baseTotal: num(row.baseTotal),
        taxAmount: num(row.taxAmount),
        total: num(row.total),
        description: row.description || "",
        createdAt: serverTimestamp(),
        createdBy: user?.uid || null,
      });
    });

    inventorySnaps.forEach((snap, index) => {
      const itemId = itemIds[index];
      const deductedQty = isDirectSaleItem(snap.data())
        ? num(newQty.get(itemId))
        : 0;
      if (deductedQty === 0) return;

      const currentStock = num(snap.data()?.currentStock);
      const nextStock = currentStock - deductedQty;
      // Restaurant path may sell without stock; never write negative stock
      // (staff rules require currentStock >= 0 and a strict decrease).
      if (nextStock >= 0) {
        tx.update(itemRefs[index], {
          currentStock: nextStock,
          updatedAt: serverTimestamp(),
          updatedBy: user?.uid || null,
        });
      } else if (currentStock > 0) {
        tx.update(itemRefs[index], {
          currentStock: 0,
          updatedAt: serverTimestamp(),
          updatedBy: user?.uid || null,
        });
      }

      const representative =
        cart.find((row) => row.itemId === itemId) || {};
      tx.set(movementRefs[index], {
        clientId,
        itemId,
        itemName: representative.itemName || snap.data()?.itemName || "",
        itemCode: representative.itemCode || "",
        type: "OUT",
        qty: deductedQty,
        rate: num(representative.sellingPrice),
        amount: deductedQty * num(representative.sellingPrice),
        reason: "SALE",
        refType: "sales_invoice",
        refId: invoiceRef.id,
        shiftId: activeShift.id,
        invoiceNo: invoicePayload.invoiceNo,
        date: tenderPayloads[0].payload.date,
        dateMs: chosenMs,
        createdAt: serverTimestamp(),
        createdBy: user?.uid || null,
      });
    });

    tenderPayloads.forEach((entry, index) => {
      const snap = tenderSnaps[index];
      tx.set(entry.ref, {
        ...entry.payload,
        createdAt: serverTimestamp(),
        createdBy: user?.uid || null,
        createdAtMs: Date.now(),
        updatedAt: serverTimestamp(),
        updatedBy: user?.uid || null,
      });
      void snap;
    });
  });

  return { invoiceId: invoiceRef.id, invoicePayload };
}

export function makePosInvoiceNo() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `INV-${y}${m}${day}-${hh}${mm}`;
}
