/**
 * P2-C1 acceptance: temporary TEST SQLite only. No application listener,
 * no real profiles/databases and no destructive in-place restoration.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { openDatabase, getDb, runMigrations, closeDatabase } from '../db/db.js';
import { stampMigratedTestDatabase } from '../db/testStartup.js';
import { createTestBackup, verifyTestBackup, restoreTestBackupToNewDirectory, startTestAutoBackups } from '../backup/testBackup.js';

const keys = ['GTCT_LOCAL_DATA_DIR','GTCT_TEST_BACKUP_DIR','GTCT_TEST_RESTORE_DIR','GTCT_TEST_BACKUP_FILE',
  'GTCT_ENABLE_TEST_AUTO_BACKUP','GTCT_OPERATING_MODE','GTCT_PRODUCTION_DATA_DIR'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtct-backup-accept-'));
const source = path.join(root, 'test-data');
const backups = path.join(root, 'snapshots');
const restore = path.join(root, 'restored-test');
const production = path.join(root, 'reserved-production');
let count = 0;
function pass(label) { count++; console.log(`PASS ${label}`); }
const sha = async file => (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
  for (const key of keys) delete process.env[key];
  process.env.GTCT_LOCAL_DATA_DIR = source;
  process.env.GTCT_PRODUCTION_DATA_DIR = production;
  process.env.GTCT_TEST_BACKUP_DIR = backups;
  const cfg = loadConfig({ mode: 'script' });
  assert.equal(cfg.operatingMode, 'TEST');
  assert.ok(cfg.dbPath.startsWith(root));
  pass('disposable-test-paths-only');

  await assert.rejects(createTestBackup(), /missing|regular|SQLITE/i);
  assert.equal(fs.existsSync(backups), false);
  pass('uninitialized-database-refused-without-creating-backups');

  fs.mkdirSync(source);
  openDatabase(cfg.dbPath);
  await runMigrations(getDb());
  stampMigratedTestDatabase(getDb(), cfg);
  getDb().prepare('INSERT INTO meta (key,value) VALUES (?, ?)').run('p2c1.acceptance.marker', 'ORIGINAL');
  const first = await createTestBackup();
  assert.ok(fs.existsSync(first.backupPath) && fs.existsSync(first.manifestPath));
  assert.equal(verifyTestBackup(first.backupPath).manifest.scope, 'SQLITE_ONLY');
  pass('wal-safe-live-sqlite-backup-and-integrity-check');

  const firstBytes = await sha(first.backupPath);
  const second = await createTestBackup();
  assert.notEqual(first.backupPath, second.backupPath);
  assert.equal(await sha(first.backupPath), firstBytes);
  pass('uniquely-named-backups-no-overwrite');

  getDb().prepare('UPDATE meta SET value=? WHERE key=?').run('LATEST', 'p2c1.acceptance.marker');
  const third = await createTestBackup();
  const priorDb = new Database(first.backupPath, { readonly: true });
  const laterDb = new Database(third.backupPath, { readonly: true });
  try {
    assert.equal(priorDb.prepare('SELECT value FROM meta WHERE key=?').get('p2c1.acceptance.marker').value, 'ORIGINAL');
    assert.equal(laterDb.prepare('SELECT value FROM meta WHERE key=?').get('p2c1.acceptance.marker').value, 'LATEST');
  } finally { priorDb.close(); laterDb.close(); }
  pass('consistent-backup-snapshot-not-live-copy');

  process.env.GTCT_TEST_RESTORE_DIR = restore;
  const restored = await restoreTestBackupToNewDirectory(first.backupPath);
  const recovered = new Database(restored.restoredDbPath, { readonly: true });
  try { assert.equal(recovered.prepare('SELECT value FROM meta WHERE key=?').get('p2c1.acceptance.marker').value, 'ORIGINAL'); }
  finally { recovered.close(); }
  assert.equal(getDb().prepare('SELECT value FROM meta WHERE key=?').get('p2c1.acceptance.marker').value, 'LATEST');
  pass('restore-new-folder-preserves-source-and-historical-snapshot');

  const restoredHash = await sha(restored.restoredDbPath);
  await assert.rejects(restoreTestBackupToNewDirectory(first.backupPath), /already exists/);
  assert.equal(await sha(restored.restoredDbPath), restoredHash);
  pass('existing-restore-location-refused');

  process.env.GTCT_TEST_RESTORE_DIR = source;
  await assert.rejects(restoreTestBackupToNewDirectory(first.backupPath), /separate from TEST database/);
  process.env.GTCT_TEST_RESTORE_DIR = path.join(backups, 'nested');
  await assert.rejects(restoreTestBackupToNewDirectory(first.backupPath), /separate from backup directory/);
  process.env.GTCT_TEST_RESTORE_DIR = production;
  await assert.rejects(restoreTestBackupToNewDirectory(first.backupPath), /separate from reserved production/);
  process.env.GTCT_TEST_RESTORE_DIR = restore;
  pass('restore-refuses-active-backup-and-production-destinations');

  process.env.GTCT_TEST_BACKUP_DIR = source;
  await assert.rejects(createTestBackup(), /separate from TEST database/);
  process.env.GTCT_TEST_BACKUP_DIR = production;
  await assert.rejects(createTestBackup(), /separate from reserved production/);
  process.env.GTCT_TEST_BACKUP_DIR = backups;
  pass('backup-location-must-be-isolated');

  const fakeManifest = JSON.parse(fs.readFileSync(first.manifestPath, 'utf8'));
  fs.writeFileSync(first.manifestPath, JSON.stringify({ ...fakeManifest, operatingMode: 'PRODUCTION' }));
  assert.throws(() => verifyTestBackup(first.backupPath), /manifest\/hash mismatch/);
  fs.writeFileSync(first.manifestPath, JSON.stringify(fakeManifest));
  pass('production-or-invalid-manifest-rejected');

  const firstFd = fs.openSync(first.backupPath, 'r+');
  try { fs.writeSync(firstFd, Buffer.from('CORRUPT'), 0, 7, 0); }
  finally { fs.closeSync(firstFd); }
  assert.throws(() => verifyTestBackup(first.backupPath), /manifest\/hash mismatch/);
  pass('changed-database-bytes-rejected');

  process.env.GTCT_OPERATING_MODE = 'PRODUCTION';
  await assert.rejects(createTestBackup(), /Only TEST operating mode/);
  delete process.env.GTCT_OPERATING_MODE;
  pass('production-mode-never-backed-up-by-test-cli');

  let scheduledLogs = 0;
  const disabled = await startTestAutoBackups({ logger: { info() { scheduledLogs++; } } });
  assert.equal(disabled.enabled, false);
  disabled.stop();
  assert.equal(scheduledLogs, 0);
  pass('automatic-backup-off-by-default');

  process.env.GTCT_ENABLE_TEST_AUTO_BACKUP = 'true';
  const running = await startTestAutoBackups({ logger: { info() { scheduledLogs++; } } });
  assert.equal(running.enabled, true);
  assert.ok(verifyTestBackup(running.startupBackup));
  running.stop();
  assert.equal(scheduledLogs, 1);
  pass('explicit-opt-in-creates-verified-startup-backup');

  // Simulate a restart without touching or replacing any business records.
  closeDatabase();
  const check = new Database(cfg.dbPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(check.prepare('SELECT value FROM meta WHERE key=?').get('p2c1.acceptance.marker').value, 'LATEST');
    assert.equal(check.pragma('integrity_check')[0].integrity_check, 'ok');
  } finally { check.close(); }
  pass('restart-preserves-live-test-data');

  console.log(`TEST backup recovery ${count} passed (temporary SQLite only, no in-place restore, real sales disabled)`);
} finally {
  closeDatabase();
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
}
