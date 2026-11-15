import { createHash } from "node:crypto";
import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { dedupeInstructions, getStationsForItem } from "./menuMappings.js";
import { enqueuePrintJobsForOrder } from "./printQueue.js";
import {
  canAdjustAddonPrices,
  canAdjustBasePrices,
  resolveOrderAddons,
  sumAddonMinor,
} from "./addons.js";
import { validateOrderInstructions } from "./kitchenLibrary.js";
import { recordAudit } from "./audit.js";
import { allocateTokenInOrderTransaction, assertOrderShiftOpenForEdit } from "./businessShifts.js";
import { getShopSettings } from "./shopSettings.js";
import {
  computeDeliveryFeeTax,
  computeOrderTaxFromBuckets,
  splitUnitTaxBuckets,
} from "./tax.js";
import { resolveVariantForOrder } from "./variants.js";
import { resolveSaleFulfillment } from "./orderSetup.js";

function existingOrderResult(db, order) {
  const jobs = db
    .prepare(`SELECT * FROM print_jobs WHERE order_id = ? ORDER BY created_at`)
    .all(order.order_id);
  return { order, jobs, created: false };
}

function formatShopOrderNumber(sequence) {
  return `TEST-UI-${String(sequence).padStart(6, "0")}`;
}

function nextShopOrderNumber(db, shopId) {
  db.prepare(
    `INSERT INTO shop_order_counters (shop_id, last_number) VALUES (?, 0)
     ON CONFLICT(shop_id) DO NOTHING`
  ).run(shopId);
  const row = db
    .prepare(
      `UPDATE shop_order_counters
       SET last_number = last_number + 1
       WHERE shop_id = ?
       RETURNING last_number`
    )
    .get(shopId);
  return formatShopOrderNumber(row.last_number);
}

function isShopSequencePreview(orderNumber) {
  return /^TEST-UI-\d{6}$/.test(String(orderNumber || ""));
}

export function peekNextOrderNumber(shopId) {
  const db = getDb();
  db.prepare(
    `INSERT INTO shop_order_counters (shop_id, last_number) VALUES (?, 0)
     ON CONFLICT(shop_id) DO NOTHING`
  ).run(shopId);
  const row = db
    .prepare(`SELECT last_number FROM shop_order_counters WHERE shop_id = ?`)
    .get(shopId);
  return formatShopOrderNumber(Number(row?.last_number || 0) + 1);
}

export function allocateOrderNumber(shopId) {
  const db = getDb();
  return db.transaction(() => nextShopOrderNumber(db, shopId))();
}

function normalizeSubmissionId(value) {
  if (value == null || String(value).trim() === "") {
    throw Object.assign(new Error("Each order needs its own submission id."), {
      status: 400,
      code: "SUBMISSION_REQUIRED",
    });
  }
  const id = String(value).trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw Object.assign(new Error("This order draft could not be identified."), {
      status: 400,
      code: "INVALID_SUBMISSION",
    });
  }
  return id;
}

function submissionFingerprint(input) {
  const lines = (Array.isArray(input.lines) ? input.lines : []).map((line) => ({
    itemId: line?.itemId || "",
    variantId: line?.variantId || "",
    quantity: line?.quantity ?? null,
    unitBasePriceCents: line?.unitBasePriceCents ?? null,
    basePriceOverride: Boolean(line?.basePriceOverride),
    configuredUnitBasePriceCents: line?.configuredUnitBasePriceCents ?? null,
    instructions: Array.isArray(line?.instructions) ? line.instructions : [],
    addons: (Array.isArray(line?.addons) ? line.addons : []).map((addon) => ({
      addonId: addon?.addonId || "",
      quantity: addon?.quantity ?? 1,
      unitPriceCents: addon?.unitPriceCents ?? null,
    })),
  }));
  const body = {
    orderType: input.orderType || "",
    orderTypeId: input.orderTypeId || "",
    destination: input.destination || "",
    fulfillment: input.fulfillment && typeof input.fulfillment === "object" ? input.fulfillment : {},
    lines,
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function submissionConflict() {
  return Object.assign(
    new Error(
      "This order was already submitted with different details. Start a new order and send it again."
    ),
    { status: 409, code: "SUBMISSION_CONFLICT" }
  );
}

function historicalNumberUsed() {
  return Object.assign(
    new Error("This order number was already used. Start a new order."),
    { status: 409, code: "ORDER_NUMBER_USED" }
  );
}

function orderByNumber(db, tenantId, orderNumber) {
  return db
    .prepare(`SELECT * FROM orders WHERE tenant_id = ? AND order_number = ?`)
    .get(tenantId, orderNumber);
}

function orderBySubmission(db, tenantId, submissionId) {
  if (!submissionId) return null;
  return db
    .prepare(`SELECT * FROM orders WHERE tenant_id = ? AND submission_id = ?`)
    .get(tenantId, submissionId);
}

function assertIntegerQuantity(qty, itemName) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error(`Invalid quantity for ${itemName}`), {
      status: 400,
    });
  }
  // Allow whole-number quantities only for priced lines (exact minor-unit math).
  if (!Number.isInteger(n)) {
    throw Object.assign(
      new Error(`Quantity must be a whole number for ${itemName}`),
      { status: 400 }
    );
  }
  return n;
}

/**
 * Create a local test order and enqueue kitchen + cashier print jobs.
 * Never touches production invoices, inventory, or accounting.
 *
 * A submission id is required for every new sale. Retrying that same attempt
 * returns the accepted order. The display order number is not an idempotency key.
 * Orders saved before submission ids remain readable and are not rewritten.
 *
 * Prices: server resolves configured base + add-ons.
 * Client base is accepted only with explicit basePriceOverride + canAdjustBasePrices(role).
 */
export function createTestOrder(
  input,
  config,
  actor = {}
) {
  const {
    role = "device",
    deviceId = "",
    userId = "",
    permissions = null,
    terminalId = "",
    terminalName = "",
  } = actor;
  let orderNumber = String(input.orderNumber || "").trim();
  const { lines = [] } = input;
  let ticketRevision = Number(input.ticketRevision) || 1;
  const submissionId = normalizeSubmissionId(input.submissionId);
  const fingerprint = submissionId ? submissionFingerprint(input) : "";

  if (!Array.isArray(lines) || lines.length === 0) {
    throw Object.assign(new Error("lines required"), { status: 400 });
  }

  const db = getDb();
  const tenantId = config.testTenantId;

  try {
    const result = db.transaction(() => {
      const bySubmission = orderBySubmission(db, tenantId, submissionId);
      if (bySubmission) {
        if (bySubmission.submission_fingerprint === fingerprint) {
          const existing = existingOrderResult(db, bySubmission);
          if (String(input.orderId || "") === bySubmission.order_id) existing.edited = true;
          return existing;
        }
        throw submissionConflict();
      }

      const replaceId = String(input.orderId || "").trim();
      let replacing = null;
      let shiftIdentity = null;
      if (replaceId) {
        replacing = db
          .prepare(`SELECT * FROM orders WHERE order_id = ? AND tenant_id = ?`)
          .get(replaceId, tenantId);
        if (!replacing) {
          throw Object.assign(new Error("Order not found"), {
            status: 404,
            code: "ORDER_NOT_FOUND",
          });
        }
        assertOrderShiftOpenForEdit(db, tenantId, replacing);
        if (replacing.status !== "OPEN") {
          throw Object.assign(new Error("Only open orders can be edited."), {
            status: 400,
            code: "ORDER_NOT_EDITABLE",
          });
        }
        const settled = db
          .prepare(`SELECT 1 AS ok FROM order_settlements WHERE shop_id = ? AND order_id = ?
            UNION ALL SELECT 1 AS ok FROM order_payment_allocations WHERE shop_id = ? AND order_id = ? LIMIT 1`)
          .get(tenantId, replaceId, tenantId, replaceId);
        if (settled) {
          throw Object.assign(new Error("This order is paid and cannot be edited."), {
            status: 409,
            code: "ORDER_ALREADY_PAID",
          });
        }
        orderNumber = replacing.order_number;
      } else {
        const taken = orderNumber ? orderByNumber(db, tenantId, orderNumber) : null;
        const preview = isShopSequencePreview(orderNumber);
        if (!orderNumber || preview || taken) {
          if (taken && !taken.submission_id && !preview) throw historicalNumberUsed();
          orderNumber = nextShopOrderNumber(db, tenantId);
        }
        // Token belongs to the active business shift; invoice/order_number stays shop-wide.
        shiftIdentity = allocateTokenInOrderTransaction(db, tenantId, userId);
      }

      const fulfillment = resolveSaleFulfillment(tenantId, input);
      const staffScoped = Array.isArray(permissions);
      const allowBase = staffScoped
        ? permissions.includes("sales.price_override")
        : canAdjustBasePrices(role);
      const allowAddon = staffScoped
        ? permissions.includes("sales.addon_price_override")
        : canAdjustAddonPrices(role);
      const allowDelivery = staffScoped
        ? permissions.includes("sales.delivery_fee.edit")
        : true;
      if (fulfillment.behavior === "DELIVERY" && fulfillment.deliveryFeeOverride && !allowDelivery) {
        throw Object.assign(
          new Error("You do not have permission to edit this order’s delivery charge."),
          { status: 403 }
        );
      }
      const orderId = replacing ? replacing.order_id : newId("ord");
      const ts = nowIso();
      const unmapped = [];
      let orderTotal = 0;
      let orderTaxable = 0;
      let orderNontaxable = 0;
      const previousLines = replacing ? snapshotTicketLines(db, orderId) : [];
      const previousLineKeys = new Set(
        previousLines.map((row) => `${row.itemId}::${row.variantId || ""}`)
      );

      if (replacing) {
        db.prepare(
          `DELETE FROM order_line_instructions
           WHERE line_id IN (SELECT line_id FROM order_lines WHERE order_id = ?)`
        ).run(orderId);
        db.prepare(
          `DELETE FROM order_line_addons
           WHERE line_id IN (SELECT line_id FROM order_lines WHERE order_id = ?)`
        ).run(orderId);
        db.prepare(`DELETE FROM order_lines WHERE order_id = ?`).run(orderId);
      } else {
        db.prepare(
          `INSERT INTO orders (
            order_id, tenant_id, order_number, order_type, destination,
            status, is_test, total_cents, created_at, updated_at,
            submission_id, submission_fingerprint, business_shift_id, business_date, token_number
          ) VALUES (?, ?, ?, ?, ?, 'OPEN', 1, 0, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          orderId,
          tenantId,
          orderNumber,
          fulfillment.code,
          fulfillment.destination,
          ts,
          ts,
          submissionId || null,
          fingerprint || null,
          shiftIdentity.shiftId,
          shiftIdentity.businessDate,
          shiftIdentity.tokenNumber
        );
      }

      lines.forEach((line, index) => {
        const item = db
          .prepare(`SELECT * FROM menu_items WHERE item_id = ?`)
          .get(line.itemId);
        if (!item) {
          throw Object.assign(new Error(`Unknown itemId: ${line.itemId}`), {
            status: 400,
          });
        }
        const variantId = line.variantId || line.variant_id || null;
        const keepExistingLine = previousLineKeys.has(
          `${line.itemId}::${variantId || ""}`
        );
        if (!item.is_active && !keepExistingLine) {
          throw Object.assign(
            new Error(`Item is inactive and cannot be ordered: ${item.name}`),
            { status: 400 }
          );
        }
        if (item.is_sold_out && !keepExistingLine) {
          throw Object.assign(
            new Error(`Item is sold out: ${item.name}`),
            { status: 400 }
          );
        }

        const quantity = assertIntegerQuantity(line.quantity, item.name);

        let stationId = line.stationId || null;
        if (!stationId) {
          const mapped = getStationsForItem(line.itemId);
          if (mapped.length === 1) {
            stationId = mapped[0];
          } else if (mapped.length === 0) {
            stationId = null;
          } else {
            unmapped.push({
              itemId: line.itemId,
              name: item.name,
              reason: `Ambiguous station mappings: ${mapped.join(",")}`,
            });
            stationId = null;
          }
        }

        const instructions = dedupeInstructions(line.instructions || []);
        validateOrderInstructions(line.itemId, instructions);

        const resolvedAddons = resolveOrderAddons(
          line.itemId,
          line.addons || line.addonSelections || [],
          { role, allowAdjust: allowAddon }
        );
        const resolved = resolveVariantForOrder(item, variantId, {
          allowUnavailable: keepExistingLine,
        });
        const configuredUnitBase = resolved.unitBaseCents;

        const clientBaseRaw =
          line.unitBasePriceCents ??
          line.unit_base_price_cents ??
          line.priceCents ??
          line.price_cents;
        const explicitOverride =
          line.basePriceOverride === true ||
          line.base_price_override === true ||
          line.basePriceAdjusted === true ||
          line.base_price_adjusted === true;

        let unitBase = configuredUnitBase;
        let basePriceAdjusted = false;

        if (explicitOverride) {
          if (!allowBase) {
            throw Object.assign(
              new Error(
                "Administrator permission required to override the item selling price."
              ),
              { status: 403, code: "BASE_PRICE_OVERRIDE_FORBIDDEN" }
            );
          }
          if (clientBaseRaw == null || clientBaseRaw === "") {
            throw Object.assign(
              new Error(
                `Override price required for ${resolved.displayName}.`
              ),
              { status: 400, code: "BASE_PRICE_OVERRIDE_INVALID" }
            );
          }
          const overrideMinor = Number(clientBaseRaw);
          if (
            !Number.isFinite(overrideMinor) ||
            !Number.isInteger(overrideMinor) ||
            overrideMinor < 0
          ) {
            throw Object.assign(
              new Error(
                `Override price must be a non-negative whole minor amount for ${resolved.displayName}.`
              ),
              { status: 400, code: "BASE_PRICE_OVERRIDE_INVALID" }
            );
          }
          unitBase = overrideMinor;
          basePriceAdjusted = unitBase !== configuredUnitBase;
        } else if (
          clientBaseRaw != null &&
          clientBaseRaw !== "" &&
          Number(clientBaseRaw) !== configuredUnitBase
        ) {
          // Ordinary stale-cart mismatch — do not treat as an override.
          throw Object.assign(
            new Error(
              `Price changed for ${resolved.displayName}. Refresh the cart and review before sending.`
            ),
            { status: 409, code: "PRICE_CHANGED" }
          );
        }

        const unitAddons = sumAddonMinor(resolvedAddons);
        const unitTotal = unitBase + unitAddons;
        const lineTotal = unitTotal * quantity;
        if (unitTotal < 0 || lineTotal < 0) {
          throw Object.assign(
            new Error(
              `Line total cannot be negative for ${item.name} (unit ${unitTotal}, line ${lineTotal})`
            ),
            { status: 400 }
          );
        }
        const itemTaxApplicable =
          item.tax_applicable == null
            ? true
            : Boolean(Number(item.tax_applicable));
        const buckets = splitUnitTaxBuckets(
          unitBase,
          itemTaxApplicable,
          resolvedAddons
        );
        const lineTaxable = buckets.taxableUnitCents * quantity;
        const lineNontaxable = buckets.nontaxableUnitCents * quantity;
        if (lineTaxable < 0 || lineNontaxable < 0) {
          throw Object.assign(
            new Error(
              `Tax buckets cannot be negative for ${item.name} (taxable ${lineTaxable}, non-taxable ${lineNontaxable})`
            ),
            { status: 400 }
          );
        }
        orderTotal += lineTotal;
        orderTaxable += lineTaxable;
        orderNontaxable += lineNontaxable;

        const lineId = newId("line");
        db.prepare(
          `INSERT INTO order_lines (
            line_id, order_id, item_id, item_name, quantity, station_id, line_index,
            unit_base_price_cents, unit_addons_cents, unit_total_cents, line_total_cents,
            tax_applicable, taxable_cents, nontaxable_cents,
            variant_id, variant_name, variant_price_cents,
            configured_unit_base_price_cents, base_price_adjusted, base_price_adjusted_by_role
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          lineId,
          orderId,
          line.itemId,
          item.name,
          quantity,
          stationId,
          index,
          unitBase,
          unitAddons,
          unitTotal,
          lineTotal,
          itemTaxApplicable ? 1 : 0,
          lineTaxable,
          lineNontaxable,
          resolved.variant?.variantId || null,
          resolved.variant?.name || "",
          resolved.variant ? configuredUnitBase : null,
          configuredUnitBase,
          basePriceAdjusted ? 1 : 0,
          basePriceAdjusted ? role : ""
        );

        if (basePriceAdjusted) {
          recordAudit({
            actorRole: role,
            actorUserId: userId || "",
            action: "order.line.base_price_adjust",
            entityType: "order_line",
            entityId: lineId,
            detail: {
              orderId,
              lineId,
              itemId: line.itemId,
              itemName: item.name,
              variantId: resolved.variant?.variantId || null,
              variantName: resolved.variant?.name || "",
              configuredUnitBasePriceCents: configuredUnitBase,
              appliedUnitBasePriceCents: unitBase,
              priceDeltaCents: unitBase - configuredUnitBase,
              quantity,
              permission: "sales.price_override",
              authorization: staffScoped ? "sales.price_override" : "role:admin",
              staffUserId: userId || "",
              deviceId: deviceId || undefined,
            },
          });
        }

        instructions.forEach((label, i) => {
          db.prepare(
            `INSERT INTO order_line_instructions (instruction_id, line_id, label, sort_index)
             VALUES (?, ?, ?, ?)`
          ).run(newId("ins"), lineId, label, i);
        });

        resolvedAddons.forEach((addon, i) => {
          db.prepare(
            `INSERT INTO order_line_addons (
               line_addon_id, line_id, addon_id, addon_name, quantity,
               configured_unit_price_cents, unit_price_cents, line_price_cents,
               price_adjusted, adjusted_by_role, sort_index, tax_applicable
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            newId("ola"),
            lineId,
            addon.addonId,
            addon.name,
            addon.quantity,
            addon.configuredUnitPriceCents,
            addon.unitPriceCents,
            addon.linePriceCents,
            addon.priceAdjusted ? 1 : 0,
            addon.priceAdjusted ? role : "",
            i,
            addon.taxApplicable !== false ? 1 : 0
          );
          if (addon.priceEnteredAtSale) {
            recordAudit({
              actorRole: role,
              actorUserId: userId || "",
              action: "order.addon.price_entered",
              entityType: "order_line_addon",
              entityId: orderId,
              detail: {
                orderId,
                lineId,
                itemId: line.itemId,
                addonId: addon.addonId,
                addonName: addon.name,
                catalogPriceCents: null,
                appliedUnitPriceCents: addon.unitPriceCents,
                deviceId: deviceId || undefined,
              },
            });
          } else if (addon.priceAdjusted) {
            recordAudit({
              actorRole: role,
              actorUserId: userId || "",
              action: "order.addon.price_adjust",
              entityType: "order_line_addon",
              entityId: orderId,
              detail: {
                orderId,
                lineId,
                itemId: line.itemId,
                addonId: addon.addonId,
                addonName: addon.name,
                configuredUnitPriceCents: addon.configuredUnitPriceCents,
                appliedUnitPriceCents: addon.unitPriceCents,
                priceDeltaCents: addon.priceDeltaCents,
                deviceId: deviceId || undefined,
              },
            });
          }
        });
      });

      if (orderTotal < 0) {
        throw Object.assign(new Error("Order total cannot be negative"), {
          status: 400,
        });
      }

      // Tax uses taxable / non-taxable buckets from item + add-on flags.
      // Client-submitted tax/totals are ignored.
      const shop = getShopSettings(tenantId);
      const taxResult = computeOrderTaxFromBuckets(
        {
          taxableCents: orderTaxable,
          nontaxableCents: orderNontaxable,
        },
        {
          taxEnabled: shop.taxEnabled,
          taxMode: shop.taxMode,
          taxRateBps: shop.taxRateBps,
          taxName: shop.taxName,
        }
      );
      if (taxResult.goodsCents !== orderTotal) {
        throw Object.assign(
          new Error(
            `Goods reconciliation failed (${taxResult.goodsCents} vs ${orderTotal})`
          ),
          { status: 500 }
        );
      }
      if (taxResult.totalCents < 0) {
        throw Object.assign(new Error("Order total cannot be negative"), {
          status: 400,
        });
      }

      // Item tax stays on goods. A block charge marked taxable uses the shop rate:
      // inclusive tax is already inside the charge; exclusive tax is added on top.
      const feeTax = computeDeliveryFeeTax(
        fulfillment.deliveryChargeCents,
        fulfillment.deliveryFeeTaxApplicable,
        {
          taxEnabled: shop.taxEnabled,
          taxMode: shop.taxMode,
          taxRateBps: shop.taxRateBps,
          taxName: shop.taxName,
        }
      );
      const customerTotal =
        taxResult.totalCents + fulfillment.deliveryChargeCents + feeTax.addedCents;
      const storedTaxCents = taxResult.taxCents + feeTax.taxCents;
      if (customerTotal < 0) {
        throw Object.assign(new Error("Order total cannot be negative"), {
          status: 400,
        });
      }
      if (input.customerTotalCents != null || input.totalCents != null) {
        const claimed = Number(
          input.customerTotalCents != null ? input.customerTotalCents : input.totalCents
        );
        if (!Number.isSafeInteger(claimed) || claimed !== customerTotal) {
          throw Object.assign(
            new Error("Order total does not match the server calculation."),
            { status: 400 }
          );
        }
      }

      db.prepare(
        `UPDATE orders SET
           total_cents = ?,
           goods_cents = ?,
           taxable_goods_cents = ?,
           nontaxable_goods_cents = ?,
           net_cents = ?,
           tax_cents = ?,
           tax_enabled = ?,
           tax_mode = ?,
           tax_rate_bps = ?,
           tax_name = ?,
           tax_registration_number = ?,
           currency_code = ?,
           currency_label = ?,
           currency_decimals = ?,
           shop_display_name = ?,
           shop_legal_name = ?,
           order_type_id = ?,
           order_type_name = ?,
           fulfillment_behavior = ?,
           customer_name = ?,
           customer_phone = ?,
           building_number = ?,
           road_number = ?,
           block_number = ?,
           address_note = ?,
           address_label = ?,
           table_number = ?,
           vehicle_number = ?,
           parking_location = ?,
           configured_delivery_cents = ?,
           delivery_charge_cents = ?,
           delivery_fee_override = ?,
           delivery_fee_tax_treatment = ?,
           customer_id = ?,
           customer_address_id = ?,
           delivery_rate_source = ?,
           created_by_role = ?,
           created_by_device_id = ?,
           created_by_user_id = ?,
           created_by_terminal_id = ?,
           created_by_terminal_name = ?,
           order_type = ?,
           destination = ?,
           submission_id = ?,
           submission_fingerprint = ?,
           updated_at = ?
         WHERE order_id = ?`
      ).run(
        customerTotal,
        taxResult.goodsCents,
        taxResult.taxableGoodsCents,
        taxResult.nontaxableGoodsCents,
        taxResult.netCents,
        storedTaxCents,
        taxResult.taxEnabled ? 1 : 0,
        taxResult.taxMode,
        taxResult.taxRateBps,
        taxResult.taxName,
        shop.taxRegistrationNumber || "",
        shop.currencyCode,
        shop.currencyLabel,
        shop.currencyDecimals,
        shop.displayName,
        shop.legalName || "",
        fulfillment.orderTypeId,
        fulfillment.name,
        fulfillment.behavior,
        fulfillment.customerName,
        fulfillment.customerPhone,
        fulfillment.buildingNumber,
        fulfillment.roadNumber,
        fulfillment.blockNumber,
        fulfillment.addressNote,
        fulfillment.addressLabel || "",
        fulfillment.tableNumber,
        fulfillment.vehicleNumber,
        fulfillment.parkingLocation,
        fulfillment.configuredChargeCents,
        fulfillment.deliveryChargeCents,
        fulfillment.deliveryFeeOverride ? 1 : 0,
        feeTax.treatment,
        fulfillment.customerId || null,
        fulfillment.addressId || null,
        fulfillment.deliveryRateSource || "",
        role,
        deviceId || "",
        userId || null,
        terminalId || null,
        terminalName || "",
        fulfillment.code,
        fulfillment.destination,
        submissionId || null,
        fingerprint || null,
        ts,
        orderId
      );

      if (fulfillment.behavior === "DELIVERY" && fulfillment.deliveryFeeOverride) {
        const configured = fulfillment.configuredChargeCents;
        recordAudit({
          actorRole: role,
          actorUserId: userId || "",
          action: "order.delivery_fee.override",
          entityType: "order",
          entityId: orderId,
          detail: {
            orderId,
            orderNumber,
            blockNumber: fulfillment.blockNumber,
            configuredChargeCents: configured,
            appliedChargeCents: fulfillment.deliveryChargeCents,
            differenceCents:
              configured == null ? null : fulfillment.deliveryChargeCents - configured,
            rateSource: fulfillment.deliveryRateSource || "",
            staffUserId: userId || "",
            deviceId: deviceId || "",
          },
        });
      }

      if (unmapped.length > 0) {
        logUnmapped(db, orderId, unmapped);
      }

      if (replacing) {
        const row = db
          .prepare(
            `SELECT COALESCE(MAX(ticket_revision), 0) AS n FROM print_jobs WHERE order_id = ?`
          )
          .get(orderId);
        ticketRevision = Number(row?.n || 0) + 1;
      }
      const printKitchen = input.printKitchen !== false;
      const printCashier = input.printCashier !== false;
      const jobs =
        printKitchen || printCashier
          ? enqueuePrintJobsForOrder(orderId, ticketRevision, config, {
              unmapped,
              orderEdited: Boolean(replacing),
              fulfillmentChanged: fulfillmentChangedForEdit(replacing, fulfillment),
              previousLines,
              includeKitchen: printKitchen,
              includeCashier: printCashier,
            })
          : [];
      const order = db
        .prepare(`SELECT * FROM orders WHERE order_id = ?`)
        .get(orderId);
      return { order, jobs, created: !replacing, edited: Boolean(replacing), unmapped };
    })();

    return result;
  } catch (err) {
    if (
      err?.code === "SUBMISSION_CONFLICT" ||
      err?.code === "ORDER_NUMBER_USED" ||
      err?.code === "ORDER_ALREADY_PAID" ||
      err?.code === "ORDER_NOT_FOUND" ||
      err?.code === "ORDER_NOT_EDITABLE" ||
      input.orderId
    ) {
      throw err;
    }
    if (
      String(err?.code || "").includes("CONSTRAINT") ||
      /UNIQUE/i.test(String(err?.message || ""))
    ) {
      const bySubmission = orderBySubmission(db, tenantId, submissionId);
      if (bySubmission) {
        if (bySubmission.submission_fingerprint === fingerprint) {
          return existingOrderResult(db, bySubmission);
        }
        throw submissionConflict();
      }
      const taken = orderByNumber(db, tenantId, orderNumber);
      if (taken && !taken.submission_id) throw historicalNumberUsed();
      if ((input._numberAttempt || 0) < 3) {
        return createTestOrder(
          {
            ...input,
            orderNumber: allocateOrderNumber(tenantId),
            _numberAttempt: (input._numberAttempt || 0) + 1,
          },
          config,
          actor
        );
      }
    }
    throw err;
  }
}

function snapshotTicketLines(db, orderId) {
  const lines = db
    .prepare(`SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index`)
    .all(orderId);
  const instr = db.prepare(
    `SELECT label FROM order_line_instructions WHERE line_id = ? ORDER BY sort_index`
  );
  const addons = db.prepare(
    `SELECT addon_name, quantity FROM order_line_addons WHERE line_id = ? ORDER BY sort_index`
  );
  return lines.map((line) => ({
    stationId: line.station_id || "",
    itemId: line.item_id,
    variantId: line.variant_id || "",
    name: line.item_name,
    quantity: Number(line.quantity || 0),
    variantName: line.variant_name || "",
    instructions: instr.all(line.line_id).map((row) => row.label),
    addons: addons.all(line.line_id).map((row) => ({
      name: row.addon_name,
      quantity: Number(row.quantity || 1),
    })),
  }));
}

function fulfillmentChangedForEdit(previous, fulfillment) {
  if (!previous) return false;
  const same = (left, right) => String(left || "") === String(right || "");
  return !(
    same(previous.order_type, fulfillment.code) &&
    same(previous.destination, fulfillment.destination) &&
    same(previous.customer_name, fulfillment.customerName) &&
    same(previous.customer_phone, fulfillment.customerPhone) &&
    same(previous.block_number, fulfillment.blockNumber) &&
    same(previous.building_number, fulfillment.buildingNumber) &&
    same(previous.road_number, fulfillment.roadNumber) &&
    same(previous.address_note, fulfillment.addressNote) &&
    same(previous.table_number, fulfillment.tableNumber) &&
    same(previous.vehicle_number, fulfillment.vehicleNumber) &&
    same(previous.parking_location, fulfillment.parkingLocation)
  );
}

function logUnmapped(db, orderId, unmapped) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(
    `unmapped:${orderId}`,
    JSON.stringify({ orderId, unmapped, at: nowIso() })
  );
}

function loadLineAddons(db, lineId) {
  return db
    .prepare(
      `SELECT * FROM order_line_addons WHERE line_id = ? ORDER BY sort_index`
    )
    .all(lineId)
    .map((r) => ({
      addonId: r.addon_id,
      name: r.addon_name,
      quantity: Number(r.quantity),
      configuredUnitPriceCents: Number(
        r.configured_unit_price_cents ?? r.unit_price_cents ?? 0
      ),
      unitPriceCents: Number(r.unit_price_cents),
      linePriceCents: Number(r.line_price_cents),
      priceAdjusted: Boolean(r.price_adjusted),
      adjustedByRole: r.adjusted_by_role || "",
      taxApplicable:
        r.tax_applicable == null ? true : Boolean(Number(r.tax_applicable)),
    }));
}

export function getOrder(orderId) {
  const db = getDb();
  const order = db.prepare(`SELECT * FROM orders WHERE order_id = ?`).get(orderId);
  if (!order) return null;
  const lines = db
    .prepare(`SELECT * FROM order_lines WHERE order_id = ? ORDER BY line_index`)
    .all(orderId);
  const instr = db.prepare(
    `SELECT * FROM order_line_instructions WHERE line_id = ? ORDER BY sort_index`
  );
  return {
    ...order,
    total_cents: Number(order.total_cents || 0),
    goods_cents: Number(order.goods_cents ?? order.total_cents ?? 0),
    taxable_goods_cents: Number(
      order.taxable_goods_cents ?? order.goods_cents ?? order.total_cents ?? 0
    ),
    nontaxable_goods_cents: Number(order.nontaxable_goods_cents || 0),
    net_cents: Number(order.net_cents ?? order.total_cents ?? 0),
    tax_cents: Number(order.tax_cents || 0),
    tax_enabled: Boolean(order.tax_enabled),
    tax_mode: order.tax_mode || "",
    tax_rate_bps: Number(order.tax_rate_bps || 0),
    tax_name: order.tax_name || "",
    tax_registration_number: order.tax_registration_number || "",
    currency_code: order.currency_code || "",
    currency_label: order.currency_label || "",
    currency_decimals: Number(
      order.currency_decimals != null ? order.currency_decimals : 2
    ),
    shop_display_name: order.shop_display_name || "",
    shop_legal_name: order.shop_legal_name || "",
    lines: lines.map((l) => ({
      ...l,
      unit_base_price_cents: Number(l.unit_base_price_cents || 0),
      unit_addons_cents: Number(l.unit_addons_cents || 0),
      unit_total_cents: Number(l.unit_total_cents || 0),
      line_total_cents: Number(l.line_total_cents || 0),
      tax_applicable:
        l.tax_applicable == null ? true : Boolean(Number(l.tax_applicable)),
      taxable_cents: Number(l.taxable_cents || 0),
      nontaxable_cents: Number(l.nontaxable_cents || 0),
      variant_id: l.variant_id || null,
      variant_name: l.variant_name || "",
      variant_price_cents:
        l.variant_price_cents == null
          ? null
          : Number(l.variant_price_cents),
      instructions: instr.all(l.line_id).map((i) => i.label),
      addons: loadLineAddons(db, l.line_id),
    })),
  };
}

export function loadOrderBundle(orderId) {
  return getOrder(orderId);
}

export function loadOrderForEdit(shopId, orderId) {
  const order = getOrder(orderId);
  if (!order || order.tenant_id !== shopId) {
    throw Object.assign(new Error("Order not found"), {
      status: 404,
      code: "ORDER_NOT_FOUND",
    });
  }
  if (order.status !== "OPEN") {
    throw Object.assign(new Error("Only open orders can be edited."), {
      status: 400,
      code: "ORDER_NOT_EDITABLE",
    });
  }
  const settled = getDb()
    .prepare(`SELECT 1 AS ok FROM order_settlements WHERE shop_id = ? AND order_id = ?
      UNION ALL SELECT 1 AS ok FROM order_payment_allocations WHERE shop_id = ? AND order_id = ? LIMIT 1`)
    .get(shopId, orderId, shopId, orderId);
  if (settled) {
    throw Object.assign(new Error("This order is paid and cannot be edited."), {
      status: 409,
      code: "ORDER_ALREADY_PAID",
    });
  }
  return {
    orderId: order.order_id,
    orderNumber: order.order_number,
    orderTypeId: order.order_type_id || "",
    orderTypeCode: order.order_type || "",
    fulfillment: {
      customerId: order.customer_id || "",
      addressId: order.customer_address_id || "",
      addressLabel: order.address_label || "",
      customerName: order.customer_name || "",
      customerPhone: order.customer_phone || "",
      buildingNumber: order.building_number || "",
      roadNumber: order.road_number || "",
      blockNumber: order.block_number || "",
      addressNote: order.address_note || "",
      tableNumber: order.table_number || "",
      vehicleNumber: order.vehicle_number || "",
      parkingLocation: order.parking_location || "",
      counterLabel: order.fulfillment_behavior === "COUNTER" ? order.destination || "" : "",
      deliveryChargeCents: Number(order.delivery_charge_cents || 0),
      deliveryFeeOverride: Boolean(order.delivery_fee_override),
      expectedBlockRateCents:
        order.configured_delivery_cents == null
          ? null
          : Number(order.configured_delivery_cents),
    },
    lines: (order.lines || []).map((line) => ({
      itemId: line.item_id,
      name: line.item_name,
      variantId: line.variant_id || null,
      variantName: line.variant_name || "",
      quantity: Number(line.quantity || 1),
      priceCents: Number(line.unit_base_price_cents || 0),
      configuredPriceCents: Number(
        line.configured_unit_base_price_cents ?? line.unit_base_price_cents ?? 0
      ),
      basePriceAdjusted: Boolean(line.base_price_adjusted),
      taxApplicable: line.tax_applicable !== false,
      instructions: line.instructions || [],
      addons: (line.addons || []).map((addon) => ({
        addonId: addon.addonId,
        name: addon.name,
        quantity: Number(addon.quantity || 1),
        unitPriceCents: Number(addon.unitPriceCents || 0),
        configuredUnitPriceCents: Number(
          addon.configuredUnitPriceCents ?? addon.unitPriceCents ?? 0
        ),
        priceAdjusted: Boolean(addon.priceAdjusted),
      })),
    })),
  };
}

export function countOrders(tenantId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN is_test = 1 THEN 1 ELSE 0 END) AS test_count
       FROM orders WHERE tenant_id = ?`
    )
    .get(tenantId);
  return {
    total: Number(row?.total || 0),
    testCount: Number(row?.test_count || 0),
  };
}

/**
 * Admin-only: permanently delete local test orders (is_test=1) for this shop.
 * Cascades to order lines, instructions, add-ons, print jobs, and job events.
 * Does not touch menu, printers, or shop settings.
 * Refuses the wipe when any test order already has a cash settlement.
 */
export function clearTestOrders(tenantId, { role = "device", confirm = false } = {}) {
  if (role !== "admin") {
    throw Object.assign(new Error("Admin role required"), { status: 403 });
  }
  if (!confirm) {
    throw Object.assign(
      new Error("confirm=true is required to clear test orders"),
      { status: 400 }
    );
  }
  const db = getDb();
  const before = countOrders(tenantId);
  const tx = db.transaction(() => {
    // Clean optional meta keys tied to orders
    const settled = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM order_settlements s
         JOIN orders o ON o.order_id = s.order_id
         WHERE o.tenant_id = ? AND o.is_test = 1`
      )
      .get(tenantId);
    const splitCount = db.prepare(`SELECT COUNT(*) AS n FROM order_payment_allocations a
      JOIN orders o ON o.order_id=a.order_id
      WHERE o.tenant_id=? AND o.is_test=1`).get(tenantId);
    if (Number(settled?.n || 0) > 0 || Number(splitCount?.n || 0) > 0) {
      throw Object.assign(new Error("Settled test orders cannot be deleted."), {
        status: 409,
        code: "SETTLED_TEST_ORDERS",
      });
    }
    const orderIds = db
      .prepare(
        `SELECT order_id FROM orders WHERE tenant_id = ? AND is_test = 1`
      )
      .all(tenantId)
      .map((r) => r.order_id);
    const delMeta = db.prepare(`DELETE FROM meta WHERE key = ?`);
    for (const id of orderIds) {
      delMeta.run(`unmapped:${id}`);
    }
    const result = db
      .prepare(`DELETE FROM orders WHERE tenant_id = ? AND is_test = 1`)
      .run(tenantId);
    return result.changes;
  });
  const deleted = tx();
  const after = countOrders(tenantId);
  return {
    deleted,
    remainingOrders: after.total,
    remainingTestOrders: after.testCount,
    before,
  };
}
