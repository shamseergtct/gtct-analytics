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
  const FAST_WINDOW_DAYS = 30; // count movements inside this window
  const FAST_THRESHOLD = 5; // movements in window to be FAST
  const DEAD_DAYS = 60; // no movement since this many days -> DEAD

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
    category: "Commodity",
    unit: "pcs",
    avgCostPrice: "",
    sellingPrice: "",
    reorderLevel: "",
  });

  // =========================
  // Movements Modal
  // =========================
  const [showMovements, setShowMovements] = useState(false);
  const [movementItem, setMovementItem] = useState(null);
  const [movements, setMovements] = useState([]);
  const [loadingMovements, setLoadingMovements] = useState(false);

  // =========================
  // Purchase Module
  // =========================
  const [purchaseDate, setPurchaseDate] = useState(todayYYYYMMDD()); // ✅ Date picker
  const [purchaseSearch, setPurchaseSearch] = useState("");
  const [purchaseItemId, setPurchaseItemId] = useState("");
  const [purchaseCurrentStock, setPurchaseCurrentStock] = useState(""); // optional manual base stock
  const [purchaseQty, setPurchaseQty] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [purchaseSellingPrice, setPurchaseSellingPrice] = useState("");
  const [purchaseNote, setPurchaseNote] = useState("");
  const [savingPurchase, setSavingPurchase] = useState(false);
  const [purchaseMsg, setPurchaseMsg] = useState("");

  // Vendor selection from Parties
  const [vendorId, setVendorId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorQuery, setVendorQuery] = useState("");
  const [vendorOpen, setVendorOpen] = useState(false);
  const vendorRef = useRef(null);

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
  // FAST/DEAD based on inventory_movements activity
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

        // ✅ Avoid orderBy + range filter to skip composite index issues
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

          const ms = num(row.dateMs) || (row.date?.toDate ? row.date.toDate().getTime() : 0);
          if (!ms) return;

          if (!map[itemId]) map[itemId] = { fastCount: 0, lastMs: ms };

          // ✅ last movement inside DEAD window
          if (ms >= deadFromMs && ms > num(map[itemId].lastMs)) {
            map[itemId].lastMs = ms;
          }

          // ✅ fast movements only inside FAST window
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
        const qy = query(ref, where("clientId", "==", activeClientId), orderBy("name", "asc"));
        const snap = await getDocs(qy);
        const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        const onlyVendors = all.filter((p) => p.type === "Supplier" || p.type === "Both");
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

    // ✅ No orderBy => avoids composite index requirement
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
        list.sort((a, b) => num(b.purchasedAtMs) - num(a.purchasedAtMs));
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
    const totalValue = items.reduce((a, it) => a + num(it.currentStock) * num(it.avgCostPrice), 0);
    const lowCount = items.filter((it) => num(it.currentStock) < num(it.reorderLevel)).length;
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

  // ✅ Purchase search shows max 5 only (no full listing)
  const filteredForPurchase = useMemo(() => {
    const q = purchaseSearch.trim().toLowerCase();
    if (!q) return [];
    return items.filter((it) => (it.itemName || "").toLowerCase().includes(q)).slice(0, 5);
  }, [items, purchaseSearch]);

  const filteredForEntry = useMemo(() => {
    const q = entrySearch.trim().toLowerCase();
    if (!q) return [];
    return items.filter((it) => (it.itemName || "").toLowerCase().includes(q)).slice(0, 10);
  }, [items, entrySearch]);

  const filteredForAudit = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    if (!q) return [];
    return items.filter((it) => (it.itemName || "").toLowerCase().includes(q)).slice(0, 10);
  }, [items, auditSearch]);

  const vendorsFiltered = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendors.slice(0, 10);
    return vendors.filter((v) => (v.name || "").toLowerCase().includes(q)).slice(0, 10);
  }, [vendors, vendorQuery]);

  const selectedPurchaseItem = useMemo(
    () => items.find((x) => x.id === purchaseItemId) || null,
    [items, purchaseItemId]
  );

  const historyFiltered = useMemo(() => {
    let base = purchaseHistory;
    if (historyVendorId) base = base.filter((p) => p.vendorId === historyVendorId);

    const q = historySearch.trim().toLowerCase();
    if (!q) return base;

    return base.filter((p) => {
      const s = `${p.itemName || ""} ${p.vendorName || ""} ${p.note || ""}`.toLowerCase();
      return s.includes(q);
    });
  }, [purchaseHistory, historySearch, historyVendorId]);

  // =========================
  // Modal helpers
  // =========================
  function openAddModal() {
    setEditingItem(null);
    setAddForm({
      itemName: "",
      category: "Commodity",
      unit: "pcs",
      avgCostPrice: "",
      sellingPrice: "",
      reorderLevel: "",
    });
    setShowAdd(true);
  }

  function openEditModal(it) {
    setEditingItem(it);
    setAddForm({
      itemName: it.itemName || "",
      category: it.category || "Commodity",
      unit: it.unit || "pcs",
      avgCostPrice: it.avgCostPrice ?? "",
      sellingPrice: it.sellingPrice ?? "",
      reorderLevel: it.reorderLevel ?? "",
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
          category: addForm.category || "Commodity",
          unit: (addForm.unit || "pcs").trim(),
          avgCostPrice: num(addForm.avgCostPrice),
          sellingPrice: num(addForm.sellingPrice),
          reorderLevel: num(addForm.reorderLevel),
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, "inventory"), {
          clientId: activeClientId,
          itemName: name,
          category: addForm.category || "Commodity",
          unit: (addForm.unit || "pcs").trim(),
          currentStock: 0,
          avgCostPrice: num(addForm.avgCostPrice),
          sellingPrice: num(addForm.sellingPrice),
          reorderLevel: num(addForm.reorderLevel),
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
  // Purchase Save (with Date Picker)
  // =========================
  async function savePurchase(e) {
    e.preventDefault();
    setErr("");
    setPurchaseMsg("");

    if (!activeClientId) return;
    if (!purchaseItemId) return setPurchaseMsg("Please select an item.");
    if (!vendorId) return setPurchaseMsg("Please select a vendor.");

    const qty = num(purchaseQty);
    const price = num(purchasePrice);
    if (!qty || qty <= 0) return setPurchaseMsg("Quantity must be > 0.");
    if (!price || price <= 0) return setPurchaseMsg("Purchase price must be > 0.");

    const manualStockProvided = purchaseCurrentStock !== "";
    const manualStock = num(purchaseCurrentStock);
    if (manualStockProvided && manualStock < 0) return setPurchaseMsg("Current stock must be 0 or more.");

    const sp = purchaseSellingPrice === "" ? null : num(purchaseSellingPrice);
    const amount = qty * price;

    const chosenMs = dateStrToMsMidday(purchaseDate); // ✅ uses selected date

    setSavingPurchase(true);

    try {
      const itemRef = doc(db, "inventory", purchaseItemId);

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(itemRef);
        if (!snap.exists()) throw new Error("Item not found.");

        const it = snap.data();
        const systemStock = num(it.currentStock);
        const baseStock = manualStockProvided ? manualStock : systemStock;

        const newStock = baseStock + qty;

        // avg cost update
        const oldAvg = num(it.avgCostPrice);
        const newAvg = newStock > 0 ? (baseStock * oldAvg + qty * price) / newStock : price;

        const updatePayload = {
          currentStock: newStock,
          avgCostPrice: Number(newAvg.toFixed(4)),
          updatedAt: serverTimestamp(),
        };
        if (sp !== null && Number.isFinite(sp) && sp >= 0) updatePayload.sellingPrice = sp;

        tx.update(itemRef, updatePayload);

        // ✅ Purchase record
        const purchaseRef = doc(collection(db, "inventory_purchases"));
        tx.set(purchaseRef, {
          clientId: activeClientId,
          itemId: purchaseItemId,
          itemName: it.itemName || "",
          category: it.category || "",
          unit: it.unit || "",

          vendorId,
          vendorName: vendorName || "",

          qty,
          purchasePrice: price,
          sellingPrice: sp ?? null,
          amount,
          note: purchaseNote || "",

          systemStockAtTime: systemStock,
          baseStockUsed: baseStock,
          manualStockEntered: manualStockProvided ? manualStock : null,
          newStockAfterPurchase: newStock,

          purchasedAtMs: chosenMs, // ✅ from date picker
          purchasedAt: serverTimestamp(),
          createdAtMs: Date.now(),
          createdAt: serverTimestamp(),
        });

        // ✅ Movement record (this is what badges use now)
        const mvRef = doc(collection(db, "inventory_movements"));
        tx.set(mvRef, {
          clientId: activeClientId,
          itemId: purchaseItemId,
          itemName: it.itemName || "",
          type: "IN",
          qty,
          rate: price,
          amount,

          vendorId,
          vendorName: vendorName || "",
          note: purchaseNote || "",

          dateMs: chosenMs, // ✅ from date picker
          date: serverTimestamp(),
          createdAt: serverTimestamp(),
        });
      });

      setPurchaseMsg("✅ Purchase saved. Stock updated.");

      // reset purchase form (keep date)
      setPurchaseItemId("");
      setPurchaseSearch("");
      setPurchaseCurrentStock("");
      setPurchaseQty("");
      setPurchasePrice("");
      setPurchaseSellingPrice("");
      setPurchaseNote("");

      setVendorId("");
      setVendorName("");
      setVendorQuery("");
      setVendorOpen(false);
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
          date: serverTimestamp(),
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
          date: serverTimestamp(),
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
          <h1 className="text-2xl font-semibold text-slate-100">Inventory Management</h1>
          <p className="text-slate-400 mt-1">
            Separate module (not linked with Transactions). All data saved in Firestore.
          </p>

          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <span className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-slate-200">
              Total Stock Value: <b>{money(stats.totalValue)}</b>
            </span>
            <span className="px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-slate-200">
              Low Stock Alerts: <b>{stats.lowCount}</b>
            </span>

            {/* ✅ Movement-based chips */}
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
                  <th className="p-3">Item Name</th>
                  <th className="p-3">Category</th>
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
                    <td className="p-4 text-slate-400" colSpan={7}>
                      Loading…
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td className="p-4 text-slate-400" colSpan={7}>
                      No items yet. Click “Add Item”.
                    </td>
                  </tr>
                ) : (
                  items.map((it) => {
                    const low = num(it.currentStock) < num(it.reorderLevel);
                    const total = num(it.currentStock) * num(it.avgCostPrice);
                    const stockNonZero = num(it.currentStock) !== 0;

                    const m = movementMap[it.id];
                    const count = num(m?.fastCount);
                    const lastMs = num(m?.lastMs);

                    const now = Date.now();
                    const deadCutoff = now - DEAD_DAYS * 24 * 60 * 60 * 1000;

                    const isFast = count >= FAST_THRESHOLD;
                    const isDead = !lastMs || lastMs <= deadCutoff;

                    return (
                      <tr
                        key={it.id}
                        className={`border-b border-slate-900 ${low ? "bg-red-950/25" : ""}`}
                      >
                        <td className="p-3 text-slate-100 font-medium">
                          {it.itemName}

                          {low ? (
                            <span className="ml-2 text-xs px-2 py-1 rounded-full border border-red-700 bg-red-900/30 text-red-200">
                              LOW
                            </span>
                          ) : null}

                          {isFast ? (
                            <span
                              className="ml-2 text-xs px-2 py-1 rounded-full border border-emerald-700 bg-emerald-900/25 text-emerald-200"
                              title={`FAST MOVING: ${count} movements in last ${FAST_WINDOW_DAYS} days`}
                            >
                              FAST
                            </span>
                          ) : null}

                          {isDead ? (
                            <span
                              className="ml-2 text-xs px-2 py-1 rounded-full border border-slate-700 bg-slate-900/40 text-slate-200"
                              title={
                                lastMs
                                  ? `DEAD STOCK: No movement since ${new Date(lastMs).toLocaleDateString()}`
                                  : "DEAD STOCK: No movements recorded"
                              }
                            >
                              DEAD
                            </span>
                          ) : null}

                          {!isDead && lastMs ? (
                            <span className="ml-2 text-xs text-slate-500">
                              Last move: {new Date(lastMs).toLocaleDateString()}
                            </span>
                          ) : null}
                        </td>
                        <td className="p-3 text-slate-300">{it.category}</td>
                        <td className="p-3 text-slate-200">
                          {money(it.currentStock)} <span className="text-slate-500">{it.unit}</span>
                        </td>
                        <td className="p-3 text-slate-200">{money(it.avgCostPrice)}</td>
                        <td className="p-3 text-slate-200">{money(total)}</td>
                        <td className="p-3 text-slate-300">
                          {money(it.reorderLevel)} <span className="text-slate-500">{it.unit}</span>
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
                            <div className="mt-1 text-xs text-slate-500">Delete locked (stock ≠ 0)</div>
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

                <form onSubmit={addOrUpdateItem} className="p-4 grid grid-cols-1 md:grid-cols-12 gap-3">
                  <div className="md:col-span-12">
                    <label className="text-sm text-slate-300">Item Name</label>
                    <input
                      value={addForm.itemName}
                      onChange={(e) => setAddForm((s) => ({ ...s, itemName: e.target.value }))}
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                      placeholder='e.g. "Tomato", "Red Bull"'
                      required
                    />
                  </div>

                  <div className="md:col-span-6">
                    <label className="text-sm text-slate-300">Category</label>
                    <select
                      value={addForm.category}
                      onChange={(e) => setAddForm((s) => ({ ...s, category: e.target.value }))}
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    >
                      <option>Commodity</option>
                      <option>Asset</option>
                    </select>
                  </div>

                  <div className="md:col-span-6">
                    <label className="text-sm text-slate-300">Unit</label>
                    <input
                      value={addForm.unit}
                      onChange={(e) => setAddForm((s) => ({ ...s, unit: e.target.value }))}
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
                      onChange={(e) => setAddForm((s) => ({ ...s, avgCostPrice: e.target.value }))}
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    />
                  </div>

                  <div className="md:col-span-4">
                    <label className="text-sm text-slate-300">Selling Price</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={addForm.sellingPrice}
                      onChange={(e) => setAddForm((s) => ({ ...s, sellingPrice: e.target.value }))}
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    />
                  </div>

                  <div className="md:col-span-4">
                    <label className="text-sm text-slate-300">Reorder Level</label>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={addForm.reorderLevel}
                      onChange={(e) => setAddForm((s) => ({ ...s, reorderLevel: e.target.value }))}
                      className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                    />
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
              <div className="w-full max-w-4xl rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl">
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
                            <th className="p-3">Vendor</th>
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
                              <td className="p-3 text-slate-300">{m.vendorName || "-"}</td>
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

      {/* ================= PURCHASE ================= */}
      {tab === "purchase" ? (
        <div className="mt-6 max-w-3xl">
          <h2 className="text-slate-100 font-semibold">Purchase Module</h2>
          <p className="text-slate-400 text-sm mt-1">
            Search item (max 5 results), select vendor, choose date, enter current stock (optional), qty & price.
          </p>

          {purchaseMsg ? (
            <div className="mt-4 rounded-lg border border-green-800 bg-green-950/30 text-green-200 px-3 py-2 text-sm">
              {purchaseMsg}
            </div>
          ) : null}

          <form onSubmit={savePurchase} className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              {/* ✅ Date Picker */}
              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Purchase Date</label>
                <input
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  required
                />
              </div>

              {/* Item search */}
              <div className="md:col-span-8">
                <label className="text-sm text-slate-300">Search Item</label>
                <input
                  value={purchaseSearch}
                  onChange={(e) => {
                    setPurchaseSearch(e.target.value);
                    setPurchaseItemId("");
                    setPurchaseCurrentStock("");
                  }}
                  placeholder="Type item name..."
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                />

                {filteredForPurchase.length > 0 ? (
                  <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-slate-800">
                    {filteredForPurchase.map((it) => (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => {
                          setPurchaseItemId(it.id);
                          setPurchaseSearch(it.itemName || "");
                          setPurchaseCurrentStock(String(it.currentStock ?? ""));
                        }}
                        className="w-full text-left px-3 py-2 border-b border-slate-900 hover:bg-slate-900/40"
                      >
                        <div className="flex items-center justify-between">
                          <div className="text-slate-100 font-medium text-sm">{it.itemName}</div>
                          <div className="text-slate-400 text-xs">
                            Stock: {money(it.currentStock)} {it.unit}
                          </div>
                        </div>
                        <div className="text-slate-500 text-xs">
                          {it.category} • Avg Cost: {money(it.avgCostPrice)}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : null}

                {purchaseItemId ? (
                  <div className="mt-1 text-xs text-slate-400">
                    Selected item:{" "}
                    <span className="text-slate-200">{selectedPurchaseItem?.itemName || "-"}</span>
                  </div>
                ) : null}
              </div>

              {/* Vendor dropdown */}
              <div className="md:col-span-6" ref={vendorRef}>
                <label className="text-sm text-slate-300">Vendor Name</label>

                <div className="relative mt-1">
                  <input
                    value={vendorQuery}
                    onChange={(e) => {
                      setVendorQuery(e.target.value);
                      setVendorOpen(true);
                      setVendorId("");
                      setVendorName("");
                    }}
                    onFocus={() => setVendorOpen(true)}
                    placeholder="Search vendor..."
                    className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  />

                  {vendorOpen ? (
                    <div className="absolute z-20 mt-2 w-full rounded-xl border border-slate-800 bg-slate-950 shadow-xl max-h-60 overflow-auto">
                      {vendorsFiltered.length === 0 ? (
                        <div className="px-3 py-3 text-sm text-slate-400">
                          No vendors found. Add from Parties page.
                        </div>
                      ) : (
                        vendorsFiltered.map((v) => (
                          <button
                            type="button"
                            key={v.id}
                            onClick={() => {
                              setVendorId(v.id);
                              setVendorName(v.name || "");
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

              {/* Category + Unit readonly */}
              <div className="md:col-span-3">
                <label className="text-sm text-slate-300">Category</label>
                <input
                  value={selectedPurchaseItem?.category || ""}
                  readOnly
                  className="mt-1 w-full rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2 text-slate-200"
                />
              </div>
              <div className="md:col-span-3">
                <label className="text-sm text-slate-300">Unit</label>
                <input
                  value={selectedPurchaseItem?.unit || ""}
                  readOnly
                  className="mt-1 w-full rounded-lg bg-slate-900/60 border border-slate-800 px-3 py-2 text-slate-200"
                />
              </div>

              {/* Current stock */}
              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Current Stock (before purchase)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={purchaseCurrentStock}
                  onChange={(e) => setPurchaseCurrentStock(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="Optional (eg: 5)"
                />
                <div className="text-xs text-slate-500 mt-1">If entered: final stock = this + purchased qty</div>
              </div>

              {/* Qty */}
              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Purchased Qty</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={purchaseQty}
                  onChange={(e) => setPurchaseQty(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="0"
                  required
                />
              </div>

              {/* Price */}
              <div className="md:col-span-4">
                <label className="text-sm text-slate-300">Purchase Price (per unit)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="0.00"
                  required
                />
              </div>

              {/* Selling price */}
              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Selling Price (optional)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={purchaseSellingPrice}
                  onChange={(e) => setPurchaseSellingPrice(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="0.00"
                />
              </div>

              {/* Note */}
              <div className="md:col-span-6">
                <label className="text-sm text-slate-300">Note (optional)</label>
                <input
                  value={purchaseNote}
                  onChange={(e) => setPurchaseNote(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100"
                  placeholder="Invoice no / remarks..."
                />
              </div>
            </div>

            <div className="mt-4 flex justify-end">
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
          {/* (unchanged UI below — kept from your version) */}
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

            {filteredForEntry.length > 0 ? (
              <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-slate-800">
                {filteredForEntry.map((it) => (
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
            ) : null}

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
          <p className="text-slate-400 text-sm mt-1">Physical count → variance saved → stock updated.</p>

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

            {filteredForAudit.length > 0 ? (
              <div className="mt-2 max-h-56 overflow-auto rounded-xl border border-slate-800">
                {filteredForAudit.map((it) => (
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
            ) : null}

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
                <option value="">All Vendors</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>

              <input
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Search item / vendor / note..."
                className="rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 text-sm w-64"
              />
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/40">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-900/50 border-b border-slate-800">
                <tr className="text-left text-slate-200">
                  <th className="p-3">Date</th>
                  <th className="p-3">Item</th>
                  <th className="p-3">Vendor</th>
                  <th className="p-3">Qty</th>
                  <th className="p-3">Rate</th>
                  <th className="p-3">Amount</th>
                  <th className="p-3">Stock Result</th>
                  <th className="p-3">Note</th>
                </tr>
              </thead>

              <tbody>
                {loadingHistory ? (
                  <tr>
                    <td className="p-4 text-slate-400" colSpan={8}>
                      Loading...
                    </td>
                  </tr>
                ) : historyFiltered.length === 0 ? (
                  <tr>
                    <td className="p-4 text-slate-400" colSpan={8}>
                      No purchases found.
                    </td>
                  </tr>
                ) : (
                  historyFiltered.map((p) => (
                    <tr key={p.id} className="border-b border-slate-900">
                      <td className="p-3 text-slate-300">{fmtTS(p.purchasedAt, p.purchasedAtMs)}</td>
                      <td className="p-3 text-slate-100 font-medium">{p.itemName || "-"}</td>
                      <td className="p-3 text-slate-300">{p.vendorName || "-"}</td>
                      <td className="p-3 text-slate-200">{money(p.qty)}</td>
                      <td className="p-3 text-slate-200">{money(p.purchasePrice)}</td>
                      <td className="p-3 text-slate-200">{money(p.amount)}</td>
                      <td className="p-3 text-slate-300">
                        {p.manualStockEntered !== null && p.manualStockEntered !== undefined
                          ? `Base ${money(p.manualStockEntered)} → ${money(p.newStockAfterPurchase)}`
                          : `System → ${money(p.newStockAfterPurchase)}`}
                      </td>
                      <td className="p-3 text-slate-300">{p.note || "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
