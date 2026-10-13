import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { copyTextToClipboard } from "./clipboard.js";
import { baseCostFromPurchaseUnitRate } from "./inventoryPack.js";
import { numMoney } from "./money.js";

export const PO_STATUS = {
  DRAFT: "DRAFT",
  SENT: "SENT",
  PARTIALLY_RECEIVED: "PARTIALLY_RECEIVED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

export const PO_STATUS_META = {
  DRAFT: { label: "Draft", className: "text-amber-200" },
  SENT: { label: "Sent", className: "text-emerald-200" },
  PARTIALLY_RECEIVED: {
    label: "To be received",
    className: "text-orange-200",
  },
  COMPLETED: { label: "Completed", className: "text-sky-200" },
  CANCELLED: { label: "Cancelled", className: "text-slate-400" },
};

/** Leftover handling after a partial receive. */
export const PO_LEFTOVER_ACTION = {
  KEEP: "keep",
  REMOVE: "remove",
};

/**
 * Purchase-unit qty used for pricing.
 * Box and pcs are additive: 1 box + 2 pcs = 1 box + (2 / pack size) boxes.
 */
export function billablePurchaseQty(row = {}) {
  const qty = Math.max(0, numMoney(row.qty));
  const subUnitQty = Math.max(0, numMoney(row.subUnitQty));
  const subQty = numMoney(row.subQty);
  let fromPcs = 0;
  if (subUnitQty > 0) {
    fromPcs = subQty > 0 ? numMoney(subUnitQty / subQty) : subUnitQty;
  }
  return numMoney(qty + fromPcs);
}

export function poLineTotal(row = {}) {
  const unitRate = Math.max(0, numMoney(row.unitRate ?? row.cost ?? 0));
  return numMoney(billablePurchaseQty(row) * unitRate);
}

/**
 * Received qty → on-hand base stock.
 * With pack: (boxes * subQty) + pcs. Without pack: qty (+ optional pcs).
 */
export function poReceivedBaseQty(row = {}) {
  const qty = Math.max(0, numMoney(row.receivedQty ?? row.qty));
  const subUnitQty = Math.max(
    0,
    numMoney(row.receivedSubUnitQty ?? row.subUnitQty)
  );
  const subQty = numMoney(row.subQty);
  if (subQty > 0) return numMoney(qty * subQty + subUnitQty);
  return numMoney(qty + subUnitQty);
}

/** Ordered open qty still waiting (purchase + sub units). */
export function poLinePendingQty(row = {}) {
  const orderedQty = Math.max(0, numMoney(row.qty));
  const orderedSub = Math.max(0, numMoney(row.subUnitQty));
  const receivedQty = Math.max(0, numMoney(row.receivedQty));
  const receivedSub = Math.max(0, numMoney(row.receivedSubUnitQty));
  return {
    pendingQty: Math.max(0, numMoney(orderedQty - receivedQty)),
    pendingSubUnitQty: Math.max(0, numMoney(orderedSub - receivedSub)),
  };
}

export function poLineHasPending(row = {}) {
  const { pendingQty, pendingSubUnitQty } = poLinePendingQty(row);
  return pendingQty > 0 || pendingSubUnitQty > 0;
}

export function formatPoQtyBits(row = {}, { qtyKey = "qty", subKey = "subUnitQty" } = {}) {
  const qty = Math.max(0, numMoney(row[qtyKey]));
  const subUnitQty = Math.max(0, numMoney(row[subKey]));
  const purchaseUnit =
    String(row.purchaseUnit || row.unit || "").trim() || "qty";
  const baseUnit = String(row.baseUnit || "pcs").trim() || "pcs";
  const bits = [];
  if (qty > 0) bits.push(`${qty} ${purchaseUnit}`);
  if (subUnitQty > 0) bits.push(`${subUnitQty} ${baseUnit}`);
  return bits.length ? bits.join(", ") : "0";
}

export function normalizePoLine(raw = {}) {
  const qty = numMoney(raw.qty);
  const subUnitQty = Math.max(0, numMoney(raw.subUnitQty));
  const unitRate = Math.max(0, numMoney(raw.unitRate ?? raw.cost ?? 0));
  const purchaseUnit = String(raw.purchaseUnit || "").trim();
  const baseUnit = String(raw.baseUnit || "").trim();
  const subQty = Math.max(0, numMoney(raw.subQty));
  const line = {
    itemId: String(raw.itemId || "").trim(),
    itemCode: String(raw.itemCode || "").trim(),
    itemName: String(raw.itemName || "").trim(),
    qty,
    subUnitQty,
    unitRate,
    unit: String(raw.unit || purchaseUnit || baseUnit || "").trim(),
    purchaseUnit,
    baseUnit,
    subQty,
    notes: String(raw.notes || "").trim().slice(0, 200),
  };
  const receivedQty = Math.max(0, numMoney(raw.receivedQty));
  const receivedSubUnitQty = Math.max(0, numMoney(raw.receivedSubUnitQty));
  const hasReceived =
    raw.receivedQty != null ||
    raw.receivedSubUnitQty != null ||
    raw.receivedBaseQty != null;
  if (hasReceived) {
    line.receivedQty = receivedQty;
    line.receivedSubUnitQty = receivedSubUnitQty;
    line.receivedBaseQty = numMoney(
      raw.receivedBaseQty != null
        ? raw.receivedBaseQty
        : poReceivedBaseQty({
            ...line,
            receivedQty,
            receivedSubUnitQty,
          })
    );
  }
  return {
    ...line,
    lineTotal: poLineTotal(line),
  };
}

export function validatePurchaseOrderPayload({
  clientId,
  businessDate,
  vendorId,
  vendorName,
  lines,
}) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  const vId = String(vendorId || "").trim();
  const vName = String(vendorName || "").trim();
  const cleanLines = (Array.isArray(lines) ? lines : [])
    .map(normalizePoLine)
    .filter((row) => row.itemId && (row.qty > 0 || row.subUnitQty > 0));

  if (!shop) throw new Error("Select an active shop first.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Business date is required.");
  }
  if (!vId || !vName) throw new Error("Select a vendor.");
  if (!cleanLines.length) {
    throw new Error("Add at least one item with quantity.");
  }
  return { shop, date, vId, vName, cleanLines };
}

export function buildPoNumber(businessDate) {
  const date = String(businessDate || "").trim().replace(/-/g, "");
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PO-${date || "NA"}-${suffix}`;
}

export async function createPurchaseOrder({
  clientId,
  businessDate,
  vendorId,
  vendorName,
  vendorPhone = "",
  notes = "",
  lines,
  userUid,
  status = PO_STATUS.DRAFT,
}) {
  const { shop, date, vId, vName, cleanLines } = validatePurchaseOrderPayload({
    clientId,
    businessDate,
    vendorId,
    vendorName,
    lines,
  });
  const uid = String(userUid || "").trim();
  if (!uid) throw new Error("You must be signed in.");

  const nowMs = Date.now();
  const payload = {
    clientId: shop,
    businessDate: date,
    poNumber: buildPoNumber(date),
    vendorId: vId,
    vendorName: vName,
    vendorPhone: String(vendorPhone || "").trim(),
    notes: String(notes || "").trim().slice(0, 500),
    lines: cleanLines,
    lineCount: cleanLines.length,
    status: Object.values(PO_STATUS).includes(status) ? status : PO_STATUS.DRAFT,
    createdBy: uid,
    createdAt: serverTimestamp(),
    createdAtMs: nowMs,
    updatedBy: uid,
    updatedAt: serverTimestamp(),
    updatedAtMs: nowMs,
    sentAtMs:
      status === PO_STATUS.SENT || status === PO_STATUS.COMPLETED
        ? nowMs
        : null,
    completedAtMs: status === PO_STATUS.COMPLETED ? nowMs : null,
  };

  const ref = await addDoc(collection(db, "purchase_orders"), payload);
  return { id: ref.id, ...payload };
}

export async function updatePurchaseOrder({
  poId,
  clientId,
  businessDate,
  vendorId,
  vendorName,
  vendorPhone = "",
  notes = "",
  lines,
  userUid,
  status,
}) {
  const id = String(poId || "").trim();
  if (!id) throw new Error("Purchase order id is required.");
  const { shop, date, vId, vName, cleanLines } = validatePurchaseOrderPayload({
    clientId,
    businessDate,
    vendorId,
    vendorName,
    lines,
  });
  const uid = String(userUid || "").trim();
  if (!uid) throw new Error("You must be signed in.");

  const nextStatus = String(status || PO_STATUS.DRAFT).trim().toUpperCase();
  if (!Object.values(PO_STATUS).includes(nextStatus)) {
    throw new Error("Invalid purchase order status.");
  }

  const nowMs = Date.now();
  const patch = {
    clientId: shop,
    businessDate: date,
    vendorId: vId,
    vendorName: vName,
    vendorPhone: String(vendorPhone || "").trim(),
    notes: String(notes || "").trim().slice(0, 500),
    lines: cleanLines,
    lineCount: cleanLines.length,
    status: nextStatus,
    updatedBy: uid,
    updatedAt: serverTimestamp(),
    updatedAtMs: nowMs,
  };
  if (nextStatus === PO_STATUS.SENT || nextStatus === PO_STATUS.COMPLETED) {
    patch.sentAtMs = nowMs;
  }
  if (nextStatus === PO_STATUS.COMPLETED) {
    patch.completedAtMs = nowMs;
  }

  await updateDoc(doc(db, "purchase_orders", id), patch);
  return { id, ...patch };
}

/**
 * Bulk-receive PO lines into inventory.
 * Supports partial delivery:
 * - leftoverAction "keep": remaining qty stays on PO as to-be-received (PARTIALLY_RECEIVED)
 * - leftoverAction "remove": drop remaining, complete PO with only received lines
 */
export async function receivePurchaseOrderToStock({
  poId,
  clientId,
  lines,
  userUid,
  userName = "",
  shiftId = "",
  leftoverAction = PO_LEFTOVER_ACTION.KEEP,
  receiveNote = "",
}) {
  const id = String(poId || "").trim();
  const shop = String(clientId || "").trim();
  const uid = String(userUid || "").trim();
  if (!id) throw new Error("Purchase order id is required.");
  if (!shop) throw new Error("Select an active shop first.");
  if (!uid) throw new Error("You must be signed in.");

  const action = String(leftoverAction || PO_LEFTOVER_ACTION.KEEP)
    .trim()
    .toLowerCase();
  if (
    action !== PO_LEFTOVER_ACTION.KEEP &&
    action !== PO_LEFTOVER_ACTION.REMOVE
  ) {
    throw new Error("Choose whether to keep or remove remaining items.");
  }

  const noteText = String(receiveNote || "").trim().slice(0, 500);
  const rawLines = Array.isArray(lines) ? lines : [];
  if (!rawLines.length) throw new Error("No lines to receive.");

  const receiveRows = rawLines
    .map((row) => {
      // Empty string = explicitly 0 (skip), not "fall back to ordered qty".
      const receivedQtyRaw =
        row.receivedQty !== undefined && row.receivedQty !== null
          ? row.receivedQty
          : row.qty;
      const receivedSubRaw =
        row.receivedSubUnitQty !== undefined && row.receivedSubUnitQty !== null
          ? row.receivedSubUnitQty
          : row.subUnitQty;
      const base = normalizePoLine({
        ...row,
        qty: row.qty,
        subUnitQty: row.subUnitQty,
        receivedQty: receivedQtyRaw,
        receivedSubUnitQty: receivedSubRaw,
      });
      const receivedBaseQty = poReceivedBaseQty({
        ...base,
        receivedQty: receivedQtyRaw,
        receivedSubUnitQty: receivedSubRaw,
      });
      const unitRate = Math.max(
        0,
        numMoney(
          row.unitRate != null && row.unitRate !== ""
            ? row.unitRate
            : base.unitRate
        )
      );
      const pending = poLinePendingQty({
        qty: base.qty,
        subUnitQty: base.subUnitQty,
        receivedQty: receivedQtyRaw,
        receivedSubUnitQty: receivedSubRaw,
      });
      return {
        ...base,
        unitRate,
        lineTotal: poLineTotal({ ...base, unitRate }),
        receivedQty: Math.max(0, numMoney(receivedQtyRaw)),
        receivedSubUnitQty: Math.max(0, numMoney(receivedSubRaw)),
        receivedBaseQty,
        receivedUnitRate: unitRate,
        pendingQty: pending.pendingQty,
        pendingSubUnitQty: pending.pendingSubUnitQty,
      };
    })
    .filter((row) => row.itemId);

  if (!receiveRows.length) throw new Error("No valid items to receive.");

  const stockRows = receiveRows.filter((row) => row.receivedBaseQty > 0);
  if (!stockRows.length) {
    throw new Error(
      "Enter a received quantity for at least one item before posting to stock."
    );
  }

  const pendingRows = receiveRows.filter(
    (row) => row.pendingQty > 0 || row.pendingSubUnitQty > 0
  );
  const hasPending = pendingRows.length > 0;

  if (hasPending && action === PO_LEFTOVER_ACTION.KEEP && !noteText) {
    throw new Error(
      "Add a short note for items still to be received, or remove the remaining balance."
    );
  }

  const poRef = doc(db, "purchase_orders", id);
  const prepared = stockRows.map((row) => ({
    row,
    itemRef: doc(db, "inventory", row.itemId),
    movementRef: doc(collection(db, "inventory_movements")),
  }));

  const nowMs = Date.now();
  const displayName = String(userName || "").trim();
  const openShiftId = String(shiftId || "").trim();

  let nextStatus = PO_STATUS.COMPLETED;
  let nextLines = [];

  await runTransaction(db, async (transaction) => {
    const poSnap = await transaction.get(poRef);
    if (!poSnap.exists()) throw new Error("Purchase order not found.");
    const po = poSnap.data() || {};
    if (po.clientId !== shop) {
      throw new Error("Purchase order belongs to another shop.");
    }
    const currentStatus = String(po.status || "").toUpperCase();
    if (currentStatus === PO_STATUS.CANCELLED) {
      throw new Error("Cancelled purchase orders cannot be received.");
    }
    if (currentStatus === PO_STATUS.COMPLETED) {
      throw new Error("This purchase order is already completed.");
    }

    const snapshots = [];
    for (const item of prepared) {
      snapshots.push(await transaction.get(item.itemRef));
    }

    snapshots.forEach((snap, index) => {
      const { row } = prepared[index];
      if (!snap.exists()) {
        throw new Error(
          `${row.itemName || row.itemCode || "Item"} is missing from inventory.`
        );
      }
      const item = snap.data() || {};
      if (item.clientId !== shop) {
        throw new Error(
          `${row.itemName || "Item"} belongs to another shop.`
        );
      }
    });

    prepared.forEach(({ row, itemRef, movementRef }, index) => {
      const item = snapshots[index].data() || {};
      const oldStock = numMoney(item.currentStock);
      const addQty = row.receivedBaseQty;
      const totalStock = numMoney(oldStock + addQty);
      const unitRate = Math.max(0, numMoney(row.unitRate));
      // Inventory cost is per base/stock unit; PO unitRate is per purchase unit.
      const baseUnitCost = baseCostFromPurchaseUnitRate(unitRate, row.subQty);
      const itemUpdate = {
        currentStock: totalStock,
        updatedAt: serverTimestamp(),
        updatedBy: uid,
      };
      if (Math.abs(baseUnitCost - numMoney(item.cost)) > 0.000001) {
        itemUpdate.cost = baseUnitCost;
      }
      transaction.update(itemRef, itemUpdate);
      transaction.set(movementRef, {
        clientId: shop,
        itemId: row.itemId,
        itemCode: row.itemCode || "",
        itemName: row.itemName || "",
        type: "IN",
        qty: addQty,
        unitCost: baseUnitCost,
        amount: numMoney(addQty * baseUnitCost),
        oldStock,
        totalStock,
        source: "STOCK_RECEIVING",
        reason: "PO_RECEIVE",
        purchaseOrderId: id,
        poNumber: String(po.poNumber || "").trim(),
        shiftId: openShiftId,
        userId: uid,
        userName: displayName,
        createdBy: uid,
        date: new Date(nowMs),
        dateMs: nowMs,
        createdAt: serverTimestamp(),
      });
    });

    if (!hasPending) {
      nextStatus = PO_STATUS.COMPLETED;
      nextLines = receiveRows.map((row) =>
        normalizePoLine({
          ...row,
          qty: row.receivedQty,
          subUnitQty: row.receivedSubUnitQty,
          unitRate: row.unitRate,
          receivedQty: row.receivedQty,
          receivedSubUnitQty: row.receivedSubUnitQty,
          receivedBaseQty: row.receivedBaseQty,
        })
      );
    } else if (action === PO_LEFTOVER_ACTION.REMOVE) {
      nextStatus = PO_STATUS.COMPLETED;
      nextLines = receiveRows
        .filter((row) => row.receivedBaseQty > 0)
        .map((row) =>
          normalizePoLine({
            ...row,
            qty: row.receivedQty,
            subUnitQty: row.receivedSubUnitQty,
            unitRate: row.unitRate,
            receivedQty: row.receivedQty,
            receivedSubUnitQty: row.receivedSubUnitQty,
            receivedBaseQty: row.receivedBaseQty,
          })
        );
      if (!nextLines.length) {
        throw new Error("Nothing received to keep on the purchase order.");
      }
    } else {
      nextStatus = PO_STATUS.PARTIALLY_RECEIVED;
      nextLines = receiveRows
        .filter(
          (row) =>
            row.pendingQty > 0 ||
            row.pendingSubUnitQty > 0 ||
            row.receivedBaseQty > 0
        )
        .map((row) => {
          const stillOpen =
            row.pendingQty > 0 || row.pendingSubUnitQty > 0;
          if (!stillOpen) {
            // Fully received this round — drop from open PO.
            return null;
          }
          // Remaining open balance becomes the PO line (to be received).
          return {
            ...normalizePoLine({
              ...row,
              qty: row.pendingQty,
              subUnitQty: row.pendingSubUnitQty,
              unitRate: row.unitRate,
              notes: row.notes || "",
            }),
            lastReceivedQty: row.receivedQty,
            lastReceivedSubUnitQty: row.receivedSubUnitQty,
            lastReceivedBaseQty: row.receivedBaseQty,
          };
        })
        .filter(Boolean);
      if (!nextLines.length) {
        throw new Error("No remaining items to keep as to be received.");
      }
    }

    const existingNotes = String(po.notes || "").trim();
    let nextNotes = existingNotes;
    if (noteText) {
      const tag =
        nextStatus === PO_STATUS.PARTIALLY_RECEIVED
          ? `To be received: ${noteText}`
          : noteText;
      nextNotes = existingNotes
        ? existingNotes.includes(noteText)
          ? existingNotes
          : `${existingNotes}\n${tag}`.slice(0, 500)
        : tag.slice(0, 500);
    }

    const patch = {
      lines: nextLines,
      lineCount: nextLines.length,
      status: nextStatus,
      notes: nextNotes,
      receiveNote: noteText,
      lastStockReceivedAtMs: nowMs,
      lastStockReceivedBy: uid,
      pendingReceiveCount:
        nextStatus === PO_STATUS.PARTIALLY_RECEIVED
          ? nextLines.filter(
              (row) => numMoney(row.qty) > 0 || numMoney(row.subUnitQty) > 0
            ).length
          : 0,
      updatedBy: uid,
      updatedAt: serverTimestamp(),
      updatedAtMs: nowMs,
    };

    if (nextStatus === PO_STATUS.COMPLETED) {
      patch.completedAtMs = nowMs;
      patch.stockReceivedAtMs = nowMs;
      patch.stockReceivedBy = uid;
    } else {
      // Still open for another receive.
      patch.completedAtMs = null;
      patch.stockReceivedAtMs = null;
    }

    transaction.update(poRef, patch);
  });

  return {
    id,
    status: nextStatus,
    leftoverAction: action,
    pendingLineCount: pendingRows.length,
    receivedLineCount: stockRows.length,
    receivedBaseTotal: stockRows.reduce(
      (sum, row) => sum + row.receivedBaseQty,
      0
    ),
    stockReceivedAtMs:
      nextStatus === PO_STATUS.COMPLETED ? nowMs : null,
  };
}

export function subscribePurchaseOrders(
  clientId,
  businessDate,
  onRows,
  onError
) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();
  if (!shop) {
    onRows([]);
    return () => {};
  }

  const constraints = [where("clientId", "==", shop)];
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    constraints.push(where("businessDate", "==", date));
  }
  constraints.push(orderBy("createdAtMs", "desc"));

  const q = query(collection(db, "purchase_orders"), ...constraints);
  return onSnapshot(
    q,
    (snap) => {
      onRows(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    },
    (err) => {
      onError?.(err);
      onRows([]);
    }
  );
}

/** Digits only for wa.me; empty → share text without a fixed number. */
export function normalizeWhatsAppPhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits;
}

/**
 * Plain WhatsApp text:
 * shop name / address / contact, then items (name - qty unit (note)), then Note.
 * Never includes rate or totals.
 */
export function buildPurchaseOrderWhatsAppText(po, shop = {}) {
  const shopInfo =
    shop && typeof shop === "object" && !Array.isArray(shop)
      ? shop
      : { name: String(shop || "").trim() };

  const shopName = String(shopInfo.name || "").trim();
  const shopAddress = String(
    shopInfo.location || shopInfo.address || ""
  ).trim();
  const shopContact = String(
    shopInfo.contact_number || shopInfo.phone || shopInfo.contact || ""
  ).trim();

  const parts = [];
  if (shopName) parts.push(shopName);
  if (shopAddress) parts.push(shopAddress);
  if (shopContact) parts.push(shopContact);
  if (parts.length) parts.push("");

  const lines = Array.isArray(po?.lines) ? po.lines : [];
  for (const row of lines) {
    const name = String(row.itemName || row.itemCode || "Item").trim();
    const qty = numMoney(row.qty);
    const subUnitQty = numMoney(row.subUnitQty);
    const unit = String(row.unit || row.purchaseUnit || "").trim();
    const baseUnit = String(row.baseUnit || "pcs").trim() || "pcs";
    const note = String(row.notes || "").trim();
    // Show exactly what was entered — no box↔pcs conversion.
    const qtyBits = [];
    if (qty > 0) qtyBits.push(unit ? `${qty} ${unit}` : String(qty));
    if (subUnitQty > 0) qtyBits.push(`${subUnitQty} ${baseUnit}`);
    const qtyPart = qtyBits.length ? qtyBits.join(", ") : "0";
    parts.push(note ? `${name} - ${qtyPart} (${note})` : `${name} - ${qtyPart}`);
  }

  const generalNote = String(po?.notes || "").trim();
  if (generalNote) {
    if (lines.length || shopName || shopAddress || shopContact) parts.push("");
    // Keep the note text exactly as entered (no translation / rewriting).
    parts.push(`Note: ${generalNote}`);
  }

  return parts.join("\n").trim();
}

/**
 * Copy PO text (Windows 7–safe) and optionally open WhatsApp.
 * Long messages are copied only — URL length limits break wa.me on older browsers.
 */
export async function copyPurchaseOrderText(po, shop = {}) {
  const text = buildPurchaseOrderWhatsAppText(po, shop);
  if (!text) throw new Error("Nothing to copy.");
  const copied = await copyTextToClipboard(text);
  if (!copied) {
    throw new Error(
      "Could not copy text. Select and copy manually, or try Chrome/Firefox."
    );
  }
  return { method: "clipboard", text };
}

export async function openPurchaseOrderWhatsApp(po, shop = {}) {
  const text = buildPurchaseOrderWhatsAppText(po, shop);
  if (!text) throw new Error("Nothing to share.");

  const phone = normalizeWhatsAppPhone(po?.vendorPhone);

  // Always copy first — reliable on Windows 7 / desktop where share may be missing.
  const copied = await copyTextToClipboard(text);

  // Prefer native share sheet on mobile when available.
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ text });
      return { method: "share", text, copied };
    } catch (err) {
      if (String(err?.name || "") === "AbortError") {
        return { method: "cancelled", text, copied };
      }
    }
  }

  // Older browsers / Win7: long encodeURIComponent URLs often fail. Prefer paste.
  const encoded = encodeURIComponent(text);
  const urlTooLong = encoded.length > 1500;
  const url = phone
    ? urlTooLong
      ? `https://wa.me/${phone}`
      : `https://wa.me/${phone}?text=${encoded}`
    : urlTooLong
      ? `https://api.whatsapp.com/send`
      : `https://api.whatsapp.com/send?text=${encoded}`;

  let opened = false;
  try {
    const win = window.open(url, "_blank");
    opened = Boolean(win);
    // Some browsers ignore noopener when assigned; still attempt open.
    if (win) {
      try {
        win.opener = null;
      } catch {
        // ignore
      }
    }
  } catch {
    opened = false;
  }

  if (!copied && !opened) {
    throw new Error(
      "Could not copy or open WhatsApp. Copy the PO text manually."
    );
  }

  return {
    method: opened ? (urlTooLong ? "whatsapp-url-paste" : "whatsapp-url") : "clipboard",
    text,
    copied,
    opened,
    urlTooLong,
  };
}
