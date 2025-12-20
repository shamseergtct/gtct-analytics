// src/utils/inventoryPdf.js
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

function money(v) {
  const n = Number(v || 0);
  return n.toFixed(2);
}

export function generateInventoryPDF({ clientName = "Client", items = [] }) {
  const doc = new jsPDF("p", "mm", "a4");
  const today = new Date();

  const dateText = today.toLocaleDateString();

  // Header
  doc.setFillColor(0, 51, 102); // #003366
  doc.rect(0, 0, 210, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.text("GTCT - INVENTORY REPORT", 10, 14);

  doc.setFontSize(10);
  doc.text(`Client: ${clientName}`, 140, 10);
  doc.text(`Date: ${dateText}`, 140, 16);

  // Summary
  const totalValue = items.reduce(
    (a, it) => a + Number(it.currentStock || 0) * Number(it.avgCostPrice || 0),
    0
  );
  const lowItems = items.filter(
    (it) => Number(it.currentStock || 0) < Number(it.reorderLevel || 0)
  );

  doc.setTextColor(20);
  doc.setFontSize(11);
  doc.text(`Total Items: ${items.length}`, 10, 30);
  doc.text(`Total Stock Value: ${money(totalValue)}`, 75, 30);
  doc.text(`Low Stock Alerts: ${lowItems.length}`, 160, 30);

  // Main Table
  autoTable(doc, {
    startY: 36,
    head: [["Item", "Category", "Stock", "Unit", "Avg Cost", "Total Value", "Status"]],
    body: items.map((it) => {
      const stock = Number(it.currentStock || 0);
      const avg = Number(it.avgCostPrice || 0);
      const total = stock * avg;
      const reorder = Number(it.reorderLevel || 0);
      const status = stock < reorder ? "LOW" : "OK";
      return [
        it.itemName || "",
        it.category || "",
        money(stock),
        it.unit || "",
        money(avg),
        money(total),
        status,
      ];
    }),
    styles: { fontSize: 9 },
    headStyles: { fillColor: [0, 51, 102] },
  });

  // Low Stock Section
  if (lowItems.length > 0) {
    const y = doc.lastAutoTable.finalY + 8;
    doc.setFontSize(11);
    doc.text("Low Stock Items", 10, y);

    autoTable(doc, {
      startY: y + 4,
      head: [["Item", "Stock", "Reorder Level", "Unit"]],
      body: lowItems.map((it) => [
        it.itemName || "",
        money(it.currentStock),
        money(it.reorderLevel),
        it.unit || "",
      ]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [153, 0, 0] },
    });
  }

  const safeName = String(clientName || "Client").replace(/[^\w\s-]/g, "").replace(/\s+/g, "_");
  doc.save(`GTCT_Inventory_Report_${safeName}_${dateText.replaceAll("/", "-")}.pdf`);
}
