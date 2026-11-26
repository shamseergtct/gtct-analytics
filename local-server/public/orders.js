import { createMoneyFormatter } from "/money.js";
import { registerPwa } from "./pwa.js";
import { renderBoard } from "./orderBoard.js";
registerPwa();

const VIEW_KEY = "gtct.orders.view";
const state = {
  role: null,
  staff: false,
  permissions: [],
  fullName: "",
  page: 1,
  boardPage: 1,
  view: "list",
  behavior: "",
  orderTypeId: "",
  addressLabel: "",
  register: null,
  boardBusy: false,
  expandedOrderIds: new Set(),
  activeShift: null,
  money: createMoneyFormatter({ currencyLabel: "", currencyDecimals: 2 }),
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 12000);
  const { timeoutMs: _ignored, signal: outerSignal, ...fetchOpts } = options;
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), timeoutMs);
  if (outerSignal) {
    if (outerSignal.aborted) ac.abort();
    else outerSignal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  try {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(fetchOpts.body ? { "Content-Type": "application/json" } : {}),
      },
      ...fetchOpts,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
    }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, status: 0, json: { error: "Request timed out. Check Wi-Fi or open http://127.0.0.1:8787/ on this Mac." } };
    }
    return { ok: false, status: 0, json: { error: "Connection lost. Reconnecting…" } };
  } finally {
    window.clearTimeout(timer);
  }
}

/** Board module expects (path, method, body). */
function boardApi(path, method = "GET", body) {
  return api(path, {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function defaultViewForRole(role) {
  return role === "admin" || role === "cashier" ? "list" : "board";
}

function resolveInitialView(role) {
  const param = new URLSearchParams(location.search).get("view");
  if (param === "board" || param === "list") return param;
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === "board" || saved === "list") return saved;
  } catch { /* ignore */ }
  return defaultViewForRole(role);
}

function persistView(view) {
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ }
  const url = new URL(location.href);
  url.searchParams.set("view", view);
  history.replaceState(null, "", url);
}

function applyViewChrome() {
  const isBoard = state.view === "board";
  $("view-list-btn")?.setAttribute("aria-pressed", String(!isBoard));
  $("view-board-btn")?.setAttribute("aria-pressed", String(isBoard));
  $("view-list-btn")?.classList.toggle("is-active", !isBoard);
  $("view-board-btn")?.classList.toggle("is-active", isBoard);
  if ($("orders-list-panel")) $("orders-list-panel").hidden = isBoard;
  if ($("orders-board-panel")) $("orders-board-panel").hidden = !isBoard;
  if ($("delivery-tools")) {
    $("delivery-tools").hidden = isBoard || state.behavior !== "DELIVERY";
  }
}

function setView(view, { reload = true } = {}) {
  state.view = view === "board" ? "board" : "list";
  persistView(state.view);
  applyViewChrome();
  if (reload) void refreshCurrentView();
}

function refreshCurrentView() {
  if (state.view === "board") return loadBoard();
  return loadOrders();
}

function boardQueryString() {
  const params = new URLSearchParams();
  params.set("page", String(state.boardPage));
  params.set("pageSize", "60");
  if (state.behavior) params.set("behavior", state.behavior);
  if (state.orderTypeId) params.set("orderTypeId", state.orderTypeId);
  const q = $("order-search").value.trim();
  const date = $("order-date").value;
  if (q) params.set("q", q);
  if (date) params.set("date", date);
  return params.toString();
}

function boardCtx() {
  return {
    session: {
      role: state.role,
      permissions: state.permissions,
      fullName: state.fullName,
    },
    expandedOrderIds: state.expandedOrderIds,
    api: boardApi,
    onRefresh: loadBoard,
  };
}

async function loadBoard({ quiet = false, force = false } = {}) {
  if (!canView()) return;
  if (state.boardBusy && !force) return;
  state.boardBusy = true;
  if (!quiet) setStatus("Loading board…");
  try {
    const result = await api(`/v1/order-monitor?${boardQueryString()}`, { timeoutMs: 12000 });
    if (result.status === 401) {
      showLogin("Sign in to view orders.");
      return;
    }
    if (!result.ok) {
      setStatus(result.json?.error || "Could not load board.");
      return;
    }
    const data = result.json;
    if (data.orderTypes) {
      state.register = {
        ...(state.register || {}),
        orderTypes: data.orderTypes,
        addressLabels: data.addressLabels || state.register?.addressLabels || [],
      };
      renderTabs();
    }
    renderBoard($("orders-board"), data.orders || [], boardCtx());
    $("board-page-label").textContent = data.total
      ? `Page ${data.page} · ${data.total} orders`
      : "No orders";
    $("board-page-prev").disabled = data.page <= 1;
    $("board-page-next").disabled = data.page * data.pageSize >= data.total;
    if (!quiet) setStatus("");
    else if (state._boardStatusWasError) setStatus("");
    state._boardStatusWasError = false;
  } catch {
    state._boardStatusWasError = true;
    setStatus("Connection lost. Reconnecting when the network is back…");
  } finally {
    state.boardBusy = false;
  }
}

function reconnectBoard() {
  if (state.view !== "board" || !canView() || document.hidden) return;
  void loadBoard({ quiet: true, force: true });
}

function canView() {
  return state.staff && state.permissions.includes("sales.orders.view");
}

function canEditOrders() {
  if (state.role === "admin" || state.role === "device") return true;
  return state.staff && state.permissions.includes("sales.order.create");
}

function setStatus(message) {
  $("orders-status").textContent = message || "";
}

function moneyFor(order) {
  return createMoneyFormatter({
    currencyLabel: order.currencyLabel,
    currencyDecimals: order.currencyDecimals,
  });
}

function when(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "";
  return date.toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paymentBadge(order) {
  if (order.fulfillmentStatus === 'VOID') return '<span class="pay-badge unpaid">VOID</span>';
  const status = String(order.paymentStatus || 'UNPAID');
  const label = ({PAID:'Paid', CREDIT:'Credit', PARTIAL:'Partial',UNPAID:'Unpaid'})[status] || status;
  return `<span class="pay-badge ${status === 'PAID' ? 'paid' : 'unpaid'}">${label}</span>`;
}

function tokenLabel(order) {
  return order.tokenNumber == null ? 'Legacy — no shift token' : `Token #${String(order.tokenNumber).padStart(3, '0')}`;
}
function currentStatusLabel(order) {
  return String(order.operationalStatus || order.kitchenStatus || order.fulfillmentStatus || 'UNKNOWN')
    .replaceAll('_', ' ');
}
function deliveryBoyLine(order) {
  // An unassigned delivery is not useful information in a compact list.
  if (order.fulfillmentBehavior !== 'DELIVERY' || !order.deliveryBoyName) return '';
  return `<div class="order-secondary order-delivery-boy">Rider · ${escapeHtml(order.deliveryBoyName)}</div>`;
}

function deliveryPaymentStatusLine(order) {
  if (order.fulfillmentBehavior !== 'DELIVERY' || !order.deliveryPaymentReport) return '';
  const labels = {
    CASH_WITH_BOY:'Cash with rider · awaiting handover',
    SHOP_PAID_REPORTED:'Shop paid · rider report (unverified)',
    CREDIT_REPORTED:'Credit · rider report (unapproved)',
    PAID_CONFIRMED:'Shop payment verified',
  };
  const label = labels[order.deliveryPaymentReport.status];
  return label ? `<div class="order-secondary order-delivery-payment">${escapeHtml(label)}</div>` : '';
}

function statusTone(order) {
  const status = String(order.operationalStatus || order.kitchenStatus || order.fulfillmentStatus || '').toUpperCase();
  if (status === 'FINISHED' || status === 'READY_FOR_DELIVERY' || status === 'DELIVERED') return 'is-success';
  if (status === 'ACCEPTED' || status === 'PREPARING' || status === 'ACCEPTED_BY_DELIVERY_BOY') return 'is-active';
  if (status === 'PACKING_RECHECK_REQUIRED') return 'is-warning';
  if (status === 'VOID') return 'is-warning';
  return 'is-neutral';
}

function statusChip(order) {
  return `<span class="fulfill-badge current-status ${statusTone(order)}">${escapeHtml(currentStatusLabel(order))}</span>`;
}

function shortDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function tokenMarkup(order) {
  return order.tokenNumber == null
    ? ''
    : `<span class="order-token">TOKEN ${escapeHtml(String(order.tokenNumber).padStart(3, '0'))}</span>`;
}

function customerLine(order) {
  return [order.customerName, order.customerPhone].filter(Boolean).join(" · ");
}

function placeLine(order) {
  if (order.fulfillmentBehavior === "DELIVERY") {
    const parts = [];
    if (order.blockNumber) parts.push(`Block ${order.blockNumber}`);
    if (order.roadNumber) parts.push(`Road ${order.roadNumber}`);
    if (order.buildingNumber) parts.push(`Building ${order.buildingNumber}`);
    if (order.addressNote) parts.push(order.addressNote);
    if (order.addressLabel) parts.push(order.addressLabel);
    return parts.join(" · ") || "Address incomplete";
  }
  if (order.tableNumber) return `Table ${order.tableNumber}`;
  if (order.vehicleNumber || order.parkingLocation) {
    return [order.vehicleNumber, order.parkingLocation].filter(Boolean).join(" · ");
  }
  return "";
}

function queryString() {
  const params = new URLSearchParams();
  params.set("page", String(state.page));
  params.set("pageSize", "40");
  if (state.behavior) params.set("behavior", state.behavior);
  if (state.orderTypeId) params.set("orderTypeId", state.orderTypeId);
  const q = $("order-search").value.trim();
  const date = $("order-date").value;
  if (q) params.set("q", q);
  if (date) params.set("date", date);
  if (state.behavior === "DELIVERY") {
    const block = $("filter-block").value.trim();
    const road = $("filter-road").value.trim();
    const building = $("filter-building").value.trim();
    if (block) params.set("block", block);
    if (road) params.set("road", road);
    if (building) params.set("building", building);
    if (state.addressLabel) params.set("addressLabel", state.addressLabel);
  }
  return params.toString();
}

function renderTabs() {
  const types = state.register?.orderTypes || [];
  const tabs = [{ name: "All orders", behavior: "", orderTypeId: "" }, ...types.map((type) => ({
    name: type.name,
    behavior: type.behavior,
    orderTypeId: type.orderTypeId,
  }))];
  $("type-tabs").innerHTML = tabs.map((tab) => {
    const selected = tab.behavior === state.behavior && tab.orderTypeId === state.orderTypeId;
    return `<button type="button" class="chip" role="tab" aria-selected="${selected}" data-behavior="${escapeHtml(tab.behavior)}" data-type="${escapeHtml(tab.orderTypeId)}">${escapeHtml(tab.name)}</button>`;
  }).join("");
  if ($("delivery-tools")) {
    $("delivery-tools").hidden = state.view === "board" || state.behavior !== "DELIVERY";
  }
  const labels = ["", ...(state.register?.addressLabels || [])];
  if ($("address-type-tabs")) {
    $("address-type-tabs").innerHTML = labels.map((label) => {
      const selected = label === state.addressLabel;
      const text = label || "All address types";
      return `<button type="button" class="chip" role="tab" aria-selected="${selected}" data-label="${escapeHtml(label)}">${escapeHtml(text)}</button>`;
    }).join("");
  }
}

function orderCells(order) {
  const money = moneyFor(order);
  return {
    number: `<div class="order-ref"><button type="button" class="linkish" data-order="${escapeHtml(order.orderId)}">${escapeHtml(order.invoiceNumber || order.orderNumber)}</button>${
      order.fulfillmentStatus === 'OPEN' && canEditOrders() && order.paymentStatus === "UNPAID" && !order.hasAllocations
        ? `<button type="button" class="btn ghost orders-edit" data-edit="${escapeHtml(order.orderId)}">Edit</button>`
        : ""
    }</div><div class="order-subline">${tokenMarkup(order)}<span class="order-secondary">${escapeHtml(shortDate(order.createdAt))}</span></div>`,
    type: escapeHtml(order.orderTypeName || order.fulfillmentBehavior),
    customer: escapeHtml(customerLine(order) || "—"),
    place: escapeHtml(placeLine(order)),
    total: escapeHtml(money.format(order.totalCents)),
    payment: paymentBadge(order),
    status: statusChip(order),
  };
}

function renderTable(orders) {
  const rows = orders.map((order) => {
    const cell = orderCells(order);
    return `<tr data-open-order="${escapeHtml(order.orderId)}" tabindex="0" aria-label="Open details for ${escapeHtml(order.invoiceNumber || order.orderNumber)}">
      <td class="order-main-cell">${cell.number}</td>
      <td><strong class="order-type">${cell.type}</strong>${cell.place ? `<div class="order-secondary order-place" title="${cell.place}">${cell.place}</div>` : ''}</td>
      <td><div class="order-customer">${cell.customer}</div>${deliveryBoyLine(order)}</td>
      <td><strong class="order-total">${cell.total}</strong><div class="order-payment">${cell.payment}</div></td>
      <td>${cell.status}${deliveryPaymentStatusLine(order)}</td>
    </tr>`;
  }).join("");
  return `<div class="orders-table-wrap"><table class="orders-table">
    <thead><tr><th>Order</th><th>Type</th><th>Customer</th><th>Total</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderCards(orders) {
  return `<div class="orders-cards">${orders.map((order) => {
    const cell = orderCells(order);
    return `<article class="order-card" data-open-order="${escapeHtml(order.orderId)}" tabindex="0" role="button" aria-label="Open details for ${escapeHtml(order.invoiceNumber || order.orderNumber)}">
      <div class="order-card-top">${cell.number}${cell.status}</div>
      <div class="order-card-middle"><strong class="order-type">${cell.type}</strong>${customerLine(order) ? `<span class="order-secondary">${cell.customer}</span>` : ''}</div>
      ${cell.place ? `<div class="order-secondary order-place" title="${cell.place}">${cell.place}</div>` : ''}
      ${deliveryBoyLine(order)}
      ${deliveryPaymentStatusLine(order)}
      <div class="order-card-bottom"><strong class="order-total">${cell.total}</strong>${cell.payment}</div>
    </article>`;
  }).join("")}</div>`;
}

function renderDelivery(groups) {
  const sections = (groups.blocks || []).map((block) => {
    const roads = block.roads.map((road) => {
      const buildings = road.buildings.map((building) => {
        const title = building.buildingNumber
          ? `Building ${building.buildingNumber}`
          : "Building not recorded";
        return `<div class="delivery-building"><h4>${escapeHtml(title)}</h4>${renderCards(building.orders)}${renderTable(building.orders)}</div>`;
      }).join("");
      const roadTitle = road.roadNumber ? `Road ${road.roadNumber}` : "Road not recorded";
      return `<div class="delivery-road"><h3>${escapeHtml(roadTitle)}</h3>${buildings}</div>`;
    }).join("");
    return `<section class="delivery-block"><h2>Block ${escapeHtml(block.blockNumber)}</h2>${roads}</section>`;
  }).join("");
  const incomplete = groups.incomplete?.length
    ? `<section class="delivery-block"><h2>Address incomplete</h2><p class="hint">These delivery orders do not have a saved block number.</p>${renderCards(groups.incomplete)}${renderTable(groups.incomplete)}</section>`
    : "";
  return sections + incomplete;
}

function renderList() {
  const register = state.register;
  if (!register) return;
  renderTabs();
  const orders = register.orders || [];
  $("page-label").textContent = register.total
    ? `Page ${register.page} · ${register.total} orders`
    : "No orders";
  $("page-prev").disabled = register.page <= 1;
  $("page-next").disabled = register.page * register.pageSize >= register.total;
  if (!orders.length) {
    $("orders-list").innerHTML = `<p class="hint">No accepted orders match these filters.</p>`;
    setStatus("");
    return;
  }
  $("orders-list").innerHTML = register.deliveryGroups
    ? renderDelivery(register.deliveryGroups)
    : renderTable(orders) + renderCards(orders);
  setStatus("");
}

async function loadOrders() {
  setStatus("Loading orders…");
  const result = await api(`/v1/order-register?${queryString()}`);
  if (result.status === 401) {
    showLogin("Sign in to view orders.");
    return;
  }
  if (!result.ok) {
    setStatus(result.json?.error || "Could not load orders.");
    return;
  }
  state.register = result.json;
  const first = result.json.orders?.[0];
  if (first) state.money = moneyFor(first);
  renderList();
}

async function openOrder(orderId) {
  const result = await api(`/v1/order-register/${encodeURIComponent(orderId)}`);
  if (!result.ok) {
    setStatus(result.json?.error || "Could not open this order.");
    return;
  }
  const order = result.json.order;
  const money = moneyFor(order);
  $("detail-title").textContent = `Invoice ${order.invoiceNumber || order.orderNumber}`;
  const lines = (order.lines || []).map((line) => {
    const extras = [
      line.variantName,
      ...(line.addons || []).map((addon) => `${addon.name} × ${addon.quantity}`),
      ...(line.instructions || []),
    ].filter(Boolean).join(" · ");
    return `<li class="detail-item">
      <div class="detail-item-info"><strong>${escapeHtml(line.quantity)} × ${escapeHtml(line.itemName)}</strong>${extras ? `<div class="detail-item-notes">${escapeHtml(extras)}</div>` : ''}</div>
      <strong class="detail-item-price">${escapeHtml(money.format(line.lineTotalCents))}</strong>
    </li>`;
  }).join("");
  const orderMeta = [
    order.orderTypeName,
    shortDate(order.createdAt),
    order.businessDate ? `Business ${order.businessDate}` : '',
  ].filter(Boolean);
  const customer = customerLine(order);
  const place = placeLine(order) || order.destination || '';
  const showAddress = Boolean(place);
  const deliveryBoy = order.fulfillmentBehavior === 'DELIVERY' && order.deliveryBoyName
    ? `<div class="detail-secondary">Rider · ${escapeHtml(order.deliveryBoyName)}</div>` : '';
  const taxRow = Number(order.taxCents || 0) !== 0
    ? `<div class="detail-summary-row"><span>Tax</span><span>${escapeHtml(money.format(order.taxCents))}</span></div>` : '';
  const deliveryRow = Number(order.deliveryChargeCents || 0) !== 0
    ? `<div class="detail-summary-row"><span>Delivery</span><span>${escapeHtml(money.format(order.deliveryChargeCents))}</span></div>` : '';
  const paymentObservation = deliveryPaymentStatusLine(order);
  const tender = order.paymentStatus === 'PAID' && order.paymentTender
    ? `<span class="detail-secondary">${escapeHtml(order.paymentTender)}${order.bankAccountLabel ? ` · ${escapeHtml(order.bankAccountLabel)}` : ''}</span>` : '';
  $("detail-body").innerHTML = `
    <div class="detail-hero">
      <div class="detail-hero-top"><div class="detail-token">${tokenMarkup(order)}</div>${statusChip(order)}</div>
      <div class="detail-secondary">${escapeHtml(orderMeta.join(' · '))}</div>
    </div>
    ${customer || showAddress || deliveryBoy ? `<section class="detail-section detail-contact">
      ${customer ? `<strong>${escapeHtml(customer)}</strong>` : ''}
      ${showAddress ? `<div class="detail-secondary">${escapeHtml(place)}</div>` : ''}
      ${deliveryBoy}
    </section>` : ''}
    <section class="detail-section">
      <h3 class="detail-section-title">Items</h3>
      <ul class="detail-lines">${lines}</ul>
    </section>
    <section class="detail-section detail-summary">
      <div class="detail-summary-row"><span>Subtotal</span><span>${escapeHtml(money.format(order.goodsCents))}</span></div>
      ${taxRow}${deliveryRow}
      <div class="detail-total"><span>Total</span><strong>${escapeHtml(money.format(order.totalCents))}</strong></div>
      <div class="detail-payment">${order.fulfillmentStatus === 'VOID' ? '<span class="fulfill-badge is-warning">VOID</span>' : paymentBadge(order)}${order.fulfillmentStatus === 'VOID' ? '' : tender}${order.fulfillmentStatus === 'VOID' ? '' : paymentObservation}</div>
      ${order.fulfillmentStatus === 'VOID' ? '<p class="detail-secondary">Voided invoice · payment disabled</p>' : ''}
      <div class="payment-allocation-summary">
        <span>Shop Cash: <strong>${escapeHtml(money.format(order.cashCents || 0))}</strong></span>
        <span>Shop Bank: <strong>${escapeHtml(money.format(order.bankCents || 0))}</strong></span>
        <span>Shop Credit: <strong>${escapeHtml(money.format(order.creditCents || 0))}</strong></span>
        <span>Not yet allocated: <strong>${escapeHtml(money.format(order.unallocatedCents ?? order.totalCents))}</strong></span>
      </div>
    </section>
    ${order.fulfillmentStatus !== 'VOID' && state.staff && state.permissions.includes('sales.payment.receive') && Number(order.unallocatedCents ?? order.totalCents) > 0
      ? `<div class="detail-actions"><a class="btn primary" href="/?payOrder=${encodeURIComponent(order.orderId)}">Take Payment</a></div>`
      : ''}
    ${order.fulfillmentStatus !== 'VOID' && canEditOrders() && order.paymentStatus === "UNPAID" && !order.hasAllocations
      ? `<div class="detail-actions"><a class="btn ghost" href="/?editOrder=${encodeURIComponent(order.orderId)}">Edit order</a></div>`
      : ''}
    ${state.role === 'admin' && order.fulfillmentStatus === 'OPEN' && order.paymentStatus === 'UNPAID'
      && !order.hasAllocations && Number(order.paidCents || 0) === 0
      && Number(order.creditCents || 0) === 0
      ? `<div class="detail-actions"><button type="button" id="void-invoice-btn" class="btn ghost">Void Bill</button></div>
         <section id="void-panel" class="void-confirm-panel" hidden>
           <h3>Void this invoice</h3>
           <label for="void-reason">Reason
             <input id="void-reason" type="text" maxlength="240" autocomplete="off" placeholder="Reason for voiding" />
           </label>
           <label for="void-word">Type VOID to confirm
             <input id="void-word" type="text" maxlength="4" autocomplete="off" placeholder="VOID" />
           </label>
           <p id="void-error" role="alert" class="void-error" hidden></p>
           <div class="void-confirm-actions">
             <button id="void-cancel-btn" type="button" class="btn ghost">Cancel</button>
             <button id="void-confirm-btn" type="button" class="btn primary" disabled>Confirm Void</button>
           </div>
         </section>` : ''}
  `;
  if (!$('order-detail').open) $('order-detail').showModal();
  const voidBtn = $('void-invoice-btn');
  if (voidBtn) {
    const panel=$('void-panel'), reason=$('void-reason'), word=$('void-word');
    const confirmBtn=$('void-confirm-btn'), cancelBtn=$('void-cancel-btn');
    const error=$('void-error');
    voidBtn.addEventListener('click', () => {
      panel.hidden=false; voidBtn.hidden=true; reason.focus();
    });
    cancelBtn.addEventListener('click', () => {
      panel.hidden=true; voidBtn.hidden=false; reason.value=''; word.value='';
      confirmBtn.disabled=true; error.hidden=true;
    });
    const validate = () => {
      confirmBtn.disabled=reason.value.trim().length<5 || word.value !== 'VOID';
      error.hidden=true;
    };
    reason.addEventListener('input',validate);
    word.addEventListener('input',validate);
    confirmBtn.addEventListener('click', async () => {
      if (confirmBtn.disabled) return;
      confirmBtn.disabled=true; cancelBtn.disabled=true;
      const result = await api(`/v1/orders/${encodeURIComponent(order.orderId)}/void`, {
        method:'POST',body:JSON.stringify({reason:reason.value.trim(),expectedUpdatedAt:order.updatedAt})
      });
      if (!result.ok) {
        error.textContent=result.json?.error || 'Void failed. Refresh invoice before retrying.';
        error.hidden=false;cancelBtn.disabled=false;validate();error.hidden=false;
        return;
      }
      await loadOrders();
      await openOrder(order.orderId);
    });
  }
}

function showLogin(message = "") {
  $("login-view").hidden = false;
  $("main-view").hidden = true;
  $("login-error").hidden = !message;
  $("login-error").textContent = message;
}

function showMain() {
  $("login-view").hidden = true;
  $("main-view").hidden = false;
  $("session-role").textContent = state.fullName || state.role || "";
  const prepLink = $("prep-link");
  if (prepLink) {
    prepLink.hidden = !(state.role === "admin" || (state.staff && state.permissions.includes("prep.station.work")));
  }
  const allowed = canView();
  $("orders-denied").hidden = allowed;
  $("orders-shell").hidden = !allowed;
  if (allowed) {
    state.view = resolveInitialView(state.role);
    persistView(state.view);
    applyViewChrome();
    void refreshCurrentView();
    void loadShift();
  }
}

async function login() {
  const username = $("login-username").value.trim();
  const password = $("login-password").value;
  const result = await api("/v1/session/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!result.ok) {
    showLogin(result.json?.error || "Sign-in failed.");
    return;
  }
  const me = await api("/v1/session/me");
  if (!me.ok || !me.json?.authenticated) {
    showLogin("Signed in, but the session cookie was not kept.");
    return;
  }
  state.role = me.json.role;
  state.staff = Boolean(me.json.staff);
  state.permissions = me.json.permissions || [];
  state.fullName = me.json.fullName || "";
  showMain();
}

$("login-btn").addEventListener("click", () => void login());
$("nav-menu-btn").addEventListener("click", () => {
  const open = !document.body.classList.contains("nav-menu-open");
  document.body.classList.toggle("nav-menu-open", open);
  $("nav-menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
});
$("logout-btn").addEventListener("click", async () => {
  await api("/v1/session/logout", { method: "POST" });
  showLogin();
});
$("view-list-btn")?.addEventListener("click", () => setView("list"));
$("view-board-btn")?.addEventListener("click", () => setView("board"));
$("type-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-behavior]");
  if (!button) return;
  state.behavior = button.dataset.behavior || "";
  state.orderTypeId = button.dataset.type || "";
  state.page = 1;
  state.boardPage = 1;
  void refreshCurrentView();
});
$("address-type-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-label]");
  if (!button) return;
  state.addressLabel = button.dataset.label || "";
  state.page = 1;
  void loadOrders();
});
$("order-search").addEventListener("change", () => {
  state.page = 1;
  state.boardPage = 1;
  void refreshCurrentView();
});
$("order-date").addEventListener("change", () => {
  state.page = 1;
  state.boardPage = 1;
  void refreshCurrentView();
});
for (const id of ["filter-block", "filter-road", "filter-building"]) {
  $(id).addEventListener("change", () => {
    state.page = 1;
    void loadOrders();
  });
}
$("clear-filters").addEventListener("click", () => {
  state.page = 1;
  state.boardPage = 1;
  state.behavior = "";
  state.orderTypeId = "";
  state.addressLabel = "";
  $("order-search").value = "";
  $("order-date").value = "";
  $("filter-block").value = "";
  $("filter-road").value = "";
  $("filter-building").value = "";
  void refreshCurrentView();
});
$("page-prev").addEventListener("click", () => {
  if (state.page > 1) {
    state.page -= 1;
    void loadOrders();
  }
});
$("page-next").addEventListener("click", () => {
  state.page += 1;
  void loadOrders();
});
$("board-page-prev")?.addEventListener("click", () => {
  if (state.boardPage > 1) {
    state.boardPage -= 1;
    void loadBoard();
  }
});
$("board-page-next")?.addEventListener("click", () => {
  state.boardPage += 1;
  void loadBoard();
});
window.setInterval(() => {
  if (state.view !== "board" || !canView() || document.hidden) return;
  void loadBoard({ quiet: true });
}, 8000);
window.addEventListener("online", reconnectBoard);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) reconnectBoard();
});
$("orders-list").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit]");
  if (edit) {
    location.href = `/?editOrder=${encodeURIComponent(edit.dataset.edit)}`;
    return;
  }
  const target = event.target.closest("[data-order], [data-open-order]");
  if (!target) return;
  void openOrder(target.dataset.order || target.dataset.openOrder);
});
$("orders-list").addEventListener("keydown", (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target.closest('button, a, input, select')) return;
  const row = event.target.closest('[data-open-order]');
  if (!row) return;
  event.preventDefault();
  void openOrder(row.dataset.openOrder);
});

// Shift UI is intentionally operational only. It NEVER settles Cash/Bank.
async function loadShift() {
  const result = await api('/v1/business-shift');
  if (!result.ok) {
    $('shift-info').textContent = result.json?.error || 'Could not load business shift.';
    return;
  }
  const active = result.json.active;
  state.activeShift = active;
  $('shift-info').textContent = active
    ? `Shift open · ${active.businessDate} · Next token ${String(active.nextTokenNumber).padStart(3, '0')}`
    : `No active shift${result.json.requiresManualStart ? ' · Open a shift to take orders' : ''}`;
  const admin = state.role === 'admin';
  $('shift-actions').hidden = !admin;
  $('shift-close').hidden = !admin || !active;
  $('shift-open').hidden = !admin || Boolean(active);
  $('shift-next-date').hidden = !admin || Boolean(active);
  if (!active) $('shift-next-date').value = result.json.suggestedBusinessDate || '';
}
$('shift-close').addEventListener('click', async () => {
  const active = state.activeShift;
  if (!active || state.role !== 'admin') return;
  const approved = confirm(`Close TEST shift ${active.businessDate}? New orders will be blocked until you open the next shift. This does NOT settle payments or delivery cash.`);
  if (!approved) return;
  const result = await api('/v1/business-shift/close', {
    method: 'POST', body: JSON.stringify({ shiftId: active.shiftId, confirm: true }),
  });
  if (!result.ok) { setStatus(result.json?.error || 'Could not close shift.'); return; }
  await loadShift();
});
$('shift-open').addEventListener('click', async () => {
  if (state.role !== 'admin' || state.activeShift) return;
  const businessDate = $('shift-next-date').value;
  if (!businessDate) { setStatus('Choose the business date.'); return; }
  const result = await api('/v1/business-shift/open', {
    method: 'POST', body: JSON.stringify({ businessDate }),
  });
  if (!result.ok) { setStatus(result.json?.error || 'Could not open shift.'); return; }
  await loadShift();
});

const session = await api("/v1/session/me");
if (session.ok && session.json?.authenticated) {
  state.role = session.json.role;
  state.staff = Boolean(session.json.staff);
  state.permissions = session.json.permissions || [];
  state.fullName = session.json.fullName || "";
  showMain();
} else {
  showLogin();
}
