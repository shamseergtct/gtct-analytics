/** Phase P2-A2 integration suite. ONLY temporary SQLite databases are created. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from '../config.js';
import { assertTestDatabaseIdentity } from '../operatingMode.js';
import {
  SEALED_DB_FILE, prepareSealedProductionVault, getSealedPathOptions,
  verifySealedVault, backupSealedProductionVault,
} from '../production/sealedVault.js';

const names = ['GTCT_PRODUCTION_DATA_DIR', 'GTCT_PRODUCTION_BACKUP_DIR', 'GTCT_LOCAL_DATA_DIR', 'GTCT_OPERATING_MODE'];
const original = Object.fromEntries(names.map(k => [k, process.env[k]]));
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'gtct-vault-'));
let passed = 0;
const pass = (label) => { console.log(`PASS ${label}`); passed++; };


try {
  process.env.GTCT_LOCAL_DATA_DIR = path.join(parent, 'test-data');
  process.env.GTCT_PRODUCTION_DATA_DIR = path.join(parent, 'sealed-prod');
  process.env.GTCT_PRODUCTION_BACKUP_DIR = path.join(parent, 'sealed-backups');
  delete process.env.GTCT_OPERATING_MODE;

  assert.throws(() => prepareSealedProductionVault({}), /explicit absolute local path/);
  pass('requires an explicit production path');

  assert.throws(() => prepareSealedProductionVault({ GTCT_PRODUCTION_DATA_DIR: process.env.GTCT_LOCAL_DATA_DIR }), /separate from TEST/);
  assert.throws(() => prepareSealedProductionVault({ GTCT_PRODUCTION_DATA_DIR: path.join(process.cwd(), 'data-prod') }), /separate from TEST data and application source/);
  pass('rejects TEST and source path overlaps');

  const initial = prepareSealedProductionVault();
  assert.equal(path.basename(initial.dbPath), SEALED_DB_FILE);
  assert.equal(initial.identity.operatingMode, 'PRODUCTION');
  assert.equal(initial.identity.state, 'SEALED');
  pass('new empty SEALED production vault created');

  const db = new Database(initial.dbPath, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(x => x.name), ['meta']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta').get().n, 1);
    assert.throws(() => assertTestDatabaseIdentity(db, loadConfig({ mode: 'script' })), /identity does not match/);
  } finally { db.close(); }
  pass('no real orders or payment schema; TEST identity rejects vault');

  process.env.GTCT_LOCAL_DATA_DIR = path.join(parent, 'sealed-prod');
  assert.throws(() => loadConfig({ mode: 'script' }), /reserved production data directory/);
  process.env.GTCT_LOCAL_DATA_DIR = path.join(parent, 'test-data');
  process.env.GTCT_OPERATING_MODE = 'PRODUCTION';
  assert.throws(() => loadConfig({ mode: 'http' }), /Only TEST operating mode/);
  assert.throws(() => loadConfig({ mode: 'script' }), /Only TEST operating mode/);
  delete process.env.GTCT_OPERATING_MODE;
  pass('regular server and migration remain TEST-only');

  assert.throws(() => prepareSealedProductionVault(), /already exists/);
  assert.equal(verifySealedVault(initial.dbPath).installationId, initial.identity.installationId);
  pass('second initialization refuses overwrite');

  const result = await backupSealedProductionVault();
  assert.ok(fs.existsSync(result.backupPath));
  assert.equal(verifySealedVault(result.backupPath).installationId, initial.identity.installationId);
  pass('SQLite-safe backup verified without changing source');

  const second = await backupSealedProductionVault();
  assert.notEqual(result.backupPath, second.backupPath);
  pass('backups create unique paths without overwrite');

  process.env.GTCT_PRODUCTION_BACKUP_DIR = path.join(parent, 'sealed-prod', 'copies');
  assert.throws(() => getSealedPathOptions(process.env, true), /Backup directory must be separate/);
  process.env.GTCT_PRODUCTION_BACKUP_DIR = path.join(parent, 'sealed-backups');
  pass('backup path inside production data rejected');

  const evil = new Database(result.backupPath);
  try { evil.exec('CREATE TABLE orders (order_id TEXT)'); } finally { evil.close(); }
  assert.throws(() => verifySealedVault(result.backupPath), /unexpected schema/);
  pass('vault with unexpected operational table rejected');

  assert.ok(!fs.existsSync(path.join(parent, 'test-data', SEALED_DB_FILE)));
  pass('TEST database was not touched');
} finally {
  for (const key of names) {
    if (original[key] == null) delete process.env[key]; else process.env[key] = original[key];
  }
  fs.rmSync(parent, { recursive: true, force: true });
}
console.log(`Sealed production vault: ${passed} passed (temporary SQLite only, real sales disabled)`);
