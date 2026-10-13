/** Session dismissals for urgent stock → PO notifications (per shop + date). */

function storageKey(clientId, businessDate) {
  return `po_urgent_dismissed:${String(clientId || "").trim()}:${String(businessDate || "").trim()}`;
}

export const PO_URGENT_DISMISS_EVENT = "po-urgent-dismiss-changed";

export function getDismissedUrgentItemIds(clientId, businessDate) {
  if (typeof sessionStorage === "undefined") return new Set();
  try {
    const raw = sessionStorage.getItem(storageKey(clientId, businessDate));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(
      (Array.isArray(parsed) ? parsed : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

export function dismissUrgentPoItem(clientId, businessDate, itemId) {
  const id = String(itemId || "").trim();
  if (!id || !clientId || !businessDate) return;
  const next = getDismissedUrgentItemIds(clientId, businessDate);
  if (next.has(id)) return;
  next.add(id);
  try {
    sessionStorage.setItem(
      storageKey(clientId, businessDate),
      JSON.stringify(Array.from(next))
    );
  } catch {
    // ignore quota / private mode
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(PO_URGENT_DISMISS_EVENT, {
        detail: { clientId, businessDate, itemId: id },
      })
    );
  }
}

export function itemIdsOnPurchaseOrders(orders = []) {
  const ids = new Set();
  for (const order of orders) {
    const status = String(order?.status || "").toUpperCase();
    if (status === "CANCELLED") continue;
    const lines = Array.isArray(order?.lines) ? order.lines : [];
    for (const line of lines) {
      const id = String(line?.itemId || "").trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}
