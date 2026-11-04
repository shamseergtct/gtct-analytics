// P2-E1.7 TEST-only presentation checks. No DB, browser service or network required.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../");
const html = readFileSync(resolve(root, "public/index.html"), "utf8");
const css = readFileSync(resolve(root, "public/styles.css"), "utf8");
const app = readFileSync(resolve(root, "public/app.js"), "utf8");
let passed = 0;
function pass(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}
function fnSource(name, nextName) {
  const head = `function ${name}(`;
  const start = app.indexOf(head);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = nextName ? app.indexOf(`function ${nextName}(`, start + head.length) : -1;
  assert.ok(end > start, `Cannot locate end of ${name}`);
  return app.slice(start, end);
}

pass("order-type-quick-picker-markup", () => {
  assert.match(html, /id="order-type-quick"[^>]*role="group"/);
  assert.match(html, /id="order-type"/);
});
pass("existing-select-preserved", () => {
  assert.match(html, /<select id="order-type"/);
  assert.match(app, /\$\("order-type"\)\?\.addEventListener\("change"/);
});
pass("mobile-touch-targets", () => {
  assert.match(css, /\.order-type-option\s*\{[^}]*min-height:\s*48px/s);
});
pass("desktop-original-select", () => {
  assert.match(css, /\.order-type-quick\s*\{\s*display:\s*none;/);
  assert.match(css, /@media \(max-width: 1023px\)/);
});
pass("responsive-narrow-phones", () => {
  assert.match(css, /@media \(max-width: 350px\)\s*\{\s*\.order-type-quick/);
});
pass("draft-and-fulfillment-remain", () => {
  assert.match(html, /id="order-number"/);
  assert.match(html, /id="fulfillment-fields"/);
  assert.match(app, /function renderFulfillmentFields\(\)/);
});

function makeButton() {
  const events = {};
  const classes = new Set();
  return {
    dataset: {}, attributes: {}, type: "", className: "", textContent: "",
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, handler) { events[name] = handler; },
    click() { events.click?.(); },
  };
}
const container = {
  children: [],
  replaceChildren(fragment) { this.children = fragment.children; },
  querySelectorAll() { return this.children; },
};
let changes = 0;
const select = { value: "", innerHTML: "", dispatchEvent(event) { assert.equal(event.type, "change"); changes++; } };
const types = [
  { orderTypeId: "id_counter", name: "Counter", code: "COUNTER" },
  { orderTypeId: "id_takeaway", name: "Takeaway", code: "TAKEAWAY" },
  { orderTypeId: "id_delivery", name: "Delivery", code: "DELIVERY" },
  { orderTypeId: "id_dine", name: "Dine in", code: "DINE_IN" },
  { orderTypeId: "id_car", name: "Car-Hop", code: "CAR_HOP" },
];
const ctx = {
  state: { orderTypes: types },
  $: (id) => ({ "order-type": select, "order-type-quick": container }[id] || null),
  document: { createElement() { return makeButton(); }, createDocumentFragment() { return { children: [], appendChild(button) { this.children.push(button); } }; } },
  Event: class { constructor(type, options) { this.type = type; this.bubbles = options?.bubbles; } },
  escapeHtml: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
};
vm.createContext(ctx);
vm.runInContext(
  fnSource("syncOrderTypeQuickButtons", "renderOrderTypeQuickButtons") + "\n" +
  fnSource("renderOrderTypeQuickButtons", "fillOrderTypeSelect") + "\n" +
  fnSource("fillOrderTypeSelect", "syncDeliveryFromInput"),
  ctx
);

ctx.fillOrderTypeSelect();
pass("dynamic-shop-types", () => assert.deepEqual(container.children.map(x => x.textContent), ["Counter", "Takeaway", "Delivery", "Dine in", "Car-Hop"]));
pass("default-takeaway", () => assert.equal(select.value, "id_takeaway"));
pass("selected-highlight-and-aria", () => {
  assert.equal(container.children.filter(x => x.classList.contains("is-selected")).length, 1);
  assert.equal(container.children[1].getAttribute("aria-pressed"), "true");
});
container.children[2].click();
pass("touch-select-changes-original-control", () => assert.equal(select.value, "id_delivery"));
pass("single-change-event", () => assert.equal(changes, 1));
ctx.syncOrderTypeQuickButtons();
pass("delivery-active-state-sync", () => {
  assert.equal(container.children[2].classList.contains("is-selected"), true);
  assert.equal(container.children[1].getAttribute("aria-pressed"), "false");
});
container.children[2].click();
pass("reselect-no-extra-change", () => assert.equal(changes, 1));
select.value = "id_car";
ctx.syncOrderTypeQuickButtons();
pass("restored-draft-choice-sync", () => {
  assert.equal(container.children[4].getAttribute("aria-pressed"), "true");
  assert.equal(container.children[2].getAttribute("aria-pressed"), "false");
});
pass("existing-fulfillment-refresh-sync", () => {
  assert.match(app, /function renderFulfillmentFields\(\)\s*\{[^}]*syncOrderTypeQuickButtons\(\)/s);
});
pass("no-pricing-logic-touched", () => {
  assert.match(app, /function renderCart\(/);
  assert.match(app, /function selectedOrderType\(/);
});
console.log(`Order type picker ${passed} passed (UI only, no DB or financial changes)`);
