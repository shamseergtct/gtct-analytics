/**
 * Shop Settings — admin UI (Phase 1.7).
 */
import { createMoneyFormatter } from "./money.js";

const $ = (id) => document.getElementById(id);

const state = {
  shop: null,
  savedSnapshot: "",
  dirty: false,
  role: null,
  orderCount: 0,
  testOrderCount: 0,
  orderTypes: [],
  blockRates: [],
  editingTypeId: null,
  editingRateId: null,
  bankAccounts: [],
  editingAccountId: null,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { ok: res.ok, status: res.status, json };
}

function showLogin(msg) {
  $("login-view").hidden = false;
  $("main-view").hidden = true;
  if (msg) {
    $("login-error").hidden = false;
    $("login-error").textContent = msg;
  }
}

function showMain() {
  $("login-view").hidden = true;
  $("main-view").hidden = false;
}

function setStatus(message, ok = true) {
  const el = $("save-status");
  el.hidden = !message;
  el.textContent = message || "";
  el.className = `status-line ${ok ? "ok" : "err"}`;
}

function snapshotForm() {
  return JSON.stringify(collectForm());
}

function markDirty() {
  const next = snapshotForm();
  state.dirty = next !== state.savedSnapshot;
  $("dirty-hint").hidden = !state.dirty;
}

function collectForm() {
  const taxMode =
    document.querySelector('input[name="tax-mode"]:checked')?.value ||
    "exclusive";
  return {
    displayName: $("f-display-name").value,
    legalName: $("f-legal-name").value,
    addressText: $("f-address").value,
    city: $("f-city").value,
    country: $("f-country").value,
    phone: $("f-phone").value,
    phoneSecondary: $("f-phone2").value,
    whatsapp: $("f-whatsapp").value,
    email: $("f-email").value,
    registrationNumber: $("f-registration").value,
    currencyPreset: $("f-currency-preset").value || undefined,
    currencyCode: $("f-currency-code").value,
    currencyLabel: $("f-currency-label").value,
    currencyDecimals: Number($("f-currency-decimals").value),
    taxEnabled: $("f-tax-enabled").checked,
    taxName: $("f-tax-name").value,
    taxRatePercent: $("f-tax-rate").value,
    taxMode,
    taxRegistrationNumber: $("f-tax-reg").value,
    timezone: $("f-timezone").value,
    dateFormat: $("f-date-format").value,
    receipt: {
      showDisplayName: $("r-show-display").checked,
      showLegalName: $("r-show-legal").checked,
      showAddress: $("r-show-address").checked,
      showPhone: $("r-show-phone").checked,
      showWhatsapp: $("r-show-whatsapp").checked,
      showTaxName: $("r-show-tax-name").checked,
      showTaxNumber: $("r-show-tax-number").checked,
      showRegistration: $("r-show-registration").checked,
      showLogo: $("r-show-logo").checked,
      footer: $("f-receipt-footer").value,
    },
  };
}

function fillForm(shop) {
  $("f-display-name").value = shop.displayName || "";
  $("f-legal-name").value = shop.legalName || "";
  $("f-address").value = shop.addressText || "";
  $("f-city").value = shop.city || "";
  $("f-country").value = shop.country || "";
  $("f-phone").value = shop.phone || "";
  $("f-phone2").value = shop.phoneSecondary || "";
  $("f-whatsapp").value = shop.whatsapp || "";
  $("f-email").value = shop.email || "";
  $("f-registration").value = shop.registrationNumber || "";

  $("f-currency-preset").value = "";
  $("f-currency-code").value = shop.currencyCode || "";
  $("f-currency-label").value = shop.currencyLabel || "";
  $("f-currency-decimals").value = String(shop.currencyDecimals ?? 2);
  $("f-timezone").value = shop.timezone || "UTC";
  $("f-date-format").value = shop.dateFormat || "YYYY-MM-DD";

  $("f-tax-enabled").checked = Boolean(shop.taxEnabled);
  $("f-tax-name").value = shop.taxName || "VAT";
  $("f-tax-rate").value = shop.taxRatePercent || "0";
  $("f-tax-reg").value = shop.taxRegistrationNumber || "";
  const mode = shop.taxMode === "inclusive" ? "inclusive" : "exclusive";
  document.querySelectorAll('input[name="tax-mode"]').forEach((el) => {
    el.checked = el.value === mode;
  });

  const r = shop.receipt || {};
  $("r-show-display").checked = r.showDisplayName !== false;
  $("r-show-legal").checked = Boolean(r.showLegalName);
  $("r-show-address").checked = r.showAddress !== false;
  $("r-show-phone").checked = r.showPhone !== false;
  $("r-show-whatsapp").checked = r.showWhatsapp !== false;
  $("r-show-tax-name").checked = r.showTaxName !== false;
  $("r-show-tax-number").checked = r.showTaxNumber !== false;
  $("r-show-registration").checked = Boolean(r.showRegistration);
  $("r-show-logo").checked = r.showLogo !== false;
  $("f-receipt-footer").value = r.footer || "Thank you! Visit again.";

  renderLogo(shop);
  syncTaxUi();
  updateMoneyExample();
  state.savedSnapshot = snapshotForm();
  state.dirty = false;
  $("dirty-hint").hidden = true;
}

function renderLogo(shop) {
  const host = $("logo-preview");
  if (shop.logoUrl) {
    host.innerHTML = `<img src="${shop.logoUrl}" alt="Shop logo" />`;
  } else {
    host.textContent = "No logo";
  }
}

function syncTaxUi() {
  const on = $("f-tax-enabled").checked;
  $("tax-fields").dataset.disabled = on ? "0" : "1";
  $("tax-disabled-note").hidden = on;
}

function updateMoneyExample() {
  const label = $("f-currency-label").value || $("f-currency-code").value;
  const dec = Number($("f-currency-decimals").value || 2);
  const sample = (1500 / 10 ** dec).toFixed(dec);
  $("money-example").textContent = `Example: ${label} ${sample} (1500 minor units). Changing decimals does not rescale stored prices.`;
  $("currency-pill").textContent = `${$("f-currency-code").value || "—"} · ${dec} DP`;
}

function switchTab(tab) {
  document.querySelectorAll(".shop-tabs .ms-tab").forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  ["profile", "tax", "currency", "receipt", "orders", "banks"].forEach((id) => {
    const panel = $(`panel-${id}`);
    if (panel) panel.hidden = id !== tab;
  });
  const saveBar = document.querySelector(".ss-save-bar");
  if (saveBar) saveBar.hidden = tab === "orders" || tab === "banks";
  if (tab === "receipt") refreshPreview();
  if (tab === "orders") loadOrderDelivery();
  if (tab === "banks") void loadBankAccounts();
}

function updateOrderLockUi() {
  const text = $("order-lock-text");
  const btn = $("clear-orders-btn");
  const n = Number(state.orderCount || 0);
  const t = Number(state.testOrderCount || 0);
  if (!text || !btn) return;
  if (n <= 0) {
    text.textContent =
      "No orders on file. Currency and decimal precision can be changed (menu confirmation still required).";
    btn.disabled = true;
    btn.textContent = "Clear test orders";
  } else {
    text.textContent = `Currency/precision is locked while orders exist (${n} total, ${t} test). Clearing removes test orders and their MOCK print jobs only — menu and settings are kept.`;
    btn.disabled = t <= 0;
    btn.textContent =
      t > 0 ? `Clear ${t} test order${t === 1 ? "" : "s"}` : "No test orders to clear";
  }
}

async function loadShop() {
  const res = await api("/v1/shop-settings");
  if (!res.ok) {
    if (res.status === 401) {
      showLogin("Session expired. Sign in again.");
      return;
    }
    setStatus(res.json?.error || "Failed to load settings", false);
    return;
  }
  state.shop = res.json.shop;
  state.orderCount = Number(res.json.orderCount || 0);
  state.testOrderCount = Number(res.json.testOrderCount || 0);
  fillForm(state.shop);
  updateOrderLockUi();
}

async function clearTestOrders() {
  const t = Number(state.testOrderCount || 0);
  if (t <= 0) {
    setStatus("No test orders to clear.", false);
    return;
  }
  const ok = confirm(
    `Permanently delete ${t} test order${t === 1 ? "" : "s"} and related MOCK print jobs?\n\n` +
      "Menu items, add-ons, and shop settings are not deleted. This cannot be undone."
  );
  if (!ok) return;
  const res = await api("/v1/test-orders", {
    method: "DELETE",
    body: JSON.stringify({ confirm: true }),
  });
  if (!res.ok) {
    setStatus(res.json?.error || "Could not clear orders", false);
    return;
  }
  state.orderCount = Number(res.json.remainingOrders || 0);
  state.testOrderCount = Number(res.json.remainingTestOrders || 0);
  updateOrderLockUi();
  setStatus(
    `Cleared ${res.json.deleted || 0} test order(s). You can change currency now.`
  );
}

async function saveShop(e) {
  e?.preventDefault();
  const body = collectForm();
  if (!String(body.displayName || "").trim()) {
    setStatus("Shop display name is required.", false);
    switchTab("profile");
    return;
  }
  if (body.taxEnabled) {
    const ok = confirm(
      "Save tax and billing settings? New orders will use these values. Historical orders will not change."
    );
    if (!ok) return;
  }
  const currencyChanged =
    body.currencyCode !== state.shop?.currencyCode ||
    Number(body.currencyDecimals) !== Number(state.shop?.currencyDecimals) ||
    body.currencyPreset;
  if (currencyChanged) {
    const ok = confirm(
      "Currency or decimal precision changes do NOT convert existing amounts. " +
        "Menu prices keep the same numbers under the new label. Continue?"
    );
    if (!ok) return;
    body.confirmCurrencyChange = true;
  }

  $("save-btn").disabled = true;
  setStatus("Saving…");
  const res = await api("/v1/shop-settings", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  $("save-btn").disabled = false;
  if (!res.ok) {
    setStatus(res.json?.error || "Save failed", false);
    return;
  }
  state.shop = res.json.shop;
  fillForm(state.shop);
  setStatus("Shop settings saved.");
  refreshPreview();
}

async function refreshPreview() {
  const body = {
    ...collectForm(),
    previewMode: $("preview-mode").value,
  };
  const res = await api("/v1/shop-settings/receipt-preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    $("receipt-preview").textContent = res.json?.error || "Preview failed";
    return;
  }
  $("receipt-preview").textContent = res.json.text || "";
}

async function uploadLogo() {
  const file = $("f-logo").files?.[0];
  if (!file) {
    setStatus("Choose a logo file first.", false);
    return;
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64Data = btoa(binary);
  const res = await api("/v1/shop-settings/logo", {
    method: "PUT",
    body: JSON.stringify({ mimeType: file.type, base64Data }),
  });
  if (!res.ok) {
    setStatus(res.json?.error || "Logo upload failed", false);
    return;
  }
  state.shop = res.json.shop;
  renderLogo(state.shop);
  setStatus("Logo uploaded.");
}

async function clearLogo() {
  if (!confirm("Remove the shop logo?")) return;
  const res = await api("/v1/shop-settings/logo", { method: "DELETE" });
  if (!res.ok) {
    setStatus(res.json?.error || "Remove failed", false);
    return;
  }
  state.shop = res.json.shop;
  renderLogo(state.shop);
  $("f-logo").value = "";
  setStatus("Logo removed.");
}

async function bootstrap() {
  const me = await api("/v1/session/me");
  if (!me.ok || !me.json?.authenticated) {
    showLogin();
    return;
  }
  state.role = me.json.role;
  $("session-role").textContent = String(state.role || "").toUpperCase();
  showMain();
  if (state.role !== "admin") {
    $("device-block").hidden = false;
    $("admin-shell").hidden = true;
    return;
  }
  $("device-block").hidden = true;
  $("admin-shell").hidden = false;
  await loadShop();
  await refreshPreview();
}

async function login() {
  const username = $("login-username").value.trim();
  const password = $("login-password").value;
  if (!username || !password) {
    showLogin("Enter your username and password.");
    return;
  }
  const btn = $("login-btn");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  btn.setAttribute("aria-busy", "true");
  $("login-error").hidden = true;
  try {
    const res = await api("/v1/session/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      showLogin(res.json?.error || "Sign-in failed");
      return;
    }
    $("login-password").value = "";
    await bootstrap();
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
    btn.removeAttribute("aria-busy");
  }
}

function bindUi() {
  $("login-btn").addEventListener("click", login);
  $("logout-btn")?.addEventListener("click", async () => {
    if (state.dirty && !confirm("Discard unsaved changes and sign out?")) return;
    await api("/v1/session/logout", { method: "POST" });
    showLogin();
  });
  for (const id of ["login-username", "login-password"]) {
    $(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        login();
      }
    });
  }
  $("toggle-password-btn")?.addEventListener("click", () => {
    const input = $("login-password");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("toggle-password-btn").textContent = show ? "Hide" : "Show";
  });

  document.querySelectorAll(".shop-tabs .ms-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
  $("bank-save")?.addEventListener("click", () => void saveBankAccount());
  $("bank-cancel")?.addEventListener("click", resetBankForm);
  $("bank-account-list")?.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-bank-edit]");
    if (edit) {
      const account = state.bankAccounts.find((row) => row.accountId === edit.dataset.bankEdit);
      if (account) fillBankForm(account);
      return;
    }
    const toggle = event.target.closest("[data-bank-toggle]");
    if (toggle) {
      const account = state.bankAccounts.find((row) => row.accountId === toggle.dataset.bankToggle);
      if (account) void toggleBankAccount(account);
    }
  });

  $("shop-form").addEventListener("submit", saveShop);
  $("shop-form").addEventListener("input", () => {
    markDirty();
    syncTaxUi();
    updateMoneyExample();
  });
  $("shop-form").addEventListener("change", () => {
    markDirty();
    syncTaxUi();
    updateMoneyExample();
  });

  $("f-tax-enabled").addEventListener("change", syncTaxUi);
  $("f-currency-preset").addEventListener("change", () => {
    const p = $("f-currency-preset").value;
    if (p === "BHD") {
      $("f-currency-code").value = "BHD";
      $("f-currency-label").value = "BHD";
      $("f-currency-decimals").value = "3";
    } else if (p === "QAR") {
      $("f-currency-code").value = "QAR";
      $("f-currency-label").value = "QR";
      $("f-currency-decimals").value = "2";
    } else if (p === "INR") {
      $("f-currency-code").value = "INR";
      $("f-currency-label").value = "₹";
      $("f-currency-decimals").value = "2";
    }
    updateMoneyExample();
    markDirty();
  });

  $("reload-btn").addEventListener("click", async () => {
    if (state.dirty && !confirm("Discard unsaved changes?")) return;
    await loadShop();
    setStatus("Changes discarded.");
    refreshPreview();
  });
  $("preview-receipt-btn").addEventListener("click", refreshPreview);
  $("preview-mode").addEventListener("change", refreshPreview);
  $("upload-logo-btn").addEventListener("click", uploadLogo);
  $("clear-logo-btn").addEventListener("click", clearLogo);
  $("clear-orders-btn")?.addEventListener("click", clearTestOrders);

  window.addEventListener("beforeunload", (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = "";
  });

  $("add-order-type-btn").addEventListener("click", () => openOrderTypeDialog(null));
  $("ot-cancel").addEventListener("click", () => $("order-type-dialog").close());
  $("ot-behavior").addEventListener("change", syncOrderTypeHint);
  $("order-type-form").addEventListener("submit", saveOrderType);
  $("add-block-btn").addEventListener("click", () => openBlockDialog(null));
  $("br-cancel").addEventListener("click", () => $("block-rate-dialog").close());
  $("br-charge").addEventListener("blur", () => {
    const money = shopMoney();
    const raw = $("br-charge").value.trim();
    if (!raw) return;
    try {
      $("br-charge").value = money.formatPlain(money.parse(raw));
    } catch {
      /* leave the typed value so Save can show the error */
    }
  });
  $("br-tax")?.addEventListener("change", syncBlockTaxHint);
  $("block-rate-form").addEventListener("submit", saveBlockRate);
}

const FIELD_COPY = {
  COUNTER: "No extra fields.",
  TAKEAWAY: "No extra fields.",
  DELIVERY: "Requires a block number.",
  TABLE: "Requires a table number.",
  CAR_HOP: "Vehicle number and parking location are optional.",
};

function shopMoney() {
  return createMoneyFormatter(state.shop || {});
}

function syncOrderTypeHint() {
  const behavior = $("ot-behavior").value;
  $("ot-fields").textContent = FIELD_COPY[behavior] || "";
}

async function loadOrderDelivery() {
  const [types, rates] = await Promise.all([
    api("/v1/order-types"),
    api("/v1/block-delivery-rates"),
  ]);
  if (!types.ok || !rates.ok) {
    setStatus(types.json?.error || rates.json?.error || "Could not load order settings", false);
    return;
  }
  state.orderTypes = types.json.orderTypes || [];
  state.blockRates = rates.json.rates || [];
  if (types.json.deliveryChargeTax?.reason) {
    $("delivery-tax-note").textContent = types.json.deliveryChargeTax.reason;
  }
  renderOrderTypes();
  renderBlockRates();
}

function renderOrderTypes() {
  const root = $("order-type-list");
  root.replaceChildren();
  state.orderTypes.forEach((row, index) => {
    const item = document.createElement("div");
    item.className = "od-row";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = row.name;
    copy.append(title);
    if (!row.isActive) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = "Inactive";
      copy.append(pill);
    }
    const hint = document.createElement("p");
    hint.className = "hint";
    const fields = (row.fieldRequirements || []).map((field) => field.label);
    hint.textContent = fields.length
      ? `${row.behaviorLabel} · ${fields.join(", ")}`
      : `${row.behaviorLabel} · No extra fields`;
    copy.append(hint);

    const actions = document.createElement("div");
    actions.className = "od-actions";
    actions.append(
      iconButton("Up", index === 0, () => moveOrderType(index, -1)),
      iconButton("Down", index === state.orderTypes.length - 1, () => moveOrderType(index, 1)),
      iconButton("Edit", false, () => openOrderTypeDialog(row)),
      iconButton(row.isActive ? "Deactivate" : "Activate", false, () => toggleOrderType(row))
    );
    item.append(copy, actions);
    root.append(item);
  });
}

function renderBlockRates() {
  const root = $("block-rate-list");
  root.replaceChildren();
  const money = shopMoney();
  if (!state.blockRates.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No block charges yet.";
    root.append(empty);
    return;
  }
  state.blockRates.forEach((row) => {
    const item = document.createElement("div");
    item.className = "od-row";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `Block ${row.blockNumber}`;
    copy.append(title);
    if (!row.isActive) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = "Inactive";
      copy.append(pill);
    }
    const hint = document.createElement("p");
    hint.className = "hint";
    const taxLabel = row.taxApplicable ? "Taxable" : "No tax";
    hint.textContent = `${money.format(row.chargeCents)} · ${taxLabel}`;
    copy.append(hint);
    const actions = document.createElement("div");
    actions.className = "od-actions";
    actions.append(
      iconButton("Edit", false, () => openBlockDialog(row)),
      iconButton(row.isActive ? "Deactivate" : "Activate", false, () => toggleBlockRate(row))
    );
    item.append(copy, actions);
    root.append(item);
  });
}

function iconButton(label, disabled, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn ghost small";
  btn.textContent = label;
  btn.disabled = disabled;
  btn.addEventListener("click", onClick);
  return btn;
}

function openOrderTypeDialog(row) {
  state.editingTypeId = row?.orderTypeId || null;
  $("order-type-dialog-title").textContent = row ? "Edit order type" : "Add order type";
  $("ot-name").value = row?.name || "";
  $("ot-behavior").value = row?.behavior || "COUNTER";
  $("ot-behavior").disabled = Boolean(row?.behaviorLocked);
  $("ot-active").checked = row ? row.isActive : true;
  $("ot-error").hidden = true;
  syncOrderTypeHint();
  $("order-type-dialog").showModal();
}

function deliveryTaxHintText(taxable) {
  const shop = state.shop || {};
  if (!taxable) return "This delivery charge is not taxed.";
  if (!shop.taxEnabled) {
    return "Shop tax is off. This choice is saved and used when tax is turned on.";
  }
  const name = shop.taxName || "VAT";
  const rate = shop.taxRatePercent || "0";
  if (shop.taxMode === "inclusive") {
    return `The charge includes ${name} (${rate}%). The customer pays the amount you enter.`;
  }
  return `${name} (${rate}%) is added on top of this charge.`;
}

function syncBlockTaxHint() {
  $("br-tax-hint").textContent = deliveryTaxHintText($("br-tax").checked);
}

function openBlockDialog(row) {
  state.editingRateId = row?.rateId || null;
  $("block-dialog-title").textContent = row ? "Edit block charge" : "Add block charge";
  $("br-block").value = row?.blockNumber || "";
  const money = shopMoney();
  $("br-currency").textContent = state.shop?.currencyLabel || state.shop?.currencyCode || "";
  $("br-charge").value = row ? money.formatPlain(row.chargeCents) : "";
  $("br-tax").checked = row ? Boolean(row.taxApplicable) : true;
  $("br-active").checked = row ? row.isActive : true;
  $("br-error").hidden = true;
  syncBlockTaxHint();
  $("block-rate-dialog").showModal();
}

async function saveOrderType(event) {
  event.preventDefault();
  const body = {
    name: $("ot-name").value.trim(),
    behavior: $("ot-behavior").value,
    isActive: $("ot-active").checked,
  };
  if (state.editingTypeId) body.orderTypeId = state.editingTypeId;
  const res = await api("/v1/order-types", { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    $("ot-error").hidden = false;
    $("ot-error").textContent = res.json?.error || "Save failed";
    return;
  }
  $("order-type-dialog").close();
  setStatus(state.editingTypeId ? "Order type updated." : "Order type added.");
  await loadOrderDelivery();
}

async function toggleOrderType(row) {
  const res = await api("/v1/order-types", {
    method: "PUT",
    body: JSON.stringify({
      orderTypeId: row.orderTypeId,
      name: row.name,
      behavior: row.behavior,
      isActive: !row.isActive,
    }),
  });
  if (!res.ok) {
    setStatus(res.json?.error || "Could not update order type", false);
    return;
  }
  await loadOrderDelivery();
}

async function moveOrderType(index, delta) {
  const next = state.orderTypes.slice();
  const target = index + delta;
  if (target < 0 || target >= next.length) return;
  const [row] = next.splice(index, 1);
  next.splice(target, 0, row);
  const res = await api("/v1/order-types/reorder", {
    method: "PUT",
    body: JSON.stringify({ orderTypeIds: next.map((item) => item.orderTypeId) }),
  });
  if (!res.ok) {
    setStatus(res.json?.error || "Could not reorder", false);
    return;
  }
  state.orderTypes = res.json.orderTypes || next;
  renderOrderTypes();
}

async function saveBlockRate(event) {
  event.preventDefault();
  const money = shopMoney();
  let chargeCents;
  try {
    chargeCents = money.parse($("br-charge").value);
  } catch (err) {
    $("br-error").hidden = false;
    $("br-error").textContent = err.message || "Enter a valid charge";
    return;
  }
  if (chargeCents < 0) {
    $("br-error").hidden = false;
    $("br-error").textContent = "Delivery charge cannot be negative.";
    return;
  }
  const body = {
    blockNumber: $("br-block").value.trim(),
    chargeCents,
    taxApplicable: $("br-tax").checked,
    isActive: $("br-active").checked,
  };
  if (state.editingRateId) body.rateId = state.editingRateId;
  const res = await api("/v1/block-delivery-rates", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    $("br-error").hidden = false;
    $("br-error").textContent = res.json?.error || "Save failed";
    return;
  }
  $("block-rate-dialog").close();
  setStatus(state.editingRateId ? "Block charge updated." : "Block charge added.");
  await loadOrderDelivery();
}

async function toggleBlockRate(row) {
  const res = await api("/v1/block-delivery-rates", {
    method: "PUT",
    body: JSON.stringify({
      rateId: row.rateId,
      blockNumber: row.blockNumber,
      chargeCents: row.chargeCents,
      taxApplicable: Boolean(row.taxApplicable),
      isActive: !row.isActive,
    }),
  });
  if (!res.ok) {
    setStatus(res.json?.error || "Could not update block charge", false);
    return;
  }
  await loadOrderDelivery();
}

function escapeBank(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resetBankForm() {
  state.editingAccountId = null;
  $("bank-form-title").textContent = "Add bank account";
  $("bank-display-name").value = "";
  $("bank-name").value = "";
  $("bank-type").value = "OPERATIONAL";
  $("bank-reference").value = "";
  $("bank-active").checked = true;
  $("bank-cancel").hidden = true;
  $("bank-form-error").hidden = true;
}

function fillBankForm(account) {
  state.editingAccountId = account.accountId;
  $("bank-form-title").textContent = "Edit bank account";
  $("bank-display-name").value = account.displayName || "";
  $("bank-name").value = account.bankName || "";
  $("bank-type").value = account.accountType || "OPERATIONAL";
  $("bank-reference").value = account.maskedReference || "";
  $("bank-active").checked = account.isActive !== false;
  $("bank-cancel").hidden = false;
  $("bank-form-error").hidden = true;
}

function renderBankAccounts() {
  const list = $("bank-account-list");
  if (!state.bankAccounts.length) {
    list.innerHTML = `<p class="muted">No bank accounts yet.</p>`;
    return;
  }
  list.innerHTML = state.bankAccounts
    .map((account) => {
      const kind = account.accountType === "RESERVE" ? "Reserve" : "Operational";
      const status = account.isActive ? "Active" : "Inactive";
      const mask = account.maskedReference ? ` · ${escapeBank(account.maskedReference)}` : "";
      return `<article class="bank-account-card">
        <div>
          <strong>${escapeBank(account.displayName)}</strong>
          <p class="hint">${escapeBank(account.bankName)} · ${kind} · ${status}${mask}</p>
        </div>
        <div class="item-actions">
          <button type="button" class="btn ghost small" data-bank-edit="${escapeBank(account.accountId)}">Edit</button>
          <button type="button" class="btn ghost small" data-bank-toggle="${escapeBank(account.accountId)}">${account.isActive ? "Deactivate" : "Activate"}</button>
        </div>
      </article>`;
    })
    .join("");
}

async function loadBankAccounts() {
  const res = await api("/v1/bank-accounts?manage=1");
  if (!res.ok) {
    $("bank-account-list").innerHTML = `<p class="error">${escapeBank(res.json?.error || "Bank accounts could not be loaded.")}</p>`;
    return;
  }
  state.bankAccounts = res.json?.accounts || [];
  renderBankAccounts();
}

async function saveBankAccount() {
  const body = {
    displayName: $("bank-display-name").value.trim(),
    bankName: $("bank-name").value.trim(),
    accountType: $("bank-type").value,
    maskedReference: $("bank-reference").value.trim(),
    isActive: $("bank-active").checked,
  };
  const editing = state.editingAccountId;
  const res = await api(editing ? `/v1/bank-accounts/${encodeURIComponent(editing)}` : "/v1/bank-accounts", {
    method: editing ? "PUT" : "POST",
    body: JSON.stringify(body),
  });
  const error = $("bank-form-error");
  if (!res.ok) {
    error.hidden = false;
    error.textContent = res.json?.error || "The account could not be saved.";
    return;
  }
  resetBankForm();
  setStatus(editing ? "Bank account updated." : "Bank account added.");
  await loadBankAccounts();
}

async function toggleBankAccount(account) {
  const res = await api(`/v1/bank-accounts/${encodeURIComponent(account.accountId)}`, {
    method: "PUT",
    body: JSON.stringify({
      displayName: account.displayName,
      bankName: account.bankName,
      accountType: account.accountType,
      maskedReference: account.maskedReference || "",
      isActive: !account.isActive,
    }),
  });
  if (!res.ok) {
    setStatus(res.json?.error || "The account could not be updated.", false);
    return;
  }
  setStatus(account.isActive ? "Bank account deactivated." : "Bank account activated.");
  await loadBankAccounts();
}

bindUi();
bootstrap();
