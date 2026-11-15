/**
 * First-run bootstrap for the Windows TEST PILOT package.
 * Available only while no active Admin exists. Never embeds credentials.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../db/db.js";
import { createFirstAdmin, StaffAuthError } from "./staffAuth.js";
import { getShopSettings, updateShopSettings } from "./shopSettings.js";

const RUNTIME_FILE = "pilot-runtime.json";

function activeAdminExists(shopId) {
  const row = getDb()
    .prepare(
      `SELECT u.user_id
       FROM staff_users u
       JOIN staff_user_roles r
         ON r.user_id = u.user_id AND r.shop_id = u.shop_id
       WHERE u.shop_id = ?
         AND u.is_active = 1
         AND r.role_id = 'role_admin'
         AND r.revoked_at IS NULL
       LIMIT 1`
    )
    .get(shopId);
  return Boolean(row);
}

function defaultBackupDir() {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "GTCT", "RestaurantPilot-Backups");
  }
  return path.join(os.tmpdir(), "gtct-restaurant-pilot-backups");
}

function readRuntimePrefs(dataDir) {
  const file = path.join(dataDir, RUNTIME_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function assertSafeBackupDir(backupDir, dataDir) {
  const raw = String(backupDir || "").trim();
  if (!raw) throw Object.assign(new Error("Choose a backup folder."), { status: 400 });
  if (!path.isAbsolute(raw)) {
    throw Object.assign(new Error("Backup folder must be an absolute path."), { status: 400 });
  }
  if (raw.startsWith("\\\\") || raw.startsWith("//")) {
    throw Object.assign(new Error("Backup folder cannot be a network share."), { status: 400 });
  }
  const resolved = path.resolve(raw);
  const data = path.resolve(dataDir);
  if (resolved === data || resolved.startsWith(data + path.sep)) {
    throw Object.assign(new Error("Backup folder must be outside the database folder."), {
      status: 400,
    });
  }
  const root = path.parse(resolved).root;
  if (resolved === root || resolved === os.homedir()) {
    throw Object.assign(new Error("Backup folder cannot be a drive root or home folder."), {
      status: 400,
    });
  }
  return resolved;
}

export function getPilotSetupStatus(config) {
  const shopId = config.testTenantId;
  getShopSettings(shopId);
  const needsSetup = !activeAdminExists(shopId);
  const prefs = readRuntimePrefs(config.dataDir);
  return {
    needsSetup,
    operatingMode: config.operatingMode,
    packageLabel: "TEST PILOT",
    physicalPrintEnabled: Boolean(config.physicalPrintEnabled),
    dataDirConfigured: Boolean(config.dataDir),
    suggestedBackupDir: prefs.backupDir || process.env.GTCT_TEST_BACKUP_DIR || defaultBackupDir(),
    currencyPresetDefault: "BHD",
  };
}

export function bootstrapPilotSetup(config, input = {}) {
  if (config.operatingMode !== "TEST") {
    throw Object.assign(new Error("Setup is available only in TEST PILOT mode."), { status: 403 });
  }
  if (!config.loopback) {
    throw Object.assign(new Error("First-run setup is only allowed on this computer."), {
      status: 403,
    });
  }
  const shopId = config.testTenantId;
  if (activeAdminExists(shopId)) {
    throw Object.assign(new Error("Setup is already complete. Sign in with your Admin account."), {
      status: 409,
      code: "setup_complete",
    });
  }

  const shopName = String(input.shopName || "").trim();
  const addressText = String(input.addressText || "").trim();
  const fullName = String(input.fullName || "").trim();
  const username = String(input.username || "").trim();
  const password = String(input.password || "");
  const confirmPassword = String(input.confirmPassword || "");
  if (!shopName) throw Object.assign(new Error("Enter the shop name."), { status: 400 });
  if (password !== confirmPassword) {
    throw Object.assign(new Error("The passwords did not match."), { status: 400 });
  }

  const backupDir = assertSafeBackupDir(input.backupDir || defaultBackupDir(), config.dataDir);
  fs.mkdirSync(backupDir, { recursive: true });

  // Ensure shop row exists, then apply BHD + profile before creating Admin.
  getShopSettings(shopId);
  updateShopSettings(
    shopId,
    {
      displayName: shopName,
      addressText,
      currencyPreset: "BHD",
      confirmCurrencyChange: true,
    },
    { role: "admin" }
  );

  let created;
  try {
    created = createFirstAdmin({
      shopId,
      fullName,
      username,
      password,
    });
  } catch (err) {
    if (err instanceof StaffAuthError) {
      throw Object.assign(new Error(err.message), { status: 400, code: err.code });
    }
    throw err;
  }

  const runtime = {
    version: 1,
    packageLabel: "TEST_PILOT",
    backupDir,
    port: Number(config.port) || 8787,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(config.dataDir, RUNTIME_FILE), `${JSON.stringify(runtime, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });

  return {
    ok: true,
    username: created.username,
    next: {
      printers: "/settings.html",
      sales: "/",
      note: "Configure Kitchen and Cashier printers after sign-in. Physical automatic printing stays off until an authorized manual test succeeds.",
    },
  };
}
