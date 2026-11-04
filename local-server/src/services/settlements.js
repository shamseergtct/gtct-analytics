/**
 * Full cash or bank settlement for one open shop order.
 * The order total, tax snapshot, and fulfillment status are not changed.
 * A settlement does not create kitchen or cashier tickets.
 */
import { createHash } from "node:crypto";
import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { recordAudit } from "./audit.js";
import { readAllocationSummary } from "./paymentAllocations.js";

export function toPublicSettlementError(err) {
  const code = String(err?.code || "");
  const message = String(err?.message || "");
  const busy = code.includes("SQLITE_BUSY") || /database is locked/i.test(message);
  const sqlite = code.startsWith("SQLITE_") || /SQLITE|constraint failed/i.test(message);
  if (!busy && !sqlite) return err;
  const publicCode = busy ? "PAYMENT_IN_PROGRESS" : "PAYMENT_CONFLICT";
  const publicMessage = busy
    ? "This payment is already being recorded. Check the order before trying again."
    : "This payment could not be recorded. Check the order before trying again.";
  return fail(409, publicMessage, publicCode);
}

function fail(status, message, code, auditRejection) {
  return Object.assign(new Error(message), { status, code, auditRejection });
}

function normalizeSubmissionId(value) {
  if (value == null || String(value).trim() === "") {
    throw fail(400, "Each payment needs its own submission id.", "SUBMISSION_REQUIRED");
  }
  const id = String(value).trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    throw fail(400, "This payment could not be identified.", "INVALID_SUBMISSION");
  }
  return id;
}

function claimedAmount(value) {
  if (value == null || value === "") return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) return Number.NaN;
  return amount;
}

function claimedCurrency(value) {
  if (value == null || String(value).trim() === "") return null;
  return String(value).trim();
}

function normalizeTender(value) {
  if (value == null || String(value).trim() === "") return "CASH";
  const tender = String(value).trim().toUpperCase();
  if (tender !== "CASH" && tender !== "BANK") {
    throw fail(400, "Only a full cash or bank payment can be recorded.", "TENDER_NOT_ALLOWED");
  }
  return tender;
}

function fingerprintOf(input, tender) {
  const body = {
    orderId: String(input.orderId || "").trim(),
    tender,
    amountCents: claimedAmount(input.amountCents),
    currencyCode: claimedCurrency(input.currencyCode),
  };
  if (tender === "BANK") body.bankAccountId = String(input.bankAccountId || "").trim();
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function bankDisplay(db, accountId) {
  if (!accountId) return { bankAccountId: null, bankAccountLabel: "" };
  const account = db
    .prepare(
      `SELECT display_name, bank_name, masked_reference
       FROM shop_bank_accounts WHERE account_id = ?`
    )
    .get(accountId);
  if (!account) return { bankAccountId: accountId, bankAccountLabel: "" };
  const mask = account.masked_reference ? ` ${account.masked_reference}` : "";
  return {
    bankAccountId: accountId,
    bankAccountLabel: `${account.display_name} · ${account.bank_name}${mask}`,
  };
}

function settlementView(row, balance) {
  const bank = bankDisplay(getDb(), row.bank_account_id);
  return {
    created: false,
    paymentStatus: balance.payment_status,
    settlement: {
      settlementId: row.settlement_id,
      shopId: row.shop_id,
      orderId: row.order_id,
      submissionId: row.submission_id,
      tender: row.tender,
      currencyCode: row.currency_code,
      amountCents: Number(row.amount_cents),
      balanceBeforeCents: Number(row.balance_before_cents),
      balanceAfterCents: Number(row.balance_after_cents),
      createdByUserId: row.created_by_user_id,
      createdAt: row.created_at,
      bankAccountId: bank.bankAccountId,
      bankAccountLabel: bank.bankAccountLabel,
    },
    balance: {
      orderTotalCents: Number(balance.order_total_cents),
      paidCents: Number(balance.paid_cents),
      balanceCents: Number(balance.balance_cents),
      paymentStatus: balance.payment_status,
    },
  };
}

function loadSettlement(db, shopId, submissionId) {
  return db
    .prepare(
      `SELECT * FROM order_settlements WHERE shop_id = ? AND submission_id = ?`
    )
    .get(shopId, submissionId);
}

function loadBalance(db, shopId, orderId) {
  return db
    .prepare(`SELECT * FROM order_payment_balances WHERE shop_id = ? AND order_id = ?`)
    .get(shopId, orderId);
}

function resultFor(db, shopId, row) {
  const balance = loadBalance(db, shopId, row.order_id);
  return { ...settlementView(row, balance), created: false };
}

function rejectionAudit(actor, shopId, orderId, code, tender = "CASH") {
  return {
    actorRole: actor.role || "",
    actorUserId: actor.userId || "",
    action: tender === "BANK" ? "payment.bank.reject" : "payment.cash.reject",
    entityType: "order",
    entityId: orderId || "",
    detail: { code, shopId, orderId: orderId || "", tender },
  };
}

function rollback(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    /* no open transaction */
  }
}

/**
 * Record one full cash payment, or return the original settlement for a retry.
 * @param {{ orderId?: string, submissionId?: string, tender?: string, amountCents?: number, currencyCode?: string, bankAccountId?: string }} input
 * @param {{ testTenantId: string }} config
 * @param {{ role?: string, userId?: string }} actor
 */
export function settleCashPayment(input, config, actor = {}) {
  const shopId = config.testTenantId;
  const orderId = String(input?.orderId || "").trim();
  const userId = String(actor.userId || "").trim();
  let tender = "CASH";
  try {
    tender = normalizeTender(input?.tender);
  } catch (err) {
    err.auditRejection = rejectionAudit(actor, shopId, orderId, "TENDER_NOT_ALLOWED");
    throw audited(err);
  }
  const reject = (code, id = orderId) => rejectionAudit(actor, shopId, id, code, tender);
  if (!userId) {
    throw audited(
      fail(403, "A staff member must record this payment.", "FORBIDDEN", reject("FORBIDDEN"))
    );
  }
  if (!orderId) {
    throw audited(fail(400, "Choose an order.", "ORDER_REQUIRED", reject("ORDER_REQUIRED", "")));
  }
  if (tender === "BANK" && !String(input?.bankAccountId || "").trim()) {
    throw audited(
      fail(400, "Choose an operational bank account.", "BANK_ACCOUNT_REQUIRED", reject("BANK_ACCOUNT_REQUIRED"))
    );
  }

  let submissionId;
  try {
    submissionId = normalizeSubmissionId(input?.submissionId);
  } catch (err) {
    err.auditRejection = reject(err.code || "INVALID_SUBMISSION");
    throw audited(err);
  }
  const fingerprint = fingerprintOf({ ...input, orderId }, tender);
  const db = getDb();

  const finishExisting = (row) => {
    if (row.submission_fingerprint !== fingerprint) {
      throw fail(
        409,
        "This payment was already submitted with different details.",
        "SUBMISSION_CONFLICT",
        reject("SUBMISSION_CONFLICT")
      );
    }
    return { ...resultFor(db, shopId, row), created: false };
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = loadSettlement(db, shopId, submissionId);
    if (existing) {
      const replay = finishExisting(existing);
      db.exec("COMMIT");
      return replay;
    }

    const order = db.prepare(`SELECT * FROM orders WHERE order_id = ?`).get(orderId);
    if (!order || order.tenant_id !== shopId) {
      throw fail(
        404,
        "Order not found.",
        "ORDER_NOT_FOUND",
        reject("ORDER_NOT_FOUND")
      );
    }
    if (order.status !== "OPEN" || Number(order.is_test) !== 1) {
      throw fail(
        400,
        "This order cannot be settled.",
        "ORDER_NOT_ELIGIBLE",
        reject("ORDER_NOT_ELIGIBLE")
      );
    }

    const orderTotal = Number(order.total_cents || 0);
    const currency = String(order.currency_code || "");
    if (!currency || !Number.isSafeInteger(orderTotal) || orderTotal <= 0) {
      throw fail(
        400,
        "This order cannot be settled.",
        "ORDER_NOT_ELIGIBLE",
        reject("ORDER_NOT_ELIGIBLE")
      );
    }
    const sentCurrency = claimedCurrency(input?.currencyCode);
    if (sentCurrency && sentCurrency !== currency) {
      throw fail(
        400,
        "The payment currency does not match the order.",
        "CURRENCY_MISMATCH",
        reject("CURRENCY_MISMATCH")
      );
    }

    // Prevent a separate legacy cash/bank settlement while rider custody is open.
    // Only the atomic rider cash handover flow may resolve CASH_WITH_BOY.
    if (order.fulfillment_behavior === 'DELIVERY' &&
      db.prepare(`SELECT 1 FROM delivery_order_payment_reports
        WHERE shop_id=? AND order_id=? AND report_type='CASH_WITH_BOY'`)
        .get(shopId,orderId)) {
      throw fail(409,'Cash is reported in rider custody. Confirm handover before posting shop payment.',
        'RIDER_CASH_CUSTODY',reject('RIDER_CASH_CUSTODY'));
    }

    const split = db.prepare(`SELECT 1 FROM order_payment_allocations WHERE shop_id=? AND order_id=?`)
      .get(shopId,orderId);
    if (split) throw fail(409, 'Split payment exists. Use Orders split-payment form.',
      'SPLIT_PAYMENT_EXISTS', reject('SPLIT_PAYMENT_EXISTS'));
    const balance = loadBalance(db, shopId, orderId);
    const remaining = balance ? Number(balance.balance_cents) : orderTotal;
    if (balance?.payment_status === "PAID" || remaining <= 0) {
      throw fail(
        409,
        "This order is already paid.",
        "ALREADY_PAID",
        reject("ALREADY_PAID")
      );
    }
    if (remaining !== orderTotal) {
      throw fail(
        400,
        "This order cannot be settled.",
        "ORDER_NOT_ELIGIBLE",
        reject("ORDER_NOT_ELIGIBLE")
      );
    }

    const amount = claimedAmount(input?.amountCents);
    if (Number.isNaN(amount) || (amount != null && amount !== orderTotal)) {
      throw fail(
        400,
        tender === "BANK"
          ? "The bank amount must equal the full order balance."
          : "The cash amount must equal the full order balance.",
        "AMOUNT_MISMATCH",
        reject("AMOUNT_MISMATCH")
      );
    }

    let bankAccountId = null;
    if (tender === "BANK") {
      bankAccountId = String(input?.bankAccountId || "").trim();
      const account = db
        .prepare(`SELECT * FROM shop_bank_accounts WHERE account_id = ?`)
        .get(bankAccountId);
      if (!account || account.shop_id !== shopId) {
        throw fail(404, "Bank account not found.", "BANK_ACCOUNT_NOT_FOUND", reject("BANK_ACCOUNT_NOT_FOUND"));
      }
      if (account.account_type !== "OPERATIONAL") {
        throw fail(
          400,
          "Reserve accounts cannot receive sales payments.",
          "BANK_ACCOUNT_NOT_OPERATIONAL",
          reject("BANK_ACCOUNT_NOT_OPERATIONAL")
        );
      }
      if (Number(account.is_active) !== 1) {
        throw fail(400, "This bank account is inactive.", "BANK_ACCOUNT_INACTIVE", reject("BANK_ACCOUNT_INACTIVE"));
      }
    }

    const paidByOther = db
      .prepare(`SELECT settlement_id FROM order_settlements WHERE shop_id = ? AND order_id = ?`)
      .get(shopId, orderId);
    if (paidByOther) {
      throw fail(
        409,
        "This order is already paid.",
        "ALREADY_PAID",
        reject("ALREADY_PAID")
      );
    }

    const createdAt = nowIso();
    const settlementId = newId("set");
    db.prepare(
      `INSERT INTO order_settlements (
         settlement_id, shop_id, order_id, submission_id, submission_fingerprint,
         kind, tender, currency_code, amount_cents, balance_before_cents, balance_after_cents,
         created_by_user_id, created_at, bank_account_id
       ) VALUES (?, ?, ?, ?, ?, 'PAYMENT', ?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(
      settlementId,
      shopId,
      orderId,
      submissionId,
      fingerprint,
      tender,
      currency,
      orderTotal,
      orderTotal,
      userId,
      createdAt,
      bankAccountId
    );
    db.prepare(
      `INSERT INTO order_payment_balances (
         shop_id, order_id, currency_code, order_total_cents, paid_cents, balance_cents,
         payment_status, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, 'PAID', ?)`
    ).run(shopId, orderId, currency, orderTotal, orderTotal, createdAt);

    recordAudit({
      actorRole: actor.role || "",
      actorUserId: userId,
      action: tender === "BANK" ? "payment.bank.post" : "payment.cash.post",
      entityType: "order_settlement",
      entityId: settlementId,
      detail: {
        shopId,
        orderId,
        settlementId,
        tender,
        amountCents: orderTotal,
        currencyCode: currency,
        balanceBeforeCents: orderTotal,
        balanceAfterCents: 0,
        staffUserId: userId,
        ...(tender === "BANK" ? { bankAccountId } : {}),
      },
    });

    const storedOrder = db.prepare(`SELECT status, total_cents, tax_cents FROM orders WHERE order_id = ?`).get(orderId);
    if (storedOrder.status !== order.status || Number(storedOrder.total_cents) !== orderTotal) {
      throw fail(500, "The order total could not be kept unchanged.", "ORDER_MUTATED");
    }

    const row = loadSettlement(db, shopId, submissionId);
    const posted = loadBalance(db, shopId, orderId);
    db.exec("COMMIT");
    return { ...settlementView(row, posted), created: true };
  } catch (err) {
    rollback(db);
    if (isUnique(err)) {
      const same = loadSettlement(db, shopId, submissionId);
      if (same) {
        if (same.submission_fingerprint === fingerprint) return { ...resultFor(db, shopId, same), created: false };
        const conflict = fail(
          409,
          "This payment was already submitted with different details.",
          "SUBMISSION_CONFLICT",
          reject("SUBMISSION_CONFLICT")
        );
        recordAudit(conflict.auditRejection);
        throw conflict;
      }
      const paid = fail(
        409,
        "This order is already paid.",
        "ALREADY_PAID",
        reject("ALREADY_PAID")
      );
      recordAudit(paid.auditRejection);
      throw paid;
    }
    if (err.auditRejection) recordAudit(err.auditRejection);
    const publicError = toPublicSettlementError(err);
    if (publicError !== err) {
      publicError.auditRejection = reject(publicError.code);
      if (!err.auditRejection) recordAudit(publicError.auditRejection);
      throw publicError;
    }
    throw err;
  }
}

function paymentView(order, balance, settlement) {
  const db = getDb();
  const allocations = readAllocationSummary(db,order.tenant_id,order.order_id,order.total_cents);
  const creditOwner = db.prepare(`SELECT c.customer_id, c.name, c.phone
    FROM order_payment_allocations a
    JOIN shop_customers c ON c.customer_id=a.credit_customer_id AND c.shop_id=a.shop_id
    WHERE a.shop_id=? AND a.order_id=? AND a.credit_cents>0
    ORDER BY a.created_at,a.allocation_id LIMIT 1`).get(order.tenant_id,order.order_id);
  const orderTotal = Number(order.total_cents || 0);
  const paid = balance ? Number(balance.paid_cents) : 0;
  const due = balance ? Number(balance.balance_cents) : orderTotal;
  return {
    orderId: order.order_id,
    orderNumber: order.order_number,
    customerName: order.customer_name || "",
    customerPhone: order.customer_phone || "",
    customerId: order.customer_id || "",
    creditCustomerId: creditOwner?.customer_id || "",
    creditCustomerName: creditOwner?.name || "",
    creditCustomerPhone: creditOwner?.phone || "",
    orderStatus: order.status,
    currencyCode: order.currency_code || "",
    currencyLabel: order.currency_label || order.currency_code || "",
    currencyDecimals: Number(order.currency_decimals != null ? order.currency_decimals : 2),
    orderTotalCents: orderTotal,
    paidCents: allocations.paidCents,
    balanceCents: allocations.balanceCents,
    cashCents: allocations.cashCents,
    bankCents: allocations.bankCents,
    creditCents: allocations.creditCents,
    unallocatedCents: allocations.unallocatedCents,
    hasAllocations: allocations.hasAllocations,
    paymentStatus: allocations.paymentStatus,
    settlement: settlement
      ? {
          settlementId: settlement.settlement_id,
          tender: settlement.tender,
          amountCents: Number(settlement.amount_cents),
          currencyCode: settlement.currency_code,
          balanceBeforeCents: Number(settlement.balance_before_cents),
          balanceAfterCents: Number(settlement.balance_after_cents),
          createdAt: settlement.created_at,
          createdByUserId: settlement.created_by_user_id,
          ...bankDisplay(getDb(), settlement.bank_account_id),
        }
      : null,
  };
}

/**
 * Payment status for one shop order.
 * A missing balance row is UNPAID. The order total is the stored snapshot.
 */
export function getOrderPayment(orderId, shopId) {
  const db = getDb();
  const id = String(orderId || "").trim();
  const order = id ? db.prepare(`SELECT * FROM orders WHERE order_id = ?`).get(id) : null;
  if (!order || order.tenant_id !== shopId) {
    throw fail(404, "Order not found.", "ORDER_NOT_FOUND");
  }
  return paymentView(
    order,
    loadBalance(db, shopId, id),
    db.prepare(`SELECT * FROM order_settlements WHERE shop_id = ? AND order_id = ?`).get(shopId, id)
  );
}

/**
 * Open test orders in this shop that have not been fully paid.
 */
export function listPendingPayments(shopId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT o.order_id, o.order_number, o.customer_name, o.customer_phone,
              o.total_cents, o.currency_code, o.currency_label, o.currency_decimals,
              o.created_at, o.status,
              b.paid_cents, b.balance_cents, b.payment_status
       FROM orders o
       LEFT JOIN order_payment_balances b
         ON b.shop_id = o.tenant_id AND b.order_id = o.order_id
       WHERE o.tenant_id = ?
         AND o.is_test = 1
         AND o.status = 'OPEN'
         AND (b.order_id IS NULL OR (b.payment_status != 'PAID' AND b.balance_cents > 0))
       ORDER BY o.created_at ASC, o.order_number ASC`
    )
    .all(shopId);
  return rows.filter(row => {
    return readAllocationSummary(db,shopId,row.order_id,row.total_cents).unallocatedCents > 0;
  }).map((row) => ({
    orderId: row.order_id,
    orderNumber: row.order_number,
    customerName: row.customer_name || "",
    customerPhone: row.customer_phone || "",
    orderStatus: row.status,
    currencyCode: row.currency_code || "",
    currencyLabel: row.currency_label || row.currency_code || "",
    currencyDecimals: Number(row.currency_decimals != null ? row.currency_decimals : 2),
    orderTotalCents: Number(row.total_cents || 0),
    paidCents: row.payment_status ? Number(row.paid_cents || 0) : 0,
    balanceCents: row.payment_status ? Number(row.balance_cents || 0) : Number(row.total_cents || 0),
    paymentStatus: row.payment_status || "UNPAID",
    createdAt: row.created_at,
  }));
}

function isUnique(err) {
  const code = String(err?.code || "");
  return code.includes("UNIQUE") || /UNIQUE constraint failed/i.test(String(err?.message || ""));
}

function audited(err) {
  if (err?.auditRejection) recordAudit(err.auditRejection);
  return err;
}
