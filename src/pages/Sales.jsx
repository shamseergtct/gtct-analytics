// src/pages/Sales.jsx
console.log("🔥 SALES COMPONENT LOADED FROM THIS FILE");

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useShift, useUnsavedWork } from "../context/shift-context.js";
import ModuleExitButton from "../components/ModuleExitButton.jsx";
import ModuleHelpButton from "../components/ModuleHelpButton.jsx";
import { formatDateValue } from "../utils/dateFormat.js";
import {
  buildTransactionPayload,
} from "../utils/transactionContract.js";
import { useBankAccounts } from "../hooks/useBankAccounts.js";
import { assertOperationalBankAccount } from "../utils/bankAccountTypes.js";
import {
  buildPaymentModeOptions,
  findBankAccountName,
  legacyPaymentModeFlags,
  parsePaymentModeSelection,
  paymentModeSelectionFromSaved,
} from "../utils/paymentModes.js";
import { getSalesLayout } from "../components/sales/index.js";
import { openHtmlPrintWindow } from "../utils/openPrintWindow.js";
import {
  formatPaymentLabel,
  itemMatchesSearchQuery,
  resolveSaleTenders,
  saleTenderTxnId,
  tenderTotals,
} from "../components/sales/salesHelpers.js";
import { getPartyCode, nextPartyCode } from "../utils/partyCode.js";
import { normalizeShopType, shopTypeLabel } from "../utils/shopTypes.js";
import { useMoney } from "../hooks/useMoney.js";
import { useFormDraft } from "../hooks/useFormDraft.js";
import { formatMoney, numMoney } from "../utils/money.js";

/**
 * =========================
 * Helpers
 * =========================
 */
function num(v) {
  return numMoney(v);
}
function calcBaseTotal(qty, sellingPrice) {
  return Math.max(0, num(qty) * num(sellingPrice));
}
function calcTaxAmount(qty, sellingPrice, taxPct) {
  const base = calcBaseTotal(qty, sellingPrice);
  return Math.max(0, (base * num(taxPct)) / 100);
}

function todayYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dateStrToMsMidday(dateStr) {
  if (!dateStr) return Date.now();
  const d = new Date(`${dateStr}T12:00:00`);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}
function msToYYYYMMDD(value) {
  const d = new Date(num(value));
  if (Number.isNaN(d.getTime())) return todayYYYYMMDD();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function quantitiesByItem(rows) {
  const totals = new Map();
  for (const row of rows || []) {
    if (!row?.itemId) continue;
    totals.set(row.itemId, num(totals.get(row.itemId)) + num(row.qty));
  }
  return totals;
}
function tenderFormValue(value, bankAccountId = "") {
  return paymentModeSelectionFromSaved(value, bankAccountId);
}
function makeInvoiceNo() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `INV-${y}${m}${day}-${hh}${mm}`;
}
function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function normPhone(p) {
  return String(p || "").trim().replace(/\s+/g, "");
}

function getItemBaseCode(item) {
  return item?.itemCode || item?.code || item?.sku || "";
}

/**
 * =========================
 * Printing (A4 / Thermal)
 * =========================
 */
function printInvoice({ shopName, invoice, items, mode, decimals }) {
  const money = (v) => formatMoney(v, decimals);
  const title = `Invoice ${invoice.invoiceNo || ""}`;
  const safeShop = escapeHtml(shopName || "Shop");
  const invNo = escapeHtml(invoice.invoiceNo || "");
  const invDate = escapeHtml(
    formatDateValue(invoice.saleAtMs, "-")
  );

  const custName = escapeHtml(invoice.customerName || "");
  const phone = escapeHtml(invoice.customerPhone || "");
  const a1 = escapeHtml(invoice.address1 || "");
  const a2 = escapeHtml(invoice.address2 || "");
  const a3 = escapeHtml(invoice.address3 || "");

  const rowsHtml = (items || [])
    .map((it, idx) => {
      const sn = idx + 1;
      const code = escapeHtml(it.itemCode || "");
      const name = escapeHtml(it.itemName || "");
      const qty = money(it.qty);
      const sellingPrice = money(it.sellingPrice);
      const total = money(it.total);
      const desc = escapeHtml(it.description || "");

      return `
        <tr>
          <td class="sn">${sn}</td>
          <td class="code">${code}</td>
          <td class="name">${name}</td>
          <td class="num">${qty}</td>
          <td class="num">${sellingPrice}</td>
          <td class="num">${total}</td>
        </tr>
        ${
          desc
            ? `<tr class="desc-row"><td></td><td colspan="5" class="desc">↳ ${desc}</td></tr>`
            : ""
        }
      `;
    })
    .join("");

  const subTotal = money(invoice.subTotal);
  const grandBeforeTax = money(invoice.grandTotalBeforeTax ?? invoice.grandTotal);
  const taxAmount = money(invoice.taxAmount || 0);
  const grandTotal = money(invoice.grandTotal);

  const isThermal = mode === "THERMAL";

  const cssA4 = `
    @page { size: A4; margin: 10mm; }
    body { font-family: Arial, sans-serif; color: #111; }
    .wrap { width: 100%; }
    .hdr { display:flex; justify-content:space-between; align-items:flex-start; gap: 12px; }
    .shop { font-size: 18px; font-weight: 800; }
    .meta { text-align:right; font-size: 12px; }
    .box { border: 1px solid #000; padding: 8px; margin-top: 10px; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
    th, td { border: 1px solid #000; padding: 6px; vertical-align: top; }
    th { background: #f2f2f2; }
    .num { text-align: right; white-space: nowrap; }
    .sn { width: 26px; text-align:center; }
    .code { width: 90px; }
    .name { width: auto; }
    .muted { color:#444; font-size: 11px; }
    .desc-row td { border-top: none; }
    .desc { font-size: 11px; color:#111; padding-top: 2px; padding-bottom: 8px; }
    .totals { margin-top: 10px; width: 100%; display:flex; justify-content:flex-end; }
    .totals table { width: 360px; font-size: 12px; }
    .totals td { padding: 6px; }
    .gt { font-weight: 800; }
    .foot { margin-top: 12px; font-size: 11px; text-align:center; }
  `;

  const cssThermal = `
    @page { size: 80mm auto; margin: 4mm; }
    body { font-family: Arial, sans-serif; color: #111; }
    .wrap { width: 72mm; }
    .shop { font-size: 14px; font-weight: 800; text-align:center; }
    .meta { font-size: 10px; text-align:center; margin-top: 4px; }
    .box { border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 6px 0; margin-top: 6px; font-size: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 10px; }
    th, td { padding: 3px 0; vertical-align: top; }
    th { border-bottom: 1px dashed #000; }
    .num { text-align: right; white-space: nowrap; }
    .desc { font-size: 9px; padding-left: 10px; }
    .muted { color:#444; font-size: 9px; }
    .foot { margin-top: 8px; font-size: 10px; text-align:center; border-top: 1px dashed #000; padding-top: 6px; }
  `;

  const html = `
    <html>
      <head>
        <title>${escapeHtml(title)}</title>
        <style>${isThermal ? cssThermal : cssA4}</style>
      </head>
      <body>
        <div class="wrap">
          <div class="hdr">
            <div class="shop">${safeShop}</div>
            ${
              isThermal
                ? ""
                : `<div class="meta">
                    <div><b>Invoice:</b> ${invNo}</div>
                    <div><b>Date:</b> ${invDate}</div>
                  </div>`
            }
          </div>

          ${
            isThermal
              ? `<div class="meta">
                  <div><b>Invoice:</b> ${invNo}</div>
                  <div><b>Date:</b> ${invDate}</div>
                </div>`
              : ""
          }

          <div class="box">
            <div><b>Customer:</b> ${custName || "-"}</div>
            <div><b>Phone:</b> ${phone || "-"}</div>
            ${(a1 || a2 || a3) ? `<div><b>Address:</b> ${[a1,a2,a3].filter(Boolean).join(", ")}</div>` : ""}
            <div><b>Payment:</b> ${escapeHtml(formatPaymentLabel(invoice, decimals))}</div>
            <div><b>Order Type:</b> ${escapeHtml(invoice.orderType || "-")}</div>
          </div>

          <table>
            <thead>
              <tr>
                <th>SN</th>
                <th>Item code</th>
                <th>Item Name</th>
                <th class="num">QTY</th>
                <th class="num">Price</th>
                <th class="num">Total</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>

          ${
            isThermal
              ? `
                <div style="margin-top:8px; font-size:10px;">
                  <div style="display:flex; justify-content:space-between;"><span>Sub Total</span><span>${subTotal}</span></div>
                  <div style="display:flex; justify-content:space-between;"><span>Grand Total (Before Tax)</span><span>${grandBeforeTax}</span></div>
                  <div style="display:flex; justify-content:space-between;"><span>Tax</span><span>${taxAmount}</span></div>
                  <div style="display:flex; justify-content:space-between; font-weight:800;"><span>Grand Total</span><span>${grandTotal}</span></div>
                </div>
              `
              : `
                <div class="totals">
                  <table>
                    <tr><td>Sub Total</td><td class="num">${subTotal}</td></tr>
                    <tr><td>Grand Total (Before Tax)</td><td class="num">${grandBeforeTax}</td></tr>
                    <tr><td>Tax (Item-wise)</td><td class="num">${taxAmount}</td></tr>
                    <tr><td class="gt">Grand Total</td><td class="num gt">${grandTotal}</td></tr>
                  </table>
                </div>
              `
          }

          <div class="foot">
            Thank you. Visit again!
          </div>
        </div>

        <script>
          window.onload = function () {
            window.focus();
            window.print();
            // Keep the preview open until after the print dialog closes.
            // Closing too early leaves a blank print screen.
            window.onafterprint = function () {
              window.close();
            };
          };
        </script>
      </body>
    </html>
  `;

  try {
    openHtmlPrintWindow(html, { width: 900, height: 700, autoPrint: true });
  } catch {
    alert("Popup blocked. Allow popups to print.");
  }
}

/**
 * =========================
 * Page
 * =========================
 */
export default function Sales() {
  const navigate = useNavigate();
  const { activeClientId, activeClientData } = useClient();
  const { user } = useAuth();
  const { activeShift, loadingShift } = useShift();
  const { accounts: bankAccounts } = useBankAccounts(activeClientId);
  const { money, round, decimals, toMinor } = useMoney();
  const draftKey = `sales:${activeClientId || "none"}`;
  const {
    initialDraft,
    syncDraft,
    clearDraft,
    readDraft,
    markDraftHydrated,
  } = useFormDraft(draftKey, {
    label: "Sales / Billing",
    path: "/sales",
    moduleId: "sales",
  });
  const draft = initialDraft || {};

  // Tabs
  const [tab, setTab] = useState(() => draft.tab ?? "new"); // new | history

  // Inventory for item search
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(true);

  // Customers (from Parties: Customer / Both)
  const [customers, setCustomers] = useState([]);
  const [loadingCustomers, setLoadingCustomers] = useState(false);

  // Invoice History
  const [invoices, setInvoices] = useState([]);
  const [loadingInv, setLoadingInv] = useState(false);
  const [invSearch, setInvSearch] = useState("");
  const [editingInvoice, setEditingInvoice] = useState(
    () => draft.editingInvoice ?? null
  );

  // Printer selection
  const [printMode, setPrintMode] = useState(() => draft.printMode ?? "A4"); // A4 | THERMAL

  // Invoice fields
  const [saleDate, setSaleDate] = useState(
    () => draft.saleDate || todayYYYYMMDD()
  );
  const [invoiceNo, setInvoiceNo] = useState(
    () => draft.invoiceNo || makeInvoiceNo()
  );
  const [paymentMode, setPaymentMode] = useState(
    () => draft.paymentMode ?? "CASH"
  );
  const [settlementMode, setSettlementMode] = useState(
    () => draft.settlementMode ?? "full"
  ); // full | split
  const [payCash, setPayCash] = useState(() => draft.payCash ?? "");
  const [payBank, setPayBank] = useState(() => draft.payBank ?? "");
  const [payCredit, setPayCredit] = useState(() => draft.payCredit ?? "");
  const paymentModeOptions = useMemo(
    () =>
      buildPaymentModeOptions({
        bankAccounts,
        includeCredit: true,
        ...legacyPaymentModeFlags(paymentMode),
      }),
    [bankAccounts, paymentMode]
  );
  const resolvedPayment = parsePaymentModeSelection(paymentMode);
  const [orderType, setOrderType] = useState(
    () => draft.orderType ?? "COUNTER"
  ); // COUNTER | TAKEAWAY | CARHOP | DELIVERY

  // Customer fields (select OR add)
  const [customerId, setCustomerId] = useState(() => draft.customerId ?? ""); // optional
  const [customerName, setCustomerName] = useState(
    () => draft.customerName ?? ""
  );
  const [customerPhone, setCustomerPhone] = useState(
    () => draft.customerPhone ?? ""
  );
  const [address1, setAddress1] = useState(() => draft.address1 ?? "");
  const [address2, setAddress2] = useState(() => draft.address2 ?? "");
  const [address3, setAddress3] = useState(() => draft.address3 ?? "");

  // Item add
  const [search, setSearch] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [qty, setQty] = useState("1");
  const [lineSellingPrice, setLineSellingPrice] = useState("");
  const [taxPct, setTaxPct] = useState("0");
  const [itemDesc, setItemDesc] = useState("");

  const qtyRef = useRef(null);
  const searchRef = useRef(null);
  const taxPctRef = useRef(null);
  const sellingPriceRef = useRef(null);
  const addBtnRef = useRef(null);

  // Cart rows
  const [cart, setCart] = useState(() =>
    Array.isArray(draft.cart) ? draft.cart : []
  );

  // UI states
  const [saving, setSaving] = useState(false);
  const billingLock = useRef(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const hasUnsavedSalesWork = Boolean(cart.length || editingInvoice);
  useUnsavedWork("sales", "Sales / Billing", hasUnsavedSalesWork);

  const salesDraftKeyRef = useRef(null);
  useLayoutEffect(() => {
    const isFirst = salesDraftKeyRef.current === null;
    const keyChanged = salesDraftKeyRef.current !== draftKey;
    salesDraftKeyRef.current = draftKey;
    if (isFirst) {
      markDraftHydrated();
      return;
    }
    if (!keyChanged) return;
    const d = readDraft() || {};
    setTab(d.tab ?? "new");
    setEditingInvoice(d.editingInvoice ?? null);
    setPrintMode(d.printMode ?? "A4");
    setSaleDate(d.saleDate || todayYYYYMMDD());
    setInvoiceNo(d.invoiceNo || makeInvoiceNo());
    setPaymentMode(d.paymentMode ?? "CASH");
    setSettlementMode(d.settlementMode ?? "full");
    setPayCash(d.payCash ?? "");
    setPayBank(d.payBank ?? "");
    setPayCredit(d.payCredit ?? "");
    setOrderType(d.orderType ?? "COUNTER");
    setCustomerId(d.customerId ?? "");
    setCustomerName(d.customerName ?? "");
    setCustomerPhone(d.customerPhone ?? "");
    setAddress1(d.address1 ?? "");
    setAddress2(d.address2 ?? "");
    setAddress3(d.address3 ?? "");
    setCart(Array.isArray(d.cart) ? d.cart : []);
    markDraftHydrated();
  }, [draftKey, readDraft, markDraftHydrated]);

  useEffect(() => {
    syncDraft(
      {
        tab,
        cart,
        editingInvoice,
        printMode,
        saleDate,
        invoiceNo,
        paymentMode,
        settlementMode,
        payCash,
        payBank,
        payCredit,
        orderType,
        customerId,
        customerName,
        customerPhone,
        address1,
        address2,
        address3,
      },
      { dirty: hasUnsavedSalesWork }
    );
  }, [
    syncDraft,
    hasUnsavedSalesWork,
    tab,
    cart,
    editingInvoice,
    printMode,
    saleDate,
    invoiceNo,
    paymentMode,
    settlementMode,
    payCash,
    payBank,
    payCredit,
    orderType,
    customerId,
    customerName,
    customerPhone,
    address1,
    address2,
    address3,
  ]);

  useEffect(() => {
    if (!editingInvoice && activeShift?.businessDate) {
      setSaleDate(activeShift.businessDate);
    }
  }, [activeShift?.businessDate, editingInvoice]);

  /**
   * =========================
   * Load default printer mode for this shop
   * =========================
   */
  useEffect(() => {
    async function loadPrinterDefault() {
      if (!activeClientId) return;
      try {
        const ref = doc(db, "client_settings", activeClientId);
        const snap = await getDoc(ref);

        if (snap.exists()) {
          const data = snap.data();
          const def = data?.defaultPrinterMode;
          if (def === "A4" || def === "THERMAL") setPrintMode(def);
        }
      } catch (e) {
        console.error("Failed to load printer default:", e);
      }
    }
    loadPrinterDefault();
  }, [activeClientId]);

  /**
   * =========================
   * Load inventory items
   * =========================
   */
  useEffect(() => {
    if (!activeClientId) {
      setItems([]);
      setLoadingItems(false);
      return;
    }

    setLoadingItems(true);
    const qy = query(
      collection(db, "inventory"),
      where("clientId", "==", activeClientId),
      orderBy("itemName", "asc")
    );

    const unsub = onSnapshot(
      qy,
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoadingItems(false);
      },
      (e) => {
        console.error("Inventory load error:", e);
        setItems([]);
        setLoadingItems(false);
      }
    );

    return () => unsub();
  }, [activeClientId]);

  /**
   * =========================
   * Load customers from Parties
   * =========================
   */
  useEffect(() => {
    async function fetchCustomers() {
      if (!activeClientId) {
        setCustomers([]);
        return;
      }
      setLoadingCustomers(true);
      try {
        const qy = query(
          collection(db, "parties"),
          where("clientId", "==", activeClientId),
          orderBy("name", "asc")
        );
        const snap = await getDocs(qy);
        const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const onlyCustomers = all.filter(
          (p) => p.type === "Customer" || p.type === "Both"
        );
        setCustomers(onlyCustomers);
      } catch (e) {
        console.error("Customer fetch error:", e);
        setCustomers([]);
      } finally {
        setLoadingCustomers(false);
      }
    }
    fetchCustomers();
  }, [activeClientId]);

  /**
   * =========================
   * Load invoice history (when tab = history)
   * =========================
   */
  useEffect(() => {
    if (!activeClientId) {
      setInvoices([]);
      return;
    }
    if (tab !== "history") return;

    setLoadingInv(true);

    const qy = query(
      collection(db, "sales_invoices"),
      where("clientId", "==", activeClientId)
    );

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => (b.saleAtMs || 0) - (a.saleAtMs || 0));
        setInvoices(list);
        setLoadingInv(false);
      },
      (e) => {
        console.error("History error:", e);
        setInvoices([]);
        setLoadingInv(false);
      }
    );

    return () => unsub();
  }, [activeClientId, tab]);

  /**
   * =========================
   * Computed / Filters
   * =========================
   */
  const selectedItem = useMemo(
    () => items.find((x) => x.id === selectedItemId) || null,
    [items, selectedItemId]
  );

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || selectedItemId) return [];
    return items.filter((it) => itemMatchesSearchQuery(it, q)).slice(0, 8);
  }, [items, search, selectedItemId]);

  // ✅ Totals + Tax (item-wise) — rounded to client currency decimals
  const totals = useMemo(() => {
    const subTotal = round(cart.reduce((s, x) => s + num(x.baseTotal), 0));
    const discountTotal = 0;
    const grandTotalBeforeTax = round(
      cart.reduce((s, x) => s + num(x.baseTotal), 0)
    );
    const taxAmount = round(cart.reduce((s, x) => s + num(x.taxAmount), 0));
    const grandTotal = round(grandTotalBeforeTax + taxAmount);

    return { subTotal, discountTotal, grandTotalBeforeTax, taxAmount, grandTotal };
  }, [cart, round]);

  const historyFiltered = useMemo(() => {
    const q = invSearch.trim().toLowerCase();
    if (!q) return invoices;
    return invoices.filter((inv) => {
      const s = `${inv.invoiceNo || ""} ${inv.customerName || ""} ${
        inv.customerPhone || ""
      } ${inv.paymentMode || ""} ${inv.orderType || ""} ${inv.status || ""}`.toLowerCase();
      return s.includes(q);
    });
  }, [invoices, invSearch]);

  /**
   * =========================
   * Customer select
   * =========================
   */
  function onSelectCustomer(id) {
    setCustomerId(id);

    if (!id) {
      setCustomerName("");
      setCustomerPhone("");
      setAddress1("");
      setAddress2("");
      setAddress3("");
      return;
    }

    const c = customers.find((x) => x.id === id);
    if (!c) return;

    setCustomerName(c.name || "");
    setCustomerPhone(c.phone || c.mobile || c.contact || "");
    setAddress1(c.address1 || c.address || "");
    setAddress2(c.address2 || "");
    setAddress3(c.address3 || "");
  }

  /**
   * =========================
   * Cart logic
   * =========================
   */
  function makeLineId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function addLine({
    item,
    qtyVal,
    sellingPriceValue,
    desc,
    taxPct: taxPctVal,
    unitLabel = "",
  }) {
    const q = num(qtyVal);
    const price = num(sellingPriceValue);

    const baseTotal = round(calcBaseTotal(q, price));
    const taxAmount = round(calcTaxAmount(q, price, taxPctVal));
    const total = round(baseTotal + taxAmount);
    const itemCode = getItemBaseCode(item).trim();

    const row = {
      lineId: makeLineId(),
      itemId: item.id,
      itemName: item.itemName || "",
      itemCode,
      qty: q,
      cost: num(item.cost),
      sellingPrice: price,
      taxPct: num(taxPctVal),
      baseTotal,
      taxAmount,
      total,
      description: desc || "",
      unitLabel: unitLabel || "",
    };

    setCart((prev) => [...prev, row]);
  }

  function addItemToCart() {
    setErr("");
    setMsg("");

    if (!selectedItem) return setErr("Please select an item.");
    const q = num(qty);
    if (!q || q <= 0) return setErr("Qty must be > 0.");

    const price =
      lineSellingPrice === ""
        ? num(selectedItem.sellingPrice)
        : num(lineSellingPrice);
    if (price < 0) return setErr("Selling Price must be zero or greater.");

    addLine({
      item: selectedItem,
      qtyVal: q,
      sellingPriceValue: price,
      desc: itemDesc || "",
      taxPct: taxPct,
    });

    setSearch("");
    setSelectedItemId("");
    setQty("1");
    setLineSellingPrice("");
    setItemDesc("");
    setTimeout(() => searchRef.current?.focus?.(), 0);
  }

  /** Retail barcode / exact-code Enter → add qty 1, or bump an undescribed line. */
  function onBarcodeMatch(item) {
    setErr("");
    const price = num(item?.sellingPrice);
    if (!item?.id) return;
    if (price < 0) return setErr("Selling Price must be zero or greater.");

    // Only merge into a line with no description. Described lines stay separate
    // so the same product can be sold with different notes / prices / qtys.
    const existing = cart.find(
      (row) =>
        row.itemId === item.id && !String(row.description || "").trim()
    );
    if (existing) {
      updateLine(existing.lineId, { qty: num(existing.qty) + 1 });
    } else {
      addLine({
        item,
        qtyVal: 1,
        sellingPriceValue: price,
        desc: "",
        taxPct,
      });
    }

    setSearch("");
    setSelectedItemId("");
    setQty("1");
    setLineSellingPrice("");
    setItemDesc("");
    setTimeout(() => searchRef.current?.focus?.(), 0);
  }

  function resetCustomerFields() {
    setCustomerId("");
    setCustomerName("");
    setCustomerPhone("");
    setAddress1("");
    setAddress2("");
    setAddress3("");
  }

  function resetPaymentFields() {
    setSettlementMode("full");
    setPaymentMode("CASH");
    setPayCash("");
    setPayBank("");
    setPayCredit("");
  }

  function onClearCart() {
    if (cart.length === 0) return;
    const ok = window.confirm("Clear all items from this order?");
    if (!ok) return;
    setCart([]);
    setMsg("");
    setErr("");
    if (!editingInvoice) clearDraft();
    setTimeout(() => searchRef.current?.focus?.(), 0);
  }

  function onNewOrder() {
    setEditingInvoice(null);
    setCart([]);
    clearDraft();
    setInvoiceNo(makeInvoiceNo());
    setSaleDate(
      activeShift?.businessDate
        ? String(activeShift.businessDate).slice(0, 10)
        : todayYYYYMMDD()
    );
    resetPaymentFields();
    setOrderType("COUNTER");
    resetCustomerFields();
    setSearch("");
    setSelectedItemId("");
    setQty("1");
    setLineSellingPrice("");
    setItemDesc("");
    setTaxPct("0");
    setErr("");
    setMsg("");
    setTab("new");
    setTimeout(() => searchRef.current?.focus?.(), 0);
  }

  function onCloseModule() {
    navigate("/dashboard");
  }

  /** Café menu tap → add qty 1. */
  function onQuickAddItem(item) {
    setErr("");
    const price = num(item?.sellingPrice);
    if (!item?.id) return;
    if (price < 0) return setErr("Selling Price must be zero or greater.");
    addLine({
      item,
      qtyVal: 1,
      sellingPriceValue: price,
      desc: "",
      taxPct,
    });
  }

  /**
   * Wholesale add — inventory always in pieces; unit/tier noted on the line.
   */
  function onWholesaleAdd({
    item,
    qtyEntered,
    unit,
    priceTier,
    pieceQty,
    taxPct: lineTax,
    desc,
    packSize,
  }) {
    setErr("");
    if (!item?.id) return setErr("Please select an item.");
    const pieces = num(pieceQty);
    if (!pieces || pieces <= 0) return setErr("Qty must be > 0.");

    const wholesale = num(item.wholesalePrice ?? item.wholesale_price);
    const retail = num(item.sellingPrice);
    const piecePrice =
      priceTier === "WHOLESALE"
        ? wholesale > 0
          ? wholesale
          : retail
        : retail;
    if (piecePrice < 0) return setErr("Selling Price must be zero or greater.");

    const unitLabel =
      unit === "CARTON"
        ? `${num(qtyEntered)} carton × ${packSize} pcs · ${String(priceTier).toLowerCase()}`
        : `piece · ${String(priceTier).toLowerCase()}`;

    addLine({
      item,
      qtyVal: pieces,
      sellingPriceValue: piecePrice,
      desc: [desc, unitLabel].filter(Boolean).join(" · "),
      taxPct: lineTax,
      unitLabel,
    });

    setSearch("");
    setSelectedItemId("");
    setQty("1");
    setLineSellingPrice("");
    setItemDesc("");
    setTimeout(() => searchRef.current?.focus?.(), 0);
  }

  async function onPrintModeChange(e) {
    const v = e.target.value;
    setPrintMode(v);
    try {
      if (!activeClientId) return;
      await setDoc(
        doc(db, "client_settings", activeClientId),
        {
          clientId: activeClientId,
          defaultPrinterMode: v,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    } catch (err) {
      console.error("Failed to save printer default:", err);
    }
  }

  function removeLine(lineId) {
    setCart((prev) => prev.filter((x) => x.lineId !== lineId));
  }

  function updateLine(lineId, patch) {
    setCart((prev) =>
      prev.map((x) => {
        if (x.lineId !== lineId) return x;
        const next = { ...x, ...patch };
        next.qty = num(next.qty);
        next.sellingPrice = num(next.sellingPrice);
        next.taxPct = num(next.taxPct);
        next.baseTotal = round(calcBaseTotal(next.qty, next.sellingPrice));
        next.taxAmount = round(
          calcTaxAmount(next.qty, next.sellingPrice, next.taxPct)
        );
        next.total = round(next.baseTotal + next.taxAmount);
        return next;
      })
    );
  }

  /**
   * =========================
   * Save + Print
   * =========================
   */
  async function findOrUpsertCustomerParty({ chosenMs }) {
    const name = customerName.trim();
    const phone = normPhone(customerPhone);
    const a1 = (address1 || "").trim();
    const a2 = (address2 || "").trim();
    const a3 = (address3 || "").trim();

    if (!customerId && !name && !phone) return null;

    // If selected from dropdown → update (backfill simple ID if missing)
    if (customerId) {
      const selected = customers.find((c) => c.id === customerId);
      const patch = {
        name: name || "",
        phone: phone || "",
        address1: a1 || "",
        address2: a2 || "",
        address3: a3 || "",
        updatedAt: serverTimestamp(),
        lastSaleAtMs: chosenMs,
      };
      if (!getPartyCode(selected)) {
        patch.partyCode = nextPartyCode(customers, "C");
      }
      await updateDoc(doc(db, "parties", customerId), patch);
      return customerId;
    }

    // Try match by phone
    if (phone) {
      const qy = query(
        collection(db, "parties"),
        where("clientId", "==", activeClientId),
        where("phone", "==", phone),
        limit(1)
      );

      const snap = await getDocs(qy);
      if (!snap.empty) {
        const d = snap.docs[0];
        const existing = d.data() || {};
        const patch = {
          name: name || existing.name || phone,
          phone,
          address1: a1 || existing.address1 || "",
          address2: a2 || existing.address2 || "",
          address3: a3 || existing.address3 || "",
          updatedAt: serverTimestamp(),
          lastSaleAtMs: chosenMs,
        };
        if (!getPartyCode(existing)) {
          patch.partyCode = nextPartyCode(customers, "C");
        }
        await updateDoc(doc(db, "parties", d.id), patch);
        return d.id;
      }
    }

    // Create new with simple auto ID (C001, C002, …)
    const ref = await addDoc(collection(db, "parties"), {
      clientId: activeClientId,
      type: "Customer",
      partyCode: nextPartyCode(customers, "C"),
      name: name || phone || "Customer",
      phone,
      address1: a1 || "",
      address2: a2 || "",
      address3: a3 || "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      lastSaleAtMs: chosenMs,
    });

    return ref.id;
  }

  async function findSaleTransactionDocs(invoiceId) {
    if (!invoiceId) return [];
    const snap = await getDocs(
      query(
        collection(db, "transactions"),
        where("refId", "==", invoiceId),
        limit(20)
      )
    );
    return snap.docs
      .filter((d) => {
        const data = d.data();
        return (
          data?.clientId === activeClientId &&
          data?.refType === "sales_invoice"
        );
      })
      .map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
  }

  async function finishAndBilling({ doPrint }) {
    if (billingLock.current || saving) return;

    setErr("");
    setMsg("");

    if (!activeClientId) return;
    if (loadingShift) return setErr("Active shift is still loading.");
    if (!activeShift?.id || activeShift.status !== "OPEN") {
      return setErr("Open a shift before recording a POS sale.");
    }
    if (!invoiceNo.trim()) return setErr("Invoice No required.");
    if (cart.length === 0) return setErr("Add at least one item.");
    if (cart.some((item) => num(item.qty) <= 0)) {
      return setErr("Every item quantity must be greater than zero.");
    }
    if (cart.some((item) => num(item.sellingPrice) < 0)) {
      return setErr("Every item Selling Price must be zero or greater.");
    }
    const focWithoutDesc = cart.find(
      (item) =>
        num(item.sellingPrice) === 0 &&
        !String(item.description || "").trim()
    );
    if (focWithoutDesc) {
      return setErr(
        `Description is required for FOC / zero-price items (${
          focWithoutDesc.itemName || "item"
        }).`
      );
    }

    const saleTenders = resolveSaleTenders({
      settlement: settlementMode,
      paymentMode: resolvedPayment.paymentMode,
      bankAccountId: resolvedPayment.bankAccountId,
      bankAccountName: findBankAccountName(
        bankAccounts,
        resolvedPayment.bankAccountId
      ),
      cashAmount: payCash,
      bankAmount: payBank,
      creditAmount: payCredit,
      grandTotal: totals.grandTotal,
      decimals,
    });
    const tenderSummary = tenderTotals(saleTenders, decimals);
    const grandRounded = round(totals.grandTotal);

    // FOC / zero-total bills have no tender lines — that is OK.
    if (grandRounded > 0 && saleTenders.length === 0) {
      return setErr("Enter at least one payment amount.");
    }
    if (toMinor(tenderSummary.allocated) !== toMinor(grandRounded)) {
      return setErr(
        `Payment amounts must equal total (${money(grandRounded)}). Allocated ${money(
          tenderSummary.allocated
        )}.`
      );
    }
    if (tenderSummary.bank > 0 && !resolvedPayment.bankAccountId) {
      return setErr("Select a bank account for bank payments.");
    }
    if (tenderSummary.bank > 0 && resolvedPayment.bankAccountId) {
      const bankCheck = assertOperationalBankAccount(
        bankAccounts,
        resolvedPayment.bankAccountId
      );
      if (!bankCheck.ok) return setErr(bankCheck.message);
    }
    if (tenderSummary.credit > 0 && !customerId && !customerName.trim()) {
      return setErr("Credit sale requires a customer. Select or enter a customer.");
    }

    // ✅ Delivery validation: name + mobile + address1 required
    if (orderType === "DELIVERY") {
      if (!customerName.trim()) return setErr("Delivery: Customer Name is required.");
      if (!customerPhone.trim()) return setErr("Delivery: Mobile Number is required.");
      if (!address1.trim()) return setErr("Delivery: Address 1 is required.");
    }

    billingLock.current = true;
    setSaving(true);

    try {
    const lockedSaleDate =
      !editingInvoice && activeShift?.businessDate
        ? activeShift.businessDate
        : saleDate;
    const chosenMs = dateStrToMsMidday(lockedSaleDate);

    // ✅ ensure customer party exists/updated (selected or typed)
    let linkedCustomerId = null;
    try {
      linkedCustomerId = await findOrUpsertCustomerParty({ chosenMs });
    } catch (e) {
      console.error("Customer upsert failed:", e);
      // we continue saving invoice even if customer update fails (optional behavior)
    }

    if (tenderSummary.credit > 0 && !linkedCustomerId) {
      billingLock.current = false;
      setSaving(false);
      return setErr(
        "Credit sale requires a saved customer. Select a customer from the list or enter a name."
      );
    }

    const isEditing = Boolean(editingInvoice?.id);
    const invoiceRef = isEditing
      ? doc(db, "sales_invoices", editingInvoice.id)
      : doc(collection(db, "sales_invoices"));
    const shiftRef = doc(db, "shifts", activeShift.id);

    const existingItemsSnap = isEditing
      ? await getDocs(
          query(
            collection(db, "sales_invoices", invoiceRef.id, "items"),
            limit(500)
          )
        )
      : null;
    const existingItems = existingItemsSnap
      ? existingItemsSnap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }))
      : [];
    const existingAccountingDocs = isEditing
      ? await findSaleTransactionDocs(invoiceRef.id)
      : [];

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
          clientId: activeClientId,
          date: lockedSaleDate,
          type: "sales",
          category: "Sales",
          mode: line.mode,
          bankAccountId: line.bankAccountId || "",
          bankAccountName: line.bankAccountName || "",
          partyType: "Customer",
          partyId: linkedCustomerId,
          partyName: customerName.trim() || "Walk-in",
          description: `Sales invoice ${invoiceNo.trim()}`,
          amountBeforeTax: line.amount,
          taxAmount: 0,
          totalAmount: line.amount,
          source: "pos",
          refType: "sales_invoice",
          refId: invoiceRef.id,
          shiftId: activeShift.id,
          invoiceNo: invoiceNo.trim(),
          orderType,
          status: "POSTED",
        }),
      };
    });

    const invoicePayload = {
      clientId: activeClientId,
      clientName: activeClientData?.name || "",

      invoiceNo: invoiceNo.trim(),
      saleAtMs: chosenMs,
      saleAt: tenderPayloads[0].payload.date,

      // Customer
      customerId: linkedCustomerId || null,
      customerName: customerName.trim() || "",
      customerPhone: customerPhone.trim() || "",
      address1: address1 || "",
      address2: address2 || "",
      address3: address3 || "",

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
      printerMode: printMode,

      // Totals
      subTotal: totals.subTotal,
      discountTotal: totals.discountTotal,

      // Tax
      taxType: "ITEM_WISE",
      taxAmount: totals.taxAmount,
      grandTotalBeforeTax: totals.grandTotalBeforeTax,
      grandTotal: totals.grandTotal,

      itemCount: cart.length,
      status: "ACTIVE",
      stockPosted: true,
      shiftId: activeShift.id,
      accountingTransactionId: primaryAccountingRef.id,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
      updatedBy: user?.uid || null,
    };

      const itemsCol = collection(db, "sales_invoices", invoiceRef.id, "items");
      const newLineRefs = cart.map(() => doc(itemsCol));
      const oldQty = quantitiesByItem(existingItems);
      const newQty = quantitiesByItem(cart);
      const itemIds = [...new Set([...oldQty.keys(), ...newQty.keys()])];
      const itemRefs = itemIds.map((id) => doc(db, "inventory", id));
      const movementRefs = itemIds.map(() =>
        doc(collection(db, "inventory_movements"))
      );

      await runTransaction(db, async (tx) => {
        const shiftSnap = await tx.get(shiftRef);
        const currentInvoiceSnap = isEditing ? await tx.get(invoiceRef) : null;
        const inventorySnaps = [];
        for (const itemRef of itemRefs) {
          inventorySnaps.push(await tx.get(itemRef));
        }

        // Firestore requires every doc read before any write.
        const existingTxnSnaps = [];
        for (const existingDoc of existingAccountingDocs) {
          existingTxnSnaps.push(await tx.get(existingDoc.ref));
        }
        const tenderSnaps = [];
        for (const entry of tenderPayloads) {
          // Skip duplicate get if already in existingAccountingDocs
          const already = existingAccountingDocs.find((d) => d.id === entry.ref.id);
          if (already) {
            tenderSnaps.push(
              existingTxnSnaps[
                existingAccountingDocs.findIndex((d) => d.id === entry.ref.id)
              ]
            );
          } else {
            tenderSnaps.push(await tx.get(entry.ref));
          }
        }
        const legacyAccountingRef = doc(
          db,
          "transactions",
          `sales_invoice_${invoiceRef.id}`
        );
        const legacyInExisting = existingAccountingDocs.some(
          (d) => d.id === legacyAccountingRef.id
        );
        const legacySnap = legacyInExisting
          ? null
          : await tx.get(legacyAccountingRef);

        if (
          !shiftSnap.exists() ||
          shiftSnap.data()?.status !== "OPEN" ||
          shiftSnap.data()?.clientId !== activeClientId
        ) {
          throw new Error("The active shift is no longer open.");
        }
        if (isEditing && !currentInvoiceSnap?.exists()) {
          throw new Error("Invoice no longer exists.");
        }
        if (currentInvoiceSnap?.data()?.status === "CANCELLED") {
          throw new Error("Cancelled invoices cannot be edited.");
        }

        const oldStockWasPosted =
          isEditing && currentInvoiceSnap?.data()?.stockPosted === true;

        inventorySnaps.forEach((snap, index) => {
          if (!snap.exists()) {
            throw new Error(`Inventory item not found: ${itemIds[index]}`);
          }
          if (snap.data()?.clientId !== activeClientId) {
            throw new Error("Inventory item belongs to another client.");
          }

          const itemId = itemIds[index];
          const restoredQty = oldStockWasPosted ? num(oldQty.get(itemId)) : 0;
          const deductedQty = num(newQty.get(itemId));
          const nextStock =
            num(snap.data()?.currentStock) + restoredQty - deductedQty;

          if (nextStock < 0) {
            throw new Error(
              `Insufficient stock for ${snap.data()?.itemName || itemId}.`
            );
          }
        });

        tx.set(
          invoiceRef,
          {
            ...invoicePayload,
            ...(isEditing
              ? {}
              : {
                  createdAt: serverTimestamp(),
                  createdAtMs: Date.now(),
                  createdBy: user?.uid || null,
                }),
          },
          { merge: isEditing }
        );

        existingItems.forEach((item) => tx.delete(item.ref));
        cart.forEach((row, idx) => {
          tx.set(newLineRefs[idx], {
            clientId: activeClientId,
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
          const restoredQty = oldStockWasPosted ? num(oldQty.get(itemId)) : 0;
          const deductedQty = num(newQty.get(itemId));
          const delta = deductedQty - restoredQty;
          const nextStock =
            num(snap.data()?.currentStock) + restoredQty - deductedQty;

          tx.update(itemRefs[index], {
            currentStock: nextStock,
            updatedAt: serverTimestamp(),
          });

          if (delta !== 0) {
            const representative =
              cart.find((row) => row.itemId === itemId) ||
              existingItems.find((row) => row.itemId === itemId) ||
              {};
            tx.set(movementRefs[index], {
              clientId: activeClientId,
              itemId,
              itemName: representative.itemName || snap.data()?.itemName || "",
              itemCode: representative.itemCode || "",
              type: delta > 0 ? "OUT" : "IN",
              qty: Math.abs(delta),
              rate: num(representative.sellingPrice),
              amount: Math.abs(delta) * num(representative.sellingPrice),
              reason: isEditing ? "SALE_EDIT" : "SALE",
              refType: "sales_invoice",
              refId: invoiceRef.id,
              shiftId: activeShift.id,
              invoiceNo: invoicePayload.invoiceNo,
              date: tenderPayloads[0].payload.date,
              dateMs: chosenMs,
              createdAt: serverTimestamp(),
              createdBy: user?.uid || null,
            });
          }
        });

        const keepTxnIds = new Set(
          tenderPayloads.map((entry) => entry.ref.id)
        );

        existingAccountingDocs.forEach((existingDoc, index) => {
          if (!keepTxnIds.has(existingDoc.id) && existingTxnSnaps[index]?.exists()) {
            tx.delete(existingDoc.ref);
          }
        });
        if (
          !keepTxnIds.has(legacyAccountingRef.id) &&
          legacySnap?.exists()
        ) {
          tx.delete(legacyAccountingRef);
        }

        tenderPayloads.forEach((entry, index) => {
          const snap = tenderSnaps[index];
          tx.set(
            entry.ref,
            {
              ...entry.payload,
              createdAt: snap?.exists()
                ? snap.data()?.createdAt || serverTimestamp()
                : serverTimestamp(),
              createdBy: snap?.exists()
                ? snap.data()?.createdBy || user?.uid || null
                : user?.uid || null,
              createdAtMs: snap?.exists()
                ? snap.data()?.createdAtMs || Date.now()
                : Date.now(),
              updatedAt: serverTimestamp(),
              updatedBy: user?.uid || null,
            },
            { merge: Boolean(snap?.exists()) }
          );
        });
      });

      setMsg(isEditing ? "Invoice updated successfully." : "Order saved successfully.");

      if (doPrint) {
        printInvoice({
          shopName: activeClientData?.name || activeClientId,
          invoice: { ...invoicePayload, customerId: linkedCustomerId },
          items: cart.map((x) => ({
            itemCode: x.itemCode,
            itemName: x.itemName,
            qty: x.qty,
            sellingPrice: x.sellingPrice,
            taxPct: x.taxPct,
            taxAmount: x.taxAmount,
            baseTotal: x.baseTotal,
            total: x.total,
            description: x.description,
          })),
          mode: printMode,
          decimals,
        });
      }

      // Reset for next order
      setInvoiceNo(makeInvoiceNo());
      setEditingInvoice(null);
      setSaleDate(todayYYYYMMDD());
      resetPaymentFields();
      setOrderType("COUNTER");
      setCustomerId("");
      setCustomerName("");
      setCustomerPhone("");
      setAddress1("");
      setAddress2("");
      setAddress3("");
      setSearch("");
      setSelectedItemId("");
      setQty("1");
      setLineSellingPrice("");
      setItemDesc("");
      setCart([]);
      clearDraft();
      setTimeout(() => searchRef.current?.focus?.(), 0);
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to save order.");
    } finally {
      billingLock.current = false;
      setSaving(false);
    }
  }

  /**
   * =========================
   * History actions
   * =========================
   */
  async function viewInvoice(inv) {
    try {
      const snap = await getDocs(
        query(collection(db, "sales_invoices", inv.id, "items"), limit(300))
      );
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const lines = list
        .sort((a, b) => num(a.sn) - num(b.sn))
        .map(
          (x) =>
            `${x.sn}. ${x.itemCode || ""} | ${x.itemName} | QTY ${money(
              x.qty
            )} | Price ${money(x.sellingPrice)} | Total ${money(
              x.total
            )}${x.description ? `\n   ↳ ${x.description}` : ""}`
        )
        .join("\n");

      alert(
        `Invoice: ${inv.invoiceNo}\nDate: ${
          formatDateValue(inv.saleAtMs, "-")
        }\nCustomer: ${inv.customerName || "-"}\nPhone: ${inv.customerPhone || "-"}\nPayment: ${
          formatPaymentLabel(inv, decimals)
        }\nOrderType: ${inv.orderType || "-"}\nStatus: ${inv.status || "ACTIVE"}\nTax: ${money(
          inv.taxAmount || 0
        )}\n\nItems:\n${lines}\n\nGrand Total: ${money(inv.grandTotal)}`
      );
    } catch (e) {
      console.error(e);
      alert(e?.message || "Failed to load invoice items.");
    }
  }

  async function printInvoiceWithItems(inv) {
    try {
      const snap = await getDocs(
        query(collection(db, "sales_invoices", inv.id, "items"), limit(500))
      );
      const list = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => num(a.sn) - num(b.sn));

      printInvoice({
        shopName: activeClientData?.name || activeClientId,
        invoice: inv,
        items: list.map((x) => ({
          itemCode: x.itemCode,
          itemName: x.itemName,
          qty: x.qty,
          sellingPrice: x.sellingPrice,
          total: x.total,
          description: x.description,
        })),
        mode: inv.printerMode || "A4",
        decimals,
      });
    } catch (e) {
      console.error(e);
      alert(e?.message || "Failed to fetch items for printing.");
    }
  }

  // Load the existing invoice into the form. The next save updates this ID.
  async function editInvoice(inv) {
    try {
      if (inv.status === "CANCELLED") {
        alert("This invoice is cancelled. You cannot edit it.");
        return;
      }

      const snap = await getDocs(
        query(collection(db, "sales_invoices", inv.id, "items"), limit(500))
      );
      const list = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => num(a.sn) - num(b.sn));

      // Fill invoice meta + customer
      setSaleDate(inv.saleAtMs ? msToYYYYMMDD(inv.saleAtMs) : todayYYYYMMDD());
      setInvoiceNo(inv.invoiceNo || makeInvoiceNo());

      const savedTenders = Array.isArray(inv.paymentTenders)
        ? inv.paymentTenders
        : null;
      if (savedTenders && savedTenders.length > 1) {
        setSettlementMode("split");
        const cashLine = savedTenders.find(
          (line) => String(line.mode || "").toUpperCase() === "CASH"
        );
        const bankLine = savedTenders.find((line) => {
          const mode = String(line.mode || "").toUpperCase();
          return (
            mode === "BANK" ||
            mode === "BANK_TRANSFER" ||
            mode.startsWith("BANK:")
          );
        });
        const creditLine = savedTenders.find(
          (line) => String(line.mode || "").toUpperCase() === "CREDIT"
        );
        setPayCash(cashLine ? String(cashLine.amount ?? "") : "");
        setPayBank(bankLine ? String(bankLine.amount ?? "") : "");
        setPayCredit(creditLine ? String(creditLine.amount ?? "") : "");
        setPaymentMode(
          tenderFormValue(
            bankLine?.mode || inv.paymentMode || "CASH",
            bankLine?.bankAccountId || inv.bankAccountId
          )
        );
      } else {
        setSettlementMode(
          String(inv.settlementMode || "").toLowerCase() === "split"
            ? "split"
            : "full"
        );
        setPayCash("");
        setPayBank("");
        setPayCredit("");
        setPaymentMode(
          tenderFormValue(inv.paymentMode || "CASH", inv.bankAccountId)
        );
      }

      setOrderType(inv.orderType || "COUNTER");
      setPrintMode(inv.printerMode || printMode);

      setCustomerId(inv.customerId || "");
      setCustomerName(inv.customerName || "");
      setCustomerPhone(inv.customerPhone || "");
      setAddress1(inv.address1 || "");
      setAddress2(inv.address2 || "");
      setAddress3(inv.address3 || "");

      // Convert items to cart rows
      const cartRows = list.map((it) => {
        const baseTotal = round(calcBaseTotal(it.qty, it.sellingPrice));
        const taxAmount = round(
          calcTaxAmount(it.qty, it.sellingPrice, it.taxPct || 0)
        );
        return {
          lineId: makeLineId(),
          itemId: it.itemId,
          itemName: it.itemName || "",
          itemCode: it.itemCode || "",
          qty: num(it.qty),
          cost: num(it.cost),
          sellingPrice: num(it.sellingPrice),
          taxPct: num(it.taxPct || 0),
          baseTotal,
          taxAmount,
          total: round(baseTotal + taxAmount),
          description: it.description || "",
        };
      });

      setCart(cartRows);
      setEditingInvoice(inv);
      setTab("new");
      setMsg(`Editing invoice ${inv.invoiceNo}. Saving will update this invoice.`);
      setErr("");
      setTimeout(() => searchRef.current?.focus?.(), 0);
    } catch (e) {
      console.error(e);
      alert(e?.message || "Failed to load invoice for editing.");
    }
  }

  async function cancelInvoice(inv) {
    try {
      if (inv.status === "CANCELLED") {
        alert("Already cancelled.");
        return;
      }
      if (!window.confirm(`Cancel invoice ${inv.invoiceNo}? This will reverse stock + create reversal transaction.`)) {
        return;
      }
      const reason = String(
        window.prompt("Cancellation/refund reason (required):", "") || ""
      ).trim();
      if (!reason) {
        alert("Cancellation reason is required.");
        return;
      }

      const snap = await getDocs(
        query(collection(db, "sales_invoices", inv.id, "items"), limit(500))
      );
      const itemsList = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const existingAccountingDocs = await findSaleTransactionDocs(inv.id);
      const saleTxnDocs =
        existingAccountingDocs.length > 0
          ? existingAccountingDocs
          : [
              {
                id: `sales_invoice_${inv.id}`,
                ref: doc(db, "transactions", `sales_invoice_${inv.id}`),
                mode: inv.paymentMode || "cash",
                bankAccountId: inv.bankAccountId || "",
                bankAccountName: inv.bankAccountName || "",
                totalAmount: num(inv.grandTotal),
                amountIn: num(inv.grandTotal),
                amountBeforeTax: num(inv.grandTotalBeforeTax),
                taxAmount: num(inv.taxAmount),
              },
            ];
      const invoiceRef = doc(db, "sales_invoices", inv.id);
      const qtyByItem = quantitiesByItem(itemsList);
      const itemIds = [...qtyByItem.keys()];
      const itemRefs = itemIds.map((id) => doc(db, "inventory", id));
      const movementRefs = itemIds.map(() =>
        doc(collection(db, "inventory_movements"))
      );
      const businessDate = inv.saleAtMs
        ? msToYYYYMMDD(inv.saleAtMs)
        : todayYYYYMMDD();

      const reversalPlans = saleTxnDocs.map((saleDoc) => {
        const amount = num(saleDoc.amountIn || saleDoc.totalAmount || 0);
        const originalSale = buildTransactionPayload({
          clientId: activeClientId,
          date: businessDate,
          type: "sales",
          category: "Sales",
          mode: saleDoc.mode || inv.paymentMode || "cash",
          bankAccountId: saleDoc.bankAccountId || inv.bankAccountId || "",
          bankAccountName: saleDoc.bankAccountName || inv.bankAccountName || "",
          partyType: "Customer",
          partyId: inv.customerId || null,
          partyName: inv.customerName || "Walk-in",
          description: `Sales invoice ${inv.invoiceNo || ""}`,
          amountBeforeTax: num(saleDoc.amountBeforeTax || amount),
          taxAmount: num(saleDoc.taxAmount || 0),
          totalAmount: amount,
          source: "pos",
          refType: "sales_invoice",
          refId: inv.id,
          shiftId: inv.shiftId || "",
          invoiceNo: inv.invoiceNo,
          orderType: inv.orderType,
          status: "REVERSED",
        });
        const reversal = buildTransactionPayload({
          ...originalSale,
          date: businessDate,
          type: "sales",
          category: "Sales Reversal",
          amountBeforeTax: -num(originalSale.amountBeforeTax),
          taxAmount: -num(originalSale.taxAmount),
          totalAmount: -amount,
          amountIn: -amount,
          amountOut: 0,
          source: "pos_cancel",
          refType: "sales_invoice_cancel",
          refId: inv.id,
          reversalOf: saleDoc.id,
          status: "POSTED",
        });
        return {
          saleDoc,
          originalSale,
          reversal,
          reversalRef: doc(
            db,
            "transactions",
            `sales_invoice_cancel_${saleDoc.id}`
          ),
        };
      });

      await runTransaction(db, async (tx) => {
        const invoiceSnap = await tx.get(invoiceRef);
        const inventorySnaps = [];
        for (const itemRef of itemRefs) {
          inventorySnaps.push(await tx.get(itemRef));
        }
        const saleTxnSnaps = [];
        const reversalSnaps = [];
        for (const plan of reversalPlans) {
          saleTxnSnaps.push(await tx.get(plan.saleDoc.ref));
          reversalSnaps.push(await tx.get(plan.reversalRef));
        }

        if (!invoiceSnap.exists()) throw new Error("Invoice no longer exists.");
        if (
          invoiceSnap.data()?.status === "CANCELLED" ||
          reversalSnaps.some((snap) => snap.exists())
        ) {
          throw new Error("Invoice has already been cancelled.");
        }

        const shouldRestoreStock = invoiceSnap.data()?.stockPosted === true;
        inventorySnaps.forEach((itemSnap, index) => {
          if (!itemSnap.exists()) {
            throw new Error(`Inventory item not found: ${itemIds[index]}`);
          }
        });

        tx.update(invoiceRef, {
          status: "CANCELLED",
          cancelReason: reason,
          cancelledAt: serverTimestamp(),
          cancelledAtMs: Date.now(),
          cancelledBy: user?.uid || null,
          updatedAt: serverTimestamp(),
          updatedAtMs: Date.now(),
          updatedBy: user?.uid || null,
        });

        if (shouldRestoreStock) {
          inventorySnaps.forEach((itemSnap, index) => {
            const qty = num(qtyByItem.get(itemIds[index]));
            tx.update(itemRefs[index], {
              currentStock: num(itemSnap.data()?.currentStock) + qty,
              updatedAt: serverTimestamp(),
            });
            tx.set(movementRefs[index], {
              clientId: activeClientId,
              itemId: itemIds[index],
              itemName: itemSnap.data()?.itemName || "",
              type: "IN",
              qty,
              rate: 0,
              amount: 0,
              reason: "SALE_CANCEL",
              refType: "sales_invoice",
              refId: inv.id,
              shiftId: inv.shiftId || "",
              invoiceNo: inv.invoiceNo || "",
              date: reversalPlans[0].originalSale.date,
              dateMs: reversalPlans[0].originalSale.dateMs,
              createdAt: serverTimestamp(),
              createdBy: user?.uid || null,
            });
          });
        }

        reversalPlans.forEach((plan, index) => {
          const saleTxnSnap = saleTxnSnaps[index];
          tx.set(
            plan.saleDoc.ref,
            {
              ...plan.originalSale,
              cancelReason: reason,
              reversedAt: serverTimestamp(),
              reversedBy: user?.uid || null,
              createdAt: saleTxnSnap.exists()
                ? saleTxnSnap.data()?.createdAt || serverTimestamp()
                : serverTimestamp(),
              createdBy: saleTxnSnap.exists()
                ? saleTxnSnap.data()?.createdBy || user?.uid || null
                : user?.uid || null,
              updatedAt: serverTimestamp(),
              updatedBy: user?.uid || null,
            },
            { merge: saleTxnSnap.exists() }
          );
          tx.set(plan.reversalRef, {
            ...plan.reversal,
            cancelReason: reason,
            createdAt: serverTimestamp(),
            createdBy: user?.uid || null,
            updatedAt: serverTimestamp(),
            updatedBy: user?.uid || null,
          });
        });
      });

      if (editingInvoice?.id === inv.id) {
        setEditingInvoice(null);
        setCart([]);
      }
      alert("Invoice cancelled and reversed successfully.");
    } catch (e) {
      console.error(e);
      alert(e?.message || "Failed to cancel invoice.");
    }
  }

  /**
   * =========================
   * Guards
   * =========================
   */
  if (!activeClientId) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-slate-100">Sales</h1>
        <p className="text-slate-400 mt-2">Please select a client/shop first.</p>
      </div>
    );
  }

  const shopType = normalizeShopType(activeClientData?.shop_type);
  const SalesLayout = getSalesLayout(shopType);
  const isRetailPos = shopType === "retail";
  const retailOwnsChrome = isRetailPos && tab === "new";

  const salesLayoutProps = {
    saleDate,
    setSaleDate,
    editingInvoice,
    invoiceNo,
    setInvoiceNo,
    orderType,
    setOrderType,
    paymentMode,
    setPaymentMode,
    paymentModeOptions,
    settlementMode,
    setSettlementMode,
    payCash,
    setPayCash,
    payBank,
    setPayBank,
    payCredit,
    setPayCredit,
    printMode,
    onPrintModeChange,
    customerId,
    onSelectCustomer,
    loadingCustomers,
    customers,
    customerName,
    setCustomerName,
    setCustomerId,
    customerPhone,
    setCustomerPhone,
    address1,
    setAddress1,
    address2,
    setAddress2,
    address3,
    setAddress3,
    search,
    setSearch,
    setSelectedItemId,
    searchRef,
    filteredItems,
    items,
    selectedItem,
    selectedItemId,
    qty,
    setQty,
    lineSellingPrice,
    setLineSellingPrice,
    taxPct,
    setTaxPct,
    itemDesc,
    setItemDesc,
    qtyRef,
    taxPctRef,
    sellingPriceRef,
    addBtnRef,
    addItemToCart,
    loadingItems,
    onBarcodeMatch,
    onQuickAddItem,
    onWholesaleAdd,
    cart,
    totals,
    grandTotal: totals.grandTotal,
    updateLine,
    removeLine,
    saving,
    finishAndBilling,
    setTab,
    onNewOrder,
    onClearCart,
    onCloseModule,
  };

  /**
   * =========================
   * UI
   * =========================
   */
  return (
    <div className={retailOwnsChrome ? "p-2.5 sm:p-4 md:p-5" : "p-3 sm:p-6"}>
      {/* Header — retail new-order chrome lives inside RetailSales */}
      {!retailOwnsChrome ? (
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">Sales / Billing</h1>
            <p className="text-slate-400 mt-1">{shopTypeLabel(shopType)} layout</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <ModuleHelpButton moduleId="sales" />
            <button
              onClick={() => setTab("new")}
              className={`px-4 py-2 rounded-lg text-sm border ${
                tab === "new"
                  ? "bg-slate-100 text-slate-900 border-slate-200"
                  : "bg-slate-950/40 text-slate-200 border-slate-800"
              }`}
            >
              New Order
            </button>
            <button
              onClick={() => setTab("history")}
              className={`px-4 py-2 rounded-lg text-sm border ${
                tab === "history"
                  ? "bg-slate-100 text-slate-900 border-slate-200"
                  : "bg-slate-950/40 text-slate-200 border-slate-800"
              }`}
            >
              History
            </button>
            <ModuleExitButton ariaLabel="Close sales module" />
          </div>
        </div>
      ) : null}

      {err ? (
        <div
          className={`${retailOwnsChrome ? "mb-3" : "mt-4"} rounded-lg border border-red-800 bg-red-950/40 text-red-200 px-3 py-2 text-sm`}
        >
          {err}
        </div>
      ) : null}

      {msg ? (
        <div
          className={`${retailOwnsChrome ? "mb-3" : "mt-4"} rounded-lg border border-green-800 bg-green-950/30 text-green-200 px-3 py-2 text-sm`}
        >
          {msg}
        </div>
      ) : null}

      {/* ================= HISTORY ================= */}
      {tab === "history" ? (
        <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-slate-100 font-semibold">Sales History</h2>
              <p className="text-slate-400 text-sm">
                Search by invoice / customer / phone / payment / order / status
              </p>
            </div>

            <input
              value={invSearch}
              onChange={(e) => setInvSearch(e.target.value)}
              className="w-full md:w-96 rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
              placeholder="Search invoices..."
            />
          </div>

          {loadingInv ? (
            <div className="mt-4 text-slate-400 text-sm">Loading invoices...</div>
          ) : historyFiltered.length === 0 ? (
            <div className="mt-4 text-slate-400 text-sm">No invoices found.</div>
          ) : (
            <>
              {/* Mobile history cards */}
              <ul className="mt-3 space-y-2 md:hidden">
                {historyFiltered.map((inv) => {
                  const cancelled = inv.status === "CANCELLED";
                  return (
                    <li
                      key={inv.id}
                      className="rounded-xl border border-slate-800 bg-slate-950/60 p-3"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-100 break-words">
                            {inv.invoiceNo || "-"}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            {formatDateValue(inv.saleAtMs, "-")}
                            {" · "}
                            {inv.orderType || "—"}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="font-semibold tabular-nums text-slate-100">
                            {money(inv.grandTotal || 0)}
                          </div>
                          <span
                            className={`mt-1 inline-flex text-[10px] px-2 py-0.5 rounded-full border ${
                              cancelled
                                ? "border-red-800 text-red-200 bg-red-950/30"
                                : "border-emerald-800 text-emerald-200 bg-emerald-950/20"
                            }`}
                          >
                            {inv.status || "ACTIVE"}
                          </span>
                        </div>
                      </div>
                      <div className="mt-2 text-sm text-slate-300">
                        {inv.customerName || "Walk-in"}
                        {inv.customerPhone ? (
                          <span className="text-slate-500"> · {inv.customerPhone}</span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {formatPaymentLabel(inv, decimals)}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => viewInvoice(inv)}
                          className="min-h-9 rounded-lg border border-slate-700 px-3 text-xs text-slate-200 hover:bg-slate-900/50"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          onClick={() => editInvoice(inv)}
                          disabled={cancelled}
                          className="min-h-9 rounded-lg border border-blue-700 px-3 text-xs text-blue-200 hover:bg-blue-950/30 disabled:opacity-50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => printInvoiceWithItems(inv)}
                          className="min-h-9 rounded-lg bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500"
                        >
                          Print
                        </button>
                        <button
                          type="button"
                          onClick={() => cancelInvoice(inv)}
                          disabled={cancelled}
                          className="min-h-9 rounded-lg border border-red-800 px-3 text-xs text-red-200 hover:bg-red-950/30 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {/* Desktop history table */}
              <div className="mt-3 hidden overflow-x-auto rounded-xl border border-slate-800 md:block">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-900/60 border-b border-slate-800">
                    <tr className="text-left text-slate-200 text-xs">
                      <th className="p-2">Date</th>
                      <th className="p-2">Invoice</th>
                      <th className="p-2">Customer</th>
                      <th className="p-2">Phone</th>
                      <th className="p-2">Order</th>
                      <th className="p-2">Payment</th>
                      <th className="p-2">Status</th>
                      <th className="p-2 text-right">Total</th>
                      <th className="p-2">Actions</th>
                    </tr>
                  </thead>

                  <tbody>
                    {historyFiltered.map((inv) => {
                      const cancelled = inv.status === "CANCELLED";
                      return (
                        <tr key={inv.id} className="border-b border-slate-900">
                          <td className="p-2 text-slate-300">
                            {formatDateValue(inv.saleAtMs, "-")}
                          </td>
                          <td className="p-2">
                            <div className="text-slate-100 font-semibold">
                              {inv.invoiceNo || "-"}
                            </div>
                            <div className="text-xs text-slate-500">
                              Items: {inv.itemCount ?? "-"} • Tax:{" "}
                              {money(inv.taxAmount || 0)}
                            </div>
                          </td>
                          <td className="p-2 text-slate-200">
                            {inv.customerName || "-"}
                          </td>
                          <td className="p-2 text-slate-300">
                            {inv.customerPhone || "-"}
                          </td>
                          <td className="p-2 text-slate-300">{inv.orderType || "-"}</td>
                          <td className="p-2 text-slate-300">
                            {formatPaymentLabel(inv, decimals)}
                          </td>
                          <td className="p-2">
                            <span
                              className={`text-xs px-2 py-1 rounded-full border ${
                                cancelled
                                  ? "border-red-800 text-red-200 bg-red-950/30"
                                  : "border-emerald-800 text-emerald-200 bg-emerald-950/20"
                              }`}
                            >
                              {inv.status || "ACTIVE"}
                            </span>
                          </td>
                          <td className="p-2 text-right text-slate-100 font-semibold">
                            {money(inv.grandTotal || 0)}
                          </td>
                          <td className="p-2 whitespace-nowrap">
                            <div className="flex gap-2 flex-wrap">
                              <button
                                type="button"
                                onClick={() => viewInvoice(inv)}
                                className="rounded-lg border border-slate-700 text-slate-200 px-3 py-1.5 text-xs hover:bg-slate-900/50"
                              >
                                View
                              </button>

                              <button
                                type="button"
                                onClick={() => editInvoice(inv)}
                                disabled={cancelled}
                                className="rounded-lg border border-blue-700 text-blue-200 px-3 py-1.5 text-xs hover:bg-blue-950/30 disabled:opacity-50"
                              >
                                Edit
                              </button>

                              <button
                                type="button"
                                onClick={() => printInvoiceWithItems(inv)}
                                className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-xs"
                              >
                                Print
                              </button>

                              <button
                                type="button"
                                onClick={() => cancelInvoice(inv)}
                                disabled={cancelled}
                                className="rounded-lg border border-red-800 text-red-200 px-3 py-1.5 text-xs hover:bg-red-950/30 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* ================= NEW ORDER (layout by shop_type) ================= */}
      {tab === "new" ? (
        <>
          {editingInvoice ? (
            <div className="mt-6 flex items-center justify-between gap-3 rounded-xl border border-amber-700 bg-amber-950/30 px-4 py-3">
              <div className="text-sm text-amber-100">
                Editing invoice <b>{editingInvoice.invoiceNo}</b>. Save will update the existing record.
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditingInvoice(null);
                  setInvoiceNo(makeInvoiceNo());
                  setSaleDate(todayYYYYMMDD());
                  setCart([]);
                  setMsg("");
                }}
                className="rounded-lg border border-amber-700 px-3 py-1.5 text-xs text-amber-100"
              >
                Cancel Edit
              </button>
            </div>
          ) : null}
          <div className={editingInvoice ? "mt-3" : ""}>
            <SalesLayout {...salesLayoutProps} />
          </div>
        </>
      ) : null}
    </div>
  );
}
