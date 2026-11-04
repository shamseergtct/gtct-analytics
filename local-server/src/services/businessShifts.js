/** TEST-only operational shift identity. Never rolls over at midnight.
 * This is NOT an accounting day-end, payment settlement or shift reconciliation.
 */
import { getDb } from '../db/db.js';
import { getShopSettings } from './shopSettings.js';
import { newId } from '../util/ids.js';
import { nowIso } from '../util/time.js';
import { recordAudit } from './audit.js';

function fail(status, message, code) {
  throw Object.assign(new Error(message), { status, code });
}

function shopDate(shopId) {
  const zone = getShopSettings(shopId).timezone || 'UTC';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function requireValidDate(value) {
  const str = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) fail(400, 'Valid business date (YYYY-MM-DD) required.', 'INVALID_BUSINESS_DATE');
  const dt = new Date(`${str}T00:00:00Z`);
  if (!Number.isFinite(dt.getTime()) || dt.toISOString().slice(0, 10) !== str) {
    fail(400, 'Business date does not exist.', 'INVALID_BUSINESS_DATE');
  }
  return str;
}

function active(db, shopId) {
  return db.prepare(`SELECT * FROM shop_business_shifts
    WHERE shop_id = ? AND status = 'OPEN'`).get(shopId) || null;
}

function toView(shift) {
  if (!shift) return null;
  return {
    shiftId: shift.shift_id,
    businessDate: shift.business_date,
    status: shift.status,
    lastTokenNumber: Number(shift.last_token_number),
    nextTokenNumber: Number(shift.last_token_number) + 1,
    openedAt: shift.opened_at,
    closedAt: shift.closed_at || null,
  };
}

export function getBusinessShift(shopId) {
  const db = getDb();
  const shift = active(db, shopId);
  return {
    active: toView(shift),
    suggestedBusinessDate: shopDate(shopId),
    requiresManualStart: !shift && Boolean(db.prepare(`SELECT 1 AS present
      FROM shop_business_shifts WHERE shop_id = ? LIMIT 1`).get(shopId)),
  };
}

function insertShift(db, shopId, businessDate, actorUserId = '') {
  const shiftId = newId('shift');
  const stamp = nowIso();
  db.prepare(`INSERT INTO shop_business_shifts
    (shift_id, shop_id, business_date, status, last_token_number, opened_at, opened_by_user_id)
    VALUES (?, ?, ?, 'OPEN', 0, ?, ?)`).run(shiftId, shopId, businessDate, stamp, actorUserId || null);
  return active(db, shopId);
}

/** Called inside createTestOrder's SQLite transaction. First TEST shift can
 * initialize automatically for backwards compatibility. After any close,
 * a new shift requires an explicit Admin action (no midnight reset).
 */
export function allocateTokenInOrderTransaction(db, shopId, actorUserId = '') {
  let shift = active(db, shopId);
  if (!shift) {
    const anyHistory = db.prepare(`SELECT 1 AS present FROM shop_business_shifts
      WHERE shop_id = ? LIMIT 1`).get(shopId);
    if (anyHistory) fail(409, 'Shift closed. Admin must open a new business shift.', 'BUSINESS_SHIFT_CLOSED');
    const date = shopDate(shopId);
    shift = insertShift(db, shopId, date, actorUserId);
    recordAudit({ actorRole: 'system', actorUserId,
      action: 'business_shift.auto_open_test', entityType: 'shop_business_shift',
      entityId: shift.shift_id, detail: { shopId, businessDate: date, testOnly: true } });
  }
  const allocated = db.prepare(`UPDATE shop_business_shifts SET last_token_number = last_token_number + 1
    WHERE shift_id = ? AND shop_id = ? AND status = 'OPEN'
    RETURNING last_token_number`).get(shift.shift_id, shopId);
  if (!allocated) fail(409, 'Open shift changed. Refresh and retry.', 'BUSINESS_SHIFT_CHANGED');
  return {
    shiftId: shift.shift_id,
    businessDate: shift.business_date,
    tokenNumber: Number(allocated.last_token_number),
  };
}

export function assertOrderShiftOpenForEdit(db, shopId, order) {
  if (!order.business_shift_id) return; // legacy historical TEST orders
  const shift = db.prepare(`SELECT status FROM shop_business_shifts
    WHERE shift_id = ? AND shop_id = ?`).get(order.business_shift_id, shopId);
  if (!shift || shift.status !== 'OPEN') {
    fail(409, 'This order belongs to a closed shift and cannot be edited.', 'ORDER_SHIFT_CLOSED');
  }
}

export function openBusinessShift(shopId, requestedDate, actor) {
  if (!actor?.userId || actor.role !== 'admin') fail(403, 'Admin required.', 'SHIFT_ADMIN_REQUIRED');
  const date = requireValidDate(requestedDate || shopDate(shopId));
  const db = getDb();
  return db.transaction(() => {
    if (active(db, shopId)) fail(409, 'Close the current shift before opening another.', 'SHIFT_ALREADY_OPEN');
    const shift = insertShift(db, shopId, date, actor.userId);
    recordAudit({ actorRole: actor.role, actorUserId: actor.userId,
      action: 'business_shift.open', entityType: 'shop_business_shift', entityId: shift.shift_id,
      detail: { shopId, businessDate: date } });
    return toView(shift);
  }).immediate();
}

export function closeBusinessShift(shopId, shiftId, actor, confirm) {
  if (!actor?.userId || actor.role !== 'admin') fail(403, 'Admin required.', 'SHIFT_ADMIN_REQUIRED');
  if (confirm !== true) fail(400, 'Explicit confirmation required. No shift was closed.', 'SHIFT_CONFIRM_REQUIRED');
  const db = getDb();
  return db.transaction(() => {
    const shift = active(db, shopId);
    if (!shift || shift.shift_id !== String(shiftId || '')) {
      fail(409, 'Shift changed. Refresh and review the active shift.', 'SHIFT_CHANGED');
    }
    const stamp = nowIso();
    db.prepare(`UPDATE shop_business_shifts SET status='CLOSED', closed_at=?, closed_by_user_id=?
      WHERE shift_id=? AND shop_id=? AND status='OPEN'`).run(stamp, actor.userId, shift.shift_id, shopId);
    recordAudit({ actorRole: actor.role, actorUserId: actor.userId,
      action: 'business_shift.close', entityType: 'shop_business_shift', entityId: shift.shift_id,
      detail: { shopId, businessDate: shift.business_date, lastTokenNumber: shift.last_token_number,
        note: 'Operational shift only. No cash reconciliation or settlement was performed.' } });
    return toView({ ...shift, status: 'CLOSED', closed_at: stamp });
  }).immediate();
}
