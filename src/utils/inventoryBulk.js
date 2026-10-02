/** Inventory item CSV bulk import/export helpers (scoped to one shop/client). */

export const INVENTORY_CSV_HEADERS = [
  "Category",
  "Item Code",
  "Name",
  "Cost",
  "Selling Price",
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
  category: "category",
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

/**
 * Download CSV of inventory items for one shop.
 * Stock / images are not included — base catalog fields only.
 */
export function exportInventoryCsv({ items = [], shopName = "" } = {}) {
  const lines = [INVENTORY_CSV_HEADERS.map(csvEscape).join(",")];
  for (const item of items) {
    lines.push(
      [
        csvEscape(item.category || "COMMODITY"),
        csvEscape(item.itemCode || ""),
        csvEscape(item.itemName || ""),
        csvEscape(
          Number.isFinite(Number(item.cost)) ? Number(item.cost).toFixed(2) : "0.00"
        ),
        csvEscape(
          Number.isFinite(Number(item.sellingPrice))
            ? Number(item.sellingPrice).toFixed(2)
            : "0.00"
        ),
      ].join(",")
    );
  }

  const blob = new Blob([`${lines.join("\n")}\n`], {
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
        category: "COMMODITY",
        itemCode: "ITM-001",
        itemName: "Example Item",
        cost: 10,
        sellingPrice: 15,
      },
    ],
    shopName: shopName ? `${shopName}_template` : "inventory_template",
  });
}

/**
 * Parse inventory CSV into create-ready rows.
 * Returns { rows, errors }.
 */
export function parseInventoryCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((line) => safeText(line).length > 0);

  if (lines.length === 0) {
    return { rows: [], errors: ["CSV file is empty."] };
  }

  const headerCells = parseCsvLine(lines[0]).map(normalizeHeader);
  const index = {
    category: -1,
    itemCode: -1,
    itemName: -1,
    cost: -1,
    sellingPrice: -1,
  };

  headerCells.forEach((header, i) => {
    const key = HEADER_ALIASES[header];
    if (key && index[key] < 0) index[key] = i;
  });

  const hasHeader = index.itemCode >= 0 || index.itemName >= 0;
  let dataStart = 1;
  if (!hasHeader) {
    index.category = 0;
    index.itemCode = 1;
    index.itemName = 2;
    index.cost = 3;
    index.sellingPrice = 4;
    dataStart = 0;
  }

  const rows = [];
  const errors = [];
  const seenCodes = new Set();

  for (let i = dataStart; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const cells = parseCsvLine(lines[i]);

    const itemCode = safeText(index.itemCode >= 0 ? cells[index.itemCode] : "");
    const itemName = safeText(index.itemName >= 0 ? cells[index.itemName] : "");
    if (!itemCode) {
      errors.push(`Line ${lineNo}: Item Code is required.`);
      continue;
    }
    if (!itemName) {
      errors.push(`Line ${lineNo}: Name is required.`);
      continue;
    }

    const codeKey = itemCode.toLowerCase();
    if (seenCodes.has(codeKey)) {
      errors.push(`Line ${lineNo}: duplicate Item Code "${itemCode}" in file.`);
      continue;
    }

    const category = normalizeInventoryCategory(
      index.category >= 0 ? cells[index.category] : "COMMODITY"
    );
    if (!category) {
      errors.push(
        `Line ${lineNo}: invalid Category. Use ${INVENTORY_CATEGORIES.join(", ")}.`
      );
      continue;
    }

    const cost =
      index.cost >= 0 ? parseMoney(cells[index.cost]) : 0;
    const sellingPrice =
      index.sellingPrice >= 0 ? parseMoney(cells[index.sellingPrice]) : 0;

    if (cost === null) {
      errors.push(`Line ${lineNo}: invalid Cost.`);
      continue;
    }
    if (sellingPrice === null) {
      errors.push(`Line ${lineNo}: invalid Selling Price.`);
      continue;
    }

    seenCodes.add(codeKey);
    rows.push({
      category,
      itemCode,
      itemName,
      cost,
      sellingPrice,
      line: lineNo,
    });
  }

  return { rows, errors };
}
