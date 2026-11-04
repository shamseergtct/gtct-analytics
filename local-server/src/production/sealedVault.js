/**
 * Phase P2-A2: A deliberately SEALED production data vault.
 * This module never enables a production server, shop, order, settlement,
 * printer, or production schema migration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { DB_IDENTITY_KEY } from '../operatingMode.js';
import { resolveDataDir } from '../config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SEALED_DB_FILE = 'gtct-production-sealed.sqlite';
export const SEALED_STATUS = 'SEALED';

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function disjoint(a, b) {
  return !inside(a, b) && !inside(b, a);
}
function canon(p) {
  let current = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...tail);
}
function validLocalPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) {
    throw new Error(`${label} requires an explicit absolute local path.`);
  }
  const raw = value.trim();
  if (raw.startsWith('\\\\') || raw.startsWith('//')) throw new Error(`${label} cannot be a network share.`);
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) {
    throw new Error(`${label} cannot be a filesystem root or the home directory.`);
  }
  // Existing symlinks and aliases in the chosen path must not point to a test/source path.
  return { resolved, canonical: canon(resolved) };
}
function guardedDirs(productionDir, backupDir) {
  const testDir = validLocalPath(resolveDataDir(), 'TEST data directory');
  const sourceDir = validLocalPath(ROOT, 'Application source directory');
  for (const bad of [testDir, sourceDir]) {
    if (!disjoint(productionDir.canonical, bad.canonical) || !disjoint(productionDir.resolved, bad.resolved)) {
      throw new Error('Production directory must be separate from TEST data and application source.');
    }
  }
  if (backupDir) {
    if (!disjoint(backupDir.canonical, productionDir.canonical) || !disjoint(backupDir.resolved, productionDir.resolved)) {
      throw new Error('Backup directory must be separate from production data.');
    }
    for (const bad of [testDir, sourceDir]) {
      if (!disjoint(backupDir.canonical, bad.canonical) || !disjoint(backupDir.resolved, bad.resolved)) {
        throw new Error('Backup directory must be separate from TEST data and application source.');
      }
    }
  }
}

export function getSealedPathOptions(env = process.env, needBackup = false) {
  const prod = validLocalPath(env.GTCT_PRODUCTION_DATA_DIR, 'GTCT_PRODUCTION_DATA_DIR');
  const backup = needBackup ? validLocalPath(env.GTCT_PRODUCTION_BACKUP_DIR, 'GTCT_PRODUCTION_BACKUP_DIR') : null;
  guardedDirs(prod, backup);
  return { productionDir: prod.resolved, dbPath: path.join(prod.resolved, SEALED_DB_FILE), backupDir: backup?.resolved };
}

function readIdentity(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  if (tables.length !== 1 || tables[0] !== 'meta') throw new Error('Not a sealed-only production vault; unexpected schema.');
  const rows = db.prepare('SELECT key, value FROM meta').all();
  if (rows.length !== 1 || rows[0].key !== DB_IDENTITY_KEY) throw new Error('Sealed production identity is missing or unexpected.');
  let identity;
  try { identity = JSON.parse(rows[0].value); } catch { throw new Error('Sealed production identity is corrupt.'); }
  if (
    identity?.version !== 1 || identity.operatingMode !== 'PRODUCTION' ||
    identity.state !== SEALED_STATUS ||
    typeof identity.installationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(identity.installationId) ||
    typeof identity.createdAt !== 'string' || Number.isNaN(Date.parse(identity.createdAt))
  ) throw new Error('Sealed production identity is invalid.');
  return identity;
}

export function verifySealedVault(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error('Sealed production database is missing.');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const ok = db.pragma('integrity_check');
    if (ok.length !== 1 || ok[0].integrity_check !== 'ok') throw new Error('SQLite integrity_check failed.');
    if (db.pragma('foreign_key_check').length) throw new Error('SQLite foreign_key_check failed.');
    return readIdentity(db);
  } finally { db.close(); }
}

export function prepareSealedProductionVault(env = process.env) {
  const { productionDir, dbPath } = getSealedPathOptions(env);
  if (fs.existsSync(productionDir)) throw new Error('Production directory already exists; refusing to initialize or overwrite it.');
  const parent = path.dirname(productionDir);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('Production parent directory must exist before initialization.');
  }
  // Exclusive create. Never migrate/copy a TEST database or populate a real shop.
  fs.mkdirSync(productionDir, { mode: 0o700 });
  const db = new Database(dbPath, { fileMustExist: false });
  try {
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = FULL');
    const identity = {
      version: 1, operatingMode: 'PRODUCTION', state: SEALED_STATUS,
      installationId: randomUUID(), createdAt: new Date().toISOString(),
    };
    db.transaction(() => {
      db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(DB_IDENTITY_KEY, JSON.stringify(identity));
    })();
  } finally { db.close(); }
  try { fs.chmodSync(dbPath, 0o600); } catch { /* Windows: protect with NTFS ACLs during deployment */ }
  return { dbPath, identity: verifySealedVault(dbPath) };
}

export async function backupSealedProductionVault(env = process.env) {
  const { dbPath, backupDir } = getSealedPathOptions(env, true);
  const identity = verifySealedVault(dbPath);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const basename = `gtct-sealed-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`;
  const dest = path.join(backupDir, basename);
  if (fs.existsSync(dest)) throw new Error('Backup destination exists; refusing overwrite.');
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(dest);
  } finally { source.close(); }
  try { fs.chmodSync(dest, 0o600); } catch { /* Windows NTFS permissions checked separately */ }
  try {
    const copied = verifySealedVault(dest);
    if (copied.installationId !== identity.installationId || copied.createdAt !== identity.createdAt) {
      throw new Error('Backup identity verification failed.');
    }
  } catch (err) {
    // Only this newly created backup file may be deleted on verification failure.
    fs.rmSync(dest, { force: true });
    throw err;
  }
  return { backupPath: dest, identity };
}
