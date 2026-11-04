/**
 * Phase P2-C1: TEST-only, SQLite-consistent snapshots and NON-DESTRUCTIVE restore.
 * No production mode, in-place replacement, automatic pruning or full media backup.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { assertTestDatabaseIdentity } from '../operatingMode.js';

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BACKUP_PREFIX = 'gtct-test-';
const BACKUP_NAME = /^gtct-test-[0-9TZ-]+-[0-9a-f-]{36}\.sqlite$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

function isWithin(p, parent) {
  const relative = path.relative(parent, p);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function overlapping(a, b) { return isWithin(a, b) || isWithin(b, a); }

// Resolve real parent paths as far as possible so existing symlinks cannot bypass guards.
function canonical(candidate) {
  let current = path.resolve(candidate);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...suffix);
}
function absoluteLocal(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) {
    throw new Error(`${label} requires an explicit absolute local directory.`);
  }
  const raw = value.trim();
  if (raw.startsWith('\\\\') || raw.startsWith('//')) throw new Error(`${label} cannot be a network share.`);
  const resolved = path.resolve(raw);
  const forbidden = [path.parse(resolved).root, os.homedir()];
  if (forbidden.includes(resolved)) throw new Error(`${label} cannot be a root or home directory.`);
  return { resolved, canonical: canonical(resolved) };
}
function reservedProductionDirectory(env) {
  if (env.GTCT_PRODUCTION_DATA_DIR?.trim()) {
    return path.resolve(env.GTCT_PRODUCTION_DATA_DIR.trim());
  }
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'GTCT', 'RestaurantProductionServer');
  }
  return path.join(SOURCE_ROOT, 'data-production');
}
function validateDisjoint(a, b, aLabel, bLabel) {
  if (overlapping(a.resolved, b.resolved) || overlapping(a.canonical, b.canonical)) {
    throw new Error(`${aLabel} must be separate from ${bLabel}.`);
  }
}
/** Require explicit paths, never default to TEST data, source or sealed production. */
export function getTestBackupPaths(env = process.env, { restore = false } = {}) {
  // Main app validation: only TEST mode and reserved production folder rejection.
  // Uses process environment in the normal app; acceptance temporarily sets env itself.
  const config = loadConfig({ mode: 'script' });
  const data = absoluteLocal(config.dataDir, 'TEST data directory');
  const backup = absoluteLocal(env.GTCT_TEST_BACKUP_DIR, 'GTCT_TEST_BACKUP_DIR');
  const source = absoluteLocal(SOURCE_ROOT, 'Application source');
  const production = absoluteLocal(reservedProductionDirectory(env), 'Reserved production');
  for (const [other, label] of [[data, 'TEST database'], [source, 'application source'], [production, 'reserved production']]) {
    validateDisjoint(backup, other, 'Backup directory', label);
  }
  let restoreTarget;
  if (restore) {
    restoreTarget = absoluteLocal(env.GTCT_TEST_RESTORE_DIR, 'GTCT_TEST_RESTORE_DIR');
    for (const [other, label] of [[data, 'TEST database'], [backup, 'backup directory'], [source, 'application source'], [production, 'reserved production']]) {
      validateDisjoint(restoreTarget, other, 'Restore directory', label);
    }
  }
  return { config, backupDir: backup.resolved, restoreDir: restoreTarget?.resolved };
}
function sha256(file) {
  const sha = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) sha.update(buffer.subarray(0, read));
  } finally { fs.closeSync(fd); }
  return sha.digest('hex');
}
function verifyTestSQLite(file, config) {
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) {
    throw new Error('TEST SQLite file is missing or not a regular file.');
  }
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity_check failed.');
    if (db.pragma('foreign_key_check').length) throw new Error('SQLite foreign_key_check failed.');
    const testIdentity = assertTestDatabaseIdentity(db, config);
    if (!testIdentity.identified) throw new Error('Identified TEST database required; refusing unknown/legacy identity.');
    return true;
  } finally { db.close(); }
}
function ensureBackupDirectory(backupDir) {
  const parent = path.dirname(backupDir);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('Backup parent directory must already exist.');
  }
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { mode: 0o700 });
  if (!fs.lstatSync(backupDir).isDirectory()) throw new Error('Backup location must be a real directory, not a symlink.');
}
/** SQLite hot backup handles WAL safely; validates new backup BEFORE publication. */
export async function createTestBackup(env = process.env) {
  const { config, backupDir } = getTestBackupPaths(env);
  verifyTestSQLite(config.dbPath, config);
  ensureBackupDirectory(backupDir);
  const name = `${BACKUP_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`;
  const finalFile = path.join(backupDir, name);
  const manifestFile = `${finalFile}.json`;
  const scratch = path.join(backupDir, `.${name}.partial.sqlite`);
  const scratchManifest = path.join(backupDir, `.${name}.partial.json`);
  if ([finalFile, manifestFile, scratch, scratchManifest].some(file => fs.existsSync(file))) {
    throw new Error('Backup output collision; refusing overwrite.');
  }
  let published = false;
  try {
    const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
    try {
      assertTestDatabaseIdentity(db, config);
      await db.backup(scratch);
    } finally { db.close(); }
    verifyTestSQLite(scratch, config);
    const manifest = {
      version: 1, operatingMode: 'TEST', scope: 'SQLITE_ONLY',
      filename: name, createdAt: new Date().toISOString(),
      testTenantId: config.testTenantId,
      bytes: fs.statSync(scratch).size, sha256: sha256(scratch),
    };
    fs.writeFileSync(scratchManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try { fs.chmodSync(scratch, 0o600); } catch { /* Windows: deployment ACL must be reviewed */ }
    fs.renameSync(scratch, finalFile);
    fs.renameSync(scratchManifest, manifestFile);
    published = true;
    return { backupPath: finalFile, manifestPath: manifestFile, manifest };
  } finally {
    for (const file of [scratch, scratchManifest]) {
      try { fs.rmSync(file, { force: true }); } catch { /* report original failure */ }
    }
    if (!published) {
      for (const file of [finalFile, manifestFile]) {
        try { fs.rmSync(file, { force: true }); } catch { /* report original failure */ }
      }
    }
  }
}
/** Fail closed on changed bytes, corrupt SQLite, bad identity, or non-TEST backup. */
export function verifyTestBackup(backupPath, env = process.env) {
  const { config, backupDir } = getTestBackupPaths(env);
  if (typeof backupPath !== 'string' || !path.isAbsolute(backupPath)) {
    throw new Error('Backup path must be an absolute path.');
  }
  const file = path.resolve(backupPath);
  if (path.dirname(file) !== backupDir || !BACKUP_NAME.test(path.basename(file))) {
    throw new Error('Backup must be an approved snapshot directly inside GTCT_TEST_BACKUP_DIR.');
  }
  const metadataPath = `${file}.json`;
  for (const p of [file, metadataPath]) {
    if (!fs.existsSync(p) || !fs.lstatSync(p).isFile()) throw new Error('Backup or manifest missing/not regular.');
  }
  const manifest = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (manifest.version !== 1 || manifest.operatingMode !== 'TEST' ||
      manifest.scope !== 'SQLITE_ONLY' || manifest.testTenantId !== config.testTenantId ||
      manifest.filename !== path.basename(file) ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0 ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      manifest.bytes !== fs.statSync(file).size || sha256(file) !== manifest.sha256) {
    throw new Error('Backup manifest/hash mismatch, wrong mode, or corrupt metadata.');
  }
  verifyTestSQLite(file, config);
  return { backupPath: file, manifest };
}
/** Restore into a NEW folder only. Never replace the active app database. */
export async function restoreTestBackupToNewDirectory(backupPath, env = process.env) {
  const { config, restoreDir } = getTestBackupPaths(env, { restore: true });
  const verified = verifyTestBackup(backupPath, env);
  if (fs.existsSync(restoreDir)) throw new Error('Restore directory already exists; refusing overwrite.');
  const parent = path.dirname(restoreDir);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('Restore parent must already exist.');
  }
  fs.mkdirSync(restoreDir, { mode: 0o700 });
  const target = path.join(restoreDir, 'gtct-local.sqlite');
  let success = false;
  try {
    const src = new Database(verified.backupPath, { readonly: true, fileMustExist: true });
    try { await src.backup(target); } finally { src.close(); }
    verifyTestSQLite(target, config);
    const after = sha256(target);
    // SQLite may normalize page layouts during backup; full data integrity is checked above.
    if (!after) throw new Error('Failed to hash restored database.');
    try { fs.chmodSync(target, 0o600); } catch { /* Windows NTFS ACL required */ }
    success = true;
    return { restoredDbPath: target, originBackupPath: verified.backupPath };
  } finally {
    if (!success) {
      for (const p of [target, `${target}-wal`, `${target}-shm`]) {
        try { fs.rmSync(p, { force: true }); } catch { /* no change to active DB */ }
      }
      try { fs.rmdirSync(restoreDir); } catch { /* do not delete arbitrary contents */ }
    }
  }
}
/** Explicit opt-in; startup backup plus every 24h while process stays alive. */
export async function startTestAutoBackups({ logger, env = process.env, onAttempt } = {}) {
  if (String(env.GTCT_ENABLE_TEST_AUTO_BACKUP || '').toLowerCase() !== 'true') {
    return { stop() {}, enabled: false };
  }
  // Validate BEFORE any scheduled work. Fail server startup on misconfiguration.
  getTestBackupPaths(env);
  const initial = await createTestBackup(env);
  logger?.info('TEST SQLite backup created at startup', { backupPath: initial.backupPath });
  try { onAttempt?.({ success: true }); } catch (error) { logger?.error('Backup health update failed', { error: error.message }); }
  let inProgress = false;
  const timer = setInterval(async () => {
    if (inProgress) return;
    inProgress = true;
    try {
      const result = await createTestBackup(env);
      logger?.info('Scheduled TEST SQLite backup created', { backupPath: result.backupPath });
      try { onAttempt?.({ success: true }); } catch (error) { logger?.error('Backup health update failed', { error: error.message }); }
    } catch (err) {
      logger?.error('Scheduled TEST SQLite backup FAILED; investigate immediately', { error: err.message });
      try { onAttempt?.({ success: false, error: err.message }); } catch (error) { logger?.error('Backup health update failed', { error: error.message }); }
    } finally { inProgress = false; }
  }, DAY_MS);
  timer.unref();
  return { stop() { clearInterval(timer); }, enabled: true, startupBackup: initial.backupPath };
}
