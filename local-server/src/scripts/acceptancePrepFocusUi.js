/** P2-E1.4 lightweight frontend safety contract. No database or network used. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../../public/prep.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../../public/prep.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../../public/prep.css", import.meta.url), "utf8");

const cases = [
  ["preparing-priority-layout", () => assert(html.indexOf("prep-column-preparing") < html.indexOf("prep-column-new"))],
  ["new-order-accept-remains", () => assert(js.includes('data-accept=') && js.includes('mark(accept.dataset.accept, "accept")'))],
  ["click-preparing-opens-focus", () => assert(js.includes('data-focus=') && js.includes('openFocus(focused.dataset.focus)'))],
  ["focus-has-large-items", () => assert(html.includes('id="prep-focus-body"') && css.includes('.prep-focus-lines li strong'))],
  ["focus-includes-instructions", () => assert(js.includes('.map(lineHtml).join("")'))],
  ["finish-action-reuses-server", () => assert(js.includes('mark(state.focusOrderId, "finish")'))],
  ["server-status-and-revision-preserved", () => assert(js.includes('expectedStatus: ticket.status') && js.includes('expectedRevision: ticket.revision'))],
  ["no-direct-status-update", () => assert(!/ticket\.status\s*=\s*"FINISHED"/.test(js))],
  ["focus-keeps-state-on-refresh", () => assert(js.includes('if (state.focusRevision === ticket.revision) return;'))],
  ["finished-hidden-initially", () => assert(/id="prep-finished-panel"[^>]*hidden/.test(html))],
  ["finished-search-available", () => assert(html.includes('id="prep-finished-search"') && js.includes('function searchText(ticket)'))],
  ["finished-renders-only-on-demand", () => assert(js.includes('if (!state.finishedOpen) return;'))],
  ["on-demand-history-limited-height", () => assert(css.includes('max-height: 340px'))],
  ["accessible-close-and-escape", () => assert(js.includes('event.key === "Escape"') && html.includes('aria-modal="true"'))],
  ["background-polling-preserved", () => assert(js.includes('}, 3000);') && js.includes('document.hidden'))],
  ["station-restriction-preserved", () => assert(js.includes('state.role === "kitchen"') && js.includes('prep.station.work'))],
  ["mobile-focus-view", () => assert(css.includes('height: 100dvh') && css.includes('prep-focus-dialog'))],
];
let passed = 0;
for (const [name, action] of cases) {
  action();
  console.log(`PASS ${name}`);
  passed++;
}
console.log(`Kitchen focus UI ${passed} passed (frontend-only; database untouched)`);
