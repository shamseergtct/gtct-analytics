/**
 * Shared item-line presentation for Review Order + Board Details.
 * Display only — does not recalculate money; uses cents already on the line/addons.
 */

function esc(value, escapeHtml) {
  if (typeof escapeHtml === "function") return escapeHtml(value);
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SPLIT_INSTR_RE = /^Order\s+(\d+)$/i;

function lineName(line) {
  return String(line.itemName || line.name || "Item").trim();
}

function lineTotalCents(line) {
  if (line.lineTotalCents != null) return Number(line.lineTotalCents);
  if (line.line_total_cents != null) return Number(line.line_total_cents);
  return null;
}

/** Split group id from stored instruction "Order N" (or line.splitNo). */
export function splitNoFromLine(line) {
  const direct = Number(line?.splitNo);
  if (Number.isFinite(direct) && direct >= 1) return Math.trunc(direct);
  for (const raw of line?.instructions || []) {
    const m = String(raw || "").trim().match(SPLIT_INSTR_RE);
    if (m) return Number(m[1]);
  }
  return null;
}

export function kitchenNotesWithoutSplit(line) {
  return (line?.instructions || [])
    .map((i) => String(i || "").trim())
    .filter((i) => i && !SPLIT_INSTR_RE.test(i));
}

/** "Subtotal BD 2.000" — never "BD:" or "Total". */
export function formatSplitGroupTotalLabel(formattedMoney) {
  const amount = String(formattedMoney || "")
    .trim()
    .replace(/^([A-Za-z]+):\s*/, "$1 ");
  return `Subtotal ${amount}`;
}

/**
 * Group lines by split for Details/Review headings.
 * Group total = sum of each line's API lineTotalCents (no unit recalculation).
 */
export function groupLinesBySplit(lines) {
  const list = Array.isArray(lines) ? lines : [];
  const map = new Map();
  for (const line of list) {
    const n = splitNoFromLine(line);
    const key = n == null ? 0 : n;
    if (!map.has(key)) map.set(key, { splitNo: n, lines: [], totalCents: 0 });
    const g = map.get(key);
    g.lines.push(line);
    const t = lineTotalCents(line);
    if (t != null) g.totalCents += t;
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (a === 0) return 1;
    if (b === 0) return -1;
    return a - b;
  });
  const numbered = keys.filter((k) => k > 0);
  return {
    isSplit: numbered.length > 1,
    splitCount: numbered.length,
    groups: keys.map((k) => map.get(k)),
  };
}

/** Prefer stored addon cents already on the object; never invent a price. */
function addonPriceCents(addon) {
  if (addon == null) return null;
  if (addon.linePriceCents != null) return Number(addon.linePriceCents);
  if (addon.unitPriceCents != null) {
    const q = Number(addon.quantity || 1);
    return Number(addon.unitPriceCents) * (Number.isFinite(q) ? q : 1);
  }
  if (addon.appliedPriceCents != null) return Number(addon.appliedPriceCents);
  return null;
}

/**
 * @param {object} line
 * @param {{
 *   formatMoney: (cents:number)=>string,
 *   formatLineMoney?: (cents:number)=>string,
 *   formatSignedMoney?: (cents:number)=>string,
 *   escapeHtml?: (s:any)=>string,
 *   editButtonHtml?: string,
 * }} opts
 * @returns {string} HTML
 */
export function renderOrderLineItemHtml(line, opts) {
  const escapeHtml = opts.escapeHtml;
  const formatMoney = opts.formatMoney;
  const formatLineMoney = opts.formatLineMoney || formatMoney;
  const formatSigned =
    opts.formatSignedMoney ||
    ((cents) => {
      const n = Number(cents || 0);
      if (n === 0) return formatMoney(0);
      return `${n > 0 ? "+" : ""}${formatMoney(n)}`;
    });

  const qty = Number(line.quantity || 0) || 0;
  const name = lineName(line);
  const variant = String(line.variantName || "").trim();
  const title = variant ? `${name} · ${variant}` : name;
  const total = lineTotalCents(line);
  const totalHtml =
    total == null
      ? ""
      : `<strong class="oli-total">${esc(formatLineMoney(total), escapeHtml)}</strong>`;

  const edit = opts.editButtonHtml || "";

  const extras = (line.addons || [])
    .map((a) => {
      const label = String(a.name || "").trim();
      if (!label) return "";
      const price = addonPriceCents(a);
      const qtyA = Number(a.quantity || 1);
      const qtyBit = qtyA > 1 ? ` × ${qtyA}` : "";
      const priceBit = price == null ? "" : ` ${formatSigned(price)}`;
      return `<span class="oli-chip oli-chip-extra">${esc(label + qtyBit + priceBit, escapeHtml)}</span>`;
    })
    .filter(Boolean)
    .join("");

  const kitchen = kitchenNotesWithoutSplit(line)
    .map((i) => `<span class="oli-chip oli-chip-kitchen">${esc(i, escapeHtml)}</span>`)
    .join("");

  const note = String(line.orderNote || line.note || "").trim();

  const extrasRow = extras
    ? `<div class="oli-row oli-row-extras"><span class="oli-label">Extras:</span><div class="oli-chips">${extras}</div></div>`
    : "";
  const kitchenRow = kitchen
    ? `<div class="oli-row oli-row-kitchen"><span class="oli-label">Kitchen:</span><div class="oli-chips">${kitchen}</div></div>`
    : "";
  const noteRow = note
    ? `<div class="oli-row oli-row-note"><span class="oli-label">Note:</span><span class="oli-note-text">${esc(note, escapeHtml)}</span></div>`
    : "";

  return `<div class="oli-line"${line.lineId ? ` data-line-id="${esc(line.lineId, escapeHtml)}"` : ""}>
    <div class="oli-main">
      <span class="oli-title">${esc(`${qty} × ${title}`, escapeHtml)}</span>
      ${totalHtml}
      ${edit}
    </div>
    ${extrasRow}${kitchenRow}${noteRow}
  </div>`;
}

/**
 * Append one line into a DOM host (Board Details).
 * @param {HTMLElement} host
 * @param {object} line
 * @param {object} opts same as renderOrderLineItemHtml
 */
export function appendOrderLineItem(host, line, opts) {
  const wrap = document.createElement("div");
  wrap.innerHTML = renderOrderLineItemHtml(line, opts);
  const el = wrap.firstElementChild;
  if (el) host.append(el);
}
