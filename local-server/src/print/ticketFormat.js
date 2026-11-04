import { formatTicketTime } from "../util/time.js";
import { formatMoneyMinor } from "../util/money.js";
import { computeOrderTaxFromBuckets, splitUnitTaxBuckets, formatTaxPercentFromBps } from "../services/tax.js";

function wrapWidth(paperWidthMm) {
  return paperWidthMm <= 58 ? 32 : 42;
}

function line(char, width) {
  return char.repeat(width);
}

function center(text, width) {
  const t = String(text || "");
  if (t.length >= width) return t.slice(0, width);
  const pad = Math.floor((width - t.length) / 2);
  return `${" ".repeat(pad)}${t}`;
}

function moneyShop(payload) {
  return {
    currency_code: payload.currencyCode,
    currency_label: payload.currencyLabel,
    currency_decimals: payload.currencyDecimals ?? 2,
  };
}

function formatAddonKitchen(addon) {
  const qty = Number(addon.quantity || 1);
  const name = String(addon.name || "").toUpperCase();
  const price = Number(addon.unitPriceCents ?? addon.linePriceCents ?? 0);
  const prefix = price < 0 ? "-" : "+";
  return qty > 1 ? `${prefix} ${qty}× ${name}` : `${prefix} ${name}`;
}

function formatSignedMoney(minor, shop, fmt) {
  const n = Number(minor || 0);
  if (n === 0) return fmt(0);
  const sign = n > 0 ? "+" : "";
  return `${sign}${fmt(n)}`;
}

function headerName(payload) {
  return (
    payload.shopDisplayName ||
    payload.restaurantDisplayName ||
    "GTCT RESTAURANT"
  );
}

function typeLabel(payload) {
  return String(payload.orderTypeName || payload.orderType || "").trim().toUpperCase();
}

function appendServiceLines(lines, payload) {
  const push = (label, value) => {
    const text = String(value || "").trim();
    if (text) lines.push(`${label}: ${text.toUpperCase()}`);
  };
  push("CUSTOMER", payload.customerName);
  push("PHONE", payload.customerPhone);
  push("BLOCK", payload.blockNumber);
  push("BUILDING", payload.buildingNumber);
  push("ROAD", payload.roadNumber);
  push("ADDRESS", payload.addressNote);
  push("TABLE", payload.tableNumber);
  push("VEHICLE", payload.vehicleNumber);
  push("PARKING", payload.parkingLocation);
}

function deliveryAmount(payload) {
  return Number(payload.deliveryChargeCents || 0);
}

function showDelivery(payload) {
  return payload.fulfillmentBehavior === "DELIVERY" || deliveryAmount(payload) !== 0;
}

function billSplitNo(item) {
  const first = Array.isArray(item?.instructions) ? item.instructions[0] : "";
  const match = String(first || "").match(/^Order (\d+)$/);
  return match ? Number(match[1]) : 0;
}

function compareBillItems(a, b) {
  const cat =
    (Number.isFinite(a?.categorySort) ? a.categorySort : 1e9) -
    (Number.isFinite(b?.categorySort) ? b.categorySort : 1e9);
  if (cat) return cat;
  const catName = String(a?.category || "").localeCompare(String(b?.category || ""));
  if (catName) return catName;
  const sub =
    (Number.isFinite(a?.subcategorySort) ? a.subcategorySort : 1e9) -
    (Number.isFinite(b?.subcategorySort) ? b.subcategorySort : 1e9);
  if (sub) return sub;
  const subName = String(a?.subcategory || "").localeCompare(String(b?.subcategory || ""));
  if (subName) return subName;
  const itemSort = Number(a?.itemSort || 0) - Number(b?.itemSort || 0);
  if (itemSort) return itemSort;
  const name = String(a?.name || "").localeCompare(String(b?.name || ""));
  if (name) return name;
  return String(a?.variantName || "").localeCompare(String(b?.variantName || ""));
}

/** Group a bill by category, then item name. Cart entry order is not the bill order. */
export function sortBillItems(items) {
  const rows = (items || []).map((item, index) => ({
    item,
    index,
    split: billSplitNo(item),
  }));
  const splitCount = new Set(rows.map((row) => row.split).filter((n) => n > 0)).size;
  rows.sort((a, b) => {
    if (splitCount > 1 && a.split !== b.split) return a.split - b.split;
    return compareBillItems(a.item, b.item) || a.index - b.index;
  });
  return rows.map((row) => row.item);
}

function pushCustomerTotal(lines, fmt, payload) {
  if (showDelivery(payload)) {
    lines.push(`Delivery charge  ${fmt(deliveryAmount(payload))}`);
  }
  lines.push(`TOTAL  ${payload.totalFormatted || fmt(payload.totalCents)}`);
}

/**
 * Render kitchen ticket text (thermal-friendly plain text).
 * Prioritizes preparation clarity — instructions then add-ons, no prices.
 */
function renderStationSlip(payload, width) {
  const pair = (left, right) => left + ' '.repeat(Math.max(1, width - left.length - right.length)) + right;
  const when = new Date(payload.createdAt);
  const date = when.toLocaleDateString('en-GB', { timeZone: 'Asia/Bahrain' });
  const time = when.toLocaleTimeString('en-GB', { timeZone: 'Asia/Bahrain', hour: '2-digit', minute: '2-digit' });
  const stamp = when.toLocaleTimeString('en-US', { timeZone: 'Asia/Bahrain' });
  const lines = [payload.stationName, pair('Order ' + payload.orderNumber, payload.orderTypeName),
    pair('Server ' + payload.serverName, payload.terminalName), pair(date, time),
    payload.customerName, payload.customerPhone, payload.addressNote, '', line('-', width)];
  for (const item of payload.items) {
    lines.push(pair(item.quantity + ' ' + item.name, formatMoneyMinor(item.lineTotalCents, moneyShop(payload)).replace(/[^0-9.,-]/g, '').trim()));
    if (item.variantName) lines.push('        ' + item.variantName);
    for (const note of item.instructions || []) lines.push('        ' + note);
  }
  lines.push('', 'Reference#' + payload.tokenNumber, '', center('Printed On ' + date + ' ' + stamp, width),
    center('TEST TICKET', width));
  return lines.join('\n');
}

export function renderKitchenTicket(payload, options = {}) {
  const width = wrapWidth(options.paperWidthMm || 80);
  if (options.layout === "station-slip") return renderStationSlip(payload, width);
  const lines = [];
  lines.push(center(headerName(payload), width));
  lines.push(center("KITCHEN TEST", width));
  lines.push(line("-", width));
  lines.push(`STATION: ${String(payload.stationName || "").toUpperCase()}`);
  lines.push(`INVOICE: ${payload.orderNumber}`);
  if (payload.tokenNumber != null) lines.push(`TOKEN: ${String(payload.tokenNumber).padStart(3, "0")}`);
  if (payload.businessDate) lines.push(`BUSINESS DATE: ${payload.businessDate}`);
  lines.push(`TICKET: ${payload.ticketId}`);
  lines.push(`TYPE: ${typeLabel(payload)}`);
  if (payload.destination) {
    lines.push(`DESTINATION: ${String(payload.destination).toUpperCase()}`);
  }
  appendServiceLines(lines, payload);
  lines.push(`TIME: ${formatTicketTime(payload.orderEdited && payload.updatedAt ? payload.updatedAt : payload.createdAt)}`);
  lines.push(`REV: ${payload.ticketRevision || 1}`);
  if (payload.orderEdited) {
    lines.push(center("*** ORDER UPDATED ***", width));
  }
  if (payload.isReprint) {
    lines.push(center("*** REPRINT ***", width));
  }
  if (payload.warning) {
    lines.push(center(String(payload.warning).toUpperCase(), width));
  }
  lines.push(line("-", width));

  for (const item of payload.items || []) {
    lines.push(`${item.quantity} × ${String(item.name || "").toUpperCase()}`);
    if (item.variantName) {
      lines.push(`  SIZE: ${String(item.variantName).toUpperCase()}`);
    }
    for (const note of item.instructions || []) {
      lines.push(`  ${String(note).toUpperCase()}`);
    }
    for (const addon of item.addons || []) {
      lines.push(`  ${formatAddonKitchen(addon)}`);
    }
    lines.push("");
  }
  if (payload.removedItems?.length) {
    lines.push(center("REMOVED — DO NOT PREPARE", width));
    for (const item of payload.removedItems) {
      lines.push(`${item.quantity} × ${String(item.name || "").toUpperCase()}`);
      if (item.variantName) {
        lines.push(`  SIZE: ${String(item.variantName).toUpperCase()}`);
      }
      for (const note of item.instructions || []) {
        lines.push(`  ${String(note).toUpperCase()}`);
      }
      lines.push("");
    }
  }

  lines.push(line("-", width));
  lines.push(center("TEST TICKET — NOT A BILL", width));
  lines.push("");
  return lines.join("\n");
}

/**
 * Render cashier receipt (complete order, synthetic TEST DATA only).
 * Uses order-time billing snapshots when present on the payload.
 */
function receiptColumns(left, right, width) {
  if (!right) return left;
  if (left.length + right.length >= width) return left + '\n' + right.padStart(width);
  return left + ' '.repeat(width - left.length - right.length) + right;
}

function appendDeliveryAddress(lines, payload, width) {
  lines.push(line("-", width), center("DELIVERY ADDRESS", width));
  const add = (label, value) => {
    if (!value?.trim()) return;
    let text = label + value.trim().replace(/\s+/g, " ");
    while (text.length > width) {
      const space = text.lastIndexOf(" ", width);
      const end = space > 0 ? space : width;
      lines.push(text.slice(0, end));
      text = text.slice(end).trimStart();
    }
    lines.push(text);
  };
  add("Customer: ", payload.customerName);
  add("Phone: ", payload.customerPhone);
  add("Building: ", payload.buildingNumber);
  add("Road: ", payload.roadNumber);
  add("Block: ", payload.blockNumber);
  add("Address note: ", payload.addressNote);
  if (![payload.buildingNumber, payload.roadNumber, payload.blockNumber, payload.addressNote].some(v => v?.trim())) {
    if (payload.destination?.trim()) add("Destination: ", payload.destination);
    else lines.push("Delivery address not recorded");
  }
}

export function renderCashierReceipt(payload, options = {}) {
  const width = wrapWidth(options.paperWidthMm || 80);
  const shop = moneyShop(payload);
  const hasMoney =
    payload.currencyLabel != null ||
    payload.currencyCode != null ||
    payload.totalCents != null;
  const fmt = (minor) =>
    hasMoney ? formatMoneyMinor(minor, shop) : String(minor ?? "");
  const itemFmt = minor => formatMoneyMinor(minor, { currency_decimals: shop.currency_decimals });
  const receipt = payload.receipt || {};
  const supplierLine = value => {
    for (const part of String(value).split(/\r?\n/)) {
      for (let start = 0; start < part.length; start += width) lines.push(center(part.slice(start, start + width), width));
    }
  };

  const lines = [];
  if (receipt.showDisplayName !== false) {
    lines.push(center(headerName(payload), width));
  }
  if ((payload.taxEnabled || receipt.showLegalName) && payload.shopLegalName) {
    supplierLine(payload.shopLegalName);
  }
  lines.push(center(payload.taxEnabled ? "TEST VAT INVOICE" : "CASHIER TEST RECEIPT", width));
  if (payload.addressText) supplierLine(payload.addressText);
  if (payload.phone) supplierLine(`Tel: ${payload.phone}`);
  if (receipt.showWhatsapp !== false && payload.whatsapp) {
    lines.push(center(`WhatsApp: ${payload.whatsapp}`, width));
  }
  if (receipt.showRegistration && payload.registrationNumber) {
    lines.push(center(`CR: ${payload.registrationNumber}`, width));
  }
  if (
    payload.taxEnabled &&
    payload.taxRegistrationNumber
  ) {
    supplierLine(`VAT Account No: ${payload.taxRegistrationNumber}`);
  }
  lines.push(receiptColumns(`Order ${payload.orderNumber}`, typeLabel(payload), width));
  if (payload.serverName || payload.terminalName) {
    lines.push(receiptColumns(payload.serverName ? `Server ${payload.serverName}` : "", payload.terminalName || "", width));
  }
  const stamp = formatTicketTime(payload.createdAt);
  const [date, time] = stamp.split(" ");
  lines.push(receiptColumns("Issued " + date, time || "", width));
  if (payload.businessDate && payload.businessDate !== date) lines.push(`Business date: ${payload.businessDate}`);
  if ((payload.fulfillmentBehavior || payload.orderType || "").toUpperCase() === "DELIVERY") {
    appendDeliveryAddress(lines, payload, width);
  } else {
    if (payload.destination) lines.push(`Destination: ${payload.destination}`);
    appendServiceLines(lines, payload);
  }
  if (payload.ticketRevision > 1 || payload.orderEdited) lines.push(`REV: ${payload.ticketRevision || 1}`);
  if (payload.orderEdited) {
    lines.push(center("*** ORDER UPDATED ***", width));
  }
  if (payload.isReprint) {
    lines.push(center("Duplicate of original", width));
  }
  lines.push(line("-", width));

  let lastCategory = null;
  let lastSplit = null;
  const sortedItems = sortBillItems(payload.items || []);
  const grouped = new Set(sortedItems.map(billSplitNo).filter(Boolean)).size > 1;
  // Allocate the order-level tax by cumulative buckets so rounding is not
  // repeated per split. Delivery remains a single bill-level charge.
  const splitTotals = new Map();
  if (grouped && hasMoney) {
    let taxableCents = 0;
    let nontaxableCents = 0;
    let previousTax = 0;
    for (const split of new Set(sortedItems.map(billSplitNo))) {
      const items = sortedItems.filter(item => billSplitNo(item) === split);
      let goods = 0;
      for (const item of items) {
        const amount = Number(item.lineTotalCents || 0);
        goods += amount;
        const buckets = item.unitBasePriceCents != null
          ? splitUnitTaxBuckets(item.unitBasePriceCents, item.taxApplicable !== false, item.addons || [])
          : { taxableUnitCents: item.taxApplicable !== false ? amount : 0 };
        const taxable = item.unitBasePriceCents != null
          ? buckets.taxableUnitCents * Number(item.quantity || 0)
          : buckets.taxableUnitCents;
        taxableCents += taxable;
        nontaxableCents += amount - taxable;
      }
      const cumulative = computeOrderTaxFromBuckets({ taxableCents, nontaxableCents }, payload);
      const tax = cumulative.taxCents - previousTax;
      previousTax = cumulative.taxCents;
      splitTotals.set(split, { tax, payable: goods + (payload.taxEnabled && payload.taxMode === "exclusive" ? tax : 0) });
    }
  }
  for (const item of sortedItems) {
    const split = billSplitNo(item);
    const category = String(item.category || "").trim();
    if (split !== lastSplit) {
      if (grouped && lastSplit !== null) lines.push(line("-", width));
      lastCategory = null;
      lastSplit = split;
      if (grouped && split) {
        const totals = splitTotals.get(split);
        lines.push(receiptColumns(`Order ${split}`, totals ? fmt(totals.payable) : "", width));
      }
    }
    if (category && category !== lastCategory) {
      lines.push(category.toUpperCase());
      lastCategory = category;
    }
    const lineTotal = item.lineTotalCents;
    lines.push(receiptColumns(`${item.quantity} × ${item.name}`,
      lineTotal != null && hasMoney ? itemFmt(lineTotal) : "", width));
    if (item.variantName) lines.push(`        ${item.variantName}`);
    if (item.unitBasePriceCents != null && hasMoney) {
      lines.push(
        item.variantName
          ? `        Unit ${itemFmt(item.unitBasePriceCents)}`
          : `        Base ${itemFmt(item.unitBasePriceCents)}`
      );
    }
    const notes = item.instructions || [];
    for (const note of grouped && split ? notes.slice(1) : notes) {
      lines.push(`        ${note}`);
    }
    for (const addon of item.addons || []) {
      const price = Number(addon.linePriceCents || 0);
      const label =
        price === 0
          ? `${addon.name}  ${itemFmt(0)}`
          : `${addon.name}  ${formatSignedMoney(price, shop, itemFmt)}`;
      lines.push(`        ${label}`);
    }
  }

  lines.push(line("-", width));
  if (hasMoney) {
    const totalsStart = lines.length;
    const goods =
      payload.goodsCents != null ? payload.goodsCents : payload.totalCents;
    const taxEnabled = Boolean(payload.taxEnabled);
    const mode = String(payload.taxMode || "");
    const taxName = payload.taxName || "Tax";
    const rateLabel = formatTaxPercentFromBps(payload.taxRateBps || 0);

    const taxable =
      payload.taxableGoodsCents != null
        ? Number(payload.taxableGoodsCents)
        : goods;
    const nontaxable = Number(payload.nontaxableGoodsCents || 0);

    if (taxEnabled && mode === "exclusive") {
      lines.push(`Subtotal  ${fmt(goods)}`);
      if (nontaxable > 0 || taxable !== goods) {
        lines.push(`Taxable  ${fmt(taxable)}`);
        if (nontaxable > 0) lines.push(`Non-taxable  ${fmt(nontaxable)}`);
      }
      if (receipt.showTaxName !== false) {
        lines.push(`${taxName} ${rateLabel}%  ${fmt(payload.taxCents || 0)}`);
      }
      pushCustomerTotal(lines, fmt, payload);
    } else if (taxEnabled && mode === "inclusive") {
      const itemsCharged = Number(payload.totalCents || 0) - deliveryAmount(payload);
      lines.push(
        `Total (incl. tax)  ${fmt(showDelivery(payload) ? itemsCharged : payload.totalCents)}`
      );
      if (nontaxable > 0 || taxable !== goods) {
        lines.push(`Taxable  ${fmt(taxable)}`);
        if (nontaxable > 0) lines.push(`Non-taxable  ${fmt(nontaxable)}`);
      }
      lines.push(`Net  ${fmt(payload.netCents || 0)}`);
      if (receipt.showTaxName !== false) {
        lines.push(
          `Incl. ${taxName} ${rateLabel}%  ${fmt(payload.taxCents || 0)}`
        );
      }
      if (showDelivery(payload)) {
        lines.push(`Delivery charge  ${fmt(deliveryAmount(payload))}`);
        lines.push(`Customer total  ${fmt(payload.totalCents)}`);
      }
    } else if (payload.totalCents != null) {
      lines.push(`Subtotal  ${fmt(goods)}`);
      pushCustomerTotal(lines, fmt, payload);
    }
    for (let i = totalsStart; i < lines.length; i++) {
      const split = lines[i].lastIndexOf("  ");
      if (split >= 0) lines[i] = receiptColumns(lines[i].slice(0, split), lines[i].slice(split + 2), width);
    }
    if (taxEnabled && mode === "inclusive" && !showDelivery(payload)) {
      lines.push(receiptColumns("TOTAL", payload.totalFormatted || fmt(payload.totalCents), width));
    }
    lines.push(line("-", width));
  }

  if (payload.tokenNumber != null) lines.push(center(`Reference# ${payload.tokenNumber}`, width));
  if (payload.receiptFooter) {
    lines.push(center(String(payload.receiptFooter), width));
  }
  lines.push(center("TEST DATA — NOT A CUSTOMER BILL", width));
  if (!payload.taxEnabled) {
    lines.push(center("NO TAXES / PAYMENTS", width));
  } else {
    lines.push(center("NO PAYMENTS — TEST ONLY", width));
  }
  lines.push("");
  return lines.join("\n");
}

export function renderTicketText(jobType, payload, options = {}) {
  if (jobType === "CASHIER") {
    return renderCashierReceipt(payload, options);
  }
  return renderKitchenTicket(payload, options);
}

/**
 * Synthetic receipt preview for Shop Settings (never dispatched to printers).
 */
export function renderShopReceiptPreview(shop, taxBreakdown, options = {}) {
  const width = wrapWidth(options.paperWidthMm || 80);
  const money = {
    currency_code: shop.currencyCode,
    currency_label: shop.currencyLabel,
    currency_decimals: shop.currencyDecimals,
  };
  const fmt = (m) => formatMoneyMinor(m, money);
  const receipt = shop.receipt || {};
  const lines = [];
  lines.push(center("RECEIPT PREVIEW", width));
  lines.push(center("(not a real order)", width));
  lines.push(line("=", width));
  if (receipt.showDisplayName !== false) {
    lines.push(center(shop.displayName || "Shop", width));
  }
  if (receipt.showLegalName && shop.legalName) {
    lines.push(center(shop.legalName, width));
  }
  if (receipt.showAddress && shop.addressText) {
    for (const part of String(shop.addressText).split(/\n+/)) {
      const t = part.trim();
      if (t) lines.push(center(t, width));
    }
  }
  if (receipt.showPhone && shop.phone) {
    lines.push(center(`Tel: ${shop.phone}`, width));
  }
  if (receipt.showWhatsapp !== false && shop.whatsapp) {
    lines.push(center(`WhatsApp: ${shop.whatsapp}`, width));
  }
  if (receipt.showRegistration && shop.registrationNumber) {
    lines.push(center(`CR: ${shop.registrationNumber}`, width));
  }
  if (
    receipt.showTaxNumber &&
    shop.taxEnabled &&
    shop.taxRegistrationNumber
  ) {
    lines.push(center(`Tax No: ${shop.taxRegistrationNumber}`, width));
  }
  lines.push(line("-", width));
  lines.push(`1 × Sample Item  ${fmt(taxBreakdown.goodsCents)}`);
  lines.push(line("-", width));

  const taxName = taxBreakdown.taxName || shop.taxName || "Tax";
  const rateLabel = formatTaxPercentFromBps(taxBreakdown.taxRateBps || 0);
  if (!taxBreakdown.taxEnabled) {
    lines.push(`TOTAL  ${fmt(taxBreakdown.totalCents)}`);
    lines.push(center("Tax disabled", width));
  } else if (taxBreakdown.taxMode === "exclusive") {
    lines.push(`Subtotal (net)  ${fmt(taxBreakdown.netCents)}`);
    if (receipt.showTaxName !== false) {
      lines.push(`${taxName} ${rateLabel}%  ${fmt(taxBreakdown.taxCents)}`);
    }
    lines.push(`TOTAL  ${fmt(taxBreakdown.totalCents)}`);
  } else {
    lines.push(`Total (incl. tax)  ${fmt(taxBreakdown.totalCents)}`);
    lines.push(`Net  ${fmt(taxBreakdown.netCents)}`);
    if (receipt.showTaxName !== false) {
      lines.push(
        `Incl. ${taxName} ${rateLabel}%  ${fmt(taxBreakdown.taxCents)}`
      );
    }
  }
  lines.push(line("-", width));
  if (receipt.footer) {
    lines.push(center(String(receipt.footer), width));
  }
  lines.push(center("PREVIEW ONLY — NOT DISPATCHED", width));
  lines.push("");
  return lines.join("\n");
}
