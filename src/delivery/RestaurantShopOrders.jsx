import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import {
  PAYMENT_STATUS,
  POOL_STATUS,
  RESTAURANT_DELIVERY_ORDERS,
  formatPoolMoney,
  paymentStatusLabel,
  poolStatusLabel,
} from "../utils/restaurantDeliveryOrders.js";

const acceptOrderFn = httpsCallable(functions, "acceptRestaurantDeliveryOrder");
const updateStatusFn = httpsCallable(functions, "updateRestaurantDeliveryStatus");
const reportPaymentFn = httpsCallable(functions, "reportRestaurantDeliveryPayment");

function addressLine(order) {
  return [
    order.blockNumber && `Block ${order.blockNumber}`,
    order.roadNumber && `Road ${order.roadNumber}`,
    order.buildingNumber && `Building ${order.buildingNumber}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function OrderCard({
  order,
  mine,
  busyId,
  onAccept,
  onDeliver,
  onPayment,
  expandedId,
  onToggleBill,
}) {
  const busy = busyId === order.id;
  const payment = order.paymentReport || { status: PAYMENT_STATUS.UNMARKED };
  const expanded = expandedId === order.id;
  const lines = Array.isArray(order.lines) ? order.lines : [];

  return (
    <article className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-bold text-white">{order.orderNumber}</div>
          <div className="mt-1 text-xs font-semibold text-sky-300">
            {order.tokenNumber != null
              ? `TOKEN ${String(order.tokenNumber).padStart(3, "0")}`
              : "Shop order"}
          </div>
        </div>
        <span className="rounded-lg bg-slate-800 px-2 py-1 text-[11px] font-bold text-slate-200">
          {poolStatusLabel(order.status)}
        </span>
      </header>

      <div className="mt-3 text-sm font-semibold text-slate-100">
        {addressLine(order) || "Address not entered"}
      </div>
      {[order.customerName, order.customerPhone].filter(Boolean).length ? (
        <div className="mt-1 text-sm text-slate-400">
          {[order.customerName, order.customerPhone].filter(Boolean).join(" · ")}
        </div>
      ) : null}
      <div className="mt-2 text-base font-extrabold text-emerald-300">
        {formatPoolMoney(order)}
      </div>

      <button
        type="button"
        onClick={() => onToggleBill(order.id)}
        className="mt-3 w-full rounded-xl border border-slate-600 bg-slate-950/50 px-3 py-2.5 text-sm font-semibold text-sky-200"
      >
        {expanded ? "Hide bill" : "View bill"}
      </button>

      {expanded ? (
        <div className="mt-3 space-y-2 rounded-xl border border-slate-700 bg-slate-950/60 p-3">
          {lines.length ? (
            lines.map((line, index) => (
              <div key={`${order.id}-line-${index}`} className="text-sm text-slate-200">
                <div className="flex justify-between gap-2 font-semibold">
                  <span>
                    {line.quantity}× {line.name}
                    {line.variantName ? ` — ${line.variantName}` : ""}
                  </span>
                  <span>{formatPoolMoney(order, line.lineTotalCents)}</span>
                </div>
                {(line.instructions || []).length ? (
                  <div className="text-xs text-amber-300/90">
                    {line.instructions.join(" · ")}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <div className="text-sm text-slate-400">No line items.</div>
          )}
          <div className="border-t border-slate-700 pt-2 text-sm text-slate-300">
            <div className="flex justify-between">
              <span>Items</span>
              <span>{formatPoolMoney(order, order.goodsCents)}</span>
            </div>
            {Number(order.deliveryChargeCents) > 0 ? (
              <div className="flex justify-between">
                <span>Delivery</span>
                <span>{formatPoolMoney(order, order.deliveryChargeCents)}</span>
              </div>
            ) : null}
            {Number(order.taxCents) > 0 ? (
              <div className="flex justify-between">
                <span>{order.taxName || "Tax"}</span>
                <span>{formatPoolMoney(order, order.taxCents)}</span>
              </div>
            ) : null}
            <div className="mt-1 flex justify-between font-bold text-white">
              <span>Total</span>
              <span>{formatPoolMoney(order)}</span>
            </div>
          </div>
        </div>
      ) : null}

      {!mine ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAccept(order)}
          className="mt-3 w-full rounded-xl bg-sky-500 px-3 py-3 text-sm font-bold text-slate-950 disabled:opacity-60"
        >
          {busy ? "Accepting…" : "Accept delivery"}
        </button>
      ) : (
        <div className="mt-3 space-y-3">
          {order.status === POOL_STATUS.CLAIMED ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onDeliver(order)}
              className="w-full rounded-xl bg-emerald-500 px-3 py-3 text-sm font-bold text-slate-950 disabled:opacity-60"
            >
              {busy ? "Saving…" : "Mark delivered"}
            </button>
          ) : null}

          <div className="rounded-xl border border-slate-700 bg-slate-950/50 p-3">
            <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <span>Customer payment</span>
              <span className="normal-case text-slate-200">
                {paymentStatusLabel(payment.status)}
              </span>
            </div>
            {![PAYMENT_STATUS.PAID_CONFIRMED, PAYMENT_STATUS.CREDIT_APPROVED].includes(
              payment.status
            ) && order.status !== POOL_STATUS.CANCELLED ? (
              <div className="grid gap-2">
                {[
                  [PAYMENT_STATUS.CASH_WITH_BOY, "Cash collected by me"],
                  [PAYMENT_STATUS.SHOP_PAID_REPORTED, "Paid at shop"],
                  [PAYMENT_STATUS.CREDIT_REPORTED, "Customer credit"],
                  [PAYMENT_STATUS.PARTIAL_SHOP, "Partial payment"],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    disabled={busy || payment.status === value}
                    onClick={() => onPayment(order, value)}
                    className="rounded-lg border border-slate-600 px-3 py-2 text-left text-sm font-semibold text-slate-100 disabled:opacity-50"
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </article>
  );
}

export default function RestaurantShopOrders({
  clientId,
  deliveryBoyId,
  deliveryBoyName,
}) {
  const [tab, setTab] = useState("available");
  const [orders, setOrders] = useState([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [expandedId, setExpandedId] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!clientId || !deliveryBoyId) {
      setOrders([]);
      return undefined;
    }
    setError("");
    // Firestore list rules only allow AVAILABLE for the shop, or orders claimed
    // by this boy — a bare clientId query is rejected as "insufficient permissions".
    const availableQuery = query(
      collection(db, RESTAURANT_DELIVERY_ORDERS),
      where("clientId", "==", clientId),
      where("status", "==", POOL_STATUS.AVAILABLE)
    );
    const mineQuery = query(
      collection(db, RESTAURANT_DELIVERY_ORDERS),
      where("clientId", "==", clientId),
      where("claimedByDeliveryBoyId", "==", deliveryBoyId)
    );

    let availableRows = [];
    let mineRows = [];
    const publish = () => {
      const byId = new Map();
      for (const row of [...availableRows, ...mineRows]) {
        byId.set(row.id, row);
      }
      const rows = Array.from(byId.values());
      rows.sort(
        (a, b) => Number(b.publishedAt || 0) - Number(a.publishedAt || 0)
      );
      setOrders(rows);
    };

    const unsubAvailable = onSnapshot(
      availableQuery,
      (snap) => {
        availableRows = snap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
        publish();
      },
      (err) => {
        setError(err?.message || "Could not load shop orders.");
        availableRows = [];
        publish();
      }
    );
    const unsubMine = onSnapshot(
      mineQuery,
      (snap) => {
        mineRows = snap.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));
        publish();
      },
      (err) => {
        setError(err?.message || "Could not load shop orders.");
        mineRows = [];
        publish();
      }
    );
    return () => {
      unsubAvailable();
      unsubMine();
    };
  }, [clientId, deliveryBoyId]);

  const available = useMemo(
    () => orders.filter((o) => o.status === POOL_STATUS.AVAILABLE),
    [orders]
  );
  const mine = useMemo(
    () =>
      orders.filter(
        (o) =>
          String(o.claimedByDeliveryBoyId || "") === String(deliveryBoyId || "") &&
          o.status !== POOL_STATUS.AVAILABLE
      ),
    [orders, deliveryBoyId]
  );

  async function runAction(orderId, work, successMessage) {
    setBusyId(orderId);
    setError("");
    setNotice("");
    try {
      await work();
      if (successMessage) setNotice(successMessage);
    } catch (err) {
      setError(err?.message || "Action failed.");
    } finally {
      setBusyId("");
    }
  }

  function accept(order) {
    if (!window.confirm(`Accept ${order.orderNumber} for delivery?`)) return;
    void runAction(
      order.id,
      () =>
        acceptOrderFn({
          orderDocId: order.id,
          expectedRevision: order.claimRevision || "",
        }),
      `${order.orderNumber} accepted.`
    );
  }

  function deliver(order) {
    if (!window.confirm(`Mark ${order.orderNumber} delivered?`)) return;
    void runAction(
      order.id,
      () =>
        updateStatusFn({
          orderDocId: order.id,
          action: "DELIVERED",
          expectedVersion: Number(order.deliveryLifecycle?.version || 0),
        }),
      `${order.orderNumber} marked delivered.`
    );
  }

  function payment(order, reportType) {
    void runAction(
      order.id,
      () =>
        reportPaymentFn({
          orderDocId: order.id,
          reportType,
          expectedVersion: Number(order.paymentReport?.version || 0),
        }),
      "Payment mark saved."
    );
  }

  if (!clientId || !deliveryBoyId) {
    return (
      <div className="rounded-2xl border border-amber-800/60 bg-amber-950/30 p-4 text-sm text-amber-100">
        Your delivery login is not linked to a shop yet. Ask admin to assign your
        Delivery Boy profile to a shop, then restaurant orders can appear here.
      </div>
    );
  }

  const list = tab === "available" ? available : mine;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-700 bg-slate-900/60 p-4">
        <h2 className="text-lg font-bold text-white">Shop orders</h2>
        <p className="mt-1 text-sm text-slate-400">
          Restaurant deliveries for {deliveryBoyName || "you"} · works on mobile
          data. External bill entry stays on the Bills tab.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {[
          { id: "available", label: "Available", count: available.length },
          { id: "mine", label: "My orders", count: mine.length },
        ].map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded-xl px-3 py-2.5 text-sm font-semibold ${
                active ? "bg-sky-500 text-slate-950" : "bg-slate-900 text-slate-300"
              }`}
            >
              {item.label}
              <span className="ml-1 opacity-80">{item.count}</span>
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-800 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-100">
          {notice}
        </div>
      ) : null}

      {!list.length ? (
        <div className="rounded-2xl border border-dashed border-slate-700 px-4 py-10 text-center text-sm text-slate-400">
          {tab === "available"
            ? "No ready shop deliveries right now."
            : "No accepted shop deliveries yet."}
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              mine={tab === "mine"}
              busyId={busyId}
              expandedId={expandedId}
              onToggleBill={(id) =>
                setExpandedId((prev) => (prev === id ? "" : id))
              }
              onAccept={accept}
              onDeliver={deliver}
              onPayment={payment}
            />
          ))}
        </div>
      )}
    </div>
  );
}
