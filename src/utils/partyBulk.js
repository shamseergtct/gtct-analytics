/** Party CSV bulk import/export helpers (scoped to one shop/client). */

export const PARTY_CSV_HEADERS = ["Name", "Type", "Contact", "Tax Number"];

export const PARTY_BULK_TYPES = [
  "Customer",
  "Supplier",
  "Partner",
  "Owner",
  "Employee",
  "Lender",
  "Both",
];

const TYPE_ALIASES = {
  customer: "Customer",
  cust: "Customer",
  supplier: "Supplier",
  vendor: "Supplier",
  partner: "Partner",
  owner: "Owner",
  employee: "Employee",
  staff: "Employee",
  lender: "Lender",
  loan: "Lender",
  both: "Both",
};

function safeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function fileSafeName(value) {
  return safeText(value)
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "_")
    .toLowerCase() || "parties";
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Parse a single CSV line, respecting quoted fields. */
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
  name: "name",
  partyname: "name",
  type: "type",
  partytype: "type",
  contact: "contact",
  phone: "contact",
  whatsapp: "contact",
  mobile: "contact",
  taxnumber: "taxNumber",
  tax: "taxNumber",
  vat: "taxNumber",
  gst: "taxNumber",
  vatgstnumber: "taxNumber",
};

export function normalizePartyType(raw) {
  const key = safeText(raw).toLowerCase();
  if (!key) return "Customer";
  if (TYPE_ALIASES[key]) return TYPE_ALIASES[key];
  const match = PARTY_BULK_TYPES.find((t) => t.toLowerCase() === key);
  return match || null;
}

/**
 * Build and download a CSV of parties for one shop.
 */
export function exportPartiesCsv({ parties = [], shopName = "" } = {}) {
  const lines = [PARTY_CSV_HEADERS.map(csvEscape).join(",")];
  for (const party of parties) {
    lines.push(
      [
        csvEscape(party.name || ""),
        csvEscape(party.type || "Customer"),
        csvEscape(party.contact || ""),
        csvEscape(party.taxNumber || ""),
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
  anchor.download = `${fileSafeName(shopName)}_parties_${stamp}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Download a blank template CSV for bulk import. */
export function downloadPartyImportTemplate(shopName = "") {
  exportPartiesCsv({
    parties: [
      {
        name: "Example Customer",
        type: "Customer",
        contact: "0500000000",
        taxNumber: "",
      },
    ],
    shopName: shopName ? `${shopName}_template` : "parties_template",
  });
}

/**
 * Parse party CSV text into row objects ready for Firestore create.
 * Returns { rows, errors } where rows have { name, type, contact, taxNumber, line }.
 */
export function parsePartiesCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((line) => safeText(line).length > 0);

  if (lines.length === 0) {
    return { rows: [], errors: ["CSV file is empty."] };
  }

  const headerCells = parseCsvLine(lines[0]).map(normalizeHeader);
  const index = { name: -1, type: -1, contact: -1, taxNumber: -1 };

  headerCells.forEach((header, i) => {
    const key = HEADER_ALIASES[header];
    if (key && index[key] < 0) index[key] = i;
  });

  // Allow headerless files: first cell looks like a name column if "Name" missing
  const hasHeader = index.name >= 0;
  let dataStart = 1;
  if (!hasHeader) {
    index.name = 0;
    index.type = 1;
    index.contact = 2;
    index.taxNumber = 3;
    dataStart = 0;
  }

  const rows = [];
  const errors = [];

  for (let i = dataStart; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const cells = parseCsvLine(lines[i]);
    const name = safeText(cells[index.name] ?? "");
    if (!name) {
      errors.push(`Line ${lineNo}: name is required.`);
      continue;
    }

    const typeRaw = index.type >= 0 ? cells[index.type] : "Customer";
    const type = normalizePartyType(typeRaw);
    if (!type) {
      errors.push(
        `Line ${lineNo}: invalid type "${safeText(typeRaw)}". Use ${PARTY_BULK_TYPES.join(", ")}.`
      );
      continue;
    }

    rows.push({
      name,
      type,
      contact: safeText(index.contact >= 0 ? cells[index.contact] : ""),
      taxNumber: safeText(index.taxNumber >= 0 ? cells[index.taxNumber] : ""),
      line: lineNo,
    });
  }

  return { rows, errors };
}
