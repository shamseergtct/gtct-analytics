import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { resolveAttentionStatus } from "../utils/inventoryAttention.js";
import {
  ATTENTION_STATUS_META,
  subscribeDailyReviewLines,
} from "../utils/inventoryDailyReview.js";
import { subscribePurchaseOrders } from "../utils/purchaseOrders.js";
import {
  getDismissedUrgentItemIds,
  itemIdsOnPurchaseOrders,
  PO_URGENT_DISMISS_EVENT,
} from "../utils/poUrgentNotifications.js";

const ALERT_STATUSES = new Set(["URGENT", "VERY_URGENT"]);

/**
 * Urgent / Very Urgent stock alerts for Purchase Orders.
 * Cleared when the item is on a PO for the date, or added to the PO form (session dismiss).
 */
export function useUrgentStockNotifications(clientId, businessDate) {
  const shop = String(clientId || "").trim();
  const date = String(businessDate || "").trim();

  const [items, setItems] = useState([]);
  const [reviewLines, setReviewLines] = useState([]);
  const [orders, setOrders] = useState([]);
  const [dismissedVersion, setDismissedVersion] = useState(0);

  useEffect(() => {
    if (!shop) {
      setItems([]);
      return undefined;
    }
    const q = query(
      collection(db, "inventory"),
      where("clientId", "==", shop),
      orderBy("itemName", "asc")
    );
    return onSnapshot(
      q,
      (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      () => setItems([])
    );
  }, [shop]);

  useEffect(() => {
    if (!shop || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setReviewLines([]);
      return undefined;
    }
    return subscribeDailyReviewLines(shop, date, setReviewLines, () =>
      setReviewLines([])
    );
  }, [shop, date]);

  useEffect(() => {
    if (!shop || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setOrders([]);
      return undefined;
    }
    return subscribePurchaseOrders(shop, date, setOrders, () => setOrders([]));
  }, [shop, date]);

  useEffect(() => {
    function onDismiss(event) {
      const detail = event?.detail || {};
      if (detail.clientId && detail.clientId !== shop) return;
      if (detail.businessDate && detail.businessDate !== date) return;
      setDismissedVersion((n) => n + 1);
    }
    window.addEventListener(PO_URGENT_DISMISS_EVENT, onDismiss);
    return () => window.removeEventListener(PO_URGENT_DISMISS_EVENT, onDismiss);
  }, [shop, date]);

  const alerts = useMemo(() => {
    if (!shop || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];

    const staffByItemId = new Map();
    for (const row of reviewLines) {
      const id = String(row.itemId || row.id || "").trim();
      if (id) staffByItemId.set(id, row);
    }

    const onPo = itemIdsOnPurchaseOrders(orders);
    const dismissed = getDismissedUrgentItemIds(shop, date);
    void dismissedVersion;

    const rows = [];
    for (const item of items) {
      const itemId = String(item.id || "").trim();
      if (!itemId) continue;
      if (onPo.has(itemId) || dismissed.has(itemId)) continue;

      const resolved = resolveAttentionStatus(
        item,
        staffByItemId.get(itemId) || null
      );
      if (!ALERT_STATUSES.has(resolved.status)) continue;

      const meta = ATTENTION_STATUS_META[resolved.status];
      rows.push({
        id: `urgent:${itemId}`,
        itemId,
        itemName: String(item.itemName || item.itemCode || "Item").trim(),
        itemCode: String(item.itemCode || "").trim(),
        status: resolved.status,
        statusLabel: meta?.label || resolved.status,
        source: resolved.source,
        requestedQty: resolved.requestedQty,
        href: `/purchase-orders?urgentItem=${encodeURIComponent(itemId)}`,
      });
    }

    const rank = { VERY_URGENT: 0, URGENT: 1 };
    return rows.sort((a, b) => {
      const byStatus = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
      if (byStatus !== 0) return byStatus;
      return a.itemName.localeCompare(b.itemName);
    });
  }, [shop, date, items, reviewLines, orders, dismissedVersion]);

  return { alerts, count: alerts.length };
}
