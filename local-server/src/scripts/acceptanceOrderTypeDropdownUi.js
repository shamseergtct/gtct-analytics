// P2-E1.8 TEST-only UI contract. Source checks; does not start a server or open SQLite.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../');
const html = readFileSync(resolve(root, 'public/index.html'), 'utf8');
const css = readFileSync(resolve(root, 'public/styles.css'), 'utf8');
const js = readFileSync(resolve(root, 'public/app.js'), 'utf8');
const cases = [
  ['one native select', () => assert.equal((html.match(/id="order-type"/g) || []).length, 1)],
  ['single accessible label', () => assert.match(html, /<label for="order-type">Order type<\/label>/)],
  ['quick button grid removed', () => assert.doesNotMatch(html, /id="order-type-quick"/)],
  ['desktop and mobile select visible', () => assert.match(css, /\.order-meta\.compact-meta \.order-type-field > select\s*\{[^}]*display:\s*block/s)],
  ['native dropdown is styled', () => assert.match(css, /-webkit-appearance:\s*none/)],
  ['touch target sized for mobile', () => assert.match(css, /@media \(max-width: 1023px\)[\s\S]*?\.order-type-field > select\s*\{[^}]*min-height:\s*52px/s)],
  ['dropdown focus treatment', () => assert.match(css, /\.order-type-field > select:focus-visible/)],
  ['single column on mobile', () => assert.match(css, /@media \(max-width: 1023px\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/s)],
  ['draft remains visible', () => assert.match(html, /id="order-number"[^>]*readonly/)],
  ['options remain shop-configured', () => assert.match(js, /const types = state\.orderTypes \|\| \[\];/)],
  ['select remains change-handler authority', () => assert.match(js, /\$\("order-type"\)\?\.addEventListener\("change",\s*\(\) => \{\s*renderFulfillmentFields\(\);\s*renderCart\(\);\s*persistActiveCart\(\);/)],
  ['delivery/order settings logic unchanged', () => assert.match(js, /const delivery = type\.behavior === "DELIVERY";/)],
];
for (const [name, fn] of cases) {
  fn();
  console.log(`PASS ${name}`);
}
console.log(`Order type dropdown UI ${cases.length} passed (source UI contract only; no SQLite or financial changes)`);
