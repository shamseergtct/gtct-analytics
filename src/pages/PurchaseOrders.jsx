import { useEffect, useMemo, useState } from "react";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import {
  CheckCircle2,
  ClipboardList,
  Plus,
  Search,
  Share2,
  Trash2,
} from "lucide-react";
import { db } from "../firebase";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext.jsx";
import { useShift } from "../context/shift-context.js";
import DateInput from "../components/DateInput.jsx";
import ModuleExitButton from "../components/ModuleExitButton.jsx";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_CLASS,
  FIELD_NUMBER_CLASS,
  LABEL_CLASS,
} from "../components/externalSales/externalSalesUi.js";
import { formatMoney, numMoney, resolveCurrencyDecimals } from "../utils/money.js";
import {
  ATTENTION_STATUS_META,
  subscribeDailyReviewLines,
} from "../utils/inventoryDailyReview.js";
import {
  PO_STATUS,
  PO_STATUS_META,
  createPurchaseOrder,
  openPurchaseOrderWhatsApp,
  subscribePurchaseOrders,
  updatePurchaseOrder,
} from "../utils/purchaseOrders.js";

const TABS = [
  { id: "entry", label: "New / Edit PO" },
  { id: "list", label: "PO List" },
];

function todayYYYYMMDD() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function isSupplierParty(party) {
  const type = String(party?.type || party?.partyType || "")
    .trim()
    .toLowerCase();
  return ["supplier", "vendor", "both"].includes(type);
}

function emptyForm(businessDate) {
  return {
    id: "",
    poNumber: "",
    businessDate: businessDate || todayYYYYMMDD(),
    vendorId: "",
    vendorName: "",
    vendorPhone: "",
    notes: "",
    status: PO_STATUS.DRAFT,
    lines: [],
  };
}

export default function PurchaseOrders() {
  const { user, displayName } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const { activeShift } = useShift();

  const clientId = String(activeClientId || "").trim();
  const defaultDate = activeShift?.businessDate || todayYYYYMMDD();
  const currencyDecimals = resolveCurrencyDecimals(activeClientData);
  const currency = String(activeClientData?.currency || "BHD").trim() || "BHD";

  const [tab, setTab] = useState("entry");
  const [filterDate, setFilterDate] = useState("");
  const listDate = filterDate || defaultDate;

  const [form, setForm] = useState(() => emptyForm(defaultDate));
  const [itemQuery, setItemQuery] = useState("");
  const [vendorQuery, setVendorQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [items, setItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [reviewLines, setReviewLines] = useState([]);

  useEffect(() => {
    setForm((prev) =>
      prev.id
        ? prev
        : { ...prev, businessDate: defaultDate }
    );
  }, [defaultDate]);

  useEffect(() => {
    if (!message) return undefined;
    const id = window.setTimeout(() => setMessage(""), 3500);
    return () => window.clearTimeout(id);
  }, [message]);

  useEffect(() => {
    if (!clientId) {
      setItems([]);
      return undefined;
    }
    const q = query(
      collection(db, "inventory"),
      where("clientId", "==", clientId),
      orderBy("itemName", "asc")
    );
    return onSnapshot(
      q,
      (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      () => setItems([])
    );
  }, [clientId]);

  useEffect(() => {
    if (!clientId) {
      setVendors([]);
      return undefined;
    }
    const q = query(
      collection(db, "parties"),
      where("clientId", "==", clientId)
    );
    return onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter(isSupplierParty)
          .sort((a, b) =>
            String(a.name || "").localeCompare(String(b.name || ""))
          );
        setVendors(rows);
      },
      () => setVendors([])
    );
  }, [clientId]);

  useEffect(() => {
    if (!clientId || !listDate) {
      setOrders([]);
      return undefined;
    }
    setLoadingOrders(true);
    return subscribePurchaseOrders(
      clientId,
      listDate,
      (rows) => {
        setOrders(rows);
        setLoadingOrders(false);
      },
      (err) => {
        setLoadingOrders(false);
        setError(err?.message || "Could not load purchase orders.");
      }
    );
  }, [clientId, listDate]);

  // Staff checklist requirements for the PO business date (qty requested).
  useEffect(() => {
    if (!clientId || !form.businessDate) {
      setReviewLines([]);
      return undefined;
    }
    return subscribeDailyReviewLines(
      clientId,
      form.businessDate,
      setReviewLines,
      () => setReviewLines([])
    );
  }, [clientId, form.businessDate]);

  const filteredVendors = useMemo(() => {
    const q = vendorQuery.trim().toLowerCase();
    if (!q) return vendors.slice(0, 40);
    return vendors
      .filter((v) => {
        const hay = `${v.name || ""} ${v.contact || ""} ${v.phone || ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 40);
  }, [vendors, vendorQuery]);

  const filteredItems = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    const selected = new Set(form.lines.map((row) => row.itemId));
    return items
      .filter((item) => !selected.has(item.id))
      .filter((item) => {
        if (!q) return true;
        const hay = `${item.itemName || ""} ${item.itemCode || ""} ${item.barcode || ""}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 40);
  }, [items, itemQuery, form.lines]);

  function resetForm() {
    setForm(emptyForm(defaultDate));
    setItemQuery("");
    setVendorQuery("");
    setError("");
  }

  function selectVendor(vendor) {
    setForm((prev) => ({
      ...prev,
      vendorId: vendor.id,
      vendorName: String(vendor.name || "").trim(),
      vendorPhone: String(vendor.contact || vendor.phone || "").trim(),
    }));
    setVendorQuery("");
  }

  const itemById = useMemo(() => {
    const map = new Map();
    for (const item of items) map.set(item.id, item);
    return map;
  }, [items]);

  const requirements = useMemo(() => {
    const selected = new Set(form.lines.map((row) => row.itemId));
    return reviewLines
      .filter((row) => {
        const status = String(row.attentionStatus || "").toUpperCase();
        const qty = numMoney(row.requestedQty);
        if (!(qty > 0)) return false;
        if (status === "ENOUGH") return false;
        return true;
      })
      .map((row) => {
        const item = itemById.get(String(row.itemId || row.id));
        return {
          itemId: String(row.itemId || row.id),
          itemCode: String(row.itemCode || item?.itemCode || "").trim(),
          itemName: String(
            row.itemName || item?.itemName || row.itemCode || "Item"
          ).trim(),
          qty: numMoney(row.requestedQty),
          unit: String(item?.baseUnit || "").trim(),
          unitRate: Math.max(0, numMoney(item?.cost)),
          attentionStatus: String(row.attentionStatus || "").toUpperCase(),
          notes: String(row.notes || "").trim(),
          alreadyOnPo: selected.has(String(row.itemId || row.id)),
        };
      })
      .sort((a, b) =>
        String(a.itemName || "").localeCompare(String(b.itemName || ""))
      );
  }, [reviewLines, form.lines, itemById]);

  function lineUnitRate(row) {
    if (row.unitRate != null && row.unitRate !== "") {
      return Math.max(0, numMoney(row.unitRate));
    }
    const item = itemById.get(row.itemId);
    return Math.max(0, numMoney(item?.cost));
  }

  function lineTotal(row) {
    return numMoney(numMoney(row.qty) * lineUnitRate(row));
  }

  const orderTotal = useMemo(() => {
    return form.lines.reduce((sum, row) => {
      const rate =
        row.unitRate != null && row.unitRate !== ""
          ? Math.max(0, numMoney(row.unitRate))
          : Math.max(0, numMoney(itemById.get(row.itemId)?.cost));
      return sum + numMoney(numMoney(row.qty) * rate);
    }, 0);
  }, [form.lines, itemById]);

  function addItem(item) {
    setForm((prev) => {
      if (prev.lines.some((row) => row.itemId === item.id)) return prev;
      return {
        ...prev,
        lines: [
          ...prev.lines,
          {
            itemId: item.id,
            itemCode: String(item.itemCode || "").trim(),
            itemName: String(item.itemName || "").trim(),
            qty: "",
            unitRate: Math.max(0, numMoney(item.cost)),
            unit: String(item.baseUnit || "").trim(),
            notes: "",
          },
        ],
      };
    });
    setItemQuery("");
  }

  function addRequirement(req) {
    if (!req?.itemId || !(numMoney(req.qty) > 0)) return;
    setForm((prev) => {
      const existing = prev.lines.find((row) => row.itemId === req.itemId);
      if (existing) {
        return {
          ...prev,
          lines: prev.lines.map((row) =>
            row.itemId === req.itemId
              ? {
                  ...row,
                  qty: String(numMoney(req.qty)),
                  notes: row.notes || req.notes || "",
                }
              : row
          ),
        };
      }
      return {
        ...prev,
        lines: [
          ...prev.lines,
          {
            itemId: req.itemId,
            itemCode: req.itemCode || "",
            itemName: req.itemName || "",
            qty: String(numMoney(req.qty)),
            unitRate: Math.max(0, numMoney(req.unitRate)),
            unit: req.unit || "",
            notes: req.notes || "",
          },
        ],
      };
    });
  }

  function addAllRequirements() {
    const pending = requirements.filter((row) => !row.alreadyOnPo);
    for (const req of pending) addRequirement(req);
  }

  function patchLine(itemId, patch) {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.map((row) =>
        row.itemId === itemId ? { ...row, ...patch } : row
      ),
    }));
  }

  function removeLine(itemId) {
    setForm((prev) => ({
      ...prev,
      lines: prev.lines.filter((row) => row.itemId !== itemId),
    }));
  }

  function loadOrder(order) {
    setForm({
      id: order.id,
      poNumber: order.poNumber || "",
      businessDate: order.businessDate || defaultDate,
      vendorId: order.vendorId || "",
      vendorName: order.vendorName || "",
      vendorPhone: order.vendorPhone || "",
      notes: order.notes || "",
      status: order.status || PO_STATUS.DRAFT,
      lines: (Array.isArray(order.lines) ? order.lines : []).map((row) => {
        const fromItem = itemById.get(row.itemId);
        const rate =
          row.unitRate != null && row.unitRate !== ""
            ? numMoney(row.unitRate)
            : numMoney(fromItem?.cost);
        return {
          itemId: row.itemId,
          itemCode: row.itemCode || "",
          itemName: row.itemName || "",
          qty: row.qty == null ? "" : String(row.qty),
          unitRate: Math.max(0, rate),
          unit: row.unit || "",
          notes: row.notes || "",
        };
      }),
    });
    setTab("entry");
    setError("");
    setMessage(`Editing ${order.poNumber || "purchase order"}.`);
  }

  async function handleSave({
    markSent = false,
    markCompleted = false,
    shareAfter = false,
  } = {}) {
    if (saving) return;
    setError("");
    setMessage("");
    setSaving(true);
    try {
      let status = form.status || PO_STATUS.DRAFT;
      if (markCompleted) status = PO_STATUS.COMPLETED;
      else if (markSent) status = PO_STATUS.SENT;

      const payload = {
        clientId,
        businessDate: form.businessDate,
        vendorId: form.vendorId,
        vendorName: form.vendorName,
        vendorPhone: form.vendorPhone,
        notes: form.notes,
        lines: form.lines,
        userUid: user?.uid,
        status,
      };

      let saved;
      if (form.id) {
        saved = await updatePurchaseOrder({ poId: form.id, ...payload });
        saved = {
          ...form,
          ...saved,
          poNumber: form.poNumber,
          lines: payload.lines
            .map((row) => ({
              ...row,
              qty: numMoney(row.qty),
            }))
            .filter((row) => row.itemId && numMoney(row.qty) > 0),
        };
      } else {
        saved = await createPurchaseOrder(payload);
      }

      const sharePayload = {
        ...saved,
        poNumber: saved.poNumber || form.poNumber,
        vendorPhone: form.vendorPhone || saved.vendorPhone,
        notes: form.notes || saved.notes || "",
        lines: (saved.lines || form.lines || []).map((row) => ({
          ...row,
          qty: numMoney(row.qty),
          notes: row.notes || "",
        })),
      };

      // Clear form for a fresh PO after successful save.
      resetForm();
      setMessage(
        markCompleted
          ? `PO ${sharePayload.poNumber || ""} completed.`
          : markSent
            ? `PO ${sharePayload.poNumber || ""} marked as sent.`
            : `PO ${sharePayload.poNumber || ""} saved.`
      );

      if (shareAfter) {
        await openPurchaseOrderWhatsApp(sharePayload, activeClientData || {});
      }
    } catch (err) {
      setError(err?.message || "Failed to save purchase order.");
    } finally {
      setSaving(false);
    }
  }

  async function handleShare(order) {
    setError("");
    try {
      await openPurchaseOrderWhatsApp(order, activeClientData || {});
    } catch (err) {
      setError(err?.message || "Could not share text on WhatsApp.");
    }
  }

  if (!clientId) {
    return (
      <div className="p-4 text-sm text-amber-100">
        Select an active shop to manage purchase orders.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 pb-10 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white">Purchase Orders</h1>
          <p className="mt-1 text-sm text-slate-400">
            {activeClientData?.name || clientId} · Assign vendor, items & qty,
            then share on WhatsApp
          </p>
        </div>
        <ModuleExitButton />
      </div>

      <div className="grid grid-cols-2 gap-1.5 rounded-2xl border border-slate-800 bg-slate-900/60 p-1">
        {TABS.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => {
              setTab(row.id);
              setError("");
            }}
            className={`min-h-11 rounded-xl text-sm font-semibold transition ${
              tab === row.id
                ? "bg-blue-600 text-white"
                : "text-slate-300 hover:bg-slate-800"
            }`}
          >
            {row.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-800 bg-rose-950/40 px-3 py-2 text-sm text-rose-100">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-100">
          {message}
        </div>
      ) : null}

      {tab === "entry" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={resetForm}
              disabled={saving}
            >
              <Plus className="h-4 w-4" />
              New PO
            </button>
            {form.poNumber ? (
              <span className="inline-flex items-center rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-300">
                {form.poNumber}
                {" · "}
                <span className={PO_STATUS_META[form.status]?.className || ""}>
                  {PO_STATUS_META[form.status]?.label || form.status}
                </span>
              </span>
            ) : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
              <label className={LABEL_CLASS}>
                Business date
                <DateInput
                  value={form.businessDate}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      businessDate: e.target.value,
                    }))
                  }
                  className={FIELD_CLASS}
                />
              </label>

              <div>
                <div className={LABEL_CLASS}>Vendor</div>
                {form.vendorId ? (
                  <div className="mt-1.5 flex items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-white">
                        {form.vendorName}
                      </div>
                      <div className="text-xs text-slate-400">
                        {form.vendorPhone || "No phone on file"}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="text-xs font-semibold text-sky-300"
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          vendorId: "",
                          vendorName: "",
                          vendorPhone: "",
                        }))
                      }
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative mt-1.5">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <input
                        value={vendorQuery}
                        onChange={(e) => setVendorQuery(e.target.value)}
                        placeholder="Search supplier / vendor"
                        className={`${FIELD_CLASS} pl-9`}
                      />
                    </div>
                    <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-slate-800">
                      {!filteredVendors.length ? (
                        <div className="px-3 py-4 text-sm text-slate-500">
                          No vendors found. Add a Supplier in Parties.
                        </div>
                      ) : (
                        filteredVendors.map((vendor) => (
                          <button
                            key={vendor.id}
                            type="button"
                            onClick={() => selectVendor(vendor)}
                            className="flex w-full items-center justify-between border-b border-slate-800/80 px-3 py-2.5 text-left last:border-b-0 hover:bg-slate-800/50"
                          >
                            <span className="truncate text-sm text-white">
                              {vendor.name}
                            </span>
                            <span className="text-xs text-slate-500">
                              {vendor.contact || vendor.phone || ""}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>

              <label className={LABEL_CLASS}>
                Vendor phone (WhatsApp)
                <input
                  value={form.vendorPhone}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      vendorPhone: e.target.value,
                    }))
                  }
                  className={FIELD_CLASS}
                  placeholder="e.g. 973xxxxxxxx"
                />
              </label>

              <label className={LABEL_CLASS}>
                General note (shared on WhatsApp)
                <textarea
                  value={form.notes}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, notes: e.target.value }))
                  }
                  rows={3}
                  className={`${FIELD_CLASS} h-auto py-2`}
                  placeholder="e.g. Please deliver before 10am"
                />
              </label>
            </section>

            <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
              <div className={LABEL_CLASS}>Add inventory items</div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  value={itemQuery}
                  onChange={(e) => setItemQuery(e.target.value)}
                  placeholder="Search item name / code"
                  className={`${FIELD_CLASS} pl-9`}
                />
              </div>
              <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-800">
                {!filteredItems.length ? (
                  <div className="px-3 py-4 text-sm text-slate-500">
                    {itemQuery.trim()
                      ? "No matching items."
                      : "Type to search items, or all unused items appear here."}
                  </div>
                ) : (
                  filteredItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => addItem(item)}
                      className="flex w-full items-center justify-between border-b border-slate-800/80 px-3 py-2.5 text-left last:border-b-0 hover:bg-slate-800/50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-white">
                          {item.itemName}
                        </span>
                        <span className="text-xs text-slate-500">
                          {item.itemCode || "—"}
                        </span>
                      </span>
                      <Plus className="h-4 w-4 text-sky-300" />
                    </button>
                  ))
                )}
              </div>
            </section>
          </div>

          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
              <div className="text-sm font-semibold text-white">
                Staff requirements ({requirements.length})
              </div>
              {requirements.some((row) => !row.alreadyOnPo) ? (
                <button
                  type="button"
                  className="text-xs font-semibold text-sky-300 hover:text-sky-200"
                  onClick={addAllRequirements}
                  disabled={saving}
                >
                  Add all to PO
                </button>
              ) : null}
            </div>
            {!requirements.length ? (
              <div className="px-4 py-6 text-center text-sm text-slate-500">
                No staff requests with qty for {form.businessDate}. Items marked
                Low / Urgent with a requested qty appear here.
              </div>
            ) : (
              <ul className="max-h-64 overflow-y-auto">
                {requirements.map((req) => {
                  const meta =
                    ATTENTION_STATUS_META[req.attentionStatus] || null;
                  return (
                    <li
                      key={req.itemId}
                      className="flex flex-wrap items-center gap-3 border-b border-slate-800/80 px-4 py-2.5 last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-white">
                          {req.itemName}
                        </div>
                        <div className="text-xs text-slate-500">
                          {req.itemCode || "—"}
                          {req.unit ? ` · ${req.unit}` : ""}
                          {req.notes ? ` · ${req.notes}` : ""}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold tabular-nums text-amber-200">
                          Qty {req.qty}
                          {req.unit ? ` ${req.unit}` : ""}
                        </div>
                        {meta ? (
                          <div className={`text-xs ${meta.textClass}`}>
                            {meta.label}
                          </div>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => addRequirement(req)}
                        className={BTN_SECONDARY}
                      >
                        <Plus className="h-4 w-4" />
                        {req.alreadyOnPo ? "Update qty" : "Add"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50">
            <div className="border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
              Order lines ({form.lines.length})
            </div>
            {!form.lines.length ? (
              <div className="px-4 py-8 text-center text-sm text-slate-500">
                Select a vendor and add items with quantities.
              </div>
            ) : (
              <>
                <ul>
                  {form.lines.map((row) => {
                    const rate = lineUnitRate(row);
                    const total = lineTotal(row);
                    return (
                      <li
                        key={row.itemId}
                        className="border-b border-slate-800/80 px-4 py-3 last:border-b-0"
                      >
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-0 flex-1 basis-40">
                            <div className="font-medium text-white">
                              {row.itemName}
                            </div>
                            <div className="text-xs text-slate-500">
                              {row.itemCode || "—"}
                              {row.unit ? ` · ${row.unit}` : ""}
                            </div>
                          </div>
                          <label className="w-24 shrink-0 text-xs text-slate-400">
                            Qty
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              step="any"
                              value={row.qty}
                              onChange={(e) =>
                                patchLine(row.itemId, { qty: e.target.value })
                              }
                              className={FIELD_NUMBER_CLASS}
                            />
                          </label>
                          <div className="w-28 shrink-0 text-xs text-slate-400">
                            Last rate
                            <div className="mt-1.5 h-11 rounded-xl border border-slate-800 bg-slate-950/80 px-3 text-sm tabular-nums leading-[2.75rem] text-slate-200">
                              {formatMoney(rate, currencyDecimals)}
                            </div>
                          </div>
                          <div className="w-28 shrink-0 text-xs text-slate-400">
                            Total
                            <div className="mt-1.5 h-11 rounded-xl border border-slate-800 bg-slate-950/80 px-3 text-sm font-semibold tabular-nums leading-[2.75rem] text-sky-200">
                              {formatMoney(total, currencyDecimals)}
                            </div>
                          </div>
                          <label className="min-w-[10rem] flex-1 text-xs text-slate-400">
                            Line note
                            <input
                              value={row.notes}
                              onChange={(e) =>
                                patchLine(row.itemId, { notes: e.target.value })
                              }
                              className={FIELD_CLASS}
                              placeholder="Optional"
                            />
                          </label>
                          <button
                            type="button"
                            onClick={() => removeLine(row.itemId)}
                            className="mt-5 rounded-lg border border-slate-700 p-2 text-slate-400 hover:text-rose-300"
                            aria-label="Remove line"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex justify-end border-t border-slate-800 px-4 py-3 text-sm text-slate-300">
                  Order total ({currency}):{" "}
                  <span className="ml-2 font-semibold tabular-nums text-sky-200">
                    {formatMoney(orderTotal, currencyDecimals)}
                  </span>
                </div>
              </>
            )}
          </section>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave({ markSent: false })}
              className={BTN_PRIMARY}
            >
              {saving ? "Saving…" : form.id ? "Save changes" : "Save draft"}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() =>
                void handleSave({ markSent: true, shareAfter: true })
              }
              className={BTN_PRIMARY}
            >
              <Share2 className="h-4 w-4" />
              Save & share text
            </button>
            <button
              type="button"
              disabled={saving || !form.lines.length}
              onClick={() => void handleSave({ markCompleted: true })}
              className={BTN_PRIMARY}
            >
              <CheckCircle2 className="h-4 w-4" />
              Complete PO
            </button>
            {form.id ? (
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  void handleShare({
                    ...form,
                    lines: form.lines.map((row) => ({
                      ...row,
                      qty: numMoney(row.qty),
                    })),
                  })
                }
                className={BTN_SECONDARY}
              >
                Share text only
              </button>
            ) : null}
          </div>
          <p className="text-xs text-slate-500">
            WhatsApp: shop name, address, contact, then items (qty + line notes
            in brackets), then Note. Rates/totals are not shared.
          </p>
        </div>
      ) : null}

      {tab === "list" ? (
        <div className="space-y-4">
          <label className={`${LABEL_CLASS} max-w-xs`}>
            Business date
            <DateInput
              value={listDate}
              onChange={(e) => setFilterDate(e.target.value)}
              className={FIELD_CLASS}
            />
          </label>

          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50">
            <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3 text-sm font-semibold text-white">
              <ClipboardList className="h-4 w-4 text-slate-400" />
              Purchase orders ({orders.length})
            </div>
            {loadingOrders ? (
              <div className="px-4 py-8 text-center text-sm text-slate-500">
                Loading…
              </div>
            ) : !orders.length ? (
              <div className="px-4 py-8 text-center text-sm text-slate-500">
                No purchase orders for this date.
              </div>
            ) : (
              <ul>
                {orders.map((order) => (
                  <li
                    key={order.id}
                    className="border-b border-slate-800/80 px-4 py-3 last:border-b-0"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-white">
                          {order.poNumber || "PO"}
                          <span
                            className={`ml-2 text-xs font-medium ${
                              PO_STATUS_META[order.status]?.className ||
                              "text-slate-400"
                            }`}
                          >
                            {PO_STATUS_META[order.status]?.label ||
                              order.status}
                          </span>
                        </div>
                        <div className="mt-0.5 text-sm text-slate-300">
                          {order.vendorName || "—"}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {order.lineCount || order.lines?.length || 0} line
                          {(order.lineCount || order.lines?.length || 0) === 1
                            ? ""
                            : "s"}
                          {order.notes ? ` · ${order.notes}` : ""}
                        </div>
                        <ul className="mt-2 space-y-0.5 text-xs text-slate-400">
                          {(order.lines || []).slice(0, 4).map((row) => (
                            <li key={`${order.id}-${row.itemId}`}>
                              {row.itemName} —{" "}
                              <span className="tabular-nums text-sky-200">
                                {formatMoney(row.qty, 3)}
                              </span>
                              {row.unit ? ` ${row.unit}` : ""}
                            </li>
                          ))}
                          {(order.lines || []).length > 4 ? (
                            <li>
                              +{(order.lines || []).length - 4} more…
                            </li>
                          ) : null}
                        </ul>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={BTN_SECONDARY}
                          onClick={() => loadOrder(order)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={BTN_PRIMARY}
                          onClick={() => void handleShare(order)}
                        >
                          <Share2 className="h-4 w-4" />
                          Share text
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
