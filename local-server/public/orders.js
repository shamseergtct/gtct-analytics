import { createMoneyFormatter } from "/money.js";

const state = {
  role: null,
  staff: false,
  permissions: [],
  fullName: "",
  page: 1,
  behavior: "",
  orderTypeId: "",
  addressLabel: "",
  register: null,
  money: createMoneyFormatter({ currencyLabel: "", currencyDecimals: 2 }),
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
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
  }
  return { ok: res.ok, status: res.status, json };
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
  const paid = order.paymentStatus === "PAID";
  const label = paid ? "Paid" : "Unpaid";
  return `<span class="pay-badge ${paid ? "paid" : "unpaid"}">${label}</span>`;
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
  $("delivery-tools").hidden = state.behavior !== "DELIVERY";
  const labels = ["", ...(state.register?.addressLabels || [])];
  $("address-type-tabs").innerHTML = labels.map((label) => {
    const selected = label === state.addressLabel;
    const text = label || "All address types";
    return `<button type="button" class="chip" role="tab" aria-selected="${selected}" data-label="${escapeHtml(label)}">${escapeHtml(text)}</button>`;
  }).join("");
}

function orderCells(order) {
  const money = moneyFor(order);
  return {
    number: `<button type="button" class="linkish" data-order="${escapeHtml(order.orderId)}">${escapeHtml(order.orderNumber)}</button>${
      canEditOrders() && order.paymentStatus !== "PAID"
        ? `<button type="button" class="btn ghost orders-edit" data-edit="${escapeHtml(order.orderId)}">Edit</button>`
        : ""
    }`,
    when: escapeHtml(when(order.createdAt)),
    type: escapeHtml(order.orderTypeName || order.fulfillmentBehavior),
    customer: escapeHtml(customerLine(order) || "—"),
    place: escapeHtml(placeLine(order)),
    total: escapeHtml(money.format(order.totalCents)),
    payment: paymentBadge(order),
    status: `<span class="fulfill-badge">${escapeHtml(order.fulfillmentStatus || "OPEN")}</span>`,
    staff: escapeHtml(order.createdByName || "—"),
  };
}

function renderTable(orders) {
  const rows = orders.map((order) => {
    const cell = orderCells(order);
    return `<tr>
      <td>${cell.number}<div class="hint">${cell.when}</div></td>
      <td>${cell.type}<div class="hint">${cell.place}</div></td>
      <td>${cell.customer}</td>
      <td>${cell.total}<div>${cell.payment}</div></td>
      <td>${cell.status}<div class="hint">${cell.staff}</div></td>
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
    return `<article class="order-card">
      <div>${cell.number}</div>
      <p>${cell.when} · ${cell.type}</p>
      <p>${cell.customer}</p>
      <p>${cell.place}</p>
      <p>${cell.total} ${cell.payment} ${cell.status}</p>
      <p class="hint">${cell.staff}</p>
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
  $("detail-title").textContent = order.orderNumber;
  const lines = (order.lines || []).map((line) => {
    const extras = [
      line.variantName,
      ...(line.addons || []).map((addon) => `${addon.name} × ${addon.quantity}`),
      ...(line.instructions || []),
    ].filter(Boolean).join(" · ");
    return `<li><strong>${escapeHtml(line.quantity)} × ${escapeHtml(line.itemName)}</strong>
      <div class="hint">${escapeHtml(extras)}</div>
      <div>${escapeHtml(money.format(line.lineTotalCents))}</div></li>`;
  }).join("");
  $("detail-body").innerHTML = `
    <p>${escapeHtml(when(order.createdAt))} · ${escapeHtml(order.orderTypeName)}</p>
    <p>${escapeHtml(customerLine(order) || "No customer snapshot")}</p>
    <p>${escapeHtml(placeLine(order) || order.destination || "")}</p>
    <ul class="detail-lines">${lines}</ul>
    <p>Goods ${escapeHtml(money.format(order.goodsCents))} · Tax ${escapeHtml(money.format(order.taxCents))} · Delivery ${escapeHtml(money.format(order.deliveryChargeCents))}</p>
    <p><strong>Total ${escapeHtml(money.format(order.totalCents))}</strong></p>
    <p>${paymentBadge(order)} <span class="fulfill-badge">${escapeHtml(order.fulfillmentStatus)}</span></p>
    <p class="hint">${escapeHtml(order.paymentTender ? `Payment ${order.paymentTender}${order.bankAccountLabel ? ` · ${order.bankAccountLabel}` : ""}` : "No payment recorded")} · ${escapeHtml(order.createdByName || "Staff name unavailable")}</p>
    ${
      canEditOrders() && order.paymentStatus !== "PAID"
        ? `<p><a class="btn ghost" href="/?editOrder=${encodeURIComponent(order.orderId)}">Edit order</a></p>`
        : ""
    }
  `;
  $("order-detail").showModal();
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
  if (allowed) void loadOrders();
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
$("type-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-behavior]");
  if (!button) return;
  state.behavior = button.dataset.behavior || "";
  state.orderTypeId = button.dataset.type || "";
  state.page = 1;
  void loadOrders();
});
$("address-type-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-label]");
  if (!button) return;
  state.addressLabel = button.dataset.label || "";
  state.page = 1;
  void loadOrders();
});
$("order-search").addEventListener("input", () => {
  state.page = 1;
  void loadOrders();
});
$("order-date").addEventListener("change", () => {
  state.page = 1;
  void loadOrders();
});
for (const id of ["filter-block", "filter-road", "filter-building"]) {
  $(id).addEventListener("change", () => {
    state.page = 1;
    void loadOrders();
  });
}
$("clear-filters").addEventListener("click", () => {
  state.page = 1;
  state.behavior = "";
  state.orderTypeId = "";
  state.addressLabel = "";
  $("order-search").value = "";
  $("order-date").value = "";
  $("filter-block").value = "";
  $("filter-road").value = "";
  $("filter-building").value = "";
  void loadOrders();
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
$("orders-list").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit]");
  if (edit) {
    location.href = `/?editOrder=${encodeURIComponent(edit.dataset.edit)}`;
    return;
  }
  const button = event.target.closest("[data-order]");
  if (!button) return;
  void openOrder(button.dataset.order);
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
