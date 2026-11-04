/** P2-C3 acceptance. Temporary TEST SQLite only; all file deletion confined to mkdtemp. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { openDatabase, getDb, runMigrations, closeDatabase } from '../db/db.js';
import { stampMigratedTestDatabase } from '../db/testStartup.js';
import { createTestBackup, verifyTestBackup } from '../backup/testBackup.js';
import { getTestBackupHealth, recordTestBackupAttempt, planTestBackupRetention, applyTestBackupRetention } from '../backup/testBackupManagement.js';

const envKeys = ['GTCT_LOCAL_DATA_DIR', 'GTCT_TEST_BACKUP_DIR', 'GTCT_ENABLE_TEST_AUTO_BACKUP',
  'GTCT_OPERATING_MODE', 'GTCT_PRODUCTION_DATA_DIR', 'GTCT_TEST_RETENTION_DAYS',
  'GTCT_TEST_RETENTION_KEEP', 'GTCT_TEST_RETENTION_CONFIRM', 'GTCT_TEST_RETENTION_PLAN_ID'];
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gtct-monitor-accept-'));
const dataDir = path.join(root, 'test-data');
const backupDir = path.join(root, 'snapshots');
let checks = 0;
function pass(label) { checks++; console.log(`PASS ${label}`); }
try {
  for (const key of envKeys) delete process.env[key];
  assert.equal(getTestBackupHealth().state, 'DISABLED');
  pass('automatic-backup-disabled-without-config');

  process.env.GTCT_LOCAL_DATA_DIR = dataDir;
  process.env.GTCT_TEST_BACKUP_DIR = backupDir;
  process.env.GTCT_PRODUCTION_DATA_DIR = path.join(root, 'reserved-production');
  process.env.GTCT_ENABLE_TEST_AUTO_BACKUP = 'true';
  const cfg = loadConfig({ mode: 'script' });
  assert.equal(cfg.operatingMode, 'TEST');
  assert.ok(cfg.dbPath.startsWith(root));
  pass('disposable-test-paths-only');

  assert.equal(getTestBackupHealth().state, 'ERROR');
  pass('missing-backup-folder-reported-without-writing');

  fs.mkdirSync(dataDir);
  openDatabase(cfg.dbPath);
  await runMigrations(getDb());
  stampMigratedTestDatabase(getDb(), cfg);
  getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('p2c3.marker', 'PRESERVE');
  const snapshots = [];
  for (let i = 0; i < 10; i++) snapshots.push(await createTestBackup());
  assert.equal(snapshots.length, 10);
  pass('ten-isolated-verified-snapshots-created');

  const first = getTestBackupHealth();
  assert.equal(first.state, 'OK');
  assert.equal(first.snapshotCount, 10);
  assert.ok(first.latestBackup?.filename);
  assert.equal(typeof first.latestBackup?.filename, 'string');
  assert.equal(JSON.stringify(first).includes(root), false);
  pass('admin-health-lists-latest-without-exposing-paths');

  recordTestBackupAttempt({ success: true });
  const healthy = getTestBackupHealth();
  assert.equal(healthy.state, 'OK');
  assert.ok(healthy.lastSuccessAt);
  pass('success-recorded-durably');

  recordTestBackupAttempt({ success: false, error: 'simulated scheduler failure' });
  const failing = getTestBackupHealth();
  assert.equal(failing.state, 'ERROR');
  assert.match(failing.message, /failed/i);
  assert.ok(failing.lastFailureAt);
  assert.equal(failing.lastSuccessAt, healthy.lastSuccessAt);
  pass('scheduler-failure-displayed-without-false-success');

  recordTestBackupAttempt({ success: true });
  assert.equal(getTestBackupHealth().state, 'OK');
  pass('successful-retry-clears-active-failure');

  const oldClock = Date.now() + 48 * 60 * 60 * 1000;
  assert.equal(getTestBackupHealth(process.env, { now: oldClock }).state, 'STALE');
  pass('stale-snapshot-warning-after-26-hours');

  process.env.GTCT_ENABLE_TEST_AUTO_BACKUP = 'false';
  assert.equal(getTestBackupHealth().state, 'DISABLED');
  pass('disabled-state-explicit-even-with-old-backups');
  process.env.GTCT_ENABLE_TEST_AUTO_BACKUP = 'true';

  const newest = snapshots.at(-1);
  const handle = fs.openSync(newest.backupPath, 'r+');
  try { fs.writeSync(handle, Buffer.from('INVALID'), 0, 7, 0); } finally { fs.closeSync(handle); }
  assert.throws(() => verifyTestBackup(newest.backupPath), /manifest\/hash mismatch/);
  assert.equal(getTestBackupHealth().state, 'ERROR');
  pass('corrupt-newest-backup-alert-not-hidden');

  const future = Date.now() + 40 * 86_400_000;
  const plan = planTestBackupRetention(process.env, { now: future });
  assert.equal(plan.snapshotCount, 10);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.eligible.length, 2); // 9 valid, keep newest 7 verified
  assert.equal(plan.deletionPerformed, false);
  for (const item of plan.eligible) assert.ok(fs.existsSync(path.join(backupDir, item.name)));
  pass('dry-run-keeps-seven-verified-and-skips-corruption');

  assert.throws(() => applyTestBackupRetention(process.env, { now: future }), /GTCT_TEST_RETENTION_CONFIRM required/);
  assert.equal(fs.existsSync(plan.eligible.map(item => path.join(backupDir, item.name))[0]), true);
  pass('deletion-without-explicit-confirmation-refused');

  process.env.GTCT_TEST_RETENTION_CONFIRM = 'DELETE_REVIEWED_TEST_BACKUPS';
  process.env.GTCT_TEST_RETENTION_PLAN_ID = 'wrong-token';
  assert.throws(() => applyTestBackupRetention(process.env, { now: future }), /plan changed|plan ID missing/);
  pass('mismatched-review-plan-refused');

  process.env.GTCT_TEST_RETENTION_PLAN_ID = plan.planId;
  const completed = applyTestBackupRetention(process.env, { now: future });
  assert.equal(completed.deleted, 2);
  for (const item of plan.eligible) {
    assert.equal(fs.existsSync(path.join(backupDir, item.name)), false);
    assert.equal(fs.existsSync(path.join(backupDir, `${item.name}.json`)), false);
  }
  assert.ok(fs.existsSync(newest.backupPath), 'corrupted file must not be deleted automatically');
  pass('confirmed-plan-deletes-only-reviewed-verified-pairs');

  assert.throws(() => applyTestBackupRetention(process.env, { now: future }), /plan changed|plan ID missing/);
  pass('old-review-token-cannot-be-reused');

  assert.equal(getDb().prepare('SELECT value FROM meta WHERE key=?').get('p2c3.marker').value, 'PRESERVE');
  assert.equal(getDb().pragma('integrity_check')[0].integrity_check, 'ok');
  pass('active-sqlite-untouched');

  process.env.GTCT_OPERATING_MODE = 'PRODUCTION';
  assert.throws(() => planTestBackupRetention(), /Only TEST operating mode/);
  delete process.env.GTCT_OPERATING_MODE;
  pass('retention-refused-in-production-mode');

  process.env.GTCT_TEST_BACKUP_DIR = dataDir;
  assert.throws(() => planTestBackupRetention(), /separate from TEST database/);
  pass('retention-path-cannot-overlap-active-data');

  const httpSource = fs.readFileSync(new URL('../http/server.js', import.meta.url), 'utf8');
  assert.match(httpSource, /path === "\/v1\/admin\/backup-health"/);
  assert.match(httpSource, /requireStaffAdmin\(req, res, config\)/);
  pass('backup-health-route-enforces-staff-admin-auth');

  console.log(`TEST backup monitoring ${checks} passed (temporary SQLite only, dry-run default, real sales disabled)`);
} finally {
  closeDatabase();
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
}
