import { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
  where,
} from "firebase/firestore";
import {
  deleteObject,
  getDownloadURL,
  ref as storageRef,
  uploadBytes,
} from "firebase/storage";
import {
  Boxes,
  CheckCircle2,
  ClipboardList,
  ImageIcon,
  PackagePlus,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { db, storage } from "../firebase";
import { useAuth } from "../context/AuthContext.jsx";
import ModuleExitButton from "../components/ModuleExitButton.jsx";
import ModuleHelpButton from "../components/ModuleHelpButton.jsx";
import DateInput from "../components/DateInput.jsx";
import { formatDateTimeValue } from "../utils/dateFormat.js";
import { useClient } from "../context/ClientContext.jsx";
import { useShift, useUnsavedWork } from "../context/shift-context.js";
import {
  downloadInventoryImportTemplate,
  exportInventoryCsv,
  parseInventoryCsv,
} from "../utils/inventoryBulk.js";
import { getInventoryLayout } from "../components/inventory/index.js";
import { normalizeShopType, shopTypeLabel } from "../utils/shopTypes.js";
import { formatMoney, formatMoneyLocale } from "../utils/money.js";

const CATEGORIES = ["COMMODITY", "CONSUMABLES", "ASSET"];
const FAST_WINDOW_DAYS = 30;
const FAST_THRESHOLD = 5;
const DEAD_DAYS = 60;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FIRESTORE_BATCH_LIMIT = 450;

const INPUT_CLASS =
  "w-full rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2.5 text-slate-200 shadow-inner transition-all duration-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50";
const LABEL_CLASS = "mb-1.5 block text-sm font-medium text-slate-300";

function num(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return formatMoney(value);
}

function itemCost(item) {
  return num(item?.cost);
}

function formatDate(timestamp, dateMs) {
  return formatDateTimeValue(timestamp || dateMs, "-");
}

function movementTimestamp(movement) {
  return (
    num(movement?.dateMs) ||
    (movement?.date?.toDate ? movement.date.toDate().getTime() : 0)
  );
}

function movementDisplayType(movement) {
  const type = String(movement?.type || "").toUpperCase();
  if (
    type === "DAMAGE" ||
    String(movement?.reason || "").toUpperCase() === "DAMAGE"
  ) {
    return "DAMAGE";
  }
  return type || "-";
}

function matchesItem(item, search) {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return false;
  return `${item?.itemCode || ""} ${item?.itemName || ""}`
    .toLowerCase()
    .includes(needle);
}

function safeImageName(name) {
  return String(name || "item-image")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(-100);
}

function ItemSearch({
  label,
  items,
  search,
  selectedId,
  onSearchChange,
  onSelect,
  placeholder,
}) {
  const [activeIndex, setActiveIndex] = useState(-1);
  const suggestions = useMemo(
    () =>
      search.trim() && !selectedId
        ? items.filter((item) => matchesItem(item, search)).slice(0, 10)
        : [],
    [items, search, selectedId]
  );

  function chooseItem(item) {
    if (!item) return;
    onSelect(item);
    setActiveIndex(-1);
  }

  return (
    <div>
      <label className={LABEL_CLASS}>{label}</label>
      <div className="relative">
        <Search
          size={17}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
        />
        <input
          value={search}
          onChange={(event) => {
            onSearchChange(event.target.value);
            setActiveIndex(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && suggestions.length > 0) {
              event.preventDefault();
              setActiveIndex((current) =>
                current < suggestions.length - 1 ? current + 1 : 0
              );
            } else if (event.key === "ArrowUp" && suggestions.length > 0) {
              event.preventDefault();
              setActiveIndex((current) =>
                current > 0 ? current - 1 : suggestions.length - 1
              );
            } else if (event.key === "Enter" && suggestions.length > 0) {
              event.preventDefault();
              chooseItem(suggestions[activeIndex >= 0 ? activeIndex : 0]);
            } else if (event.key === "Escape") {
              setActiveIndex(-1);
            }
          }}
          className={`${INPUT_CLASS} pl-10`}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={suggestions.length > 0}
        />
        {suggestions.length > 0 ? (
          <div className="absolute z-20 mt-2 max-h-64 w-full overflow-y-auto rounded-xl border border-slate-700 bg-slate-950">
            {suggestions.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => chooseItem(item)}
                className={`flex w-full items-center justify-between gap-4 border-b border-slate-800 px-3 py-2.5 text-left last:border-0 hover:bg-slate-900 ${
                  activeIndex === index ? "bg-slate-800" : ""
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-100">
                    {item.itemName}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {item.itemCode || "No item code"} · {item.category || "No category"}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-slate-400">
                  Stock {money(item.currentStock)}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SummaryBadge({ label, value }) {
  return (
    <span className="rounded-full border border-slate-800 bg-slate-900 px-3 py-1 text-sm text-slate-300">
      {label}: <b className="text-slate-100">{value}</b>
    </span>
  );
}

export default function Inventory() {
  const navigate = useNavigate();
  const { activeClientId, activeClientData } = useClient();
  const { user, displayName } = useAuth();
  const { activeShift } = useShift();

  const [tab, setTab] = useState("entry");
  const [items, setItems] = useState([]);
  const [movementMap, setMovementMap] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [category, setCategory] = useState(CATEGORIES[0]);
  const [itemCode, setItemCode] = useState("");
  const [itemName, setItemName] = useState("");
  const [cost, setCost] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
  // Optional vertical fields (safe defaults; ignored by older readers)
  const [barcode, setBarcode] = useState("");
  const [minStock, setMinStock] = useState("0");
  const [batchNo, setBatchNo] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [baseUnit, setBaseUnit] = useState("pcs");
  const [recipeNotes, setRecipeNotes] = useState("");
  const [unitsPerCarton, setUnitsPerCarton] = useState("12");
  const [wholesalePrice, setWholesalePrice] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState("");
  const [imageStatus, setImageStatus] = useState("No image selected");
  const [savingItem, setSavingItem] = useState(false);
  const [entryMessage, setEntryMessage] = useState("");
  const [editingItemId, setEditingItemId] = useState("");
  const [existingImage, setExistingImage] = useState({
    imageUrl: "",
    imagePath: "",
    imageName: "",
    imageStatus: "NONE",
  });
  const entryFormRef = useRef(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importPreview, setImportPreview] = useState(null);
  const [skipDuplicateCodes, setSkipDuplicateCodes] = useState(true);
  const fileInputRef = useRef(null);

  const [stockSearch, setStockSearch] = useState("");
  const [stockRows, setStockRows] = useState([]);
  const [savingStock, setSavingStock] = useState(false);
  const [stockMessage, setStockMessage] = useState("");

  useUnsavedWork(
    "inventory",
    "Inventory",
    Boolean(
      editingItemId ||
        stockRows.length ||
        itemCode.trim() ||
        itemName.trim() ||
        String(cost || "").trim() ||
        String(sellingPrice || "").trim() ||
        imageFile
    )
  );

  const [auditSearch, setAuditSearch] = useState("");
  const [auditItemId, setAuditItemId] = useState("");
  const [auditMovements, setAuditMovements] = useState([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [auditTypeFilter, setAuditTypeFilter] = useState("ALL");
  const [auditFromDate, setAuditFromDate] = useState("");
  const [auditToDate, setAuditToDate] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");

  useEffect(() => {
    if (!activeClientId) {
      setItems([]);
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const inventoryQuery = query(
      collection(db, "inventory"),
      where("clientId", "==", activeClientId)
    );
    return onSnapshot(
      inventoryQuery,
      (snapshot) => {
        const next = snapshot.docs
          .map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }))
          .sort((a, b) =>
            String(a.itemName || "").localeCompare(String(b.itemName || ""))
          );
        setItems(next);
        setLoading(false);
      },
      (snapshotError) => {
        setError(snapshotError?.message || "Failed to load inventory.");
        setLoading(false);
      }
    );
  }, [activeClientId]);

  useEffect(() => {
    if (!activeClientId) {
      setMovementMap({});
      return undefined;
    }

    const movementQuery = query(
      collection(db, "inventory_movements"),
      where("clientId", "==", activeClientId),
      limit(5000)
    );
    return onSnapshot(
      movementQuery,
      (snapshot) => {
        const now = Date.now();
        const fastCutoff = now - FAST_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        const next = {};

        snapshot.docs.forEach((movementDoc) => {
          const movement = movementDoc.data() || {};
          if (!movement.itemId) return;
          const timestamp =
            num(movement.dateMs) ||
            (movement.date?.toDate ? movement.date.toDate().getTime() : 0);
          if (!next[movement.itemId]) {
            next[movement.itemId] = { recentCount: 0, lastMovementMs: 0 };
          }
          if (timestamp >= fastCutoff) next[movement.itemId].recentCount += 1;
          if (timestamp > next[movement.itemId].lastMovementMs) {
            next[movement.itemId].lastMovementMs = timestamp;
          }
        });
        setMovementMap(next);
      },
      () => setMovementMap({})
    );
  }, [activeClientId]);

  useEffect(() => {
    if (!activeClientId || !auditItemId) {
      setAuditMovements([]);
      setLoadingAudit(false);
      return undefined;
    }

    setLoadingAudit(true);
    const movementQuery = query(
      collection(db, "inventory_movements"),
      where("clientId", "==", activeClientId),
      where("itemId", "==", auditItemId),
      limit(1000)
    );
    return onSnapshot(
      movementQuery,
      (snapshot) => {
        const next = snapshot.docs
          .map((movementDoc) => ({ id: movementDoc.id, ...movementDoc.data() }))
          .sort(
            (a, b) =>
              (num(b.dateMs) ||
                (b.date?.toDate ? b.date.toDate().getTime() : 0)) -
              (num(a.dateMs) ||
                (a.date?.toDate ? a.date.toDate().getTime() : 0))
          );
        setAuditMovements(next);
        setLoadingAudit(false);
      },
      (snapshotError) => {
        setError(snapshotError?.message || "Failed to load item history.");
        setLoadingAudit(false);
      }
    );
  }, [activeClientId, auditItemId]);

  useEffect(
    () => () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    },
    [imagePreview]
  );

  const auditItem = useMemo(
    () => items.find((item) => item.id === auditItemId) || null,
    [items, auditItemId]
  );

  const dashboard = useMemo(() => {
    const now = Date.now();
    const deadCutoff = now - DEAD_DAYS * 24 * 60 * 60 * 1000;
    let totalValue = 0;
    let lowCount = 0;
    let fastCount = 0;
    let deadCount = 0;

    items.forEach((item) => {
      totalValue += num(item.currentStock) * itemCost(item);
      if (num(item.currentStock) <= num(item.minStock || 0)) lowCount += 1;
      const movement = movementMap[item.id];
      if (num(movement?.recentCount) >= FAST_THRESHOLD) fastCount += 1;
      if (!movement?.lastMovementMs || movement.lastMovementMs <= deadCutoff) {
        deadCount += 1;
      }
    });
    return { totalValue, lowCount, fastCount, deadCount };
  }, [items, movementMap]);

  const catalogItems = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => {
      const hay = `${item.itemCode || ""} ${item.itemName || ""} ${item.barcode || ""} ${item.category || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, catalogSearch]);

  const auditMetrics = useMemo(
    () =>
      auditMovements.reduce(
        (totals, movement) => {
          const type = String(movement.type || "").toUpperCase();
          const isDamage =
            type === "DAMAGE" ||
            String(movement.reason || "").toUpperCase() === "DAMAGE";
          if (type === "IN") totals.totalIn += Math.abs(num(movement.qty));
          if (isDamage) {
            totals.totalDamaged += Math.abs(num(movement.qty));
          } else if (type === "OUT") {
            totals.totalOut += Math.abs(num(movement.qty));
          }
          return totals;
        },
        { totalIn: 0, totalOut: 0, totalDamaged: 0 }
      ),
    [auditMovements]
  );

  const filteredAuditMovements = useMemo(() => {
    const fromMs = auditFromDate
      ? new Date(`${auditFromDate}T00:00:00`).getTime()
      : 0;
    const toMs = auditToDate
      ? new Date(`${auditToDate}T23:59:59.999`).getTime()
      : Number.POSITIVE_INFINITY;

    return auditMovements.filter((movement) => {
      const typeMatches =
        auditTypeFilter === "ALL" ||
        movementDisplayType(movement) === auditTypeFilter;
      const timestamp = movementTimestamp(movement);
      const dateMatches =
        (!auditFromDate && !auditToDate) ||
        (timestamp > 0 && timestamp >= fromMs && timestamp <= toMs);
      return typeMatches && dateMatches;
    });
  }, [auditMovements, auditTypeFilter, auditFromDate, auditToDate]);

  function clearItemForm() {
    setEditingItemId("");
    setExistingImage({
      imageUrl: "",
      imagePath: "",
      imageName: "",
      imageStatus: "NONE",
    });
    setCategory(CATEGORIES[0]);
    setItemCode("");
    setItemName("");
    setCost("");
    setSellingPrice("");
    setBarcode("");
    setMinStock("0");
    setBatchNo("");
    setExpiryDate("");
    setBaseUnit("pcs");
    setRecipeNotes("");
    setUnitsPerCarton("12");
    setWholesalePrice("");
    setImageFile(null);
    setImagePreview("");
    setImageStatus("No image selected");
  }

  function startEditItem(item) {
    if (!item?.id) return;
    setTab("entry");
    setEditingItemId(item.id);
    setCategory(
      CATEGORIES.includes(item.category) ? item.category : CATEGORIES[0]
    );
    setItemCode(String(item.itemCode || ""));
    setItemName(String(item.itemName || ""));
    setCost(String(num(item.cost)));
    setSellingPrice(String(num(item.sellingPrice)));
    setBarcode(String(item.barcode || ""));
    setMinStock(String(num(item.minStock)));
    setBatchNo(String(item.batchNo || ""));
    setExpiryDate(String(item.expiryDate || ""));
    setBaseUnit(String(item.baseUnit || "pcs"));
    setRecipeNotes(String(item.recipeNotes || ""));
    setUnitsPerCarton(String(Math.max(1, num(item.unitsPerCarton) || 12)));
    setWholesalePrice(
      item.wholesalePrice === undefined || item.wholesalePrice === null
        ? ""
        : String(num(item.wholesalePrice))
    );
    setImageFile(null);
    const url = String(item.imageUrl || "");
    setExistingImage({
      imageUrl: url,
      imagePath: String(item.imagePath || ""),
      imageName: String(item.imageName || ""),
      imageStatus: String(item.imageStatus || (url ? "UPLOADED" : "NONE")),
    });
    setImagePreview(url);
    setImageStatus(
      url
        ? String(item.imageName || "Current image")
        : "No image selected"
    );
    setEntryMessage(`Editing “${item.itemName || item.itemCode || "item"}”.`);
    setError("");
    setTimeout(() => {
      entryFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 40);
  }

  function cancelItemEntry() {
    clearItemForm();
    setEntryMessage("");
    setError("");
  }

  function closeItemEntry() {
    cancelItemEntry();
    navigate("/dashboard");
  }

  function handleExportItems() {
    if (!activeClientId) {
      setError("Please select a client first.");
      return;
    }
    setError("");
    exportInventoryCsv({
      items,
      shopName: activeClientData?.name || "shop",
    });
    setEntryMessage(
      `Exported ${items.length} item${items.length === 1 ? "" : "s"} for ${
        activeClientData?.name || "this shop"
      }.`
    );
  }

  function openImportItems() {
    setImportError("");
    setImportPreview(null);
    setSkipDuplicateCodes(true);
    setImportOpen(true);
  }

  function closeImportItems() {
    setImportOpen(false);
    setImporting(false);
    setImportError("");
    setImportPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onImportFileChange(event) {
    const file = event.target.files?.[0];
    setImportError("");
    setImportPreview(null);
    if (!file) return;

    try {
      const text = await file.text();
      const { rows, errors } = parseInventoryCsv(text);
      if (rows.length === 0 && errors.length === 0) {
        setImportError("No item rows found in the file.");
        return;
      }
      setImportPreview({ rows, errors, fileName: file.name });
    } catch (err) {
      console.error("❌ Read inventory CSV error:", err);
      setImportError(err?.message || "Failed to read CSV file.");
    }
  }

  async function handleImportConfirm() {
    if (!activeClientId) {
      setImportError("Please select a client first.");
      return;
    }
    const rows = importPreview?.rows || [];
    if (rows.length === 0) {
      setImportError("Nothing to import.");
      return;
    }

    setImporting(true);
    setImportError("");
    setError("");
    setEntryMessage("");

    try {
      const existingCodes = new Set(
        items.map((item) =>
          String(item.itemCode || "")
            .trim()
            .toLowerCase()
        )
      );

      let created = 0;
      let skipped = 0;
      let batch = writeBatch(db);
      let opsInBatch = 0;
      const nowMs = Date.now();

      async function flushBatch() {
        if (opsInBatch === 0) return;
        await batch.commit();
        batch = writeBatch(db);
        opsInBatch = 0;
      }

      for (const row of rows) {
        const codeKey = row.itemCode.toLowerCase();
        if (skipDuplicateCodes && existingCodes.has(codeKey)) {
          skipped += 1;
          continue;
        }

        const itemRef = doc(collection(db, "inventory"));
        batch.set(itemRef, {
          clientId: activeClientId,
          category: row.category,
          itemCode: row.itemCode,
          itemName: row.itemName,
          cost: row.cost,
          sellingPrice: row.sellingPrice,
          imageUrl: "",
          imagePath: "",
          imageName: "",
          imageStatus: "NONE",
          currentStock: 0,
          createdAt: serverTimestamp(),
          createdAtMs: nowMs,
          createdBy: user?.uid || null,
          updatedAt: serverTimestamp(),
          updatedBy: user?.uid || null,
        });
        existingCodes.add(codeKey);
        created += 1;
        opsInBatch += 1;

        if (opsInBatch >= FIRESTORE_BATCH_LIMIT) {
          await flushBatch();
        }
      }

      await flushBatch();
      closeImportItems();
      setEntryMessage(
        `Imported ${created} item${created === 1 ? "" : "s"} into ${
          activeClientData?.name || "this shop"
        }${
          skipped
            ? ` (${skipped} duplicate code${skipped === 1 ? "" : "s"} skipped)`
            : ""
        }.`
      );
    } catch (err) {
      console.error("❌ Import inventory error:", err);
      setImportError(err?.message || "Failed to import items.");
    } finally {
      setImporting(false);
    }
  }

  function handleImageChange(event) {
    const file = event.target.files?.[0] || null;
    setEntryMessage("");

    if (!file) {
      setImageFile(null);
      setImagePreview("");
      setImageStatus("No image selected");
      return;
    }
    if (!file.type.startsWith("image/")) {
      event.target.value = "";
      setImageStatus("Invalid file type");
      setEntryMessage("Please select an image file.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      event.target.value = "";
      setImageStatus("Image exceeds 5 MB");
      setEntryMessage("Item image must be 5 MB or smaller.");
      return;
    }

    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
    setImageStatus(`${file.name} ready to upload`);
  }

  async function saveItem(event) {
    event.preventDefault();
    setError("");
    setEntryMessage("");

    const cleanCode = itemCode.trim();
    const cleanName = itemName.trim();
    const costValue = num(cost);
    const sellingValue = num(sellingPrice);
    const isEditing = Boolean(editingItemId);

    if (!activeClientId) return;
    if (!cleanCode) return setEntryMessage("Item Code is required.");
    if (!cleanName) return setEntryMessage("Name is required.");
    if (cost === "" || costValue < 0) {
      return setEntryMessage("Enter a valid non-negative Cost.");
    }
    if (sellingPrice === "" || sellingValue < 0) {
      return setEntryMessage("Enter a valid non-negative Selling Price.");
    }
    const duplicateCode = items.some(
      (item) =>
        item.id !== editingItemId &&
        String(item.itemCode || "").trim().toLowerCase() === cleanCode.toLowerCase()
    );
    if (duplicateCode) return setEntryMessage("This Item Code already exists.");

    const itemRef = isEditing
      ? doc(db, "inventory", editingItemId)
      : doc(collection(db, "inventory"));
    let uploadedPath = "";
    setSavingItem(true);
    setImageStatus(imageFile ? "Uploading image…" : imageStatus);

    try {
      let imageUrl = existingImage.imageUrl || "";
      let imagePath = existingImage.imagePath || "";
      let imageName = existingImage.imageName || "";
      let nextImageStatus = existingImage.imageStatus || "NONE";

      if (imageFile) {
        uploadedPath = `inventory/${activeClientId}/${itemRef.id}/${Date.now()}-${safeImageName(
          imageFile.name
        )}`;
        const fileRef = storageRef(storage, uploadedPath);
        await uploadBytes(fileRef, imageFile, { contentType: imageFile.type });
        imageUrl = await getDownloadURL(fileRef);
        imagePath = uploadedPath;
        imageName = imageFile.name;
        nextImageStatus = "UPLOADED";
      }

      const sharedFields = {
        category,
        itemCode: cleanCode,
        itemName: cleanName,
        cost: costValue,
        sellingPrice: sellingValue,
        barcode: String(barcode || "").trim(),
        minStock: Math.max(0, num(minStock)),
        batchNo: String(batchNo || "").trim(),
        expiryDate: String(expiryDate || "").trim(),
        baseUnit: String(baseUnit || "pcs").trim() || "pcs",
        recipeNotes: String(recipeNotes || "").trim(),
        unitsPerCarton: Math.max(1, num(unitsPerCarton) || 12),
        wholesalePrice: Math.max(0, num(wholesalePrice)),
        imageUrl,
        imagePath,
        imageName,
        imageStatus: imageUrl ? "UPLOADED" : nextImageStatus || "NONE",
        updatedAt: serverTimestamp(),
        updatedBy: user?.uid || null,
      };

      if (isEditing) {
        await updateDoc(itemRef, sharedFields);
        setEntryMessage("Item updated successfully.");
      } else {
        await setDoc(itemRef, {
          clientId: activeClientId,
          ...sharedFields,
          currentStock: 0,
          createdAt: serverTimestamp(),
          createdAtMs: Date.now(),
          createdBy: user?.uid || null,
        });
        setEntryMessage("Item saved successfully.");
      }

      clearItemForm();
    } catch (saveError) {
      if (uploadedPath) {
        try {
          await deleteObject(storageRef(storage, uploadedPath));
        } catch {
          // Best-effort cleanup if the Firestore write fails after upload.
        }
      }
      setImageStatus(imageFile ? "Upload failed" : imageStatus);
      setError(saveError?.message || "Failed to save item.");
    } finally {
      setSavingItem(false);
    }
  }

  async function saveStockUpdate(event) {
    event.preventDefault();
    setError("");
    setStockMessage("");

    if (!activeClientId || stockRows.length === 0) {
      return setStockMessage("Add at least one item.");
    }
    if (
      stockRows.some(
        (row) =>
          row.currentStock === "" ||
          num(row.currentStock) < 0 ||
          row.newStock === "" ||
          num(row.newStock) < 0 ||
          row.damagedQty === "" ||
          num(row.damagedQty) < 0 ||
          num(row.currentStock) + num(row.newStock) - num(row.damagedQty) < 0 ||
          row.cost === "" ||
          num(row.cost) < 0 ||
          row.sellingPrice === "" ||
          num(row.sellingPrice) < 0
      )
    ) {
      return setStockMessage(
        "All values must be non-negative, and Damaged Qty cannot exceed available stock."
      );
    }

    setSavingStock(true);
    try {
      const preparedRows = stockRows.map((row) => ({
        row,
        itemRef: doc(db, "inventory", row.itemId),
        adjustmentRef: doc(collection(db, "inventory_movements")),
        receivingRef: doc(collection(db, "inventory_movements")),
        damageRef: doc(collection(db, "inventory_movements")),
      }));

      await runTransaction(db, async (transaction) => {
        const snapshots = [];
        for (const prepared of preparedRows) {
          snapshots.push(await transaction.get(prepared.itemRef));
        }

        snapshots.forEach((snapshot, index) => {
          const { row } = preparedRows[index];
          if (!snapshot.exists()) {
            throw new Error(`${row.itemName} no longer exists.`);
          }
          const item = snapshot.data();
          if (item.clientId !== activeClientId) {
            throw new Error(`${row.itemName} belongs to another client.`);
          }
          if (Math.abs(num(item.currentStock) - num(row.originalStock)) > 0.000001) {
            throw new Error(
              `${row.itemName} stock changed after selection. Remove and add it again.`
            );
          }
        });

        preparedRows.forEach(
          ({ row, itemRef, adjustmentRef, receivingRef, damageRef }) => {
          const originalStock = num(row.originalStock);
          const editedCurrentStock = num(row.currentStock);
          const newStock = num(row.newStock);
          const damagedQty = num(row.damagedQty);
          const stockBeforeDamage = editedCurrentStock + newStock;
          const finalStock = stockBeforeDamage - damagedQty;
          const reconciliationDifference = editedCurrentStock - originalStock;
          const timestamp = Date.now();
          const movementBase = {
            clientId: activeClientId,
            itemId: row.itemId,
            itemCode: row.itemCode || "",
            itemName: row.itemName || "",
            shiftId: activeShift?.status === "OPEN" ? activeShift.id : "",
            userId: user?.uid || "",
            userName: displayName || "",
            createdBy: user?.uid || null,
            date: new Date(timestamp),
            dateMs: timestamp,
            createdAt: serverTimestamp(),
          };

          const itemUpdate = {
            currentStock: finalStock,
            updatedAt: serverTimestamp(),
            updatedBy: user?.uid || null,
          };
          if (num(row.cost) !== num(row.originalCost)) {
            itemUpdate.cost = num(row.cost);
          }
          if (
            num(row.sellingPrice) !== num(row.originalSellingPrice)
          ) {
            itemUpdate.sellingPrice = num(row.sellingPrice);
          }
          transaction.update(itemRef, itemUpdate);

          if (reconciliationDifference !== 0) {
            transaction.set(adjustmentRef, {
              ...movementBase,
              type: reconciliationDifference > 0 ? "IN" : "OUT",
              qty: Math.abs(reconciliationDifference),
              oldStock: originalStock,
              totalStock: editedCurrentStock,
              source: "STOCK_RECONCILIATION",
              reason: "CURRENT_STOCK_EDIT",
            });
          }

          if (newStock > 0) {
            transaction.set(receivingRef, {
              ...movementBase,
              type: "IN",
              qty: newStock,
              oldStock: editedCurrentStock,
              totalStock: finalStock,
              source: "STOCK_RECEIVING",
              reason: "NEW_STOCK",
            });
          }

          if (damagedQty > 0) {
            transaction.set(damageRef, {
              ...movementBase,
              type: "OUT",
              qty: damagedQty,
              oldStock: stockBeforeDamage,
              totalStock: finalStock,
              source: "STOCK_DAMAGE",
              reason: "DAMAGE",
            });
          }
        }
        );
      });

      setStockRows([]);
      setStockSearch("");
      setStockMessage(`${stockRows.length} item(s) updated successfully.`);
    } catch (saveError) {
      setError(saveError?.message || "Failed to update stock.");
    } finally {
      setSavingStock(false);
    }
  }

  function selectStockItem(item) {
    if (stockRows.some((row) => row.itemId === item.id)) {
      setStockMessage(`${item.itemName} is already in the update list.`);
      setStockSearch("");
      return;
    }
    if (stockRows.length >= 100) {
      setStockMessage("A maximum of 100 items can be updated at once.");
      return;
    }

    setStockRows((current) => [
      ...current,
      {
        itemId: item.id,
        itemCode: item.itemCode || "",
        itemName: item.itemName || "",
        originalStock: num(item.currentStock),
        currentStock: String(num(item.currentStock)),
        newStock: "0",
        damagedQty: "0",
        originalCost: itemCost(item),
        cost: String(itemCost(item)),
        originalSellingPrice: num(item.sellingPrice),
        sellingPrice: String(num(item.sellingPrice)),
      },
    ]);
    setStockSearch("");
    setStockMessage("");
  }

  function updateStockRow(itemId, field, value) {
    setStockRows((current) =>
      current.map((row) => (row.itemId === itemId ? { ...row, [field]: value } : row))
    );
  }

  function removeStockRow(itemId) {
    setStockRows((current) => current.filter((row) => row.itemId !== itemId));
  }

  function selectAuditItem(item) {
    setAuditItemId(item.id);
    setAuditSearch("");
    setAuditTypeFilter("ALL");
    setAuditFromDate("");
    setAuditToDate("");
  }

  if (!activeClientId) {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-slate-100">Inventory</h1>
        <p className="mt-2 text-slate-400">Please select a client/shop first.</p>
      </div>
    );
  }

  const shopType = normalizeShopType(activeClientData?.shop_type);
  const InventoryLayout = getInventoryLayout(shopType);

  const inventoryLayoutProps = {
    saveItem,
    categories: CATEGORIES,
    category,
    setCategory,
    itemCode,
    setItemCode,
    itemName,
    setItemName,
    cost,
    setCost,
    sellingPrice,
    setSellingPrice,
    barcode,
    setBarcode,
    minStock,
    setMinStock,
    batchNo,
    setBatchNo,
    expiryDate,
    setExpiryDate,
    baseUnit,
    setBaseUnit,
    recipeNotes,
    setRecipeNotes,
    unitsPerCarton,
    setUnitsPerCarton,
    wholesalePrice,
    setWholesalePrice,
    imagePreview,
    imageStatus,
    handleImageChange,
    entryMessage,
    savingItem,
    isEditing: Boolean(editingItemId),
    cancelItemEntry,
    handleExportItems,
    openImportItems,
    closeItemEntry,
    loading,
    activeClientId,
  };

  const tabs = [
    { id: "entry", label: "Item Entry", icon: <PackagePlus size={16} /> },
    { id: "stock", label: "Stock Update", icon: <Boxes size={16} /> },
    { id: "audit", label: "Item Audit", icon: <ClipboardList size={16} /> },
  ];

  function handleCatalogItemSelect(item) {
    if (!item?.id) return;
    if (tab === "stock") {
      selectStockItem(item);
      return;
    }
    if (tab === "audit") {
      selectAuditItem(item);
      return;
    }
    startEditItem(item);
  }

  const inventoryCatalogPanel = (
    <div className="mx-auto mt-6 max-w-5xl rounded-xl border border-slate-700/50 bg-slate-900/80 p-5 shadow-xl shadow-black/20 backdrop-blur-sm sm:p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-100">Inventory Items</h2>
          <p className="mt-1 text-sm text-slate-400">
            {loading
              ? "Loading catalog…"
              : `${catalogItems.length} item${catalogItems.length === 1 ? "" : "s"}${
                  catalogSearch.trim() ? " matching search" : " in catalog"
                }`}
          </p>
        </div>
        <label className="relative block w-full sm:w-72">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
          />
          <input
            value={catalogSearch}
            onChange={(event) => setCatalogSearch(event.target.value)}
            className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 pl-9 pr-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30"
            placeholder="Search code, name, barcode…"
            aria-label="Search inventory items"
          />
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="min-w-[820px] w-full text-sm">
          <thead className="border-b border-slate-700/50 bg-slate-800/50">
            <tr className="text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
              <th className="p-3 font-medium">Item</th>
              <th className="p-3 font-medium">Category</th>
              <th className="p-3 font-medium">Barcode</th>
              <th className="p-3 text-right font-medium">Cost</th>
              <th className="p-3 text-right font-medium">Selling</th>
              <th className="p-3 text-right font-medium">Stock</th>
              <th className="p-3 text-center font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-500">
                  Loading items…
                </td>
              </tr>
            ) : catalogItems.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center italic text-slate-500">
                  {catalogSearch.trim()
                    ? "No items match your search."
                    : "No inventory items yet. Save an item on Item Entry to start the catalog."}
                </td>
              </tr>
            ) : (
              catalogItems.map((item) => {
                const low = num(item.currentStock) <= num(item.minStock || 0);
                const inStockList = stockRows.some((row) => row.itemId === item.id);
                const isSelected =
                  tab === "entry"
                    ? editingItemId === item.id
                    : tab === "stock"
                      ? inStockList
                      : auditItemId === item.id;
                const actionLabel =
                  tab === "stock"
                    ? inStockList
                      ? "Added"
                      : "Select"
                    : tab === "audit"
                      ? auditItemId === item.id
                        ? "Selected"
                        : "Select"
                      : "Edit";

                return (
                  <tr
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleCatalogItemSelect(item)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleCatalogItemSelect(item);
                      }
                    }}
                    className={`cursor-pointer border-b border-slate-800/70 last:border-0 hover:bg-slate-800/30 ${
                      isSelected ? "bg-blue-950/35 ring-1 ring-inset ring-blue-500/20" : ""
                    }`}
                  >
                    <td className="p-3">
                      <p className="font-medium text-slate-100">
                        {item.itemName || "—"}
                      </p>
                      <p className="mt-0.5 font-mono text-xs text-slate-500">
                        {item.itemCode || "No code"}
                      </p>
                    </td>
                    <td className="p-3 text-slate-300">{item.category || "—"}</td>
                    <td className="p-3 font-mono text-xs text-slate-400">
                      {item.barcode || "—"}
                    </td>
                    <td className="p-3 text-right tabular-nums text-slate-200">
                      {money(itemCost(item))}
                    </td>
                    <td className="p-3 text-right tabular-nums text-slate-200">
                      {money(item.sellingPrice)}
                    </td>
                    <td
                      className={`p-3 text-right tabular-nums font-medium ${
                        low ? "text-amber-300" : "text-slate-100"
                      }`}
                    >
                      {money(item.currentStock)}
                    </td>
                    <td className="p-3 text-center">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCatalogItemSelect(item);
                        }}
                        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                          isSelected
                            ? "border-blue-700/60 bg-blue-950/50 text-blue-200"
                            : "border-slate-700 bg-slate-950 text-slate-200 hover:bg-slate-800 hover:text-white"
                        }`}
                        aria-label={`${actionLabel} ${item.itemName || "item"}`}
                      >
                        {tab === "entry" ? <Pencil size={13} /> : null}
                        {actionLabel}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="p-6">
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Inventory</h1>
          <p className="mt-1 text-sm text-slate-400">
            {activeClientData?.name || activeClientId}
            <span className="text-slate-600"> · </span>
            {shopTypeLabel(shopType)}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <SummaryBadge
              label="Total Stock Value"
              value={money(dashboard.totalValue)}
            />
            <SummaryBadge label="Low Stock Alerts" value={dashboard.lowCount} />
            <SummaryBadge
              label={`Fast Moving (${FAST_WINDOW_DAYS}d)`}
              value={dashboard.fastCount}
            />
            <SummaryBadge
              label={`Dead Stock (${DEAD_DAYS}d)`}
              value={dashboard.deadCount}
            />
          </div>
        </div>

        <div className="ml-auto flex items-start gap-2">
          <ModuleHelpButton moduleId="inventory" />
          <div className="inline-flex rounded-xl border border-slate-800 bg-slate-950 p-1 lg:mt-0">
            {tabs.map(({ id, label, icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  tab === id
                    ? "bg-blue-600 text-white"
                    : "text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                }`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
          <ModuleExitButton ariaLabel="Close inventory module" />
        </div>
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {tab === "entry" ? (
        <>
          <div ref={entryFormRef}>
            <InventoryLayout {...inventoryLayoutProps} />
          </div>
          {inventoryCatalogPanel}
        </>
      ) : null}

      {tab === "stock" ? (
        <>
        <form
          onSubmit={saveStockUpdate}
          className="mx-auto mt-6 max-w-5xl rounded-xl border border-slate-700/50 bg-slate-900/80 p-5 shadow-xl shadow-black/20 backdrop-blur-sm sm:p-6"
        >
          <div className="mb-4">
            <h2 className="font-semibold text-slate-100">Stock Update</h2>
            <p className="mt-1 text-sm text-slate-400">
              Add multiple items, reconcile current stock, and record new arrivals.
            </p>
          </div>

          <ItemSearch
            label="Add Item"
            items={items}
            search={stockSearch}
            selectedId=""
            onSearchChange={setStockSearch}
            onSelect={selectStockItem}
            placeholder="Search by item code or name..."
          />

          <div className="mt-5 overflow-x-auto rounded-xl border border-slate-800">
            <table className="min-w-[1060px] w-full text-sm">
              <thead className="border-b border-slate-700/50 bg-slate-800/50">
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-slate-400">
                  <th className="p-3 font-medium">Item</th>
                  <th className="p-3 text-right font-medium">Current Cost</th>
                  <th className="p-3 text-right font-medium">Selling Price</th>
                  <th className="p-3 text-right font-medium">Current Stock</th>
                  <th className="p-3 text-right font-medium">New Stock</th>
                  <th className="p-3 text-right font-medium">Damaged</th>
                  <th className="p-3 text-right font-medium">Final Stock</th>
                  <th className="p-3 text-center font-medium">Remove</th>
                </tr>
              </thead>
              <tbody>
                {stockRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-6 text-center italic text-slate-500">
                      Search and select items to build a bulk stock update.
                    </td>
                  </tr>
                ) : (
                  stockRows.map((row) => {
                    const finalStock =
                      num(row.currentStock) +
                      num(row.newStock) -
                      num(row.damagedQty);
                    const compactInputClass =
                      "w-28 rounded-lg border border-slate-800 bg-slate-950/50 px-2.5 py-2 text-right text-slate-200 shadow-inner transition-all duration-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50";

                    return (
                      <tr
                        key={row.itemId}
                        className="border-b border-slate-800/70 align-middle last:border-0 hover:bg-slate-800/20"
                      >
                        <td className="p-3">
                          <p className="font-medium text-slate-100">{row.itemName}</p>
                          <p className="mt-0.5 text-xs text-slate-500">
                            {row.itemCode || "No item code"}
                          </p>
                        </td>
                        <td className="p-3 text-right">
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="any"
                            value={row.cost}
                            onChange={(event) =>
                              updateStockRow(row.itemId, "cost", event.target.value)
                            }
                            className={compactInputClass}
                            aria-label={`${row.itemName} current cost`}
                          />
                        </td>
                        <td className="p-3 text-right">
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="any"
                            value={row.sellingPrice}
                            onChange={(event) =>
                              updateStockRow(
                                row.itemId,
                                "sellingPrice",
                                event.target.value
                              )
                            }
                            className={compactInputClass}
                            aria-label={`${row.itemName} selling price`}
                          />
                        </td>
                        <td className="p-3 text-right">
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="any"
                            value={row.currentStock}
                            onChange={(event) =>
                              updateStockRow(
                                row.itemId,
                                "currentStock",
                                event.target.value
                              )
                            }
                            className={compactInputClass}
                            aria-label={`${row.itemName} current stock`}
                          />
                        </td>
                        <td className="p-3 text-right">
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="any"
                            value={row.newStock}
                            onChange={(event) =>
                              updateStockRow(row.itemId, "newStock", event.target.value)
                            }
                            className={`${compactInputClass} border-blue-700/70`}
                            aria-label={`${row.itemName} new stock`}
                          />
                        </td>
                        <td className="p-3 text-right">
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="any"
                            value={row.damagedQty}
                            onChange={(event) =>
                              updateStockRow(
                                row.itemId,
                                "damagedQty",
                                event.target.value
                              )
                            }
                            className={`${compactInputClass} border-orange-800/70`}
                            aria-label={`${row.itemName} damaged quantity`}
                          />
                        </td>
                        <td className="p-3 text-right">
                          <div className="inline-flex min-w-28 justify-end rounded-lg bg-blue-900/20 px-3 py-2 font-semibold text-blue-300">
                            {money(finalStock)}
                          </div>
                        </td>
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => removeStockRow(row.itemId)}
                            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-rose-950/40 hover:text-rose-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
                            aria-label={`Remove ${row.itemName}`}
                            title="Remove item"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {stockMessage ? (
            <p className="mt-4 text-sm text-slate-300">{stockMessage}</p>
          ) : null}

          <div className="mt-5 flex justify-end">
            <button
              type="submit"
              disabled={savingStock || stockRows.length === 0}
              className="transform rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white shadow-lg shadow-blue-900/20 transition-all duration-200 hover:-translate-y-0.5 hover:bg-blue-500 disabled:translate-y-0 disabled:opacity-50"
            >
              {savingStock ? "Saving…" : "Save Stock Update"}
            </button>
          </div>
        </form>
          {inventoryCatalogPanel}
        </>
      ) : null}

      {tab === "audit" ? (
        <>
        <div className="mx-auto mt-6 max-w-5xl rounded-xl border border-slate-700/50 bg-slate-900/80 p-6 shadow-xl shadow-black/20 backdrop-blur-sm">
          <div className="mb-6">
            <h2 className="font-semibold text-slate-100">Item Audit</h2>
            <p className="mt-1 text-sm text-slate-400">
              Review an item&apos;s current position and complete movement ledger.
            </p>
          </div>

          <ItemSearch
            label="Find Item"
            items={items}
            search={auditSearch}
            selectedId={auditItemId}
            onSearchChange={(value) => {
              setAuditSearch(value);
              setAuditItemId("");
            }}
            onSelect={selectAuditItem}
            placeholder="Search by item code or name..."
          />

          {auditItem ? (
            <div className="mt-6 space-y-6">
              <div className="flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4 sm:flex-row sm:items-center">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-700 bg-slate-950">
                  {auditItem.imageUrl ? (
                    <img
                      src={auditItem.imageUrl}
                      alt={auditItem.itemName || "Inventory item"}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <ImageIcon size={28} className="text-slate-600" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-semibold text-slate-100">
                      {auditItem.itemName}
                    </h3>
                    <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-400">
                      {auditItem.imageUrl ? "Image uploaded" : "No image"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-400">
                    {auditItem.itemCode || "No code"} · {auditItem.category || "No category"}
                  </p>
                  <div className="mt-3 grid grid-cols-1 divide-y divide-slate-800 rounded-lg bg-slate-950/50 py-1 sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-5">
                    <div className="px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">Cost</p>
                      <p className="mt-0.5 font-medium text-slate-200">
                        {money(itemCost(auditItem))}
                      </p>
                    </div>
                    <div className="px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Selling Price
                      </p>
                      <p className="mt-0.5 font-medium text-slate-200">
                        {money(auditItem.sellingPrice)}
                      </p>
                    </div>
                    <div className="px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Total Stock
                      </p>
                      <p className="mt-0.5 font-medium text-slate-200">
                        {money(auditItem.currentStock)}
                      </p>
                    </div>
                    <div className="px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Total Cost
                      </p>
                      <p className="mt-0.5 font-medium text-slate-200">
                        {money(itemCost(auditItem) * num(auditItem.currentStock))}
                      </p>
                    </div>
                    <div className="px-3 py-2">
                      <p className="text-xs uppercase tracking-wide text-slate-500">
                        Total Selling Amount
                      </p>
                      <p className="mt-0.5 font-medium text-slate-200">
                        {money(
                          num(auditItem.sellingPrice) *
                            num(auditItem.currentStock)
                        )}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-emerald-800/30 bg-gradient-to-br from-emerald-900/20 to-transparent px-4 py-3 text-emerald-400">
                  <p className="text-xs uppercase tracking-wider text-emerald-400">
                    Total Stock IN
                  </p>
                  <p className="mt-1 text-2xl font-bold text-emerald-400 drop-shadow-[0_0_10px_rgba(52,211,153,0.18)]">
                    {money(auditMetrics.totalIn)}
                  </p>
                </div>
                <div className="rounded-lg border border-rose-800/30 bg-gradient-to-br from-rose-900/20 to-transparent px-4 py-3 text-rose-400">
                  <p className="text-xs uppercase tracking-wider text-rose-400">
                    Total Stock OUT
                  </p>
                  <p className="mt-1 text-2xl font-bold text-rose-400 drop-shadow-[0_0_10px_rgba(251,113,133,0.18)]">
                    {money(auditMetrics.totalOut)}
                  </p>
                </div>
                <div className="rounded-lg border border-orange-800/30 bg-gradient-to-br from-orange-900/20 to-transparent px-4 py-3 text-orange-400">
                  <p className="text-xs uppercase tracking-wider text-orange-400">
                    Damaged Stock
                  </p>
                  <p className="mt-1 text-2xl font-bold text-orange-400 drop-shadow-[0_0_10px_rgba(251,146,60,0.18)]">
                    {money(auditMetrics.totalDamaged)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 items-end gap-3 rounded-lg bg-slate-950/40 p-3 sm:grid-cols-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
                    Movement Type
                  </label>
                  <select
                    value={auditTypeFilter}
                    onChange={(event) => setAuditTypeFilter(event.target.value)}
                    className={`${INPUT_CLASS} h-12`}
                  >
                    <option value="ALL">All Movements</option>
                    <option value="IN">Stock IN</option>
                    <option value="OUT">Stock OUT</option>
                    <option value="DAMAGE">Damage</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
                    From Date
                  </label>
                  <DateInput
                    value={auditFromDate}
                    max={auditToDate || undefined}
                    onChange={(event) => setAuditFromDate(event.target.value)}
                    className={`${INPUT_CLASS} h-12 p-0`}
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-400">
                    To Date
                  </label>
                  <DateInput
                    value={auditToDate}
                    min={auditFromDate || undefined}
                    onChange={(event) => setAuditToDate(event.target.value)}
                    className={`${INPUT_CLASS} h-12 p-0`}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setAuditTypeFilter("ALL");
                    setAuditFromDate("");
                    setAuditToDate("");
                  }}
                  className="h-12 rounded-lg border border-slate-700 px-4 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
                >
                  Reset Filters
                </button>
              </div>

              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="min-w-full text-sm">
                  <thead className="border-b border-slate-800 bg-slate-950/70">
                    <tr className="text-left text-xs uppercase tracking-wider text-slate-400">
                      <th className="p-3 font-medium">Date</th>
                      <th className="p-3 font-medium">Type</th>
                      <th className="p-3 text-right font-medium">Quantity</th>
                      <th className="p-3 font-medium">Shift</th>
                      <th className="p-3 font-medium">User</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingAudit ? (
                      <tr>
                        <td colSpan={5} className="p-4 text-slate-400">
                          Loading history…
                        </td>
                      </tr>
                    ) : filteredAuditMovements.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-4 text-slate-400">
                          No stock movements match the selected filters.
                        </td>
                      </tr>
                    ) : (
                      filteredAuditMovements.map((movement) => {
                        const storedType = String(
                          movement.type || ""
                        ).toUpperCase();
                        const isDamage =
                          storedType === "DAMAGE" ||
                          String(movement.reason || "").toUpperCase() === "DAMAGE";
                        const displayType = isDamage ? "DAMAGE" : storedType || "-";
                        const typeClass = isDamage
                          ? "bg-orange-950/50 text-orange-400"
                          : storedType === "IN"
                          ? "bg-emerald-950/50 text-emerald-300"
                          : "bg-rose-950/50 text-rose-400";

                        return (
                          <tr
                            key={movement.id}
                            className="border-b border-slate-800/70 transition-colors last:border-0 hover:bg-slate-800/30"
                          >
                            <td className="p-3 text-slate-400">
                              {formatDate(movement.date, movement.dateMs)}
                            </td>
                            <td className="p-3">
                              <span
                                className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${typeClass}`}
                              >
                                {displayType}
                              </span>
                            </td>
                            <td className="p-3 text-right font-medium text-slate-200">
                              {money(Math.abs(num(movement.qty)))}
                            </td>
                            <td className="p-3 text-slate-400">
                              {movement.shiftId || "-"}
                            </td>
                            <td className="p-3 text-slate-400">
                              {movement.userName ||
                                movement.userId ||
                                movement.createdBy ||
                                "-"}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : loading ? (
            <p className="mt-6 text-sm text-slate-400">Loading items…</p>
          ) : (
            <div className="mt-6 flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/30 px-4 py-3 text-sm text-slate-400">
              <CheckCircle2 size={17} />
              Select an item to view its audit ledger.
            </div>
          )}
        </div>
          {inventoryCatalogPanel}
        </>
      ) : null}

      {importOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={closeImportItems} />
          <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <div>
                <div className="font-semibold text-slate-100">Import Items (CSV)</div>
                <div className="mt-0.5 text-xs text-slate-400">
                  Into shop:{" "}
                  <span className="text-slate-200">
                    {activeClientData?.name || "No client selected"}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={closeImportItems}
                className="text-slate-400 hover:text-slate-200"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <p className="text-sm text-slate-400">
                Columns:{" "}
                <span className="text-slate-200">
                  Category, Item Code, Name, Cost, Selling Price
                </span>
                . Categories: {CATEGORIES.join(", ")}. Imported items start with zero
                stock (no images). Only the active shop is updated.
              </p>

              <button
                type="button"
                onClick={() =>
                  downloadInventoryImportTemplate(activeClientData?.name || "shop")
                }
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
              >
                Download template
              </button>

              <div>
                <label className="text-sm text-slate-300">CSV file</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={onImportFileChange}
                  className="mt-1 block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-slate-100 hover:file:bg-slate-700"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={skipDuplicateCodes}
                  onChange={(event) => setSkipDuplicateCodes(event.target.checked)}
                  className="rounded border-slate-600 bg-slate-900"
                />
                Skip duplicates (same Item Code already in this shop)
              </label>

              {importPreview ? (
                <div className="space-y-1 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
                  <div>
                    File:{" "}
                    <span className="text-slate-100">{importPreview.fileName}</span>
                  </div>
                  <div>
                    Valid rows:{" "}
                    <span className="text-emerald-300">{importPreview.rows.length}</span>
                  </div>
                  {importPreview.errors.length > 0 ? (
                    <div className="text-amber-200">
                      Skipped / invalid: {importPreview.errors.length}
                      <ul className="mt-1 max-h-28 list-disc overflow-auto pl-4 text-xs text-amber-200/90">
                        {importPreview.errors.slice(0, 8).map((msg) => (
                          <li key={msg}>{msg}</li>
                        ))}
                        {importPreview.errors.length > 8 ? (
                          <li>…and {importPreview.errors.length - 8} more</li>
                        ) : null}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {importError ? (
                <div className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                  {importError}
                </div>
              ) : null}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeImportItems}
                  className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-slate-200 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImportConfirm}
                  disabled={
                    importing || !importPreview?.rows?.length || !activeClientId
                  }
                  className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-60"
                >
                  {importing
                    ? "Importing…"
                    : `Import ${importPreview?.rows?.length || 0}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
