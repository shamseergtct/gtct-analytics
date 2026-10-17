import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { Minus, Plus, ShoppingBag, Trash2, X } from "lucide-react";
import { db } from "../firebase";
import { useAuth } from "../context/AuthContext.jsx";
import { useClient } from "../context/ClientContext.jsx";
import { useShift, useUnsavedWork } from "../context/shift-context.js";
import { useBankAccounts } from "../hooks/useBankAccounts.js";
import { useFormDraft } from "../hooks/useFormDraft.js";
import { useMoney } from "../hooks/useMoney.js";
import {
  buildPaymentModeOptions,
  findBankAccountName,
  parsePaymentModeSelection,
} from "../utils/paymentModes.js";
import { normalizeShopType, shopTypeLabel } from "../utils/shopTypes.js";
import {
  calcBaseTotal,
  calcTaxAmount,
  getItemBaseCode,
  isDirectSaleItem,
  isInventoryItemActive,
  num,
  roundMoney,
} from "../components/sales/salesHelpers.js";
import {
  makePosInvoiceNo,
  submitPosSaleInvoice,
} from "../utils/posInvoiceSubmit.js";
import {
  cartLineHasKitchenNotes,
  normalizeKitchenCartLine,
} from "../utils/kitchenInstructions.js";
import { compareMenuItems } from "../utils/restaurantMenu.js";
import KitchenInstructionsPicker from "../components/restaurant/KitchenInstructionsPicker.jsx";
import { Link } from "react-router-dom";

const ORDER_TYPES = [
  { value: "COUNTER", label: "Counter" },
  { value: "TAKEAWAY", label: "Take Away" },
  { value: "CARHOP", label: "Car Hop" },
  { value: "DELIVERY", label: "Delivery" },
];

const RESTAURANT_SHOP_TYPES = new Set(["cafe", "restaurant"]);

function isRestaurantShop(shopType) {
  return RESTAURANT_SHOP_TYPES.has(normalizeShopType(shopType));
}

export default function RestaurantSales() {
  const { user, isStaff, canManageShopOps } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const { activeShift, loadingShift } = useShift();
  const { accounts: bankAccounts } = useBankAccounts(activeClientId, {
    purpose: "transaction",
  });
  const { money, decimals } = useMoney();

  const shopType = normalizeShopType(activeClientData?.shop_type);
  const shopOk = isRestaurantShop(shopType);

  const draftKey = `restaurant-sales:${activeClientId || "none"}`;
  const {
    initialDraft,
    syncDraft,
    clearDraft,
    readDraft,
    markDraftHydrated,
  } = useFormDraft(draftKey, {
    label: "Restaurant Sales",
    path: "/restaurant-sales",
    moduleId: "restaurant-sales",
  });
  const draft = initialDraft || {};

  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [category, setCategory] = useState(() => draft.category ?? "");
  const [search, setSearch] = useState(() => draft.search ?? "");
  const [orderType, setOrderType] = useState(
    () => draft.orderType ?? "COUNTER"
  );
  const [destinationNote, setDestinationNote] = useState(
    () => draft.destinationNote ?? ""
  );
  const [customerName, setCustomerName] = useState(
    () => draft.customerName ?? ""
  );
  const [customerPhone, setCustomerPhone] = useState(
    () => draft.customerPhone ?? ""
  );
  const [cart, setCart] = useState(() =>
    Array.isArray(draft.cart)
      ? draft.cart.map((row) => normalizeKitchenCartLine(row))
      : []
  );
  const [paymentSelection, setPaymentSelection] = useState(
    () => draft.paymentSelection ?? "CASH"
  );
  const [step, setStep] = useState("menu"); // menu | review
  const [invoiceNo, setInvoiceNo] = useState(
    () => draft.invoiceNo || makePosInvoiceNo()
  );
  const [taxPct] = useState("0");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [kitchenEditorLineId, setKitchenEditorLineId] = useState("");
  const billingLock = useRef(false);
  const draftKeyRef = useRef(draftKey);

  useLayoutEffect(() => {
    const keyChanged = draftKeyRef.current !== draftKey;
    draftKeyRef.current = draftKey;
    const d = readDraft() || {};
    if (keyChanged || d) {
      setCategory(d.category ?? "");
      setSearch(d.search ?? "");
      setOrderType(d.orderType ?? "COUNTER");
      setDestinationNote(d.destinationNote ?? "");
      setCustomerName(d.customerName ?? "");
      setCustomerPhone(d.customerPhone ?? "");
      setCart(
        Array.isArray(d.cart)
          ? d.cart.map((row) => normalizeKitchenCartLine(row))
          : []
      );
      setPaymentSelection(d.paymentSelection ?? "CASH");
      setInvoiceNo(d.invoiceNo || makePosInvoiceNo());
    }
    markDraftHydrated();
  }, [draftKey, readDraft, markDraftHydrated]);

  useEffect(() => {
    syncDraft({
      category,
      search,
      orderType,
      destinationNote,
      customerName,
      customerPhone,
      cart,
      paymentSelection,
      invoiceNo,
    });
  }, [
    category,
    search,
    orderType,
    destinationNote,
    customerName,
    customerPhone,
    cart,
    paymentSelection,
    invoiceNo,
    syncDraft,
  ]);

  useUnsavedWork(
    "restaurant-sales",
    "Restaurant Sales",
    cart.length > 0
  );

  useEffect(() => {
    if (!activeClientId || !shopOk) {
      setItems([]);
      setLoadingItems(false);
      return undefined;
    }
    setLoadingItems(true);
    const q = query(
      collection(db, "inventory"),
      where("clientId", "==", activeClientId),
      orderBy("itemName", "asc")
    );
    return onSnapshot(
      q,
      (snap) => {
        setItems(
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .filter(
              (it) => isDirectSaleItem(it) && isInventoryItemActive(it)
            )
        );
        setLoadingItems(false);
      },
      () => {
        setItems([]);
        setLoadingItems(false);
      }
    );
  }, [activeClientId, shopOk]);

  const categories = useMemo(() => {
    const set = new Set();
    for (const it of items) {
      const c = String(it.category || "").trim();
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const menuItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((it) => {
        if (category && String(it.category || "") !== category) return false;
        if (!q) return true;
        return `${getItemBaseCode(it)} ${it.itemName || ""} ${it.subCategory || ""}`
          .toLowerCase()
          .includes(q);
      })
      .slice()
      .sort(compareMenuItems);
  }, [items, search, category]);

  const paymentOptions = useMemo(
    () =>
      buildPaymentModeOptions({
        bankAccounts,
        includeCredit: !isStaff,
      }),
    [bankAccounts, isStaff]
  );

  const totals = useMemo(() => {
    const subTotal = roundMoney(
      cart.reduce((s, row) => s + num(row.baseTotal), 0),
      decimals
    );
    const taxAmount = roundMoney(
      cart.reduce((s, row) => s + num(row.taxAmount), 0),
      decimals
    );
    const discountTotal = 0;
    const grandTotalBeforeTax = roundMoney(subTotal - discountTotal, decimals);
    const grandTotal = roundMoney(grandTotalBeforeTax + taxAmount, decimals);
    return {
      subTotal,
      discountTotal,
      grandTotalBeforeTax,
      taxAmount,
      grandTotal,
    };
  }, [cart, decimals]);

  const cartCount = cart.reduce((s, row) => s + num(row.qty), 0);

  function addItem(item) {
    setErr("");
    setMsg("");
    const price = num(item.sellingPrice);
    if (price < 0) {
      setErr("Selling price must be zero or greater.");
      return;
    }
    setCart((current) => {
      // Match Sales.jsx: only merge into lines with no notes/instructions.
      const existing = current.find(
        (row) => row.itemId === item.id && !cartLineHasKitchenNotes(row)
      );
      if (existing) {
        return current.map((row) => {
          if (row.lineId !== existing.lineId) return row;
          const qty = num(row.qty) + 1;
          const baseTotal = calcBaseTotal(qty, row.sellingPrice);
          const taxAmount = calcTaxAmount(qty, row.sellingPrice, row.taxPct);
          return {
            ...row,
            qty,
            baseTotal,
            taxAmount,
            total: roundMoney(baseTotal + taxAmount, decimals),
          };
        });
      }
      const qty = 1;
      const baseTotal = calcBaseTotal(qty, price);
      const taxAmount = calcTaxAmount(qty, price, taxPct);
      return [
        ...current,
        {
          lineId: crypto.randomUUID(),
          itemId: item.id,
          itemCode: getItemBaseCode(item),
          itemName: item.itemName || "",
          qty,
          cost: num(item.cost),
          sellingPrice: price,
          taxPct: num(taxPct),
          baseTotal,
          taxAmount,
          total: roundMoney(baseTotal + taxAmount, decimals),
          kitchenInstructions: [],
          customKitchenNote: "",
          description: "",
        },
      ];
    });
  }

  function updateLine(lineId, patch) {
    setCart((current) =>
      current.map((row) => {
        if (row.lineId !== lineId) return row;
        const next = { ...row, ...patch };
        const qty = num(next.qty);
        const price = num(next.sellingPrice);
        const tax = num(next.taxPct);
        const baseTotal = calcBaseTotal(qty, price);
        const taxAmount = calcTaxAmount(qty, price, tax);
        return {
          ...next,
          qty,
          sellingPrice: price,
          taxPct: tax,
          baseTotal,
          taxAmount,
          total: roundMoney(baseTotal + taxAmount, decimals),
        };
      })
    );
  }

  function removeLine(lineId) {
    setCart((current) => current.filter((row) => row.lineId !== lineId));
  }

  function resetAfterSuccess() {
    setCart([]);
    setDestinationNote("");
    setCustomerName("");
    setCustomerPhone("");
    setOrderType("COUNTER");
    setPaymentSelection("CASH");
    setInvoiceNo(makePosInvoiceNo());
    setStep("menu");
    setCartOpen(false);
    clearDraft();
  }

  async function confirmOrder() {
    if (billingLock.current || saving) return;
    setErr("");
    setMsg("");

    if (!shopOk) {
      setErr("Restaurant Sales is only available for Café / Restaurant shops.");
      return;
    }
    if (loadingShift) {
      setErr("Active shift is still loading.");
      return;
    }
    if (!activeShift?.id) {
      setErr("Open a shift before recording a sale.");
      return;
    }
    const focMissing = cart.find(
      (item) =>
        num(item.sellingPrice) === 0 &&
        !String(item.description || "").trim()
    );
    if (focMissing) {
      setErr(
        `Description is required for FOC / zero-price items (${
          focMissing.itemName || "item"
        }).`
      );
      return;
    }

    const parsed = parsePaymentModeSelection(paymentSelection);
    billingLock.current = true;
    setSaving(true);
    try {
      await submitPosSaleInvoice({
        user,
        clientId: activeClientId,
        clientName: activeClientData?.name || "",
        activeShift,
        bankAccounts,
        cart,
        totals,
        invoiceNo,
        orderType,
        destinationNote,
        paymentMode: parsed.paymentMode || "CASH",
        bankAccountId: parsed.bankAccountId || "",
        bankAccountName: findBankAccountName(
          bankAccounts,
          parsed.bankAccountId
        ),
        settlementMode: "full",
        printerMode: "THERMAL",
        decimals,
        entrySource: "restaurant_sales",
        allowCredit: !isStaff,
        enforceStockAvailability: false,
        customerName,
        customerPhone,
        address1: orderType === "DELIVERY" ? destinationNote : "",
      });
      setMsg("Order saved successfully.");
      resetAfterSuccess();
    } catch (reason) {
      setErr(reason?.message || "Failed to save order.");
    } finally {
      billingLock.current = false;
      setSaving(false);
    }
  }

  if (!activeClientId) {
    return (
      <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-6 text-amber-100">
        Select an active shop to take restaurant orders.
      </div>
    );
  }

  if (!shopOk) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
        <h1 className="text-xl font-semibold text-white">Restaurant Sales</h1>
        <p className="mt-2 text-sm text-slate-400">
          This workspace is for {shopTypeLabel("cafe")} and{" "}
          {shopTypeLabel("restaurant")} shops only. Current shop type:{" "}
          {shopTypeLabel(shopType)}.
        </p>
      </div>
    );
  }

  const cartPanel = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-white">
          Cart ({cartCount || 0})
        </h2>
        <button
          type="button"
          className="rounded-lg border border-slate-700 p-2 text-slate-400 lg:hidden"
          onClick={() => setCartOpen(false)}
          aria-label="Close cart"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {!cart.length ? (
          <p className="px-1 py-6 text-center text-sm text-slate-500">
            Tap menu items to build the order.
          </p>
        ) : (
          cart.map((row) => (
            <div
              key={row.lineId}
              className="rounded-xl border border-slate-800 bg-slate-950/50 p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-sm font-semibold text-white">
                  {row.itemName}
                </p>
                <button
                  type="button"
                  onClick={() => removeLine(row.lineId)}
                  className="rounded-lg border border-rose-900/50 p-1.5 text-rose-300"
                  aria-label="Remove item"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="mt-2 grid grid-cols-[auto_1fr_1fr] items-end gap-2">
                <div>
                  <span className="mb-0.5 block text-[10px] uppercase text-slate-500">
                    Qty
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 text-white"
                      onClick={() =>
                        updateLine(row.lineId, {
                          qty: Math.max(1, num(row.qty) - 1),
                        })
                      }
                    >
                      <Minus size={14} />
                    </button>
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0.0001"
                      step="any"
                      value={row.qty}
                      onChange={(e) =>
                        updateLine(row.lineId, { qty: e.target.value })
                      }
                      className="h-9 w-14 rounded-lg border border-slate-700 bg-slate-900 px-1 text-center text-sm font-semibold tabular-nums text-white"
                      aria-label={`Quantity for ${row.itemName}`}
                    />
                    <button
                      type="button"
                      className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 text-white"
                      onClick={() =>
                        updateLine(row.lineId, { qty: num(row.qty) + 1 })
                      }
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
                <label className="block min-w-0">
                  <span className="mb-0.5 block text-[10px] uppercase text-slate-500">
                    Price
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={row.sellingPrice}
                    onChange={(e) =>
                      updateLine(row.lineId, {
                        sellingPrice: e.target.value,
                      })
                    }
                    className="h-9 w-full rounded-lg border border-slate-700 bg-slate-900 px-2 text-right text-sm tabular-nums text-white"
                    aria-label={`Price for ${row.itemName}`}
                  />
                </label>
                <div className="min-w-0 text-right">
                  <span className="mb-0.5 block text-[10px] uppercase text-slate-500">
                    Line
                  </span>
                  <p className="flex h-9 items-center justify-end text-sm font-semibold tabular-nums text-amber-300">
                    {money(row.total)}
                  </p>
                </div>
              </div>
              <KitchenInstructionsPicker
                key={row.lineId}
                itemName={row.itemName}
                instructions={row.kitchenInstructions || []}
                customNote={row.customKitchenNote || ""}
                open={kitchenEditorLineId === row.lineId}
                onOpenChange={(nextOpen) =>
                  setKitchenEditorLineId(nextOpen ? row.lineId : "")
                }
                onChange={(patch) => updateLine(row.lineId, patch)}
              />
              {num(row.sellingPrice) === 0 &&
              !String(row.description || "").trim() ? (
                <p className="mt-1 text-xs text-amber-300">
                  Description required for FOC / zero-price items.
                </p>
              ) : null}
            </div>
          ))
        )}
      </div>
      <div className="space-y-2 border-t border-slate-800 px-4 py-3">
        <div className="flex justify-between text-sm text-slate-300">
          <span>Subtotal</span>
          <span className="tabular-nums">{money(totals.subTotal)}</span>
        </div>
        <div className="flex justify-between text-sm text-slate-300">
          <span>Tax</span>
          <span className="tabular-nums">{money(totals.taxAmount)}</span>
        </div>
        <div className="flex justify-between text-base font-semibold text-white">
          <span>Total</span>
          <span className="tabular-nums text-amber-300">
            {money(totals.grandTotal)}
          </span>
        </div>
        {step === "menu" ? (
          <button
            type="button"
            disabled={!cart.length}
            onClick={() => {
              setStep("review");
              setCartOpen(false);
              setErr("");
            }}
            className="w-full rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-slate-950 disabled:opacity-40"
          >
            Review order
          </button>
        ) : (
          <button
            type="button"
            disabled={saving || !cart.length}
            onClick={confirmOrder}
            className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? "Saving…" : "Confirm & bill"}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-6xl pb-24 lg:pb-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-white sm:text-2xl">
            Restaurant Sales
          </h1>
          <p className="mt-1 text-xs text-slate-500">
            {shopTypeLabel(shopType)} · Invoice {invoiceNo}
            {activeShift?.businessDate
              ? ` · ${activeShift.businessDate}`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canManageShopOps ? (
            <Link
              to="/restaurant-menu"
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200"
            >
              Menu setup
            </Link>
          ) : null}
          {step === "review" ? (
            <button
              type="button"
              onClick={() => setStep("menu")}
              className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200"
            >
              Back to menu
            </button>
          ) : null}
        </div>
      </div>

      {err ? (
        <div className="mb-3 rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
          {err}
        </div>
      ) : null}
      {msg ? (
        <div className="mb-3 rounded-xl border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">
          {msg}
        </div>
      ) : null}

      {step === "review" ? (
        <div className="grid gap-4 lg:grid-cols-12">
          <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/40 p-4 lg:col-span-7">
            <h2 className="text-sm font-semibold text-white">Review & pay</h2>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Order type
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {ORDER_TYPES.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setOrderType(opt.value)}
                    className={`rounded-xl px-3 py-3 text-sm font-semibold ${
                      orderType === opt.value
                        ? "bg-amber-500 text-slate-950"
                        : "border border-slate-700 bg-slate-950 text-slate-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="block text-sm text-slate-300">
              {orderType === "DELIVERY"
                ? "Delivery address"
                : "Table / destination (optional)"}
              <input
                value={destinationNote}
                onChange={(e) => setDestinationNote(e.target.value)}
                placeholder={
                  orderType === "DELIVERY"
                    ? "Street / building / landmark"
                    : "e.g. Table 4, Window seat, Car bay 2"
                }
                className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"
              />
            </label>
            {orderType === "DELIVERY" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm text-slate-300">
                  Customer name
                  <input
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"
                  />
                </label>
                <label className="block text-sm text-slate-300">
                  Mobile number
                  <input
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"
                  />
                </label>
              </div>
            ) : null}
            <label className="block text-sm text-slate-300">
              Payment
              <select
                value={paymentSelection}
                onChange={(e) => setPaymentSelection(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-white"
              >
                {paymentOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {isStaff ? (
                <span className="mt-1 block text-xs text-slate-500">
                  Staff can take cash or bank payments only.
                </span>
              ) : null}
            </label>
            <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">
              {cart.map((row) => (
                <li
                  key={row.lineId}
                  className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm"
                >
                  <div>
                    <p className="font-medium text-white">
                      {row.qty} × {row.itemName}
                    </p>
                    {row.description ? (
                      <p className="whitespace-pre-line text-xs text-slate-500">
                        {row.description}
                      </p>
                    ) : null}
                  </div>
                  <span className="tabular-nums text-slate-200">
                    {money(row.total)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="hidden overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40 lg:col-span-5 lg:block">
            {cartPanel}
          </div>
          <div className="lg:hidden">
            <button
              type="button"
              disabled={saving || !cart.length}
              onClick={confirmOrder}
              className="w-full rounded-xl bg-emerald-600 px-4 py-3.5 text-sm font-semibold text-white disabled:opacity-40"
            >
              {saving ? "Saving…" : `Confirm & bill · ${money(totals.grandTotal)}`}
            </button>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search menu…"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-white"
              />
            </div>
            {categories.length ? (
              <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setCategory("")}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
                    !category
                      ? "bg-amber-500 text-slate-950"
                      : "border border-slate-700 text-slate-300"
                  }`}
                >
                  All
                </button>
                {categories.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCategory(c)}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
                      category === c
                        ? "bg-amber-500 text-slate-950"
                        : "border border-slate-700 text-slate-300"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : null}

            {loadingItems ? (
              <p className="text-sm text-slate-400">Loading menu…</p>
            ) : menuItems.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-700 px-4 py-10 text-center text-sm text-slate-500">
                No menu items found.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {menuItems.map((it) => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => addItem(it)}
                    className="flex min-h-[96px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 text-left transition-colors hover:border-amber-500/50 active:scale-[0.98]"
                  >
                    {it.imageUrl ? (
                      <img
                        src={it.imageUrl}
                        alt=""
                        className="h-20 w-full object-cover"
                      />
                    ) : null}
                    <span className="flex flex-1 flex-col justify-between p-3">
                      <span className="line-clamp-2 text-sm font-semibold text-white">
                        {it.itemName || "Item"}
                      </span>
                      <span className="mt-2 flex items-center justify-between gap-1">
                        <span className="font-mono text-[10px] text-slate-500">
                          {getItemBaseCode(it) || "—"}
                        </span>
                        <span className="text-sm font-bold text-amber-300">
                          {money(it.sellingPrice)}
                        </span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="hidden overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40 lg:col-span-5 lg:block lg:min-h-[28rem]">
            {cartPanel}
          </div>
        </div>
      )}

      {/* Mobile cart FAB / sheet */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-800 bg-slate-950/95 p-3 backdrop-blur lg:hidden">
        <button
          type="button"
          onClick={() => setCartOpen(true)}
          className="flex w-full items-center justify-between rounded-xl bg-amber-500 px-4 py-3 text-sm font-semibold text-slate-950"
        >
          <span className="inline-flex items-center gap-2">
            <ShoppingBag size={18} />
            View cart ({cartCount || 0})
          </span>
          <span className="tabular-nums">{money(totals.grandTotal)}</span>
        </button>
      </div>

      {cartOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            aria-label="Dismiss cart"
            onClick={() => setCartOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-hidden rounded-t-2xl border border-slate-700 bg-slate-900 shadow-2xl">
            {cartPanel}
          </div>
        </div>
      ) : null}
    </div>
  );
}
