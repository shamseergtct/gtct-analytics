import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { formatMoney, numMoney } from "./money.js";
import {
  PO_STATUS_META,
  billablePurchaseQty,
  poLineTotal,
} from "./purchaseOrders.js";

function safeStr(value, fallback = "—") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function fileSafeName(value) {
  return (
    String(value || "PO")
      .trim()
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "") || "PO"
  );
}

function shopFields(shop = {}) {
  const info =
    shop && typeof shop === "object" && !Array.isArray(shop)
      ? shop
      : { name: String(shop || "").trim() };
  return {
    name: String(info.name || "").trim(),
    address: String(info.location || info.address || "").trim(),
    contact: String(
      info.contact_number || info.phone || info.contact || ""
    ).trim(),
  };
}

function formatQtyCell(row) {
  const qty = numMoney(row.qty);
  const subUnitQty = numMoney(row.subUnitQty);
  const unit = String(row.unit || row.purchaseUnit || "").trim();
  const baseUnit = String(row.baseUnit || "pcs").trim() || "pcs";
  const bits = [];
  if (qty > 0) bits.push(unit ? `${formatMoney(qty, 3)} ${unit}` : formatMoney(qty, 3));
  if (subUnitQty > 0) bits.push(`${formatMoney(subUnitQty, 3)} ${baseUnit}`);
  return bits.join(", ") || "0";
}

function exportLines(po) {
  return (Array.isArray(po?.lines) ? po.lines : [])
    .map((row) => ({
      ...row,
      unitRate: Math.max(
        0,
        numMoney(row.unitRate ?? row.cost ?? row.unitCost ?? 0)
      ),
    }))
    .filter(
      (row) =>
        String(row.itemId || "").trim() &&
        (numMoney(row.qty) > 0 || numMoney(row.subUnitQty) > 0)
    );
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Download the current PO as a PDF (jsPDF).
 */
export function downloadPurchaseOrderPdf({
  po,
  shop = {},
  currency = "BHD",
  currencyDecimals = 3,
} = {}) {
  const lines = exportLines(po);
  if (!lines.length) throw new Error("Add at least one item with quantity first.");

  const shopInfo = shopFields(shop);
  const poNumber = safeStr(po?.poNumber, "Draft PO");
  const status =
    PO_STATUS_META[po?.status]?.label || safeStr(po?.status, "Draft");
  const total = lines.reduce((sum, row) => sum + poLineTotal(row), 0);

  const doc = new jsPDF("p", "mm", "a4");
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  doc.setFillColor(0, 51, 102);
  doc.rect(0, 0, pageW, 30, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(safeStr(shopInfo.name, "Shop"), margin, 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text("Purchase Order", margin, 20);
  doc.setFontSize(10);
  doc.text(poNumber, pageW - margin, 12, { align: "right" });
  doc.text(`Status: ${status}`, pageW - margin, 18, { align: "right" });
  doc.text(`Date: ${safeStr(po?.businessDate)}`, pageW - margin, 24, {
    align: "right",
  });

  let y = 38;
  doc.setTextColor(30, 41, 59);
  doc.setFontSize(10);
  if (shopInfo.address) {
    doc.text(`Address: ${shopInfo.address}`, margin, y);
    y += 6;
  }
  if (shopInfo.contact) {
    doc.text(`Shop contact: ${shopInfo.contact}`, margin, y);
    y += 6;
  }
  doc.text(`Vendor: ${safeStr(po?.vendorName)}`, margin, y);
  y += 6;
  if (String(po?.vendorPhone || "").trim()) {
    doc.text(`Vendor phone: ${String(po.vendorPhone).trim()}`, margin, y);
    y += 6;
  }

  autoTable(doc, {
    startY: y + 2,
    head: [
      [
        "#",
        "Item",
        "Code",
        "Qty",
        `Rate (${currency})`,
        `Amount (${currency})`,
        "Note",
      ],
    ],
    body: lines.map((row, index) => [
      String(index + 1),
      safeStr(row.itemName, "Item"),
      safeStr(row.itemCode),
      formatQtyCell(row),
      formatMoney(row.unitRate, currencyDecimals),
      formatMoney(poLineTotal(row), currencyDecimals),
      safeStr(row.notes, ""),
    ]),
    styles: {
      font: "helvetica",
      fontSize: 9,
      textColor: [51, 65, 85],
      cellPadding: 2.5,
    },
    headStyles: {
      fillColor: [0, 51, 102],
      textColor: [255, 255, 255],
      fontStyle: "bold",
    },
    columnStyles: {
      0: { cellWidth: 10 },
      4: { halign: "right" },
      5: { halign: "right" },
    },
    theme: "grid",
  });

  const endY = doc.lastAutoTable?.finalY || y + 20;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text(
    `Total: ${formatMoney(total, currencyDecimals)} ${currency}`,
    pageW - margin,
    endY + 10,
    { align: "right" }
  );

  const generalNote = String(po?.notes || "").trim();
  if (generalNote) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    const noteLines = doc.splitTextToSize(`Note: ${generalNote}`, pageW - margin * 2);
    doc.text(noteLines, margin, endY + 18);
  }

  const filename = `${fileSafeName(poNumber)}_${safeStr(po?.businessDate, "PO")}.pdf`;
  doc.save(filename);
  return { filename, lineCount: lines.length, total };
}

/**
 * Download the current PO as an Excel-friendly spreadsheet (CSV with BOM).
 * Opens cleanly in Excel / Google Sheets without adding a new dependency.
 */
export function downloadPurchaseOrderExcel({
  po,
  shop = {},
  currency = "BHD",
  currencyDecimals = 3,
} = {}) {
  const lines = exportLines(po);
  if (!lines.length) throw new Error("Add at least one item with quantity first.");

  const shopInfo = shopFields(shop);
  const poNumber = safeStr(po?.poNumber, "Draft PO");
  const status =
    PO_STATUS_META[po?.status]?.label || safeStr(po?.status, "Draft");
  const total = lines.reduce((sum, row) => sum + poLineTotal(row), 0);

  const rows = [
    ["Purchase Order"],
    ["Shop", shopInfo.name],
    ["Address", shopInfo.address],
    ["Shop contact", shopInfo.contact],
    ["PO number", poNumber],
    ["Status", status],
    ["Business date", safeStr(po?.businessDate)],
    ["Vendor", safeStr(po?.vendorName)],
    ["Vendor phone", safeStr(po?.vendorPhone, "")],
    ["General note", String(po?.notes || "").trim()],
    [],
    [
      "#",
      "Item name",
      "Item code",
      "Qty (purchase)",
      "Purchase unit",
      "Qty (sub)",
      "Sub unit",
      "Pack size",
      "Billable purchase qty",
      `Unit rate (${currency})`,
      `Line total (${currency})`,
      "Line note",
    ],
    ...lines.map((row, index) => [
      index + 1,
      safeStr(row.itemName, "Item"),
      safeStr(row.itemCode, ""),
      numMoney(row.qty) > 0 ? formatMoney(numMoney(row.qty), 3) : "",
      numMoney(row.qty) > 0
        ? safeStr(row.unit || row.purchaseUnit, "")
        : "",
      numMoney(row.subUnitQty) > 0
        ? formatMoney(numMoney(row.subUnitQty), 3)
        : "",
      numMoney(row.subUnitQty) > 0
        ? safeStr(row.baseUnit || "pcs", "pcs")
        : "",
      numMoney(row.subQty) > 0 ? formatMoney(numMoney(row.subQty), 3) : "",
      formatMoney(billablePurchaseQty(row), 3),
      formatMoney(row.unitRate, currencyDecimals),
      formatMoney(poLineTotal(row), currencyDecimals),
      String(row.notes || "").trim(),
    ]),
    [],
    ["Total", "", "", "", "", "", "", "", "", "", formatMoney(total, currencyDecimals), ""],
  ];

  const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
  const blob = new Blob([`\uFEFF${csv}\n`], {
    type: "text/csv;charset=utf-8;",
  });
  const filename = `${fileSafeName(poNumber)}_${safeStr(po?.businessDate, "PO")}.csv`;
  downloadBlob(blob, filename);
  return { filename, lineCount: lines.length, total };
}
