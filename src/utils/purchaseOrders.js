import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { numMoney } from "./money.js";

export const PO_STATUS = {
  DRAFT: "DRAFT",
  SENT: "SENT",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

export const PO_STATUS_META = {
  DRAFT: { label: "Draft", className: "text-amber-200" },
  SENT: { label: "Sent", className: "text-emerald-200" },
  COMPLETED: { label: "Completed", className: "text-sky-200" },
  CANCELLED: { label: "Cancelled", className: "text-slate-400" },
};

export function normalizePoLine(raw = {}) {
  const qty = numMoney(raw.qty);
  const unitRate = Math.max(0, numMoney(raw.unitRate ?? raw.cost ?? 0));
  return {
    itemId: String(raw.itemId || "").trim(),
    itemCode: String(raw.itemCode || "").trim(),
    itemName: String(raw.itemName || "").trim(),
    qty,
    unitRate,
    lineTotal: numMoney(qty * unitRate),
    unit: String(raw.unit || raw.baseUnit || "").trim(),
    notes: String(raw.notes || "").trim().slice(0, 200),
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
    .filter((row) => row.itemId && row.qty > 0);

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
 * shop name / address / contact, then items (name qty (note)), then Note.
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
    const note = String(row.notes || "").trim();
    parts.push(note ? `${name} ${qty} (${note})` : `${name} ${qty}`);
  }

  const generalNote = String(po?.notes || "").trim();
  if (generalNote) {
    if (lines.length || shopName || shopAddress || shopContact) parts.push("");
    parts.push(`Note: ${generalNote}`);
  }

  return parts.join("\n").trim();
}

export async function openPurchaseOrderWhatsApp(po, shop = {}) {
  const text = buildPurchaseOrderWhatsAppText(po, shop);
  if (!text) throw new Error("Nothing to share.");

  const phone = normalizeWhatsAppPhone(po?.vendorPhone);

  // Prefer native share sheet with text only (mobile). Falls back to wa.me text URL.
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ text });
      return { method: "share", text };
    } catch (err) {
      // User cancelled — stop. Other errors fall through to wa.me.
      if (String(err?.name || "") === "AbortError") {
        return { method: "cancelled", text };
      }
    }
  }

  const url = phone
    ? `https://wa.me/${phone}?text=${encodeURIComponent(text)}`
    : `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank", "noopener,noreferrer");
  return { method: "whatsapp-url", text };
}
