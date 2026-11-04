/** P2-C3: TEST-only backup monitoring + explicitly reviewed retention.
 * Never touches the active SQLite, production vault or Windows pilot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getTestBackupPaths, verifyTestBackup } from './testBackup.js';

const BACKUP_NAME = /^gtct-test-[0-9TZ-]+-[0-9a-f-]{36}\.sqlite$/i;
const HEALTH_FILE = 'gtct-test-backup-health.json';
const DAY_MS = 86_400_000;
const MAX_AGE_HOURS = 26;

function isSafeDir(dir) {
  return fs.existsSync(dir) && fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink();
}
function listSnapshotNames(dir) {
  if (!isSafeDir(dir)) return [];
  return fs.readdirSync(dir).filter(name => BACKUP_NAME.test(name)).sort().reverse();
}
function readHealthFile(dir) {
  const file = path.join(dir, HEALTH_FILE);
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return null;
  try {
    const status = JSON.parse(fs.readFileSync(file, 'utf8'));
    return status.version === 1 && ['SUCCESS', 'FAILURE'].includes(status.lastResult) ? status : null;
  } catch { return null; }
}
/** Persistent last attempt, survives server restart. Failures are NOT reported as successes. */
export function recordTestBackupAttempt({ success, error = '' }, env = process.env) {
  const { backupDir } = getTestBackupPaths(env);
  if (!isSafeDir(backupDir)) throw new Error('Backup health folder is not a real directory.');
  const previous = readHealthFile(backupDir);
  const now = new Date().toISOString();
  const status = {
    version: 1,
    lastResult: success ? 'SUCCESS' : 'FAILURE',
    lastAttemptAt: now,
    lastSuccessAt: success ? now : previous?.lastSuccessAt || null,
    lastFailureAt: success ? previous?.lastFailureAt || null : now,
    // Avoid stack traces and paths in public status; operator logs contain details.
    lastError: success ? '' : String(error || 'Backup failed').slice(0, 200),
  };
  const tmp = path.join(backupDir, `.${HEALTH_FILE}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, path.join(backupDir, HEALTH_FILE));
  } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* keep original failure */ } }
  return status;
}

/** Admin-only status payload: NO absolute local paths, secrets or DB records. */
export function getTestBackupHealth(env = process.env, { now = Date.now() } = {}) {
  const autoEnabled = String(env.GTCT_ENABLE_TEST_AUTO_BACKUP || '').toLowerCase() === 'true';
  if (!env.GTCT_TEST_BACKUP_DIR?.trim()) {
    return { state: autoEnabled ? 'CONFIG_ERROR' : 'DISABLED', autoEnabled, snapshotCount: 0,
      message: autoEnabled ? 'Backup location not configured.' : 'Automatic TEST backups are disabled.' };
  }
  let backupDir;
  try { ({ backupDir } = getTestBackupPaths(env)); }
  catch { return { state: 'CONFIG_ERROR', autoEnabled, snapshotCount: 0, message: 'Backup path configuration invalid.' }; }
  if (!isSafeDir(backupDir)) {
    return { state: autoEnabled ? 'ERROR' : 'DISABLED', autoEnabled, snapshotCount: 0,
      message: 'Backup folder missing or not a regular directory.' };
  }
  const snapshots = listSnapshotNames(backupDir);
  const health = readHealthFile(backupDir);
  let latest = null;
  // Inspect newest snapshots; a corrupt newest file must not appear healthy.
  let invalidNewest = false;
  for (const [index, name] of snapshots.slice(0, 16).entries()) {
    try {
      const verified = verifyTestBackup(path.join(backupDir, name), env);
      const timestamp = Date.parse(verified.manifest.createdAt);
      if (Number.isFinite(timestamp) && timestamp <= now + DAY_MS && timestamp > 0) {
        latest = { filename: name, createdAt: verified.manifest.createdAt, ageHours: Math.max(0, Math.round((now - timestamp) / 3_600_000)) };
        break;
      }
      if (index === 0) invalidNewest = true;
    } catch { if (index === 0) invalidNewest = true; }
  }
  let state = 'OK';
  let message = 'Latest TEST backup verified.';
  if (!autoEnabled) { state = 'DISABLED'; message = 'Automatic TEST backups are off.'; }
  else if (health?.lastResult === 'FAILURE') { state = 'ERROR'; message = 'Last scheduled TEST backup failed; inspect server logs.'; }
  else if (!latest) { state = 'ERROR'; message = 'No verifiable recent TEST backup found.'; }
  else if (invalidNewest) { state = 'ERROR'; message = 'Newest backup failed verification.'; }
  else if (latest.ageHours > MAX_AGE_HOURS) { state = 'STALE'; message = 'Last verified backup is older than 26 hours.'; }
  return { state, autoEnabled, snapshotCount: snapshots.length, latestBackup: latest,
    lastAttemptAt: health?.lastAttemptAt || null, lastSuccessAt: health?.lastSuccessAt || null,
    lastFailureAt: health?.lastFailureAt || null, message };
}

function ensureWholeNumber(value, label, min, max) {
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < min || num > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return num;
}
/** Reviewable retention PLAN. No deletion occurs here. */
export function planTestBackupRetention(env = process.env, options = {}) {
  const { backupDir } = getTestBackupPaths(env);
  if (!isSafeDir(backupDir)) throw new Error('A real existing TEST backup directory is required.');
  const days = ensureWholeNumber(options.days ?? env.GTCT_TEST_RETENTION_DAYS ?? 30, 'Retention days', 7, 3650);
  const keep = ensureWholeNumber(options.keep ?? env.GTCT_TEST_RETENTION_KEEP ?? 7, 'Protected newest snapshots', 7, 10000);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || now <= 0) throw new Error('Invalid retention clock.');
  const names = listSnapshotNames(backupDir);
  const eligible = [];
  const skipped = [];
  let verifiedProtected = 0;
  for (const name of names) {
    const file = path.join(backupDir, name);
    let verified;
    try { verified = verifyTestBackup(file, env); }
    catch { skipped.push(name); continue; } // never delete corrupt/unknown/unverifiable files
    const created = Date.parse(verified.manifest.createdAt);
    if (!Number.isFinite(created) || created <= 0 || created > now) { skipped.push(name); continue; }
    // Keep at least 7 VERIFIED snapshots, not merely 7 filenames.
    if (verifiedProtected < keep) { verifiedProtected++; continue; }
    if (now - created < days * DAY_MS) continue;
    eligible.push({ name, sha256: verified.manifest.sha256, bytes: verified.manifest.bytes });
  }
  const planId = createHash('sha256').update(JSON.stringify({ backupDir, days, keep, eligible })).digest('hex').slice(0, 20);
  return { days, keep, snapshotCount: names.length, eligible, skipped, planId, deletionPerformed: false };
}
/** Destructive by design but only with two independent, explicit confirmations. */
export function applyTestBackupRetention(env = process.env, options = {}) {
  if (env.GTCT_TEST_RETENTION_CONFIRM !== 'DELETE_REVIEWED_TEST_BACKUPS') {
    throw new Error('Explicit GTCT_TEST_RETENTION_CONFIRM required. No files deleted.');
  }
  const plan = planTestBackupRetention(env, options);
  if (env.GTCT_TEST_RETENTION_PLAN_ID !== plan.planId) {
    throw new Error('Retention plan changed or plan ID missing. Run preview again. No files deleted.');
  }
  const { backupDir } = getTestBackupPaths(env);
  let deleted = 0;
  for (const item of plan.eligible) {
    const file = path.join(backupDir, item.name);
    // Re-verify before deletion; preserve any changed/corrupt files.
    const current = verifyTestBackup(file, env);
    if (current.manifest.sha256 !== item.sha256 || current.manifest.bytes !== item.bytes) {
      throw new Error('Backup changed during retention. Stopped without deleting this backup.');
    }
    // Neither the live DB nor any backup outside the explicitly configured folder is touched.
    fs.unlinkSync(file);
    fs.unlinkSync(`${file}.json`);
    deleted++;
  }
  return { ...plan, deleted, deletionPerformed: true };
}
