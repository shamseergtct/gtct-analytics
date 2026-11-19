import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { loadConfig } from "../config.js";
import { getShopSettings } from "./shopSettings.js";
import { formatMoneyMinor } from "../util/money.js";

function serviceFields(order) {
  let serverName = "";
  if (order.created_by_user_id) {
    try {
      const user = getDb()
        .prepare(
          `SELECT full_name, username FROM staff_users
           WHERE user_id = ? AND shop_id = ?`
        )
        .get(order.created_by_user_id, order.tenant_id);
      serverName = user?.full_name || user?.username || "";
    } catch {
      serverName = "";
    }
  }
  return {
    orderTypeName: order.order_type_name || "",
    fulfillmentBehavior: order.fulfillment_behavior || "",
    customerName: order.customer_name || "",
    customerPhone: order.customer_phone || "",
    buildingNumber: order.building_number || "",
    roadNumber: order.road_number || "",
    blockNumber: order.block_number || "",
    addressNote: order.address_note || "",
    tableNumber: order.table_number || "",
    vehicleNumber: order.vehicle_number || "",
    parkingLocation: order.parking_location || "",
    deliveryChargeCents: Number(order.delivery_charge_cents || 0),
    deliveryFeeTaxTreatment: order.delivery_fee_tax_treatment || "",
    serverName,
    terminalName: order.created_by_terminal_name || "",
  };
}

function kitchenMoneyFields(order, shop) {
  return {
    currencyCode: order.currency_code || shop?.currencyCode || "",
    currencyLabel: order.currency_label || shop?.currencyLabel || "",
    currencyDecimals:
      order.currency_decimals != null && order.currency_decimals !== ""
        ? Number(order.currency_decimals)
        : Number(shop?.currencyDecimals ?? 2),
  };
}

function buildIdempotencyKey({
  tenantId,
  orderId,
  stationId,
  jobType,
  ticketRevision,
  printerId,
}) {
  return [
    tenantId,
    orderId,
    jobType,
    stationId || "NONE",
    printerId,
    `rev${ticketRevision}`,
  ].join("::");
}

function insertJob(db, row) {
  const existing = db
    .prepare(`SELECT * FROM print_jobs WHERE idempotency_key = ?`)
    .get(row.idempotencyKey);
  if (existing) return { job: existing, created: false };

  const ts = nowIso();
  db.prepare(
    `INSERT INTO print_jobs (
      job_id, tenant_id, order_id, station_id, printer_id, ticket_revision,
      job_type, idempotency_key, payload_snapshot, status, attempt_count,
      last_error, is_reprint, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, NULL, 0, ?, ?)`
  ).run(
    row.jobId,
    row.tenantId,
    row.orderId,
    row.stationId,
    row.printerId,
    row.ticketRevision,
    row.jobType,
    row.idempotencyKey,
    row.payloadSnapshot,
    ts,
    ts
  );
  db.prepare(
    `INSERT INTO print_job_events (event_id, job_id, from_status, to_status, note, created_at)
     VALUES (?, ?, NULL, 'PENDING', ?, ?)`
  ).run(newId("evt"), row.jobId, row.note || "Enqueued", ts);

  return {
    job: db.prepare(`SELECT * FROM print_jobs WHERE job_id = ?`).get(row.jobId),
    created: true,
  };
}

function stationPrinter(db, stationId) {
  return db
    .prepare(
      `SELECT p.* FROM station_printers sp
       JOIN printers p ON p.printer_id = sp.printer_id
       WHERE sp.station_id = ? AND p.is_active = 1
       LIMIT 1`
    )
    .get(stationId);
}

/** Prefer CASHIER station printer; fall back so receipts still print in single-printer shops. */
function resolveCashierPrinter(db) {
  const assigned = stationPrinter(db, "station_cashier");
  if (assigned) return { printer: assigned, source: "station_cashier" };
  const preferred = db
    .prepare(
      `SELECT p.* FROM printers p
       WHERE p.is_active = 1 AND p.connection_type = 'NETWORK_TCP'
       ORDER BY p.updated_at DESC, p.display_name
       LIMIT 1`
    )
    .get();
  if (preferred) return { printer: preferred, source: "fallback_network_tcp" };
  const anyActive = db
    .prepare(
      `SELECT p.* FROM printers p
       WHERE p.is_active = 1
       ORDER BY p.updated_at DESC, p.display_name
       LIMIT 1`
    )
    .get();
  if (anyActive) return { printer: anyActive, source: "fallback_active" };
  return { printer: null, source: "none" };
}

function ticketLineSignature(line) {
  const name = line.item_name || line.name || "";
  const variant = line.variant_name || line.variantName || "";
  const notes = (line.instructions || []).map((note) => String(note.label || note)).join("|");
  const addons = (line.addons || [])
    .map((addon) => `${addon.addon_name || addon.name}:${Number(addon.quantity || 1)}`)
    .join("|");
  return `${name}::${variant}::${Number(line.quantity || 0)}::${notes}::${addons}`;
}

function removedTicketLines(previous, current) {
  const remaining = (current || []).map(ticketLineSignature);
  const removed = [];
  for (const line of previous || []) {
    const signature = ticketLineSignature(line);
    const index = remaining.indexOf(signature);
    if (index >= 0) remaining.splice(index, 1);
    else {
      removed.push({
        name: line.name || line.item_name,
        quantity: Number(line.quantity || 0),
        variantName: line.variantName || line.variant_name || "",
        instructions: line.instructions || [],
        addons: line.addons || [],
      });
    }
  }
  return removed;
}

/** Lines in current that do not match a previous signature (new or changed). */
function newOrChangedTicketLines(previous, current) {
  const remaining = (previous || []).map(ticketLineSignature);
  const changed = [];
  for (const line of current || []) {
    const signature = ticketLineSignature(line);
    const index = remaining.indexOf(signature);
    if (index >= 0) remaining.splice(index, 1);
    else changed.push(line);
  }
  return changed;
}

function cancelledKitchenItems(removed) {
  return (removed || []).map((item) => {
    const name = String(item.name || item.item_name || "").trim() || "ITEM";
    const qty = Number(item.quantity || 0);
    return {
      name: `CANCELLED: ${name} x${qty}`,
      quantity: "",
      instructions: [],
      addons: [],
      variantName: "",
      unitBasePriceCents: 0,
      unitAddonsCents: 0,
      unitTotalCents: 0,
      lineTotalCents: 0,
      stationName: null,
    };
  });
}

/**
 * Enqueue kitchen jobs per station and/or an unpaid cashier bill.
 * Paid cashier receipts are enqueued after payment via enqueueCashierReceiptAfterPayment.
 * Unmapped kitchen lines produce a NEEDS_REVIEW placeholder job on cashier printer
 * so items are never silently discarded.
 *
 * options.includeKitchen — default true
 * options.includeCashier — default false (set true to print bill before payment)
 */
export function enqueuePrintJobsForOrder(orderId, ticketRevision, config, options = {}) {
  const db = getDb();
  const cfg = config || loadConfig({ mode: "script" });
  const order = db.prepare(`SELECT * FROM orders WHERE order_id = ?`).get(orderId);
  if (!order) throw new Error(`Order not found: ${orderId}`);

  let shopDisplayName = order.shop_display_name || cfg.restaurantDisplayName;
  let shopSettings = null;
  try {
    shopSettings = getShopSettings(order.tenant_id);
    if (!order.shop_display_name) shopDisplayName = shopSettings.displayName;
  } catch {
    /* ignore */
  }
  const moneyFields = kitchenMoneyFields(order, shopSettings);

  const lines = db
    .prepare(`SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index`)
    .all(orderId);
  const instrStmt = db.prepare(
    `SELECT label FROM order_line_instructions WHERE line_id = ? ORDER BY sort_index`
  );
  const addonStmt = db.prepare(
    `SELECT addon_name, quantity, unit_price_cents, line_price_cents
     FROM order_line_addons WHERE line_id = ? ORDER BY sort_index`
  );
  const stationStmt = db.prepare(
    `SELECT * FROM stations WHERE station_id = ?`
  );
  const billMetaStmt = db.prepare(
    `SELECT mi.sort_order AS item_sort,
            mi.category AS category,
            mi.subcategory AS subcategory,
            c.sort_order AS category_sort,
            s.sort_order AS subcategory_sort
     FROM menu_items mi
     LEFT JOIN menu_categories c ON c.category_id = mi.category_id
     LEFT JOIN menu_subcategories s ON s.subcategory_id = mi.subcategory_id
     WHERE mi.item_id = ?`
  );

  function mapLineItems(lineRows) {
    return lineRows.map((l) => ({
      name: l.item_name,
      quantity: l.quantity,
      instructions: l.instructions,
      addons: l.addons,
      variantId: l.variant_id || null,
      variantName: l.variant_name || "",
      unitBasePriceCents: Number(l.unit_base_price_cents || 0),
      unitAddonsCents: Number(l.unit_addons_cents || 0),
      unitTotalCents: Number(l.unit_total_cents || 0),
      lineTotalCents: Number(l.line_total_cents || 0),
      stationName: l.station?.name || null,
    }));
  }

  const decorated = lines.map((line) => ({
    ...line,
    instructions: instrStmt.all(line.line_id).map((r) => r.label),
    addons: addonStmt.all(line.line_id).map((r) => ({
      name: r.addon_name,
      quantity: Number(r.quantity),
      unitPriceCents: Number(r.unit_price_cents),
      linePriceCents: Number(r.line_price_cents),
    })),
    station: line.station_id ? stationStmt.get(line.station_id) : null,
  }));

  const results = [];
  const byStation = new Map();

  for (const line of decorated) {
    if (!line.station_id) continue;
    if (!byStation.has(line.station_id)) byStation.set(line.station_id, []);
    byStation.get(line.station_id).push(line);
  }

  const orderEdited = options.orderEdited === true;
  const previousByStation = new Map();
  for (const line of options.previousLines || []) {
    if (!line.stationId) continue;
    if (!previousByStation.has(line.stationId)) previousByStation.set(line.stationId, []);
    previousByStation.get(line.stationId).push(line);
  }
  function stationChanged(stationId) {
    if (!orderEdited) return true;
    const before = (previousByStation.get(stationId) || []).map(ticketLineSignature).sort().join("||");
    const after = (byStation.get(stationId) || []).map(ticketLineSignature).sort().join("||");
    return before !== after;
  }

  const includeKitchen = options.includeKitchen !== false;
  const includeCashier = options.includeCashier === true;

  const tx = db.transaction(() => {
    if (includeKitchen) {
    for (const [stationId, stationLines] of byStation.entries()) {
      if (!stationChanged(stationId)) continue;
      const station = stationStmt.get(stationId);
      const printer = stationPrinter(db, stationId);
      const prevStationLines = previousByStation.get(stationId) || [];
      const removedItems = orderEdited
        ? removedTicketLines(prevStationLines, stationLines)
        : [];
      const kitchenLines = orderEdited
        ? newOrChangedTicketLines(prevStationLines, stationLines)
        : stationLines;
      const items = orderEdited
        ? [...mapLineItems(kitchenLines), ...cancelledKitchenItems(removedItems)]
        : mapLineItems(stationLines);
      if (orderEdited && items.length === 0) continue;
      if (!printer) {
        // Explicit failure path — do not drop station items
        const cashierPrinter = stationPrinter(db, "station_cashier");
        if (!cashierPrinter) {
          throw new Error(
            `No printer for station ${stationId} and no cashier fallback`
          );
        }
        const payload = {
          restaurantDisplayName: shopDisplayName,
          shopDisplayName,
          orderNumber: order.order_number,
          tokenNumber: order.token_number == null ? null : Number(order.token_number),
          businessDate: order.business_date || null,
          ticketId: `${order.order_number}-${stationId}-UNROUTED`,
          stationName: station?.name || stationId,
          orderType: order.order_type,
          destination: order.destination,
          ...serviceFields(order),
          ...moneyFields,
          createdAt: order.created_at,
          updatedAt: order.updated_at,
          ticketRevision,
          isReprint: false,
          orderEdited,
          removedItems: [],
          items,
          warning: orderEdited
            ? "REVISED ORDER — NO PRINTER ASSIGNED TO STATION"
            : "NO PRINTER ASSIGNED TO STATION",
        };
        const key = buildIdempotencyKey({
          tenantId: order.tenant_id,
          orderId,
          stationId,
          jobType: "KITCHEN",
          ticketRevision,
          printerId: cashierPrinter.printer_id,
        });
        const { job, created } = insertJob(db, {
          jobId: newId("job"),
          tenantId: order.tenant_id,
          orderId,
          stationId,
          printerId: cashierPrinter.printer_id,
          ticketRevision,
          jobType: "KITCHEN",
          idempotencyKey: key,
          payloadSnapshot: JSON.stringify(payload),
          note: "Enqueued without station printer — operator must assign printer",
        });
        if (created) {
          db.prepare(
            `UPDATE print_jobs SET status = 'NEEDS_REVIEW', last_error = ?, updated_at = ? WHERE job_id = ?`
          ).run("No printer assigned to station", nowIso(), job.job_id);
          db.prepare(
            `INSERT INTO print_job_events (event_id, job_id, from_status, to_status, note, created_at)
             VALUES (?, ?, 'PENDING', 'NEEDS_REVIEW', ?, ?)`
          ).run(
            newId("evt"),
            job.job_id,
            "No printer assigned to station",
            nowIso()
          );
        }
        results.push(db.prepare(`SELECT * FROM print_jobs WHERE job_id = ?`).get(job.job_id));
        continue;
      }

      const payload = {
        restaurantDisplayName: shopDisplayName,
      shopDisplayName,
        orderNumber: order.order_number,
          tokenNumber: order.token_number == null ? null : Number(order.token_number),
          businessDate: order.business_date || null,
        ticketId: `${order.order_number}-${stationId}-r${ticketRevision}`,
        stationName: station?.name || stationId,
        orderType: order.order_type,
        destination: order.destination,
        ...serviceFields(order),
        ...moneyFields,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        ticketRevision,
        isReprint: false,
        orderEdited,
        removedItems: [],
        items,
        ...(orderEdited ? { warning: "REVISED ORDER" } : {}),
      };

      const key = buildIdempotencyKey({
        tenantId: order.tenant_id,
        orderId,
        stationId,
        jobType: "KITCHEN",
        ticketRevision,
        printerId: printer.printer_id,
      });

      const { job } = insertJob(db, {
        jobId: newId("job"),
        tenantId: order.tenant_id,
        orderId,
        stationId,
        printerId: printer.printer_id,
        ticketRevision,
        jobType: "KITCHEN",
        idempotencyKey: key,
        payloadSnapshot: JSON.stringify(payload),
        note: "Kitchen ticket enqueued",
      });
      results.push(job);
    }

    if (orderEdited) {
      for (const [stationId, oldLines] of previousByStation.entries()) {
        if (byStation.has(stationId) || !stationChanged(stationId)) continue;
        const station = stationStmt.get(stationId);
        const printer = stationPrinter(db, stationId) || stationPrinter(db, "station_cashier");
        if (!printer) continue;
        const removedItems = removedTicketLines(oldLines, []);
        if (!removedItems.length) continue;
        const payload = {
          restaurantDisplayName: shopDisplayName,
          shopDisplayName,
          orderNumber: order.order_number,
          tokenNumber: order.token_number == null ? null : Number(order.token_number),
          businessDate: order.business_date || null,
          ticketId: `${order.order_number}-${stationId}-r${ticketRevision}`,
          stationName: station?.name || stationId,
          orderType: order.order_type,
          destination: order.destination,
          ...serviceFields(order),
          ...moneyFields,
          createdAt: order.created_at,
          updatedAt: order.updated_at,
          ticketRevision,
          isReprint: false,
          orderEdited: true,
          removedItems: [],
          items: cancelledKitchenItems(removedItems),
          warning: "REVISED ORDER",
        };
        const key = buildIdempotencyKey({
          tenantId: order.tenant_id,
          orderId,
          stationId,
          jobType: "KITCHEN",
          ticketRevision,
          printerId: printer.printer_id,
        });
        const { job } = insertJob(db, {
          jobId: newId("job"),
          tenantId: order.tenant_id,
          orderId,
          stationId,
          printerId: printer.printer_id,
          ticketRevision,
          jobType: "KITCHEN",
          idempotencyKey: key,
          payloadSnapshot: JSON.stringify(payload),
          note: "Edited order — items removed from this preparation station",
        });
        results.push(job);
      }
    }

    // Ambiguous/broken prep mappings only — intentional no-prep (null station) is NOT unmapped.
    const unmappedMeta = options.unmapped || [];
    if (unmappedMeta.length > 0) {
      const unmappedIds = new Set(unmappedMeta.map((u) => u.itemId));
      const unmappedLines = decorated.filter((l) => unmappedIds.has(l.item_id));
      const cashierPrinter = stationPrinter(db, "station_cashier");
      if (cashierPrinter) {
        const payload = {
          restaurantDisplayName: shopDisplayName,
      shopDisplayName,
          orderNumber: order.order_number,
          tokenNumber: order.token_number == null ? null : Number(order.token_number),
          businessDate: order.business_date || null,
          ticketId: `${order.order_number}-UNMAPPED-r${ticketRevision}`,
          stationName: "UNMAPPED",
          orderType: order.order_type,
          destination: order.destination,
          ...serviceFields(order),
          ...moneyFields,
          createdAt: order.created_at,
          ticketRevision,
          isReprint: false,
          items: mapLineItems(unmappedLines),
          warning: "UNMAPPED KITCHEN ITEMS — REQUIRES OPERATOR REVIEW",
          unmapped: unmappedMeta,
        };
        const key = buildIdempotencyKey({
          tenantId: order.tenant_id,
          orderId,
          stationId: "UNMAPPED",
          jobType: "KITCHEN",
          ticketRevision,
          printerId: cashierPrinter.printer_id,
        });
        const { job, created } = insertJob(db, {
          jobId: newId("job"),
          tenantId: order.tenant_id,
          orderId,
          stationId: null,
          printerId: cashierPrinter.printer_id,
          ticketRevision,
          jobType: "KITCHEN",
          idempotencyKey: key,
          payloadSnapshot: JSON.stringify(payload),
          note: "Unmapped items — needs review",
        });
        if (created) {
          db.prepare(
            `UPDATE print_jobs SET status = 'NEEDS_REVIEW', last_error = ?, updated_at = ? WHERE job_id = ?`
          ).run("Unmapped kitchen items", nowIso(), job.job_id);
          db.prepare(
            `INSERT INTO print_job_events (event_id, job_id, from_status, to_status, note, created_at)
             VALUES (?, ?, 'PENDING', 'NEEDS_REVIEW', ?, ?)`
          ).run(newId("evt"), job.job_id, "Unmapped kitchen items", nowIso());
        }
        results.push(
          db.prepare(`SELECT * FROM print_jobs WHERE job_id = ?`).get(job.job_id)
        );
      }
    }
    } // includeKitchen

    // Unpaid cashier bill (before payment). Paid receipts use enqueueCashierReceiptAfterPayment.
    if (includeCashier) {
      const cashierJob = insertCashierJob(db, {
        order,
        shopDisplayName,
        decorated,
        unmappedMeta: options.unmapped || [],
        billMetaStmt,
        stationStmt,
        ticketRevision,
        orderEdited,
        paymentSummary: null,
      });
      results.push(cashierJob);
    }
  });

  tx();
  return results;
}

function insertCashierJob(db, ctx) {
  const {
    order,
    shopDisplayName,
    decorated,
    unmappedMeta,
    billMetaStmt,
    stationStmt,
    ticketRevision,
    orderEdited,
    paymentSummary,
  } = ctx;
  const cashierStation = stationStmt.get("station_cashier");
  const { printer: cashierPrinter, source: printerSource } = resolveCashierPrinter(db);
  if (!cashierPrinter) {
    throw Object.assign(
      new Error(
        "No cashier printer available. Assign a printer to the CASHIER station (or keep at least one active printer)."
      ),
      { status: 409, code: "CASHIER_PRINTER_MISSING" }
    );
  }

  const cashierPayload = {
    restaurantDisplayName: shopDisplayName,
    shopDisplayName,
    orderNumber: order.order_number,
    tokenNumber: order.token_number == null ? null : Number(order.token_number),
    businessDate: order.business_date || null,
    ticketId: `${order.order_number}-CASHIER-r${ticketRevision}`,
    stationName: cashierStation?.name || "CASHIER",
    orderType: order.order_type,
    destination: order.destination,
    ...serviceFields(order),
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    ticketRevision,
    isReprint: false,
    orderEdited,
    paymentConfirmed: Boolean(paymentSummary),
    paymentSummary: paymentSummary || null,
    totalCents: Number(order.total_cents || 0),
    goodsCents: Number(order.goods_cents ?? order.total_cents ?? 0),
    taxableGoodsCents: Number(
      order.taxable_goods_cents ?? order.goods_cents ?? order.total_cents ?? 0
    ),
    nontaxableGoodsCents: Number(order.nontaxable_goods_cents || 0),
    netCents: Number(order.net_cents ?? order.total_cents ?? 0),
    taxCents: Number(order.tax_cents || 0),
    taxEnabled: Boolean(order.tax_enabled),
    taxMode: order.tax_mode || "",
    taxRateBps: Number(order.tax_rate_bps || 0),
    taxName: order.tax_name || "",
    taxRegistrationNumber: order.tax_registration_number || "",
    shopLegalName: order.shop_legal_name || "",
    items: decorated.map((l) => {
      const isProblem = unmappedMeta.some((u) => u.itemId === l.item_id);
      let stationName = "No Preparation";
      if (l.station?.name) stationName = l.station.name;
      else if (l.station_id) stationName = l.station_id;
      else if (isProblem) stationName = "UNMAPPED";
      const meta = billMetaStmt.get(l.item_id) || {};
      return {
        name: l.item_name,
        quantity: l.quantity,
        instructions: l.instructions,
        addons: l.addons,
        category: meta.category || "",
        subcategory: meta.subcategory || "",
        categorySort: Number.isFinite(meta.category_sort)
          ? Number(meta.category_sort)
          : undefined,
        subcategorySort: Number.isFinite(meta.subcategory_sort)
          ? Number(meta.subcategory_sort)
          : undefined,
        itemSort: Number(meta.item_sort || 0),
        variantId: l.variant_id || null,
        variantName: l.variant_name || "",
        unitBasePriceCents: Number(l.unit_base_price_cents || 0),
        unitAddonsCents: Number(l.unit_addons_cents || 0),
        unitTotalCents: Number(l.unit_total_cents || 0),
        lineTotalCents: Number(l.line_total_cents || 0),
        taxApplicable:
          l.tax_applicable == null ? true : Boolean(Number(l.tax_applicable)),
        stationName,
      };
    }),
  };
  try {
    const shop = getShopSettings(order.tenant_id);
    const moneyShop = {
      currency_code: order.currency_code || shop.currencyCode,
      currency_label: order.currency_label || shop.currencyLabel,
      currency_decimals:
        order.currency_decimals != null && order.currency_decimals !== ""
          ? Number(order.currency_decimals)
          : shop.currencyDecimals,
    };
    cashierPayload.currencyCode = moneyShop.currency_code;
    cashierPayload.currencyLabel = moneyShop.currency_label;
    cashierPayload.currencyDecimals = moneyShop.currency_decimals;
    cashierPayload.shopDisplayName = order.shop_display_name || shop.displayName;
    cashierPayload.shopLegalName = order.shop_legal_name || shop.legalName || "";
    cashierPayload.addressText = shop.addressText || "";
    cashierPayload.phone = shop.phone || "";
    cashierPayload.whatsapp = shop.whatsapp || "";
    cashierPayload.registrationNumber = shop.registrationNumber || "";
    cashierPayload.receipt = shop.receipt;
    cashierPayload.receiptFooter = shop.receipt?.footer || "";
    cashierPayload.totalFormatted = formatMoneyMinor(
      cashierPayload.totalCents,
      moneyShop
    );
  } catch {
    /* shop settings optional for older DBs mid-migrate */
  }

  const paidSuffix = paymentSummary
    ? `::paid::${paymentSummary.paymentStatus}::${paymentSummary.paidCents}::${paymentSummary.creditCents}`
    : "";
  const cashierKey =
    buildIdempotencyKey({
      tenantId: order.tenant_id,
      orderId: order.order_id,
      stationId: "station_cashier",
      jobType: "CASHIER",
      ticketRevision,
      printerId: cashierPrinter.printer_id,
    }) + paidSuffix;

  const { job: cashierJob } = insertJob(db, {
    jobId: newId("job"),
    tenantId: order.tenant_id,
    orderId: order.order_id,
    stationId: "station_cashier",
    printerId: cashierPrinter.printer_id,
    ticketRevision,
    jobType: "CASHIER",
    idempotencyKey: cashierKey,
    payloadSnapshot: JSON.stringify(cashierPayload),
    note: paymentSummary
      ? `Cashier receipt enqueued after payment confirmation (${printerSource})`
      : `Cashier receipt enqueued (${printerSource})`,
  });
  return cashierJob;
}

/**
 * Enqueue one cashier receipt only after payment/credit is fully confirmed.
 * Idempotent for the same paid/credit totals.
 */
export function enqueueCashierReceiptAfterPayment(orderId, paymentSummary, config) {
  const db = getDb();
  const cfg = config || loadConfig({ mode: "script" });
  const order = db.prepare(`SELECT * FROM orders WHERE order_id = ?`).get(orderId);
  if (!order) throw new Error(`Order not found: ${orderId}`);

  let shopDisplayName = order.shop_display_name || cfg.restaurantDisplayName;
  try {
    const liveShop = getShopSettings(order.tenant_id);
    if (!order.shop_display_name) shopDisplayName = liveShop.displayName;
  } catch {
    /* ignore */
  }

  const lines = db
    .prepare(`SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index`)
    .all(orderId);
  const instrStmt = db.prepare(
    `SELECT label FROM order_line_instructions WHERE line_id = ? ORDER BY sort_index`
  );
  const addonStmt = db.prepare(
    `SELECT addon_name, quantity, unit_price_cents, line_price_cents
     FROM order_line_addons WHERE line_id = ? ORDER BY sort_index`
  );
  const stationStmt = db.prepare(`SELECT * FROM stations WHERE station_id = ?`);
  const billMetaStmt = db.prepare(
    `SELECT mi.sort_order AS item_sort,
            mi.category AS category,
            mi.subcategory AS subcategory,
            c.sort_order AS category_sort,
            s.sort_order AS subcategory_sort
     FROM menu_items mi
     LEFT JOIN menu_categories c ON c.category_id = mi.category_id
     LEFT JOIN menu_subcategories s ON s.subcategory_id = mi.subcategory_id
     WHERE mi.item_id = ?`
  );
  const decorated = lines.map((line) => ({
    ...line,
    instructions: instrStmt.all(line.line_id).map((r) => r.label),
    addons: addonStmt.all(line.line_id).map((r) => ({
      name: r.addon_name,
      quantity: Number(r.quantity),
      unitPriceCents: Number(r.unit_price_cents),
      linePriceCents: Number(r.line_price_cents),
    })),
    station: line.station_id ? stationStmt.get(line.station_id) : null,
  }));
  const ticketRevision =
    Number(
      db
        .prepare(
          `SELECT COALESCE(MAX(ticket_revision), 0) AS n FROM print_jobs WHERE order_id = ?`
        )
        .get(orderId)?.n || 0
    ) || 1;

  return db.transaction(() =>
    insertCashierJob(db, {
      order,
      shopDisplayName,
      decorated,
      unmappedMeta: [],
      billMetaStmt,
      stationStmt,
      ticketRevision,
      orderEdited: false,
      paymentSummary,
    })
  )();
}

export function listPrintJobs(filters = {}) {
  const db = getDb();
  if (filters.status) {
    return db
      .prepare(
        `SELECT * FROM print_jobs WHERE status = ? ORDER BY created_at DESC LIMIT 200`
      )
      .all(filters.status);
  }
  if (filters.orderId) {
    return db
      .prepare(
        `SELECT * FROM print_jobs WHERE order_id = ? ORDER BY created_at`
      )
      .all(filters.orderId);
  }
  return db
    .prepare(`SELECT * FROM print_jobs ORDER BY created_at DESC LIMIT 200`)
    .all();
}

const CLEARABLE_JOB_STATUSES = [
  "DISPATCHED",
  "FAILED",
  "UNKNOWN",
  "NEEDS_REVIEW",
  "CONFIRMED",
];

/**
 * Admin-only history cleanup. Never deletes PENDING/DISPATCHING work-in-flight.
 * Does not reprint or re-queue anything.
 */
export function clearPrintJobHistory(tenantId) {
  const shopId = String(tenantId || "").trim();
  if (!shopId) {
    throw Object.assign(new Error("Shop is required."), { status: 400 });
  }
  const db = getDb();
  const placeholders = CLEARABLE_JOB_STATUSES.map(() => "?").join(",");
  const jobs = db
    .prepare(
      `SELECT job_id FROM print_jobs
       WHERE tenant_id = ? AND status IN (${placeholders})`
    )
    .all(shopId, ...CLEARABLE_JOB_STATUSES);
  const ids = jobs.map((j) => j.job_id);
  if (!ids.length) return { cleared: 0 };
  const tx = db.transaction(() => {
    const delEvents = db.prepare(`DELETE FROM print_job_events WHERE job_id = ?`);
    const delJob = db.prepare(`DELETE FROM print_jobs WHERE job_id = ? AND tenant_id = ?`);
    let cleared = 0;
    for (const jobId of ids) {
      delEvents.run(jobId);
      cleared += delJob.run(jobId, shopId).changes;
    }
    return cleared;
  });
  return { cleared: tx() };
}

/** Fill category labels on older cashier payloads so the bill can group by category. */
export function applyCashierCategories(payload) {
  if (!payload || !Array.isArray(payload.items)) return payload;
  const needs = payload.items.some((item) => !String(item?.category || "").trim());
  if (!needs) return payload;
  const db = getDb();
  const stmt = db.prepare(
    `SELECT mi.sort_order AS item_sort,
            mi.category AS category,
            mi.subcategory AS subcategory,
            c.sort_order AS category_sort,
            s.sort_order AS subcategory_sort
     FROM menu_items mi
     LEFT JOIN menu_categories c ON c.category_id = mi.category_id
     LEFT JOIN menu_subcategories s ON s.subcategory_id = mi.subcategory_id
     WHERE mi.name = ?
     ORDER BY mi.is_active DESC
     LIMIT 1`
  );
  return {
    ...payload,
    items: payload.items.map((item) => {
      if (String(item?.category || "").trim()) return item;
      const meta = stmt.get(item?.name) || {};
      return {
        ...item,
        category: meta.category || "",
        subcategory: meta.subcategory || "",
        categorySort: Number.isFinite(meta.category_sort)
          ? Number(meta.category_sort)
          : item.categorySort,
        subcategorySort: Number.isFinite(meta.subcategory_sort)
          ? Number(meta.subcategory_sort)
          : item.subcategorySort,
        itemSort: Number(meta.item_sort || item.itemSort || 0),
      };
    }),
  };
}

export function getPrintJob(jobId) {
  const db = getDb();
  const job = db.prepare(`SELECT * FROM print_jobs WHERE job_id = ?`).get(jobId);
  if (!job) return null;
  const events = db
    .prepare(
      `SELECT * FROM print_job_events WHERE job_id = ? ORDER BY created_at`
    )
    .all(jobId);
  return { ...job, events };
}
