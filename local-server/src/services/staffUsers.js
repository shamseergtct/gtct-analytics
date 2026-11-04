import { getDb } from "../db/db.js";
import { newId } from "../util/ids.js";
import { recordAudit } from "./audit.js";
import { readStaffRiderCommission, assignStaffRiderCommissionInTx } from "./deliveryCommissionSettings.js";
import {
  hashPassword,
  normalizeUsername,
  revokeStaffSessions,
  validatePassword,
  StaffAuthError,
} from "./staffAuth.js";

const ROLES = {
  admin: "role_admin",
  cashier: "role_cashier",
  kitchen: "role_kitchen",
  delivery: "role_delivery",
};

export const OPTIONAL_PERMISSIONS = ["sales.price_override", "sales.addon_price_override"];

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function activeAdminCount(db, shopId, exceptUserId = "") {
  return db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM staff_users u
       JOIN staff_user_roles r
         ON r.user_id = u.user_id AND r.shop_id = u.shop_id
       WHERE u.shop_id = ?
         AND u.is_active = 1
         AND u.user_id != ?
         AND r.role_id = 'role_admin'
         AND r.revoked_at IS NULL`
    )
    .get(shopId, exceptUserId || "").n;
}

function roleCode(roleId) {
  if (roleId === "role_admin") return "admin";
  if (roleId === "role_cashier") return "cashier";
  if (roleId === "role_kitchen") return "kitchen";
  if (roleId === "role_delivery") return "delivery";
  return "";
}

function optionalGrants(db, shopId, userId) {
  return db
    .prepare(
      `SELECT permission_code FROM staff_user_permissions
       WHERE shop_id = ? AND user_id = ? AND revoked_at IS NULL
       ORDER BY permission_code`
    )
    .all(shopId, userId)
    .map((row) => row.permission_code)
    .filter((code) => OPTIONAL_PERMISSIONS.includes(code));
}

export function listAssignablePrepStations() {
  return getDb().prepare(`SELECT station_id AS stationId, name
    FROM stations WHERE is_active = 1 AND station_id != 'station_cashier' ORDER BY name`).all();
}

export function listKitchenStationIds(shopId, userId) {
  if (!shopId || !userId) return [];
  return getDb().prepare(`SELECT a.station_id FROM staff_station_assignments a
    JOIN stations s ON s.station_id = a.station_id
    WHERE a.shop_id = ? AND a.user_id = ? AND s.is_active = 1
      AND s.station_id != 'station_cashier' ORDER BY s.name`).all(shopId, userId)
    .map((row) => row.station_id);
}

function readStationIds(value) {
  if (!Array.isArray(value) || value.length > 30) fail(400, "Choose preparation stations from the list.");
  const ids = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry)) {
      fail(400, "Invalid preparation station.");
    }
    if (ids.includes(entry)) fail(400, "Duplicate preparation station.");
    ids.push(entry);
  }
  return ids;
}

function validateStationIds(db, ids) {
  for (const id of ids) {
    const row = db.prepare(`SELECT station_id FROM stations
      WHERE station_id = ? AND is_active = 1 AND station_id != 'station_cashier'`).get(id);
    if (!row) fail(400, "Choose an active preparation station.");
  }
}

function replaceStationAssignments(db, shopId, userId, ids, now) {
  db.prepare(`DELETE FROM staff_station_assignments WHERE shop_id = ? AND user_id = ?`)
    .run(shopId, userId);
  const insert = db.prepare(`INSERT INTO staff_station_assignments
    (shop_id, user_id, station_id, assigned_at) VALUES (?, ?, ?, ?)`);
  for (const id of ids) insert.run(shopId, userId, id, now);
}

function mapUser(db, shopId, row) {
  return {
    userId: row.user_id,
    fullName: row.full_name,
    username: row.username,
    role: roleCode(row.role_id),
    isActive: row.is_active === 1,
    permissions: ["kitchen", "delivery"].includes(roleCode(row.role_id)) ? [] : optionalGrants(db, shopId, row.user_id),
    stationIds: roleCode(row.role_id) === "kitchen" ? listKitchenStationIds(shopId, row.user_id) : [],
    commissionRule: roleCode(row.role_id) === "delivery" ? readStaffRiderCommission(shopId,row.user_id) : null,
    createdAt: row.created_at,
  };
}

function loadUser(db, shopId, userId) {
  const row = db
    .prepare(
      `SELECT u.user_id, u.full_name, u.username, u.is_active, u.created_at, r.role_id
       FROM staff_users u
       LEFT JOIN staff_user_roles r
         ON r.user_id = u.user_id
        AND r.shop_id = u.shop_id
        AND r.revoked_at IS NULL
        AND r.role_id IN ('role_admin', 'role_cashier', 'role_kitchen', 'role_delivery')
       WHERE u.shop_id = ? AND u.user_id = ?
       ORDER BY CASE WHEN r.role_id = 'role_admin' THEN 0 ELSE 1 END
       LIMIT 1`
    )
    .get(shopId, userId);
  return row ? mapUser(db, shopId, row) : null;
}

export function listStaffUsers(shopId) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT u.user_id, u.full_name, u.username, u.is_active, u.created_at, r.role_id
       FROM staff_users u
       LEFT JOIN staff_user_roles r
         ON r.user_id = u.user_id
        AND r.shop_id = u.shop_id
        AND r.revoked_at IS NULL
        AND r.role_id IN ('role_admin', 'role_cashier', 'role_kitchen', 'role_delivery')
       WHERE u.shop_id = ?
       ORDER BY u.full_name COLLATE NOCASE, u.username COLLATE NOCASE`
    )
    .all(shopId);
  const seen = new Set();
  const users = [];
  for (const row of rows) {
    if (seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    users.push(mapUser(db, shopId, row));
  }
  return users;
}

function readRole(value, fallback = "cashier") {
  const role = String(value || fallback).trim().toLowerCase();
  if (!ROLES[role]) fail(400, "Choose Admin, Cashier, Kitchen or Delivery.");
  return role;
}

function readOptionalPermissions(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(400, "Permissions must be a list.");
  const codes = [];
  for (const code of value) {
    const text = String(code || "").trim();
    if (!OPTIONAL_PERMISSIONS.includes(text)) {
      fail(400, "That permission cannot be granted here.");
    }
    if (!codes.includes(text)) codes.push(text);
  }
  return codes;
}

function assignRole(db, shopId, userId, role, now) {
  const roleId = ROLES[role];
  db.prepare(
    `UPDATE staff_user_roles
     SET revoked_at = ?
     WHERE shop_id = ? AND user_id = ? AND revoked_at IS NULL AND role_id != ?`
  ).run(now, shopId, userId, roleId);
  const existing = db
    .prepare(
      `SELECT revoked_at FROM staff_user_roles
       WHERE shop_id = ? AND user_id = ? AND role_id = ?`
    )
    .get(shopId, userId, roleId);
  if (!existing) {
    db.prepare(
      `INSERT INTO staff_user_roles (shop_id, user_id, role_id, assigned_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`
    ).run(shopId, userId, roleId, now);
    return;
  }
  if (existing.revoked_at) {
    db.prepare(
      `UPDATE staff_user_roles
       SET revoked_at = NULL, assigned_at = ?
       WHERE shop_id = ? AND user_id = ? AND role_id = ?`
    ).run(now, shopId, userId, roleId);
  }
}

function replaceOptionalGrants(db, shopId, userId, codes, now) {
  const current = db
    .prepare(
      `SELECT permission_code, revoked_at FROM staff_user_permissions
       WHERE shop_id = ? AND user_id = ?`
    )
    .all(shopId, userId);
  const wanted = new Set(codes);
  for (const row of current) {
    if (!OPTIONAL_PERMISSIONS.includes(row.permission_code)) continue;
    if (wanted.has(row.permission_code)) {
      if (row.revoked_at) {
        db.prepare(
          `UPDATE staff_user_permissions
           SET revoked_at = NULL, granted_at = ?
           WHERE shop_id = ? AND user_id = ? AND permission_code = ?`
        ).run(now, shopId, userId, row.permission_code);
      }
      wanted.delete(row.permission_code);
    } else if (!row.revoked_at) {
      db.prepare(
        `UPDATE staff_user_permissions
         SET revoked_at = ?
         WHERE shop_id = ? AND user_id = ? AND permission_code = ?`
      ).run(now, shopId, userId, row.permission_code);
    }
  }
  for (const code of wanted) {
    db.prepare(
      `INSERT INTO staff_user_permissions (shop_id, user_id, permission_code, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL)`
    ).run(shopId, userId, code, now);
  }
}

function guardLastAdmin(db, shopId, userId, nextRole, nextActive) {
  const current = loadUser(db, shopId, userId);
  if (!current || current.role !== "admin" || !current.isActive) return;
  const leaving = nextRole !== "admin" || !nextActive;
  if (!leaving) return;
  if (activeAdminCount(db, shopId, userId) < 1) {
    fail(409, "The shop must keep one active administrator.");
  }
}

export function createStaffUser(shopId, input, actor) {
  const fullName = String(input.fullName || input.full_name || "").trim();
  const username = String(input.username || "").trim();
  const normalized = normalizeUsername(username);
  const password = input.password;
  const confirm = input.confirmPassword ?? input.confirm_password;
  const role = readRole(input.role, "cashier");
  const isActive = input.isActive === false || input.isActive === 0 ? 0 : 1;
  const permissions = readOptionalPermissions(input.permissions);
  const stationIds = role === "kitchen" ? readStationIds(input.stationIds) : [];
  // Legacy staff creation clients without commission fields default to no commission.
  // New User Management always sends an explicit rule.
  if(role !== 'delivery' && input.commissionPolicy != null)
    fail(400,'Commission rules are only for Delivery Boy staff.');
  if (["kitchen", "delivery"].includes(role) && permissions.length) fail(400, "Restricted staff cannot receive Sales permissions.");
  if (role !== "kitchen" && input.stationIds != null && readStationIds(input.stationIds).length) {
    fail(400, "Only Kitchen staff can be assigned preparation stations.");
  }
  if (role === "kitchen" && !stationIds.length) fail(400, "Assign at least one station to Kitchen staff.");
  if (!fullName || fullName.length > 80) fail(400, "Enter the staff member’s name.");
  if (!/^[a-z0-9._-]{3,40}$/.test(normalized)) {
    fail(400, "Use a username of 3–40 letters, numbers, dots, underscores, or hyphens.");
  }
  if (typeof password !== "string" || password !== confirm) {
    fail(400, "Enter the password twice, with the same value.");
  }
  const passwordError = validatePassword(password, username);
  if (passwordError) fail(400, passwordError);
  const passwordHash = hashPassword(password);
  if (passwordHash.includes(password)) fail(400, "Password could not be stored safely.");

  const db = getDb();
  const now = new Date().toISOString();
  const userId = newId("user");
  const run = db.transaction(() => {
    const shop = db.prepare(`SELECT shop_id FROM shop_settings WHERE shop_id = ?`).get(shopId);
    if (!shop) fail(400, "This shop was not found.");
    validateStationIds(db, stationIds);
    const taken = db
      .prepare(`SELECT user_id FROM staff_users WHERE shop_id = ? AND username_normalized = ?`)
      .get(shopId, normalized);
    if (taken) fail(409, "That username is already in use.");
    db.prepare(
      `INSERT INTO staff_users (
         user_id, shop_id, full_name, username, username_normalized, password_hash,
         is_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, shopId, fullName, username, normalized, passwordHash, isActive, now, now);
    assignRole(db, shopId, userId, role, now);
    replaceOptionalGrants(db, shopId, userId, permissions, now);
    replaceStationAssignments(db, shopId, userId, stationIds, now);
    if(role==='delivery' && input.commissionPolicy!=null)
      assignStaffRiderCommissionInTx(db,shopId,userId,input.commissionPolicy,actor);
  });
  try {
    run.immediate();
  } catch (err) {
    if (err.status) throw err;
    if (err instanceof StaffAuthError) fail(400, err.message);
    if (/UNIQUE/i.test(String(err.message))) fail(409, "That username is already in use.");
    throw err;
  }

  const user = loadUser(db, shopId, userId);
  recordAudit({
    actorRole: actor.role,
    actorUserId: actor.userId || "",
    action: "staff.user.create",
    entityType: "staff_user",
    entityId: userId,
    detail: {
      userId,
      username: user.username,
      role: user.role,
      isActive: user.isActive,
      permissions: user.permissions,
      stationIds: user.stationIds,
    },
  });
  return user;
}

export function updateStaffUser(shopId, userId, input, actor) {
  const db = getDb();
  const current = loadUser(db, shopId, userId);
  if (!current) fail(404, "Staff member not found.");
  const fullName =
    input.fullName != null || input.full_name != null
      ? String(input.fullName ?? input.full_name).trim()
      : current.fullName;
  const role = input.role != null ? readRole(input.role) : current.role;
  const isActive =
    input.isActive == null ? current.isActive : !(input.isActive === false || input.isActive === 0);
  const suppliedPermissions = input.permissions == null ? null : readOptionalPermissions(input.permissions);
  if (["kitchen", "delivery"].includes(role) && suppliedPermissions?.length) {
    fail(400, "Restricted staff cannot receive Sales permissions.");
  }
  const permissions = ["kitchen", "delivery"].includes(role) ? [] : suppliedPermissions ?? current.permissions;
  const stationIds = role === "kitchen"
    ? input.stationIds == null ? current.stationIds : readStationIds(input.stationIds)
    : [];
  if(role !== 'delivery' && input.commissionPolicy != null)
    fail(400,'Commission rules are only for Delivery Boy staff.');
  // Existing integrations can edit delivery staff without changing commission settings.
  if (["kitchen", "delivery"].includes(role) && permissions.length) fail(400, "Restricted staff cannot receive Sales permissions.");
  if (role !== "kitchen" && input.stationIds != null && readStationIds(input.stationIds).length) {
    fail(400, "Only Kitchen staff can be assigned preparation stations.");
  }
  if (role === "kitchen" && !stationIds.length) fail(400, "Assign at least one station to Kitchen staff.");
  if (!fullName || fullName.length > 80) fail(400, "Enter the staff member’s name.");
  guardLastAdmin(db, shopId, userId, role, isActive);

  const now = new Date().toISOString();
  const roleChanged = role !== current.role;
  const deactivated = current.isActive && !isActive;
  const stationsChanged = stationIds.join("|") !== current.stationIds.join("|");
  const run = db.transaction(() => {
    validateStationIds(db, stationIds);
    db.prepare(
      `UPDATE staff_users SET full_name = ?, is_active = ?, updated_at = ? WHERE shop_id = ? AND user_id = ?`
    ).run(fullName, isActive ? 1 : 0, now, shopId, userId);
    assignRole(db, shopId, userId, role, now);
    replaceOptionalGrants(db, shopId, userId, permissions, now);
    replaceStationAssignments(db, shopId, userId, stationIds, now);
    if(role === 'delivery' && input.commissionPolicy != null)
      assignStaffRiderCommissionInTx(db,shopId,userId,input.commissionPolicy,actor);
  });
  run.immediate();
  if (deactivated || roleChanged || stationsChanged) revokeStaffSessions(shopId, userId);

  const user = loadUser(db, shopId, userId);
  const granted = user.permissions.filter((code) => !current.permissions.includes(code));
  const revoked = current.permissions.filter((code) => !user.permissions.includes(code));
  recordAudit({
    actorRole: actor.role,
    actorUserId: actor.userId || "",
    action: deactivated ? "staff.user.deactivate" : "staff.user.update",
    entityType: "staff_user",
    entityId: userId,
    detail: {
      userId,
      role: user.role,
      previousRole: current.role,
      isActive: user.isActive,
      granted,
      revoked,
      stationIds: user.stationIds,
      previousStationIds: current.stationIds,
    },
  });
  return user;
}

export function resetStaffPassword(shopId, userId, input, actor) {
  const password = input.password;
  const confirm = input.confirmPassword ?? input.confirm_password;
  if (typeof password !== "string" || password !== confirm) {
    fail(400, "Enter the new password twice, with the same value.");
  }
  const db = getDb();
  const current = loadUser(db, shopId, userId);
  if (!current) fail(404, "Staff member not found.");
  const passwordError = validatePassword(password, current.username);
  if (passwordError) fail(400, passwordError);
  const passwordHash = hashPassword(password);
  if (passwordHash.includes(password)) fail(400, "Password could not be stored safely.");
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE staff_users SET password_hash = ?, updated_at = ? WHERE shop_id = ? AND user_id = ?`
  ).run(passwordHash, now, shopId, userId);
  revokeStaffSessions(shopId, userId);
  recordAudit({
    actorRole: actor.role,
    actorUserId: actor.userId || "",
    action: "staff.password.reset",
    entityType: "staff_user",
    entityId: userId,
    detail: { userId, username: current.username },
  });
  return { userId, username: current.username };
}
