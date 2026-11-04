/**
 * Shop bank accounts for cashier-confirmed sales receipts.
 * Passwords, card numbers, and gateway secrets are not stored.
 */
import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { nowIso } from "../util/time.js";
import { recordAudit } from "./audit.js";

const TYPES = new Set(["OPERATIONAL", "RESERVE"]);
const SECRET_FIELDS = [
  "password",
  "onlinePassword",
  "cardNumber",
  "pan",
  "cvv",
  "secret",
  "apiKey",
  "gatewaySecret",
  "accountNumber",
];

function fail(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

export function toPublicBankError(err) {
  const code = String(err?.code || "");
  const message = String(err?.message || "");
  const sqlite = code.startsWith("SQLITE_") || /SQLITE|constraint failed/i.test(message);
  if (!sqlite) return err;
  return fail(409, "The bank account could not be saved.", "BANK_ACCOUNT_CONFLICT");
}

function rejectSecrets(input) {
  if (!input || typeof input !== "object") return;
  for (const field of SECRET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      throw fail(
        400,
        "Bank passwords, card numbers, and gateway secrets are not stored.",
        "SECRET_NOT_ALLOWED"
      );
    }
  }
}

export function maskedReference(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length > 64 || !/^[\d*\-\s]+$/.test(text)) {
    throw fail(400, "Use a masked account reference, such as ****1234.", "INVALID_REFERENCE");
  }
  const digits = text.replace(/\D/g, "");
  if (!digits) return "";
  return `****${digits.slice(-4)}`;
}

function cleanName(value, label) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 80) {
    throw fail(400, `${label} is required.`, "INVALID_ACCOUNT");
  }
  return text;
}

function cleanType(value) {
  const type = String(value ?? "").trim().toUpperCase();
  if (!TYPES.has(type)) {
    throw fail(400, "Choose Operational or Reserve.", "INVALID_ACCOUNT_TYPE");
  }
  return type;
}

function view(row) {
  return {
    accountId: row.account_id,
    shopId: row.shop_id,
    displayName: row.display_name,
    bankName: row.bank_name,
    accountType: row.account_type,
    isActive: Number(row.is_active) === 1,
    maskedReference: row.masked_reference || "",
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditAccount(actor, action, account) {
  recordAudit({
    actorRole: actor.role || "",
    actorUserId: actor.userId || "",
    action,
    entityType: "shop_bank_account",
    entityId: account.accountId,
    detail: {
      shopId: account.shopId,
      accountId: account.accountId,
      displayName: account.displayName,
      bankName: account.bankName,
      accountType: account.accountType,
      isActive: account.isActive,
      maskedReference: account.maskedReference,
      staffUserId: actor.userId || "",
    },
  });
}

export function listSalesBankAccounts(shopId) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM shop_bank_accounts
       WHERE shop_id = ? AND account_type = 'OPERATIONAL' AND is_active = 1
       ORDER BY display_name COLLATE NOCASE, bank_name COLLATE NOCASE`
    )
    .all(shopId);
  return rows.map(view);
}

export function listManagedBankAccounts(shopId) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM shop_bank_accounts
       WHERE shop_id = ?
       ORDER BY is_active DESC, account_type, display_name COLLATE NOCASE`
    )
    .all(shopId);
  return rows.map(view);
}

export function createBankAccount(shopId, input, actor = {}) {
  const userId = String(actor.userId || "").trim();
  if (!userId) throw fail(403, "You do not have permission for this action.", "FORBIDDEN");
  rejectSecrets(input);
  const displayName = cleanName(input?.displayName, "Display name");
  const bankName = cleanName(input?.bankName, "Bank name");
  const accountType = cleanType(input?.accountType);
  const isActive = input?.isActive === false ? 0 : 1;
  const reference = maskedReference(input?.maskedReference);
  const now = nowIso();
  const accountId = newId("acct");
  getDb()
    .prepare(
      `INSERT INTO shop_bank_accounts (
         account_id, shop_id, display_name, bank_name, account_type, is_active,
         masked_reference, created_by_user_id, updated_by_user_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      accountId,
      shopId,
      displayName,
      bankName,
      accountType,
      isActive,
      reference,
      userId,
      userId,
      now,
      now
    );
  const account = view(
    getDb().prepare(`SELECT * FROM shop_bank_accounts WHERE account_id = ?`).get(accountId)
  );
  auditAccount(actor, "bank_account.create", account);
  return account;
}

export function updateBankAccount(shopId, accountId, input, actor = {}) {
  const userId = String(actor.userId || "").trim();
  if (!userId) throw fail(403, "You do not have permission for this action.", "FORBIDDEN");
  rejectSecrets(input);
  const id = String(accountId || "").trim();
  const existing = getDb()
    .prepare(`SELECT * FROM shop_bank_accounts WHERE account_id = ?`)
    .get(id);
  if (!existing || existing.shop_id !== shopId) {
    throw fail(404, "Bank account not found.", "BANK_ACCOUNT_NOT_FOUND");
  }
  const displayName = cleanName(input?.displayName, "Display name");
  const bankName = cleanName(input?.bankName, "Bank name");
  const accountType = cleanType(input?.accountType);
  const isActive = input?.isActive === false || input?.isActive === 0 ? 0 : 1;
  const reference = maskedReference(input?.maskedReference);
  const now = nowIso();
  getDb()
    .prepare(
      `UPDATE shop_bank_accounts
       SET display_name = ?, bank_name = ?, account_type = ?, is_active = ?,
           masked_reference = ?, updated_by_user_id = ?, updated_at = ?
       WHERE account_id = ? AND shop_id = ?`
    )
    .run(displayName, bankName, accountType, isActive, reference, userId, now, id, shopId);
  const account = view(
    getDb().prepare(`SELECT * FROM shop_bank_accounts WHERE account_id = ?`).get(id)
  );
  const wasActive = Number(existing.is_active) === 1;
  const action = wasActive === account.isActive
    ? "bank_account.update"
    : account.isActive
      ? "bank_account.activate"
      : "bank_account.deactivate";
  auditAccount(actor, action, account);
  return account;
}
