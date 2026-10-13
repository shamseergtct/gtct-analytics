import { formatMoney, numMoney } from "./money.js";

/** Inventory item CSV bulk import/export helpers (scoped to one shop/client). */

export const INVENTORY_CSV_HEADERS = [
  "Item ID",
  "Category",
  "Sub Category",
  "Item Code",
  "Name",
  "Cost",
  "Selling Price",
  "Barcode",
  "Min Stock",
  "Batch No",
  "Expiry Date",
  "Base Unit",
  "Purchase Unit",
  "Sub Qty",
  "Recipe Notes",
  "Units Per Carton",
  "Wholesale Price",
  "Direct Sale",
  "Attention Low Qty",
  "Attention Urgent Qty",
  "Attention Very Urgent Qty",
  "Current Stock",
];

export const INVENTORY_CATEGORIES = ["COMMODITY", "CONSUMABLES", "ASSET"];

const CATEGORY_ALIASES = {
  commodity: "COMMODITY",
  commodities: "COMMODITY",
  consumable: "CONSUMABLES",
  consumables: "CONSUMABLES",
  asset: "ASSET",
  assets: "ASSET",
};

function safeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function fileSafeName(value) {
  return (
    safeText(value)
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "_")
      .toLowerCase() || "inventory"
  );
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells;
}

function normalizeHeader(value) {
  return safeText(value)
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

const HEADER_ALIASES = {
  itemid: "itemId",
  itemno: "itemId",
  itemnumber: "itemId",
  id: "itemId",
  docid: "itemId",
  firestoreid: "itemId",
  category: "category",
  subcategory: "subCategory",
  subcat: "subCategory",
  itemcode: "itemCode",
  code: "itemCode",
  sku: "itemCode",
  name: "itemName",
  itemname: "itemName",
  item: "itemName",
  cost: "cost",
  costprice: "cost",
  sellingprice: "sellingPrice",
  sellprice: "sellingPrice",
  price: "sellingPrice",
  saleprice: "sellingPrice",
  barcode: "barcode",
  minstock: "minStock",
  reorderlevel: "minStock",
  batchno: "batchNo",
  batch: "batchNo",
  lot: "batchNo",
  expirydate: "expiryDate",
  expiry: "expiryDate",
  baseunit: "baseUnit",
  usageunit: "baseUnit",
  stockunit: "baseUnit",
  unit: "baseUnit",
  purchaseunit: "purchaseUnit",
  packunit: "purchaseUnit",
  subqty: "subQty",
  packsize: "subQty",
  unitsperpurchase: "subQty",
  recipenotes: "recipeNotes",
  recipe: "recipeNotes",
  unitspercarton: "unitsPerCarton",
  piecespercarton: "unitsPerCarton",
  wholesaleprice: "wholesalePrice",
  directsale: "directSale",
  attentionlowqty: "attentionLowQty",
  lowqty: "attentionLowQty",
  attentionurgentqty: "attentionUrgentQty",
  urgentqty: "attentionUrgentQty",
  attentionveryurgentqty: "attentionVeryUrgentQty",
  veryurgentqty: "attentionVeryUrgentQty",
  currentstock: "currentStock",
  stock: "currentStock",
  onhand: "currentStock",
  openingqty: "currentStock",
};

export function normalizeInventoryCategory(raw) {
  const key = safeText(raw).toLowerCase();
  if (!key) return "COMMODITY";
  if (CATEGORY_ALIASES[key]) return CATEGORY_ALIASES[key];
  const match = INVENTORY_CATEGORIES.find((c) => c.toLowerCase() === key);
  return match || null;
}

function parseMoney(raw) {
  const cleaned = String(raw ?? "")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "")
    .trim();
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function parseOptionalMoney(raw, fallback = 0) {
  if (raw == null || safeText(raw) === "") return fallback;
  const value = parseMoney(raw);
  return value === null ? null : value;
}

function parseBool(raw, fallback = false) {
  const key = safeText(raw).toLowerCase();
  if (!key) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(key)) return true;
  if (["0", "false", "no", "n", "off"].includes(key)) return false;
  return null;
}

function cell(cells, indexMap, key) {
  const i = indexMap[key];
  if (i == null || i < 0) return "";
  return cells[i] ?? "";
}

/** Shop-scoped numeric Item ID (1, 2, 3…). */
export function resolveItemNo(item) {
  const raw = item?.itemNo;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return null;
  const asInt = Math.floor(n);
  return asInt === n ? asInt : null;
}

/** Next free numeric Item ID for this shop’s catalog. */
export function nextItemNo(items = []) {
  let max = 0;
  for (const item of items) {
    const n = resolveItemNo(item);
    if (n != null && n > max) max = n;
  }
  return max + 1;
}

/**
 * Parse CSV Item ID cell: digits → itemNo; otherwise legacy Firestore doc id.
 */
export function parseCsvItemIdCell(raw) {
  const text = safeText(raw);
  if (!text) return { itemNo: null, firestoreId: "" };
  if (/^\d+$/.test(text)) {
    const itemNo = Number(text);
    return { itemNo: itemNo >= 1 ? itemNo : null, firestoreId: "" };
  }
  return { itemNo: null, firestoreId: text };
}

function exportRow(item) {
  const itemNo = resolveItemNo(item);
  return [
    itemNo != null ? String(itemNo) : "",
    item.category || "COMMODITY",
    item.subCategory || "",
    item.itemCode || "",
    item.itemName || "",
    formatMoney(item.cost),
    formatMoney(item.sellingPrice),
    item.barcode || "",
    formatMoney(item.minStock ?? 0),
    item.batchNo || "",
    item.expiryDate || "",
    item.baseUnit || "pcs",
    item.purchaseUnit || "",
    numMoney(item.subQty) > 0 ? formatMoney(item.subQty) : "",
    item.recipeNotes || "",
    formatMoney(Math.max(1, numMoney(item.unitsPerCarton) || 12)),
    formatMoney(item.wholesalePrice ?? 0),
    item.directSale === false ? "false" : "true",
    formatMoney(item.attentionLowQty ?? 0),
    formatMoney(item.attentionUrgentQty ?? 0),
    formatMoney(item.attentionVeryUrgentQty ?? 0),
    formatMoney(item.currentStock ?? 0),
  ].map(csvEscape);
}

/**
 * Download CSV of inventory items for one shop.
 * Item ID is a numeric shop number (itemNo). Images are not included.
 * Current Stock is exported for reference; import does not overwrite stock.
 */
export function exportInventoryCsv({ items = [], shopName = "" } = {}) {
  const lines = [INVENTORY_CSV_HEADERS.map(csvEscape).join(",")];
  for (const item of items) {
    lines.push(exportRow(item).join(","));
  }

  const blob = new Blob([`\uFEFF${lines.join("\n")}\n`], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  anchor.download = `${fileSafeName(shopName)}_inventory_${stamp}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadInventoryImportTemplate(shopName = "") {
  exportInventoryCsv({
    items: [
      {
        itemNo: 1,
        category: "COMMODITY",
        subCategory: "Beef",
        itemCode: "ITM-001",
        itemName: "Example Item",
        cost: 10,
        sellingPrice: 15,
        barcode: "",
        minStock: 0,
        batchNo: "",
        expiryDate: "",
        baseUnit: "pcs",
        purchaseUnit: "box",
        subQty: 12,
        recipeNotes: "",
        unitsPerCarton: 12,
        wholesalePrice: 0,
        directSale: false,
        attentionLowQty: 10,
        attentionUrgentQty: 5,
        attentionVeryUrgentQty: 2,
        currentStock: 0,
      },
    ],
    shopName: shopName ? `${shopName}_template` : "inventory_template",
  });
}

/**
 * Parse inventory CSV into create/update-ready rows.
 * Returns { rows, errors }.
 * Item ID (when present) is used for bulk edit updates.
 * Older short CSVs (Category…Selling Price) remain supported.
 */
export function parseInventoryCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((line) => safeText(line).length > 0);

  if (lines.length === 0) {
    return { rows: [], errors: ["CSV file is empty."] };
  }

  const headerCells = parseCsvLine(lines[0]).map(normalizeHeader);
  const index = {
    itemId: -1,
    category: -1,
    subCategory: -1,
    itemCode: -1,
    itemName: -1,
    cost: -1,
    sellingPrice: -1,
    barcode: -1,
    minStock: -1,
    batchNo: -1,
    expiryDate: -1,
    baseUnit: -1,
    purchaseUnit: -1,
    subQty: -1,
    recipeNotes: -1,
    unitsPerCarton: -1,
    wholesalePrice: -1,
    directSale: -1,
    attentionLowQty: -1,
    attentionUrgentQty: -1,
    attentionVeryUrgentQty: -1,
    currentStock: -1,
  };

  headerCells.forEach((header, i) => {
    const key = HEADER_ALIASES[header];
    if (key && index[key] < 0) index[key] = i;
  });

  const hasHeader = index.itemCode >= 0 || index.itemName >= 0;
  let dataStart = 1;
  if (!hasHeader) {
    // Legacy short layouts without a header row.
    const width = parseCsvLine(lines[0]).length;
    if (width >= 6) {
      index.category = 0;
      index.subCategory = 1;
      index.itemCode = 2;
      index.itemName = 3;
      index.cost = 4;
      index.sellingPrice = 5;
    } else {
      index.category = 0;
      index.itemCode = 1;
      index.itemName = 2;
      index.cost = 3;
      index.sellingPrice = 4;
    }
    dataStart = 0;
  }

  const rows = [];
  const errors = [];
  const seenCodes = new Set();
  const seenIds = new Set();

  for (let i = dataStart; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const cells = parseCsvLine(lines[i]);

    const idCell = parseCsvItemIdCell(cell(cells, index, "itemId"));
    const itemNo = idCell.itemNo;
    const firestoreId = idCell.firestoreId;
    const itemIdKey =
      itemNo != null ? `n:${itemNo}` : firestoreId ? `f:${firestoreId}` : "";
    const itemCode = safeText(cell(cells, index, "itemCode"));
    const itemName = safeText(cell(cells, index, "itemName"));
    if (!itemCode) {
      errors.push(`Line ${lineNo}: Item Code is required.`);
      continue;
    }
    if (!itemName) {
      errors.push(`Line ${lineNo}: Name is required.`);
      continue;
    }

    if (itemIdKey) {
      if (seenIds.has(itemIdKey)) {
        errors.push(
          `Line ${lineNo}: duplicate Item ID "${itemNo ?? firestoreId}" in file.`
        );
        continue;
      }
      seenIds.add(itemIdKey);
    }

    const codeKey = itemCode.toLowerCase();
    if (seenCodes.has(codeKey)) {
      errors.push(`Line ${lineNo}: duplicate Item Code "${itemCode}" in file.`);
      continue;
    }

    const category = normalizeInventoryCategory(
      cell(cells, index, "category") || "COMMODITY"
    );
    if (!category) {
      errors.push(
        `Line ${lineNo}: invalid Category. Use ${INVENTORY_CATEGORIES.join(", ")}.`
      );
      continue;
    }

    const cost = parseOptionalMoney(cell(cells, index, "cost"), 0);
    const sellingPrice = parseOptionalMoney(
      cell(cells, index, "sellingPrice"),
      0
    );
    if (cost === null) {
      errors.push(`Line ${lineNo}: invalid Cost.`);
      continue;
    }
    if (sellingPrice === null) {
      errors.push(`Line ${lineNo}: invalid Selling Price.`);
      continue;
    }

    const minStock = parseOptionalMoney(cell(cells, index, "minStock"), 0);
    const subQty = parseOptionalMoney(cell(cells, index, "subQty"), 0);
    const unitsPerCarton = parseOptionalMoney(
      cell(cells, index, "unitsPerCarton"),
      12
    );
    const wholesalePrice = parseOptionalMoney(
      cell(cells, index, "wholesalePrice"),
      0
    );
    const attentionLowQty = parseOptionalMoney(
      cell(cells, index, "attentionLowQty"),
      0
    );
    const attentionUrgentQty = parseOptionalMoney(
      cell(cells, index, "attentionUrgentQty"),
      0
    );
    const attentionVeryUrgentQty = parseOptionalMoney(
      cell(cells, index, "attentionVeryUrgentQty"),
      0
    );
    const currentStock = parseOptionalMoney(
      cell(cells, index, "currentStock"),
      0
    );

    if (
      minStock === null ||
      subQty === null ||
      unitsPerCarton === null ||
      wholesalePrice === null ||
      attentionLowQty === null ||
      attentionUrgentQty === null ||
      attentionVeryUrgentQty === null ||
      currentStock === null
    ) {
      errors.push(`Line ${lineNo}: invalid numeric field.`);
      continue;
    }

    const directSale = parseBool(cell(cells, index, "directSale"), false);
    if (directSale === null) {
      errors.push(
        `Line ${lineNo}: invalid Direct Sale. Use true/false or yes/no.`
      );
      continue;
    }

    const purchaseUnit = safeText(cell(cells, index, "purchaseUnit")).slice(
      0,
      40
    );
    const baseUnit =
      safeText(cell(cells, index, "baseUnit")).slice(0, 40) || "pcs";

    seenCodes.add(codeKey);
    rows.push({
      itemNo,
      itemId: firestoreId,
      category,
      subCategory: safeText(cell(cells, index, "subCategory")).slice(0, 60),
      itemCode,
      itemName,
      cost,
      sellingPrice,
      barcode: safeText(cell(cells, index, "barcode")),
      minStock: Math.max(0, minStock),
      batchNo: safeText(cell(cells, index, "batchNo")),
      expiryDate: safeText(cell(cells, index, "expiryDate")),
      baseUnit,
      purchaseUnit,
      subQty: Math.max(0, subQty),
      recipeNotes: safeText(cell(cells, index, "recipeNotes")),
      unitsPerCarton: Math.max(1, unitsPerCarton || 12),
      wholesalePrice: Math.max(0, wholesalePrice),
      directSale,
      attentionLowQty: Math.max(0, attentionLowQty),
      attentionUrgentQty: Math.max(0, attentionUrgentQty),
      attentionVeryUrgentQty: Math.max(0, attentionVeryUrgentQty),
      // Exported for reference; import never overwrites on-hand stock.
      currentStock: Math.max(0, currentStock),
      line: lineNo,
    });
  }

  return { rows, errors };
}

/** Shared field patch for CSV create/update (excludes stock and images). */
export function inventoryFieldsFromCsvRow(row, { includeItemNo = false } = {}) {
  const fields = {
    category: row.category,
    subCategory: String(row.subCategory || "").trim().slice(0, 60),
    itemCode: String(row.itemCode || "").trim(),
    itemName: String(row.itemName || "").trim(),
    cost: Math.max(0, numMoney(row.cost)),
    sellingPrice: Math.max(0, numMoney(row.sellingPrice)),
    barcode: String(row.barcode || "").trim(),
    minStock: Math.max(0, numMoney(row.minStock)),
    batchNo: String(row.batchNo || "").trim(),
    expiryDate: String(row.expiryDate || "").trim(),
    baseUnit: String(row.baseUnit || "pcs").trim() || "pcs",
    purchaseUnit: String(row.purchaseUnit || "").trim().slice(0, 40),
    subQty: Math.max(0, numMoney(row.subQty)),
    recipeNotes: String(row.recipeNotes || "").trim(),
    unitsPerCarton: Math.max(1, numMoney(row.unitsPerCarton) || 12),
    wholesalePrice: Math.max(0, numMoney(row.wholesalePrice)),
    directSale: Boolean(row.directSale),
    attentionLowQty: Math.max(0, numMoney(row.attentionLowQty)),
    attentionUrgentQty: Math.max(0, numMoney(row.attentionUrgentQty)),
    attentionVeryUrgentQty: Math.max(0, numMoney(row.attentionVeryUrgentQty)),
  };
  if (includeItemNo) {
    const itemNo = resolveItemNo(row);
    if (itemNo != null) fields.itemNo = itemNo;
  }
  return fields;
}
