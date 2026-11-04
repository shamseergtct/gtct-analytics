import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { loadConfig } from "../config.js";
import { getShopSettings } from "./shopSettings.js";
import { formatMoneyMinor } from "../util/money.js";

function serviceFields(order) {
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

/**
 * Enqueue kitchen jobs per station + one cashier job.
 * Unmapped kitchen lines produce a NEEDS_REVIEW placeholder job on cashier printer
 * so items are never silently discarded.
 */
export function enqueuePrintJobsForOrder(orderId, ticketRevision, config, options = {}) {
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
  const fulfillmentChanged = options.fulfillmentChanged === true;
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
    return fulfillmentChanged || before !== after;
  }

  const tx = db.transaction(() => {
    for (const [stationId, stationLines] of byStation.entries()) {
      if (!stationChanged(stationId)) continue;
      const station = stationStmt.get(stationId);
      const printer = stationPrinter(db, stationId);
      const removedItems = orderEdited
        ? removedTicketLines(previousByStation.get(stationId), stationLines)
        : [];
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
          ticketId: `${order.order_number}-${stationId}-UNROUTED`,
          stationName: station?.name || stationId,
          orderType: order.order_type,
          destination: order.destination,
          ...serviceFields(order),
          createdAt: order.created_at,
          updatedAt: order.updated_at,
          ticketRevision,
          isReprint: false,
          orderEdited,
          removedItems,
          items: mapLineItems(stationLines),
          warning: "NO PRINTER ASSIGNED TO STATION",
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
        ticketId: `${order.order_number}-${stationId}-r${ticketRevision}`,
        stationName: station?.name || stationId,
        orderType: order.order_type,
        destination: order.destination,
        ...serviceFields(order),
        createdAt: order.created_at,
        updatedAt: order.updated_at,
        ticketRevision,
        isReprint: false,
        orderEdited,
        removedItems,
        items: mapLineItems(stationLines),
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
        const payload = {
          restaurantDisplayName: shopDisplayName,
          shopDisplayName,
          orderNumber: order.order_number,
          ticketId: `${order.order_number}-${stationId}-r${ticketRevision}`,
          stationName: station?.name || stationId,
          orderType: order.order_type,
          destination: order.destination,
          ...serviceFields(order),
          createdAt: order.created_at,
          updatedAt: order.updated_at,
          ticketRevision,
          isReprint: false,
          orderEdited: true,
          removedItems,
          items: [],
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
          ticketId: `${order.order_number}-UNMAPPED-r${ticketRevision}`,
          stationName: "UNMAPPED",
          orderType: order.order_type,
          destination: order.destination,
          ...serviceFields(order),
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

    // Cashier complete receipt
    const cashierStation = stationStmt.get("station_cashier");
    const cashierPrinter = stationPrinter(db, "station_cashier");
    if (!cashierPrinter) {
      throw new Error("Cashier station has no printer assigned");
    }

    const cashierPayload = {
      restaurantDisplayName: shopDisplayName,
      shopDisplayName,
      orderNumber: order.order_number,
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
      shopDisplayName: order.shop_display_name || "",
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
            l.tax_applicable == null
              ? true
              : Boolean(Number(l.tax_applicable)),
          stationName,
        };
      }),
    };
    try {
      const shop = getShopSettings(order.tenant_id);
      // Prefer order-time currency snapshot when present (historical freeze).
      const moneyShop = {
        currency_code:
          order.currency_code || shop.currencyCode,
        currency_label:
          order.currency_label || shop.currencyLabel,
        currency_decimals:
          order.currency_decimals != null && order.currency_decimals !== ""
            ? Number(order.currency_decimals)
            : shop.currencyDecimals,
      };
      cashierPayload.currencyCode = moneyShop.currency_code;
      cashierPayload.currencyLabel = moneyShop.currency_label;
      cashierPayload.currencyDecimals = moneyShop.currency_decimals;
      cashierPayload.shopDisplayName =
        order.shop_display_name || shop.displayName;
      cashierPayload.shopLegalName =
        order.shop_legal_name || shop.legalName || "";
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
      // Kitchen-facing display name preference
      for (const job of results) {
        /* kitchen payloads already inserted; cashier only here */
      }
    } catch {
      /* shop settings optional for older DBs mid-migrate */
    }

    const cashierKey = buildIdempotencyKey({
      tenantId: order.tenant_id,
      orderId,
      stationId: "station_cashier",
      jobType: "CASHIER",
      ticketRevision,
      printerId: cashierPrinter.printer_id,
    });

    const { job: cashierJob } = insertJob(db, {
      jobId: newId("job"),
      tenantId: order.tenant_id,
      orderId,
      stationId: "station_cashier",
      printerId: cashierPrinter.printer_id,
      ticketRevision,
      jobType: "CASHIER",
      idempotencyKey: cashierKey,
      payloadSnapshot: JSON.stringify(cashierPayload),
      note: "Cashier receipt enqueued",
    });
    results.push(cashierJob);
  });

  tx();
  return results;
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
