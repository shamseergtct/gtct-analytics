import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Copy,
  Download,
  FileSpreadsheet,
  PackageCheck,
  Plus,
  Search,
  Share2,
  Trash2,
  X,
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
import { resolveAttentionStatus } from "../utils/inventoryAttention.js";
import {
  PO_LEFTOVER_ACTION,
  PO_STATUS,
  PO_STATUS_META,
  copyPurchaseOrderText,
  createPurchaseOrder,
  formatPoQtyBits,
  openPurchaseOrderWhatsApp,
  poLineHasPending,
  poLinePendingQty,
  poLineTotal,
  poReceivedBaseQty,
  receivePurchaseOrderToStock,
  subscribePurchaseOrders,
  updatePurchaseOrder,
} from "../utils/purchaseOrders.js";
import {
  downloadPurchaseOrderExcel,
  downloadPurchaseOrderPdf,
} from "../utils/purchaseOrderExport.js";
import ListPagination from "../components/ListPagination.jsx";
import { usePagination } from "../hooks/usePagination.js";
import { useUrgentStockNotifications } from "../hooks/useUrgentStockNotifications.js";
import { dismissUrgentPoItem } from "../utils/poUrgentNotifications.js";
import {
  listItemSubCategories,
  itemMatchesSubCategory,
} from "../utils/inventorySubCategory.js";
import {
  formatPackHint,
  hasPackConversion,
  packFieldsFromItem,
  purchaseUnitRateFromBaseCost,
} from "../utils/inventoryPack.js";

const ITEM_STATUS_FILTERS = [
  { id: "all", label: "All statuses" },
  { id: "LOW", label: "Low" },
  { id: "URGENT", label: "Urgent" },
  { id: "VERY_URGENT", label: "Very urgent" },
  { id: "NO_STOCK", label: "No stock" },
];

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
    stockReceivedAtMs: null,
    receiveNote: "",
    lines: [],
  };
}

export default function PurchaseOrders() {
  const { user, displayName } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const { activeShift } = useShift();
  const [searchParams, setSearchParams] = useSearchParams();

  const clientId = String(activeClientId || "").trim();
  const defaultDate = activeShift?.businessDate || todayYYYYMMDD();
  const currencyDecimals = resolveCurrencyDecimals(activeClientData);
  const currency = String(activeClientData?.currency || "BHD").trim() || "BHD";

  const [tab, setTab] = useState("entry");
  const [filterDate, setFilterDate] = useState("");
  const listDate = filterDate || defaultDate;

  const [form, setForm] = useState(() => emptyForm(defaultDate));
  const [itemQuery, setItemQuery] = useState("");
  const [itemSubCategoryFilter, setItemSubCategoryFilter] = useState("all");
  const [itemStatusFilter, setItemStatusFilter] = useState("all");
  const [vendorQuery, setVendorQuery] = useState("");
  const [vendorMenuOpen, setVendorMenuOpen] = useState(false);
  const vendorPickerRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [highlightItemId, setHighlightItemId] = useState("");
  const [receiveOrder, setReceiveOrder] = useState(null);
  const [receiveLines, setReceiveLines] = useState([]);
  const [receiving, setReceiving] = useState(false);
  const [leftoverAction, setLeftoverAction] = useState(PO_LEFTOVER_ACTION.KEEP);
  const [receiveNote, setReceiveNote] = useState("");

  const [items, setItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [reviewLines, setReviewLines] = useState([]);

  const { alerts: urgentAlerts } = useUrgentStockNotifications(
    clientId,
    form.businessDate || defaultDate
  );

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

  const staffReviewByItemId = useMemo(() => {
    const map = new Map();
    for (const row of reviewLines) {
      const id = String(row.itemId || row.id || "").trim();
      if (id) map.set(id, row);
    }
    return map;
  }, [reviewLines]);

  // Deep-link from bell: /purchase-orders?urgentItem=...
  useEffect(() => {
    const focusId = String(searchParams.get("urgentItem") || "").trim();
    if (!focusId) return;
    setTab("entry");
    setItemQuery("");
    setHighlightItemId(focusId);
    const item = items.find((row) => row.id === focusId);
    if (item) {
      const resolved = resolveAttentionStatus(
        item,
        staffReviewByItemId.get(focusId) || null
      );
      if (resolved.status === "URGENT" || resolved.status === "VERY_URGENT") {
        setItemStatusFilter(resolved.status);
      } else {
        setItemStatusFilter("all");
      }
    } else {
      setItemStatusFilter("all");
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("urgentItem");
        return next;
      },
      { replace: true }
    );
  }, [searchParams, setSearchParams, items, staffReviewByItemId]);

  const itemSubCategories = useMemo(
    () => listItemSubCategories(items),
    [items]
  );

  const filteredItems = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    const selected = new Set(form.lines.map((row) => row.itemId));
    const status = String(itemStatusFilter || "all").toUpperCase();

    return items
      .filter((item) => !selected.has(item.id))
      .filter((item) => itemMatchesSubCategory(item, itemSubCategoryFilter))
      .filter((item) => {
        if (!q) return true;
        const hay = `${item.itemName || ""} ${item.itemCode || ""} ${item.barcode || ""} ${item.subCategory || ""}`.toLowerCase();
        return hay.includes(q);
      })
      .filter((item) => {
        if (status === "ALL" || status === "all") return true;
        if (status === "NO_STOCK") return !(numMoney(item.currentStock) > 0);
        const resolved = resolveAttentionStatus(
          item,
          staffReviewByItemId.get(item.id) || null
        );
        return resolved.status === status;
      })
      .sort((a, b) =>
        String(a.itemName || "").localeCompare(String(b.itemName || ""))
      );
  }, [
    items,
    itemQuery,
    form.lines,
    itemSubCategoryFilter,
    itemStatusFilter,
    staffReviewByItemId,
  ]);

  useEffect(() => {
    if (!vendorMenuOpen) return undefined;
    function onPointerDown(event) {
      if (!vendorPickerRef.current?.contains(event.target)) {
        setVendorMenuOpen(false);
      }
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setVendorMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [vendorMenuOpen]);

  function resetForm() {
    setForm(emptyForm(defaultDate));
    setItemQuery("");
    setItemSubCategoryFilter("all");
    setItemStatusFilter("all");
    setVendorQuery("");
    setVendorMenuOpen(false);
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
    setVendorMenuOpen(false);
  }

  function clearVendor() {
    setForm((prev) => ({
      ...prev,
      vendorId: "",
      vendorName: "",
      vendorPhone: "",
    }));
    setVendorQuery("");
    setVendorMenuOpen(true);
  }

  const itemById = useMemo(() => {
    const map = new Map();
    for (const item of items) map.set(item.id, item);
    return map;
  }, [items]);

  const requirements = useMemo(() => {
    const selected = new Set(form.lines.map((row) => row.itemId));
    const staffByItemId = new Map();
    for (const row of reviewLines) {
      const id = String(row.itemId || row.id || "").trim();
      if (id) staffByItemId.set(id, row);
    }

    const rows = [];
    const seen = new Set();

    // Staff-marked lines first (always win over auto thresholds).
    for (const row of reviewLines) {
      const itemId = String(row.itemId || row.id || "").trim();
      if (!itemId || seen.has(itemId)) continue;
      const item = itemById.get(itemId);
      const resolved = resolveAttentionStatus(item || row, row);
      if (resolved.source !== "staff") continue;
      if (resolved.status === "ENOUGH" || !resolved.status) continue;
      if (!(resolved.requestedQty > 0)) continue;
      seen.add(itemId);
      const pack = packFieldsFromItem(item || {});
      rows.push({
        itemId,
        itemCode: String(row.itemCode || item?.itemCode || "").trim(),
        itemName: String(
          row.itemName || item?.itemName || row.itemCode || "Item"
        ).trim(),
        qty: resolved.requestedQty,
        unit: pack.baseUnit || pack.unit,
        purchaseUnit: pack.purchaseUnit,
        baseUnit: pack.baseUnit,
        subQty: pack.subQty,
        unitRate: purchaseUnitRateFromBaseCost(item?.cost, pack),
        attentionStatus: resolved.status,
        notes: resolved.notes,
        source: "staff",
        alreadyOnPo: selected.has(itemId),
      });
    }

    // Auto from stock thresholds when staff has not marked the item.
    for (const item of items) {
      const itemId = String(item.id || "").trim();
      if (!itemId || seen.has(itemId)) continue;
      if (staffByItemId.has(itemId)) continue;
      const resolved = resolveAttentionStatus(item, null);
      if (resolved.source !== "auto") continue;
      if (resolved.status === "ENOUGH" || !resolved.status) continue;
      if (!(resolved.requestedQty > 0)) continue;
      seen.add(itemId);
      const pack = packFieldsFromItem(item);
      rows.push({
        itemId,
        itemCode: String(item.itemCode || "").trim(),
        itemName: String(item.itemName || item.itemCode || "Item").trim(),
        qty: resolved.requestedQty,
        unit: pack.baseUnit || pack.unit,
        purchaseUnit: pack.purchaseUnit,
        baseUnit: pack.baseUnit,
        subQty: pack.subQty,
        unitRate: purchaseUnitRateFromBaseCost(item.cost, pack),
        attentionStatus: resolved.status,
        notes: "",
        source: "auto",
        alreadyOnPo: selected.has(itemId),
      });
    }

    return rows.sort((a, b) =>
      String(a.itemName || "").localeCompare(String(b.itemName || ""))
    );
  }, [reviewLines, form.lines, itemById, items]);

  function lineUnitRate(row) {
    if (row.unitRate != null && row.unitRate !== "") {
      return Math.max(0, numMoney(row.unitRate));
    }
    const item = itemById.get(row.itemId);
    const pack = packFieldsFromItem(item || row);
    return purchaseUnitRateFromBaseCost(item?.cost, pack);
  }

  function lineTotal(row) {
    return poLineTotal({
      ...row,
      unitRate: lineUnitRate(row),
    });
  }

  const orderTotal = useMemo(() => {
    return form.lines.reduce((sum, row) => {
      const item = itemById.get(row.itemId);
      const pack = packFieldsFromItem(item || row);
      const rate =
        row.unitRate != null && row.unitRate !== ""
          ? Math.max(0, numMoney(row.unitRate))
          : purchaseUnitRateFromBaseCost(item?.cost, pack);
      return (
        sum +
        poLineTotal({
          ...row,
          unitRate: rate,
        })
      );
    }, 0);
  }, [form.lines, itemById]);

  const ordersPage = usePagination(orders, {
    pageSize: 25,
    resetKey: listDate,
  });

  function clearUrgentNotice(itemId) {
    const id = String(itemId || "").trim();
    if (!id) return;
    dismissUrgentPoItem(clientId, form.businessDate || defaultDate, id);
    if (highlightItemId === id) setHighlightItemId("");
  }

  function addItem(item) {
    const pack = packFieldsFromItem(item);
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
            subUnitQty: "",
            unitRate: purchaseUnitRateFromBaseCost(item.cost, pack),
            unit: pack.unit,
            purchaseUnit: pack.purchaseUnit,
            baseUnit: pack.baseUnit,
            subQty: pack.subQty,
            notes: "",
          },
        ],
      };
    });
    clearUrgentNotice(item.id);
    setItemQuery("");
    setMessage(`Added ${item.itemName || item.itemCode || "item"} to PO.`);
  }

  function addRequirement(req) {
    if (!req?.itemId || !(numMoney(req.qty) > 0)) return;
    clearUrgentNotice(req.itemId);
    const fromItem = itemById.get(req.itemId);
    const pack = packFieldsFromItem(fromItem || req);
    // Requirements are always in base/stock units. Pack POs use Qty(pcs).
    const packActive = hasPackConversion(pack);
    const reqQty = String(numMoney(req.qty));
    const qtyPatch = packActive
      ? { qty: "", subUnitQty: reqQty }
      : { qty: reqQty, subUnitQty: "" };
    setForm((prev) => {
      const existing = prev.lines.find((row) => row.itemId === req.itemId);
      if (existing) {
        return {
          ...prev,
          lines: prev.lines.map((row) =>
            row.itemId === req.itemId
              ? {
                  ...row,
                  ...qtyPatch,
                  notes: row.notes || req.notes || "",
                  unit: row.unit || pack.unit,
                  purchaseUnit: row.purchaseUnit || pack.purchaseUnit,
                  baseUnit: row.baseUnit || pack.baseUnit,
                  subQty: row.subQty || pack.subQty,
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
            ...qtyPatch,
            unitRate: Math.max(
              0,
              numMoney(
                req.unitRate ||
                  purchaseUnitRateFromBaseCost(fromItem?.cost, pack)
              )
            ),
            unit: pack.unit || req.unit || "",
            purchaseUnit: pack.purchaseUnit,
            baseUnit: pack.baseUnit,
            subQty: pack.subQty,
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
      stockReceivedAtMs: order.stockReceivedAtMs || null,
      receiveNote: order.receiveNote || "",
      lines: (Array.isArray(order.lines) ? order.lines : []).map((row) => {
        const fromItem = itemById.get(row.itemId);
        const pack = packFieldsFromItem(fromItem || row);
        const rate =
          row.unitRate != null && row.unitRate !== ""
            ? numMoney(row.unitRate)
            : purchaseUnitRateFromBaseCost(fromItem?.cost, pack);
        return {
          itemId: row.itemId,
          itemCode: row.itemCode || "",
          itemName: row.itemName || "",
          qty: row.qty == null ? "" : String(row.qty),
          subUnitQty:
            row.subUnitQty == null || row.subUnitQty === ""
              ? ""
              : String(row.subUnitQty),
          unitRate: Math.max(0, rate),
          unit: row.unit || pack.unit || "",
          purchaseUnit: row.purchaseUnit || pack.purchaseUnit || "",
          baseUnit: row.baseUnit || pack.baseUnit || "",
          subQty: numMoney(row.subQty) > 0 ? numMoney(row.subQty) : pack.subQty,
          notes: row.notes || "",
        };
      }),
    });
    setTab("entry");
    setError("");
    setMessage(`Editing ${order.poNumber || "purchase order"}.`);
  }

  function canReceiveOrder(order) {
    if (!order?.id) return false;
    const status = String(order.status || "").toUpperCase();
    if (status === PO_STATUS.CANCELLED || status === PO_STATUS.COMPLETED) {
      return false;
    }
    return true;
  }

  function buildReceiveLines(orderOrForm) {
    const sourceLines = Array.isArray(orderOrForm?.lines)
      ? orderOrForm.lines
      : [];
    return sourceLines
      .map((row) => {
        const fromItem = itemById.get(row.itemId);
        const pack = packFieldsFromItem(fromItem || row);
        const subQty =
          numMoney(row.subQty) > 0 ? numMoney(row.subQty) : pack.subQty;
        const orderedQty =
          row.qty == null || row.qty === "" ? "" : String(row.qty);
        const orderedSub =
          row.subUnitQty == null || row.subUnitQty === ""
            ? ""
            : String(row.subUnitQty);
        const receivedQty =
          row.receivedQty != null && row.receivedQty !== ""
            ? String(row.receivedQty)
            : orderedQty;
        const receivedSubUnitQty =
          row.receivedSubUnitQty != null && row.receivedSubUnitQty !== ""
            ? String(row.receivedSubUnitQty)
            : orderedSub;
        const rate = Math.max(
          0,
          numMoney(
            row.unitRate != null && row.unitRate !== ""
              ? row.unitRate
              : purchaseUnitRateFromBaseCost(fromItem?.cost, {
                  subQty,
                  purchaseUnit: pack.purchaseUnit,
                })
          )
        );
        return {
          itemId: row.itemId,
          itemCode: row.itemCode || fromItem?.itemCode || "",
          itemName: row.itemName || fromItem?.itemName || "",
          qty: numMoney(row.qty),
          subUnitQty: numMoney(row.subUnitQty),
          unitRate: String(rate),
          unit: row.unit || pack.unit || "",
          purchaseUnit: row.purchaseUnit || pack.purchaseUnit || "",
          baseUnit: row.baseUnit || pack.baseUnit || "",
          subQty,
          notes: row.notes || "",
          orderedQtyLabel: orderedQty,
          orderedSubLabel: orderedSub,
          receivedQty,
          receivedSubUnitQty,
        };
      })
      .filter((row) => row.itemId);
  }

  function openReceive(orderOrForm) {
    if (!canReceiveOrder(orderOrForm)) {
      setError(
        String(orderOrForm?.status || "").toUpperCase() === PO_STATUS.COMPLETED
          ? "This purchase order is already completed."
          : "This purchase order cannot be received."
      );
      return;
    }
    if (!orderOrForm?.id) {
      setError("Save the purchase order before receiving stock.");
      return;
    }
    const lines = buildReceiveLines(orderOrForm);
    if (!lines.length) {
      setError("Add at least one item before receiving.");
      return;
    }
    setError("");
    setMessage("");
    setLeftoverAction(PO_LEFTOVER_ACTION.KEEP);
    setReceiveNote(String(orderOrForm.receiveNote || "").trim());
    setReceiveOrder({
      id: orderOrForm.id,
      poNumber: orderOrForm.poNumber || "",
      vendorName: orderOrForm.vendorName || "",
      businessDate: orderOrForm.businessDate || listDate,
      status: orderOrForm.status || PO_STATUS.DRAFT,
    });
    setReceiveLines(lines);
  }

  function closeReceive() {
    if (receiving) return;
    setReceiveOrder(null);
    setReceiveLines([]);
    setReceiveNote("");
    setLeftoverAction(PO_LEFTOVER_ACTION.KEEP);
  }

  function patchReceiveLine(itemId, patch) {
    setReceiveLines((prev) =>
      prev.map((row) => (row.itemId === itemId ? { ...row, ...patch } : row))
    );
  }

  const receiveHasPending = useMemo(
    () =>
      receiveLines.some((row) =>
        poLineHasPending({
          qty: row.qty,
          subUnitQty: row.subUnitQty,
          receivedQty: row.receivedQty,
          receivedSubUnitQty: row.receivedSubUnitQty,
        })
      ),
    [receiveLines]
  );

  async function confirmReceive() {
    if (receiving || !receiveOrder?.id) return;
    const receivingPoId = receiveOrder.id;
    const noteSnapshot = String(receiveNote || "").trim();
    setError("");
    setMessage("");
    setReceiving(true);
    try {
      const result = await receivePurchaseOrderToStock({
        poId: receivingPoId,
        clientId,
        lines: receiveLines,
        userUid: user?.uid,
        userName: displayName || "",
        shiftId: activeShift?.status === "OPEN" ? activeShift.id : "",
        leftoverAction: receiveHasPending
          ? leftoverAction
          : PO_LEFTOVER_ACTION.REMOVE,
        receiveNote: noteSnapshot,
      });
      setReceiveOrder(null);
      setReceiveLines([]);
      setReceiveNote("");
      setLeftoverAction(PO_LEFTOVER_ACTION.KEEP);
      if (form.id === receivingPoId) {
        setForm((prev) => ({
          ...prev,
          status: result.status,
          stockReceivedAtMs: result.stockReceivedAtMs,
          receiveNote:
            result.status === PO_STATUS.PARTIALLY_RECEIVED ? noteSnapshot : "",
        }));
      }
      const statusLabel =
        PO_STATUS_META[result.status]?.label || result.status;
      setMessage(
        result.status === PO_STATUS.PARTIALLY_RECEIVED
          ? `Received ${result.receivedLineCount} item${
              result.receivedLineCount === 1 ? "" : "s"
            }. Remaining kept as to be received.`
          : result.leftoverAction === PO_LEFTOVER_ACTION.REMOVE &&
              result.pendingLineCount > 0
            ? `Received ${result.receivedLineCount} item${
                result.receivedLineCount === 1 ? "" : "s"
              }. Remaining removed. PO ${statusLabel}.`
            : `Received ${result.receivedLineCount} item${
                result.receivedLineCount === 1 ? "" : "s"
              } into stock. PO ${statusLabel}.`
      );
      setTab("list");
    } catch (err) {
      setError(err?.message || "Could not receive stock.");
    } finally {
      setReceiving(false);
    }
  }

  async function persistPurchaseOrder({
    markSent = false,
    markCompleted = false,
  } = {}) {
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
        id: form.id,
        poNumber: form.poNumber,
        lines: payload.lines
          .map((row) => ({
            ...row,
            qty: numMoney(row.qty),
            subUnitQty: numMoney(row.subUnitQty),
          }))
          .filter(
            (row) =>
              row.itemId &&
              (numMoney(row.qty) > 0 || numMoney(row.subUnitQty) > 0)
          ),
      };
    } else {
      saved = await createPurchaseOrder(payload);
    }
    return saved;
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
      const saved = await persistPurchaseOrder({ markSent, markCompleted });

      const sharePayload = {
        ...saved,
        poNumber: saved.poNumber || form.poNumber,
        vendorPhone: form.vendorPhone || saved.vendorPhone,
        notes: form.notes || saved.notes || "",
        lines: (saved.lines || form.lines || []).map((row) => ({
          ...row,
          qty: numMoney(row.qty),
          subUnitQty: numMoney(row.subUnitQty),
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
        const shareResult = await openPurchaseOrderWhatsApp(
          sharePayload,
          activeClientData || {}
        );
        if (shareResult?.copied) {
          setMessage(
            shareResult.urlTooLong
              ? `PO saved. Text copied — paste into WhatsApp (message was too long for auto-fill).`
              : `PO saved. Text copied${shareResult.opened ? " and WhatsApp opened" : ""}.`
          );
        }
      }
    } catch (err) {
      setError(err?.message || "Failed to save purchase order.");
    } finally {
      setSaving(false);
    }
  }

  async function openReceiveFromEntry() {
    if (saving || receiving) return;
    if (!form.lines.length) {
      setError("Add at least one item before receiving.");
      return;
    }
    if (!canReceiveOrder(form)) {
      setError(
        String(form.status || "").toUpperCase() === PO_STATUS.COMPLETED
          ? "This purchase order is already completed."
          : "This purchase order cannot be received."
      );
      return;
    }
    setError("");
    setMessage("");
    setSaving(true);
    try {
      const saved = await persistPurchaseOrder({ markSent: false });
      const nextForm = {
        ...form,
        id: saved.id || form.id,
        poNumber: saved.poNumber || form.poNumber,
        status: saved.status || form.status,
        lines: (saved.lines || form.lines).map((row) => ({
          ...row,
          qty: row.qty == null ? "" : String(row.qty),
          subUnitQty:
            row.subUnitQty == null || row.subUnitQty === ""
              ? ""
              : String(row.subUnitQty),
        })),
      };
      setForm(nextForm);
      setMessage(`PO ${nextForm.poNumber || ""} saved. Review received qty.`);
      openReceive(nextForm);
    } catch (err) {
      setError(err?.message || "Save the purchase order before receiving.");
    } finally {
      setSaving(false);
    }
  }

  async function handleShare(order) {
    setError("");
    setMessage("");
    try {
      const result = await openPurchaseOrderWhatsApp(
        order,
        activeClientData || {}
      );
      if (result?.method === "cancelled") return;
      if (result?.copied) {
        setMessage(
          result.urlTooLong
            ? "PO text copied. Paste into WhatsApp (auto-fill skipped — message too long)."
            : result.opened
              ? "PO text copied and WhatsApp opened."
              : "PO text copied. Paste into WhatsApp if it did not open."
        );
      } else if (result?.opened) {
        setMessage("WhatsApp opened.");
      }
    } catch (err) {
      setError(err?.message || "Could not share or copy PO text.");
    }
  }

  async function handleCopyText(order) {
    setError("");
    setMessage("");
    try {
      await copyPurchaseOrderText(
        order ||
          buildExportPo({
            ...form,
            lines: form.lines,
          }),
        activeClientData || {}
      );
      setMessage("PO text copied. Paste anywhere (WhatsApp, Notepad, etc.).");
    } catch (err) {
      setError(err?.message || "Could not copy PO text.");
    }
  }

  function buildExportPo(source) {
    const po = source || form;
    return {
      ...po,
      lines: (Array.isArray(po.lines) ? po.lines : []).map((row) => ({
        ...row,
        qty: numMoney(row.qty),
        subUnitQty: numMoney(row.subUnitQty),
        unitRate: Math.max(
          0,
          numMoney(
            row.unitRate ??
              row.cost ??
              itemById.get(row.itemId)?.cost ??
              0
          )
        ),
      })),
    };
  }

  function handleDownloadPdf(source) {
    setError("");
    try {
      const result = downloadPurchaseOrderPdf({
        po: buildExportPo(source),
        shop: activeClientData || {},
        currency,
        currencyDecimals,
      });
      setMessage(`Downloaded ${result.filename}`);
    } catch (err) {
      setError(err?.message || "Could not download PDF.");
    }
  }

  function handleDownloadExcel(source) {
    setError("");
    try {
      const result = downloadPurchaseOrderExcel({
        po: buildExportPo(source),
        shop: activeClientData || {},
        currency,
        currencyDecimals,
      });
      setMessage(`Downloaded ${result.filename}`);
    } catch (err) {
      setError(err?.message || "Could not download Excel file.");
    }
  }

  if (!clientId) {
    return (
      <div className="p-4 text-sm text-amber-100">
        Select an active shop to manage purchase orders.
      </div>
    );
  }

  const statusMeta = PO_STATUS_META[form.status] || null;
  const linesTotalLabel = `${formatMoney(orderTotal, currencyDecimals)} ${currency}`;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-3 pb-28 sm:p-4 sm:pb-10">
      {/* Page header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-white">
            Purchase Orders
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {activeClientData?.name || clientId}
          </p>
        </div>
        <ModuleExitButton />
      </header>

      {/* Segmented tabs */}
      <div
        role="tablist"
        aria-label="Purchase order views"
        className="grid grid-cols-2 gap-1 rounded-2xl border border-slate-800 bg-slate-900/50 p-1"
      >
        {TABS.map((row) => (
          <button
            key={row.id}
            type="button"
            role="tab"
            aria-selected={tab === row.id}
            onClick={() => {
              setTab(row.id);
              setError("");
            }}
            className={`min-h-11 rounded-xl text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 ${
              tab === row.id
                ? "bg-blue-600 text-white shadow-sm"
                : "text-slate-300 hover:bg-slate-800/80"
            }`}
          >
            {row.label}
          </button>
        ))}
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-rose-800 bg-rose-950/40 px-3 py-2.5 text-sm text-rose-100"
        >
          {error}
        </div>
      ) : null}
      {message ? (
        <div
          role="status"
          className="rounded-xl border border-emerald-800 bg-emerald-950/30 px-3 py-2.5 text-sm text-emerald-100"
        >
          {message}
        </div>
      ) : null}

      {tab === "entry" ? (
        <div className="space-y-4">
          {/* PO identity row */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={`${BTN_SECONDARY} min-h-11`}
              onClick={resetForm}
              disabled={saving}
            >
              <Plus className="h-4 w-4" />
              New PO
            </button>
            {form.poNumber ? (
              <div className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm">
                <span className="font-medium tabular-nums text-white">
                  {form.poNumber}
                </span>
                {statusMeta ? (
                  <span
                    className={`rounded-lg px-2 py-0.5 text-xs font-semibold ${statusMeta.className}`}
                  >
                    {statusMeta.label}
                  </span>
                ) : null}
              </div>
            ) : (
              <span className="text-sm text-slate-500">New draft</span>
            )}
            <div className="ml-auto hidden items-baseline gap-2 sm:flex">
              <span className="text-xs text-slate-500">
                {form.lines.length} item{form.lines.length === 1 ? "" : "s"}
              </span>
              <span className="text-sm font-semibold tabular-nums text-sky-200">
                {linesTotalLabel}
              </span>
            </div>
          </div>

          {/* Two columns: order details + catalog (catalog height matches left on desktop) */}
          <div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
            {/* Left: vendor / notes — drives row height */}
            <section className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
              <h2 className="text-sm font-semibold text-white">Order details</h2>

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

              <div ref={vendorPickerRef} className="relative z-20">
                <div className={LABEL_CLASS} id="po-vendor-label">
                  Vendor
                </div>
                {form.vendorId ? (
                  <div className="mt-1.5 flex min-h-11 items-center justify-between gap-2 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-white">
                        {form.vendorName}
                      </div>
                      <div className="truncate text-xs text-slate-400">
                        {form.vendorPhone || "No phone on file"}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="min-h-11 shrink-0 px-2 text-xs font-semibold text-sky-300 hover:text-sky-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
                      onClick={clearVendor}
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="relative mt-1.5">
                    <Search
                      className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-500"
                      aria-hidden
                    />
                    <input
                      value={vendorQuery}
                      onChange={(e) => {
                        setVendorQuery(e.target.value);
                        setVendorMenuOpen(true);
                      }}
                      onFocus={() => setVendorMenuOpen(true)}
                      onClick={() => setVendorMenuOpen(true)}
                      placeholder="Search supplier / vendor"
                      aria-label="Search vendor"
                      aria-labelledby="po-vendor-label"
                      aria-expanded={vendorMenuOpen}
                      aria-controls="po-vendor-listbox"
                      aria-haspopup="listbox"
                      role="combobox"
                      autoComplete="off"
                      className={`${FIELD_CLASS} pl-9 pr-10`}
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={
                        vendorMenuOpen ? "Close vendor list" : "Open vendor list"
                      }
                      onClick={() => setVendorMenuOpen((open) => !open)}
                      className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 hover:text-slate-200"
                    >
                      <ChevronDown
                        className={`h-4 w-4 transition ${
                          vendorMenuOpen ? "rotate-180" : ""
                        }`}
                      />
                    </button>

                    {vendorMenuOpen ? (
                      <div
                        id="po-vendor-listbox"
                        role="listbox"
                        aria-label="Vendors"
                        className="absolute left-0 right-0 top-[calc(100%+0.35rem)] z-30 max-h-52 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 shadow-lg shadow-black/40"
                      >
                        {!filteredVendors.length ? (
                        <div className="px-3 py-4 text-sm text-slate-500">
                          No vendors found
                        </div>
                        ) : (
                          filteredVendors.map((vendor) => (
                            <button
                              key={vendor.id}
                              type="button"
                              role="option"
                              onClick={() => selectVendor(vendor)}
                              className="flex min-h-11 w-full items-center justify-between gap-2 border-b border-slate-800/80 px-3 py-2.5 text-left last:border-b-0 hover:bg-slate-800/60 focus-visible:bg-slate-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/40"
                            >
                              <span className="truncate text-sm font-medium uppercase tracking-wide text-white">
                                {vendor.name}
                              </span>
                              <span className="shrink-0 text-xs text-slate-500">
                                {vendor.contact || vendor.phone || ""}
                              </span>
                            </button>
                          ))
                        )}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <label className={LABEL_CLASS}>
                Vendor phone
                <input
                  value={form.vendorPhone}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      vendorPhone: e.target.value,
                    }))
                  }
                  className={FIELD_CLASS}
                  placeholder="Phone"
                  inputMode="tel"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
              </label>

              <label className={LABEL_CLASS}>
                General note
                <textarea
                  value={form.notes}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, notes: e.target.value }))
                  }
                  rows={2}
                  className={`${FIELD_CLASS} h-auto min-h-[4.5rem] py-2.5`}
                  placeholder="Note"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-form-type="other"
                />
              </label>
            </section>

            {/* Right: inventory catalog — same height as Order details on desktop */}
            <div className="relative min-h-[22rem] lg:min-h-0">
              <section className="flex h-full min-h-[22rem] flex-col gap-3 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50 p-4 lg:absolute lg:inset-0 lg:min-h-0">
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-white">
                    Inventory catalog
                  </h2>
                  {urgentAlerts.length ? (
                    <button
                      type="button"
                      onClick={() => {
                        setItemStatusFilter("URGENT");
                        setItemQuery("");
                      }}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-rose-800/60 bg-rose-950/40 px-2.5 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-950/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
                    >
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {urgentAlerts.length} urgent
                    </button>
                  ) : null}
                </div>

                <div className="relative shrink-0">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                    aria-hidden
                  />
                  <input
                    value={itemQuery}
                    onChange={(e) => setItemQuery(e.target.value)}
                    placeholder="Search item name / code"
                    aria-label="Search inventory items"
                    className={`${FIELD_CLASS} pl-9`}
                  />
                </div>

                <div className="grid shrink-0 grid-cols-2 gap-2">
                  <label className="block text-xs font-medium text-slate-400">
                    Sub category
                    <select
                      value={itemSubCategoryFilter}
                      onChange={(e) =>
                        setItemSubCategoryFilter(e.target.value)
                      }
                      className={`${FIELD_CLASS} mt-1`}
                    >
                      <option value="all">All sub categories</option>
                      <option value="__none__">No sub category</option>
                      {itemSubCategories.map((sub) => (
                        <option key={sub} value={sub}>
                          {sub}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs font-medium text-slate-400">
                    Status
                    <select
                      value={itemStatusFilter}
                      onChange={(e) => setItemStatusFilter(e.target.value)}
                      className={`${FIELD_CLASS} mt-1`}
                    >
                      {ITEM_STATUS_FILTERS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40">
                  <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    {!filteredItems.length ? (
                      <div className="flex h-full min-h-[6rem] items-center justify-center px-3 py-8 text-center text-sm text-slate-500">
                        No items
                      </div>
                    ) : (
                      filteredItems.map((item) => {
                        const resolved = resolveAttentionStatus(
                          item,
                          staffReviewByItemId.get(item.id) || null
                        );
                        const meta = resolved.status
                          ? ATTENTION_STATUS_META[resolved.status]
                          : null;
                        const noStock = !(numMoney(item.currentStock) > 0);
                        const highlighted = highlightItemId === item.id;
                        const packHint = formatPackHint(item);
                        return (
                          <div
                            key={item.id}
                            className={`flex items-center gap-2 border-b border-slate-800/80 px-3 py-2 last:border-b-0 ${
                              highlighted
                                ? "bg-rose-950/40 ring-1 ring-inset ring-rose-500/40"
                                : ""
                            }`}
                          >
                            <div className="min-w-0 flex-1 py-1">
                              <div className="truncate text-sm font-medium text-white">
                                {item.itemName}
                              </div>
                              <div className="mt-0.5 text-xs text-slate-500">
                                <span className="tabular-nums">
                                  {item.itemCode || "—"}
                                </span>
                                {item.subCategory
                                  ? ` · ${item.subCategory}`
                                  : ""}
                                {packHint ? (
                                  <span className="text-sky-300/90">
                                    {" "}
                                    · {packHint}
                                  </span>
                                ) : item.baseUnit ? (
                                  ` · ${item.baseUnit}`
                                ) : (
                                  ""
                                )}
                                {noStock ? (
                                  <span className="text-rose-300">
                                    {" "}
                                    · No stock
                                  </span>
                                ) : meta ? (
                                  <span className={meta.textClass}>
                                    {" "}
                                    · {meta.short}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => addItem(item)}
                              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-sky-300 hover:border-sky-700 hover:bg-sky-950/40 hover:text-sky-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
                              aria-label={`Add ${item.itemName}`}
                            >
                              <Plus className="h-4 w-4" />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {filteredItems.length ? (
                    <div className="shrink-0 border-t border-slate-800 px-3 py-2 text-center text-xs text-slate-500">
                      {filteredItems.length} item
                      {filteredItems.length === 1 ? "" : "s"}
                    </div>
                  ) : null}
                </div>
              </section>
            </div>
          </div>

          {/* Requirements — full width */}
          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
              <h2 className="text-sm font-semibold text-white">
                Requirements
                <span className="ml-1.5 font-normal text-slate-400">
                  ({requirements.length})
                </span>
              </h2>
              {requirements.some((row) => !row.alreadyOnPo) ? (
                <button
                  type="button"
                  className="min-h-11 px-2 text-xs font-semibold text-sky-300 hover:text-sky-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
                  onClick={addAllRequirements}
                  disabled={saving}
                >
                  Add all to PO
                </button>
              ) : null}
            </div>
            {!requirements.length ? (
              <div className="px-4 py-6 text-center text-sm text-slate-500">
                No requirements
              </div>
            ) : (
              <ul className="max-h-72 overflow-y-auto">
                {requirements.map((req) => {
                  const meta =
                    ATTENTION_STATUS_META[req.attentionStatus] || null;
                  const packHint = formatPackHint(req);
                  return (
                    <li
                      key={req.itemId}
                      className="flex flex-wrap items-center gap-3 border-b border-slate-800/80 px-4 py-3 last:border-b-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-white">
                          {req.itemName}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {req.itemCode || "—"}
                          {req.unit ? ` · ${req.unit}` : ""}
                          {packHint ? (
                            <span className="text-sky-300/90">
                              {" "}
                              · {packHint}
                            </span>
                          ) : null}
                          {req.notes ? ` · ${req.notes}` : ""}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold tabular-nums text-amber-200">
                          Qty {req.qty}
                          {req.baseUnit
                            ? ` ${req.baseUnit}`
                            : req.unit
                              ? ` ${req.unit}`
                              : ""}
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
                        className={`${BTN_SECONDARY} min-h-11`}
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

          {/* This PO — full width below requirements */}
          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
              <h2 className="text-sm font-semibold text-white">
                This PO
                <span className="ml-1.5 font-normal text-slate-400">
                  ({form.lines.length})
                </span>
              </h2>
              {form.lines.length ? (
                <div className="text-sm font-semibold tabular-nums text-sky-200">
                  {linesTotalLabel}
                </div>
              ) : null}
            </div>
            {!form.lines.length ? (
              <div className="px-4 py-8 text-center text-sm text-slate-500">
                No items
              </div>
            ) : (
              <ul className="max-h-96 overflow-y-auto">
                {form.lines.map((row) => {
                  const rate = lineUnitRate(row);
                  const total = lineTotal(row);
                  const packHint = formatPackHint(row);
                  const packLine = hasPackConversion(row);
                  const baseUnitLabel =
                    String(row.baseUnit || "pcs").trim() || "pcs";
                  const purchaseUnitLabel =
                    String(row.unit || row.purchaseUnit || "").trim();
                  return (
                    <li
                      key={row.itemId}
                      className="border-b border-slate-800/80 px-4 py-3 last:border-b-0"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-white">
                            {row.itemName}
                          </div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            <span className="tabular-nums">
                              {row.itemCode || "—"}
                            </span>
                            {row.unit ? ` · ${row.unit}` : ""}
                            {packHint ? (
                              <span className="text-sky-300/90">
                                {" "}
                                · {packHint}
                              </span>
                            ) : null}
                            {" · "}
                            {formatMoney(rate, currencyDecimals)}
                            {" / "}
                            {row.unit || "unit"}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-start gap-2">
                          <label className="w-[4.5rem]">
                            <span className="sr-only">
                              Quantity for {row.itemName}
                              {purchaseUnitLabel
                                ? ` in ${purchaseUnitLabel}`
                                : ""}
                            </span>
                            <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-slate-500">
                              Qty
                              {purchaseUnitLabel
                                ? ` (${purchaseUnitLabel})`
                                : ""}
                            </span>
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              step="any"
                              value={row.qty}
                              onChange={(e) =>
                                patchLine(row.itemId, {
                                  qty: e.target.value,
                                })
                              }
                              className={`${FIELD_NUMBER_CLASS} mt-0 h-11 py-1 text-center text-sm`}
                            />
                          </label>
                          {packLine ? (
                            <label className="w-[4.5rem]">
                              <span className="sr-only">
                                Sub quantity for {row.itemName} in{" "}
                                {baseUnitLabel}
                              </span>
                              <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-slate-500">
                                Qty ({baseUnitLabel})
                              </span>
                              <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="any"
                                value={row.subUnitQty ?? ""}
                                onChange={(e) =>
                                  patchLine(row.itemId, {
                                    subUnitQty: e.target.value,
                                  })
                                }
                                className={`${FIELD_NUMBER_CLASS} mt-0 h-11 py-1 text-center text-sm`}
                              />
                            </label>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => removeLine(row.itemId)}
                            className="mt-5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-700 text-slate-400 hover:border-rose-800 hover:bg-rose-950/30 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
                            aria-label={`Remove ${row.itemName}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          value={row.notes}
                          onChange={(e) =>
                            patchLine(row.itemId, {
                              notes: e.target.value,
                            })
                          }
                          className={`${FIELD_CLASS} mt-0 h-11 min-w-0 flex-1 py-1 text-xs`}
                          placeholder="Note"
                          aria-label={`Note for ${row.itemName}`}
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                        />
                        <div className="shrink-0 text-xs font-semibold tabular-nums text-sky-200">
                          {formatMoney(total, currencyDecimals)}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Actions — sticky on mobile */}
          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-800 bg-slate-950/95 px-3 py-3 backdrop-blur sm:static sm:z-auto sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
            <div className="mx-auto flex max-w-5xl flex-col gap-2 sm:gap-3">
              <div className="flex items-center justify-between gap-2 sm:hidden">
                <span className="text-xs text-slate-400">
                  {form.lines.length} item{form.lines.length === 1 ? "" : "s"}
                </span>
                <span className="text-sm font-semibold tabular-nums text-sky-200">
                  {linesTotalLabel}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSave({ markSent: false })}
                  className={`${BTN_PRIMARY} min-h-11 flex-1 sm:flex-none`}
                >
                  {saving
                    ? "Saving…"
                    : form.id
                      ? "Save changes"
                      : "Save draft"}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void handleSave({ markSent: true, shareAfter: true })
                  }
                  className={`${BTN_PRIMARY} min-h-11 flex-1 sm:flex-none`}
                >
                  <Share2 className="h-4 w-4" />
                  <span className="sm:hidden">Share</span>
                  <span className="hidden sm:inline">Save & share text</span>
                </button>
                <button
                  type="button"
                  disabled={
                    saving ||
                    receiving ||
                    !form.id ||
                    !form.lines.length ||
                    !canReceiveOrder(form)
                  }
                  onClick={() => void openReceiveFromEntry()}
                  className={`${BTN_SECONDARY} min-h-11 border-emerald-800/60 text-emerald-200 hover:bg-emerald-950/40`}
                >
                  <PackageCheck className="h-4 w-4" />
                  Receive to stock
                </button>
                <button
                  type="button"
                  disabled={saving || !form.lines.length}
                  onClick={() => void handleCopyText()}
                  className={`${BTN_SECONDARY} min-h-11`}
                >
                  <Copy className="h-4 w-4" />
                  Copy text
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
                          subUnitQty: numMoney(row.subUnitQty),
                        })),
                      })
                    }
                    className={`${BTN_SECONDARY} min-h-11`}
                  >
                    Share text only
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={saving || !form.lines.length}
                  onClick={() => handleDownloadPdf()}
                  className={`${BTN_SECONDARY} min-h-11`}
                >
                  <Download className="h-4 w-4" />
                  PDF
                </button>
                <button
                  type="button"
                  disabled={saving || !form.lines.length}
                  onClick={() => handleDownloadExcel()}
                  className={`${BTN_SECONDARY} min-h-11`}
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  Excel
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {receiveOrder ? (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-3 sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="po-receive-title"
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 shadow-xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-800 bg-slate-950 px-4 py-3">
              <div className="min-w-0">
                <h2
                  id="po-receive-title"
                  className="text-base font-semibold text-white"
                >
                  Receive to stock
                </h2>
                <p className="mt-0.5 truncate text-xs text-slate-400">
                  {receiveOrder.poNumber || "PO"}
                  {receiveOrder.vendorName
                    ? ` · ${receiveOrder.vendorName}`
                    : ""}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Edit received qty. Short deliveries can stay as to be received.
                </p>
              </div>
              <button
                type="button"
                className={`${BTN_SECONDARY} min-h-10 shrink-0 px-2`}
                disabled={receiving}
                onClick={closeReceive}
                aria-label="Close receive"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <ul className="divide-y divide-slate-800 px-4">
              {receiveLines.map((row) => {
                const pack = hasPackConversion(row);
                const purchaseUnit =
                  String(row.purchaseUnit || row.unit || "").trim() || "qty";
                const baseUnit =
                  String(row.baseUnit || "pcs").trim() || "pcs";
                const stockIn = poReceivedBaseQty({
                  receivedQty: row.receivedQty,
                  receivedSubUnitQty: row.receivedSubUnitQty,
                  subQty: row.subQty,
                });
                const pending = poLinePendingQty({
                  qty: row.qty,
                  subUnitQty: row.subUnitQty,
                  receivedQty: row.receivedQty,
                  receivedSubUnitQty: row.receivedSubUnitQty,
                });
                const pendingLabel = formatPoQtyBits({
                  ...row,
                  qty: pending.pendingQty,
                  subUnitQty: pending.pendingSubUnitQty,
                });
                return (
                  <li key={row.itemId} className="space-y-2 py-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-white">
                        {row.itemName || row.itemCode || "Item"}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        Ordered:{" "}
                        {[
                          row.orderedQtyLabel !== "" &&
                          numMoney(row.orderedQtyLabel) > 0
                            ? `${formatMoney(
                                numMoney(row.orderedQtyLabel),
                                3
                              )} ${purchaseUnit}`
                            : null,
                          pack &&
                          row.orderedSubLabel !== "" &&
                          numMoney(row.orderedSubLabel) > 0
                            ? `${formatMoney(
                                numMoney(row.orderedSubLabel),
                                3
                              )} ${baseUnit}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(", ") || "0"}
                        {pack ? ` · ${formatPackHint(row)}` : ""}
                      </div>
                      {pending.pendingQty > 0 ||
                      pending.pendingSubUnitQty > 0 ? (
                        <div className="mt-0.5 text-xs font-medium text-orange-200">
                          To be received: {pendingLabel}
                        </div>
                      ) : (
                        <div className="mt-0.5 text-xs text-emerald-300">
                          Fully received
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      <label className={LABEL_CLASS}>
                        Received ({purchaseUnit})
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="any"
                          disabled={receiving}
                          value={row.receivedQty}
                          onChange={(e) =>
                            patchReceiveLine(row.itemId, {
                              receivedQty: e.target.value,
                            })
                          }
                          className={FIELD_NUMBER_CLASS}
                        />
                      </label>
                      {pack ? (
                        <label className={LABEL_CLASS}>
                          Received ({baseUnit})
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="any"
                            disabled={receiving}
                            value={row.receivedSubUnitQty}
                            onChange={(e) =>
                              patchReceiveLine(row.itemId, {
                                receivedSubUnitQty: e.target.value,
                              })
                            }
                            className={FIELD_NUMBER_CLASS}
                          />
                        </label>
                      ) : null}
                      <label className={LABEL_CLASS}>
                        Unit price ({currency})
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="any"
                          disabled={receiving}
                          value={row.unitRate}
                          onChange={(e) =>
                            patchReceiveLine(row.itemId, {
                              unitRate: e.target.value,
                            })
                          }
                          className={FIELD_NUMBER_CLASS}
                        />
                      </label>
                    </div>
                    <div className="text-xs text-slate-500">
                      Adds {formatMoney(stockIn, currencyDecimals)} {baseUnit}{" "}
                      to stock
                      {stockIn <= 0 ? " (skip line)" : ""}
                      {numMoney(row.unitRate) > 0
                        ? ` · cost ${formatMoney(
                            numMoney(row.unitRate),
                            currencyDecimals
                          )} ${currency}/${purchaseUnit}`
                        : ""}
                    </div>
                  </li>
                );
              })}
            </ul>
            {receiveHasPending ? (
              <div className="space-y-3 border-t border-slate-800 px-4 py-3">
                <div className="text-sm font-medium text-white">
                  Remaining items
                </div>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5">
                  <input
                    type="radio"
                    name="po-leftover"
                    className="mt-1"
                    checked={leftoverAction === PO_LEFTOVER_ACTION.KEEP}
                    disabled={receiving}
                    onChange={() => setLeftoverAction(PO_LEFTOVER_ACTION.KEEP)}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-100">
                      Keep as to be received
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      PO stays incomplete so you can receive the balance later.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5">
                  <input
                    type="radio"
                    name="po-leftover"
                    className="mt-1"
                    checked={leftoverAction === PO_LEFTOVER_ACTION.REMOVE}
                    disabled={receiving}
                    onChange={() =>
                      setLeftoverAction(PO_LEFTOVER_ACTION.REMOVE)
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-100">
                      Remove remaining and complete
                    </span>
                    <span className="mt-0.5 block text-xs text-slate-500">
                      Drop unreceived balance and mark this PO completed.
                    </span>
                  </span>
                </label>
                {leftoverAction === PO_LEFTOVER_ACTION.KEEP ? (
                  <label className={LABEL_CLASS}>
                    Note for to be received
                    <textarea
                      rows={2}
                      maxLength={500}
                      disabled={receiving}
                      value={receiveNote}
                      onChange={(e) => setReceiveNote(e.target.value)}
                      className={`${FIELD_CLASS} min-h-[4.5rem] resize-y`}
                      placeholder="e.g. vendor will deliver balance tomorrow"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                  </label>
                ) : null}
              </div>
            ) : null}
            <div className="sticky bottom-0 flex flex-wrap gap-2 border-t border-slate-800 bg-slate-950 px-4 py-3">
              <button
                type="button"
                disabled={receiving}
                onClick={closeReceive}
                className={`${BTN_SECONDARY} min-h-11 flex-1`}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  receiving ||
                  !receiveLines.length ||
                  (receiveHasPending &&
                    leftoverAction === PO_LEFTOVER_ACTION.KEEP &&
                    !String(receiveNote || "").trim())
                }
                onClick={() => void confirmReceive()}
                className={`${BTN_PRIMARY} min-h-11 flex-1`}
              >
                <CheckCircle2 className="h-4 w-4" />
                {receiving ? "Posting…" : "Post to stock"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {tab === "list" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className={`${LABEL_CLASS} w-full max-w-xs`}>
              Business date
              <DateInput
                value={listDate}
                onChange={(e) => setFilterDate(e.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <button
              type="button"
              className={`${BTN_PRIMARY} min-h-11`}
              onClick={() => {
                resetForm();
                setTab("entry");
              }}
            >
              <Plus className="h-4 w-4" />
              New PO
            </button>
          </div>

          <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50">
            <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
              <ClipboardList className="h-4 w-4 text-slate-400" aria-hidden />
              <h2 className="text-sm font-semibold text-white">
                Purchase orders
                <span className="ml-1.5 font-normal text-slate-400">
                  ({orders.length})
                </span>
              </h2>
            </div>
            {loadingOrders ? (
              <div className="px-4 py-10 text-center text-sm text-slate-500">
                Loading…
              </div>
            ) : !orders.length ? (
              <div className="px-4 py-10 text-center text-sm text-slate-500">
                No purchase orders
              </div>
            ) : (
              <>
                <ul>
                  {ordersPage.pageItems.map((order) => {
                    const lineCount =
                      order.lineCount || order.lines?.length || 0;
                    const orderStatus =
                      PO_STATUS_META[order.status] || null;
                    const amount = (order.lines || []).reduce(
                      (sum, row) =>
                        sum +
                        poLineTotal({
                          ...row,
                          unitRate: numMoney(
                            row.unitRate ??
                              row.unitCost ??
                              row.costPrice ??
                              row.purchasePrice ??
                              0
                          ),
                        }),
                      0
                    );
                    return (
                      <li
                        key={order.id}
                        className="border-b border-slate-800/80 px-4 py-4 last:border-b-0"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-base font-semibold tabular-nums text-white">
                                {order.poNumber || "PO"}
                              </span>
                              {orderStatus ? (
                                <span
                                  className={`rounded-lg px-2 py-0.5 text-xs font-semibold ${orderStatus.className}`}
                                >
                                  {orderStatus.label}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 truncate text-sm text-slate-300">
                              {order.vendorName || "No vendor"}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500">
                              <span>
                                {order.businessDate || listDate}
                              </span>
                              <span>
                                {lineCount} item{lineCount === 1 ? "" : "s"}
                              </span>
                              {amount > 0 ? (
                                <span className="tabular-nums text-sky-200">
                                  {formatMoney(amount, currencyDecimals)}{" "}
                                  {currency}
                                </span>
                              ) : null}
                            </div>
                            {order.notes ? (
                              <p className="mt-1 line-clamp-1 text-xs text-slate-500">
                                {order.notes}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <button
                              type="button"
                              className={`${BTN_SECONDARY} min-h-11 flex-1 sm:flex-none`}
                              onClick={() => loadOrder(order)}
                            >
                              Edit
                            </button>
                            {canReceiveOrder(order) ? (
                              <button
                                type="button"
                                className={`${BTN_SECONDARY} min-h-11 border-emerald-800/60 text-emerald-200 hover:bg-emerald-950/40`}
                                disabled={receiving}
                                onClick={() => openReceive(order)}
                              >
                                <PackageCheck className="h-4 w-4" />
                                Receive
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={`${BTN_SECONDARY} min-h-11`}
                              onClick={() => void handleCopyText(order)}
                            >
                              <Copy className="h-4 w-4" />
                              Copy
                            </button>
                            <button
                              type="button"
                              className={`${BTN_PRIMARY} min-h-11 flex-1 sm:flex-none`}
                              onClick={() => void handleShare(order)}
                            >
                              <Share2 className="h-4 w-4" />
                              Share
                            </button>
                            <button
                              type="button"
                              className={`${BTN_SECONDARY} min-h-11`}
                              onClick={() => handleDownloadPdf(order)}
                              aria-label={`Download ${order.poNumber || "PO"} PDF`}
                            >
                              <Download className="h-4 w-4" />
                              PDF
                            </button>
                            <button
                              type="button"
                              className={`${BTN_SECONDARY} min-h-11`}
                              onClick={() => handleDownloadExcel(order)}
                              aria-label={`Download ${order.poNumber || "PO"} Excel`}
                            >
                              <FileSpreadsheet className="h-4 w-4" />
                              Excel
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <ListPagination
                  page={ordersPage.page}
                  pageCount={ordersPage.pageCount}
                  total={ordersPage.total}
                  from={ordersPage.from}
                  to={ordersPage.to}
                  hasPrev={ordersPage.hasPrev}
                  hasNext={ordersPage.hasNext}
                  onPrev={ordersPage.goPrev}
                  onNext={ordersPage.goNext}
                />
              </>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
