/** P2-C3.1: dependency-free, read-only tests of the actual Admin banner renderer.
 * Uses no SQLite, no live server, no database or backup file operations.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';

const publicRoot = new URL('../../public/', import.meta.url);
const html = fs.readFileSync(new URL('users.html', publicRoot), 'utf8');
const script = fs.readFileSync(new URL('users.js', publicRoot), 'utf8');
const css = fs.readFileSync(new URL('backup-health.css', publicRoot), 'utf8');
const begin = script.indexOf('async function loadBackupHealth() {');
const end = script.indexOf('\nasync function loadStaffSetup()', begin);
assert.ok(begin >= 0 && end > begin, 'Could not locate the unchanged backup health loader boundary');
const renderer = script.slice(begin, end).trim();

let checks = 0;
const pass = name => { checks++; console.log(`PASS ${name}`); };

assert.match(html, /href="\/backup-health\.css"/);
assert.match(html, /id="backup-health-box"[^>]*class="settings-banner backup-health"[^>]*data-health-tone="neutral"/);
pass('backup-banner-loads-isolated-stylesheet');

for (const tone of ['ok', 'warning', 'error']) {
  assert.ok(css.includes(`[data-health-tone="${tone}"]`), `Missing ${tone} styling`);
}
assert.match(css, /#backup-health-box\.backup-health\s*\{/);
assert.doesNotMatch(css, /(^|\n)\.settings-banner\s*\{/);
pass('colors-scoped-to-backup-banner-only');

async function check({ response, throws, allowed = true, expectedTone, expectedText, hidden = false }) {
  const box = { hidden: true, dataset: { healthTone: 'previous-status' } };
  const label = { textContent: '' };
  let calls = 0;
  const elements = { 'backup-health-box': box, 'backup-health-message': label };
  const context = {
    $: id => elements[id],
    canManage: () => allowed,
    api: async path => {
      calls++;
      assert.equal(path, '/v1/admin/backup-health');
      if (throws) throw Error('network down');
      return response;
    },
    Date,
  };
  const load = runInNewContext(`(${renderer})`, context);
  await load();
  assert.equal(box.hidden, hidden);
  if (!hidden) {
    assert.equal(box.dataset.healthTone, expectedTone);
    assert.ok(label.textContent.includes(expectedText), `Expected '${expectedText}' in '${label.textContent}'`);
  }
  assert.equal(calls, allowed ? 1 : 0);
}

await check({ response: { ok: true, json: { state: 'OK', message: 'Latest TEST backup verified.', latestBackup: { createdAt: '2026-10-25T20:31:44.727Z' } } }, expectedTone: 'ok', expectedText: 'Last verified:' });
pass('verified-backup-green');

await check({ response: { ok: true, json: { state: 'STALE', message: 'Older than 26 hours.' } }, expectedTone: 'warning', expectedText: 'STALE' });
pass('stale-backup-amber');

await check({ response: { ok: true, json: { state: 'ERROR', message: 'Newest backup corrupt.' } }, expectedTone: 'error', expectedText: 'corrupt' });
pass('corrupt-or-failed-backup-red');

await check({ response: { ok: true, json: { state: 'CONFIG_ERROR', message: 'Path missing.' } }, expectedTone: 'error', expectedText: 'CONFIG_ERROR' });
pass('misconfigured-backup-red');

await check({ response: { ok: true, json: { state: 'DISABLED', message: 'Automatic TEST backups are off.' } }, expectedTone: 'neutral', expectedText: 'DISABLED' });
pass('disabled-backup-neutral');

await check({ response: { ok: true, json: { state: 'UNRECOGNIZED' } }, expectedTone: 'error', expectedText: 'Status unavailable.' });
pass('unknown-state-fails-closed');

await check({ response: { ok: false, status: 500 }, expectedTone: 'error', expectedText: 'Status unavailable' });
pass('http-error-shown-in-red');

await check({ throws: true, expectedTone: 'error', expectedText: 'Status unavailable' });
pass('network-error-shown-in-red');

await check({ allowed: false, hidden: true });
pass('non-admin-cannot-fetch-backup-health');

assert.match(css, /#backup-health-box\.backup-health\[hidden\]/);
pass('hidden-banner-stays-hidden');

console.log(`Backup health UI ${checks} passed (no database writes, real sales disabled)`);
