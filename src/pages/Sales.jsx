// src/pages/Sales.jsx
console.log("🔥 SALES COMPONENT LOADED FROM THIS FILE");

import { useEffect, useMemo, useRef, useState } from "react";
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
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { useShift, useUnsavedWork } from "../context/shift-context.js";
import DateInput from "../components/DateInput.jsx";
import ModuleExitButton from "../components/ModuleExitButton.jsx";
import { formatDateValue } from "../utils/dateFormat.js";
import {
  buildTransactionPayload,
  normalizeTransactionMode,
} from "../utils/transactionContract.js";
import { useBankAccounts } from "../hooks/useBankAccounts.js";
import {
  buildPaymentModeOptions,
  findBankAccountName,
  legacyPaymentModeFlags,
  parsePaymentModeSelection,
  paymentModeSelectionFromSaved,
} from "../utils/paymentModes.js";

/**
 * =========================
 * Helpers
 * =========================
 */
function num(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function money(v) {
  return num(v).toFixed(2);
}
function calcBaseTotal(qty, sellingPrice) {
  return Math.max(0, num(qty) * num(sellingPrice));
}
function calcTaxAmount(qty, sellingPrice, taxPct) {
  const base = calcBaseTotal(qty, sellingPrice);
  return Math.max(0, (base * num(taxPct)) / 100);
}
function calcLineTotal(qty, sellingPrice, taxPct) {
  const base = calcBaseTotal(qty, sellingPrice);
  const taxAmt = calcTaxAmount(qty, sellingPrice, taxPct);
  return Math.max(0, base + taxAmt);
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
function printInvoice({ shopName, invoice, items, mode }) {
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
            <div><b>Payment:</b> ${escapeHtml(invoice.paymentMode || "-")}</div>
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
            window.print();
            setTimeout(() => window.close(), 300);
          };
        </script>
      </body>
    </html>
  `;

  const w = window.open("", "_blank", "width=900,height=700");
  if (!w) {
    alert("Popup blocked. Allow popups to print.");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/**
 * =========================
 * Page
 * =========================
 */
export default function Sales() {
  const { activeClientId, activeClientData } = useClient();
  const { user } = useAuth();
  const { activeShift, loadingShift } = useShift();
  const { accounts: bankAccounts } = useBankAccounts(activeClientId);

  // Tabs
  const [tab, setTab] = useState("new"); // new | history

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
  const [editingInvoice, setEditingInvoice] = useState(null);

  // Printer selection
  const [printMode, setPrintMode] = useState("A4"); // A4 | THERMAL

  // Invoice fields
  const [saleDate, setSaleDate] = useState(todayYYYYMMDD());
  const [invoiceNo, setInvoiceNo] = useState(makeInvoiceNo());
  const [paymentMode, setPaymentMode] = useState("CASH");
  const paymentModeOptions = useMemo(
    () =>
      buildPaymentModeOptions({
        bankAccounts,
        ...legacyPaymentModeFlags(paymentMode),
      }),
    [bankAccounts, paymentMode]
  );
  const resolvedPayment = parsePaymentModeSelection(paymentMode);
  const [orderType, setOrderType] = useState("COUNTER"); // COUNTER | TAKEAWAY | CARHOP | DELIVERY

  // Customer fields (select OR add)
  const [customerId, setCustomerId] = useState(""); // optional
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [address3, setAddress3] = useState("");

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
  const [cart, setCart] = useState([]);

  // UI states
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useUnsavedWork(
    "sales",
    "Sales / Billing",
    Boolean(cart.length || editingInvoice)
  );

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
    return items
      .filter((it) =>
        `${it.itemCode || ""} ${it.itemName || ""}`.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [items, search, selectedItemId]);

  // ✅ Totals + Tax (item-wise)
  const totals = useMemo(() => {
    const subTotal = cart.reduce((s, x) => s + num(x.baseTotal), 0);
    const discountTotal = 0;
    const grandTotalBeforeTax = cart.reduce((s, x) => s + num(x.baseTotal), 0);
    const taxAmount = cart.reduce((s, x) => s + num(x.taxAmount), 0);
    const grandTotal = grandTotalBeforeTax + taxAmount;

    return { subTotal, discountTotal, grandTotalBeforeTax, taxAmount, grandTotal };
  }, [cart]);

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
    setCustomerPhone(c.phone || c.mobile || "");
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

  function addLine({ item, qtyVal, sellingPriceValue, desc, taxPct: taxPctVal }) {
    const q = num(qtyVal);
    const price = num(sellingPriceValue);

    const baseTotal = calcBaseTotal(q, price);
    const taxAmount = calcTaxAmount(q, price, taxPctVal);
    const total = baseTotal + taxAmount;
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
    if (!price || price <= 0) return setErr("Selling Price must be > 0.");

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
        next.baseTotal = calcBaseTotal(next.qty, next.sellingPrice);
        next.taxAmount = calcTaxAmount(
          next.qty,
          next.sellingPrice,
          next.taxPct
        );
        next.total = next.baseTotal + next.taxAmount;
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

    // If selected from dropdown → update
    if (customerId) {
      await updateDoc(doc(db, "parties", customerId), {
        name: name || "",
        phone: phone || "",
        address1: a1 || "",
        address2: a2 || "",
        address3: a3 || "",
        updatedAt: serverTimestamp(),
        lastSaleAtMs: chosenMs,
      });
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
        await updateDoc(doc(db, "parties", d.id), {
          name: name || d.data().name || phone,
          phone,
          address1: a1 || d.data().address1 || "",
          address2: a2 || d.data().address2 || "",
          address3: a3 || d.data().address3 || "",
          updatedAt: serverTimestamp(),
          lastSaleAtMs: chosenMs,
        });
        return d.id;
      }
    }

    // Create new
    const ref = await addDoc(collection(db, "parties"), {
      clientId: activeClientId,
      type: "Customer",
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
        limit(10)
      )
    );
    return snap.docs.filter((d) => {
      const data = d.data();
      return (
        data?.clientId === activeClientId &&
        data?.refType === "sales_invoice"
      );
    });
  }

  async function finishAndBilling({ doPrint }) {
    setErr("");
    setMsg("");

    if (!activeClientId) return;
    if (loadingShift) return setErr("Active shift is still loading.");
    if (!activeShift?.id || activeShift.status !== "OPEN") {
      return setErr("Open a shift before recording a POS sale.");
    }
    if (!invoiceNo.trim()) return setErr("Invoice No required.");
    if (cart.length === 0) return setErr("Add at least one item.");
    if (
      resolvedPayment.paymentMode === "BANK" &&
      !resolvedPayment.bankAccountId
    ) {
      return setErr("Select a bank account for bank payments.");
    }
    if (cart.some((item) => num(item.qty) <= 0)) {
      return setErr("Every item quantity must be greater than zero.");
    }
    if (cart.some((item) => num(item.sellingPrice) <= 0)) {
      return setErr("Every item Selling Price must be greater than zero.");
    }

    // ✅ Delivery validation: name + mobile + address1 required
    if (orderType === "DELIVERY") {
      if (!customerName.trim()) return setErr("Delivery: Customer Name is required.");
      if (!customerPhone.trim()) return setErr("Delivery: Mobile Number is required.");
      if (!address1.trim()) return setErr("Delivery: Address 1 is required.");
    }

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
    const accountingRef =
      existingAccountingDocs[0]?.ref ||
      doc(db, "transactions", `sales_invoice_${invoiceRef.id}`);

    const saleTransaction = buildTransactionPayload({
      clientId: activeClientId,
      date: lockedSaleDate,
      type: "sales",
      category: "Sales",
      mode: resolvedPayment.paymentMode,
      bankAccountId: resolvedPayment.bankAccountId || "",
      bankAccountName: findBankAccountName(
        bankAccounts,
        resolvedPayment.bankAccountId
      ),
      partyType: "Customer",
      partyId: linkedCustomerId,
      partyName: customerName.trim() || "Cash",
      description: `Sales invoice ${invoiceNo.trim()}`,
      amountBeforeTax: totals.grandTotalBeforeTax,
      taxAmount: totals.taxAmount,
      totalAmount: totals.grandTotal,
      source: "pos",
      refType: "sales_invoice",
      refId: invoiceRef.id,
      shiftId: activeShift.id,
      invoiceNo: invoiceNo.trim(),
      orderType,
      status: "POSTED",
    });

    const invoicePayload = {
      clientId: activeClientId,
      clientName: activeClientData?.name || "",

      invoiceNo: invoiceNo.trim(),
      saleAtMs: chosenMs,
      saleAt: saleTransaction.date,

      // Customer
      customerId: linkedCustomerId || null,
      customerName: customerName.trim() || "",
      customerPhone: customerPhone.trim() || "",
      address1: address1 || "",
      address2: address2 || "",
      address3: address3 || "",

      orderType,
      paymentMode: resolvedPayment.paymentMode,
      bankAccountId: resolvedPayment.bankAccountId || "",
      bankAccountName: findBankAccountName(
        bankAccounts,
        resolvedPayment.bankAccountId
      ),
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
      accountingTransactionId: accountingRef.id,
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
      updatedBy: user?.uid || null,
    };

    setSaving(true);
    try {
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
        const accountingSnap = await tx.get(accountingRef);

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
              date: saleTransaction.date,
              dateMs: chosenMs,
              createdAt: serverTimestamp(),
              createdBy: user?.uid || null,
            });
          }
        });

        tx.set(
          accountingRef,
          {
            ...saleTransaction,
            createdAt: accountingSnap.exists()
              ? accountingSnap.data()?.createdAt || serverTimestamp()
              : serverTimestamp(),
            createdBy: accountingSnap.exists()
              ? accountingSnap.data()?.createdBy || user?.uid || null
              : user?.uid || null,
            updatedAt: serverTimestamp(),
            updatedBy: user?.uid || null,
          },
          { merge: accountingSnap.exists() }
        );
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
        });
      }

      // Reset for next order
      setInvoiceNo(makeInvoiceNo());
      setEditingInvoice(null);
      setSaleDate(todayYYYYMMDD());
      setPaymentMode("CASH");
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
      setTimeout(() => searchRef.current?.focus?.(), 0);
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to save order.");
    } finally {
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
          inv.paymentMode || "-"
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
      setPaymentMode(
        tenderFormValue(inv.paymentMode || "CASH", inv.bankAccountId)
      );
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
        const baseTotal = calcBaseTotal(it.qty, it.sellingPrice);
        const taxAmount = calcTaxAmount(
          it.qty,
          it.sellingPrice,
          it.taxPct || 0
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
          total: baseTotal + taxAmount,
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
      const saleTxnRef =
        existingAccountingDocs[0]?.ref ||
        doc(db, "transactions", `sales_invoice_${inv.id}`);
      const reversalRef = doc(
        db,
        "transactions",
        `sales_invoice_cancel_${inv.id}`
      );
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

      const originalSale = buildTransactionPayload({
        clientId: activeClientId,
        date: businessDate,
        type: "sales",
        category: "Sales",
        mode: inv.paymentMode || "cash",
        partyType: "Customer",
        partyId: inv.customerId || null,
        partyName: inv.customerName || "Cash",
        description: `Sales invoice ${inv.invoiceNo || ""}`,
        amountBeforeTax: num(inv.grandTotalBeforeTax),
        taxAmount: num(inv.taxAmount),
        totalAmount: num(inv.grandTotal),
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
        amountBeforeTax: -num(inv.grandTotalBeforeTax),
        taxAmount: -num(inv.taxAmount),
        totalAmount: -num(inv.grandTotal),
        amountIn: -num(inv.grandTotal),
        amountOut: 0,
        source: "pos_cancel",
        refType: "sales_invoice_cancel",
        refId: inv.id,
        reversalOf: saleTxnRef.id,
        status: "POSTED",
      });

      await runTransaction(db, async (tx) => {
        const invoiceSnap = await tx.get(invoiceRef);
        const inventorySnaps = [];
        for (const itemRef of itemRefs) {
          inventorySnaps.push(await tx.get(itemRef));
        }
        const saleTxnSnap = await tx.get(saleTxnRef);
        const reversalSnap = await tx.get(reversalRef);

        if (!invoiceSnap.exists()) throw new Error("Invoice no longer exists.");
        if (invoiceSnap.data()?.status === "CANCELLED" || reversalSnap.exists()) {
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
              date: originalSale.date,
              dateMs: originalSale.dateMs,
              createdAt: serverTimestamp(),
              createdBy: user?.uid || null,
            });
          });
        }

        tx.set(
          saleTxnRef,
          {
            ...originalSale,
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
        tx.set(reversalRef, {
          ...reversal,
          cancelReason: reason,
          createdAt: serverTimestamp(),
          createdBy: user?.uid || null,
          updatedAt: serverTimestamp(),
          updatedBy: user?.uid || null,
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

  /**
   * =========================
   * UI
   * =========================
   */
  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Sales / Billing</h1>
          <p className="text-slate-400 mt-1">
            Customer + item pricing + Tax + Print (A4 / Thermal)
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
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

      {err ? (
        <div className="mt-4 rounded-lg border border-red-800 bg-red-950/40 text-red-200 px-3 py-2 text-sm">
          {err}
        </div>
      ) : null}

      {msg ? (
        <div className="mt-4 rounded-lg border border-green-800 bg-green-950/30 text-green-200 px-3 py-2 text-sm">
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
            <div className="mt-3 rounded-xl border border-slate-800 overflow-x-auto">
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
                            Items: {inv.itemCount ?? "-"} • Tax: {money(inv.taxAmount || 0)}
                          </div>
                        </td>
                        <td className="p-2 text-slate-200">{inv.customerName || "-"}</td>
                        <td className="p-2 text-slate-300">{inv.customerPhone || "-"}</td>
                        <td className="p-2 text-slate-300">{inv.orderType || "-"}</td>
                        <td className="p-2 text-slate-300">{inv.paymentMode || "-"}</td>
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
          )}
        </div>
      ) : null}

      {/* ================= NEW ORDER ================= */}
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
        <div className={`${editingInvoice ? "mt-3" : "mt-6"} grid grid-cols-1 xl:grid-cols-12 gap-4`}>
          {/* LEFT */}
          <div className="xl:col-span-7 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            {/* Invoice meta */}
            <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Sale Date</label>
                <DateInput
                  value={saleDate}
                  disabled={!editingInvoice}
                  onChange={(e) => setSaleDate(e.target.value)}
                  className="mt-1 h-10 w-full rounded-lg border border-slate-700 bg-slate-900 text-slate-100"
                />
                {!editingInvoice ? (
                  <p className="mt-1 text-[11px] text-slate-500">
                    Locked to active shift
                  </p>
                ) : null}
              </div>

              <div className="md:col-span-8">
                <label className="text-sm text-slate-300">Invoice No</label>
                <input
                  value={invoiceNo}
                  onChange={(e) => setInvoiceNo(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                />
              </div>

              {/* Order Type */}
              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Order Type</label>
                <select
                  value={orderType}
                  onChange={(e) => setOrderType(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                >
                  <option value="COUNTER">Counter Sale</option>
                  <option value="TAKEAWAY">Take Away</option>
                  <option value="CARHOP">Car Hop</option>
                  <option value="DELIVERY">Delivery</option>
                </select>
              </div>

              {/* Payment Mode */}
              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Payment Mode</label>
                <select
                  value={paymentMode}
                  onChange={(e) => setPaymentMode(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                >
                  {paymentModeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  {normalizeTransactionMode(paymentMode) === "credit" ? (
                    <option value="CREDIT">Credit (Legacy Record)</option>
                  ) : null}
                </select>
              </div>

              {/* Printer Mode */}
              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Printer</label>
                <select
                  value={printMode}
                  onChange={async (e) => {
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
                  }}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                >
                  <option value="A4">A4</option>
                  <option value="THERMAL">Thermal</option>
                </select>
              </div>

              {/* Select customer */}
              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Select Customer (optional)</label>
                <select
                  value={customerId}
                  onChange={(e) => onSelectCustomer(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  disabled={loadingCustomers}
                >
                  <option value="">
                    {loadingCustomers ? "Loading customers..." : "— Select customer —"}
                  </option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-slate-500 mt-1">
                  Customer list comes from <b>Parties</b> (Type: Customer / Both).
                </div>
              </div>

              {/* Customer manual/add */}
              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Customer Name</label>
                <input
                  value={customerName}
                  onChange={(e) => {
                    setCustomerName(e.target.value);
                    setCustomerId("");
                  }}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="Enter customer name..."
                />
              </div>

              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Contact Number</label>
                <input
                  value={customerPhone}
                  onChange={(e) => {
                    setCustomerPhone(e.target.value);
                    setCustomerId("");
                  }}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="Phone / WhatsApp..."
                />
              </div>

              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Address 1</label>
                <input
                  value={address1}
                  onChange={(e) => {
                    setAddress1(e.target.value);
                    setCustomerId("");
                  }}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="House / Building..."
                />
              </div>

              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Address 2</label>
                <input
                  value={address2}
                  onChange={(e) => {
                    setAddress2(e.target.value);
                    setCustomerId("");
                  }}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="Street / Area..."
                />
              </div>

              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Address 3</label>
                <input
                  value={address3}
                  onChange={(e) => {
                    setAddress3(e.target.value);
                    setCustomerId("");
                  }}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="City / State..."
                />
              </div>
            </div>

            {/* Add item manually */}
            <div className="mt-4 border-t border-slate-800 pt-4">
              <h3 className="text-slate-100 font-semibold">Add / Select Item</h3>

              <div className="mt-2">
                <label className="text-sm text-slate-300">Search Item</label>
                <input
                  ref={searchRef}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setSelectedItemId("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (filteredItems.length > 0) {
                        const it = filteredItems[0];
                        setSelectedItemId(it.id);
                        setSearch(
                          `${getItemBaseCode(it) || "NO CODE"} — ${it.itemName || ""}`
                        );
                        setQty("1");
                        setLineSellingPrice(String(num(it.sellingPrice)));
                        setTimeout(() => taxPctRef.current?.focus?.(), 0);
                      }
                    }
                  }}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="Search by item code or name..."
                />

                {filteredItems.length > 0 ? (
                  <div className="mt-2 max-h-64 overflow-auto rounded-xl border border-slate-800">
                    {filteredItems.map((it) => (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => {
                          setSelectedItemId(it.id);
                          setSearch(
                            `${getItemBaseCode(it) || "NO CODE"} — ${it.itemName || ""}`
                          );
                          setQty("1");
                          setLineSellingPrice(String(num(it.sellingPrice)));
                          setTimeout(() => taxPctRef.current?.focus?.(), 0);
                        }}
                        className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/40"
                      >
                        <div className="flex items-center justify-between">
                          <div className="text-slate-100 font-medium text-sm">{it.itemName}</div>
                          <div className="text-slate-400 text-xs">
                            Code: {getItemBaseCode(it) || "-"}
                          </div>
                        </div>
                        <div className="text-slate-500 text-xs">
                          Stock: {money(it.currentStock)} • Price: {money(it.sellingPrice)}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="mt-3">
                <label className="text-sm text-slate-300">Item Description (optional)</label>
                <input
                  value={itemDesc}
                  onChange={(e) => setItemDesc(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900/60 border border-slate-700 px-3 py-2 text-slate-200 text-sm"
                  placeholder="Notes for invoice / KOT / warehouse..."
                />
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-3">
                  <label className="text-sm text-slate-300">Tax %</label>
                  <input
                    ref={taxPctRef}
                    type="number"
                    inputMode="decimal"
                    value={taxPct}
                    onChange={(e) => setTaxPct(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        qtyRef.current?.focus?.();
                      }
                    }}
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    placeholder="0"
                  />
                </div>

                <div className="md:col-span-3">
                  <label className="text-sm text-slate-300">QTY</label>
                  <input
                    ref={qtyRef}
                    type="number"
                    inputMode="decimal"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        sellingPriceRef.current?.focus?.();
                      }
                    }}
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  />
                </div>

                <div className="md:col-span-3">
                  <label className="text-sm text-slate-300">Selling Price</label>
                  <input
                    ref={sellingPriceRef}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={lineSellingPrice}
                    onChange={(e) => setLineSellingPrice(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addBtnRef.current?.click?.();
                      }
                    }}
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    placeholder="0.00"
                  />
                </div>

                <div className="md:col-span-3">
                  <label className="text-sm text-slate-300">Total</label>
                  <input
                    readOnly
                    value={money(
                      calcLineTotal(
                        qty || 0,
                        lineSellingPrice === ""
                          ? selectedItem?.sellingPrice ?? 0
                          : lineSellingPrice,
                        taxPct || 0
                      )
                    )}
                    className="mt-1 w-full rounded-lg bg-slate-900/60 border border-slate-700 px-3 py-2 text-slate-100 font-semibold"
                  />
                </div>

                <div className="md:col-span-12 flex justify-end gap-2 mt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setSearch("");
                      setSelectedItemId("");
                      setQty("1");
                      setLineSellingPrice("");
                      setTimeout(() => searchRef.current?.focus?.(), 0);
                    }}
                    className="rounded-lg border border-slate-700 text-slate-200 px-4 py-1.5 text-sm hover:bg-slate-900/50"
                  >
                    Clear Item
                  </button>

                  <button
                    ref={addBtnRef}
                    type="button"
                    onClick={addItemToCart}
                    className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-semibold disabled:opacity-60"
                    disabled={!selectedItem || loadingItems}
                  >
                    + Add Next Item
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT: Cart + Billing */}
          <div className="xl:col-span-5 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h2 className="text-slate-100 font-semibold">Order Items</h2>
              <div className="text-xs text-slate-400">Columns: Total includes Tax</div>
            </div>

            {cart.length === 0 ? (
              <div className="mt-4 text-slate-400 text-sm">
                No items added. Add an item from search.
              </div>
            ) : (
              <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-900/60 border-b border-slate-800">
                    <tr className="text-left text-slate-200 text-xs">
                      <th className="p-2">#</th>
                      <th className="p-2">Code</th>
                      <th className="p-2">Item</th>
                      <th className="p-2 text-right">Qty</th>
                      <th className="p-2 text-right">Price</th>
                      <th className="p-2 text-right">Tax%</th>
                      <th className="p-2 text-right">Total</th>
                      <th className="p-2">Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {cart.flatMap((row, idx) => [
                      <tr key={`${row.lineId}-main`} className="border-b border-slate-900">
                        <td className="p-2 text-slate-300">{idx + 1}</td>
                        <td className="p-2 text-slate-300">{row.itemCode || "-"}</td>
                        <td className="p-2">
                          <div className="text-slate-100 font-medium">{row.itemName}</div>
                        </td>

                        <td className="p-2">
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0.0001"
                            step="any"
                            value={row.qty}
                            onChange={(e) => updateLine(row.lineId, { qty: e.target.value })}
                            className="w-20 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100"
                          />
                        </td>

                        <td className="p-2">
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
                            className="w-24 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100"
                          />
                        </td>

                        <td className="p-2">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={row.taxPct ?? 0}
                            onChange={(e) => updateLine(row.lineId, { taxPct: e.target.value })}
                            className="w-20 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100"
                            placeholder="0"
                          />
                        </td>

                        <td className="p-2 text-right text-slate-100 font-semibold">
                          {money(row.total)}
                        </td>

                        <td className="p-2">
                          <button
                            type="button"
                            onClick={() => removeLine(row.lineId)}
                            className="rounded-lg border border-red-800 text-red-200 px-2 py-1 hover:bg-red-950/30"
                          >
                            Remove
                          </button>
                        </td>
                      </tr>,

                      <tr
                        key={`${row.lineId}-desc`}
                        className="border-b border-slate-900 bg-slate-950/40"
                      >
                        <td className="p-2 text-slate-500" />
                        <td className="p-2 text-slate-500" colSpan={2}>
                          <span className="text-xs text-slate-400">
                            Item Description (invoice + KOT / warehouse)
                          </span>
                        </td>
                        <td className="p-2" colSpan={5}>
                          <input
                            value={row.description || ""}
                            onChange={(e) =>
                              updateLine(row.lineId, { description: e.target.value })
                            }
                            className="w-full rounded-lg bg-slate-900 border border-slate-700 px-2 py-1.5 text-slate-100 text-sm"
                            placeholder="Enter description..."
                          />
                        </td>
                      </tr>,
                    ])}
                  </tbody>
                </table>
              </div>
            )}

            {/* Totals + Billing */}
            <div className="mt-4 border-t border-slate-800 pt-4 space-y-2 text-sm">
              <div className="flex justify-between text-slate-300">
                <span>Sub Total</span>
                <span className="text-slate-100 font-medium">{money(totals.subTotal)}</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Grand Total (Before Tax)</span>
                <span className="text-slate-100 font-medium">
                  {money(totals.grandTotalBeforeTax)}
                </span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Tax (Item-wise)</span>
                <span className="text-slate-100 font-medium">{money(totals.taxAmount)}</span>
              </div>
              <div className="flex justify-between text-slate-200 text-base">
                <span className="font-semibold">Grand Total</span>
                <span className="font-semibold">{money(totals.grandTotal)}</span>
              </div>

              <div className="pt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => finishAndBilling({ doPrint: false })}
                  disabled={saving || cart.length === 0}
                  className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-semibold disabled:opacity-60"
                >
                  {saving
                    ? "Saving..."
                    : editingInvoice
                    ? "Update Invoice"
                    : "Finish Order"}
                </button>

                <button
                  type="button"
                  onClick={() => finishAndBilling({ doPrint: true })}
                  disabled={saving || cart.length === 0}
                  className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 font-semibold disabled:opacity-60"
                >
                  {saving
                    ? "Saving..."
                    : editingInvoice
                    ? `Update + Print (${printMode})`
                    : `Billing + Print (${printMode})`}
                </button>
              </div>

              <div className="text-xs text-slate-500">
                Saved to <b>sales_invoices</b> + subcollection <b>items</b> + <b>transactions</b>.
              </div>
            </div>
          </div>
        </div>
        </>
      ) : null}
    </div>
  );
}
