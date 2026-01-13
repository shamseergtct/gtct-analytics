// src/pages/Sales.jsx
console.log("🔥 SALES COMPONENT LOADED FROM THIS FILE");

import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";

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
function calcBaseTotal(qty, drp) {
  return Math.max(0, num(qty) * num(drp));
}
function calcTaxAmount(qty, drp, taxPct) {
  const base = calcBaseTotal(qty, drp);
  return Math.max(0, (base * num(taxPct)) / 100);
}
function calcLineTotal(qty, drp, taxPct) {
  const base = calcBaseTotal(qty, drp);
  const taxAmt = calcTaxAmount(qty, drp, taxPct);
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

/**
 * =========================
 * Variant rules
 * =========================
 */
function getItemBaseCode(item) {
  return item?.itemCode || item?.code || item?.sku || "";
}
function getItemVariants(item) {
  const arr = Array.isArray(item?.variants) ? item.variants : [];
  if (arr.length > 0) {
    return arr.map((v, idx) => ({
      id: v.id || v.name || String(idx),
      name: v.name || v.variant || `Variant ${idx + 1}`,
      mrp: v.mrp ?? v.MRP ?? item?.mrp ?? item?.sellingPrice ?? 0,
      drp: v.drp ?? v.DRP ?? item?.drp ?? item?.sellingPrice ?? 0,
      barcode: (v.barcode || "").trim(),
      code: v.code || v.itemCode || v.sku || "",
    }));
  }
  return [
    {
      id: "default",
      name: "Default",
      mrp: item?.mrp ?? item?.sellingPrice ?? 0,
      drp: item?.drp ?? item?.sellingPrice ?? 0,
      barcode: (item?.barcode || "").trim(),
      code: getItemBaseCode(item),
    },
  ];
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
    invoice.saleAtMs ? new Date(num(invoice.saleAtMs)).toLocaleDateString() : "-"
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
      const variant = escapeHtml(it.variantName || "");
      const qty = money(it.qty);
      const mrp = money(it.mrp);
      const drp = money(it.drp);
      const total = money(it.total);
      const desc = escapeHtml(it.description || "");

      return `
        <tr>
          <td class="sn">${sn}</td>
          <td class="code">${code}</td>
          <td class="name">
            ${name}${variant ? ` <span class="muted">(${variant})</span>` : ""}
          </td>
          <td class="num">${qty}</td>
          <td class="num">${mrp}</td>
          <td class="num">${drp}</td>
          <td class="num">${total}</td>
        </tr>
        ${
          desc
            ? `<tr class="desc-row"><td></td><td colspan="6" class="desc">↳ ${desc}</td></tr>`
            : ""
        }
      `;
    })
    .join("");

  const subTotal = money(invoice.subTotal);
  const discountTotal = money(invoice.discountTotal);
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
                <th class="num">MRP</th>
                <th class="num">DRP</th>
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
                  <div style="display:flex; justify-content:space-between;"><span>Discount</span><span>${discountTotal}</span></div>
                  <div style="display:flex; justify-content:space-between;"><span>Grand Total (Before Tax)</span><span>${grandBeforeTax}</span></div>
                  <div style="display:flex; justify-content:space-between;"><span>Tax</span><span>${taxAmount}</span></div>
                  <div style="display:flex; justify-content:space-between; font-weight:800;"><span>Grand Total</span><span>${grandTotal}</span></div>
                </div>
              `
              : `
                <div class="totals">
                  <table>
                    <tr><td>Sub Total</td><td class="num">${subTotal}</td></tr>
                    <tr><td>Discount</td><td class="num">${discountTotal}</td></tr>
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

  // Tabs
  const [tab, setTab] = useState("new"); // new | history

  // Inventory for item search + barcode match
  const [items, setItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(true);

  // Customers (from Parties: Customer / Both)
  const [customers, setCustomers] = useState([]);
  const [loadingCustomers, setLoadingCustomers] = useState(false);

  // Invoice History
  const [invoices, setInvoices] = useState([]);
  const [loadingInv, setLoadingInv] = useState(false);
  const [invSearch, setInvSearch] = useState("");

  // Printer selection
  const [printMode, setPrintMode] = useState("A4"); // A4 | THERMAL

  // Invoice fields
  const [saleDate, setSaleDate] = useState(todayYYYYMMDD());
  const [invoiceNo, setInvoiceNo] = useState(makeInvoiceNo());
  const [paymentMode, setPaymentMode] = useState("CASH"); // CASH | BANK | CREDIT
  const [orderType, setOrderType] = useState("COUNTER"); // COUNTER | TAKEAWAY | CARHOP | DELIVERY

  // (kept, not used now)
  const [taxPercent, setTaxPercent] = useState("0");

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
  const [selectedVariantId, setSelectedVariantId] = useState("default");
  const [qty, setQty] = useState("1");
  const [mrp, setMrp] = useState("");
  const [drp, setDrp] = useState("");
  const [taxPct, setTaxPct] = useState("0");
  const [itemDesc, setItemDesc] = useState("");

  const qtyRef = useRef(null);
  const searchRef = useRef(null);
  const taxPctRef = useRef(null);
  const mrpRef = useRef(null);
  const drpRef = useRef(null);
  const addBtnRef = useRef(null);

  // Barcode scanning
  const [barcode, setBarcode] = useState("");
  const barcodeRef = useRef(null);

  // Cart rows
  const [cart, setCart] = useState([]);

  // UI states
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

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

  const availableVariants = useMemo(() => {
    if (!selectedItem)
      return [{ id: "default", name: "Default", mrp: 0, drp: 0 }];
    return getItemVariants(selectedItem);
  }, [selectedItem]);

  useEffect(() => {
    if (!selectedItem) return;
    const vs = getItemVariants(selectedItem);
    const v = vs.find((x) => x.id === selectedVariantId) || vs[0];
    if (!v) return;
    setMrp((prev) => (prev === "" ? String(num(v.mrp)) : prev));
    setDrp((prev) => (prev === "" ? String(num(v.drp)) : prev));
  }, [selectedItemId, selectedVariantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter((it) => (it.itemName || "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [items, search]);

  // ✅ Totals + Tax (item-wise)
  const totals = useMemo(() => {
    const subTotal = cart.reduce((s, x) => s + num(x.qty) * num(x.mrp), 0);

    const discountTotal = cart.reduce(
      (s, x) => s + Math.max(0, num(x.qty) * (num(x.mrp) - num(x.drp))),
      0
    );

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

  function addLine({ item, variant, qtyVal, mrpVal, drpVal, desc, taxPct: taxPctVal }) {
    const q = num(qtyVal);
    const mrpN = num(mrpVal);
    const drpN = num(drpVal);

    const baseTotal = calcBaseTotal(q, drpN);
    const taxAmount = calcTaxAmount(q, drpN, taxPctVal);
    const total = baseTotal + taxAmount;
    const itemCode = (variant?.code || getItemBaseCode(item) || "").trim();

    const row = {
      lineId: makeLineId(),
      itemId: item.id,
      itemName: item.itemName || "",
      itemCode,
      unit: item.unit || "",
      variantId: variant?.id || "default",
      variantName: variant?.name || "Default",
      qty: q,
      mrp: mrpN,
      drp: drpN,
      taxPct: num(taxPctVal),
      baseTotal,
      taxAmount,
      total,
      description: desc || "",
    };

    setCart((prev) => [...prev, row]);
  }

  function addOrMergeByScan({ item, variant, desc }) {
    const descTrim = (desc || "").trim();
    const keyItemId = item.id;
    const keyVariantId = variant?.id || "default";

    const mrpN = num(variant?.mrp ?? item?.mrp ?? item?.sellingPrice ?? 0);
    const drpN = num(variant?.drp ?? item?.drp ?? item?.sellingPrice ?? 0);

    if (descTrim) {
      addLine({
        item,
        variant,
        qtyVal: 1,
        mrpVal: mrpN,
        drpVal: drpN,
        desc: descTrim,
        taxPct: taxPct,
      });
      return;
    }

    setCart((prev) => {
      const idx = prev.findIndex(
        (x) =>
          x.itemId === keyItemId &&
          x.variantId === keyVariantId &&
          !x.description
      );

      if (idx === -1) {
        const itemCode = (variant?.code || getItemBaseCode(item) || "").trim();
        const row = {
          lineId: makeLineId(),
          itemId: item.id,
          itemName: item.itemName || "",
          itemCode,
          unit: item.unit || "",
          variantId: keyVariantId,
          variantName: variant?.name || "Default",
          qty: 1,
          mrp: mrpN,
          drp: drpN,
          taxPct: num(taxPct),
          baseTotal: calcBaseTotal(1, drpN),
          taxAmount: calcTaxAmount(1, drpN, taxPct),
          total: calcLineTotal(1, drpN, taxPct),
          description: "",
        };
        return [...prev, row];
      }

      const next = [...prev];
      const old = next[idx];
      const newQty = num(old.qty) + 1;
      const baseTotal = calcBaseTotal(newQty, num(old.drp));
      const taxAmount = calcTaxAmount(newQty, num(old.drp), num(old.taxPct));
      next[idx] = {
        ...old,
        qty: newQty,
        baseTotal,
        taxAmount,
        total: baseTotal + taxAmount,
      };
      return next;
    });
  }

  function addItemToCart() {
    setErr("");
    setMsg("");

    if (!selectedItem) return setErr("Please select an item.");
    const q = num(qty);
    if (!q || q <= 0) return setErr("Qty must be > 0.");

    const vs = getItemVariants(selectedItem);
    const v = vs.find((x) => x.id === selectedVariantId) || vs[0];

    const mrpN = mrp === "" ? num(v.mrp) : num(mrp);
    const drpN = drp === "" ? num(v.drp) : num(drp);

    if (!mrpN || mrpN <= 0) return setErr("MRP must be > 0.");
    if (!drpN || drpN <= 0) return setErr("DRP must be > 0.");

    addLine({
      item: selectedItem,
      variant: v,
      qtyVal: q,
      mrpVal: mrpN,
      drpVal: drpN,
      desc: itemDesc || "",
      taxPct: taxPct,
    });

    setSearch("");
    setSelectedItemId("");
    setSelectedVariantId("default");
    setQty("1");
    setMrp("");
    setDrp("");
    setItemDesc("");
    setTimeout(() => barcodeRef.current?.focus?.(), 0);
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
        next.mrp = num(next.mrp);
        next.drp = num(next.drp);
        next.taxPct = num(next.taxPct);
        next.baseTotal = calcBaseTotal(next.qty, next.drp);
        next.taxAmount = calcTaxAmount(next.qty, next.drp, next.taxPct);
        next.total = next.baseTotal + next.taxAmount;
        return next;
      })
    );
  }

  /**
   * =========================
   * Barcode scanning logic
   * =========================
   */
  const barcodeMap = useMemo(() => {
    const map = new Map();
    items.forEach((it) => {
      const vs = getItemVariants(it);
      vs.forEach((v) => {
        const b = (v.barcode || "").trim();
        if (b) map.set(b, { item: it, variant: v });
      });
    });
    return map;
  }, [items]);

  function handleBarcodeSubmit() {
    const code = (barcode || "").trim();
    if (!code) return;

    const match = barcodeMap.get(code);
    if (!match) {
      setErr(`Barcode not found: ${code}`);
      setBarcode("");
      return;
    }

    setErr("");
    setMsg("");

    addOrMergeByScan({
      item: match.item,
      variant: match.variant,
      desc: itemDesc,
    });

    setBarcode("");
    setTimeout(() => searchRef.current?.focus?.(), 0);
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

  async function finishAndBilling({ doPrint }) {
    setErr("");
    setMsg("");

    if (!activeClientId) return;
    if (!invoiceNo.trim()) return setErr("Invoice No required.");
    if (cart.length === 0) return setErr("Add at least one item.");

    // ✅ Delivery validation: name + mobile + address1 required
    if (orderType === "DELIVERY") {
      if (!customerName.trim()) return setErr("Delivery: Customer Name is required.");
      if (!customerPhone.trim()) return setErr("Delivery: Mobile Number is required.");
      if (!address1.trim()) return setErr("Delivery: Address 1 is required.");
    }

    const chosenMs = dateStrToMsMidday(saleDate);

    // ✅ ensure customer party exists/updated (selected or typed)
    let linkedCustomerId = null;
    try {
      linkedCustomerId = await findOrUpsertCustomerParty({ chosenMs });
    } catch (e) {
      console.error("Customer upsert failed:", e);
      // we continue saving invoice even if customer update fails (optional behavior)
    }

    const invoicePayload = {
      clientId: activeClientId,
      clientName: activeClientData?.name || "",

      invoiceNo: invoiceNo.trim(),
      saleAtMs: chosenMs,
      saleAt: serverTimestamp(),

      // Customer
      customerId: linkedCustomerId || null,
      customerName: customerName.trim() || "",
      customerPhone: customerPhone.trim() || "",
      address1: address1 || "",
      address2: address2 || "",
      address3: address3 || "",

      orderType,
      paymentMode,
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

      createdAt: serverTimestamp(),
      createdAtMs: Date.now(),
      updatedAt: serverTimestamp(),
      updatedAtMs: Date.now(),
    };

    setSaving(true);
    try {
      const invoiceRef = await addDoc(collection(db, "sales_invoices"), invoicePayload);

      // Save items
      const itemsCol = collection(db, "sales_invoices", invoiceRef.id, "items");

      await Promise.all(
        cart.map((row, idx) =>
          addDoc(itemsCol, {
            clientId: activeClientId,
            invoiceId: invoiceRef.id,
            invoiceNo: invoicePayload.invoiceNo,
            saleAtMs: chosenMs,

            sn: idx + 1,
            itemId: row.itemId,
            itemCode: row.itemCode || "",
            itemName: row.itemName || "",
            variantId: row.variantId || "default",
            variantName: row.variantName || "Default",
            unit: row.unit || "",

            qty: num(row.qty),
            mrp: num(row.mrp),
            drp: num(row.drp),

            taxPct: num(row.taxPct),
            baseTotal: num(row.baseTotal),
            taxAmount: num(row.taxAmount),
            total: num(row.total),

            description: row.description || "",

            createdAt: serverTimestamp(),
          })
        )
      );

      // Auto-create transaction for reports
      await addDoc(collection(db, "transactions"), {
        clientId: activeClientId,

        dateMs: chosenMs,
        dateAt: serverTimestamp(),

        type: "income",
        category: "Sales",

        paymentMode,
        orderType,

        refType: "sales_invoice",
        refId: invoiceRef.id,
        invoiceNo: invoicePayload.invoiceNo,

        customerId: linkedCustomerId,
        customerName: invoicePayload.customerName || "",

        subTotal: num(invoicePayload.subTotal),
        taxAmount: num(invoicePayload.taxAmount),
        amount: num(invoicePayload.grandTotal),

        createdAt: serverTimestamp(),
      });

      setMsg("✅ Order saved successfully.");

      if (doPrint) {
        printInvoice({
          shopName: activeClientData?.name || activeClientId,
          invoice: { ...invoicePayload, customerId: linkedCustomerId },
          items: cart.map((x) => ({
            itemCode: x.itemCode,
            itemName: x.itemName,
            variantName: x.variantName,
            qty: x.qty,
            mrp: x.mrp,
            drp: x.drp,
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
      setSaleDate(todayYYYYMMDD());
      setPaymentMode("CASH");
      setOrderType("COUNTER");
      setTaxPercent("0");
      setCustomerId("");
      setCustomerName("");
      setCustomerPhone("");
      setAddress1("");
      setAddress2("");
      setAddress3("");
      setSearch("");
      setSelectedItemId("");
      setSelectedVariantId("default");
      setQty("1");
      setMrp("");
      setDrp("");
      setItemDesc("");
      setCart([]);
      setBarcode("");
      setTimeout(() => barcodeRef.current?.focus?.(), 0);
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
            `${x.sn}. ${x.itemCode || ""} | ${x.itemName} ${
              x.variantName ? `(${x.variantName})` : ""
            } | QTY ${money(x.qty)} | MRP ${money(x.mrp)} | DRP ${money(x.drp)} | Total ${money(
              x.total
            )}${x.description ? `\n   ↳ ${x.description}` : ""}`
        )
        .join("\n");

      alert(
        `Invoice: ${inv.invoiceNo}\nDate: ${
          inv.saleAtMs ? new Date(num(inv.saleAtMs)).toLocaleDateString() : "-"
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
          variantName: x.variantName,
          qty: x.qty,
          mrp: x.mrp,
          drp: x.drp,
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

  // ✅ Edit = load invoice into New Order screen (without saving until Finish)
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
      setSaleDate(inv.saleAtMs ? todayYYYYMMDD() : todayYYYYMMDD()); // keep today by default
      setInvoiceNo(inv.invoiceNo || makeInvoiceNo());
      setPaymentMode(inv.paymentMode || "CASH");
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
        const baseTotal = calcBaseTotal(it.qty, it.drp);
        const taxAmount = calcTaxAmount(it.qty, it.drp, it.taxPct || 0);
        return {
          lineId: makeLineId(),
          itemId: it.itemId,
          itemName: it.itemName || "",
          itemCode: it.itemCode || "",
          unit: it.unit || "",
          variantId: it.variantId || "default",
          variantName: it.variantName || "Default",
          qty: num(it.qty),
          mrp: num(it.mrp),
          drp: num(it.drp),
          taxPct: num(it.taxPct || 0),
          baseTotal,
          taxAmount,
          total: baseTotal + taxAmount,
          description: it.description || "",
        };
      });

      setCart(cartRows);
      setTab("new");
      setMsg(`📝 Loaded invoice ${inv.invoiceNo} into New Order (edit & re-save as needed).`);
      setErr("");
      setTimeout(() => barcodeRef.current?.focus?.(), 0);
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

      // 1) Load items
      const snap = await getDocs(
        query(collection(db, "sales_invoices", inv.id, "items"), limit(500))
      );
      const itemsList = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

      // 2) Mark invoice cancelled
      await updateDoc(doc(db, "sales_invoices", inv.id), {
        status: "CANCELLED",
        cancelledAt: serverTimestamp(),
        cancelledAtMs: Date.now(),
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
      });

      // 3) Reverse stock (add back qty) + movement log
      // Assumes inventory doc id == itemId and field = currentStock
      await Promise.all(
        itemsList.map(async (it) => {
          const invItemId = it.itemId;
          if (!invItemId) return;

          // stock +qty back
          await updateDoc(doc(db, "inventory", invItemId), {
            currentStock: increment(num(it.qty)),
            updatedAt: serverTimestamp(),
          });

          // optional movement log
          await addDoc(collection(db, "inventory_movements"), {
            clientId: activeClientId,
            itemId: invItemId,
            itemName: it.itemName || "",
            itemCode: it.itemCode || "",
            qty: num(it.qty),
            direction: "IN",
            reason: "SALE_CANCEL",
            refType: "sales_invoice",
            refId: inv.id,
            invoiceNo: inv.invoiceNo || "",
            createdAt: serverTimestamp(),
            createdAtMs: Date.now(),
          });
        })
      );

      // 4) Create reversal transaction (so reports reduce revenue)
      // You can keep it as "expense" (positive) since your reports treat expense separately.
      await addDoc(collection(db, "transactions"), {
        clientId: activeClientId,
        dateMs: inv.saleAtMs || Date.now(),
        dateAt: serverTimestamp(),

        type: "expense",
        category: "Sales Cancelled",

        paymentMode: inv.paymentMode || "",
        orderType: inv.orderType || "",

        refType: "sales_invoice_cancel",
        refId: inv.id,
        invoiceNo: inv.invoiceNo,

        customerId: inv.customerId || null,
        customerName: inv.customerName || "",

        amount: num(inv.grandTotal || 0),

        createdAt: serverTimestamp(),
      });

      alert("✅ Invoice cancelled successfully.");
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
            Customer + Variants + Barcode Scan + Tax + Print (A4 / Thermal)
          </p>
        </div>

        <div className="flex gap-2 flex-wrap">
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
                          {inv.saleAtMs
                            ? new Date(num(inv.saleAtMs)).toLocaleDateString()
                            : "-"}
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
        <div className="mt-6 grid grid-cols-1 xl:grid-cols-12 gap-4">
          {/* LEFT */}
          <div className="xl:col-span-7 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            {/* Invoice meta */}
            <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Sale Date</label>
                <input
                  type="date"
                  value={saleDate}
                  onChange={(e) => setSaleDate(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                />
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
                  <option value="CASH">Cash</option>
                  <option value="BANK">Bank</option>
                  <option value="CREDIT">Credit</option>
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

            {/* Barcode */}
            <div className="mt-4 border-t border-slate-800 pt-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h3 className="text-slate-100 font-semibold">Barcode Scan</h3>
                <div className="text-xs text-slate-400">Scan → Enter (auto add / qty++)</div>
              </div>

              <div className="mt-2">
                <input
                  ref={barcodeRef}
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleBarcodeSubmit();
                    }
                  }}
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="Scan barcode here..."
                />
              </div>
            </div>

            {/* Add item manually */}
            <div className="mt-6 border-t border-slate-800 pt-4">
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
                        setSearch(it.itemName || "");
                        setSelectedVariantId("default");
                        setQty("1");
                        setMrp("");
                        setDrp("");
                        setTimeout(() => taxPctRef.current?.focus?.(), 0);
                      }
                    }
                  }}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="Type item name..."
                />

                {filteredItems.length > 0 ? (
                  <div className="mt-2 max-h-64 overflow-auto rounded-xl border border-slate-800">
                    {filteredItems.map((it) => (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => {
                          setSelectedItemId(it.id);
                          setSearch(it.itemName || "");
                          setSelectedVariantId("default");
                          setQty("1");
                          setMrp("");
                          setDrp("");
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
                          Stock: {money(it.currentStock)} {it.unit} • SP: {money(it.sellingPrice)}
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
                <div className="md:col-span-4">
                  <label className="text-sm text-slate-300">Variant</label>
                  <select
                    value={selectedVariantId}
                    onChange={(e) => {
                      setSelectedVariantId(e.target.value);
                      setMrp("");
                      setDrp("");
                    }}
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    disabled={!selectedItem}
                  >
                    {availableVariants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} • MRP {money(v.mrp)} • DRP {money(v.drp)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="md:col-span-2">
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

                <div className="md:col-span-2">
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
                        mrpRef.current?.focus?.();
                      }
                    }}
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="text-sm text-slate-300">MRP</label>
                  <input
                    ref={mrpRef}
                    type="number"
                    inputMode="decimal"
                    value={mrp}
                    onChange={(e) => setMrp(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        drpRef.current?.focus?.();
                      }
                    }}
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    placeholder="Auto from variant"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="text-sm text-slate-300">DRP</label>
                  <input
                    ref={drpRef}
                    type="number"
                    inputMode="decimal"
                    value={drp}
                    onChange={(e) => setDrp(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addBtnRef.current?.click?.();
                      }
                    }}
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    placeholder="Auto from variant"
                  />
                </div>

                <div className="md:col-span-12 lg:col-span-2">
                  <label className="text-sm text-slate-300">Total</label>
                  <input
                    readOnly
                    value={money(
                      calcLineTotal(
                        qty || 0,
                        drp === ""
                          ? availableVariants.find((v) => v.id === selectedVariantId)?.drp ?? 0
                          : drp,
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
                      setSelectedVariantId("default");
                      setQty("1");
                      setMrp("");
                      setDrp("");
                      setTimeout(() => barcodeRef.current?.focus?.(), 0);
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
                No items added. Scan barcode or add from item search.
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
                      <th className="p-2 text-right">MRP</th>
                      <th className="p-2 text-right">DRP</th>
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
                          <div className="text-slate-100 font-medium">
                            {row.itemName}{" "}
                            <span className="text-xs text-slate-400">
                              ({row.variantName})
                            </span>
                          </div>
                        </td>

                        <td className="p-2">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={row.qty}
                            onChange={(e) => updateLine(row.lineId, { qty: e.target.value })}
                            className="w-20 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100"
                          />
                        </td>

                        <td className="p-2">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={row.mrp}
                            onChange={(e) => updateLine(row.lineId, { mrp: e.target.value })}
                            className="w-24 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100"
                          />
                        </td>

                        <td className="p-2">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={row.drp}
                            onChange={(e) => updateLine(row.lineId, { drp: e.target.value })}
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
                        <td className="p-2" colSpan={6}>
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
                <span>Sub Total (MRP)</span>
                <span className="text-slate-100 font-medium">{money(totals.subTotal)}</span>
              </div>
              <div className="flex justify-between text-slate-300">
                <span>Discount (MRP - DRP)</span>
                <span className="text-slate-100 font-medium">{money(totals.discountTotal)}</span>
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
                  {saving ? "Saving..." : "Finish Order"}
                </button>

                <button
                  type="button"
                  onClick={() => finishAndBilling({ doPrint: true })}
                  disabled={saving || cart.length === 0}
                  className="rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 font-semibold disabled:opacity-60"
                >
                  {saving ? "Saving..." : `Billing + Print (${printMode})`}
                </button>
              </div>

              <div className="text-xs text-slate-500">
                Saved to <b>sales_invoices</b> + subcollection <b>items</b> + <b>transactions</b>.
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
