// src/pages/Inventory.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
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
import { generateInventoryPDF } from "../utils/inventoryPdf";

function num(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function money(v) {
  return num(v).toFixed(2);
}
function fmtTS(ts, fallbackMs) {
  try {
    if (ts?.toDate) return ts.toDate().toLocaleString();
    if (fallbackMs) return new Date(fallbackMs).toLocaleString();
    return "-";
  } catch {
    return "-";
  }
}
function todayYYYYMMDD() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
// Use midday to avoid timezone shifting the date
function dateStrToMsMidday(dateStr) {
  if (!dateStr) return Date.now();
  const d = new Date(`${dateStr}T12:00:00`);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}
function dateStrToDateMidday(dateStr) {
  if (!dateStr) return new Date();
  const d = new Date(`${dateStr}T12:00:00`);
  return isNaN(d.getTime()) ? new Date() : d;
}
function makeItemCode(items) {
  // ITM-000123 based on current list size (simple and works offline)
  const next = (Array.isArray(items) ? items.length : 0) + 1;
  return `ITM-${String(next).padStart(6, "0")}`;
}
function makeBarcode(items) {
  // Unique inside current loaded items (no Firestore index needed)
  const used = new Set();
  (items || []).forEach((it) => {
    if (it.barcode) used.add(String(it.barcode));
    const vs = Array.isArray(it.variants) ? it.variants : [];
    vs.forEach((v) => v?.barcode && used.add(String(v.barcode)));
  });

  let b = "";
  for (let i = 0; i < 50; i++) {
    b =
      String(Date.now()) +
      String(Math.floor(Math.random() * 1000)).padStart(3, "0");
    if (!used.has(b)) return b;
  }
  return String(Date.now());
}
function makeVariantId() {
  return `v-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ✅ Purchase cart helpers
function makePurchaseLineId() {
  return `pl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function clampPct(x) {
  const v = num(x);
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}
function calcLineTotals(line) {
  const qty = num(line.qty);
  const rate = num(line.rate);
  const amountBeforeDiscount = qty * rate;

  const discountType = line.discountType || "PCT"; // PCT | AMT
  const discountValue = num(line.discountValue);

  let discountAmount = 0;
  if (discountType === "AMT") {
    discountAmount = discountValue;
  } else {
    discountAmount = (amountBeforeDiscount * clampPct(discountValue)) / 100;
  }
  if (discountAmount < 0) discountAmount = 0;
  if (discountAmount > amountBeforeDiscount) discountAmount = amountBeforeDiscount;

  const taxableAmount = amountBeforeDiscount - discountAmount;

  const taxPct = clampPct(line.taxPct);
  const taxAmount = (taxableAmount * taxPct) / 100;

  const lineTotal = taxableAmount + taxAmount;

  return {
    qty,
    rate,
    amountBeforeDiscount,
    discountType,
    discountValue,
    discountAmount,
    taxableAmount,
    taxPct,
    taxAmount,
    lineTotal,
  };
}

export default function Inventory() {
  const { activeClientId, activeClientData } = useClient();

  // Tabs
  const [tab, setTab] = useState("list"); // list | purchase | entry | audit | history

  // Core data
  const [items, setItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // =========================
  // ✅ Inventory Movement Intelligence (FAST / DEAD)
  // =========================
  const FAST_WINDOW_DAYS = 30;
  const FAST_THRESHOLD = 5;
  const DEAD_DAYS = 60;

  // movementMap: { [itemId]: { fastCount, lastMs } }
  const [movementMap, setMovementMap] = useState({});
  const [loadingMovementMap, setLoadingMovementMap] = useState(false);

  // =========================
  // Add/Edit Item Modal
  // =========================
  const [showAdd, setShowAdd] = useState(false);
  const [savingItem, setSavingItem] = useState(false);
  const [editingItem, setEditingItem] = useState(null); // {id,...} | null

  const [addForm, setAddForm] = useState({
    itemName: "",
    itemCode: "",
    barcode: "",
    category: "Commodity",
    productGroup: "General",
    unit: "pcs",
    avgCostPrice: "",
    sellingPrice: "",
    mrp: "",
    drp: "",
    reorderLevel: "",
    variants: [], // [{id,name,mrp,drp,barcode,code}]
  });

  // =========================
  // Movements Modal
  // =========================
  const [showMovements, setShowMovements] = useState(false);
  const [movementItem, setMovementItem] = useState(null);
  const [movements, setMovements] = useState([]);
  const [loadingMovements, setLoadingMovements] = useState(false);

  // =========================
  // ✅ Purchase Cart Module
  // =========================
  const [purchaseDate, setPurchaseDate] = useState(todayYYYYMMDD());
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState("");
  const [purchaseMode, setPurchaseMode] = useState("cash"); // cash | bank | credit
  const [purchaseNote, setPurchaseNote] = useState("");
  const [savingPurchase, setSavingPurchase] = useState(false);
  const [purchaseMsg, setPurchaseMsg] = useState("");

  // Vendor selection from Parties
  const [vendorId, setVendorId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorPartyType, setVendorPartyType] = useState("Supplier"); // Supplier/Both
  const [vendorQuery, setVendorQuery] = useState("");
  const [vendorOpen, setVendorOpen] = useState(false);
  const vendorRef = useRef(null);

  // Cart lines
  const [purchaseLines, setPurchaseLines] = useState(() => [
    {
      id: makePurchaseLineId(),
      search: "",
      itemId: "",
      itemName: "",
      unit: "",
      qty: "",
      rate: "",
      sellingPrice: "",
      discountType: "PCT", // PCT | AMT
      discountValue: "",
      taxPct: "",
      note: "",
    },
  ]);

  // =========================
  // Stock Entry (Manual IN/OUT/ADJUST)
  // =========================
  const [entrySearch, setEntrySearch] = useState("");
  const [entryItemId, setEntryItemId] = useState("");
  const [entryType, setEntryType] = useState("IN"); // IN | OUT | ADJUST
  const [entryQty, setEntryQty] = useState("");
  const [entryRate, setEntryRate] = useState("");
  const [entryNote, setEntryNote] = useState("");
  const [savingEntry, setSavingEntry] = useState(false);
  const [entryMsg, setEntryMsg] = useState("");

  // =========================
  // Audit
  // =========================
  const [auditSearch, setAuditSearch] = useState("");
  const [auditItemId, setAuditItemId] = useState("");
  const [physicalCount, setPhysicalCount] = useState("");
  const [savingAudit, setSavingAudit] = useState(false);
  const [auditMsg, setAuditMsg] = useState("");

  // =========================
  // Purchase History
  // =========================
  const [purchaseHistory, setPurchaseHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [historyVendorId, setHistoryVendorId] = useState("");

  // =========================
  // Load Inventory Items (Realtime)
  // =========================
  useEffect(() => {
    setErr("");
    setPurchaseMsg("");
    setEntryMsg("");
    setAuditMsg("");

    if (!activeClientId) {
      setItems([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const qy = query(
      collection(db, "inventory"),
      where("clientId", "==", activeClientId),
      orderBy("itemName", "asc")
    );

    const unsub = onSnapshot(
      qy,
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      (e) => {
        console.error("❌ Inventory load error:", e);
        setErr(e?.message || "Failed to load inventory.");
        setLoading(false);
      }
    );

    return () => unsub();
  }, [activeClientId]);

  // =========================
  // ✅ Load Movement Map (for FAST/DEAD badges) - NO INDEX NEEDED
  // =========================
  useEffect(() => {
    async function loadMovementMap() {
      if (!activeClientId) {
        setMovementMap({});
        return;
      }

      setLoadingMovementMap(true);
      try {
        const now = Date.now();
        const deadFromMs = now - DEAD_DAYS * 24 * 60 * 60 * 1000;
        const fastFromMs = now - FAST_WINDOW_DAYS * 24 * 60 * 60 * 1000;

        const qy = query(
          collection(db, "inventory_movements"),
          where("clientId", "==", activeClientId),
          limit(5000)
        );

        const snap = await getDocs(qy);

        const map = {};
        snap.docs.forEach((d) => {
          const row = d.data() || {};
          const itemId = row.itemId;
          if (!itemId) return;

          const ms =
            num(row.dateMs) ||
            (row.date?.toDate ? row.date.toDate().getTime() : 0);
          if (!ms) return;

          if (!map[itemId]) map[itemId] = { fastCount: 0, lastMs: ms };

          if (ms >= deadFromMs && ms > num(map[itemId].lastMs)) {
            map[itemId].lastMs = ms;
          }
          if (ms >= fastFromMs) {
            map[itemId].fastCount += 1;
          }
        });

        setMovementMap(map);
      } catch (e) {
        console.error("❌ Movement map load error:", e);
        setMovementMap({});
      } finally {
        setLoadingMovementMap(false);
      }
    }

    loadMovementMap();
  }, [activeClientId, FAST_WINDOW_DAYS, DEAD_DAYS]);

  // =========================
  // Load Vendors from Parties (Supplier/Both)
  // =========================
  useEffect(() => {
    async function fetchVendors() {
      if (!activeClientId) {
        setVendors([]);
        return;
      }
      try {
        const ref = collection(db, "parties");
        const qy = query(
          ref,
          where("clientId", "==", activeClientId),
          orderBy("name", "asc")
        );
        const snap = await getDocs(qy);
        const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const onlyVendors = all.filter(
          (p) => p.type === "Supplier" || p.type === "Both"
        );
        setVendors(onlyVendors);
      } catch (e) {
        console.error("❌ Vendor fetch error:", e);
        setVendors([]);
      }
    }
    fetchVendors();
  }, [activeClientId]);

  // Close vendor dropdown
  useEffect(() => {
    function onDocClick(e) {
      if (!vendorRef.current) return;
      if (!vendorRef.current.contains(e.target)) setVendorOpen(false);
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setVendorOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // =========================
  // Movements Realtime
  // =========================
  useEffect(() => {
    if (!activeClientId || !showMovements || !movementItem?.id) {
      setMovements([]);
      return;
    }

    setLoadingMovements(true);

    const qy = query(
      collection(db, "inventory_movements"),
      where("clientId", "==", activeClientId),
      where("itemId", "==", movementItem.id),
      limit(100)
    );

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => num(b.dateMs) - num(a.dateMs));
        setMovements(list);
        setLoadingMovements(false);
      },
      (e) => {
        console.error("❌ Movements load error:", e);
        setLoadingMovements(false);
      }
    );

    return () => unsub();
  }, [activeClientId, showMovements, movementItem?.id]);

  // =========================
  // Purchase History Realtime (tab only)
  // =========================
  useEffect(() => {
    if (!activeClientId) {
      setPurchaseHistory([]);
      return;
    }
    if (tab !== "history") return;

    setLoadingHistory(true);

    const qy = query(
      collection(db, "inventory_purchases"),
      where("clientId", "==", activeClientId),
      limit(200)
    );

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        list.sort((a, b) => num(b.purchaseDateMs) - num(a.purchaseDateMs));
        setPurchaseHistory(list);
        setLoadingHistory(false);
      },
      (e) => {
        console.error("❌ Purchase history load error:", e);
        setLoadingHistory(false);
      }
    );

    return () => unsub();
  }, [activeClientId, tab]);

  // =========================
  // Computed
  // =========================
  const stats = useMemo(() => {
    const totalValue = items.reduce(
      (a, it) => a + num(it.currentStock) * num(it.avgCostPrice),
      0
    );
    const lowCount = items.filter(
      (it) => num(it.currentStock) < num(it.reorderLevel)
    ).length;
    return { totalValue, lowCount };
  }, [items]);

  const movementCounters = useMemo(() => {
    const now = Date.now();
    const deadCutoff = now - DEAD_DAYS * 24 * 60 * 60 * 1000;

    let fastCount = 0;
    let deadCount = 0;

    items.forEach((it) => {
      const m = movementMap[it.id];
      const count = num(m?.fastCount);
      const lastMs = num(m?.lastMs);

      const isFast = count >= FAST_THRESHOLD;
      const isDead = !lastMs || lastMs <= deadCutoff;

      if (isFast) fastCount += 1;
      if (isDead) deadCount += 1;
    });

    return { fastCount, deadCount };
  }, [items, movementMap, DEAD_DAYS, FAST_THRESHOLD]);

  const vendorsFiltered = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendors.slice(0, 10);
    return vendors
      .filter((v) => (v.name || "").toLowerCase().includes(q))
      .slice(0, 10);
  }, [vendors, vendorQuery]);

  const historyFiltered = useMemo(() => {
    let base = purchaseHistory;
    if (historyVendorId) base = base.filter((p) => p.vendorId === historyVendorId);

    const q = historySearch.trim().toLowerCase();
    if (!q) return base;

    return base.filter((p) => {
      const s = `${p.supplierInvoiceNo || ""} ${p.vendorName || ""} ${p.note || ""}`.toLowerCase();
      return s.includes(q);
    });
  }, [purchaseHistory, historySearch, historyVendorId]);

  const purchaseTotals = useMemo(() => {
    const rows = (purchaseLines || []).map((ln) => ({
      ...ln,
      _calc: calcLineTotals(ln),
    }));

    const subtotal = rows.reduce((s, r) => s + num(r._calc.amountBeforeDiscount), 0);
    const totalDiscount = rows.reduce((s, r) => s + num(r._calc.discountAmount), 0);
    const totalTax = rows.reduce((s, r) => s + num(r._calc.taxAmount), 0);
    const grandTotal = rows.reduce((s, r) => s + num(r._calc.lineTotal), 0);

    return { rows, subtotal, totalDiscount, totalTax, grandTotal };
  }, [purchaseLines]);

  // =========================
  // Modal helpers
  // =========================
  function openAddModal() {
    setEditingItem(null);

    setAddForm({
      itemName: "",
      itemCode: makeItemCode(items),
      barcode: "",
      category: "Commodity",
      productGroup: "General",
      unit: "pcs",

      avgCostPrice: "",
      sellingPrice: "",
      mrp: "",
      drp: "",

      reorderLevel: "",
      variants: [],
    });

    setShowAdd(true);
  }

  function openEditModal(it) {
    setEditingItem(it);

    setAddForm({
      itemName: it.itemName || "",
      itemCode: it.itemCode || it.code || "",
      barcode: it.barcode || "",
      category: it.category || "Commodity",
      productGroup: it.productGroup || "General",
      unit: it.unit || "pcs",

      avgCostPrice: it.avgCostPrice ?? "",
      sellingPrice: it.sellingPrice ?? "",

      mrp: it.mrp ?? it.sellingPrice ?? "",
      drp: it.drp ?? it.sellingPrice ?? "",

      reorderLevel: it.reorderLevel ?? "",
      variants: Array.isArray(it.variants) ? it.variants : [],
    });

    setShowAdd(true);
  }

  async function addOrUpdateItem(e) {
    e.preventDefault();
    setErr("");

    if (!activeClientId) return setErr("Please select a client.");
    const name = (addForm.itemName || "").trim();
    if (!name) return setErr("Item Name is required.");

    setSavingItem(true);
    try {
      if (editingItem?.id) {
        await updateDoc(doc(db, "inventory", editingItem.id), {
          itemName: name,
          itemCode: (addForm.itemCode || "").trim(),
          barcode: (addForm.barcode || "").trim(),
          category: addForm.category || "Commodity",
          productGroup: addForm.productGroup || "General",
          unit: (addForm.unit || "pcs").trim(),

          avgCostPrice: num(addForm.avgCostPrice),
          sellingPrice: num(addForm.sellingPrice),

          mrp: addForm.mrp === "" ? null : num(addForm.mrp),
          drp: addForm.drp === "" ? null : num(addForm.drp),

          reorderLevel: num(addForm.reorderLevel),
          variants: Array.isArray(addForm.variants) ? addForm.variants : [],
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, "inventory"), {
          clientId: activeClientId,

          itemName: name,
          itemCode: (addForm.itemCode || "").trim() || makeItemCode(items),
          barcode: (addForm.barcode || "").trim(),
          category: addForm.category || "Commodity",
          productGroup: addForm.productGroup || "General",
          unit: (addForm.unit || "pcs").trim(),

          currentStock: 0,

          avgCostPrice: num(addForm.avgCostPrice),
          sellingPrice: num(addForm.sellingPrice),

          mrp: addForm.mrp === "" ? null : num(addForm.mrp),
          drp: addForm.drp === "" ? null : num(addForm.drp),

          reorderLevel: num(addForm.reorderLevel),
          variants: Array.isArray(addForm.variants) ? addForm.variants : [],

          lastAuditDate: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }

      setShowAdd(false);
      setEditingItem(null);
    } catch (e2) {
      console.error(e2);
      setErr(e2?.message || "Failed to save item.");
    } finally {
      setSavingItem(false);
    }
  }

  // ✅ Delete locked if stock != 0
  async function safeDeleteItem(it) {
    const stock = num(it.currentStock);
    if (stock !== 0) {
      alert(
        `Delete locked ❌\n\nItem: ${it.itemName}\nStock is not zero (${stock} ${it.unit || ""}).\n\nAdjust stock to 0 first.`
      );
      return;
    }
    if (!window.confirm(`Delete "${it.itemName}"?`)) return;

    try {
      await deleteDoc(doc(db, "inventory", it.id));
    } catch (e) {
      console.error(e);
      alert(e?.message || "Delete failed.");
    }
  }

  // =========================
  // ✅ Purchase cart line helpers
  // =========================
  function addPurchaseLine() {
    setPurchaseLines((s) => [
      ...(Array.isArray(s) ? s : []),
      {
        id: makePurchaseLineId(),
        search: "",
        itemId: "",
        itemName: "",
        unit: "",
        qty: "",
        rate: "",
        sellingPrice: "",
        discountType: "PCT",
        discountValue: "",
        taxPct: "",
        note: "",
      },
    ]);
  }
  function removePurchaseLine(id) {
    setPurchaseLines((s) => (s || []).filter((x) => x.id !== id));
  }
  function setLine(id, patch) {
    setPurchaseLines((s) =>
      (s || []).map((x) => (x.id === id ? { ...x, ...patch } : x))
    );
  }
  function resetPurchaseFormKeepDate() {
    setSupplierInvoiceNo("");
    setPurchaseMode("cash");
    setPurchaseNote("");
    setVendorId("");
    setVendorName("");
    setVendorPartyType("Supplier");
    setVendorQuery("");
    setVendorOpen(false);
    setPurchaseLines([
      {
        id: makePurchaseLineId(),
        search: "",
        itemId: "",
        itemName: "",
        unit: "",
        qty: "",
        rate: "",
        sellingPrice: "",
        discountType: "PCT",
        discountValue: "",
        taxPct: "",
        note: "",
      },
    ]);
  }

  // =========================
  // ✅ Save Purchase Cart:
  // - updates stock & avg cost for each line
  // - writes purchase header with lines
  // - writes movements per line
  // - writes ONE transaction into "transactions" (type: purchase, amountOut: grandTotal)
  // =========================
  async function savePurchaseCart(e) {
    e.preventDefault();
    setErr("");
    setPurchaseMsg("");

    if (!activeClientId) return;
    if (!vendorId) return setPurchaseMsg("Please select a supplier/vendor.");
    if (!supplierInvoiceNo.trim())
      return setPurchaseMsg("Supplier Invoice Number is required.");

    const validLines = (purchaseLines || [])
      .map((ln) => ({ ...ln, _calc: calcLineTotals(ln) }))
      .filter((ln) => ln.itemId && num(ln._calc.qty) > 0 && num(ln._calc.rate) > 0);

    if (validLines.length === 0) {
      return setPurchaseMsg("Add at least 1 line item (item + qty + rate).");
    }

    // totals
    const subtotal = validLines.reduce((s, r) => s + num(r._calc.amountBeforeDiscount), 0);
    const totalDiscount = validLines.reduce((s, r) => s + num(r._calc.discountAmount), 0);
    const totalTax = validLines.reduce((s, r) => s + num(r._calc.taxAmount), 0);
    const grandTotal = validLines.reduce((s, r) => s + num(r._calc.lineTotal), 0);

    if (grandTotal <= 0) return setPurchaseMsg("Grand total must be > 0.");

    const chosenMs = dateStrToMsMidday(purchaseDate);
    const chosenDateObj = dateStrToDateMidday(purchaseDate);

    setSavingPurchase(true);
    try {
      const purchaseRef = doc(collection(db, "inventory_purchases"));
      const txnRef = doc(collection(db, "transactions"));

      await runTransaction(db, async (tx) => {
        // 1) Update each inventory item
        for (const ln of validLines) {
          const itemRef = doc(db, "inventory", ln.itemId);
          const snap = await tx.get(itemRef);
          if (!snap.exists()) throw new Error(`Item not found: ${ln.itemName || ln.itemId}`);

          const it = snap.data();
          const systemStock = num(it.currentStock);
          const qty = num(ln._calc.qty);
          const rate = num(ln._calc.rate);

          const newStock = systemStock + qty;

          // weighted avg cost update
          const oldAvg = num(it.avgCostPrice);
          const newAvg =
            newStock > 0 ? (systemStock * oldAvg + qty * rate) / newStock : rate;

          const payload = {
            currentStock: newStock,
            avgCostPrice: Number(newAvg.toFixed(4)),
            updatedAt: serverTimestamp(),
          };

          // optional selling price update
          const sp = ln.sellingPrice === "" ? null : num(ln.sellingPrice);
          if (sp !== null && Number.isFinite(sp) && sp >= 0) payload.sellingPrice = sp;

          tx.update(itemRef, payload);

          // 2) Movement record (per line)
          const mvRef = doc(collection(db, "inventory_movements"));
          tx.set(mvRef, {
            clientId: activeClientId,
            itemId: ln.itemId,
            itemName: it.itemName || ln.itemName || "",
            type: "IN",
            qty,
            rate,
            amount: num(ln._calc.amountBeforeDiscount),

            discountType: ln._calc.discountType,
            discountValue: num(ln._calc.discountValue),
            discountAmount: num(ln._calc.discountAmount),
            taxableAmount: num(ln._calc.taxableAmount),
            taxPct: num(ln._calc.taxPct),
            taxAmount: num(ln._calc.taxAmount),
            totalAmount: num(ln._calc.lineTotal),

            vendorId,
            vendorName: vendorName || "",
            supplierInvoiceNo: supplierInvoiceNo.trim(),
            purchaseId: purchaseRef.id,

            note: ln.note || purchaseNote || "",

            dateMs: chosenMs,
            date: chosenDateObj, // ✅ important for range queries if you ever use it
            createdAt: serverTimestamp(),
          });
        }

        // 3) Purchase header doc (one)
        tx.set(purchaseRef, {
          clientId: activeClientId,
          vendorId,
          vendorName: vendorName || "",
          supplierInvoiceNo: supplierInvoiceNo.trim(),
          mode: purchaseMode,

          purchaseDateMs: chosenMs,
          purchaseDate: chosenDateObj,

          subtotal: Number(subtotal.toFixed(2)),
          totalDiscount: Number(totalDiscount.toFixed(2)),
          totalTax: Number(totalTax.toFixed(2)),
          grandTotal: Number(grandTotal.toFixed(2)),

          note: purchaseNote || "",

          lines: validLines.map((ln) => ({
            itemId: ln.itemId,
            itemName: ln.itemName || "",
            unit: ln.unit || "",
            qty: num(ln._calc.qty),
            rate: num(ln._calc.rate),

            amountBeforeDiscount: Number(ln._calc.amountBeforeDiscount.toFixed(2)),
            discountType: ln._calc.discountType,
            discountValue: num(ln._calc.discountValue),
            discountAmount: Number(ln._calc.discountAmount.toFixed(2)),
            taxableAmount: Number(ln._calc.taxableAmount.toFixed(2)),
            taxPct: num(ln._calc.taxPct),
            taxAmount: Number(ln._calc.taxAmount.toFixed(2)),
            lineTotal: Number(ln._calc.lineTotal.toFixed(2)),

            sellingPrice:
              ln.sellingPrice === "" ? null : Number(num(ln.sellingPrice).toFixed(2)),
            note: ln.note || "",
          })),

          createdAtMs: Date.now(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // 4) Transactions entry (one)
        // Your Transactions.jsx expects fields: clientId, date, type, mode, partyName, partyType, description, amountIn, amountOut
        tx.set(txnRef, {
          clientId: activeClientId,
          date: chosenDateObj, // ✅ this is what your Transactions page filters on
          dateMs: chosenMs,

          type: "purchase",
          mode: purchaseMode,

          partyName: vendorName || "",
          partyType: vendorPartyType || "Supplier",

          description: `Inventory Purchase • Inv: ${supplierInvoiceNo.trim()}${purchaseNote ? ` • ${purchaseNote}` : ""}`,
          category: "Inventory Purchase",

          amountIn: 0,
          amountOut: Number(grandTotal.toFixed(2)),

          linkedPurchaseId: purchaseRef.id,

          createdAt: serverTimestamp(),
        });
      });

      setPurchaseMsg("✅ Purchase saved. Stock updated. Transaction added.");
      resetPurchaseFormKeepDate();
    } catch (e2) {
      console.error(e2);
      setErr(e2?.message || "Failed to save purchase.");
    } finally {
      setSavingPurchase(false);
    }
  }

  // =========================
  // Stock Entry Save
  // =========================
  async function saveStockEntry(e) {
    e.preventDefault();
    setErr("");
    setEntryMsg("");

    if (!activeClientId) return;
    if (!entryItemId) return setEntryMsg("Please select an item.");

    const qty = num(entryQty);
    if (!qty || qty <= 0) return setEntryMsg("Quantity must be > 0.");

    const rate = num(entryRate);
    const amount = rate > 0 ? qty * rate : 0;

    setSavingEntry(true);
    try {
      const itemRef = doc(db, "inventory", entryItemId);

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(itemRef);
        if (!snap.exists()) throw new Error("Item not found.");

        const it = snap.data();
        const current = num(it.currentStock);

        let newStock = current;
        if (entryType === "IN") newStock = current + qty;
        if (entryType === "OUT") newStock = current - qty;
        if (entryType === "ADJUST") newStock = current + qty;

        tx.update(itemRef, { currentStock: newStock, updatedAt: serverTimestamp() });

        const mvRef = doc(collection(db, "inventory_movements"));
        tx.set(mvRef, {
          clientId: activeClientId,
          itemId: entryItemId,
          itemName: it.itemName || "",
          type: entryType,
          qty,
          rate,
          amount,
          note: entryNote || "",
          dateMs: Date.now(),
          date: new Date(),
          createdAt: serverTimestamp(),
        });
      });

      setEntryMsg("✅ Stock updated and movement saved.");
      setEntrySearch("");
      setEntryItemId("");
      setEntryQty("");
      setEntryRate("");
      setEntryNote("");
      setEntryType("IN");
    } catch (e2) {
      console.error(e2);
      setErr(e2?.message || "Failed to save stock entry.");
    } finally {
      setSavingEntry(false);
    }
  }

  // =========================
  // Audit Save
  // =========================
  async function saveAudit(e) {
    e.preventDefault();
    setErr("");
    setAuditMsg("");

    if (!activeClientId) return;
    if (!auditItemId) return setAuditMsg("Please select an item.");

    const physical = num(physicalCount);
    if (physicalCount === "" || physical < 0) return setAuditMsg("Enter a valid physical count.");

    setSavingAudit(true);
    try {
      const itemRef = doc(db, "inventory", auditItemId);

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(itemRef);
        if (!snap.exists()) throw new Error("Item not found.");

        const it = snap.data();
        const system = num(it.currentStock);
        const variance = physical - system;

        const auditRef = doc(collection(db, "inventory", auditItemId, "stock_audits"));
        tx.set(auditRef, {
          clientId: activeClientId,
          itemId: auditItemId,
          itemName: it.itemName || "",
          systemStock: system,
          physicalStock: physical,
          variance,
          auditedAt: serverTimestamp(),
        });

        tx.update(itemRef, {
          currentStock: physical,
          lastAuditDate: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        const mvRef = doc(collection(db, "inventory_movements"));
        tx.set(mvRef, {
          clientId: activeClientId,
          itemId: auditItemId,
          itemName: it.itemName || "",
          type: "ADJUST",
          qty: variance,
          rate: 0,
          amount: 0,
          note: `Audit adjustment. Physical=${physical}, System=${system}`,
          dateMs: Date.now(),
          date: new Date(),
          createdAt: serverTimestamp(),
        });
      });

      setAuditMsg("✅ Audit saved. Stock updated.");
      setAuditSearch("");
      setAuditItemId("");
      setPhysicalCount("");
    } catch (e2) {
      console.error(e2);
      setErr(e2?.message || "Failed to save audit.");
    } finally {
      setSavingAudit(false);
    }
  }

  // =========================
  // UI Guard
  // =========================
  if (!activeClientId) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-slate-100">Inventory</h1>
        <p className="text-slate-400 mt-2">Please select a client/shop first.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">
            Inventory Management
          </h1>
          <p className="text-slate-400 mt-1">
            Separate module (not linked with Transactions except Purchase posting).
          </p>

          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <span className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-slate-200">
              Total Stock Value: <b>{money(stats.totalValue)}</b>
            </span>
            <span className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-slate-200">
              Low Stock Alerts: <b>{stats.lowCount}</b>
            </span>

            <span className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-slate-200">
              Fast Moving ({FAST_WINDOW_DAYS}d):{" "}
              <b>{loadingMovementMap ? "…" : movementCounters.fastCount}</b>
            </span>
            <span className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-slate-200">
              Dead Stock ({DEAD_DAYS}d):{" "}
              <b>{loadingMovementMap ? "…" : movementCounters.deadCount}</b>
            </span>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          {[
            ["list", "Stock List"],
            ["purchase", "Purchase"],
            ["entry", "Stock Entry"],
            ["audit", "Stock Audit"],
            ["history", "Purchase History"],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-4 py-2 rounded-lg text-sm border ${
                tab === k
                  ? "bg-slate-100 text-slate-900 border-slate-200"
                  : "bg-slate-950/40 text-slate-200 border-slate-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {err ? (
        <div className="mt-4 rounded-lg border border-red-800 bg-red-950/40 text-red-200 px-3 py-2 text-sm">
          {err}
        </div>
      ) : null}

      {/* ================= STOCK LIST ================= */}
      {tab === "list" ? (
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-slate-100 font-semibold">Stock List</h2>

            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() =>
                  generateInventoryPDF({
                    clientName: activeClientData?.name || activeClientId,
                    items,
                  })
                }
                className="rounded-lg border border-slate-700 text-slate-200 px-4 py-2 hover:bg-slate-900/50"
              >
                Download Inventory PDF
              </button>

              <button
                onClick={openAddModal}
                className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-medium"
              >
                + Add Item
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/40">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/50 border-b border-slate-800">
                <tr className="text-left text-slate-200">
                  <th className="p-3">Item</th>
                  <th className="p-3">Code</th>
                  <th className="p-3">Barcode</th>
                  <th className="p-3">Category</th>
                  <th className="p-3">Group</th>
                  <th className="p-3">Current Stock</th>
                  <th className="p-3">Avg Cost</th>
                  <th className="p-3">Total Value</th>
                  <th className="p-3">Reorder</th>
                  <th className="p-3">Actions</th>
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td className="p-4 text-slate-400" colSpan={10}>
                      Loading…
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td className="p-4 text-slate-400" colSpan={10}>
                      No items yet. Click “Add Item”.
                    </td>
                  </tr>
                ) : (
                  items.map((it) => {
                    const low = num(it.currentStock) < num(it.reorderLevel);
                    const total = num(it.currentStock) * num(it.avgCostPrice);
                    const stockNonZero = num(it.currentStock) !== 0;

                    return (
                      <tr
                        key={it.id}
                        className={`border-b border-slate-900 ${
                          low ? "bg-red-950/25" : ""
                        }`}
                      >
                        <td className="p-3 text-slate-100 font-medium">
                          {it.itemName}
                          <div className="text-xs text-slate-500 mt-1">
                            Variants:{" "}
                            {Array.isArray(it.variants) ? it.variants.length : 0}
                          </div>
                        </td>

                        <td className="p-3 text-slate-300">{it.itemCode || "-"}</td>
                        <td className="p-3 text-slate-300">{it.barcode || "-"}</td>
                        <td className="p-3 text-slate-300">{it.category || "-"}</td>
                        <td className="p-3 text-slate-300">{it.productGroup || "General"}</td>

                        <td className="p-3 text-slate-200">
                          {money(it.currentStock)}{" "}
                          <span className="text-slate-500">{it.unit}</span>
                        </td>
                        <td className="p-3 text-slate-200">{money(it.avgCostPrice)}</td>
                        <td className="p-3 text-slate-200">{money(total)}</td>
                        <td className="p-3 text-slate-300">
                          {money(it.reorderLevel)}{" "}
                          <span className="text-slate-500">{it.unit}</span>
                        </td>

                        <td className="p-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => openEditModal(it)}
                              className="px-3 py-1 rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-900/50"
                            >
                              Edit
                            </button>

                            <button
                              type="button"
                              onClick={() => {
                                setMovementItem(it);
                                setShowMovements(true);
                              }}
                              className="px-3 py-1 rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-900/50"
                            >
                              Movements
                            </button>

                            <button
                              type="button"
                              onClick={() => safeDeleteItem(it)}
                              disabled={stockNonZero}
                              title={
                                stockNonZero
                                  ? "Delete disabled because stock is not 0. Adjust stock to 0 first."
                                  : "Delete item"
                              }
                              className={`px-3 py-1 rounded-lg border ${
                                stockNonZero
                                  ? "border-slate-800 text-slate-500 cursor-not-allowed"
                                  : "border-red-800 text-red-200 hover:bg-red-950/30"
                              }`}
                            >
                              Delete
                            </button>
                          </div>

                          {stockNonZero ? (
                            <div className="mt-1 text-xs text-slate-500">
                              Delete locked (stock ≠ 0)
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Add/Edit Modal */}
          {showAdd ? (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
                <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                  <h3 className="text-slate-100 font-semibold">
                    {editingItem ? "Edit Inventory Item" : "Add Inventory Item"}
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      setShowAdd(false);
                      setEditingItem(null);
                    }}
                    className="text-slate-300 hover:text-white"
                    disabled={savingItem}
                  >
                    ✕
                  </button>
                </div>

                <form
                  onSubmit={addOrUpdateItem}
                  className="p-4 grid grid-cols-1 md:grid-cols-12 gap-3"
                >
                  <div className="md:col-span-12">
                    <label className="text-sm text-slate-300">Item Name</label>
                    <input
                      value={addForm.itemName}
                      onChange={(e) =>
                        setAddForm((s) => ({ ...s, itemName: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                      placeholder='e.g. "Tomato", "Red Bull"'
                      required
                    />
                  </div>

                  <div className="md:col-span-6">
                    <label className="text-sm text-slate-300">Item Code</label>
                    <input
                      value={addForm.itemCode}
                      onChange={(e) =>
                        setAddForm((s) => ({ ...s, itemCode: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                      placeholder="ITM-000001"
                    />
                  </div>

                  <div className="md:col-span-6">
                    <label className="text-sm text-slate-300">Barcode (Default)</label>
                    <div className="mt-1 flex gap-2">
                      <input
                        value={addForm.barcode}
                        onChange={(e) =>
                          setAddForm((s) => ({ ...s, barcode: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.preventDefault();
                        }}
                        className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                        placeholder="Scan or enter barcode..."
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setAddForm((s) => ({ ...s, barcode: makeBarcode(items) }))
                        }
                        className="shrink-0 rounded-lg border border-slate-700 text-slate-200 px-3 py-2 hover:bg-slate-900/50"
                        title="Generate unique barcode"
                      >
                        Generate
                      </button>
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      If item has no barcode, use Generate.
                    </div>
                  </div>

                  <div className="md:col-span-6">
                    <label className="text-sm text-slate-300">Category</label>
                    <select
                      value={addForm.category}
                      onChange={(e) =>
                        setAddForm((s) => ({ ...s, category: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    >
                      <option>Commodity</option>
                      <option>Asset</option>
                    </select>
                  </div>

                  <div className="md:col-span-6">
                    <label className="text-sm text-slate-300">Product Group (Printing)</label>
                    <select
                      value={addForm.productGroup}
                      onChange={(e) =>
                        setAddForm((s) => ({ ...s, productGroup: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    >
                      <option>General</option>
                      <option>Kitchen</option>
                      <option>Juice Counter</option>
                      <option>Warehouse</option>
                      <option>Bakery</option>
                    </select>
                    <div className="text-xs text-slate-500 mt-1">
                      Later we’ll use this to print separate KOT slips.
                    </div>
                  </div>

                  <div className="md:col-span-6">
                    <label className="text-sm text-slate-300">Unit</label>
                    <input
                      value={addForm.unit}
                      onChange={(e) =>
                        setAddForm((s) => ({ ...s, unit: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                      placeholder="kg / pcs / box"
                    />
                  </div>

                  <div className="md:col-span-4">
                    <label className="text-sm text-slate-300">Avg Cost Price</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={addForm.avgCostPrice}
                      onChange={(e) =>
                        setAddForm((s) => ({ ...s, avgCostPrice: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    />
                  </div>

                  <div className="md:col-span-4">
                    <label className="text-sm text-slate-300">Selling Price</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={addForm.sellingPrice}
                      onChange={(e) =>
                        setAddForm((s) => ({ ...s, sellingPrice: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    />
                  </div>

                  <div className="md:col-span-4">
                    <label className="text-sm text-slate-300">Reorder Level</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={addForm.reorderLevel}
                      onChange={(e) =>
                        setAddForm((s) => ({ ...s, reorderLevel: e.target.value }))
                      }
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    />
                  </div>

                  <div className="md:col-span-12">
                    <div className="flex items-center justify-between">
                      <label className="text-sm text-slate-300">Variants (Optional)</label>
                      <button
                        type="button"
                        onClick={() =>
                          setAddForm((s) => ({
                            ...s,
                            variants: [
                              ...(Array.isArray(s.variants) ? s.variants : []),
                              {
                                id: makeVariantId(),
                                name: "Variant",
                                mrp: "",
                                drp: "",
                                barcode: "",
                                code: "",
                              },
                            ],
                          }))
                        }
                        className="rounded-lg border border-slate-700 text-slate-200 px-3 py-1.5 hover:bg-slate-900/50 text-sm"
                      >
                        + Add Variant
                      </button>
                    </div>

                    {Array.isArray(addForm.variants) && addForm.variants.length > 0 ? (
                      <div className="mt-2 overflow-x-auto rounded-xl border border-slate-800">
                        <table className="min-w-full text-sm">
                          <thead className="bg-slate-900/50 border-b border-slate-800">
                            <tr className="text-left text-slate-200">
                              <th className="p-2">Name</th>
                              <th className="p-2 text-right">MRP</th>
                              <th className="p-2 text-right">DRP</th>
                              <th className="p-2">Barcode</th>
                              <th className="p-2">Code</th>
                              <th className="p-2"></th>
                            </tr>
                          </thead>

                          <tbody>
                            {addForm.variants.map((v, idx) => (
                              <tr key={v.id} className="border-b border-slate-900">
                                <td className="p-2">
                                  <input
                                    value={v.name || ""}
                                    onChange={(e) =>
                                      setAddForm((s) => {
                                        const next = [...(s.variants || [])];
                                        next[idx] = { ...next[idx], name: e.target.value };
                                        return { ...s, variants: next };
                                      })
                                    }
                                    className="w-48 rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100"
                                    placeholder="Small / Large"
                                  />
                                </td>

                                <td className="p-2">
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    value={v.mrp ?? ""}
                                    onChange={(e) =>
                                      setAddForm((s) => {
                                        const next = [...(s.variants || [])];
                                        next[idx] = { ...next[idx], mrp: e.target.value };
                                        return { ...s, variants: next };
                                      })
                                    }
                                    className="w-24 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100"
                                  />
                                </td>

                                <td className="p-2">
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    value={v.drp ?? ""}
                                    onChange={(e) =>
                                      setAddForm((s) => {
                                        const next = [...(s.variants || [])];
                                        next[idx] = { ...next[idx], drp: e.target.value };
                                        return { ...s, variants: next };
                                      })
                                    }
                                    className="w-24 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100"
                                  />
                                </td>

                                <td className="p-2">
                                  <div className="flex gap-2">
                                    <input
                                      value={v.barcode || ""}
                                      onChange={(e) =>
                                        setAddForm((s) => {
                                          const next = [...(s.variants || [])];
                                          next[idx] = { ...next[idx], barcode: e.target.value };
                                          return { ...s, variants: next };
                                        })
                                      }
                                      className="w-52 rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100"
                                      placeholder="Scan barcode..."
                                    />
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setAddForm((s) => {
                                          const next = [...(s.variants || [])];
                                          next[idx] = { ...next[idx], barcode: makeBarcode(items) };
                                          return { ...s, variants: next };
                                        })
                                      }
                                      className="rounded-lg border border-slate-700 text-slate-200 px-2 py-1 hover:bg-slate-900/50"
                                    >
                                      Gen
                                    </button>
                                  </div>
                                </td>

                                <td className="p-2">
                                  <input
                                    value={v.code || ""}
                                    onChange={(e) =>
                                      setAddForm((s) => {
                                        const next = [...(s.variants || [])];
                                        next[idx] = { ...next[idx], code: e.target.value };
                                        return { ...s, variants: next };
                                      })
                                    }
                                    className="w-36 rounded-lg bg-slate-900 border border-slate-700 px-2 py-1 text-slate-100"
                                    placeholder="Optional"
                                  />
                                </td>

                                <td className="p-2">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setAddForm((s) => ({
                                        ...s,
                                        variants: (s.variants || []).filter((x) => x.id !== v.id),
                                      }))
                                    }
                                    className="rounded-lg border border-red-800 text-red-200 px-2 py-1 hover:bg-red-950/30"
                                  >
                                    Remove
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-slate-500">
                        If no variants, Sales will use default price + barcode.
                      </div>
                    )}
                  </div>

                  <div className="md:col-span-12 flex justify-end gap-2 mt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setShowAdd(false);
                        setEditingItem(null);
                      }}
                      disabled={savingItem}
                      className="rounded-lg border border-slate-700 text-slate-200 px-4 py-2"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={savingItem}
                      className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-medium disabled:opacity-60"
                    >
                      {savingItem ? "Saving…" : editingItem ? "Update" : "Save Item"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          ) : null}

          {/* Movements Modal */}
          {showMovements ? (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-5xl rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
                <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                  <div>
                    <h3 className="text-slate-100 font-semibold">Item Movements</h3>
                    <div className="text-xs text-slate-400">
                      {movementItem?.itemName || "-"} • Last 100 entries
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setShowMovements(false);
                      setMovementItem(null);
                      setMovements([]);
                    }}
                    className="text-slate-300 hover:text-white"
                  >
                    ✕
                  </button>
                </div>

                <div className="p-4">
                  {loadingMovements ? (
                    <div className="text-slate-400">Loading movements…</div>
                  ) : movements.length === 0 ? (
                    <div className="text-slate-400">No movements found for this item.</div>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-800">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-900/50 border-b border-slate-800">
                          <tr className="text-left text-slate-200">
                            <th className="p-3">Date</th>
                            <th className="p-3">Type</th>
                            <th className="p-3">Qty</th>
                            <th className="p-3">Rate</th>
                            <th className="p-3">Amount</th>
                            <th className="p-3">Disc</th>
                            <th className="p-3">Tax%</th>
                            <th className="p-3">Tax</th>
                            <th className="p-3">Total</th>
                            <th className="p-3">Vendor</th>
                            <th className="p-3">Invoice</th>
                            <th className="p-3">Note</th>
                          </tr>
                        </thead>
                        <tbody>
                          {movements.map((m) => (
                            <tr key={m.id} className="border-b border-slate-900">
                              <td className="p-3 text-slate-300">{fmtTS(m.date, m.dateMs)}</td>
                              <td className="p-3 text-slate-200 font-medium">{m.type}</td>
                              <td className="p-3 text-slate-200">{money(m.qty)}</td>
                              <td className="p-3 text-slate-200">{money(m.rate)}</td>
                              <td className="p-3 text-slate-200">{money(m.amount)}</td>
                              <td className="p-3 text-slate-200">{money(m.discountAmount)}</td>
                              <td className="p-3 text-slate-200">{money(m.taxPct)}</td>
                              <td className="p-3 text-slate-200">{money(m.taxAmount)}</td>
                              <td className="p-3 text-slate-200">{money(m.totalAmount)}</td>
                              <td className="p-3 text-slate-300">{m.vendorName || "-"}</td>
                              <td className="p-3 text-slate-300">{m.supplierInvoiceNo || "-"}</td>
                              <td className="p-3 text-slate-300">{m.note || "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="mt-4 flex justify-end">
                    <button
                      className="rounded-lg border border-slate-700 text-slate-200 px-4 py-2 hover:bg-slate-900/50"
                      onClick={() => {
                        setShowMovements(false);
                        setMovementItem(null);
                        setMovements([]);
                      }}
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ================= PURCHASE (CART) ================= */}
      {tab === "purchase" ? (
        <div className="mt-6">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-slate-100 font-semibold">Purchase Cart</h2>
              <p className="text-slate-400 text-sm mt-1">
                Multi-item purchase → stock update per line → one transaction entry.
              </p>
            </div>

            {/* ✅ FIX: Add New Item button works here */}
            <button
              type="button"
              onClick={openAddModal}
              className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-medium"
            >
              + Add New Item
            </button>
          </div>

          {purchaseMsg ? (
            <div className="mt-4 rounded-lg border border-green-800 bg-green-950/30 text-green-200 px-3 py-2 text-sm">
              {purchaseMsg}
            </div>
          ) : null}

          <form
            onSubmit={savePurchaseCart}
            className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 p-4"
          >
            {/* Header fields */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-3">
                <label className="text-sm text-slate-300">Purchase Date</label>
                <input
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  required
                />
              </div>

              <div className="md:col-span-3">
                <label className="text-sm text-slate-300">Mode</label>
                <select
                  value={purchaseMode}
                  onChange={(e) => setPurchaseMode(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                >
                  <option value="cash">Cash</option>
                  <option value="bank">Bank</option>
                  <option value="credit">Credit</option>
                </select>
                <div className="text-xs text-slate-500 mt-1">
                  Credit purchase will appear as payable logic in reports.
                </div>
              </div>

              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Supplier Invoice Number</label>
                <input
                  value={supplierInvoiceNo}
                  onChange={(e) => setSupplierInvoiceNo(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="Eg: INV-234 / Bill No..."
                  required
                />
              </div>

              {/* Vendor dropdown */}
              <div className="md:col-span-6" ref={vendorRef}>
                <label className="text-sm text-slate-300">Supplier (Party)</label>
                <div className="relative mt-1">
                  <input
                    value={vendorQuery}
                    onChange={(e) => {
                      setVendorQuery(e.target.value);
                      setVendorOpen(true);
                      setVendorId("");
                      setVendorName("");
                      setVendorPartyType("Supplier");
                    }}
                    onFocus={() => setVendorOpen(true)}
                    placeholder="Search supplier..."
                    className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  />

                  {vendorOpen ? (
                    <div className="absolute z-20 mt-2 w-full rounded-xl border border-slate-800 bg-slate-950 shadow-xl max-h-60 overflow-auto">
                      {vendorsFiltered.length === 0 ? (
                        <div className="px-3 py-3 text-sm text-slate-400">
                          No suppliers found. Add from Parties page.
                        </div>
                      ) : (
                        vendorsFiltered.map((v) => (
                          <button
                            type="button"
                            key={v.id}
                            onClick={() => {
                              setVendorId(v.id);
                              setVendorName(v.name || "");
                              setVendorPartyType(v.type || "Supplier");
                              setVendorQuery(v.name || "");
                              setVendorOpen(false);
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-slate-900/60 border-b border-slate-900 last:border-b-0"
                          >
                            <div className="text-slate-100 text-sm font-medium">{v.name}</div>
                            <div className="text-slate-400 text-xs">{v.type}</div>
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>

                {vendorId ? (
                  <div className="mt-1 text-xs text-slate-400">
                    Selected: <span className="text-slate-200">{vendorName}</span>
                  </div>
                ) : null}
              </div>

              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Note (optional)</label>
                <input
                  value={purchaseNote}
                  onChange={(e) => setPurchaseNote(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="Remarks..."
                />
              </div>
            </div>

            {/* Lines */}
            <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-900/50 border-b border-slate-800">
                  <tr className="text-left text-slate-200">
                    <th className="p-3 w-[320px]">Item</th>
                    <th className="p-3">Unit</th>
                    <th className="p-3 text-right">Qty</th>
                    <th className="p-3 text-right">Rate</th>
                    <th className="p-3 text-right">Amount</th>
                    <th className="p-3">Disc</th>
                    <th className="p-3 text-right">Disc Amt</th>
                    <th className="p-3 text-right">Tax%</th>
                    <th className="p-3 text-right">Tax</th>
                    <th className="p-3 text-right">Line Total</th>
                    <th className="p-3">SP (opt)</th>
                    <th className="p-3"></th>
                  </tr>
                </thead>

                <tbody>
                  {purchaseTotals.rows.map((ln) => {
                    const calc = ln._calc;
                    const q = (ln.search || "").trim().toLowerCase();
                    const suggestions =
                      q.length === 0
                        ? []
                        : items
                            .filter((it) =>
                              (it.itemName || "").toLowerCase().includes(q)
                            )
                            .slice(0, 5);

                    return (
                      <tr key={ln.id} className="border-b border-slate-900 align-top">
                        <td className="p-3">
                          <input
                            value={ln.search}
                            onChange={(e) =>
                              setLine(ln.id, {
                                search: e.target.value,
                                itemId: "",
                                itemName: "",
                                unit: "",
                              })
                            }
                            className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                            placeholder="Type item name..."
                          />

                          {suggestions.length > 0 && !ln.itemId ? (
                            <div className="mt-2 rounded-xl border border-slate-800 overflow-hidden">
                              {suggestions.map((it) => (
                                <button
                                  type="button"
                                  key={it.id}
                                  onClick={() =>
                                    setLine(ln.id, {
                                      itemId: it.id,
                                      itemName: it.itemName || "",
                                      unit: it.unit || "",
                                      search: it.itemName || "",
                                      // auto fill rate = avgCostPrice if empty
                                      rate: ln.rate === "" ? String(it.avgCostPrice ?? "") : ln.rate,
                                      sellingPrice:
                                        ln.sellingPrice === ""
                                          ? String(it.sellingPrice ?? "")
                                          : ln.sellingPrice,
                                    })
                                  }
                                  className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/40"
                                >
                                  <div className="flex items-center justify-between">
                                    <div className="text-slate-100 font-medium text-sm">
                                      {it.itemName}
                                    </div>
                                    <div className="text-slate-400 text-xs">
                                      Stock: {money(it.currentStock)} {it.unit}
                                    </div>
                                  </div>
                                  <div className="text-slate-500 text-xs">
                                    Avg Cost: {money(it.avgCostPrice)} • SP: {money(it.sellingPrice)}
                                  </div>
                                </button>
                              ))}
                            </div>
                          ) : null}

                          {ln.itemId ? (
                            <div className="mt-1 text-xs text-slate-400">
                              Selected: <span className="text-slate-200">{ln.itemName}</span>
                            </div>
                          ) : (
                            <div className="mt-1 text-xs text-slate-500">
                              Tip: type name and pick from list.
                            </div>
                          )}
                        </td>

                        <td className="p-3 text-slate-300">{ln.unit || "-"}</td>

                        <td className="p-3">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={ln.qty}
                            onChange={(e) => setLine(ln.id, { qty: e.target.value })}
                            className="w-24 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-2 text-slate-100"
                            placeholder="0"
                          />
                        </td>

                        <td className="p-3">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={ln.rate}
                            onChange={(e) => setLine(ln.id, { rate: e.target.value })}
                            className="w-28 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-2 text-slate-100"
                            placeholder="0.00"
                          />
                        </td>

                        <td className="p-3 text-right text-slate-200">
                          {money(calc.amountBeforeDiscount)}
                        </td>

                        <td className="p-3">
                          <div className="flex gap-2">
                            <select
                              value={ln.discountType}
                              onChange={(e) => setLine(ln.id, { discountType: e.target.value })}
                              className="rounded-lg bg-slate-900 border border-slate-700 px-2 py-2 text-slate-100"
                            >
                              <option value="PCT">%</option>
                              <option value="AMT">₹</option>
                            </select>
                            <input
                              type="number"
                              inputMode="decimal"
                              value={ln.discountValue}
                              onChange={(e) => setLine(ln.id, { discountValue: e.target.value })}
                              className="w-20 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-2 text-slate-100"
                              placeholder="0"
                            />
                          </div>
                        </td>

                        <td className="p-3 text-right text-slate-200">
                          {money(calc.discountAmount)}
                        </td>

                        <td className="p-3">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={ln.taxPct}
                            onChange={(e) => setLine(ln.id, { taxPct: e.target.value })}
                            className="w-20 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-2 text-slate-100"
                            placeholder="0"
                          />
                        </td>

                        <td className="p-3 text-right text-slate-200">
                          {money(calc.taxAmount)}
                        </td>

                        <td className="p-3 text-right text-slate-100 font-semibold">
                          {money(calc.lineTotal)}
                        </td>

                        <td className="p-3">
                          <input
                            type="number"
                            inputMode="decimal"
                            value={ln.sellingPrice}
                            onChange={(e) => setLine(ln.id, { sellingPrice: e.target.value })}
                            className="w-24 text-right rounded-lg bg-slate-900 border border-slate-700 px-2 py-2 text-slate-100"
                            placeholder="0.00"
                          />
                        </td>

                        <td className="p-3">
                          <button
                            type="button"
                            onClick={() => removePurchaseLine(ln.id)}
                            disabled={purchaseLines.length <= 1}
                            className={`rounded-lg border px-3 py-2 text-xs ${
                              purchaseLines.length <= 1
                                ? "border-slate-800 text-slate-500 cursor-not-allowed"
                                : "border-red-800 text-red-200 hover:bg-red-950/30"
                            }`}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>

                <tfoot className="bg-slate-950/60 border-t border-slate-800">
                  <tr>
                    <td className="p-3" colSpan={12}>
                      <div className="flex items-center justify-between flex-wrap gap-3">
                        <button
                          type="button"
                          onClick={addPurchaseLine}
                          className="rounded-lg border border-slate-700 text-slate-200 px-4 py-2 hover:bg-slate-900/50"
                        >
                          + Add Line
                        </button>

                        <div className="flex gap-4 flex-wrap text-sm">
                          <div className="text-slate-300">
                            Subtotal:{" "}
                            <span className="text-slate-100 font-semibold">
                              {money(purchaseTotals.subtotal)}
                            </span>
                          </div>
                          <div className="text-slate-300">
                            Discount:{" "}
                            <span className="text-slate-100 font-semibold">
                              {money(purchaseTotals.totalDiscount)}
                            </span>
                          </div>
                          <div className="text-slate-300">
                            Tax:{" "}
                            <span className="text-slate-100 font-semibold">
                              {money(purchaseTotals.totalTax)}
                            </span>
                          </div>
                          <div className="text-slate-200">
                            Grand Total:{" "}
                            <span className="text-white font-bold text-base">
                              {money(purchaseTotals.grandTotal)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={resetPurchaseFormKeepDate}
                className="rounded-lg border border-slate-700 text-slate-200 px-4 py-2 hover:bg-slate-900/50"
              >
                Clear
              </button>
              <button
                type="submit"
                disabled={savingPurchase}
                className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-medium disabled:opacity-60"
              >
                {savingPurchase ? "Saving..." : "Save Purchase"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* ================= STOCK ENTRY ================= */}
      {tab === "entry" ? (
        <div className="mt-6 max-w-3xl">
          <h2 className="text-slate-100 font-semibold">Stock Entry</h2>
          <p className="text-slate-400 text-sm mt-1">IN / OUT / ADJUST (manual movements).</p>

          {entryMsg ? (
            <div className="mt-4 rounded-lg border border-green-800 bg-green-950/30 text-green-200 px-3 py-2 text-sm">
              {entryMsg}
            </div>
          ) : null}

          <form onSubmit={saveStockEntry} className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <label className="text-sm text-slate-300">Search Item</label>
            <input
              value={entrySearch}
              onChange={(e) => {
                setEntrySearch(e.target.value);
                setEntryItemId("");
              }}
              placeholder="Type item name..."
              className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
            />

            {(() => {
              const q = entrySearch.trim().toLowerCase();
              const list =
                !q ? [] : items.filter((it) => (it.itemName || "").toLowerCase().includes(q)).slice(0, 10);

              return list.length > 0 ? (
                <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-slate-800">
                  {list.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => {
                        setEntryItemId(it.id);
                        setEntrySearch(it.itemName || "");
                      }}
                      className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/40"
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-slate-100 font-medium text-sm">{it.itemName}</div>
                        <div className="text-slate-400 text-xs">
                          Stock: {money(it.currentStock)} {it.unit}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : null;
            })()}

            <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Entry Type</label>
                <select
                  value={entryType}
                  onChange={(e) => setEntryType(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                >
                  <option value="IN">IN (Add Stock)</option>
                  <option value="OUT">OUT (Reduce Stock)</option>
                  <option value="ADJUST">ADJUST (+/-)</option>
                </select>
              </div>

              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Quantity</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={entryQty}
                  onChange={(e) => setEntryQty(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="0"
                  required
                />
                <div className="text-xs text-slate-500 mt-1">
                  For ADJUST: you can enter negative qty if needed.
                </div>
              </div>

              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Rate (optional)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={entryRate}
                  onChange={(e) => setEntryRate(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="0.00"
                />
              </div>

              <div className="md:col-span-12">
                <label className="text-sm text-slate-300">Note</label>
                <input
                  value={entryNote}
                  onChange={(e) => setEntryNote(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="e.g. wastage / kitchen use..."
                />
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={savingEntry}
                className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-medium disabled:opacity-60"
              >
                {savingEntry ? "Saving..." : "Save Stock Entry"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* ================= STOCK AUDIT ================= */}
      {tab === "audit" ? (
        <div className="mt-6 max-w-2xl">
          <h2 className="text-slate-100 font-semibold">Stock Audit</h2>
          <p className="text-slate-400 text-sm mt-1">
            Physical count → variance saved → stock updated.
          </p>

          {auditMsg ? (
            <div className="mt-4 rounded-lg border border-green-800 bg-green-950/30 text-green-200 px-3 py-2 text-sm">
              {auditMsg}
            </div>
          ) : null}

          <form onSubmit={saveAudit} className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <label className="text-sm text-slate-300">Search Item</label>
            <input
              value={auditSearch}
              onChange={(e) => {
                setAuditSearch(e.target.value);
                setAuditItemId("");
              }}
              className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
              placeholder="Type item name..."
            />

            {(() => {
              const q = auditSearch.trim().toLowerCase();
              const list =
                !q ? [] : items.filter((it) => (it.itemName || "").toLowerCase().includes(q)).slice(0, 10);

              return list.length > 0 ? (
                <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-slate-800">
                  {list.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => {
                        setAuditItemId(it.id);
                        setAuditSearch(it.itemName || "");
                      }}
                      className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/40"
                    >
                      <div className="flex items-center justify-between">
                        <div className="text-slate-100 font-medium text-sm">{it.itemName}</div>
                        <div className="text-slate-400 text-xs">
                          System: {money(it.currentStock)} {it.unit}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : null;
            })()}

            <div className="mt-3">
              <label className="text-sm text-slate-300">Physical Count</label>
              <input
                type="number"
                inputMode="decimal"
                value={physicalCount}
                onChange={(e) => setPhysicalCount(e.target.value)}
                className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                placeholder="Enter physical stock..."
                required
              />
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={savingAudit}
                className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-medium disabled:opacity-60"
              >
                {savingAudit ? "Saving..." : "Save Audit"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* ================= PURCHASE HISTORY ================= */}
      {tab === "history" ? (
        <div className="mt-6">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-slate-100 font-semibold">Purchase History</h2>
              <p className="text-slate-400 text-sm mt-1">
                From Firestore: <span className="text-slate-200">inventory_purchases</span>
              </p>
            </div>

            <div className="flex gap-2 flex-wrap">
              <select
                value={historyVendorId}
                onChange={(e) => setHistoryVendorId(e.target.value)}
                className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 text-sm"
              >
                <option value="">All Suppliers</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>

              <input
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Search invoice / supplier / note..."
                className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 text-sm w-72"
              />
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/40">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/50 border-b border-slate-800">
                <tr className="text-left text-slate-200">
                  <th className="p-3">Date</th>
                  <th className="p-3">Invoice</th>
                  <th className="p-3">Supplier</th>
                  <th className="p-3">Mode</th>
                  <th className="p-3 text-right">Subtotal</th>
                  <th className="p-3 text-right">Discount</th>
                  <th className="p-3 text-right">Tax</th>
                  <th className="p-3 text-right">Grand Total</th>
                  <th className="p-3">Note</th>
                </tr>
              </thead>

              <tbody>
                {loadingHistory ? (
                  <tr>
                    <td className="p-4 text-slate-400" colSpan={9}>
                      Loading...
                    </td>
                  </tr>
                ) : historyFiltered.length === 0 ? (
                  <tr>
                    <td className="p-4 text-slate-400" colSpan={9}>
                      No purchases found.
                    </td>
                  </tr>
                ) : (
                  historyFiltered.map((p) => (
                    <tr key={p.id} className="border-b border-slate-900">
                      <td className="p-3 text-slate-300">{fmtTS(p.purchaseDate, p.purchaseDateMs)}</td>
                      <td className="p-3 text-slate-100 font-medium">{p.supplierInvoiceNo || "-"}</td>
                      <td className="p-3 text-slate-300">{p.vendorName || "-"}</td>
                      <td className="p-3 text-slate-300">{p.mode || "-"}</td>
                      <td className="p-3 text-right text-slate-200">{money(p.subtotal)}</td>
                      <td className="p-3 text-right text-slate-200">{money(p.totalDiscount)}</td>
                      <td className="p-3 text-right text-slate-200">{money(p.totalTax)}</td>
                      <td className="p-3 text-right text-white font-semibold">{money(p.grandTotal)}</td>
                      <td className="p-3 text-slate-300">{p.note || "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Optional: show lines for last purchase could be next enhancement */}
        </div>
      ) : null}
    </div>
  );
}
