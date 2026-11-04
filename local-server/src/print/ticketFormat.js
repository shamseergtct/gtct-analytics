import { formatTicketTime } from "../util/time.js";
import { formatMoneyMinor } from "../util/money.js";
import { formatTaxPercentFromBps } from "../services/tax.js";

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
export function renderKitchenTicket(payload, options = {}) {
  const width = wrapWidth(options.paperWidthMm || 80);
  const lines = [];
  lines.push(center(headerName(payload), width));
  lines.push(center("KITCHEN TEST", width));
  lines.push(line("-", width));
  lines.push(`STATION: ${String(payload.stationName || "").toUpperCase()}`);
  lines.push(`ORDER: ${payload.orderNumber}`);
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
export function renderCashierReceipt(payload, options = {}) {
  const width = wrapWidth(options.paperWidthMm || 80);
  const shop = moneyShop(payload);
  const hasMoney =
    payload.currencyLabel != null ||
    payload.currencyCode != null ||
    payload.totalCents != null;
  const fmt = (minor) =>
    hasMoney ? formatMoneyMinor(minor, shop) : String(minor ?? "");
  const receipt = payload.receipt || {};

  const lines = [];
  if (receipt.showDisplayName !== false) {
    lines.push(center(headerName(payload), width));
  }
  if (receipt.showLegalName && payload.shopLegalName) {
    lines.push(center(String(payload.shopLegalName), width));
  }
  lines.push(center("CASHIER TEST RECEIPT", width));
  if (receipt.showAddress && payload.addressText) {
    for (const part of String(payload.addressText).split(/\n+/)) {
      const t = part.trim();
      if (t) lines.push(center(t, width));
    }
  }
  if (receipt.showPhone && payload.phone) {
    lines.push(center(`Tel: ${payload.phone}`, width));
  }
  if (receipt.showWhatsapp !== false && payload.whatsapp) {
    lines.push(center(`WhatsApp: ${payload.whatsapp}`, width));
  }
  if (receipt.showRegistration && payload.registrationNumber) {
    lines.push(center(`CR: ${payload.registrationNumber}`, width));
  }
  if (
    receipt.showTaxNumber &&
    payload.taxEnabled &&
    payload.taxRegistrationNumber
  ) {
    lines.push(center(`Tax No: ${payload.taxRegistrationNumber}`, width));
  }
  lines.push(line("=", width));
  lines.push(`ORDER: ${payload.orderNumber}`);
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
  lines.push(line("-", width));

  let lastCategory = null;
  let lastSplit = null;
  for (const item of sortBillItems(payload.items || [])) {
    const split = billSplitNo(item);
    const category = String(item.category || "").trim();
    if (split !== lastSplit) {
      lastCategory = null;
      lastSplit = split;
    }
    if (category && category !== lastCategory) {
      lines.push(category.toUpperCase());
      lastCategory = category;
    }
    const lineTotal = item.lineTotalCents;
    const displayName = item.variantName
      ? `${item.name} — ${item.variantName}`
      : item.name;
    const head =
      lineTotal != null && hasMoney
        ? `${item.quantity} × ${displayName}  ${fmt(lineTotal)}`
        : `${item.quantity} × ${displayName}`;
    lines.push(head);
    if (item.unitBasePriceCents != null && hasMoney) {
      lines.push(
        item.variantName
          ? `  Unit ${fmt(item.unitBasePriceCents)}`
          : `  Base ${fmt(item.unitBasePriceCents)}`
      );
    }
    for (const note of item.instructions || []) {
      lines.push(`  - ${note}`);
    }
    for (const addon of item.addons || []) {
      const price = Number(addon.linePriceCents || 0);
      const label =
        price === 0
          ? `${addon.name}  ${fmt(0)}`
          : `${addon.name}  ${formatSignedMoney(price, shop, fmt)}`;
      lines.push(`  ${label}`);
    }
  }

  lines.push(line("-", width));
  if (hasMoney) {
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
    lines.push(line("-", width));
  }

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
