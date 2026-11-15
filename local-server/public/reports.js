const state = {
  role: null,
  permissions: [],
  report: null,
  tab: "daily",
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    ...options,
  });
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, json };
}

function setLoginError(message = "") {
  const el = $("login-error");
  el.hidden = !message;
  el.textContent = message || "";
}

function showLogin(msg = "") {
  $("login-view").hidden = false;
  $("main-view").hidden = true;
  setLoginError(msg);
}

function canViewReports() {
  if (state.role === "admin") return true;
  return (
    state.permissions.includes("sales.orders.view") ||
    state.permissions.includes("sales.payment.receive")
  );
}

function showMain() {
  $("login-view").hidden = true;
  $("main-view").hidden = false;
  $("session-role").textContent = state.role || "";
  const isAdmin = state.role === "admin";
  $("menu-setup-link").hidden = !isAdmin;
  $("shop-settings-link").hidden = !isAdmin;
  $("settings-link").hidden = !isAdmin;
  $("users-link").hidden = !(isAdmin && state.permissions.includes("staff.manage"));
  const terminalsLink = $("terminals-link");
  if (terminalsLink) {
    terminalsLink.hidden = !(isAdmin && state.permissions.includes("staff.manage"));
  }
  const allowed = canViewReports();
  $("denied-block").hidden = allowed;
  $("reports-shell").hidden = !allowed;
  $("tab-types").hidden = !isAdmin;
  $("tab-items").hidden = !isAdmin;
  $("tab-stations").hidden = !isAdmin;
  $("tab-hourly").hidden = !isAdmin;
  $("tab-audit").hidden = !isAdmin;
  $("tab-rider-cash").hidden = !isAdmin;
  $("tab-commission").hidden = !isAdmin;
  $("tab-delivery-mix").hidden = !isAdmin;
}

function money() {
  return state.report?.money || { currencyLabel: "", currencyDecimals: 2 };
}

function formatMoney(cents) {
  const m = money();
  const decimals = Number.isFinite(m.currencyDecimals) ? m.currencyDecimals : 2;
  const n = Number(cents || 0) / 10 ** decimals;
  const label = m.currencyLabel || m.currencyCode || "";
  const body = n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return label ? `${label} ${body}` : body;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(message, ok = true) {
  const el = $("filter-status");
  el.hidden = !message;
  el.textContent = message || "";
  el.className = `status-line ${ok ? "ok" : "err"}`;
}

function tableHtml(headers, rows) {
  if (!rows.length) {
    return `<p class="empty">No rows for this filter.</p>`;
  }
  return `<div class="reports-table-wrap"><table class="reports-table">
    <thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows
      .map(
        (row) =>
          `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`
      )
      .join("")}</tbody>
  </table></div>`;
}

function renderKpis() {
  const s = state.report?.summary;
  if (!s) {
    $("kpi-grid").innerHTML = "";
    return;
  }
  const cards = [
    ["Orders", String(s.orderCount)],
    ["Sales total", formatMoney(s.totalCents)],
    ["Goods", formatMoney(s.goodsCents)],
    ["Tax", formatMoney(s.taxCents)],
    ["Cash + bank", formatMoney(s.paidCents)],
    ["Credit", formatMoney(s.creditCents)],
    ["Outstanding", formatMoney(s.outstandingCents)],
  ];
  $("kpi-grid").innerHTML = cards
    .map(
      ([label, value]) =>
        `<article class="reports-kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`
    )
    .join("");
}

function renderDaily() {
  const rows = (state.report?.daily || []).map((d) => [
    escapeHtml(d.businessDate),
    String(d.orderCount),
    escapeHtml(formatMoney(d.goodsCents)),
    escapeHtml(formatMoney(d.taxCents)),
    escapeHtml(formatMoney(d.totalCents)),
    escapeHtml(formatMoney(d.paidCents)),
    escapeHtml(formatMoney(d.creditCents)),
    escapeHtml(formatMoney(d.outstandingCents)),
  ]);
  $("panel-daily").innerHTML = `
    <h2>Daily sales summary</h2>
    <p class="muted">Totals by business date in the selected range.</p>
    ${tableHtml(
      ["Date", "Orders", "Goods", "Tax", "Total", "Cash/Bank", "Credit", "Outstanding"],
      rows
    )}`;
}

function renderPayments() {
  const p = state.report?.payments || {};
  const status = p.byStatus || {};
  $("panel-payments").innerHTML = `
    <h2>Payments breakdown</h2>
    <p class="muted">Shop-received money vs credit and still-open balances.</p>
    <div class="reports-stat-grid">
      <div><span>Cash</span><strong>${escapeHtml(formatMoney(p.cashCents))}</strong></div>
      <div><span>Bank</span><strong>${escapeHtml(formatMoney(p.bankCents))}</strong></div>
      <div><span>Credit</span><strong>${escapeHtml(formatMoney(p.creditCents))}</strong></div>
      <div><span>Outstanding</span><strong>${escapeHtml(formatMoney(p.outstandingCents))}</strong></div>
    </div>
    ${tableHtml(
      ["Status", "Orders"],
      [
        ["PAID", String(status.PAID || 0)],
        ["CREDIT", String(status.CREDIT || 0)],
        ["PARTIAL", String(status.PARTIAL || 0)],
        ["UNPAID", String(status.UNPAID || 0)],
      ].map(([a, b]) => [escapeHtml(a), escapeHtml(b)])
    )}`;
}

function renderTypes() {
  const rows = (state.report?.byOrderType || []).map((r) => [
    escapeHtml(r.orderType),
    String(r.orderCount),
    escapeHtml(formatMoney(r.totalCents)),
    escapeHtml(formatMoney(r.paidCents)),
    escapeHtml(formatMoney(r.creditCents)),
    escapeHtml(formatMoney(r.outstandingCents)),
  ]);
  $("panel-types").innerHTML = `
    <h2>Sales by order type</h2>
    <p class="muted">Takeaway, delivery, dine-in, and other fulfillment types.</p>
    ${tableHtml(
      ["Type", "Orders", "Total", "Cash/Bank", "Credit", "Outstanding"],
      rows
    )}`;
}

function renderItems() {
  const itemRows = (state.report?.items || []).map((r) => [
    escapeHtml(r.itemName),
    escapeHtml(r.category),
    String(r.quantity),
    String(r.orderCount),
    escapeHtml(formatMoney(r.revenueCents)),
  ]);
  const catRows = (state.report?.categories || []).map((r) => [
    escapeHtml(r.category),
    String(r.itemCount),
    String(r.quantity),
    escapeHtml(formatMoney(r.revenueCents)),
  ]);
  $("panel-items").innerHTML = `
    <h2>Item &amp; category sales</h2>
    <p class="muted">Line revenue from non-voided orders in range. Items with variants are listed separately (e.g. Orange Juice (Medium)).</p>
    <h3 class="reports-subhead">By category</h3>
    ${tableHtml(["Category", "Items", "Qty", "Revenue"], catRows)}
    <h3 class="reports-subhead">By item</h3>
    ${tableHtml(["Item", "Category", "Qty", "Orders", "Revenue"], itemRows)}`;
}

function renderUnpaid() {
  const rows = (state.report?.unpaid || []).map((r) => [
    escapeHtml(r.orderNumber),
    escapeHtml(r.businessDate || ""),
    escapeHtml(r.orderType),
    escapeHtml(r.customerName || "—"),
    escapeHtml(r.paymentStatus),
    escapeHtml(formatMoney(r.totalCents)),
    escapeHtml(formatMoney(r.paidCents)),
    escapeHtml(formatMoney(r.creditCents)),
    escapeHtml(formatMoney(r.outstandingCents)),
  ]);
  $("panel-unpaid").innerHTML = `
    <h2>Unpaid &amp; credit outstanding</h2>
    <p class="muted">Orders with remaining unallocated amount and/or credit.</p>
    ${tableHtml(
      [
        "Invoice",
        "Date",
        "Type",
        "Customer",
        "Status",
        "Total",
        "Cash/Bank",
        "Credit",
        "Outstanding",
      ],
      rows
    )}`;
}

function renderShift() {
  const s = state.report?.shift;
  if (!s) {
    $("panel-shift").innerHTML = `
      <h2>Shift snapshot</h2>
      <p class="empty">No shift selected and no open shift found.</p>`;
    return;
  }
  const extra =
    s.orderCount != null
      ? `<div class="reports-stat-grid">
          <div><span>Orders</span><strong>${escapeHtml(String(s.orderCount))}</strong></div>
          <div><span>Total</span><strong>${escapeHtml(formatMoney(s.totalCents))}</strong></div>
          <div><span>Cash</span><strong>${escapeHtml(formatMoney(s.cashCents))}</strong></div>
          <div><span>Bank</span><strong>${escapeHtml(formatMoney(s.bankCents))}</strong></div>
          <div><span>Credit</span><strong>${escapeHtml(formatMoney(s.creditCents))}</strong></div>
          <div><span>Outstanding</span><strong>${escapeHtml(formatMoney(s.outstandingCents))}</strong></div>
        </div>`
      : `<p class="muted">${escapeHtml(s.note || "")}</p>`;
  $("panel-shift").innerHTML = `
    <h2>Shift snapshot</h2>
    <p class="muted">Operational shift view — not a formal accounting Z-report.</p>
    ${tableHtml(
      ["Field", "Value"],
      [
        ["Shift", escapeHtml(s.shiftId)],
        ["Business date", escapeHtml(s.businessDate)],
        ["Status", escapeHtml(s.status)],
        ["Opened", escapeHtml(s.openedAt || "—")],
        ["Closed", escapeHtml(s.closedAt || "—")],
        ["Last token", escapeHtml(String(s.lastTokenNumber ?? "—"))],
      ]
    )}
    ${extra}`;
}

function renderStations() {
  const rows = (state.report?.stations || []).map((r) => [
    escapeHtml(r.stationName),
    String(r.orderCount),
    String(r.itemQty),
    String(r.lineCount),
    escapeHtml(formatMoney(r.revenueCents)),
    String(r.kitchenTickets),
    String(r.dispatchedTickets),
    String(r.problemTickets),
  ]);
  $("panel-stations").innerHTML = `
    <h2>Kitchen station volume</h2>
    <p class="muted">Items routed to each preparation station, plus kitchen ticket counts.</p>
    ${tableHtml(
      [
        "Station",
        "Orders",
        "Item qty",
        "Lines",
        "Revenue",
        "KOT jobs",
        "Dispatched",
        "Problems",
      ],
      rows
    )}`;
}

function renderHourly() {
  const hourly = state.report?.hourly;
  if (!hourly) {
    $("panel-hourly").innerHTML = `
      <h2>Busy hours</h2>
      <p class="empty">No hourly data.</p>`;
    return;
  }
  const max = Math.max(1, ...hourly.hours.map((h) => h.orderCount));
  const bars = hourly.hours
    .map((h) => {
      const pct = Math.round((h.orderCount / max) * 100);
      return `<div class="reports-hour-row">
        <span class="reports-hour-label">${escapeHtml(h.label)}</span>
        <div class="reports-hour-bar-track" aria-hidden="true"><span style="width:${pct}%"></span></div>
        <span class="reports-hour-count">${h.orderCount}</span>
        <span class="reports-hour-money">${escapeHtml(formatMoney(h.totalCents))}</span>
      </div>`;
    })
    .join("");
  $("panel-hourly").innerHTML = `
    <h2>Busy hours</h2>
    <p class="muted">Order start times in shop timezone (${escapeHtml(hourly.timezone)}).
      Peak: <strong>${escapeHtml(hourly.peakHour || "—")}</strong>
      (${hourly.peakOrderCount || 0} orders).</p>
    <div class="reports-hour-chart">${bars}</div>`;
}

function renderAudit() {
  const audit = state.report?.opsAudit;
  if (!audit) {
    $("panel-audit").innerHTML = `
      <h2>Voids &amp; edits</h2>
      <p class="empty">No audit data.</p>`;
    return;
  }
  const voidRows = (audit.voids || []).map((r) => [
    escapeHtml(r.orderNumber),
    escapeHtml(r.businessDate),
    escapeHtml(r.orderType),
    escapeHtml(r.customerName || "—"),
    escapeHtml(formatMoney(r.totalCents)),
    escapeHtml(r.voidedBy || "—"),
    escapeHtml(r.voidedAt || ""),
    escapeHtml(r.reason || ""),
  ]);
  const editRows = (audit.edits || []).map((r) => [
    escapeHtml(r.orderNumber),
    escapeHtml(r.businessDate),
    escapeHtml(r.status),
    escapeHtml(r.customerName || "—"),
    escapeHtml(formatMoney(r.totalCents)),
    String(r.ticketRevision),
    String(r.kitchenJobs),
    escapeHtml(r.updatedAt || ""),
  ]);
  const priceRows = (audit.priceAudits || []).map((r) => [
    escapeHtml(r.createdAt || ""),
    escapeHtml(r.action),
    escapeHtml(r.entityId),
    escapeHtml(r.actor || "—"),
  ]);
  $("panel-audit").innerHTML = `
    <h2>Voids &amp; edits</h2>
    <p class="muted">Operational audit for the selected range.
      Voids: <strong>${audit.voidCount}</strong> · Edited invoices: <strong>${audit.editCount}</strong></p>
    <h3 class="reports-subhead">Voided invoices</h3>
    ${tableHtml(
      ["Invoice", "Date", "Type", "Customer", "Total", "By", "Voided at", "Reason"],
      voidRows
    )}
    <h3 class="reports-subhead">Edited invoices</h3>
    ${tableHtml(
      ["Invoice", "Date", "Status", "Customer", "Total", "Rev", "KOT jobs", "Updated"],
      editRows
    )}
    <h3 class="reports-subhead">Price / fee audit events</h3>
    ${tableHtml(["When", "Action", "Entity", "Actor"], priceRows)}`;
}

function renderRiderCash() {
  const data = state.report?.riderCash;
  if (!data) {
    $("panel-rider-cash").innerHTML = `
      <h2>Rider cash</h2>
      <p class="empty">No rider cash data.</p>`;
    return;
  }
  const handedRows = (data.handedOver || []).map((r) => [
    escapeHtml(r.riderName),
    String(r.handoverCount),
    escapeHtml(formatMoney(r.amountCents)),
    escapeHtml(r.lastAt || "—"),
  ]);
  const pendingRows = (data.pendingWithBoy || []).map((r) => [
    escapeHtml(r.riderName),
    String(r.pendingCount),
    escapeHtml(formatMoney(r.amountCents)),
  ]);
  $("panel-rider-cash").innerHTML = `
    <h2>Rider cash handover</h2>
    <p class="muted">${escapeHtml(data.note || "")}</p>
    <div class="reports-stat-grid">
      <div><span>Handed over</span><strong>${escapeHtml(formatMoney(data.totals.handedOverCents))}</strong></div>
      <div><span>Handover count</span><strong>${escapeHtml(String(data.totals.handedOverCount))}</strong></div>
      <div><span>Still with boy</span><strong>${escapeHtml(formatMoney(data.totals.pendingCents))}</strong></div>
      <div><span>Pending orders</span><strong>${escapeHtml(String(data.totals.pendingCount))}</strong></div>
    </div>
    <h3 class="reports-subhead">Confirmed handovers</h3>
    ${tableHtml(["Rider", "Orders", "Cash", "Last handover"], handedRows)}
    <h3 class="reports-subhead">Pending with boy</h3>
    ${tableHtml(["Rider", "Orders", "Cash"], pendingRows)}`;
}

function renderCommission() {
  const data = state.report?.commission;
  if (!data) {
    $("panel-commission").innerHTML = `
      <h2>Commission</h2>
      <p class="empty">No commission data.</p>`;
    return;
  }
  const riderRows = (data.byRider || []).map((r) => [
    escapeHtml(r.riderName),
    String(r.accrualCount),
    String(r.deliveryCount),
    escapeHtml(formatMoney(r.accruedCents)),
    escapeHtml(formatMoney(r.paidCents)),
    escapeHtml(formatMoney(r.payableCents)),
  ]);
  const accrualRows = (data.accruals || []).map((r) => [
    escapeHtml(r.businessDate),
    escapeHtml(r.riderName),
    String(r.deliveryCount),
    escapeHtml(formatMoney(r.accruedCents)),
    escapeHtml(formatMoney(r.paidCents)),
    escapeHtml(formatMoney(r.payableCents)),
    r.settled ? "Settled" : "Open",
  ]);
  $("panel-commission").innerHTML = `
    <h2>Commission accruals vs settled</h2>
    <p class="muted">${escapeHtml(data.note || "")}</p>
    <div class="reports-stat-grid">
      <div><span>Accruals</span><strong>${escapeHtml(String(data.totals.accrualCount))}</strong></div>
      <div><span>Deliveries</span><strong>${escapeHtml(String(data.totals.deliveryCount))}</strong></div>
      <div><span>Accrued</span><strong>${escapeHtml(formatMoney(data.totals.accruedCents))}</strong></div>
      <div><span>Paid</span><strong>${escapeHtml(formatMoney(data.totals.paidCents))}</strong></div>
      <div><span>Still payable</span><strong>${escapeHtml(formatMoney(data.totals.payableCents))}</strong></div>
    </div>
    <h3 class="reports-subhead">By rider</h3>
    ${tableHtml(
      ["Rider", "Days", "Deliveries", "Accrued", "Paid", "Payable"],
      riderRows
    )}
    <h3 class="reports-subhead">Daily accruals</h3>
    ${tableHtml(
      ["Date", "Rider", "Deliveries", "Accrued", "Paid", "Payable", "Status"],
      accrualRows
    )}`;
}

function renderDeliveryMix() {
  const data = state.report?.deliveryMix;
  if (!data) {
    $("panel-delivery-mix").innerHTML = `
      <h2>Delivery mix</h2>
      <p class="empty">No delivery mix data.</p>`;
    return;
  }
  const mixRows = [
    [
      "Delivery",
      String(data.delivery.orderCount),
      escapeHtml(formatMoney(data.delivery.goodsCents)),
      escapeHtml(formatMoney(data.delivery.deliveryChargeCents)),
      escapeHtml(formatMoney(data.delivery.totalCents)),
    ],
    [
      "Non-delivery",
      String(data.nonDelivery.orderCount),
      escapeHtml(formatMoney(data.nonDelivery.goodsCents)),
      escapeHtml(formatMoney(data.nonDelivery.deliveryChargeCents)),
      escapeHtml(formatMoney(data.nonDelivery.totalCents)),
    ],
  ];
  const riderRows = (data.byRider || []).map((r) => [
    escapeHtml(r.riderName),
    String(r.orderCount),
    escapeHtml(formatMoney(r.deliveryChargeCents)),
    escapeHtml(formatMoney(r.totalCents)),
  ]);
  $("panel-delivery-mix").innerHTML = `
    <h2>Delivery vs non-delivery</h2>
    <p class="muted">${escapeHtml(data.note || "")}
      Delivery share of sales: <strong>${escapeHtml(String(data.deliverySharePct))}%</strong></p>
    ${tableHtml(
      ["Channel", "Orders", "Goods", "Delivery fee", "Total"],
      mixRows
    )}
    <h3 class="reports-subhead">Delivery orders by rider</h3>
    ${tableHtml(["Rider", "Orders", "Delivery fee", "Total"], riderRows)}`;
}

function renderAll() {
  renderKpis();
  renderDaily();
  renderPayments();
  renderTypes();
  renderItems();
  renderUnpaid();
  renderShift();
  renderStations();
  renderHourly();
  renderAudit();
  renderRiderCash();
  renderCommission();
  renderDeliveryMix();
  setActiveTab(state.tab);
}

function setActiveTab(tab) {
  const isAdmin = state.role === "admin";
  const adminOnly = new Set([
    "types",
    "items",
    "stations",
    "hourly",
    "audit",
    "rider-cash",
    "commission",
    "delivery-mix",
  ]);
  if (!isAdmin && adminOnly.has(tab)) tab = "daily";
  state.tab = tab;
  document.querySelectorAll(".reports-tab").forEach((btn) => {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".reports-panel").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
}

function fillShiftOptions(shifts) {
  const sel = $("filter-shift");
  const current = sel.value;
  sel.innerHTML = `<option value="">All shifts in date range</option>`;
  for (const s of shifts || []) {
    const opt = document.createElement("option");
    opt.value = s.shiftId;
    opt.textContent = `${s.businessDate} · ${s.status}${s.closedAt ? "" : " · open"}`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

async function loadReport() {
  if (!canViewReports()) return;
  const from = $("filter-from").value;
  const to = $("filter-to").value;
  const shiftId = $("filter-shift").value;
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (shiftId) qs.set("shiftId", shiftId);
  setStatus("Loading…", true);
  const res = await api(`/v1/reports/summary?${qs.toString()}`);
  if (!res.ok) {
    setStatus(res.json?.error || "Failed to load report", false);
    return;
  }
  state.report = res.json.report;
  if (!$("filter-from").value) $("filter-from").value = state.report.filters.from;
  if (!$("filter-to").value) $("filter-to").value = state.report.filters.to;
  fillShiftOptions(state.report.shifts);
  if (state.report.filters.shiftId) $("filter-shift").value = state.report.filters.shiftId;
  renderAll();
  const range = state.report.filters.shiftId
    ? `Shift ${state.report.filters.shiftId}`
    : `${state.report.filters.from} → ${state.report.filters.to}`;
  setStatus(`Loaded · ${range} · ${state.report.summary.orderCount} order(s)`, true);
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function exportCsv() {
  const report = state.report;
  if (!report) return;
  const lines = [];
  const push = (row) => lines.push(row.map(csvEscape).join(","));
  push(["GTCT TEST Reports"]);
  push(["From", report.filters.from]);
  push(["To", report.filters.to]);
  push(["Shift", report.filters.shiftId || ""]);
  push([]);
  push(["Summary"]);
  push(["Orders", report.summary.orderCount]);
  push(["Total cents", report.summary.totalCents]);
  push(["Paid cents", report.summary.paidCents]);
  push(["Credit cents", report.summary.creditCents]);
  push(["Outstanding cents", report.summary.outstandingCents]);
  push([]);
  push(["Daily"]);
  push([
    "Date",
    "Orders",
    "Goods",
    "Tax",
    "Total",
    "Paid",
    "Credit",
    "Outstanding",
  ]);
  for (const d of report.daily || []) {
    push([
      d.businessDate,
      d.orderCount,
      d.goodsCents,
      d.taxCents,
      d.totalCents,
      d.paidCents,
      d.creditCents,
      d.outstandingCents,
    ]);
  }
  if (report.byOrderType) {
    push([]);
    push(["By type"]);
    push(["Type", "Orders", "Total", "Paid", "Credit", "Outstanding"]);
    for (const r of report.byOrderType) {
      push([
        r.orderType,
        r.orderCount,
        r.totalCents,
        r.paidCents,
        r.creditCents,
        r.outstandingCents,
      ]);
    }
  }
  if (report.items) {
    push([]);
    push(["Items"]);
    push(["Item", "Variant", "Category", "Qty", "Orders", "Revenue"]);
    for (const r of report.items) {
      push([
        r.baseItemName || r.itemName,
        r.variantName || "",
        r.category,
        r.quantity,
        r.orderCount,
        r.revenueCents,
      ]);
    }
  }
  push([]);
  push(["Unpaid and credit"]);
  push([
    "Invoice",
    "Date",
    "Type",
    "Customer",
    "Status",
    "Total",
    "Paid",
    "Credit",
    "Outstanding",
  ]);
  for (const r of report.unpaid || []) {
    push([
      r.orderNumber,
      r.businessDate,
      r.orderType,
      r.customerName,
      r.paymentStatus,
      r.totalCents,
      r.paidCents,
      r.creditCents,
      r.outstandingCents,
    ]);
  }
  if (report.stations) {
    push([]);
    push(["Stations"]);
    push([
      "Station",
      "Orders",
      "Item qty",
      "Lines",
      "Revenue",
      "Kitchen tickets",
      "Dispatched",
      "Problems",
    ]);
    for (const r of report.stations) {
      push([
        r.stationName,
        r.orderCount,
        r.itemQty,
        r.lineCount,
        r.revenueCents,
        r.kitchenTickets,
        r.dispatchedTickets,
        r.problemTickets,
      ]);
    }
  }
  if (report.hourly) {
    push([]);
    push(["Busy hours", report.hourly.timezone || ""]);
    push(["Hour", "Orders", "Total"]);
    for (const h of report.hourly.hours || []) {
      push([h.label, h.orderCount, h.totalCents]);
    }
  }
  if (report.opsAudit) {
    push([]);
    push(["Voids"]);
    push([
      "Invoice",
      "Date",
      "Type",
      "Customer",
      "Total",
      "By",
      "Voided at",
      "Reason",
    ]);
    for (const r of report.opsAudit.voids || []) {
      push([
        r.orderNumber,
        r.businessDate,
        r.orderType,
        r.customerName,
        r.totalCents,
        r.voidedBy,
        r.voidedAt,
        r.reason,
      ]);
    }
    push([]);
    push(["Edited invoices"]);
    push([
      "Invoice",
      "Date",
      "Status",
      "Customer",
      "Total",
      "Revision",
      "Kitchen jobs",
      "Updated",
    ]);
    for (const r of report.opsAudit.edits || []) {
      push([
        r.orderNumber,
        r.businessDate,
        r.status,
        r.customerName,
        r.totalCents,
        r.ticketRevision,
        r.kitchenJobs,
        r.updatedAt,
      ]);
    }
    push([]);
    push(["Price audit events"]);
    push(["When", "Action", "Entity", "Actor"]);
    for (const r of report.opsAudit.priceAudits || []) {
      push([r.createdAt, r.action, r.entityId, r.actor]);
    }
  }
  if (report.riderCash) {
    push([]);
    push(["Rider cash handed over"]);
    push(["Rider", "Orders", "Cash cents", "Last handover"]);
    for (const r of report.riderCash.handedOver || []) {
      push([r.riderName, r.handoverCount, r.amountCents, r.lastAt || ""]);
    }
    push([]);
    push(["Rider cash pending with boy"]);
    push(["Rider", "Orders", "Cash cents"]);
    for (const r of report.riderCash.pendingWithBoy || []) {
      push([r.riderName, r.pendingCount, r.amountCents]);
    }
  }
  if (report.commission) {
    push([]);
    push(["Commission by rider"]);
    push([
      "Rider",
      "Days",
      "Deliveries",
      "Accrued",
      "Paid",
      "Payable",
    ]);
    for (const r of report.commission.byRider || []) {
      push([
        r.riderName,
        r.accrualCount,
        r.deliveryCount,
        r.accruedCents,
        r.paidCents,
        r.payableCents,
      ]);
    }
    push([]);
    push(["Commission accruals"]);
    push([
      "Date",
      "Rider",
      "Deliveries",
      "Accrued",
      "Paid",
      "Payable",
      "Settled",
    ]);
    for (const r of report.commission.accruals || []) {
      push([
        r.businessDate,
        r.riderName,
        r.deliveryCount,
        r.accruedCents,
        r.paidCents,
        r.payableCents,
        r.settled ? "yes" : "no",
      ]);
    }
  }
  if (report.deliveryMix) {
    push([]);
    push(["Delivery mix"]);
    push(["Channel", "Orders", "Goods", "Delivery fee", "Total"]);
    push([
      "Delivery",
      report.deliveryMix.delivery.orderCount,
      report.deliveryMix.delivery.goodsCents,
      report.deliveryMix.delivery.deliveryChargeCents,
      report.deliveryMix.delivery.totalCents,
    ]);
    push([
      "Non-delivery",
      report.deliveryMix.nonDelivery.orderCount,
      report.deliveryMix.nonDelivery.goodsCents,
      report.deliveryMix.nonDelivery.deliveryChargeCents,
      report.deliveryMix.nonDelivery.totalCents,
    ]);
    push([]);
    push(["Delivery by rider"]);
    push(["Rider", "Orders", "Delivery fee", "Total"]);
    for (const r of report.deliveryMix.byRider || []) {
      push([r.riderName, r.orderCount, r.deliveryChargeCents, r.totalCents]);
    }
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `gtct-reports-${report.filters.from}-to-${report.filters.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function login() {
  const username = $("login-username").value.trim();
  const password = $("login-password").value;
  if (!username || !password) {
    setLoginError("Enter your username and password.");
    return;
  }
  const btn = $("login-btn");
  btn.disabled = true;
  try {
    const res = await api("/v1/session/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      setLoginError(res.json?.error || "Sign-in failed");
      return;
    }
    $("login-password").value = "";
    await ensureSession();
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  await api("/v1/session/logout", { method: "POST", body: "{}" });
  state.role = null;
  state.permissions = [];
  state.report = null;
  showLogin();
}

async function ensureSession() {
  const me = await api("/v1/session/me");
  if (!me.ok || !me.json?.authenticated) {
    showLogin();
    return false;
  }
  state.role = me.json.role;
  state.permissions = me.json.permissions || [];
  if (!["admin", "cashier"].includes(state.role)) {
    showLogin("Admin or Cashier sign-in is required for Reports.");
    return false;
  }
  showMain();
  if (canViewReports()) await loadReport();
  return true;
}

function bindUi() {
  $("login-btn").addEventListener("click", login);
  for (const id of ["login-username", "login-password"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        login();
      }
    });
  }
  $("toggle-password-btn").addEventListener("click", () => {
    const input = $("login-password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("toggle-password-btn").textContent = show ? "Hide" : "Show";
  });
  $("logout-btn").addEventListener("click", logout);
  $("apply-filters-btn").addEventListener("click", loadReport);
  $("refresh-btn").addEventListener("click", loadReport);
  $("today-btn").addEventListener("click", () => {
    const today = state.report?.filters?.today || new Date().toISOString().slice(0, 10);
    $("filter-from").value = today;
    $("filter-to").value = today;
    $("filter-shift").value = "";
    loadReport();
  });
  $("export-btn").addEventListener("click", exportCsv);
  $("print-btn").addEventListener("click", () => window.print());
  document.querySelectorAll(".reports-tab").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
}

bindUi();
ensureSession();
