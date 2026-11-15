import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  query,
  where,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { calculateDeliveryCommission } from "../utils/externalSales.js";
import {
  formatMoney,
  parseMoneyInput,
  roundMoney,
  toMinorUnits,
} from "../utils/money.js";
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

const TABS = [
  { id: "new", label: "New" },
  { id: "view", label: "View" },
  { id: "delivered", label: "Delivered" },
];

const PAYMENT_OPTIONS = [
  { value: PAYMENT_STATUS.CASH_WITH_BOY, label: "Cash collected by me" },
  { value: PAYMENT_STATUS.SHOP_PAID_REPORTED, label: "Paid at shop" },
  { value: PAYMENT_STATUS.CREDIT_REPORTED, label: "Customer credit" },
];

function tokenLabel(order) {
  const raw = order?.tokenNumber ?? order?.token_number ?? order?.token;
  const n = Number(raw);
  if (!Number.isFinite(n) || String(raw).trim() === "") return null;
  return `TOKEN ${String(Math.trunc(n)).padStart(3, "0")}`;
}

function normalizeAddressPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^block\s+/i, "")
    .replace(/^road\s+/i, "")
    .replace(/\s+/g, "");
}

function matchesAddressFilter(order, blockFilter, roadFilter) {
  const blockQ = normalizeAddressPart(blockFilter);
  const roadQ = normalizeAddressPart(roadFilter);
  if (!blockQ && !roadQ) return true;
  const block = normalizeAddressPart(order?.blockNumber);
  const road = normalizeAddressPart(order?.roadNumber);
  if (blockQ && !block.includes(blockQ)) return false;
  if (roadQ && !road.includes(roadQ)) return false;
  return true;
}

function sameBlock(order, blockValue) {
  const target = normalizeAddressPart(blockValue);
  if (!target) return false;
  return normalizeAddressPart(order?.blockNumber) === target;
}

function compareByRoadNumber(a, b) {
  const roadA = Number(a?.roadNumber);
  const roadB = Number(b?.roadNumber);
  if (Number.isFinite(roadA) && Number.isFinite(roadB) && roadA !== roadB) {
    return roadA - roadB;
  }
  return String(a?.roadNumber || "").localeCompare(
    String(b?.roadNumber || ""),
    undefined,
    { numeric: true, sensitivity: "base" }
  );
}

function addressLine(order) {
  return [
    order.blockNumber && `Block ${order.blockNumber}`,
    order.roadNumber && `Road ${order.roadNumber}`,
    order.buildingNumber && `Building ${order.buildingNumber}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function orderAmount(order) {
  const decimals = Math.min(Math.max(Number(order?.currencyDecimals) || 2, 0), 4);
  return Number(order?.totalCents || 0) / 10 ** decimals;
}

function orderDeliveryCharge(order) {
  const decimals = Math.min(Math.max(Number(order?.currencyDecimals) || 2, 0), 4);
  return Number(order?.deliveryChargeCents || 0) / 10 ** decimals;
}

function orderCommission(order, deliveryBoy) {
  return calculateDeliveryCommission({
    saleType: "DELIVERY",
    deliveryCharge: orderDeliveryCharge(order),
    commissionEnabled: Boolean(deliveryBoy?.commissionEnabled),
    commissionRate: Number(deliveryBoy?.commissionRate) || 0,
    decimals: Math.min(Math.max(Number(order?.currencyDecimals) || 2, 0), 4),
  }).commissionAmount;
}

function paymentBucket(status) {
  switch (String(status || "")) {
    case PAYMENT_STATUS.CASH_WITH_BOY:
      return "collection";
    case PAYMENT_STATUS.SHOP_PAID_REPORTED:
    case PAYMENT_STATUS.PAID_CONFIRMED:
    case PAYMENT_STATUS.PARTIAL_SHOP:
      return "shopPaid";
    case PAYMENT_STATUS.CREDIT_REPORTED:
    case PAYMENT_STATUS.CREDIT_APPROVED:
      return "credit";
    default:
      return "unmarked";
  }
}

function paymentChip(status) {
  const bucket = paymentBucket(status);
  if (bucket === "collection") {
    return { label: "Collection", className: "bg-teal-500/15 text-teal-200 ring-1 ring-teal-500/30" };
  }
  if (bucket === "shopPaid") {
    return { label: "Shop paid", className: "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-500/30" };
  }
  if (bucket === "credit") {
    return { label: "Credit", className: "bg-orange-500/15 text-orange-200 ring-1 ring-orange-500/30" };
  }
  return { label: paymentStatusLabel(status), className: "bg-white/5 text-slate-300 ring-1 ring-white/10" };
}

/** Shop cashier settlement mirrored from POS (cash / bank / credit). */
function resolveShopPayment(order) {
  const shop = order?.shopPayment || {};
  const status = String(
    shop.status || order?.paymentStatus || order?.shopPaymentStatus || ""
  ).toUpperCase();
  const cashCents = Number(shop.cashCents || 0);
  const bankCents = Number(shop.bankCents || 0);
  const creditCents = Number(shop.creditCents || 0);
  const report = String(order?.paymentReport?.status || "").toUpperCase();

  if (status === "PAID" || report === PAYMENT_STATUS.PAID_CONFIRMED) {
    const parts = [];
    if (cashCents > 0) parts.push("Cash");
    if (bankCents > 0) parts.push("Bank");
    if (!parts.length) parts.push("Paid");
    return {
      settled: true,
      kind: "PAID",
      label: parts.length === 1 ? `Paid · ${parts[0]}` : `Paid · ${parts.join(" + ")}`,
      reportType: PAYMENT_STATUS.SHOP_PAID_REPORTED,
      cashCents,
      bankCents,
      creditCents,
    };
  }
  if (status === "CREDIT" || report === PAYMENT_STATUS.CREDIT_APPROVED) {
    return {
      settled: true,
      kind: "CREDIT",
      label: "Paid · Credit",
      reportType: PAYMENT_STATUS.CREDIT_REPORTED,
      cashCents,
      bankCents,
      creditCents,
    };
  }
  if (status === "PARTIAL") {
    const parts = [];
    if (cashCents > 0) parts.push("Cash");
    if (bankCents > 0) parts.push("Bank");
    if (creditCents > 0) parts.push("Credit");
    return {
      settled: false,
      kind: "PARTIAL",
      label: parts.length ? `Partial · ${parts.join(" + ")}` : "Partial at shop",
      reportType: PAYMENT_STATUS.PARTIAL_SHOP,
      cashCents,
      bankCents,
      creditCents,
    };
  }
  return {
    settled: false,
    kind: "UNPAID",
    label: "",
    reportType: "",
    cashCents,
    bankCents,
    creditCents,
  };
}

function DeliveredTotals({ summary, currencyDecimals, currencyCode }) {
  const money = (value) => {
    const formatted = formatMoney(value, currencyDecimals);
    return currencyCode ? `${formatted} ${currencyCode}` : formatted;
  };
  const rows = [
    { label: "Order total", value: summary.all },
    { label: "Cash collection", value: summary.collection },
    { label: "Paid at shop", value: summary.shopPaid },
    { label: "Customer credit", value: summary.credit },
    { label: "Commission", value: summary.commission },
  ];
  return (
    <section className="space-y-4">
      <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900 via-slate-900 to-teal-950/40 p-5 shadow-[0_20px_50px_rgba(0,0,0,0.35)]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-teal-300/80">
          Settlement overview
        </p>
        <p className="mt-3 text-sm text-slate-400">
          {summary.count
            ? `${summary.count} delivered order${summary.count === 1 ? "" : "s"}`
            : "No delivered orders yet"}
        </p>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-2xl bg-teal-500/10 px-4 py-4 ring-1 ring-teal-400/25">
            <div className="text-[11px] font-medium uppercase tracking-wide text-teal-200/80">
              Collection
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-white">
              {money(summary.collection)}
            </div>
          </div>
          <div className="rounded-2xl bg-orange-500/10 px-4 py-4 ring-1 ring-orange-400/25">
            <div className="text-[11px] font-medium uppercase tracking-wide text-orange-200/80">
              Balance to shop
            </div>
            <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight text-white">
              {money(summary.balanceToShop)}
            </div>
          </div>
        </div>
      </div>

      <div className="overflow-hidden rounded-3xl border border-white/10 bg-slate-950/70">
        <div className="border-b border-white/10 px-4 py-3">
          <h3 className="text-sm font-semibold text-white">Breakdown</h3>
        </div>
        <ul className="divide-y divide-white/5">
          {rows.map((row) => (
            <li
              key={row.label}
              className="flex items-center justify-between gap-3 px-4 py-3.5 text-sm"
            >
              <span className="text-slate-400">{row.label}</span>
              <span className="font-semibold tabular-nums text-slate-100">
                {money(row.value)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function summarizeShopOrders(orders, deliveryBoy) {
  let collection = 0;
  let shopPaid = 0;
  let credit = 0;
  let commission = 0;
  let all = 0;
  for (const order of orders) {
    const amount = orderAmount(order);
    const decimals = Math.min(Math.max(Number(order?.currencyDecimals) || 2, 0), 4);
    const scale = 10 ** decimals;
    all += amount;
    commission += orderCommission(order, deliveryBoy);
    const shop = resolveShopPayment(order);
    if (shop.kind === "PAID") {
      shopPaid += amount;
      continue;
    }
    if (shop.kind === "CREDIT") {
      credit += amount;
      continue;
    }
    if (shop.kind === "PARTIAL") {
      collection += Number(shop.cashCents || 0) / scale;
      shopPaid += Number(shop.bankCents || 0) / scale;
      credit += Number(shop.creditCents || 0) / scale;
      continue;
    }
    const report = order.paymentReport || {};
    if (report.multi || report.status === PAYMENT_STATUS.PARTIAL_SHOP) {
      collection += Number(report.cashCents || 0) / scale;
      shopPaid += Number(report.shopPaidCents || 0) / scale;
      credit += Number(report.creditCents || 0) / scale;
      continue;
    }
    const bucket = paymentBucket(report.status);
    if (bucket === "collection") collection += amount;
    else if (bucket === "shopPaid") shopPaid += amount;
    else if (bucket === "credit") credit += amount;
  }
  collection = roundMoney(collection);
  shopPaid = roundMoney(shopPaid);
  credit = roundMoney(credit);
  commission = roundMoney(commission);
  all = roundMoney(all);
  return {
    count: orders.length,
    collection,
    shopPaid,
    credit,
    commission,
    all,
    balanceToShop: roundMoney(Math.max(0, collection - commission)),
  };
}

function buildPaymentPayload(order, form) {
  const decimals = Math.min(Math.max(Number(order?.currencyDecimals) || 2, 0), 4);
  const totalCents = Number(order.totalCents || 0);

  if (form.multi) {
    const cashCents = toMinorUnits(parseMoneyInput(form.cashAmount, decimals), decimals);
    const shopPaidCents = toMinorUnits(
      parseMoneyInput(form.shopPaidAmount, decimals),
      decimals
    );
    const creditCents = toMinorUnits(
      parseMoneyInput(form.creditAmount, decimals),
      decimals
    );
    const sum = cashCents + shopPaidCents + creditCents;
    if (cashCents < 0 || shopPaidCents < 0 || creditCents < 0) {
      return { error: "Payment amounts cannot be negative." };
    }
    if (sum <= 0) {
      return { error: "Enter at least one payment amount." };
    }
    if (sum !== totalCents) {
      return {
        error: `Split amounts must equal ${formatPoolMoney(order)}.`,
      };
    }
    const used = [cashCents > 0, shopPaidCents > 0, creditCents > 0].filter(Boolean)
      .length;
    if (used < 2) {
      return { error: "Multiple payment needs at least two modes." };
    }
    return {
      reportType: PAYMENT_STATUS.PARTIAL_SHOP,
      multi: true,
      cashCents,
      shopPaidCents,
      creditCents,
    };
  }

  if (!form.mode) {
    return { error: "Select a payment mode." };
  }
  return {
    reportType: form.mode,
    multi: false,
    cashCents: form.mode === PAYMENT_STATUS.CASH_WITH_BOY ? totalCents : 0,
    shopPaidCents:
      form.mode === PAYMENT_STATUS.SHOP_PAID_REPORTED ? totalCents : 0,
    creditCents: form.mode === PAYMENT_STATUS.CREDIT_REPORTED ? totalCents : 0,
  };
}

function OrderCard({
  order,
  tab,
  busyId,
  deliveryBoy,
  onAccept,
  onDeliver,
  onSavePayment,
  expandedId,
  onToggleBill,
  currencyDecimals,
}) {
  const busy = busyId === order.id;
  const payment = order.paymentReport || { status: PAYMENT_STATUS.UNMARKED };
  const shopPay = resolveShopPayment(order);
  const expanded = expandedId === order.id;
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const chip = shopPay.settled
    ? {
        label: shopPay.label,
        className:
          shopPay.kind === "CREDIT"
            ? "bg-orange-500/15 text-orange-200 ring-1 ring-orange-500/30"
            : "bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-500/30",
      }
    : paymentChip(payment.status);
  const commissionAmount = orderCommission(order, deliveryBoy);
  const commissionEnabled = Boolean(deliveryBoy?.commissionEnabled);
  const commissionRate = Number(deliveryBoy?.commissionRate) || 0;
  const token = tokenLabel(order);
  const canMarkDelivered = tab === "view" && order.status === POOL_STATUS.CLAIMED;
  const lockedPayment =
    shopPay.settled ||
    [
      PAYMENT_STATUS.PAID_CONFIRMED,
      PAYMENT_STATUS.CREDIT_APPROVED,
    ].includes(payment.status);
  const paymentEditable =
    !lockedPayment && order.status !== POOL_STATUS.CANCELLED;

  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState("");
  const [multi, setMulti] = useState(false);
  const [cashAmount, setCashAmount] = useState("");
  const [shopPaidAmount, setShopPaidAmount] = useState("");
  const [creditAmount, setCreditAmount] = useState("");
  const [localError, setLocalError] = useState("");

  // View tab always shows payment (needed to mark delivered) unless shop already paid.
  // Delivered tab only shows payment after Edit.
  const showPaymentForm =
    paymentEditable &&
    (tab === "view" || (tab === "delivered" && editing));

  const paymentForm = {
    mode,
    multi,
    cashAmount,
    shopPaidAmount,
    creditAmount,
  };

  function resolvePaymentOrAlert() {
    const payload = buildPaymentPayload(order, paymentForm);
    if (payload.error) {
      setLocalError(payload.error);
      return null;
    }
    setLocalError("");
    return payload;
  }

  return (
    <article className="overflow-hidden rounded-3xl border border-white/10 bg-slate-950/80 shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
      <div className="h-1 w-full bg-gradient-to-r from-teal-400 via-cyan-400 to-emerald-400" />
      <div className="p-4">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="text-[15px] font-semibold tracking-tight text-white">
              {order.orderNumber}
            </span>
            <span className="rounded-lg bg-teal-500/15 px-2 py-0.5 text-[11px] font-bold tracking-wide text-teal-200 ring-1 ring-teal-400/30">
              {token || "TOKEN —"}
            </span>
          </div>
          <div className="mt-1.5 truncate text-xs leading-relaxed text-slate-400">
            {addressLine(order) || "Address not entered"}
            {order.customerName ? ` · ${order.customerName}` : ""}
          </div>
        </div>
        <span className="shrink-0 rounded-full bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-300 ring-1 ring-white/10">
          {poolStatusLabel(order.status)}
        </span>
      </header>

      <div className="mt-3.5 grid grid-cols-2 gap-2">
        <div className="rounded-2xl bg-white/[0.03] px-3 py-2.5 ring-1 ring-white/10">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
            Amount
          </div>
          <div className="mt-1 text-sm font-semibold tabular-nums text-white">
            {formatPoolMoney(order)}
          </div>
        </div>
        <div className="rounded-2xl bg-white/[0.03] px-3 py-2.5 ring-1 ring-white/10">
          <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">
            Delivery charge
          </div>
          <div className="mt-1 text-sm font-semibold tabular-nums text-white">
            {Number(order.deliveryChargeCents) > 0
              ? formatPoolMoney(order, order.deliveryChargeCents)
              : "—"}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {shopPay.settled ? (
          <span className="rounded-full bg-emerald-400 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-950">
            {shopPay.label || "Paid"}
          </span>
        ) : shopPay.kind === "PARTIAL" ? (
          <span className="rounded-full bg-amber-400/90 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-950">
            {shopPay.label}
          </span>
        ) : tab !== "new" ? (
          <span
            className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${chip.className}`}
          >
            {chip.label || "Not marked"}
          </span>
        ) : (
          <span className="rounded-full bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 ring-1 ring-white/10">
            Unpaid
          </span>
        )}
        {commissionEnabled ? (
          <span className="rounded-full bg-cyan-500/15 px-2.5 py-1 text-[10px] font-semibold text-cyan-200 ring-1 ring-cyan-400/30">
            Commission {formatMoney(commissionAmount, currencyDecimals)}
            {commissionRate > 0 ? ` · ${commissionRate}%` : ""}
          </span>
        ) : null}
      </div>

      <div className={`mt-3.5 grid gap-2 ${tab === "delivered" && paymentEditable ? "grid-cols-2" : "grid-cols-1"}`}>
        <button
          type="button"
          onClick={() => onToggleBill(order.id)}
          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm font-semibold text-teal-100 transition hover:bg-white/[0.06]"
        >
          {expanded ? "Hide bill" : "View bill"}
        </button>
        {tab === "delivered" && paymentEditable ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing((open) => !open);
              setLocalError("");
            }}
            className="w-full rounded-2xl border border-teal-400/30 bg-teal-500/10 px-3 py-2.5 text-sm font-semibold text-teal-100 transition hover:bg-teal-500/15 disabled:opacity-60"
          >
            {editing ? "Cancel" : "Edit"}
          </button>
        ) : null}
      </div>

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
            {commissionEnabled ? (
              <div className="flex justify-between">
                <span>
                  Commission
                  {commissionRate > 0 ? ` (${commissionRate}% of delivery)` : ""}
                </span>
                <span>{formatMoney(commissionAmount, currencyDecimals)}</span>
              </div>
            ) : null}
            {shopPay.settled || shopPay.kind === "PARTIAL" ? (
              <div className="mt-1 flex justify-between text-emerald-200">
                <span>Shop payment</span>
                <span>{shopPay.label}</span>
              </div>
            ) : null}
            <div className="mt-1 flex justify-between font-bold text-white">
              <span>Total</span>
              <span>{formatPoolMoney(order)}</span>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "new" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAccept(order)}
          className="mt-3.5 w-full rounded-2xl bg-teal-400 px-3 py-3 text-sm font-bold text-slate-950 transition hover:bg-teal-300 disabled:opacity-60"
        >
          {busy ? "Accepting…" : "Accept delivery"}
        </button>
      ) : null}

      {canMarkDelivered && shopPay.settled ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            const totalCents = Number(order.totalCents || 0);
            onDeliver(order, {
              reportType: shopPay.reportType,
              multi: false,
              cashCents: 0,
              shopPaidCents:
                shopPay.kind === "PAID" ? totalCents : Number(shopPay.bankCents || 0),
              creditCents: shopPay.kind === "CREDIT" ? totalCents : 0,
              shopAlreadyPaid: true,
            });
          }}
          className="mt-3.5 w-full rounded-2xl bg-emerald-400 px-3 py-3 text-sm font-bold text-slate-950 transition hover:bg-emerald-300 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Mark delivered"}
        </button>
      ) : null}

      {showPaymentForm ? (
        <div className="mt-3.5 space-y-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
          <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <span>Customer payment</span>
            <span className="normal-case text-slate-200">
              {paymentStatusLabel(payment.status)}
            </span>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={multi}
              disabled={busy}
              onChange={(e) => {
                setMulti(e.target.checked);
                setLocalError("");
                if (e.target.checked) setMode("");
              }}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-teal-400"
            />
            Multiple payment modes (cash, shop paid, credit)
          </label>

          {!multi ? (
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">
                Payment mode
              </label>
              <select
                value={mode}
                disabled={busy}
                onChange={(e) => {
                  setMode(e.target.value);
                  setLocalError("");
                }}
                className="w-full rounded-2xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:ring-2 focus:ring-teal-400/60"
              >
                <option value="">Select payment mode…</option>
                {PAYMENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="grid gap-2">
              {[
                ["Cash", cashAmount, setCashAmount],
                ["Shop paid", shopPaidAmount, setShopPaidAmount],
                ["Credit", creditAmount, setCreditAmount],
              ].map(([label, value, setter]) => (
                <div key={label}>
                  <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">
                    {label}
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={value}
                    disabled={busy}
                    placeholder="0.000"
                    onChange={(e) => {
                      setter(e.target.value);
                      setLocalError("");
                    }}
                    className="w-full rounded-2xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm tabular-nums text-white outline-none focus:ring-2 focus:ring-teal-400/60"
                  />
                </div>
              ))}
              <p className="text-[11px] text-slate-500">
                Split must equal {formatPoolMoney(order)}.
              </p>
            </div>
          )}

          {localError ? (
            <p className="rounded-xl border border-rose-900/50 bg-rose-950/40 px-2.5 py-2 text-xs text-rose-100">
              {localError}
            </p>
          ) : null}

          {canMarkDelivered ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const payload = resolvePaymentOrAlert();
                if (!payload) return;
                onDeliver(order, payload);
              }}
              className="w-full rounded-2xl bg-emerald-400 px-3 py-3 text-sm font-bold text-slate-950 transition hover:bg-emerald-300 disabled:opacity-60"
            >
              {busy ? "Saving…" : "Mark delivered"}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const payload = resolvePaymentOrAlert();
                if (!payload) return;
                onSavePayment(order, payload, () => setEditing(false));
              }}
              className="w-full rounded-2xl border border-teal-400/30 bg-teal-500/10 px-3 py-2.5 text-sm font-semibold text-teal-100 disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save payment"}
            </button>
          )}
        </div>
      ) : null}
      </div>
    </article>
  );
}

export default function RestaurantShopOrders({
  clientId,
  deliveryBoyId,
  deliveryBoy = null,
}) {
  const [tab, setTab] = useState("new");
  const [deliveredPane, setDeliveredPane] = useState("totals"); // totals | orders
  const [blockFilter, setBlockFilter] = useState("");
  const [roadFilter, setRoadFilter] = useState("");
  const [blockSuggest, setBlockSuggest] = useState(null); // { block, acceptedOrderId, acceptedOrderNumber }
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

  const newOrders = useMemo(
    () => orders.filter((o) => o.status === POOL_STATUS.AVAILABLE),
    [orders]
  );

  const viewOrders = useMemo(
    () =>
      orders.filter(
        (o) =>
          String(o.claimedByDeliveryBoyId || "") === String(deliveryBoyId || "") &&
          [POOL_STATUS.CLAIMED, POOL_STATUS.CANCEL_REQUESTED, POOL_STATUS.CANCELLED].includes(
            o.status
          )
      ),
    [orders, deliveryBoyId]
  );
  const deliveredOrders = useMemo(
    () =>
      orders.filter(
        (o) =>
          String(o.claimedByDeliveryBoyId || "") === String(deliveryBoyId || "") &&
          o.status === POOL_STATUS.DELIVERED
      ),
    [orders, deliveryBoyId]
  );

  const filteredNewOrders = useMemo(
    () =>
      newOrders.filter((o) => matchesAddressFilter(o, blockFilter, roadFilter)),
    [newOrders, blockFilter, roadFilter]
  );
  const filteredViewOrders = useMemo(
    () =>
      viewOrders.filter((o) => matchesAddressFilter(o, blockFilter, roadFilter)),
    [viewOrders, blockFilter, roadFilter]
  );
  const filteredDeliveredOrders = useMemo(
    () =>
      deliveredOrders.filter((o) =>
        matchesAddressFilter(o, blockFilter, roadFilter)
      ),
    [deliveredOrders, blockFilter, roadFilter]
  );

  const lists = {
    new: filteredNewOrders,
    view: filteredViewOrders,
    delivered: filteredDeliveredOrders,
  };
  const tabTotals = {
    new: newOrders.length,
    view: viewOrders.length,
    delivered: deliveredOrders.length,
  };
  const list = lists[tab] || [];
  const filterActive = Boolean(
    normalizeAddressPart(blockFilter) || normalizeAddressPart(roadFilter)
  );
  const deliveredSummary = useMemo(
    () => summarizeShopOrders(filteredDeliveredOrders, deliveryBoy),
    [filteredDeliveredOrders, deliveryBoy]
  );
  const currencyDecimals = Math.min(
    Math.max(
      Number(list[0]?.currencyDecimals || deliveredOrders[0]?.currencyDecimals) || 2,
      0
    ),
    4
  );

  const sameBlockAvailable = useMemo(() => {
    if (!blockSuggest?.block) return [];
    return newOrders
      .filter(
        (o) =>
          o.id !== blockSuggest.acceptedOrderId &&
          sameBlock(o, blockSuggest.block)
      )
      .sort(compareByRoadNumber);
  }, [newOrders, blockSuggest]);

  async function runAction(orderId, work, successMessage) {
    setBusyId(orderId);
    setError("");
    setNotice("");
    try {
      await work();
      if (successMessage) setNotice(successMessage);
      return true;
    } catch (err) {
      setError(err?.message || "Action failed.");
      return false;
    } finally {
      setBusyId("");
    }
  }

  function openBlockSuggest(order) {
    const block = String(order?.blockNumber || "").trim();
    if (!block) return;
    setBlockSuggest({
      block,
      acceptedOrderId: order.id,
      acceptedOrderNumber: order.orderNumber || "",
    });
    // Prefill location filter so the New list stays focused on this block.
    setBlockFilter(block);
  }

  function accept(order, { fromPopup = false } = {}) {
    if (!window.confirm(`Accept ${order.orderNumber} for delivery?`)) return;
    void (async () => {
      const ok = await runAction(
        order.id,
        () =>
          acceptOrderFn({
            orderDocId: order.id,
            expectedRevision: order.claimRevision || "",
          }),
        `${order.orderNumber} accepted.`
      );
      if (!ok) return;
      if (fromPopup) {
        setBlockSuggest((prev) =>
          prev
            ? {
                ...prev,
                acceptedOrderId: order.id,
                acceptedOrderNumber: order.orderNumber || prev.acceptedOrderNumber,
              }
            : prev
        );
      } else {
        openBlockSuggest(order);
      }
    })();
  }

  async function savePaymentReport(order, payload) {
    await reportPaymentFn({
      orderDocId: order.id,
      reportType: payload.reportType,
      expectedVersion: Number(order.paymentReport?.version || 0),
      multi: Boolean(payload.multi),
      cashCents: Number(payload.cashCents || 0),
      shopPaidCents: Number(payload.shopPaidCents || 0),
      creditCents: Number(payload.creditCents || 0),
    });
  }

  function deliver(order, payload) {
    const shopAlreadyPaid = Boolean(payload?.shopAlreadyPaid);
    if (!shopAlreadyPaid && !payload?.reportType) {
      setError("Select a payment mode before marking delivered.");
      return;
    }
    if (!window.confirm(`Mark ${order.orderNumber} delivered?`)) return;
    void runAction(
      order.id,
      async () => {
        // Shop cashier settlement is authoritative — do not overwrite with rider marks.
        if (!shopAlreadyPaid) {
          await savePaymentReport(order, payload);
        }
        await updateStatusFn({
          orderDocId: order.id,
          action: "DELIVERED",
          expectedVersion: Number(order.deliveryLifecycle?.version || 0),
        });
      },
      shopAlreadyPaid
        ? `${order.orderNumber} marked delivered (already paid at shop).`
        : `${order.orderNumber} delivered with payment saved.`
    );
  }

  function savePayment(order, payload, onDone) {
    if (!payload?.reportType) {
      setError("Select a payment mode.");
      return;
    }
    void runAction(
      order.id,
      async () => {
        await savePaymentReport(order, payload);
        if (typeof onDone === "function") onDone();
      },
      "Payment mark saved."
    );
  }

  if (!clientId || !deliveryBoyId) {
    return (
      <main className="mx-auto max-w-lg space-y-5 px-4 py-5 pb-28">
        <div className="rounded-2xl border border-amber-800/60 bg-amber-950/30 p-4 text-sm text-amber-100">
          Your delivery login is not linked to a shop yet. Ask admin to assign your
          Delivery Boy profile to a shop, then restaurant orders can appear here.
        </div>
      </main>
    );
  }

  const currencyCode = String(
    list[0]?.currencyCode || deliveredOrders[0]?.currencyCode || ""
  ).trim();
  const showOrderList = tab !== "delivered" || deliveredPane === "orders";

  return (
    <>
      <nav className="mx-auto max-w-lg border-b border-white/10 px-3 py-2.5">
        <div className="grid grid-cols-3 gap-1 rounded-2xl bg-slate-950/80 p-1 ring-1 ring-white/10">
          {TABS.map((item) => {
            const active = tab === item.id;
            const badge = tabTotals[item.id] || 0;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setTab(item.id);
                  if (item.id === "delivered") setDeliveredPane("totals");
                }}
                className={`relative rounded-xl px-2 py-2.5 text-xs font-semibold transition ${
                  active
                    ? "bg-teal-400 text-slate-950 shadow-sm"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                {item.label}
                {badge > 0 ? (
                  <span
                    className={`ml-1 inline-flex min-w-[1.1rem] justify-center rounded-full px-1 text-[10px] ${
                      active
                        ? "bg-slate-950/15 text-slate-950"
                        : "bg-white/10 text-slate-300"
                    }`}
                  >
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </nav>

      <main className="mx-auto max-w-lg space-y-4 px-4 py-5 pb-28">
        {error ? (
          <div className="rounded-2xl border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="rounded-2xl border border-emerald-800/60 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-100">
            {notice}
          </div>
        ) : null}

        <div className="rounded-3xl border border-white/10 bg-slate-950/70 p-3.5">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-teal-300/80">
              Filter by location
            </p>
            {filterActive ? (
              <button
                type="button"
                onClick={() => {
                  setBlockFilter("");
                  setRoadFilter("");
                }}
                className="text-xs font-semibold text-slate-400 hover:text-teal-200"
              >
                Clear
              </button>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">
                Block
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={blockFilter}
                placeholder="e.g. 363"
                onChange={(e) => setBlockFilter(e.target.value)}
                className="w-full rounded-2xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:ring-2 focus:ring-teal-400/60"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">
                Road
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={roadFilter}
                placeholder="e.g. 58"
                onChange={(e) => setRoadFilter(e.target.value)}
                className="w-full rounded-2xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none placeholder:text-slate-600 focus:ring-2 focus:ring-teal-400/60"
              />
            </div>
          </div>
          {filterActive ? (
            <p className="mt-2 text-[11px] text-slate-500">
              Showing {list.length} match
              {list.length === 1 ? "" : "es"}
              {tab === "delivered" && deliveredPane === "totals"
                ? " in totals"
                : ""}
            </p>
          ) : null}
        </div>

        {tab === "delivered" ? (
          <div className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-white">
                  Delivered
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  Settlement and order history
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1 rounded-2xl bg-slate-950/70 p-1 ring-1 ring-white/10">
              {[
                { id: "totals", label: "Totals" },
                { id: "orders", label: "Orders" },
              ].map((pane) => {
                const active = deliveredPane === pane.id;
                return (
                  <button
                    key={pane.id}
                    type="button"
                    onClick={() => setDeliveredPane(pane.id)}
                    className={`rounded-xl px-3 py-2.5 text-xs font-semibold transition ${
                      active
                        ? "bg-white text-slate-950"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {pane.label}
                    {pane.id === "orders" && deliveredSummary.count
                      ? ` · ${deliveredSummary.count}`
                      : ""}
                  </button>
                );
              })}
            </div>

            {deliveredPane === "totals" ? (
              <DeliveredTotals
                summary={deliveredSummary}
                currencyDecimals={currencyDecimals}
                currencyCode={currencyCode}
              />
            ) : null}
          </div>
        ) : (
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-white">
              {tab === "new" ? "New orders" : "Accepted orders"}
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              {tab === "new"
                ? "Ready shop deliveries waiting for accept"
                : "Orders you accepted · mark delivered when done"}
            </p>
          </div>
        )}

        {showOrderList ? (
          !list.length ? (
            <div className="rounded-3xl border border-dashed border-white/10 bg-slate-950/50 px-4 py-12 text-center text-sm text-slate-500">
              {filterActive
                ? "No orders match this block / road filter."
                : tab === "new"
                  ? "No new shop deliveries right now."
                  : tab === "view"
                    ? "No accepted shop deliveries yet."
                    : "No delivered shop orders yet."}
            </div>
          ) : (
            <div className="space-y-3">
              {list.map((order) => (
                <OrderCard
                  key={order.id}
                  order={order}
                  tab={tab}
                  busyId={busyId}
                  deliveryBoy={deliveryBoy}
                  currencyDecimals={currencyDecimals}
                  expandedId={expandedId}
                  onToggleBill={(id) =>
                    setExpandedId((prev) => (prev === id ? "" : id))
                  }
                  onAccept={accept}
                  onDeliver={deliver}
                  onSavePayment={savePayment}
                />
              ))}
            </div>
          )
        ) : null}
      </main>

      {blockSuggest ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/75 p-4 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="block-suggest-title"
        >
          <div className="max-h-[85dvh] w-full max-w-lg overflow-hidden rounded-3xl border border-white/10 bg-slate-950 shadow-[0_25px_80px_rgba(0,0,0,0.55)]">
            <div className="border-b border-white/10 bg-gradient-to-br from-teal-500/15 to-transparent px-4 py-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-teal-300/80">
                Same block
              </p>
              <h3
                id="block-suggest-title"
                className="mt-1 text-lg font-semibold tracking-tight text-white"
              >
                Block {blockSuggest.block}
              </h3>
              <p className="mt-1 text-xs text-slate-400">
                {blockSuggest.acceptedOrderNumber
                  ? `${blockSuggest.acceptedOrderNumber} accepted. `
                  : ""}
                Other open orders in this block, sorted by road number.
              </p>
            </div>

            <div className="max-h-[50dvh] overflow-y-auto px-4 py-3">
              {!sameBlockAvailable.length ? (
                <div className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-slate-500">
                  No more available orders in Block {blockSuggest.block}.
                </div>
              ) : (
                <ul className="space-y-2.5">
                  {sameBlockAvailable.map((order) => {
                    const token = tokenLabel(order);
                    const busy = busyId === order.id;
                    return (
                      <li
                        key={order.id}
                        className="rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-white">
                                {order.orderNumber}
                              </span>
                              <span className="rounded-lg bg-teal-500/15 px-2 py-0.5 text-[11px] font-bold text-teal-200 ring-1 ring-teal-400/30">
                                {token || "TOKEN —"}
                              </span>
                            </div>
                            <div className="mt-1 text-xs text-slate-400">
                              Road {order.roadNumber || "—"}
                              {order.buildingNumber
                                ? ` · Building ${order.buildingNumber}`
                                : ""}
                              {order.customerName
                                ? ` · ${order.customerName}`
                                : ""}
                            </div>
                          </div>
                          <div className="shrink-0 text-right text-sm font-semibold tabular-nums text-white">
                            {formatPoolMoney(order)}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={busy || Boolean(busyId)}
                          onClick={() => accept(order, { fromPopup: true })}
                          className="mt-3 w-full rounded-2xl bg-teal-400 px-3 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-teal-300 disabled:opacity-60"
                        >
                          {busy ? "Accepting…" : "Accept delivery"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="border-t border-white/10 px-4 py-3">
              <button
                type="button"
                onClick={() => setBlockSuggest(null)}
                className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm font-semibold text-slate-100"
              >
                {sameBlockAvailable.length ? "Done" : "Close"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
