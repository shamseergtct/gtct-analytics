import {
  createMoneyFormatter,
  estimateDeliveryFeeTax,
  estimateOrderTax,
  formatTaxPercentFromBps,
} from "./money.js";
import { registerPwa } from "./pwa.js";
import { formatSplitGroupTotalLabel, renderOrderLineItemHtml } from "./orderLineItems.js";
import { initVirtualKeyboard } from "./virtualKeyboard.js";
const DEFAULT_MODIFIERS = ["Less", "More", "No", "Extra"];
const DEFAULT_TARGETS = ["Sugar", "Sauce", "Onion", "Salt", "Ice", "Cheese"];

const SALES_VIEW_KEY_LEGACY = "gtct.salesView";
const SALES_VIEW_KEY_MOBILE = "gtct.salesView.mobile";
const SALES_VIEW_KEY_DESKTOP = "gtct.salesView.desktop";

function isMobileSalesUi() {
  return window.matchMedia("(max-width: 1023px)").matches;
}

function salesViewStorageKey() {
  return isMobileSalesUi() ? SALES_VIEW_KEY_MOBILE : SALES_VIEW_KEY_DESKTOP;
}

function normalizeSalesViewPrefs(raw) {
  return {
    density: raw?.density === "compact" ? "compact" : "comfortable",
    hidePhotos: Boolean(raw?.hidePhotos),
  };
}

function readSalesViewPrefs() {
  try {
    const key = salesViewStorageKey();
    let raw = JSON.parse(localStorage.getItem(key) || "null");
    // Old single key was only used from the mobile controls — keep it on mobile only.
    if (!raw && key === SALES_VIEW_KEY_MOBILE) {
      raw = JSON.parse(localStorage.getItem(SALES_VIEW_KEY_LEGACY) || "null");
    }
    if (!raw) return { density: "comfortable", hidePhotos: false };
    return normalizeSalesViewPrefs(raw);
  } catch {
    return { density: "comfortable", hidePhotos: false };
  }
}

function writeSalesViewPrefs(prefs) {
  const normalized = normalizeSalesViewPrefs(prefs);
  localStorage.setItem(salesViewStorageKey(), JSON.stringify(normalized));
}

function syncSalesViewForViewport() {
  const next = readSalesViewPrefs();
  const changed =
    next.density !== state.salesView.density ||
    next.hidePhotos !== state.salesView.hidePhotos;
  state.salesView = next;
  applySalesView();
  if (changed && $("menu-grid")) renderMenu();
}

const state = {
  role: null,
  staff: false,
  userId: "",
  username: "",
  fullName: "",
  permissions: [],
  payment: { orderId: "", confirming: false, fromPending: false, view: null, attempt: null, accounts: [] },
  pendingOrders: [],
  menu: [],
  stations: [],
  printers: [],
  category: "ALL",
  subcategory: "ALL",
  categories: [],
  subcategories: [],
  search: "",
  salesView: readSalesViewPrefs(),
  cart: [],
  activeShift: null,
  shiftSuggestedDate: "",
  activeSplit: 1,
  orderNumber: "",
  editingOrderId: null,
  submissionId: "",
  selectedMod: null,
  selectedTargets: [],
  editingLineId: null,
  lastOrderId: null,
  config: null,
  money: null,
  canAdjustAddonPrices: false,
  canAdjustBasePrices: false,
  orderTypes: [],
  blockRates: [],
  fulfillment: {
    customerId: "",
    addressId: "",
    addressLabel: "",
    customerName: "",
    customerPhone: "",
    buildingNumber: "",
    roadNumber: "",
    blockNumber: "",
    addressNote: "",
    tableNumber: "",
    vehicleNumber: "",
    parkingLocation: "",
    counterLabel: "",
    deliveryChargeCents: null,
    deliveryFeeOverride: false,
    expectedBlockRateCents: null,
  },
  sending: false,
  customizeDraft: null, // { lineId, isNew, quantity, instructions, addons, note, priceText, ... }
  customizeTab: "notes",
  kitchenStep: 1,
  priceBreakdownOpen: false,
  cartPriceBreakdownOpen: false,
  _customizeTrigger: null,
  variantPickerItem: null,
  pkItem: null,
  pkTab: "about",
  pkPayload: null,
  _pkTrigger: null,
  cartDrawerOpen: false,
  navMenuOpen: false,
  stockMode: false,
  layoutEditMode: false,
  _layoutDrag: null,
  _layoutSaveTimer: null,
  virtualKeyboard: null,
  virtualKeyboardOn: true,
  callerPollTimer: null,
  callerSeenAt: "",
  callerPayload: null,
  addingLock: false,
  cartFocusLineId: null,
  cartFollowLatest: false,
  _cartTrigger: null,
  _navTrigger: null,
  _scrollLockY: 0,
  _cartProgrammaticScroll: false,
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  let json = null;
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { ok: res.ok, status: res.status, json };
}

function newSubmissionId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function fallbackOrderNumber() {
  const stamp = Date.now().toString(36);
  const suffix = newSubmissionId().replace(/-/g, "").slice(0, 8);
  return `TEST-UI-${stamp}-${suffix}`;
}

function showOrderNumber() {
  const field = $("order-number");
  const label = $("order-number-label");
  const display = $("order-number-display");
  if (label) label.textContent = state.editingOrderId ? "Editing" : "Draft";
  const value = state.orderNumber || "—";
  if (display) display.textContent = value;
  if (!field) return;
  field.value = state.orderNumber || "";
  field.title = state.editingOrderId
    ? "This accepted order is open for editing. Review and save to keep the changes."
    : state.orderNumber
      ? "Next order number, shared by every screen. It advances by one when an order is accepted."
      : "";
}

function titleCaseLabel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.toUpperCase() === "ALL") return "All";
  return raw
    .toLowerCase()
    .split(/([\s/_-]+)/)
    .map((part, i) =>
      i % 2 === 1 ? part : part ? part.charAt(0).toUpperCase() + part.slice(1) : part
    )
    .join("");
}

function cartQtyForMenuItem(item) {
  const id = item?.item_id;
  if (!id) return 0;
  let qty = 0;
  for (const line of state.cart) {
    if (line.itemId === id || line.item_id === id) qty += Number(line.quantity) || 0;
  }
  return qty;
}

function adjustMenuItemCartQty(item, delta) {
  if (!item || state.addingLock) return;
  if (delta > 0) {
    // "+" is a quick add. Items with sizes still ask for the size; notes/extras
    // stay one tap away by tapping the item row (onMenuItemTap).
    if (!item.hasVariants && item.is_active && !item.is_sold_out) {
      addToCart(item, null);
      return;
    }
    onMenuItemTap(item);
    return;
  }
  const id = item.item_id;
  for (let i = state.cart.length - 1; i >= 0; i -= 1) {
    const line = state.cart[i];
    if (line.itemId !== id && line.item_id !== id) continue;
    if (Number(line.quantity || 0) <= 1) {
      const removed = state.cart[i];
      state.cart.splice(i, 1);
      if (removed) showCartUndo(removed);
    } else {
      line.quantity -= 1;
    }
    renderCart();
    renderMenu();
    return;
  }
}

let cartUndoTimer = null;
let cartUndoSnapshot = null;

function hideCartUndo() {
  if (cartUndoTimer) {
    clearTimeout(cartUndoTimer);
    cartUndoTimer = null;
  }
  cartUndoSnapshot = null;
  const bar = $("cart-undo-bar");
  if (bar) bar.hidden = true;
}

function showCartUndo(line) {
  hideCartUndo();
  cartUndoSnapshot = structuredClone
    ? structuredClone(line)
    : JSON.parse(JSON.stringify(line));
  const bar = $("cart-undo-bar");
  const text = $("cart-undo-text");
  if (text) text.textContent = `Removed “${line.name}”`;
  if (bar) bar.hidden = false;
  cartUndoTimer = setTimeout(() => {
    hideCartUndo();
  }, 5000);
}

function undoCartRemove() {
  if (!cartUndoSnapshot) return;
  const line = cartUndoSnapshot;
  hideCartUndo();
  state.cart.push(line);
  focusCartLine(line.lineId, { follow: true });
  renderCart();
  renderMenu();
  void syncDraftNumber();
}

let draftNumberTimer = null;
let reviewNumberTimer = null;
let draftSyncSeq = 0;

function shopSequenceValue(orderNumber) {
  const match = /^TEST-UI-(\d{6})$/.exec(String(orderNumber || ""));
  return match ? Number(match[1]) : null;
}

async function allocateDisplayNumber() {
  const res = await api("/v1/order-numbers", { method: "POST", body: "{}" });
  if (res.ok && res.json?.orderNumber) return res.json.orderNumber;
  return "";
}

async function syncDraftNumber() {
  if (state.sending || state.editingOrderId) return;
  const seq = ++draftSyncSeq;
  const next = await allocateDisplayNumber();
  if (seq !== draftSyncSeq || !next || next === state.orderNumber) return;
  const currentValue = shopSequenceValue(state.orderNumber);
  const nextValue = shopSequenceValue(next);
  if (currentValue != null && nextValue != null && nextValue < currentValue) return;
  state.orderNumber = next;
  showOrderNumber();
  if ($("review-dialog")?.open) paintReview();
  if (cartHasItems()) persistActiveCart();
}

function draftNumberTick() {
  if ($("main-view")?.hidden || state.sending) return;
  void syncDraftNumber();
}

function startDraftNumberSync() {
  if (draftNumberTimer) return;
  draftNumberTimer = setInterval(draftNumberTick, 1000);
  document.addEventListener("visibilitychange", draftNumberTick);
  window.addEventListener("focus", draftNumberTick);
}

function stopDraftNumberSync() {
  if (draftNumberTimer) {
    clearInterval(draftNumberTimer);
    draftNumberTimer = null;
  }
  document.removeEventListener("visibilitychange", draftNumberTick);
  window.removeEventListener("focus", draftNumberTick);
  if (reviewNumberTimer) {
    clearInterval(reviewNumberTimer);
    reviewNumberTimer = null;
  }
}

function watchReviewNumber() {
  if (reviewNumberTimer) return;
  reviewNumberTimer = setInterval(() => {
    if (!$("review-dialog")?.open) {
      clearInterval(reviewNumberTimer);
      reviewNumberTimer = null;
      return;
    }
    void syncDraftNumber();
  }, 500);
}

async function ensureDraftIdentity({ fresh = false } = {}) {
  if (fresh || !state.submissionId) state.submissionId = newSubmissionId();
  const next = await allocateDisplayNumber();
  if (next) state.orderNumber = next;
  else if (!state.orderNumber) state.orderNumber = fallbackOrderNumber();
  showOrderNumber();
}

function showLogin(error = "") {
  stopDraftNumberSync();
  stopCallerIdPolling();
  closePaymentUi();
  cancelLayoutDrag();
  state.layoutEditMode = false;
  document.body.classList.remove("menu-layout-edit");
  $("login-view").hidden = false;
  $("main-view").hidden = true;
  setLoginError(error);
  const callerBtn = $("caller-id-btn");
  if (callerBtn) callerBtn.hidden = true;
}

function applySession(data) {
  state.role = data?.role || null;
  state.deviceId = data?.deviceId || "";
  state.staff = Boolean(data?.staff);
  state.userId = data?.userId || "";
  state.username = data?.username || "";
  state.fullName = data?.fullName || "";
  state.permissions = Array.isArray(data?.permissions) ? data.permissions : [];
  if (data && Object.prototype.hasOwnProperty.call(data, "canAdjustAddonPrices")) {
    state.canAdjustAddonPrices = Boolean(data.canAdjustAddonPrices);
  }
  if (data && Object.prototype.hasOwnProperty.call(data, "canAdjustBasePrices")) {
    state.canAdjustBasePrices = Boolean(data.canAdjustBasePrices);
  }
}

function showMain() {
  $("login-view").hidden = true;
  $("main-view").hidden = false;
  $("session-role").textContent = state.fullName || state.role || "";
  const isAdmin = state.role === "admin";
  const settingsLink = $("settings-link");
  const shopSettingsLink = $("shop-settings-link");
  const menuLink = $("menu-setup-link");
  const usersLink = $("users-link");
  const terminalsLink = $("terminals-link");
  const reportsLink = $("reports-link");
  const ordersLink = $("orders-link");
  const prepLink = $("prep-link");
  if (settingsLink) settingsLink.hidden = !isAdmin;
  if (shopSettingsLink) shopSettingsLink.hidden = !isAdmin;
  if (menuLink) menuLink.hidden = !isAdmin;
  const canManageUsers = Boolean(state.staff && state.permissions.includes("staff.manage"));
  if (usersLink) usersLink.hidden = !canManageUsers;
  if (terminalsLink) terminalsLink.hidden = !canManageUsers;
  const canViewReports = Boolean(
    isAdmin ||
      (state.staff &&
        (state.permissions.includes("sales.orders.view") ||
          state.permissions.includes("sales.payment.receive")))
  );
  if (reportsLink) reportsLink.hidden = !canViewReports;
  if (ordersLink) {
    ordersLink.hidden = !(state.staff && state.permissions.includes("sales.orders.view"));
  }
  if (prepLink) {
    prepLink.hidden = !(state.role === "admin" || (state.staff && state.permissions.includes("prep.station.work")));
  }
  // P2-E3C2: delivery links live under Settings; APIs still enforce permissions.
  const deliveryMenu = $("delivery-management");
  const canCash = state.staff && ["admin", "cashier"].includes(state.role) &&
    state.permissions.includes("sales.payment.receive");
  const canCommission = state.role === "admin" && state.staff &&
    state.permissions.includes("staff.manage");
  const showDelivery = Boolean(canCash || canCommission);
  if (deliveryMenu) deliveryMenu.hidden = !showDelivery;
  const commissionLink = $("delivery-commission-link");
  const commissionInstalled = commissionLink?.dataset.installed === "yes";
  if (commissionLink) commissionLink.hidden = !canCommission || !commissionInstalled;
  const commissionUnavailable = $("delivery-commission-unavailable");
  if (commissionUnavailable) commissionUnavailable.hidden = !canCommission || commissionInstalled;
  const settingsMenu = $("settings-menu");
  if (settingsMenu) {
    settingsMenu.hidden = !(isAdmin || canManageUsers || showDelivery || canViewReports);
    settingsMenu.open = false;
  }
  const accountMenu = $("account-menu");
  if (accountMenu) accountMenu.open = false;
  setNavMenu(false);
  ensureSalesViewControls();
  startDraftNumberSync();
  startCallerIdPolling();
  void refreshPendingCount();
  void loadBusinessShift();
  void consumeCallerQueryParam();
}

function canUseCallerId() {
  return Boolean(
    state.staff &&
      (state.role === "admin" ||
        state.permissions.includes("sales.order.create") ||
        state.permissions.includes("customers.manage"))
  );
}

function stopCallerIdPolling() {
  if (state.callerPollTimer) {
    window.clearInterval(state.callerPollTimer);
    state.callerPollTimer = null;
  }
}

function startCallerIdPolling() {
  stopCallerIdPolling();
  const btn = $("caller-id-btn");
  if (btn) btn.hidden = !canUseCallerId();
  if (!canUseCallerId()) return;
  void pollCallerId({ openIfNew: true });
  state.callerPollTimer = window.setInterval(() => {
    void pollCallerId({ openIfNew: true });
  }, 2500);
}

function formatCallerAddress(customer) {
  if (!customer) return "";
  return [
    customer.blockNumber ? `Block ${customer.blockNumber}` : "",
    customer.buildingNumber ? `Bldg ${customer.buildingNumber}` : "",
    customer.roadNumber ? `Road ${customer.roadNumber}` : "",
    customer.addressNote || "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderCallerIdDialog(payload) {
  const call = payload?.call || null;
  const customer = payload?.customer || null;
  const status = $("caller-id-status");
  const name = $("caller-id-name");
  const phone = $("caller-id-phone");
  const address = $("caller-id-address");
  const useBtn = $("caller-id-use");
  const input = $("caller-id-input");
  const err = $("caller-id-error");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  if (input && call?.phone && input.value.trim() !== call.phone) {
    input.value = call.phone;
  }
  if (customer) {
    if (status) {
      status.textContent = "Saved customer";
      status.dataset.tone = "known";
    }
    if (name) name.textContent = customer.name || "Saved customer";
    if (phone) phone.textContent = customer.phone || call?.phone || "—";
    const line = formatCallerAddress(customer);
    if (address) {
      address.hidden = !line;
      address.textContent = line;
    }
    if (useBtn) useBtn.disabled = false;
  } else {
    if (status) {
      status.textContent = call?.phone ? "New caller" : "Enter a number";
      status.dataset.tone = "new";
    }
    if (name) name.textContent = call?.phone ? "Unknown caller" : "No caller yet";
    if (phone) phone.textContent = call?.phone || "—";
    if (address) {
      address.hidden = true;
      address.textContent = "";
    }
    if (useBtn) useBtn.disabled = !call?.phone;
  }
  const btn = $("caller-id-btn");
  const dot = $("caller-id-dot");
  const ringing = Boolean(call?.phone);
  if (btn) btn.classList.toggle("is-ringing", ringing && Boolean(customer));
  if (dot) dot.hidden = !ringing;
}

function openCallerIdDialog(payload) {
  if (payload) {
    state.callerPayload = payload;
    renderCallerIdDialog(payload);
  } else {
    renderCallerIdDialog(state.callerPayload);
  }
  const dialog = $("caller-id-dialog");
  if (dialog && !dialog.open) dialog.showModal();
  $("caller-id-input")?.focus();
}

function closeCallerIdDialog() {
  const dialog = $("caller-id-dialog");
  if (dialog?.open) dialog.close();
}

async function pollCallerId({ openIfNew = false } = {}) {
  if (!canUseCallerId()) return;
  const res = await api("/v1/caller-id/latest");
  if (!res.ok) return;
  const payload = {
    call: res.json?.call || null,
    customer: res.json?.customer || null,
  };
  const receivedAt = payload.call?.receivedAt || "";
  const isNew = Boolean(receivedAt && receivedAt !== state.callerSeenAt);
  state.callerPayload = payload;
  renderCallerIdDialog(payload);
  if (openIfNew && isNew && payload.call?.phone) {
    state.callerSeenAt = receivedAt;
    openCallerIdDialog(payload);
    setStatus(
      payload.customer
        ? `Incoming: ${payload.customer.name} · ${payload.call.phone}`
        : `Incoming call · ${payload.call.phone}`
    );
  } else if (receivedAt) {
    state.callerSeenAt = receivedAt;
  }
}

async function lookupCallerFromInput() {
  const input = $("caller-id-input");
  const err = $("caller-id-error");
  const phone = String(input?.value || "").trim();
  if (!phone) {
    if (err) {
      err.hidden = false;
      err.textContent = "Enter a phone number.";
    }
    return;
  }
  const res = await api("/v1/caller-id/incoming", {
    method: "POST",
    body: JSON.stringify({ phone, source: "manual" }),
  });
  if (!res.ok) {
    if (err) {
      err.hidden = false;
      err.textContent = res.json?.error || "Could not look up caller.";
    }
    return;
  }
  state.callerPayload = {
    call: res.json?.call || null,
    customer: res.json?.customer || null,
  };
  state.callerSeenAt = state.callerPayload.call?.receivedAt || state.callerSeenAt;
  renderCallerIdDialog(state.callerPayload);
  setStatus(
    state.callerPayload.customer
      ? `Found ${state.callerPayload.customer.name}`
      : "Number not saved yet — you can still use it on the order."
  );
}

async function useCallerOnOrder() {
  const payload = state.callerPayload;
  const call = payload?.call;
  const customer = payload?.customer;
  if (!call?.phone) return;

  // Prefer Delivery when applying a phone caller.
  const delivery = (state.orderTypes || []).find(
    (row) => row.isActive !== false && String(row.behavior || "").toUpperCase() === "DELIVERY"
  );
  if (delivery) {
    const select = $("order-type");
    if (select) select.value = delivery.orderTypeId;
    renderOrderTypeQuickButtons();
    renderFulfillmentFields();
  }

  if (customer?.customerId) {
    selectCustomer(customer);
  } else {
    state.fulfillment.customerId = "";
    state.fulfillment.customerName = "";
    state.fulfillment.customerPhone = call.phone;
    normalizeFulfillmentCustomerFields();
    renderFulfillmentFields();
    renderCart();
    persistActiveCart();
  }
  closeCallerIdDialog();
  await api("/v1/caller-id/clear", { method: "POST", body: "{}" });
  state.callerPayload = null;
  renderCallerIdDialog(null);
  setStatus(
    customer?.name
      ? `Caller applied: ${customer.name}`
      : `Caller number applied: ${call.phone}`
  );
}

async function dismissCallerId() {
  closeCallerIdDialog();
  await api("/v1/caller-id/clear", { method: "POST", body: "{}" });
  state.callerPayload = null;
  state.callerSeenAt = "";
  renderCallerIdDialog(null);
}

async function consumeCallerQueryParam() {
  try {
    const url = new URL(window.location.href);
    const phone = String(url.searchParams.get("caller") || "").trim();
    if (!phone || !canUseCallerId()) return;
    url.searchParams.delete("caller");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    const res = await api("/v1/caller-id/incoming", {
      method: "POST",
      body: JSON.stringify({ phone, source: "url" }),
    });
    if (!res.ok) return;
    state.callerPayload = {
      call: res.json?.call || null,
      customer: res.json?.customer || null,
    };
    state.callerSeenAt = state.callerPayload.call?.receivedAt || "";
    openCallerIdDialog(state.callerPayload);
  } catch {
    /* ignore */
  }
}

async function loadBusinessShift() {
  const menu = $("shift-menu");
  const label = $("shift-chip-label");
  const detail = $("shift-menu-detail");
  const openBtn = $("shift-open-btn");
  const closeBtn = $("shift-close-btn");
  const changeBtn = $("shift-change-btn");
  if (!menu || !label) return;

  const canView = Boolean(
    state.staff &&
      (state.role === "admin" ||
        state.permissions.includes("sales.orders.view") ||
        state.permissions.includes("sales.order.create"))
  );
  menu.hidden = !canView;
  if (!canView) return;

  const res = await api("/v1/business-shift");
  if (!res.ok) {
    state.activeShift = null;
    label.textContent = "Shift · —";
    if (detail) detail.textContent = res.json?.error || "Could not load shift.";
    return;
  }
  const active = res.json?.active || null;
  state.activeShift = active;
  state.shiftSuggestedDate = res.json?.suggestedBusinessDate || "";
  const isAdmin = state.role === "admin";

  if (active) {
    label.textContent = `Shift · ${active.businessDate}`;
    if (detail) {
      detail.textContent = `Open until closed. Sales stay on ${active.businessDate} (even after midnight). Next token ${String(active.nextTokenNumber).padStart(3, "0")}.`;
    }
  } else {
    label.textContent = "No shift";
    if (detail) {
      detail.textContent = res.json?.requiresManualStart
        ? "Open a shift to take orders. Reports use the shift business date."
        : "No open shift yet. First sale can auto-open a TEST shift, or Admin can open one.";
    }
  }

  if (openBtn) openBtn.hidden = !(isAdmin && !active);
  if (closeBtn) closeBtn.hidden = !(isAdmin && active);
  if (changeBtn) changeBtn.hidden = !(isAdmin && active);
}

function localTimeValue(date = new Date()) {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function closeShiftMenu() {
  const menu = $("shift-menu");
  if (menu) menu.open = false;
}

function closeShiftDialog() {
  const dialog = $("shift-dialog");
  if (dialog?.open) dialog.close();
  const err = $("shift-dialog-error");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
}

function openShiftDialog(mode) {
  if (state.role !== "admin") return;
  const dialog = $("shift-dialog");
  if (!dialog) return;
  state._shiftDialogMode = mode === "change" ? "change" : "open";
  const title = $("shift-dialog-title");
  const confirmBtn = $("shift-dialog-confirm");
  const current = $("shift-dialog-current");
  const dateInput = $("shift-dialog-date");
  const timeInput = $("shift-dialog-time");
  const err = $("shift-dialog-error");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }

  if (state._shiftDialogMode === "change" && state.activeShift) {
    if (title) title.textContent = "Change shift";
    if (confirmBtn) confirmBtn.textContent = "Change shift";
    if (current) {
      current.hidden = false;
      current.textContent = `Current business date: ${state.activeShift.businessDate}. Sales after midnight still count on that date until you change.`;
    }
    if (dateInput) dateInput.value = state.shiftSuggestedDate || state.activeShift.businessDate;
  } else {
    if (title) title.textContent = "Open shift";
    if (confirmBtn) confirmBtn.textContent = "Open shift";
    if (current) {
      current.hidden = true;
      current.textContent = "";
    }
    if (dateInput) dateInput.value = state.shiftSuggestedDate || "";
  }
  if (timeInput) timeInput.value = localTimeValue();
  closeShiftMenu();
  if (typeof dialog.showModal === "function") dialog.showModal();
  dateInput?.focus();
}

async function confirmShiftDialog() {
  if (state.role !== "admin") return;
  const dateInput = $("shift-dialog-date");
  const timeInput = $("shift-dialog-time");
  const err = $("shift-dialog-error");
  const businessDate = String(dateInput?.value || "").trim();
  const startTime = String(timeInput?.value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    if (err) {
      err.hidden = false;
      err.textContent = "Choose a business date.";
    }
    return;
  }
  if (startTime && !/^\d{2}:\d{2}$/.test(startTime)) {
    if (err) {
      err.hidden = false;
      err.textContent = "Choose a valid start time.";
    }
    return;
  }

  const changing = state._shiftDialogMode === "change";
  if (changing) {
    if (!state.activeShift) return;
    if (businessDate === state.activeShift.businessDate) {
      if (err) {
        err.hidden = false;
        err.textContent = "Pick a different business date to change shift.";
      }
      return;
    }
    const shiftId = state.activeShift.shiftId;
    const closeRes = await api("/v1/business-shift/close", {
      method: "POST",
      body: JSON.stringify({ shiftId, confirm: true }),
    });
    if (!closeRes.ok) {
      if (err) {
        err.hidden = false;
        err.textContent = closeRes.json?.error || "Could not close current shift.";
      }
      return;
    }
    state.activeShift = null;
  }

  const res = await api("/v1/business-shift/open", {
    method: "POST",
    body: JSON.stringify({
      businessDate,
      ...(startTime ? { startTime } : {}),
    }),
  });
  if (!res.ok) {
    if (err) {
      err.hidden = false;
      err.textContent = res.json?.error || "Could not open shift.";
    }
    await loadBusinessShift();
    return;
  }
  closeShiftDialog();
  const timeNote = startTime ? ` · ${startTime}` : "";
  showToast(
    changing
      ? `Shift changed to ${businessDate}${timeNote}. New sales use this date.`
      : `Shift opened · ${businessDate}${timeNote}`,
    { duration: 2500 }
  );
  await loadBusinessShift();
}

async function closeBusinessShiftFlow() {
  if (state.role !== "admin" || !state.activeShift) return false;
  const date = state.activeShift.businessDate;
  const ok = window.confirm(
    `Close shift ${date}?\n\nNew orders will be blocked until you open (or change to) another shift.\nSales already taken stay on ${date} in reports.\nThis does NOT settle cash or payments.`
  );
  if (!ok) return false;
  const res = await api("/v1/business-shift/close", {
    method: "POST",
    body: JSON.stringify({ shiftId: state.activeShift.shiftId, confirm: true }),
  });
  if (!res.ok) {
    showToast(res.json?.error || "Could not close shift.", { duration: 2500 });
    return false;
  }
  showToast(`Shift ${date} closed.`, { duration: 2000 });
  closeShiftMenu();
  await loadBusinessShift();
  return true;
}

function redirectKitchenToPreparation() {
  if (state.role !== "kitchen" && state.role !== "delivery") return false;
  // Restricted staff never initialize the POS.
  window.location.replace(state.role === "delivery" ? "/delivery-pool.html" : "/prep.html");
  return true;
}

async function ensureSession() {
  const me = await api("/v1/session/me");
  if (!me.ok || !me.json?.authenticated) {
    showLogin();
    return false;
  }
  applySession(me.json);
  if (redirectKitchenToPreparation()) return false;
  showMain();
  return true;
}

function setLoginError(message = "") {
  const el = $("login-error");
  el.hidden = !message;
  el.textContent = message || "";
}

async function login() {
  const usernameInput = $("login-username");
  const passwordInput = $("login-password");
  const username = String(usernameInput?.value || "").trim();
  const password = String(passwordInput?.value || "");
  if (!username || !password) {
    setLoginError("Enter your username and password.");
    (username ? passwordInput : usernameInput)?.focus();
    return;
  }
  const btn = $("login-btn");
  setLoginError("");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  btn.setAttribute("aria-busy", "true");
  try {
    const res = await api("/v1/session/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      setLoginError(res.json?.error || "Sign-in failed");
      return;
    }

    const me = await api("/v1/session/me");
    if (!me.ok || !me.json?.authenticated) {
      setLoginError(
        "Signed in, but the session cookie was not kept. Use http://127.0.0.1:8787/ (not localhost) and try again."
      );
      return;
    }

    passwordInput.value = "";
    applySession(me.json);
    setLoginError("");
    if (redirectKitchenToPreparation()) return;
    showMain();
    await bootstrapData();
  } catch (err) {
    setLoginError(err.message || "Sign-in failed");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
    btn.removeAttribute("aria-busy");
  }
}

const CART_ACTIVE_KEY = "gtct.sales.activeCart.v1";
const CART_HELD_KEY_LEGACY = "gtct.sales.heldCart.v1";
const CART_HELD_LIST_KEY = "gtct.sales.heldCarts.v2";

function cartHasItems() {
  return Array.isArray(state.cart) && state.cart.length > 0;
}

function readCartStorage(key) {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.cart)) return null;
    return data;
  } catch {
    return null;
  }
}

function writeCartStorage(key, snapshot) {
  try {
    if (!snapshot || !snapshot.cart?.length) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, JSON.stringify(snapshot));
  } catch {
    /* ignore quota / private mode */
  }
}

function clearCartStorage(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function readHeldCartList() {
  try {
    migrateLegacyHeldCart();
    const raw = sessionStorage.getItem(CART_HELD_LIST_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((h) => h && Array.isArray(h.cart) && h.cart.length > 0);
  } catch {
    return [];
  }
}

function writeHeldCartList(list) {
  try {
    const clean = (Array.isArray(list) ? list : []).filter(
      (h) => h && Array.isArray(h.cart) && h.cart.length > 0
    );
    if (!clean.length) {
      sessionStorage.removeItem(CART_HELD_LIST_KEY);
      return;
    }
    sessionStorage.setItem(CART_HELD_LIST_KEY, JSON.stringify(clean));
  } catch {
    /* ignore */
  }
}

function migrateLegacyHeldCart() {
  try {
    const legacy = readCartStorage(CART_HELD_KEY_LEGACY);
    if (!legacy?.cart?.length) return;
    const existing = (() => {
      try {
        const raw = sessionStorage.getItem(CART_HELD_LIST_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch {
        return [];
      }
    })();
    const list = Array.isArray(existing) ? existing : [];
    list.unshift({
      ...legacy,
      holdId: `hold_legacy_${legacy.savedAt || Date.now()}`,
      holdLabel: legacy.holdLabel || legacy.orderNumber || "Held order",
    });
    sessionStorage.setItem(CART_HELD_LIST_KEY, JSON.stringify(list));
    sessionStorage.removeItem(CART_HELD_KEY_LEGACY);
  } catch {
    /* ignore */
  }
}

function captureCartSnapshot() {
  return {
    version: 1,
    savedAt: Date.now(),
    orderNumber: state.orderNumber || "",
    editingOrderId: state.editingOrderId || null,
    submissionId: state.submissionId || "",
    orderType: $("order-type")?.value || "",
    fulfillment: { ...state.fulfillment },
    lastOrderId: state.lastOrderId || null,
    activeSplit: lineSplitNo({ splitNo: state.activeSplit }),
    cart: state.cart.map((line) => ({
      ...line,
      instructions: [...(line.instructions || [])],
      addons: (line.addons || []).map((a) => ({ ...a })),
      availableAddons: (line.availableAddons || []).map((a) => ({ ...a })),
      instructionModifiers: [...(line.instructionModifiers || [])],
      instructionTargets: [...(line.instructionTargets || [])],
      instructionStandalone: [...(line.instructionStandalone || [])],
      stationIds: [...(line.stationIds || [])],
    })),
  };
}

function applyCartSnapshot(snapshot) {
  if (!snapshot) return false;
  state.cart = (Array.isArray(snapshot.cart) ? snapshot.cart : []).map(
    (line) => ({
      ...line,
      configuredPriceCents:
        line.configuredPriceCents != null
          ? Number(line.configuredPriceCents)
          : Number(line.priceCents || 0),
      basePriceAdjusted: Boolean(line.basePriceAdjusted),
      splitNo: lineSplitNo(line),
    })
  );
  const savedSplit = Number(snapshot.activeSplit);
  state.activeSplit =
    Number.isInteger(savedSplit) && savedSplit >= 1
      ? savedSplit
      : Math.max(1, ...state.cart.map((line) => lineSplitNo(line)));
  state.orderNumber = snapshot.orderNumber || "";
  state.editingOrderId = snapshot.editingOrderId || null;
  state.submissionId = snapshot.submissionId || state.submissionId || "";
  state.lastOrderId = snapshot.lastOrderId || null;
  showOrderNumber();
  if (snapshot.fulfillment && typeof snapshot.fulfillment === "object") {
    state.fulfillment = { ...blankFulfillment(), ...snapshot.fulfillment };
    normalizeFulfillmentCustomerFields();
  }
  if ($("order-type") && snapshot.orderType) {
    const known = (state.orderTypes || []).some((row) => row.orderTypeId === snapshot.orderType);
    if (known) $("order-type").value = snapshot.orderType;
    else {
      const byCode = (state.orderTypes || []).find((row) => row.code === snapshot.orderType);
      if (byCode) $("order-type").value = byCode.orderTypeId;
    }
  }
  renderFulfillmentFields();
  focusCartLine(null);
  return state.cart.length > 0;
}

function persistActiveCart() {
  if (!cartHasItems()) {
    clearCartStorage(CART_ACTIVE_KEY);
    return;
  }
  writeCartStorage(CART_ACTIVE_KEY, captureCartSnapshot());
}

function restoreActiveCartIfAny() {
  const snap = readCartStorage(CART_ACTIVE_KEY);
  if (!snap?.cart?.length) return false;
  applyCartSnapshot(snap);
  return true;
}

function nextDefaultHoldLabel() {
  const list = readHeldCartList();
  let n = list.length + 1;
  const used = new Set(
    list.map((h) => String(h.holdLabel || "").trim().toLowerCase())
  );
  while (used.has(`hold ${n}`)) n += 1;
  return `Hold ${n}`;
}

function updateHeldCartUi() {
  const holdBtn = $("hold-cart-btn");
  const panel = $("held-cart-panel");
  const listHost = $("held-cart-list");
  const countEl = $("held-cart-count");
  if (holdBtn) holdBtn.hidden = !cartHasItems();
  const held = readHeldCartList();
  if (!panel || !listHost) return;
  if (!held.length) {
    panel.hidden = true;
    listHost.innerHTML = "";
    return;
  }
  panel.hidden = false;
  if (countEl) {
    countEl.textContent = `${held.length} held`;
  }
  listHost.innerHTML = "";
  for (const entry of held) {
    const itemCount = entry.cart.reduce(
      (n, l) => n + Number(l.quantity || 0),
      0
    );
    const row = document.createElement("div");
    row.className = "held-cart-row";
    row.innerHTML = `
      <div class="held-cart-row-info">
        <strong class="held-cart-name">${escapeHtml(entry.holdLabel || "Held")}</strong>
        <span class="muted">${escapeHtml(entry.orderNumber || "")} · ${itemCount} item${
          itemCount === 1 ? "" : "s"
        }</span>
      </div>
      <div class="held-cart-actions">
        <button type="button" class="btn ghost small" data-act="resume">Resume</button>
        <button type="button" class="btn ghost small" data-act="discard">Discard</button>
      </div>
    `;
    row.querySelector('[data-act="resume"]').addEventListener("click", () => {
      resumeHeldCart(entry.holdId);
    });
    row.querySelector('[data-act="discard"]').addEventListener("click", () => {
      discardHeldCart(entry.holdId);
    });
    listHost.appendChild(row);
  }
}

function confirmLeaveCart(actionLabel = "continue") {
  if (!cartHasItems()) return true;
  return window.confirm(
    `Cart has items. ${actionLabel} will discard the current cart.\n\nUse Hold to keep it, Clear to empty it, or OK to discard and ${actionLabel.toLowerCase()}.`
  );
}

function emptyCart({ status = "", clearPersisted = true } = {}) {
  state.cart = [];
  state.editingOrderId = null;
  state.activeSplit = 1;
  focusCartLine(null);
  showOrderNumber();
  if (clearPersisted) clearCartStorage(CART_ACTIVE_KEY);
  renderCart();
  if (status) setStatus(status);
}

function openHoldDialog() {
  if (!cartHasItems()) {
    setStatus("Cart is empty — nothing to hold.", false);
    return;
  }
  const input = $("hold-label-input");
  const err = $("hold-dialog-error");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  if (input) {
    input.value = nextDefaultHoldLabel();
  }
  const dialog = $("hold-dialog");
  if (dialog && typeof dialog.showModal === "function") {
    dialog.showModal();
    input?.focus();
    input?.select();
  }
}

function closeHoldDialog() {
  const dialog = $("hold-dialog");
  if (dialog?.open) dialog.close();
}

function confirmHoldCart() {
  if (!cartHasItems()) {
    closeHoldDialog();
    return;
  }
  const input = $("hold-label-input");
  const err = $("hold-dialog-error");
  const label = String(input?.value || "").trim();
  if (!label) {
    if (err) {
      err.hidden = false;
      err.textContent = "Enter a hold name or number.";
    }
    input?.focus();
    return;
  }
  if (label.length > 40) {
    if (err) {
      err.hidden = false;
      err.textContent = "Hold name must be 40 characters or fewer.";
    }
    return;
  }
  const list = readHeldCartList();
  const dup = list.some(
    (h) => String(h.holdLabel || "").trim().toLowerCase() === label.toLowerCase()
  );
  if (dup) {
    if (err) {
      err.hidden = false;
      err.textContent = "That hold name is already in use. Choose another.";
    }
    input?.focus();
    return;
  }
  const snap = captureCartSnapshot();
  list.unshift({
    ...snap,
    holdId: `hold_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    holdLabel: label,
  });
  writeHeldCartList(list);
  closeHoldDialog();
  state.submissionId = "";
  state.orderNumber = "";
  emptyCart({ status: `Held as “${label}”. Safe to refresh or leave Sales.` });
  void ensureDraftIdentity({ fresh: true });
  showToast(`Held: ${label}`);
  updateHeldCartUi();
}

function holdActiveCart() {
  openHoldDialog();
}

function resumeHeldCart(holdId) {
  const list = readHeldCartList();
  const held = list.find((h) => h.holdId === holdId);
  if (!held?.cart?.length) {
    setStatus("Held cart not found.", false);
    updateHeldCartUi();
    return;
  }
  if (cartHasItems()) {
    const ok = window.confirm(
      `Current cart has items. Replace it with held “${held.holdLabel || "cart"}”?\n\nTip: Hold the current cart first if you still need it.`
    );
    if (!ok) return;
  }
  applyCartSnapshot(held);
  writeHeldCartList(list.filter((h) => h.holdId !== holdId));
  persistActiveCart();
  renderCart();
  setStatus(`Resumed “${held.holdLabel || state.orderNumber}”.`);
  showToast(`Resumed: ${held.holdLabel || "held cart"}`);
  updateHeldCartUi();
}

function discardHeldCart(holdId) {
  const list = readHeldCartList();
  const held = list.find((h) => h.holdId === holdId);
  if (!held) return;
  if (
    !window.confirm(
      `Discard held “${held.holdLabel || "cart"}” permanently?`
    )
  ) {
    return;
  }
  writeHeldCartList(list.filter((h) => h.holdId !== holdId));
  updateHeldCartUi();
  setStatus(`Discarded “${held.holdLabel || "held cart"}”.`);
}

async function logout() {
  if (!confirmLeaveCart("Sign out")) return;
  await api("/v1/session/logout", { method: "POST", body: "{}" });
  state.role = null;
  state.cart = [];
  state.lastOrderId = null;
  focusCartLine(null);
  clearCartStorage(CART_ACTIVE_KEY);
  clearCartStorage(CART_HELD_KEY_LEGACY);
  clearCartStorage(CART_HELD_LIST_KEY);
  showLogin();
}

function categoryForItem(item) {
  return item.category || "Other";
}

function menuItemInitials(name, maxLetters = 4) {
  const parts = String(name || "")
    .trim()
    .split(/[\s/_-]+/)
    .map((part) => part.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  if (!parts.length) return "?";
  const letters = parts
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
    .slice(0, Math.max(1, maxLetters));
  return letters || "?";
}

function menuMetaForLine(line) {
  const item = (state.menu || []).find((row) => row.item_id === line.itemId) || {};
  return {
    category: item.category || "",
    subcategory: item.subcategory || "",
    itemSort: Number(item.sort_order || 0),
  };
}

function categoryRank(name) {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return 100000;
  const match = (state.categories || []).find(
    (row) => String(row.name || "").trim().toLowerCase() === key
  );
  return match ? Number(match.sort_order || 0) : 50000;
}

function subcategoryRank(category, subcategory) {
  const subKey = String(subcategory || "").trim().toLowerCase();
  if (!subKey) return 0;
  const cat = (state.categories || []).find(
    (row) =>
      String(row.name || "").trim().toLowerCase() ===
      String(category || "").trim().toLowerCase()
  );
  const match = (state.subcategories || []).find(
    (row) =>
      String(row.name || "").trim().toLowerCase() === subKey &&
      (!cat || row.category_id === cat.category_id)
  );
  return match ? Number(match.sort_order || 0) : 50000;
}

function compareBillLines(a, b) {
  const ma = menuMetaForLine(a);
  const mb = menuMetaForLine(b);
  const cat = categoryRank(ma.category) - categoryRank(mb.category);
  if (cat) return cat;
  const catName = ma.category.localeCompare(mb.category);
  if (catName) return catName;
  const sub =
    subcategoryRank(ma.category, ma.subcategory) -
    subcategoryRank(mb.category, mb.subcategory);
  if (sub) return sub;
  const subName = ma.subcategory.localeCompare(mb.subcategory);
  if (subName) return subName;
  const itemSort = ma.itemSort - mb.itemSort;
  if (itemSort) return itemSort;
  const name = String(a.name || "").localeCompare(String(b.name || ""));
  if (name) return name;
  return String(a.variantName || "").localeCompare(String(b.variantName || ""));
}

function linesForBill(lines) {
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => compareBillLines(a.line, b.line) || a.index - b.index)
    .map((row) => row.line);
}

function reviewLinesHtml(lines, { hideSingleCategory = false, bareLineAmount = false } = {}) {
  const sorted = linesForBill(lines);
  const categories = new Set(
    sorted.map((line) => menuMetaForLine(line).category || "Other")
  );
  const skipCategory = hideSingleCategory && categories.size <= 1;
  let last = "";
  return sorted
    .map((line) => {
      const category = menuMetaForLine(line).category || "Other";
      const head =
        skipCategory || category === last
          ? ""
          : `<p class="review-category">${escapeHtml(category)}</p>`;
      last = category;
      return head + reviewLineHtml(line, { bareLineAmount });
    })
    .join("");
}

function subcategoryForItem(item) {
  return item.subcategory || "";
}

function formatPrice(cents) {
  if (state.money) return state.money.format(cents);
  const n = Number(cents || 0) / 100;
  return `QR ${n.toFixed(2)}`;
}

function lineUnitCents(line) {
  const base = Number(line.priceCents || 0);
  let addons = 0;
  for (const a of line.addons || []) {
    const unit = Number(
      a.unitPriceCents != null ? a.unitPriceCents : a.effectivePriceCents || 0
    );
    addons += unit * Number(a.quantity || 1);
  }
  return base + addons;
}

function priceKindLabel(applied, unsetAndUnselected) {
  if (applied == null) return unsetAndUnselected ? "Price not set" : "Enter price";
  if (applied < 0) return "Reduction";
  if (applied === 0) return "Free";
  return "Charge";
}

function formatSignedPrice(minor) {
  const n = Number(minor || 0);
  if (n === 0) return formatPrice(0);
  const sign = n > 0 ? "+" : "";
  return `${sign}${formatPrice(n)}`;
}

function addonCatalogUnset(addon) {
  if (!addon) return false;
  if (addon.priceEnteredAtSale) return true;
  if (addon.priceUnset === true) return true;
  return addon.effectivePriceCents == null && addon.priceCents == null;
}

function addonConfiguredPrice(addon) {
  if (addonCatalogUnset(addon) && addon.configuredUnitPriceCents == null) {
    return null;
  }
  if (addon.configuredUnitPriceCents != null) {
    return Number(addon.configuredUnitPriceCents);
  }
  if (addon.effectivePriceCents != null) return Number(addon.effectivePriceCents);
  if (addon.priceCents != null) return Number(addon.priceCents);
  return 0;
}

function addonAppliedPrice(addon) {
  if (addon.unitPriceCents != null) return Number(addon.unitPriceCents);
  if (addonCatalogUnset(addon)) return null;
  return addonConfiguredPrice(addon);
}

function customizationKey(line) {
  const instr = instructionKey(line.instructions || []);
  const note = String(line.orderNote || "")
    .trim()
    .toLowerCase();
  const addons = (line.addons || [])
    .map(
      (a) =>
        `${a.addonId}:${a.quantity || 1}:${addonAppliedPrice(a)}:${a.priceAdjusted ? 1 : 0}`
    )
    .sort()
    .join(",");
  return `${instr}||${note}||${addons}`;
}

/** One-line cart preview of kitchen notes / extras / free-text note. */
function cartLineNotePreview(line) {
  const bits = [
    ...(line.instructions || []),
    ...(line.addons || []).map((a) => a.name),
    String(line.orderNote || "").trim(),
  ].filter(Boolean);
  return bits.join(" · ");
}

const SALES_TOOL_ICONS = {
  layout: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  kb: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/></svg>',
  stock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
};

const CATEGORY_PALETTE = [
  { dot: "#E0742B", bg: "#FFE8D6" },
  { dot: "#2F9A78", bg: "#D7F2E8" },
  { dot: "#3B6FD9", bg: "#DDE7FF" },
  { dot: "#C2416B", bg: "#FCE0EA" },
  { dot: "#8A5CD1", bg: "#ECE3FB" },
  { dot: "#B8860B", bg: "#FBF0CC" },
  { dot: "#1C93B0", bg: "#D5F0F6" },
  { dot: "#D94F3D", bg: "#FDE0DC" },
  { dot: "#5B8A2E", bg: "#E5F1D6" },
  { dot: "#6B7A99", bg: "#E6EAF2" },
];

/** Each category gets its own colour (chips + item tiles), following Menu Setup order. */
function categoryTheme(cat) {
  const key = String(cat || "").trim().toLowerCase();
  let index = setupOrderIndex(state.categories, key);
  if (index === Number.MAX_SAFE_INTEGER) {
    index = 0;
    for (const ch of key) index = (index * 31 + ch.charCodeAt(0)) >>> 0;
  }
  const slot = index % CATEGORY_PALETTE.length;
  return { ...CATEGORY_PALETTE[slot], slug: `c${slot}` };
}

function canEditMenuLayout() {
  return state.role === "admin";
}

function setLayoutEditMode(on) {
  const next = Boolean(on) && canEditMenuLayout();
  if (state.layoutEditMode === next) {
    ensureSalesViewControls();
    return;
  }
  state.layoutEditMode = next;
  if (next) {
    state.stockMode = false;
    setStatus("Layout edit: hold and drag items, categories or subcategories to rearrange. Tap Done when finished.");
  } else {
    cancelLayoutDrag();
    if (state._layoutSaveTimer) {
      window.clearTimeout(state._layoutSaveTimer);
      state._layoutSaveTimer = null;
      void persistMenuLayoutOrder(orderedIdsFromGrid());
    }
    setStatus("Layout edit closed.");
  }
  document.body.classList.toggle("menu-layout-edit", next);
  ensureSalesViewControls();
  renderCategories();
  renderMenu();
}

function ensureSalesViewControls() {
  const host = document.querySelector(".sales-view-controls");
  if (!host) return;

  let layoutBtn = $("sales-layout-btn");
  if (canEditMenuLayout()) {
    if (!layoutBtn) {
      layoutBtn = document.createElement("button");
      layoutBtn.type = "button";
      layoutBtn.id = "sales-layout-btn";
      layoutBtn.className = "btn ghost small sales-view-btn sales-layout-btn";
      layoutBtn.innerHTML = `${SALES_TOOL_ICONS.layout}<span class="sales-layout-label">Layout</span>`;
      layoutBtn.title = "Edit menu layout";
      layoutBtn.addEventListener("click", () => {
        setLayoutEditMode(!state.layoutEditMode);
      });
      host.appendChild(layoutBtn);
    }
    layoutBtn.hidden = false;
    layoutBtn.setAttribute("aria-pressed", state.layoutEditMode ? "true" : "false");
    layoutBtn.classList.toggle("is-active", Boolean(state.layoutEditMode));
    layoutBtn.querySelector(".sales-layout-label").textContent = state.layoutEditMode
      ? "Done"
      : "Layout";
    layoutBtn.title = state.layoutEditMode
      ? "Finish layout editing"
      : "Edit menu layout (hold and drag)";
  } else if (layoutBtn) {
    layoutBtn.hidden = true;
    if (state.layoutEditMode) setLayoutEditMode(false);
  }

  let vkBtn = $("sales-vk-btn");
  if (!vkBtn) {
    vkBtn = document.createElement("button");
    vkBtn.type = "button";
    vkBtn.id = "sales-vk-btn";
    vkBtn.className = "btn ghost small sales-view-btn";
    vkBtn.innerHTML = `${SALES_TOOL_ICONS.kb}<span>Keyboard</span>`;
    vkBtn.title = "Show on-screen keyboard for search and entry fields";
    vkBtn.addEventListener("click", () => {
      state.virtualKeyboardOn = !state.virtualKeyboardOn;
      try {
        localStorage.setItem(
          "gtct.virtualKeyboard",
          state.virtualKeyboardOn ? "1" : "0"
        );
      } catch {
        /* ignore */
      }
      state.virtualKeyboard?.setEnabled(state.virtualKeyboardOn);
      ensureSalesViewControls();
      setStatus(
        state.virtualKeyboardOn
          ? "On-screen keyboard on — tap a field to type."
          : "On-screen keyboard off."
      );
    });
    host.appendChild(vkBtn);
  }
  vkBtn.hidden = Boolean(state.layoutEditMode);
  vkBtn.setAttribute("aria-pressed", state.virtualKeyboardOn ? "true" : "false");
  vkBtn.classList.toggle("is-active", Boolean(state.virtualKeyboardOn));

  let btn = $("sales-stock-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "sales-stock-btn";
    btn.className = "btn ghost small sales-view-btn";
    btn.innerHTML = `${SALES_TOOL_ICONS.stock}<span>Stock</span>`;
    btn.title = "Stock mode: mark items sold out / available";
    btn.addEventListener("click", () => {
      if (state.layoutEditMode) setLayoutEditMode(false);
      state.stockMode = !state.stockMode;
      btn.setAttribute("aria-pressed", state.stockMode ? "true" : "false");
      btn.classList.toggle("is-active", Boolean(state.stockMode));
      renderMenu();
    });
    host.appendChild(btn);
  }
  btn.hidden = Boolean(state.layoutEditMode);
  btn.setAttribute("aria-pressed", state.stockMode ? "true" : "false");
  btn.classList.toggle("is-active", Boolean(state.stockMode));
}

function ensureStockModeControl() {
  ensureSalesViewControls();
}

/** Position of a category/subcategory as set in Menu Setup (unknown ones go last). */
function setupOrderIndex(list, name, extra = () => true) {
  const needle = String(name || "").trim().toLowerCase();
  const index = (list || []).findIndex(
    (row) => extra(row) && String(row.name || "").trim().toLowerCase() === needle
  );
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function sortBySetupOrder(names, list, extra) {
  return names
    .map((name, i) => ({ name, i, rank: setupOrderIndex(list, name, extra) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.name);
}

function renderCategories() {
  ensureStockModeControl();
  const cats = [
    "ALL",
    ...sortBySetupOrder([...new Set(state.menu.map(categoryForItem))], state.categories),
  ];
  const counts = new Map([["ALL", 0]]);
  for (const item of state.menu) {
    if (!item.is_active) continue;
    const c = categoryForItem(item);
    counts.set(c, (counts.get(c) || 0) + 1);
    counts.set("ALL", counts.get("ALL") + 1);
  }
  const host = $("category-filters");
  host.innerHTML = "";
  for (const cat of cats) {
    const btn = document.createElement("button");
    btn.type = "button";
    const theme = cat === "ALL" ? null : categoryTheme(cat);
    btn.className = `chip${state.category === cat ? " active" : ""}${theme ? ` cat-dot-${theme.slug}` : ""}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", state.category === cat ? "true" : "false");
    if (theme) btn.style.setProperty("--cat-dot", theme.dot);
    btn.innerHTML =
      cat === "ALL"
        ? escapeHtml(titleCaseLabel(cat))
        : `<span class="chip-cat-dot" aria-hidden="true"></span>${escapeHtml(titleCaseLabel(cat))}`;
    const count = counts.get(cat) || 0;
    btn.insertAdjacentHTML("beforeend", `<span class="chip-count">${count}</span>`);
    btn.setAttribute("aria-label", `${titleCaseLabel(cat)}, ${count} items`);
    if (cat !== "ALL") btn.dataset.chipName = cat;
    btn.addEventListener("click", () => {
      if (Date.now() < (state._chipSuppressClick || 0)) return;
      clearMenuSearch(false);
      state.category = cat;
      state.subcategory = "ALL";
      renderCategories();
      renderSubcategories();
      renderMenu();
    });
    host.appendChild(btn);
  }
  bindChipDrag(host, "category");
  revealActiveChip(host);
  renderSubcategories();
}

/** Phones: keep the selected chip visible in its sliding row. */
function revealActiveChip(host) {
  if (!window.matchMedia?.("(max-width: 599px)").matches) return;
  const active = host.querySelector(".chip.active");
  if (!active) return;
  const left = active.offsetLeft - 12;
  const right = active.offsetLeft + active.offsetWidth + 40;
  if (left < host.scrollLeft) host.scrollLeft = left;
  else if (right > host.scrollLeft + host.clientWidth) host.scrollLeft = right - host.clientWidth;
}

/* ---------- Layout mode: hold and drag category / subcategory chips ---------- */
function bindChipDrag(host, kind) {
  const on = Boolean(state.layoutEditMode) && canEditMenuLayout();
  host.classList.toggle("is-chip-layout", on);
  if (!on) return;
  host.querySelectorAll(".chip[data-chip-name]").forEach((chip) => {
    chip.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      const drag = { active: false, moved: false, x0: event.clientX, y0: event.clientY, timer: null };
      const cleanup = () => {
        window.clearTimeout(drag.timer);
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        document.removeEventListener("pointercancel", up);
      };
      const move = (e) => {
        if (!drag.active) {
          if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 12) cleanup();
          return;
        }
        e.preventDefault();
        const over = document
          .elementsFromPoint(e.clientX, e.clientY)
          .map((el) => el.closest?.(".chip[data-chip-name]"))
          .find((el) => el && el !== chip && host.contains(el));
        if (!over) return;
        const r = over.getBoundingClientRect();
        const after = e.clientX > r.left + r.width / 2;
        const ref = after ? over.nextSibling : over;
        if (ref !== chip && ref !== chip.nextSibling) {
          host.insertBefore(chip, ref);
          drag.moved = true;
        }
      };
      const up = () => {
        cleanup();
        if (!drag.active) return;
        chip.classList.remove("is-chip-dragging");
        state._chipSuppressClick = Date.now() + 400;
        if (drag.moved) void saveChipOrder(host, kind);
      };
      drag.timer = window.setTimeout(() => {
        drag.active = true;
        chip.classList.add("is-chip-dragging");
        try {
          navigator.vibrate?.(12);
        } catch {
          /* ignore */
        }
      }, 350);
      document.addEventListener("pointermove", move, { passive: false });
      document.addEventListener("pointerup", up);
      document.addEventListener("pointercancel", up);
    });
  });
}

async function saveChipOrder(host, kind) {
  const names = [...host.querySelectorAll(".chip[data-chip-name]")].map((c) => c.dataset.chipName);
  const norm = (s) => String(s || "").trim().toLowerCase();
  const all = await api("/v1/menu-categories?includeInactive=1");
  if (!all.ok) {
    setStatus("Could not save the order. Refresh and try again.", false);
    return;
  }
  const order = (rows) => {
    const picked = names.map((n) => rows.find((r) => norm(r.name) === norm(n))).filter(Boolean);
    return [...picked, ...rows.filter((r) => !picked.includes(r))];
  };
  let url;
  let body;
  if (kind === "category") {
    url = "/v1/menu-categories/reorder";
    body = { categoryIds: order(all.json.categories || []).map((c) => c.category_id) };
  } else {
    const parent = (all.json.categories || []).find((c) => norm(c.name) === norm(state.category));
    if (!parent) {
      setStatus("Could not save the order: category not found.", false);
      return;
    }
    const subs = (all.json.subcategoriesByCategory || {})[parent.category_id] || [];
    url = "/v1/menu-subcategories/reorder";
    body = { categoryId: parent.category_id, subcategoryIds: order(subs).map((s) => s.subcategory_id) };
  }
  const res = await api(url, { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    setStatus(res.json?.error || "Could not save the order.", false);
    renderCategories();
    return;
  }
  state.categories = (res.json.categories || []).filter((c) => c.is_active);
  state.subcategories = (res.json.subcategories || []).filter((s) => s.is_active);
  showToast(kind === "category" ? "Category order saved" : "Subcategory order saved");
  renderCategories();
}

/* ---------- Subcategories as "folder" cards in the item grid ---------- */
const ALL_IN_CATEGORY = "__ALL_ITEMS__";

/** Shop Settings → Sales screen: "cards" (default) or "pills". Layout edit always uses pills. */
function subcategoryCardsMode() {
  if (state.layoutEditMode && canEditMenuLayout()) return false;
  return state.config?.shop?.subcategoryDisplay !== "pills";
}

/** Subcategory names of a category, in Menu Setup order (only those with active items). */
function orderedSubcategoriesFor(category) {
  const parent = setupOrderIndex(state.categories, category);
  const parentId = state.categories?.[parent]?.category_id;
  return sortBySetupOrder(
    [
      ...new Set(
        state.menu
          .filter((i) => i.is_active && categoryForItem(i) === category)
          .map(subcategoryForItem)
          .filter(Boolean)
      ),
    ],
    state.subcategories,
    (row) => !parentId || row.category_id === parentId
  );
}

function subcategoryRecord(category, name) {
  const parent = state.categories?.[setupOrderIndex(state.categories, category)];
  const needle = String(name || "").trim().toLowerCase();
  return (state.subcategories || []).find(
    (row) =>
      String(row.name || "").trim().toLowerCase() === needle &&
      (!parent || row.category_id === parent.category_id)
  );
}

/** "◀ Back  Sandwiches › Burgers" line shown while inside a subcategory card. */
function renderFolderBar() {
  let bar = $("menu-folder-bar");
  const inside =
    subcategoryCardsMode() && state.category !== "ALL" && state.subcategory !== "ALL";
  if (!inside) {
    if (bar) bar.hidden = true;
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "menu-folder-bar";
    bar.className = "menu-folder-bar";
    $("subcategory-filters")?.after(bar);
  }
  bar.hidden = false;
  const here = state.subcategory === ALL_IN_CATEGORY ? "All items" : titleCaseLabel(state.subcategory);
  bar.innerHTML = `<button type="button" class="menu-folder-back" aria-label="Back to ${escapeHtml(titleCaseLabel(state.category))}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg><span>Back</span></button>
    <nav class="menu-folder-path" aria-label="You are here">
      <button type="button" class="menu-folder-up">${escapeHtml(titleCaseLabel(state.category))}</button>
      <span class="menu-folder-sep" aria-hidden="true">›</span>
      <strong>${escapeHtml(here)}</strong>
    </nav>`;
  const goUp = () => {
    state.subcategory = "ALL";
    renderSubcategories();
    renderMenu();
    $("menu-grid")?.scrollTo?.({ top: 0 });
  };
  bar.querySelector(".menu-folder-back").addEventListener("click", goUp);
  bar.querySelector(".menu-folder-up").addEventListener("click", goUp);
}

/** Folder cards for the open category (null when the grid should show items only). */
function folderCardsForView() {
  if (!subcategoryCardsMode()) return null;
  if (state.category === "ALL" || state.subcategory !== "ALL") return null;
  if (String(state.search || "").trim()) return null;
  const subs = orderedSubcategoriesFor(state.category);
  if (!subs.length) return null;
  const counts = new Map();
  let total = 0;
  for (const item of state.menu) {
    if (!item.is_active || categoryForItem(item) !== state.category) continue;
    total += 1;
    const sub = subcategoryForItem(item);
    if (sub) counts.set(sub, (counts.get(sub) || 0) + 1);
  }
  return [
    { key: ALL_IN_CATEGORY, name: "All items", count: total, all: true },
    ...subs.map((name) => ({
      key: name,
      name: titleCaseLabel(name),
      count: counts.get(name) || 0,
      imageUrl: subcategoryRecord(state.category, name)?.image_url || null,
    })),
  ];
}

function buildFolderCard(folder) {
  const theme = categoryTheme(state.category);
  const wrap = document.createElement("div");
  wrap.className = "mcard-wrap mfolder-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `mfolder${folder.imageUrl ? " has-photo" : ""}${folder.all ? " is-all" : ""}`;
  btn.style.setProperty("--cat-color", theme.dot);
  btn.style.setProperty("--cat-bg", theme.bg);
  btn.setAttribute("aria-label", `Open ${folder.name}, ${folder.count} items`);
  const icon = folder.all
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  btn.innerHTML = `
    <span class="mfolder-media">${
      folder.imageUrl
        ? `<img src="${escapeHtml(folder.imageUrl)}" alt="" loading="lazy" />`
        : `<span class="mfolder-icon">${icon}</span>`
    }</span>
    <span class="mfolder-body">
      <span class="mfolder-name">${escapeHtml(folder.name)}</span>
      <span class="mfolder-count">${folder.count} ${folder.count === 1 ? "item" : "items"}</span>
    </span>
    <span class="mfolder-chevron" aria-hidden="true">›</span>`;
  const img = btn.querySelector("img");
  img?.addEventListener("error", () => {
    btn.classList.remove("has-photo");
    img.parentElement.innerHTML = `<span class="mfolder-icon">${icon}</span>`;
  });
  btn.addEventListener("click", () => {
    state.subcategory = folder.key;
    renderSubcategories();
    renderMenu();
    $("menu-grid")?.scrollTo?.({ top: 0 });
  });
  wrap.appendChild(btn);
  return wrap;
}

function renderSubcategories() {
  const host = $("subcategory-filters");
  renderFolderBar();
  if (subcategoryCardsMode()) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  if (state.subcategory === ALL_IN_CATEGORY) state.subcategory = "ALL";
  if (state.category === "ALL") {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  const parent = setupOrderIndex(state.categories, state.category);
  const parentId = state.categories?.[parent]?.category_id;
  const subs = sortBySetupOrder(
    [
      ...new Set(
        state.menu
          .filter((i) => categoryForItem(i) === state.category)
          .map(subcategoryForItem)
          .filter(Boolean)
      ),
    ],
    state.subcategories,
    (row) => !parentId || row.category_id === parentId
  );
  if (!subs.length) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  host.hidden = false;
  host.innerHTML = "";
  for (const sub of ["ALL", ...subs]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chip green${state.subcategory === sub ? " active" : ""}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", state.subcategory === sub ? "true" : "false");
    btn.textContent = titleCaseLabel(sub);
    if (sub !== "ALL") btn.dataset.chipName = sub;
    btn.addEventListener("click", () => {
      if (Date.now() < (state._chipSuppressClick || 0)) return;
      clearMenuSearch(false);
      state.subcategory = sub;
      renderSubcategories();
      renderMenu();
    });
    host.appendChild(btn);
  }
  bindChipDrag(host, "subcategory");
  revealActiveChip(host);
}

function salesVariants(item) {
  if (!item?.hasVariants) return [];
  return (item.variants || []).filter((v) => v.isActive && !v.isSoldOut);
}

function itemDisplayPrice(item) {
  const vars = salesVariants(item);
  if (vars.length) {
    const min = Math.min(...vars.map((v) => Number(v.priceCents || 0)));
    return {
      label:
        vars.length > 1
          ? `From ${formatPrice(min).replace(/^BD:\s*/i, "")}`
          : formatPrice(min),
      meta: vars.length > 1 ? `${vars.length} sizes` : "",
    };
  }
  return {
    label: formatPrice(item.price_cents),
    meta: "",
  };
}

function itemCardPriceParts(item) {
  const vars = salesVariants(item);
  const cents = vars.length
    ? Math.min(...vars.map((v) => Number(v.priceCents || 0)))
    : Number(item.price_cents || 0);
  const decimals = Number(
    state.money?.decimals ?? state.config?.shop?.currencyDecimals ?? 3
  );
  const label = String(
    state.money?.currencyLabel || state.money?.currencyCode || "BD"
  )
    .trim()
    .replace(/:$/, "");
  const amount = state.money?.formatPlain
    ? state.money.formatPlain(cents)
    : (Number(cents) / 10 ** decimals).toFixed(decimals);
  return {
    from: vars.length > 1,
    label,
    amount,
    aria: `${label} ${amount}`,
    sizesChip: vars.length > 1 ? `${vars.length} sizes` : "",
  };
}

function showToast(message, opts = {}) {
  const el = $("toast");
  if (!el) return;
  const duration = Number(opts.duration) > 0 ? Number(opts.duration) : 1600;
  el.hidden = false;
  el.textContent = message;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.hidden = true;
  }, duration);
}

function showSoldOutUndoToast(item) {
  const el = $("toast");
  if (!el) return;
  clearTimeout(showToast._t);
  clearTimeout(state._soldOutUndoTimer);
  el.hidden = false;
  el.innerHTML = `<span>${escapeHtml(item.name)} sold out.</span> <button type="button" class="btn ghost small" id="soldout-undo-btn">Undo</button>`;
  const clear = () => {
    el.hidden = true;
    el.textContent = "";
  };
  $("soldout-undo-btn")?.addEventListener("click", () => {
    clearTimeout(state._soldOutUndoTimer);
    clear();
    if (item.is_sold_out) void toggleSoldOut(item, { fromUndo: true });
  });
  state._soldOutUndoTimer = window.setTimeout(clear, 5000);
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Search looks through the WHOLE menu (not just the open category), needs every
 * typed word to match, and puts names that start with the words first.
 */
function visibleMenuItems() {
  const q = normalizeSearchText(state.search);
  const active = state.menu.filter((item) => item.is_active);
  if (!q) {
    return active.filter((item) => {
      if (state.category !== "ALL" && categoryForItem(item) !== state.category) return false;
      if (
        state.subcategory !== "ALL" &&
        state.subcategory !== ALL_IN_CATEGORY &&
        subcategoryForItem(item) !== state.subcategory
      ) {
        return false;
      }
      return true;
    });
  }
  const words = q.split(" ");
  const scored = [];
  active.forEach((item, order) => {
    const name = normalizeSearchText(item.name);
    const hay = normalizeSearchText(
      [item.name, item.code, item.sku, item.category, item.subcategory].join(" ")
    );
    if (!words.every((w) => hay.includes(w))) return;
    const nameWords = name.split(" ");
    let score = 3;
    if (name.startsWith(q)) score = 0;
    else if (words.every((w) => nameWords.some((nw) => nw.startsWith(w)))) score = 1;
    else if (words.every((w) => name.includes(w))) score = 2;
    scored.push({ item, score, order });
  });
  if (!(state.layoutEditMode && canEditMenuLayout())) {
    scored.sort((a, b) => a.score - b.score || a.order - b.order);
  }
  return scored.map((x) => x.item);
}

function clearMenuSearch(rerender = true) {
  if (!state.search) return;
  state.search = "";
  const input = $("menu-search");
  if (input) input.value = "";
  syncMenuSearchUi(0);
  if (rerender) renderMenu();
}

/** Search box extras: magnifier, clear (×) button and a "N results" line. */
function ensureMenuSearchUi() {
  const input = $("menu-search");
  if (!input || input.parentElement?.classList.contains("menu-search-box")) return;
  const box = document.createElement("div");
  box.className = "menu-search-box";
  input.parentElement.insertBefore(box, input);
  box.innerHTML =
    '<svg class="menu-search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  box.appendChild(input);
  input.placeholder = window.matchMedia?.("(max-width: 599px)").matches
    ? "Search menu…"
    : "Search item name or code…";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.id = "menu-search-clear";
  clear.className = "menu-search-clear";
  clear.hidden = true;
  clear.setAttribute("aria-label", "Clear search");
  clear.innerHTML = "&times;";
  clear.addEventListener("pointerdown", (e) => e.preventDefault());
  clear.addEventListener("click", () => clearMenuSearch());
  box.appendChild(clear);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      clearMenuSearch();
    }
  });
  const info = document.createElement("div");
  info.id = "menu-search-info";
  info.className = "menu-search-info";
  info.hidden = true;
  info.setAttribute("role", "status");
  $("subcategory-filters")?.after(info);
}

function syncMenuSearchUi(resultCount) {
  const q = String(state.search || "").trim();
  const clear = $("menu-search-clear");
  if (clear) clear.hidden = !state.search;
  document.querySelector("#menu-pane .pane-toolbar")?.classList.toggle("is-searching", Boolean(q));
  const info = $("menu-search-info");
  if (!info) return;
  info.hidden = !q;
  if (!q) return;
  info.innerHTML = `<span><strong>${resultCount}</strong> ${resultCount === 1 ? "item" : "items"} for “${escapeHtml(q)}” <span class="muted">· all categories</span></span><button type="button" class="menu-search-info-clear">Clear search</button>`;
  info.querySelector("button").addEventListener("click", () => clearMenuSearch());
}

function ensureLayoutHint(grid) {
  let hint = $("menu-layout-hint");
  if (!state.layoutEditMode) {
    if (hint) hint.remove();
    return;
  }
  if (!hint) {
    hint = document.createElement("p");
    hint.id = "menu-layout-hint";
    hint.className = "menu-layout-hint";
    hint.setAttribute("role", "status");
  }
  hint.textContent =
    "Hold an item, category or subcategory, then drag it to a new spot. Tap Done when finished.";
  if (hint.parentElement !== grid.parentElement) {
    grid.parentElement?.insertBefore(hint, grid);
  }
}

function cancelLayoutDrag() {
  const drag = state._layoutDrag;
  if (!drag) return;
  if (drag.timer) window.clearTimeout(drag.timer);
  if (drag.wrap) {
    drag.wrap.classList.remove("is-dragging");
    drag.wrap.style.transform = "";
    drag.wrap.style.zIndex = "";
    drag.wrap.style.pointerEvents = "";
  }
  document.removeEventListener("pointermove", onLayoutPointerMove);
  document.removeEventListener("pointerup", onLayoutPointerUp);
  document.removeEventListener("pointercancel", onLayoutPointerUp);
  state._layoutDrag = null;
}

function orderedIdsFromGrid() {
  const grid = $("menu-grid");
  if (!grid) return [];
  return [...grid.querySelectorAll(".mcard-wrap[data-item-id]")].map((el) =>
    el.getAttribute("data-item-id")
  );
}

function applyLocalMenuOrder(orderedIds) {
  const rank = new Map(orderedIds.map((id, index) => [id, index]));
  const touched = new Set(orderedIds);
  const existing = state.menu
    .filter((item) => touched.has(item.item_id))
    .map((item) => Number(item.sort_order || 0));
  const uniqueSlots = new Set(existing).size === existing.length && existing.length;
  const slots = uniqueSlots
    ? [...existing].sort((a, b) => a - b)
    : orderedIds.map((_, index) => {
        const base = existing.length ? Math.min(...existing) : 0;
        return base + index * 10;
      });
  for (const item of state.menu) {
    if (!rank.has(item.item_id)) continue;
    item.sort_order = slots[rank.get(item.item_id)];
  }
  state.menu.sort((a, b) => {
    const d = Number(a.sort_order || 0) - Number(b.sort_order || 0);
    if (d) return d;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

async function persistMenuLayoutOrder(orderedIds) {
  if (!orderedIds.length) return;
  const res = await api("/v1/menu-items/reorder", {
    method: "PUT",
    body: JSON.stringify({ itemIds: orderedIds }),
  });
  if (!res.ok) {
    setStatus(res.json?.error || "Could not save menu layout.", false);
    return;
  }
  if (Array.isArray(res.json?.menuItems) && res.json.menuItems.length) {
    state.menu = res.json.menuItems;
  } else {
    applyLocalMenuOrder(orderedIds);
  }
}

function schedulePersistMenuLayout() {
  if (state._layoutSaveTimer) window.clearTimeout(state._layoutSaveTimer);
  const orderedIds = orderedIdsFromGrid();
  applyLocalMenuOrder(orderedIds);
  state._layoutSaveTimer = window.setTimeout(() => {
    state._layoutSaveTimer = null;
    void persistMenuLayoutOrder(orderedIds);
  }, 280);
}

function moveLayoutWrapBefore(source, target) {
  if (!source || !target || source === target) return false;
  const grid = $("menu-grid");
  if (!grid || source.parentElement !== grid || target.parentElement !== grid) {
    return false;
  }
  const wraps = [...grid.querySelectorAll(".mcard-wrap[data-item-id]")];
  const from = wraps.indexOf(source);
  const to = wraps.indexOf(target);
  if (from < 0 || to < 0 || from === to) return false;
  if (from < to) {
    grid.insertBefore(source, target.nextSibling);
  } else {
    grid.insertBefore(source, target);
  }
  return true;
}

function layoutWrapAtPoint(clientX, clientY, exclude) {
  const stack = document.elementsFromPoint(clientX, clientY);
  for (const el of stack) {
    const wrap = el.closest?.(".mcard-wrap[data-item-id]");
    if (wrap && wrap !== exclude) return wrap;
  }
  return null;
}

function onLayoutPointerMove(event) {
  const drag = state._layoutDrag;
  if (!drag || !drag.wrap) return;
  if (!drag.active) {
    const dist = Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY);
    if (dist > 10) cancelLayoutDrag();
    return;
  }
  event.preventDefault();
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  drag.wrap.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
  const over = layoutWrapAtPoint(event.clientX, event.clientY, drag.wrap);
  if (over && over !== drag.lastOver) {
    drag.lastOver = over;
    if (moveLayoutWrapBefore(drag.wrap, over)) {
      drag.moved = true;
      drag.wrap.style.transform = "";
      const base = drag.wrap.getBoundingClientRect();
      drag.startX = base.left + drag.offsetX;
      drag.startY = base.top + drag.offsetY;
      const ndx = event.clientX - drag.startX;
      const ndy = event.clientY - drag.startY;
      drag.wrap.style.transform = `translate(${ndx}px, ${ndy}px) scale(1.04)`;
    }
  }
}

function onLayoutPointerUp(event) {
  const drag = state._layoutDrag;
  if (!drag) return;
  if (drag.timer) {
    window.clearTimeout(drag.timer);
    drag.timer = null;
  }
  if (drag.active) {
    event.preventDefault();
    drag.wrap?.classList.remove("is-dragging");
    if (drag.wrap) {
      drag.wrap.style.transform = "";
      drag.wrap.style.zIndex = "";
      drag.wrap.style.pointerEvents = "";
    }
    document.removeEventListener("pointermove", onLayoutPointerMove);
    document.removeEventListener("pointerup", onLayoutPointerUp);
    document.removeEventListener("pointercancel", onLayoutPointerUp);
    const moved = drag.moved;
    state._layoutDrag = { suppressClick: true };
    window.setTimeout(() => {
      if (state._layoutDrag?.suppressClick) state._layoutDrag = null;
    }, 220);
    if (moved) schedulePersistMenuLayout();
    return;
  }
  state._layoutDrag = null;
  document.removeEventListener("pointermove", onLayoutPointerMove);
  document.removeEventListener("pointerup", onLayoutPointerUp);
  document.removeEventListener("pointercancel", onLayoutPointerUp);
}

function bindLayoutDrag(wrap, item) {
  wrap.addEventListener("pointerdown", (event) => {
    if (!state.layoutEditMode) return;
    if (event.button != null && event.button !== 0) return;
    if (event.target.closest(".mc-info")) return;
    cancelLayoutDrag();
    const rect = wrap.getBoundingClientRect();
    state._layoutDrag = {
      itemId: item.item_id,
      wrap,
      timer: null,
      active: false,
      moved: false,
      originX: event.clientX,
      originY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      lastOver: null,
      pointerId: event.pointerId,
    };
    const drag = state._layoutDrag;
    drag.timer = window.setTimeout(() => {
      if (!state._layoutDrag || state._layoutDrag !== drag) return;
      drag.active = true;
      // Anchor translate so the card stays under the finger from activation.
      drag.wrap.style.transform = "";
      const base = drag.wrap.getBoundingClientRect();
      drag.startX = base.left + drag.offsetX;
      drag.startY = base.top + drag.offsetY;
      wrap.classList.add("is-dragging");
      wrap.style.zIndex = "40";
      wrap.style.pointerEvents = "none";
      if (navigator.vibrate) {
        try {
          navigator.vibrate(12);
        } catch {
          /* ignore */
        }
      }
    }, 420);
    document.addEventListener("pointermove", onLayoutPointerMove, { passive: false });
    document.addEventListener("pointerup", onLayoutPointerUp);
    document.addEventListener("pointercancel", onLayoutPointerUp);
  });
}

function renderMenu() {
  ensureStockModeControl();
  const stockMode = Boolean(state.stockMode);
  const layoutEdit = Boolean(state.layoutEditMode) && canEditMenuLayout();
  ensureMenuSearchUi();
  let items = visibleMenuItems();
  syncMenuSearchUi(items.length);
  renderFolderBar();
  const grid = $("menu-grid");
  grid.classList.toggle("is-layout-edit", layoutEdit);
  ensureLayoutHint(grid);
  grid.innerHTML = "";
  const folders = folderCardsForView();
  grid.classList.toggle("is-folder-view", Boolean(folders));
  if (folders) {
    for (const folder of folders) grid.appendChild(buildFolderCard(folder));
    // Items that have no subcategory show straight after the folders.
    items = items.filter((item) => !subcategoryForItem(item));
    if (!items.length) return;
  }
  if (!items.length) {
    grid.innerHTML = state.search.trim()
      ? `<div class="empty menu-empty"><strong>No item found for “${escapeHtml(state.search.trim())}”</strong><span>Check the spelling or try fewer letters.</span></div>`
      : `<p class="empty">No menu items in this category.</p>`;
    return;
  }
  for (const item of items) {
    const soldOut = Boolean(item.is_sold_out);
    const price = itemCardPriceParts(item);
    const inCartQty = cartQtyForMenuItem(item);
    const canToggleSold =
      state.role === "admin" || state.permissions.includes("menu.sold_out.update");
    const theme = categoryTheme(categoryForItem(item));
    const hasPhoto = Boolean(item.image_url);
    const initial = menuItemInitials(item.name);

    const wrap = document.createElement("div");
    wrap.className = `mcard-wrap${soldOut ? " is-sold-out" : ""}${layoutEdit ? " is-layout-editable" : ""}${inCartQty > 0 ? " has-qty" : ""}${hasPhoto ? "" : " no-photo"}`;
    wrap.dataset.itemId = item.item_id;

    const card = document.createElement("button");
    card.type = "button";
    card.className = `mcard cat-${theme.slug}${soldOut ? " is-sold-out" : ""}${hasPhoto ? "" : " no-photo"}`;
    card.style.setProperty("--cat-color", theme.dot);
    card.disabled = soldOut && !layoutEdit;
    card.setAttribute(
      "aria-label",
      layoutEdit
        ? `Reorder ${item.name}`
        : soldOut
          ? `${item.name}, sold out`
          : `Add ${item.name}, ${price.aria}`
    );

    if (inCartQty > 0 && !soldOut && !layoutEdit) {
      const badge = document.createElement("span");
      badge.className = "mc-badge";
      badge.textContent = String(inCartQty);
      badge.setAttribute("aria-label", `${inCartQty} in cart`);
      card.appendChild(badge);
    }

    if (soldOut) {
      const tag = document.createElement("span");
      tag.className = "mc-sold";
      tag.textContent = "SOLD OUT";
      card.appendChild(tag);
    }

    const media = document.createElement("span");
    media.className = "mc-media";
    if (hasPhoto) {
      const img = document.createElement("img");
      img.className = "mc-photo";
      img.alt = "";
      img.loading = "lazy";
      img.src = item.image_url;
      img.addEventListener("error", () => {
        img.remove();
        card.classList.add("no-photo");
        wrap.classList.add("no-photo");
        const ph = document.createElement("span");
        ph.className = "mc-letter";
        ph.style.background = theme.bg;
        ph.textContent = initial;
        media.appendChild(ph);
      });
      media.appendChild(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "mc-letter";
      ph.style.background = theme.bg;
      ph.textContent = initial;
      media.appendChild(ph);
    }
    card.appendChild(media);

    const body = document.createElement("span");
    body.className = "mc-body";
    const name = document.createElement("span");
    name.className = "mc-name";
    name.textContent = item.name;
    name.title = item.name;
    body.appendChild(name);

    const bottom = document.createElement("span");
    bottom.className = "mc-bottom";
    const priceEl = document.createElement("span");
    priceEl.className = "mc-price";
    if (price.from && !soldOut) {
      priceEl.innerHTML = `<small class="mc-from">from</small><b><i>${escapeHtml(price.label)}</i> ${escapeHtml(price.amount)}</b>`;
    } else {
      priceEl.innerHTML = `<b><i>${escapeHtml(price.label)}</i> ${escapeHtml(price.amount)}</b>`;
    }
    bottom.appendChild(priceEl);
    if (!soldOut && !layoutEdit) {
      const plus = document.createElement("span");
      plus.className = "mc-plus";
      plus.setAttribute("aria-hidden", "true");
      plus.textContent = "+";
      bottom.appendChild(plus);
    }
    body.appendChild(bottom);

    if (!soldOut && !layoutEdit) {
      const qtyRow = document.createElement("span");
      qtyRow.className = "mc-qtyrow";
      const dec = document.createElement("button");
      dec.type = "button";
      dec.className = "mc-qty-btn";
      dec.setAttribute("aria-label", `Decrease ${item.name}`);
      dec.textContent = "−";
      dec.disabled = inCartQty <= 0;
      dec.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        adjustMenuItemCartQty(item, -1);
      });
      const qty = document.createElement("span");
      qty.className = "mc-qty";
      qty.textContent = String(inCartQty);
      const inc = document.createElement("button");
      inc.type = "button";
      inc.className = "mc-qty-btn";
      inc.setAttribute("aria-label", `Increase ${item.name}`);
      inc.textContent = "+";
      inc.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        adjustMenuItemCartQty(item, 1);
      });
      qtyRow.append(dec, qty, inc);
      body.appendChild(qtyRow);
    }

    card.appendChild(body);

    if (layoutEdit) {
      card.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state._layoutDrag?.suppressClick) return;
      });
      bindLayoutDrag(wrap, item);
    } else if (!soldOut) {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".mc-qtyrow")) return;
        onMenuItemTap(item);
      });
    }
    wrap.appendChild(card);

    const infoBtn = document.createElement("button");
    infoBtn.type = "button";
    infoBtn.className = "mc-info";
    infoBtn.setAttribute("aria-label", `View information about ${item.name}`);
    infoBtn.innerHTML = `<span aria-hidden="true">ⓘ</span>`;
    infoBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (layoutEdit) return;
      openProductKnowledge(item);
    });
    wrap.appendChild(infoBtn);

    if (stockMode && canToggleSold && !layoutEdit) {
      const soldBtn = document.createElement("button");
      soldBtn.type = "button";
      soldBtn.className = `mc-stock${soldOut ? " is-sold" : ""}`;
      soldBtn.textContent = soldOut ? "Back in stock" : "";
      soldBtn.setAttribute(
        "aria-label",
        soldOut ? `Mark ${item.name} available` : `Mark ${item.name} sold out`
      );
      soldBtn.title = soldOut ? "Back in stock" : "Mark sold out";
      soldBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        void toggleSoldOut(item);
      });
      wrap.appendChild(soldBtn);
    }

    grid.appendChild(wrap);
  }
}

async function toggleSoldOut(item, { fromUndo = false } = {}) {
  const markingSoldOut = !item.is_sold_out;
  const res = await api(
    `/v1/menu-items/${encodeURIComponent(item.item_id)}/availability`,
    {
      method: "PATCH",
      body: JSON.stringify({ isSoldOut: !item.is_sold_out }),
    }
  );
  if (!res.ok) {
    setStatus(res.json?.error || "Could not update sold out.", false);
    return;
  }
  const next = res.json?.menuItem;
  if (next && Number(next.price_cents) !== Number(item.price_cents)) {
    setStatus("Sold out was not saved because the item price changed.", false);
    return;
  }
  item.is_sold_out = Boolean(next?.is_sold_out);
  renderMenu();
  if (!fromUndo && markingSoldOut && item.is_sold_out) {
    showSoldOutUndoToast(item);
  } else {
    setStatus(item.is_sold_out ? `${item.name} is sold out.` : `${item.name} is available.`);
  }
}

function onMenuItemTap(item) {
  if (state.addingLock) return;
  if (!item.is_active) {
    setStatus("That item is inactive.", false);
    return;
  }
  if (item.is_sold_out) {
    setStatus("That item is sold out.", false);
    return;
  }
  if (item.hasVariants) {
    const vars = salesVariants(item);
    if (!vars.length) {
      setStatus("No available sizes for this item.", false);
      return;
    }
    openVariantPicker(item, vars);
    return;
  }
  if (isMobileSalesUi()) {
    addToCartForCustomize(item, null);
    return;
  }
  addToCart(item, null);
}

function openVariantPicker(item, variants) {
  state.variantPickerItem = item;
  const dialog = $("variant-dialog");
  $("variant-item-name").textContent = item.name;
  const host = $("variant-options");
  host.innerHTML = "";
  for (const v of variants) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "variant-option";
    btn.setAttribute("role", "option");
    btn.innerHTML = `<strong>${escapeHtml(v.name)}</strong><span>${escapeHtml(
      formatPrice(v.priceCents)
    )}</span>`;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.addingLock) return;
      state.addingLock = true;
      try {
        if (isMobileSalesUi()) {
          addToCartForCustomize(item, v);
        } else {
          addToCart(item, v);
        }
        closeVariantPicker();
      } finally {
        setTimeout(() => {
          state.addingLock = false;
        }, 250);
      }
    });
    host.appendChild(btn);
  }
  if (typeof dialog.showModal === "function" && !dialog.open) {
    dialog.showModal();
  }
  host.querySelector("button")?.focus();
}

function closeVariantPicker() {
  const dialog = $("variant-dialog");
  state.variantPickerItem = null;
  if (dialog?.open) dialog.close();
  $("menu-search")?.focus();
}

function formatPrepTimeDisplay(min, max) {
  if (min == null && max == null) return null;
  if (min != null && max != null) {
    if (min === max) return `${min} minute${min === 1 ? "" : "s"}`;
    return `${min}–${max} minutes`;
  }
  const n = min ?? max;
  return `About ${n} minute${n === 1 ? "" : "s"}`;
}

function stationNameForId(stationId) {
  if (!stationId) return "";
  const s = (state.stations || []).find(
    (x) => x.station_id === stationId || x.stationId === stationId
  );
  return s?.name || "";
}

function setPkTab(tab) {
  state.pkTab = tab === "ingredients" || tab === "service" ? tab : "about";
  document.querySelectorAll(".pk-tab").forEach((btn) => {
    const active = btn.dataset.pkTab === state.pkTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  renderProductKnowledgeBody();
}

function renderPkMedia(imageUrl, name) {
  const host = $("pk-item-media");
  if (!host) return;
  host.innerHTML = "";
  if (!imageUrl) {
    host.classList.add("is-empty");
    return;
  }
  host.classList.remove("is-empty");
  const img = document.createElement("img");
  img.alt = "";
  img.loading = "lazy";
  img.src = imageUrl;
  img.addEventListener("error", () => {
    host.innerHTML = "";
    host.classList.add("is-empty");
  });
  host.appendChild(img);
}

function pkSectionBlock(title, bodyHtml) {
  if (!bodyHtml) return "";
  return `<section class="pk-block"><h4>${escapeHtml(title)}</h4>${bodyHtml}</section>`;
}

function pkPlainPara(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  return `<p class="pk-text">${escapeHtml(t).replaceAll("\n", "<br>")}</p>`;
}

function renderProductKnowledgeBody() {
  const host = $("pk-dialog-body");
  if (!host) return;
  const payload = state.pkPayload;
  if (!payload) {
    host.innerHTML = `<p class="pk-loading">Loading…</p>`;
    return;
  }
  const pk = payload.productKnowledge || {};
  const shortDesc = payload.menuItem?.description || "";
  const hasContent = Boolean(payload.hasContent);

  if (!hasContent) {
    const adminHint =
      state.role === "admin"
        ? `<p class="pk-admin-hint"><a href="/menu.html">Open Menu Setup</a> to add product information for this item.</p>`
        : "";
    host.innerHTML = `<div class="pk-empty-state"><p class="pk-empty">Product information has not been added yet.</p>${adminHint}</div>`;
    return;
  }

  if (state.pkTab === "ingredients") {
    const chips = (pk.ingredients || [])
      .map((n) => `<span class="pk-chip-view">${escapeHtml(n)}</span>`)
      .join("");
    const allergenVerified = Boolean(pk.allergenVerified);
    const allergenNotes = String(pk.allergenNotes || "").trim();
    let allergenHtml = "";
    if (allergenVerified && allergenNotes) {
      allergenHtml = pkSectionBlock(
        "Verified allergens",
        pkPlainPara(allergenNotes)
      );
    } else if (allergenNotes && !allergenVerified) {
      allergenHtml = pkSectionBlock(
        "Allergen notes",
        `${pkPlainPara(allergenNotes)}<p class="pk-caution">Allergen information not verified — confirm with the restaurant.</p>`
      );
    } else {
      allergenHtml = `<p class="pk-caution">Allergen information not verified — confirm with the restaurant.</p>`;
    }
    host.innerHTML = `
      ${
        chips
          ? pkSectionBlock(
              "Main ingredients",
              `<div class="pk-chip-row">${chips}</div>`
            )
          : `<p class="pk-muted-line">No ingredients listed.</p>`
      }
      ${allergenHtml}
    `;
    return;
  }

  if (state.pkTab === "service") {
    const prep = formatPrepTimeDisplay(pk.prepTimeMin, pk.prepTimeMax);
    const station =
      stationNameForId(payload.menuItem?.prepStationId) ||
      (payload.menuItem?.stationIds || [])
        .map(stationNameForId)
        .filter(Boolean)
        .join(", ");
    const rows = [
      pk.brand
        ? pkSectionBlock("Brand", pkPlainPara(pk.brand))
        : "",
      pk.ingredientBrand
        ? pkSectionBlock("Ingredient brand", pkPlainPara(pk.ingredientBrand))
        : "",
      prep
        ? pkSectionBlock(
            "Estimated preparation time",
            `${pkPlainPara(prep)}<p class="pk-muted-line">Estimate only — not a guaranteed completion time.</p>`
          )
        : pkSectionBlock(
            "Estimated preparation time",
            `<p class="pk-muted-line">Preparation time not specified.</p>`
          ),
      pk.servingStyle
        ? pkSectionBlock("Serving style", pkPlainPara(pk.servingStyle))
        : "",
      pk.servingAccompaniments
        ? pkSectionBlock("Served with", pkPlainPara(pk.servingAccompaniments))
        : "",
      station
        ? pkSectionBlock("Preparation station", pkPlainPara(station))
        : "",
      pk.serviceNotes
        ? pkSectionBlock("Service notes", pkPlainPara(pk.serviceNotes))
        : "",
    ]
      .filter(Boolean)
      .join("");
    host.innerHTML =
      rows || `<p class="pk-muted-line">No service details listed.</p>`;
    return;
  }

  // About
  const quick = String(pk.salesmanQuickAnswer || "").trim();
  const parts = [
    quick
      ? `<section class="pk-quick-answer"><h4>Salesman Quick Answer</h4>${pkPlainPara(quick)}</section>`
      : "",
    shortDesc ? pkSectionBlock("Short description", pkPlainPara(shortDesc)) : "",
    pk.detailedDescription
      ? pkSectionBlock(
          "Detailed description",
          pkPlainPara(pk.detailedDescription)
        )
      : "",
    pk.specialFeatures
      ? pkSectionBlock("Special features", pkPlainPara(pk.specialFeatures))
      : "",
  ]
    .filter(Boolean)
    .join("");
  host.innerHTML =
    parts || `<p class="pk-muted-line">No about details listed.</p>`;
}

async function openProductKnowledge(item) {
  const dialog = $("pk-dialog");
  if (!dialog || !item) return;
  state._pkTrigger = document.activeElement;
  state.pkItem = item;
  state.pkPayload = null;
  state.pkTab = "about";
  $("pk-item-name").textContent = item.name || "Product information";
  const catBits = [item.category, item.subcategory].filter(Boolean).join(" · ");
  const catEl = $("pk-item-category");
  if (catEl) {
    if (catBits) {
      catEl.hidden = false;
      catEl.textContent = catBits;
    } else {
      catEl.hidden = true;
      catEl.textContent = "";
    }
  }
  renderPkMedia(item.image_url || item.imageUrl || null, item.name);
  setPkTab("about");
  renderProductKnowledgeBody();
  if (typeof dialog.showModal === "function" && !dialog.open) {
    dialog.showModal();
  }
  $("pk-close-btn")?.focus();

  const res = await api(
    `/v1/menu-items/${encodeURIComponent(item.item_id)}/product-knowledge`
  );
  if (state.pkItem?.item_id !== item.item_id) return;
  if (!res.ok) {
    const host = $("pk-dialog-body");
    if (host) {
      host.innerHTML = `<p class="pk-empty">${escapeHtml(
        res.json?.error || "Could not load product information."
      )}</p>`;
    }
    return;
  }
  state.pkPayload = res.json;
  if (res.json?.menuItem?.imageUrl || res.json?.menuItem?.image_url) {
    renderPkMedia(
      res.json.menuItem.imageUrl || res.json.menuItem.image_url,
      res.json.menuItem.name
    );
  }
  renderProductKnowledgeBody();
}

function closeProductKnowledge() {
  const dialog = $("pk-dialog");
  state.pkItem = null;
  state.pkPayload = null;
  if (dialog?.open) dialog.close();
  const trigger = state._pkTrigger;
  state._pkTrigger = null;
  if (trigger && typeof trigger.focus === "function") {
    trigger.focus();
  } else {
    $("menu-search")?.focus();
  }
}

function lineSplitNo(line) {
  const n = Number(line?.splitNo);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 1;
}

function linesForSplit(splitNo) {
  const n = lineSplitNo({ splitNo });
  return state.cart.filter((line) => lineSplitNo(line) === n);
}

function splitIds() {
  const ids = new Set(state.cart.map((line) => lineSplitNo(line)));
  if (!ids.size) ids.add(1);
  else ids.add(lineSplitNo({ splitNo: state.activeSplit }));
  return [...ids].sort((a, b) => a - b);
}

function splitItemsCents(lines) {
  return lines.reduce((sum, line) => sum + line.quantity * lineUnitCents(line), 0);
}

function splitInUse() {
  return splitIds().length > 1;
}

function lineMergeKey(line) {
  return [
    line.itemId,
    line.variantId || "",
    Number(line.priceCents || 0),
    line.basePriceAdjusted ? "1" : "0",
    line.taxApplicable !== false ? "1" : "0",
    lineSplitNo(line),
    customizationKey(line),
  ].join("::");
}

function lineConfiguredPrice(line) {
  return Number(
    line.configuredPriceCents != null
      ? line.configuredPriceCents
      : line.priceCents || 0
  );
}

function buildCartCandidate(item, variant) {
  const priceCents = variant
    ? Number(variant.priceCents || 0)
    : Number(item.price_cents || 0);
  return {
    lineId: `line_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    itemId: item.item_id,
    name: item.name,
    variantId: variant?.variantId || null,
    variantName: variant?.name || "",
    imageUrl: item.image_url || "",
    configuredPriceCents: priceCents,
    priceCents,
    basePriceAdjusted: false,
    taxApplicable: item.taxApplicable !== false,
    stationIds: item.stationIds || [],
    instructionModifiers: item.instructionModifiers || DEFAULT_MODIFIERS,
    instructionTargets: item.instructionTargets || DEFAULT_TARGETS,
    instructionStandalone: item.instructionStandalone || [],
    availableAddons: (item.addons || []).filter((a) => a.isActive),
    quantity: 1,
    instructions: [],
    orderNote: "",
    addons: [],
    splitNo: lineSplitNo({ splitNo: state.activeSplit }),
  };
}

function addToCart(item, variant) {
  if (!item.is_active) {
    setStatus("That item is inactive.", false);
    return;
  }
  if (item.is_sold_out) {
    setStatus("That item is sold out.", false);
    return;
  }
  if (variant) {
    if (!variant.isActive || variant.isSoldOut) {
      setStatus("That variant is unavailable.", false);
      return;
    }
  } else if (item.hasVariants && salesVariants(item).length) {
    openVariantPicker(item, salesVariants(item));
    return;
  }

  const candidate = buildCartCandidate(item, variant);
  const key = lineMergeKey(candidate);
  const existing = state.cart.find((l) => lineMergeKey(l) === key);
  if (existing) {
    existing.quantity += 1;
    focusCartLine(existing.lineId, { follow: true });
  } else {
    state.cart.push(candidate);
    focusCartLine(candidate.lineId, { follow: true });
  }
  renderCart();
  renderMenu();
  const label = variant
    ? `${item.name} — ${variant.name}`
    : item.name;
  showToast(splitInUse() ? `Added ${label} to order ${lineSplitNo(candidate)}` : `Added ${label}`);
  setStatus("");
  void syncDraftNumber();
}

/** Mobile/small screens: create a draft line and open customize before confirming. */
function addToCartForCustomize(item, variant) {
  if (!item.is_active) {
    setStatus("That item is inactive.", false);
    return;
  }
  if (item.is_sold_out) {
    setStatus("That item is sold out.", false);
    return;
  }
  if (variant) {
    if (!variant.isActive || variant.isSoldOut) {
      setStatus("That variant is unavailable.", false);
      return;
    }
  } else if (item.hasVariants && salesVariants(item).length) {
    openVariantPicker(item, salesVariants(item));
    return;
  }

  const candidate = buildCartCandidate(item, variant);
  candidate._pendingCustomize = true;
  state.cart.push(candidate);
  renderCart();
  renderMenu();
  setStatus("");
  void syncDraftNumber();
  state._customizeTrigger = document.activeElement;
  openInstructions(candidate.lineId);
}

function focusCartLine(lineId, { follow = false } = {}) {
  state.cartFocusLineId = lineId || null;
  state.cartFollowLatest = Boolean(follow && lineId);
}

function cartLineElById(lineId) {
  const host = $("cart-lines");
  if (!host || !lineId) return null;
  const id =
    typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(lineId)
      : String(lineId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return host.querySelector(`[data-line-id="${id}"]`);
}

function prefersReducedCartMotion() {
  return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
}

function flashCartLine(el) {
  if (!el) return;
  const host = $("cart-lines");
  host?.querySelectorAll(".cart-line.just-added").forEach((n) => n.classList.remove("just-added"));
  clearTimeout(state._cartFlashTimer);
  el.classList.add("just-added");
  state._cartFlashTimer = window.setTimeout(() => {
    el.classList.remove("just-added");
  }, 1000);
}

function scrollCartToSplit(splitNo) {
  const host = $("cart-lines");
  if (!host) return;
  const lines = linesForSplit(splitNo);
  if (!lines.length) return;
  const el = cartLineElById(lines[lines.length - 1].lineId);
  if (!el) return;
  flashCartLine(el);
  state._cartProgrammaticScroll = true;
  el.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: prefersReducedCartMotion() ? "auto" : "smooth",
  });
  window.setTimeout(() => {
    state._cartProgrammaticScroll = false;
  }, prefersReducedCartMotion() ? 0 : 320);
}

function revealFocusedCartLine() {
  const host = $("cart-lines");
  if (!host || !state.cartFocusLineId) return;
  const el = cartLineElById(state.cartFocusLineId);
  if (!el) return;
  flashCartLine(el);
  host.querySelector(".cart-scroll-tail")?.remove();
  const pad = 6;
  const hostRect = host.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const name = el.querySelector(".cart-line-name");
  const nameRect = name ? name.getBoundingClientRect() : rect;
  const top = host.scrollTop + (rect.top - hostRect.top);
  const nameTop = host.scrollTop + (nameRect.top - hostRect.top);
  const view = host.clientHeight;
  const fullyInside =
    rect.top >= hostRect.top + pad - 1 && rect.bottom <= hostRect.bottom - pad + 1;
  let next = host.scrollTop;
  if (!fullyInside) {
    if (rect.height + pad * 2 <= view) {
      next =
        rect.top < hostRect.top + pad
          ? Math.max(0, top - pad)
          : Math.max(0, top - (view - rect.height - pad));
    } else {
      next = Math.max(0, nameTop - pad);
    }
  }
  const maxScroll = Math.max(0, host.scrollHeight - view);
  if (next > maxScroll) {
    let tail = host.querySelector(".cart-scroll-tail");
    if (!tail) {
      tail = document.createElement("div");
      tail.className = "cart-scroll-tail";
      tail.setAttribute("aria-hidden", "true");
      host.appendChild(tail);
    }
    tail.style.height = `${Math.ceil(next - maxScroll)}px`;
  }
  state._cartProgrammaticScroll = true;
  host.scrollTop = next;
  window.setTimeout(() => {
    state._cartProgrammaticScroll = false;
  }, 320);
}

function onCartLinesScroll() {
  if (state._cartProgrammaticScroll) return;
  if (!state.cartFollowLatest) return;
  state.cartFollowLatest = false;
  $("cart-lines")
    ?.querySelectorAll(".cart-line.just-added")
    .forEach((n) => n.classList.remove("just-added"));
}

function instructionKey(list) {
  return (list || [])
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
}

function cartTotals() {
  let count = 0;
  let cents = 0;
  for (const line of state.cart) {
    count += line.quantity;
    cents += line.quantity * lineUnitCents(line);
  }
  return { count, cents };
}

function cartTaxEstimate() {
  return estimateOrderTax(state.cart, state.config?.shop || {});
}

function selectedOrderType() {
  const id = $("order-type")?.value;
  return (state.orderTypes || []).find((row) => row.orderTypeId === id) || null;
}

function blankFulfillment() {
  return {
    customerId: "",
    addressId: "",
    addressLabel: "",
    customerName: "",
    customerPhone: "",
    buildingNumber: "",
    roadNumber: "",
    blockNumber: "",
    addressNote: "",
    tableNumber: "",
    vehicleNumber: "",
    parkingLocation: "",
    counterLabel: "",
    deliveryChargeCents: null,
    deliveryFeeOverride: false,
    expectedBlockRateCents: null,
  };
}

function deliveryQuote() {
  const type = selectedOrderType();
  if (!type || type.behavior !== "DELIVERY" || !state.fulfillment.blockNumber) {
    return { show: false, cents: 0, valid: true };
  }
  const cents = state.fulfillment.deliveryChargeCents;
  const valid = Number.isSafeInteger(cents) && cents >= 0;
  return { show: true, cents: valid ? cents : 0, valid };
}

function deliveryFeeTaxEstimate() {
  const quote = deliveryQuote();
  if (!quote.show || !quote.valid || quote.cents <= 0) {
    return { taxCents: 0, addedCents: 0, treatment: "not_applied" };
  }
  const rate = activeBlockRate(state.fulfillment.blockNumber);
  if (!rate?.taxApplicable) {
    return { taxCents: 0, addedCents: 0, treatment: "not_applied" };
  }
  return estimateDeliveryFeeTax(quote.cents, true, state.config?.shop || {});
}

function deliveryTaxHint() {
  const fee = deliveryFeeTaxEstimate();
  if (fee.treatment === "not_applied") return "";
  const shop = state.config?.shop || {};
  const name = shop.taxName || "VAT";
  const rate = formatTaxPercentFromBps(shop.taxRateBps || 0);
  if (fee.treatment === "included") return `Includes ${name} (${rate}%)`;
  return `${name} (${rate}%) is added`;
}

function customerPayableCents(tax) {
  const quote = deliveryQuote();
  const fee = deliveryFeeTaxEstimate();
  return (
    Number(tax?.totalCents || 0) +
    (quote.show && quote.valid ? quote.cents : 0) +
    fee.addedCents
  );
}

function renderTaxSummaryHtml(tax, { compact = false, itemCount = null, showEstimateNote = true } = {}) {
  if (!tax) return "";
  const rate = formatTaxPercentFromBps(tax.taxRateBps || 0);
  const quote = deliveryQuote();
  const feeTax = deliveryFeeTaxEstimate();
  const shownTaxCents = Number(tax.taxCents || 0) + feeTax.taxCents;
  const payable =
    Number(tax.totalCents || 0) +
    (quote.show && quote.valid ? quote.cents : 0) +
    feeTax.addedCents;
  const itemsRow =
    itemCount != null
      ? `<div><span class="muted">Items</span> <strong>${itemCount}</strong></div>`
      : "";
  const deliveryRow = quote.show
    ? `<div><span class="muted">Delivery charge</span> <strong>${
        quote.valid ? formatPrice(quote.cents) : "—"
      }</strong></div>`
    : "";
  const est = tax.estimate && showEstimateNote
    ? `<p class="muted tax-est-note">Estimate — server validates on send</p>`
    : "";
  if (!tax.taxEnabled) {
    return `${est}<div class="tax-breakdown${compact ? " compact" : ""}">
      ${itemsRow}
      <div><span class="muted">Items total</span> <strong>${formatPrice(tax.goodsCents)}</strong></div>
      ${deliveryRow}
      <div class="tax-row-final"><span class="muted">Customer total</span> <strong>${formatPrice(payable)}</strong></div>
    </div>`;
  }
  if (tax.taxMode === "inclusive") {
    return `${est}<div class="tax-breakdown${compact ? " compact" : ""}">
      ${itemsRow}
      <div><span class="muted">Items total</span> <strong>${formatPrice(tax.goodsCents)}</strong></div>
      ${
        tax.nontaxableGoodsCents > 0
          ? `<div><span class="muted">Taxable</span> <strong>${formatPrice(tax.taxableGoodsCents)}</strong></div>
             <div><span class="muted">Non-taxable</span> <strong>${formatPrice(tax.nontaxableGoodsCents)}</strong></div>`
          : ""
      }
      <div><span class="muted">Included ${escapeHtml(tax.taxName)} (${rate}%)</span> <strong>${formatPrice(shownTaxCents)}</strong></div>
      ${deliveryRow}
      <div class="tax-row-final"><span class="muted">Customer total</span> <strong>${formatPrice(payable)}</strong></div>
    </div>`;
  }
  return `${est}<div class="tax-breakdown${compact ? " compact" : ""}">
    ${itemsRow}
    <div><span class="muted">Items total</span> <strong>${formatPrice(tax.goodsCents)}</strong></div>
    ${
      tax.nontaxableGoodsCents > 0 || tax.taxableGoodsCents !== tax.goodsCents
        ? `<div><span class="muted">Taxable amount</span> <strong>${formatPrice(tax.taxableGoodsCents)}</strong></div>`
        : ""
    }
    ${
      tax.nontaxableGoodsCents > 0
        ? `<div><span class="muted">Non-taxable</span> <strong>${formatPrice(tax.nontaxableGoodsCents)}</strong></div>`
        : ""
    }
    <div><span class="muted">${escapeHtml(tax.taxName)} (${rate}%)</span> <strong>${formatPrice(shownTaxCents)}</strong></div>
    ${deliveryRow}
    <div class="tax-row-final"><span class="muted">Customer total</span> <strong>${formatPrice(payable)}</strong></div>
  </div>`;
}

function renderSplitBar() {
  const bar = $("split-bar");
  if (!bar) return;
  if (!state.cart.length) {
    state.activeSplit = 1;
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  const ids = splitIds();
  bar.hidden = false;
  if (ids.length === 1) {
    bar.innerHTML = `<button type="button" class="btn ghost small split-add" data-split-add>+ Order</button>`;
    return;
  }
  bar.innerHTML =
    ids
      .map((n) => {
        const lines = linesForSplit(n);
        const active = lineSplitNo({ splitNo: state.activeSplit }) === n;
        const totalLabel = formatPrice(splitItemsCents(lines));
        return `<span class="split-chip-wrap">
          <button type="button" class="split-chip${active ? " active" : ""}" data-split="${n}" aria-pressed="${active ? "true" : "false"}" title="${escapeHtml(totalLabel)}">
            <span>Order ${n}</span>
          </button>
          ${
            lines.length
              ? ""
              : `<button type="button" class="split-remove" data-split-remove="${n}" aria-label="Remove empty order ${n}">×</button>`
          }
        </span>`;
      })
      .join("") +
    `<button type="button" class="btn ghost small split-add" data-split-add>+ Order</button>`;
}

function addSplitOrder() {
  const next = Math.max(...splitIds()) + 1;
  if (next > 12) {
    showToast("12 orders is the limit");
    return;
  }
  state.activeSplit = next;
  renderCart();
  showToast(`Order ${next} is ready. New items go there.`);
}

function moveLineToSplit(line, splitNo) {
  const next = lineSplitNo({ splitNo });
  if (!line || lineSplitNo(line) === next) return;
  line.splitNo = next;
  const key = lineMergeKey(line);
  const dup = state.cart.find((other) => other !== line && lineMergeKey(other) === key);
  if (dup) {
    dup.quantity += Number(line.quantity || 1);
    state.cart = state.cart.filter((other) => other !== line);
    focusCartLine(dup.lineId, { follow: true });
  } else {
    focusCartLine(line.lineId, { follow: true });
  }
  renderCart();
}

function renderCart() {
  const host = $("cart-lines");
  host.innerHTML = "";
  const totals = cartTotals();
  const tax = cartTaxEstimate();
  if ($("mobile-cart-count")) {
    $("mobile-cart-count").textContent = String(totals.count);
  }
  if ($("mobile-cart-total")) {
    $("mobile-cart-total").textContent = formatPrice(customerPayableCents(tax));
  }
  const mobileBar = $("mobile-cart-bar");
  if (mobileBar) {
    mobileBar.hidden = false;
  }
  const orderInput = $("order-number");
  if (orderInput) {
    orderInput.title = state.orderNumber || "";
  }
  const payable = customerPayableCents(tax);
  const reviewBtn = $("review-btn") || $("review-order-btn");
  if (reviewBtn) {
    reviewBtn.textContent = state.cart.length
      ? `Review & Send · ${formatPrice(payable)}`
      : "Review & Send";
  }
  const taxHost = $("cart-tax-summary");
  if (taxHost) {
    if (!state.cart.length) state.cartPriceBreakdownOpen = false;
    taxHost.innerHTML = state.cart.length
      ? `<div class="cart-totals-block">
          <div class="cart-total-row cart-total-row-subtotal">
            <span class="cart-subtotal-label">
              Subtotal
              <button type="button" id="cart-price-breakdown-toggle"
                class="cart-price-breakdown-link"
                aria-expanded="${state.cartPriceBreakdownOpen}"
                aria-controls="cart-price-breakdown">
                ${state.cartPriceBreakdownOpen ? "Hide breakdown" : "Price breakdown"}
              </button>
            </span>
            <strong class="cart-total-value cart-subtotal-value">${escapeHtml(formatPrice(totals.cents))}</strong>
          </div>
          <div class="cart-total-row cart-total-row-primary">
            <span>Total</span>
            <strong class="cart-total-value">${escapeHtml(formatPrice(payable))}</strong>
          </div>
        </div>
        <div id="cart-price-breakdown" class="cart-price-detail" ${state.cartPriceBreakdownOpen ? "" : "hidden"}>
          ${renderTaxSummaryHtml(tax, { compact: true, itemCount: totals.count, showEstimateNote: false })}
        </div>`
      : "";
  }

  const activeSplitNo = lineSplitNo({ splitNo: state.activeSplit });
  const activeSplitEmpty = splitInUse() && !linesForSplit(activeSplitNo).length;
  const itemsLabel = $("cart-items-label");
  if (itemsLabel) {
    itemsLabel.textContent = activeSplitEmpty
      ? `Order ${activeSplitNo} is empty - tap a menu item to add`
      : `Items (${totals.count})`;
  }
  renderSplitBar();
  if (!state.cart.length) {
    host.innerHTML = `<p class="empty">Cart is empty. Tap a menu item to add it.</p>`;
    state.cartFocusLineId = null;
    state.cartFollowLatest = false;
    syncReviewWithCart();
    return;
  }
  const groups = splitInUse() ? splitIds() : [null];
  for (const splitNo of groups) {
    const groupLines = splitNo == null ? state.cart : linesForSplit(splitNo);
    if (splitNo != null) {
      const head = document.createElement("div");
      head.className = "split-group-head";
      head.dataset.splitGroup = String(splitNo);
      const adding = activeSplitNo === splitNo;
      head.innerHTML = `<span>Order ${splitNo}${adding ? " · adding here" : ""}</span><strong>${formatSplitGroupTotalLabel(formatPrice(splitItemsCents(groupLines)))}</strong>`;
      host.appendChild(head);
      if (!groupLines.length) {
        const note = document.createElement("p");
        note.className = "muted split-empty";
        note.dataset.splitEmpty = String(splitNo);
        note.textContent = `Order ${splitNo} is empty - tap a menu item to add`;
        host.appendChild(note);
      }
    }
  for (const line of groupLines) {
    const el = document.createElement("div");
    el.className = "cart-line cart-line-compact";
    el.dataset.lineId = line.lineId;
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.setAttribute("aria-label", `Edit ${line.name}`);
    if (line.lineId === state.cartFocusLineId && state.cartFollowLatest) {
      el.classList.add("just-added");
    }
    const notePreview = cartLineNotePreview(line);
    const unit = lineUnitCents(line);
    const lineTotal = formatPrice(unit * line.quantity);
    const nameHtml = escapeHtml(line.name);
    const variantBit = line.variantName ? ` · ${escapeHtml(line.variantName)}` : "";
    const adjusted =
      line.basePriceAdjusted ||
      Number(line.priceCents) !== lineConfiguredPrice(line);
    const editHint =
      '<span class="cart-line-edit-hint" aria-hidden="true"><svg viewBox="0 0 20 20" width="14" height="14"><path fill="currentColor" d="M14.7 2.3a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4l-9.5 9.5-3.2.8a.5.5 0 0 1-.6-.6l.8-3.2 9.5-9.5z"/></svg></span>';
    el.innerHTML = `
      <div class="cart-line-row cart-line-row-primary">
        <span class="cart-line-title">
          <strong class="cart-line-name">${nameHtml}</strong>${variantBit}${
            adjusted ? ` <span class="price-adjusted-badge">Adj</span>` : ""
          }
          ${editHint}
        </span>
        <strong class="cart-line-total">${lineTotal}</strong>
      </div>
      ${
        notePreview
          ? `<p class="cart-line-note muted" title="${escapeHtml(notePreview)}">📝 ${escapeHtml(notePreview)}</p>`
          : ""
      }
      <div class="cart-line-row cart-line-row-meta">
        <span class="cart-line-unit muted" title="${escapeHtml(formatPrice(unit))}">${formatPrice(unit)}</span>
        <div class="cart-line-toolbar">
          ${
            splitInUse()
              ? `<label class="split-move"><select data-act="move-split" aria-label="Move ${escapeHtml(line.name)} to another order">${splitIds()
                  .map(
                    (n) =>
                      `<option value="${n}"${n === lineSplitNo(line) ? " selected" : ""}>Order ${n}</option>`
                  )
                  .join("")}</select></label>`
              : ""
          }
          <div class="qty-controls">
            <button type="button" data-act="dec" aria-label="Decrease quantity">−</button>
            <span class="qty-value" aria-live="polite">${line.quantity}</span>
            <button type="button" data-act="inc" aria-label="Increase quantity">+</button>
          </div>
          <button type="button" class="icon-btn danger" data-act="remove" aria-label="Remove item" title="Remove">
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M7 3h6l.5 1H17v2H3V4h3.5L7 3zm1 5h2v7H8V8zm4 0h2v7h-2V8zM5 8h2v7H5V8z"/></svg>
          </button>
        </div>
      </div>
    `;
    const openCustomize = (e) => {
      if (
        e?.target?.closest?.(
          ".cart-line-toolbar, [data-act='dec'], [data-act='inc'], [data-act='remove'], [data-act='move-split']"
        )
      ) {
        return;
      }
      e?.preventDefault?.();
      e?.stopPropagation?.();
      state._customizeTrigger = el;
      openInstructions(line.lineId);
    };
    el.addEventListener("click", openCustomize);
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (
        e.target?.closest?.(
          ".cart-line-toolbar, [data-act='dec'], [data-act='inc'], [data-act='remove'], [data-act='move-split']"
        )
      ) {
        return;
      }
      e.preventDefault();
      openCustomize(e);
    });
    el.querySelector(".cart-line-toolbar")?.addEventListener("click", (e) => e.stopPropagation());
    el.querySelector(".cart-line-toolbar")?.addEventListener("keydown", (e) => e.stopPropagation());
    el.querySelector('[data-act="dec"]').addEventListener("click", (e) => {
      e.stopPropagation();
      if (line.quantity <= 1) {
        const removed = state.cart.find((l) => l.lineId === line.lineId);
        state.cart = state.cart.filter((l) => l.lineId !== line.lineId);
        if (removed) showCartUndo(removed);
        if (state.cartFocusLineId === line.lineId) {
          focusCartLine(null);
        }
      } else {
        line.quantity -= 1;
      }
      renderCart();
      renderMenu();
    });
    el.querySelector('[data-act="inc"]').addEventListener("click", (e) => {
      e.stopPropagation();
      line.quantity += 1;
      renderCart();
      renderMenu();
      void syncDraftNumber();
    });
    el.querySelector('[data-act="remove"]').addEventListener("click", (e) => {
      e.stopPropagation();
      const removed = state.cart.find((l) => l.lineId === line.lineId);
      state.cart = state.cart.filter((l) => l.lineId !== line.lineId);
      if (removed) showCartUndo(removed);
      if (state.cartFocusLineId === line.lineId) {
        focusCartLine(null);
      }
      renderCart();
      renderMenu();
    });
    el.querySelector('[data-act="move-split"]')?.addEventListener("change", (e) => {
      moveLineToSplit(line, Number(e.target.value));
    });
    host.appendChild(el);
  }
  }
  if (state.cartFollowLatest && state.cartFocusLineId) {
    requestAnimationFrame(() => revealFocusedCartLine());
  } else if (state._scrollToSplitAfterRender != null) {
    const splitTarget = state._scrollToSplitAfterRender;
    state._scrollToSplitAfterRender = null;
    requestAnimationFrame(() => scrollCartToSplit(splitTarget));
  }
  persistActiveCart();
  updateHeldCartUi();
  syncReviewWithCart();
}

function openInstructions(lineId) {
  const line = state.cart.find((l) => l.lineId === lineId);
  if (!line) return;
  if (line.configuredPriceCents == null) {
    line.configuredPriceCents = Number(line.priceCents || 0);
  }
  state.editingLineId = lineId;
  state.selectedMod = null;
  state.selectedTargets = [];
  state.kitchenStep = 1;
  state.customizeTab = "notes";
  state.priceBreakdownOpen = false;
  const priceOverride = $("customize-price-override");
  if (priceOverride) priceOverride.open = false;
  const priceBreakdown = $("customize-price-breakdown");
  if (priceBreakdown) priceBreakdown.open = false;
  const configured = lineConfiguredPrice(line);
  const applied = Number(line.priceCents || 0);
  state.customizeDraft = {
    lineId,
    isNew: Boolean(line._pendingCustomize),
    quantity: Number(line.quantity || 1),
    qtyDraft: String(Number(line.quantity || 1)),
    configuredPriceCents: configured,
    unitPriceCents: applied,
    basePriceAdjusted: Boolean(line.basePriceAdjusted) || applied !== configured,
    priceDraft: state.money
      ? state.money.formatPlain(applied)
      : String(applied),
    instructions: [...(line.instructions || [])],
    orderNote: String(line.orderNote || ""),
    addons: (line.addons || []).map((a) => {
      const entered = Boolean(a.priceEnteredAtSale);
      const applied = addonAppliedPrice(a);
      return {
        addonId: a.addonId,
        name: a.name,
        quantity: a.quantity || 1,
        priceEnteredAtSale: entered,
        configuredUnitPriceCents: entered ? null : addonConfiguredPrice(a),
        unitPriceCents: applied,
        priceAdjusted: entered ? false : Boolean(a.priceAdjusted),
        taxApplicable: a.taxApplicable !== false,
        draftText:
          applied == null
            ? ""
            : state.money
              ? state.money.formatPlain(applied)
              : String(applied),
        editingPrice: entered,
      };
    }),
    priceError: "",
  };
  $("instr-item-name").textContent = line.name;
  const variantLabel = $("customize-variant-label");
  if (variantLabel) {
    if (line.variantName) {
      variantLabel.hidden = false;
      variantLabel.textContent = line.variantName;
    } else {
      variantLabel.hidden = true;
      variantLabel.textContent = "";
    }
  }
  renderCustomizeMedia(line);
  $("custom-note").value = state.customizeDraft.orderNote;
  const hint = $("addon-price-hint");
  if (hint) {
    hint.hidden = state.canAdjustAddonPrices;
    hint.textContent = state.canAdjustAddonPrices
      ? ""
      : "Changing a priced add-on needs add-on price permission. If an add-on has no price, enter it here.";
  }
  setCustomizeTab("notes");
  syncCustomizeQty();
  syncCustomizeUnitPrice();
  setKitchenStep(1);
  renderInstrChips();
  renderSelectedInstructions();
  renderAddonPicker();
  updatePriceSummary();
  const addonErr = $("addon-price-error");
  const priceErr = $("customize-price-error");
  if (addonErr) addonErr.hidden = true;
  if (priceErr) priceErr.hidden = true;
  const applyBtn = $("customize-apply-btn");
  if (applyBtn) {
    applyBtn.textContent = state.customizeDraft.isNew
      ? "Add to cart"
      : "Apply Customization";
  }
  // Defer showModal so the opening click cannot immediately dismiss the dialog.
  document.body.classList.add("customize-open");
  const dialog = $("instr-dialog");
  const reveal = () => {
    if (!dialog) return;
    try {
      if (!dialog.open) dialog.showModal();
    } catch {
      try {
        dialog.setAttribute("open", "");
      } catch {
        /* ignore */
      }
    }
    if (isMobileSalesUi()) {
      // Phones/tablets: showModal() auto-focuses the first input (the quantity box),
      // which pops up the keyboard. Focus the sheet itself; staff tap a field to type.
      if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");
      document.activeElement?.blur?.();
      dialog.focus({ preventScroll: true });
      return;
    }
    const note = $("custom-note");
    note?.focus();
    note?.select?.();
  };
  if (typeof queueMicrotask === "function") queueMicrotask(reveal);
  else setTimeout(reveal, 0);
}

function renderCustomizeMedia(line) {
  const host = $("customize-item-media");
  const hero = $("customize-hero");
  if (!host) return;
  host.innerHTML = "";
  const hasPhoto = Boolean(line.imageUrl);
  if (!hasPhoto) {
    host.hidden = true;
    host.setAttribute("aria-hidden", "true");
    hero?.classList.add("customize-hero--no-media");
    return;
  }
  host.hidden = false;
  host.setAttribute("aria-hidden", "true");
  hero?.classList.remove("customize-hero--no-media");
  const img = document.createElement("img");
  img.src = line.imageUrl;
  img.alt = "";
  img.className = "customize-item-img";
  img.addEventListener("error", () => {
    host.innerHTML = "";
    host.hidden = true;
    hero?.classList.add("customize-hero--no-media");
  });
  host.appendChild(img);
}

function setCustomizeTab(tab) {
  state.customizeTab = tab === "extras" ? "extras" : "notes";
  const notes = $("panel-notes");
  const extras = $("panel-extras");
  const tabNotes = $("tab-notes");
  const tabExtras = $("tab-extras");
  if (notes) notes.hidden = state.customizeTab !== "notes";
  if (extras) extras.hidden = state.customizeTab !== "extras";
  if (tabNotes) {
    tabNotes.classList.toggle("active", state.customizeTab === "notes");
    tabNotes.setAttribute(
      "aria-selected",
      state.customizeTab === "notes" ? "true" : "false"
    );
  }
  if (tabExtras) {
    tabExtras.classList.toggle("active", state.customizeTab === "extras");
    tabExtras.setAttribute(
      "aria-selected",
      state.customizeTab === "extras" ? "true" : "false"
    );
  }
}

function kitchenStepTwoHeading(mod) {
  const action = String(mod || "").trim();
  if (!action) return `<span class="step-num" aria-hidden="true">2</span> Of what?`;
  const lower = action.toLowerCase();
  // Simple staff wording: "More of what?", "No what?", "Less of what?"
  if (lower === "no" || lower === "without") {
    return `<span class="step-num" aria-hidden="true">2</span> ${escapeHtml(action)} what?`;
  }
  return `<span class="step-num" aria-hidden="true">2</span> ${escapeHtml(action)} of what?`;
}

function setKitchenStep(step) {
  state.kitchenStep = step === 2 ? 2 : 1;
  const s1 = $("kitchen-step-1");
  const s2 = $("kitchen-step-2");
  if (s1) s1.hidden = state.kitchenStep !== 1;
  if (s2) s2.hidden = state.kitchenStep !== 2;
  const label = $("kitchen-target-label");
  if (label) {
    label.innerHTML =
      state.kitchenStep === 2
        ? kitchenStepTwoHeading(state.selectedMod)
        : `<span class="step-num" aria-hidden="true">2</span> Of what?`;
  }
  const step1 = $("kitchen-step-label");
  if (step1 && state.kitchenStep === 1) {
    step1.innerHTML = `<span class="step-num" aria-hidden="true">1</span> What change?`;
  }
  renderInstrChips();
}

function joinInstructionTargets(targets) {
  if (targets.length <= 1) return targets[0] || "";
  if (targets.length === 2) return `${targets[0]} and ${targets[1]}`;
  return `${targets.slice(0, -1).join(", ")} and ${targets[targets.length - 1]}`;
}

function syncKitchenTargetsOk() {
  const btn = $("kitchen-targets-ok");
  if (!btn) return;
  const count = state.selectedTargets.length;
  btn.disabled = count === 0;
  btn.textContent = count > 1 ? `Done (${count})` : "Done";
}

function showInstrFeedback(message, { error = false } = {}) {
  const el = $("instr-preview");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle("instr-feedback-error", error);
  window.setTimeout(() => {
    if (el.textContent === message) {
      el.hidden = true;
    }
  }, 1600);
}

function getDraft() {
  return state.customizeDraft;
}

function getEditingLine() {
  return state.cart.find((l) => l.lineId === state.editingLineId);
}

function syncCustomizeQty() {
  const draft = getDraft();
  const el = $("customize-qty");
  if (el && document.activeElement !== el) {
    el.value = draft?.qtyDraft ?? String(draft?.quantity || 1);
  }
  const dec = $("customize-qty-dec");
  if (dec) dec.disabled = !draft || Number(draft.quantity || 1) <= 1;
}

function changeCustomizeQty(delta) {
  const draft = getDraft();
  if (!draft) return;
  const next = Number(draft.quantity || 1) + delta;
  if (next < 1) return;
  draft.quantity = next;
  draft.qtyDraft = String(next);
  syncCustomizeQty();
  updatePriceSummary();
}

function onCustomizeQtyInput(e) {
  const draft = getDraft();
  if (!draft) return;
  draft.qtyDraft = e.target.value;
}

function commitCustomizeQty() {
  const draft = getDraft();
  const el = $("customize-qty");
  if (!draft || !el) return true;
  const raw = String(el.value ?? draft.qtyDraft ?? "").trim();
  if (!raw) {
    // Keep drafting empty while typing — do not delete the line in-modal.
    $("customize-price-error").hidden = false;
    $("customize-price-error").textContent = "Enter a quantity of 1 or more.";
    return false;
  }
  if (!/^\d+$/.test(raw)) {
    $("customize-price-error").hidden = false;
    $("customize-price-error").textContent =
      "Quantity must be a whole number (e.g. 1, 2, 10).";
    return false;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    $("customize-price-error").hidden = false;
    $("customize-price-error").textContent =
      "Quantity must be a whole number of at least 1.";
    return false;
  }
  draft.quantity = n;
  draft.qtyDraft = String(n);
  el.value = String(n);
  $("customize-price-error").hidden = true;
  syncCustomizeQty();
  updatePriceSummary();
  return true;
}

function syncCustomizeUnitPrice() {
  const draft = getDraft();
  const input = $("customize-unit-price");
  const badge = $("customize-price-adjusted");
  const reset = $("customize-price-reset");
  const locked = $("customize-price-locked");
  const configuredEl = $("customize-configured-price");
  const currencyEl = $("customize-price-currency");
  const labelEl = $("customize-price-label");
  if (!draft || !input) return;
  const canEdit = Boolean(state.canAdjustBasePrices);
  if (canEdit) {
    input.removeAttribute("readonly");
    input.disabled = false;
  } else {
    input.setAttribute("readonly", "readonly");
    input.disabled = false;
  }
  input.classList.toggle("is-editable", canEdit);
  if (currencyEl) {
    currencyEl.textContent = state.money?.label || "";
  }
  if (configuredEl) {
    configuredEl.textContent = `Menu price: ${formatPrice(draft.configuredPriceCents)}`;
  }
  if (labelEl) {
    labelEl.textContent = canEdit ? "Custom price" : "Unit price";
  }
  if (locked) locked.hidden = canEdit;
  if (document.activeElement !== input) {
    input.value =
      draft.priceDraft ??
      (state.money
        ? state.money.formatPlain(draft.unitPriceCents)
        : String(draft.unitPriceCents));
  }
  const adjusted =
    draft.basePriceAdjusted ||
    Number(draft.unitPriceCents) !== Number(draft.configuredPriceCents);
  if (badge) badge.hidden = !adjusted;
  if (reset) reset.hidden = !(canEdit && adjusted);
  updateCustomizeLineTotalPreview();
}

function updateCustomizeLineTotalPreview() {
  const draft = getDraft();
  const footer = $("customize-footer-total");
  const legacy = $("customize-line-total");
  if (!draft) return;
  const addons = draft.addons.reduce(
    (s, a) => s + Number(a.unitPriceCents || 0) * Number(a.quantity || 1),
    0
  );
  const unit = Number(draft.unitPriceCents || 0) + addons;
  const lineTotal = unit * Number(draft.quantity || 1);
  const label = `Line total ${formatPrice(lineTotal)}`;
  if (footer) footer.textContent = label;
  if (legacy) legacy.textContent = label;
}

function onCustomizeUnitPriceInput(e) {
  const draft = getDraft();
  if (!draft || !state.canAdjustBasePrices) return;
  const raw = e.target.value;
  draft.priceDraft = raw;
  const trimmed = String(raw || "").trim().replace(/,/g, "");
  if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) {
    try {
      const minor = state.money.parse(raw);
      if (minor >= 0) {
        draft.unitPriceCents = minor;
        draft.basePriceAdjusted =
          minor !== Number(draft.configuredPriceCents);
        $("customize-price-error").hidden = true;
        const badge = $("customize-price-adjusted");
        const reset = $("customize-price-reset");
        if (badge) badge.hidden = !draft.basePriceAdjusted;
        if (reset) reset.hidden = !draft.basePriceAdjusted;
        updateCustomizeLineTotalPreview();
        updatePriceSummary();
      }
    } catch {
      /* keep drafting */
    }
  }
}

function commitCustomizeUnitPrice() {
  const draft = getDraft();
  const input = $("customize-unit-price");
  const err = $("customize-price-error");
  if (!draft || !input) return true;
  if (!state.canAdjustBasePrices) {
    draft.unitPriceCents = Number(draft.configuredPriceCents || 0);
    draft.basePriceAdjusted = false;
    draft.priceDraft = state.money
      ? state.money.formatPlain(draft.unitPriceCents)
      : String(draft.unitPriceCents);
    syncCustomizeUnitPrice();
    return true;
  }
  const raw = String(input.value ?? draft.priceDraft ?? "").trim();
  if (!raw || raw === "." || /\.$/.test(raw)) {
    if (err) {
      err.hidden = false;
      err.textContent = "Enter a complete custom price.";
    }
    return false;
  }
  try {
    const minor = state.money.parse(raw);
    if (minor < 0) {
      if (err) {
        err.hidden = false;
        err.textContent = "Custom price cannot be negative.";
      }
      return false;
    }
    draft.unitPriceCents = minor;
    draft.basePriceAdjusted = minor !== Number(draft.configuredPriceCents);
    draft.priceDraft = state.money.formatPlain(minor);
    input.value = draft.priceDraft;
    if (err) err.hidden = true;
    syncCustomizeUnitPrice();
    updatePriceSummary();
    return true;
  } catch (ex) {
    if (err) {
      err.hidden = false;
      err.textContent = ex.message || "Invalid price.";
    }
    return false;
  }
}

function resetCustomizeUnitPrice() {
  const draft = getDraft();
  if (!draft || !state.canAdjustBasePrices) return;
  draft.unitPriceCents = Number(draft.configuredPriceCents || 0);
  draft.basePriceAdjusted = false;
  draft.priceDraft = state.money
    ? state.money.formatPlain(draft.unitPriceCents)
    : String(draft.unitPriceCents);
  syncCustomizeUnitPrice();
  updatePriceSummary();
  $("customize-unit-price")?.focus();
}

function renderAddonPicker() {
  const host = $("addon-pick-list");
  if (!host) return;
  const line = getEditingLine();
  const draft = getDraft();
  host.innerHTML = "";
  const available = line?.availableAddons || [];
  if (!available.length) {
    host.innerHTML = `<p class="muted">No extras for this item.</p>`;
    updatePriceSummary();
    return;
  }
  const canEdit = state.canAdjustAddonPrices;
  for (const addon of available) {
    let sel = draft.addons.find((a) => a.addonId === addon.addonId);
    const priceUnset = addonCatalogUnset(addon);
    const configured = priceUnset
      ? null
      : Number(addon.effectivePriceCents ?? addon.priceCents);
    const row = document.createElement("div");
    const checked = Boolean(sel);
    const needsEntry = checked && Boolean(sel?.priceEnteredAtSale);
    row.className = `addon-pick-row${checked ? " is-selected" : ""}${
      needsEntry ? " needs-price" : ""
    }`;
    const applied = sel ? sel.unitPriceCents : configured;
    const kind = priceKindLabel(applied, priceUnset && !checked);
    const priceBit = applied == null ? "" : formatSignedPrice(applied);
    const showPriceEdit = checked && canEdit && sel?.editingPrice && !needsEntry;
    const showRequiredPrice = needsEntry;
    row.innerHTML = `
      <button type="button" class="addon-select-btn" aria-pressed="${checked}">
        <span class="addon-select-name">${escapeHtml(addon.name)}</span>
        <span class="addon-kind muted">${escapeHtml(kind)}${
          priceBit ? ` · ${escapeHtml(priceBit)}` : ""
        }</span>
      </button>
      ${
        checked && canEdit && !needsEntry
          ? `<button type="button" class="btn ghost small addon-edit-price-btn">${
              showPriceEdit ? "Done" : "Edit price"
            }</button>`
          : ""
      }
      ${
        showPriceEdit || showRequiredPrice
          ? `<label class="field addon-price-field">
              <span class="currency-prefix">${escapeHtml(state.money?.label || "")}</span>
              <input type="text" inputmode="decimal" class="addon-price-input${
                showRequiredPrice ? " is-required" : ""
              }"
                data-addon-price="${escapeHtml(addon.addonId)}"
                value="${escapeHtml(sel?.draftText || "")}"
                placeholder="${showRequiredPrice ? "Required" : ""}"
                aria-label="Price for ${escapeHtml(addon.name)}" />
            </label>`
          : ""
      }
    `;
    row.querySelector(".addon-select-btn").addEventListener("click", () => {
      if (checked) {
        draft.addons = draft.addons.filter((a) => a.addonId !== addon.addonId);
        renderAddonPicker();
        return;
      }
      draft.addons.push({
        addonId: addon.addonId,
        name: addon.name,
        quantity: 1,
        priceEnteredAtSale: priceUnset,
        configuredUnitPriceCents: configured,
        unitPriceCents: priceUnset ? null : configured,
        priceAdjusted: false,
        taxApplicable: addon.taxApplicable !== false,
        draftText:
          priceUnset
            ? ""
            : state.money
              ? state.money.formatPlain(configured)
              : String(configured),
        editingPrice: priceUnset,
      });
      renderAddonPicker();
      if (priceUnset) {
        $("addon-pick-list")
          ?.querySelector(`[data-addon-price="${CSS.escape(addon.addonId)}"]`)
          ?.focus();
      }
    });
    const editBtn = row.querySelector(".addon-edit-price-btn");
    if (editBtn) {
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const entry = draft.addons.find((a) => a.addonId === addon.addonId);
        if (!entry) return;
        entry.editingPrice = !entry.editingPrice;
        renderAddonPicker();
        if (entry.editingPrice) {
          row.querySelector(".addon-price-input")?.focus();
        }
      });
    }
    const priceInput = row.querySelector(".addon-price-input");
    if (priceInput) {
      priceInput.addEventListener("input", (e) => {
        const entry = draft.addons.find((a) => a.addonId === addon.addonId);
        if (!entry) return;
        entry.draftText = e.target.value;
        if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(e.target.value).trim().replace(/,/g, ""))) {
          try {
            const minor = state.money.parse(e.target.value);
            entry.unitPriceCents = minor;
            entry.priceAdjusted = entry.priceEnteredAtSale
              ? false
              : minor !== entry.configuredUnitPriceCents;
            $("addon-price-error").hidden = true;
          } catch (err) {
            $("addon-price-error").hidden = false;
            $("addon-price-error").textContent = err.message;
            if (entry.priceEnteredAtSale) entry.unitPriceCents = null;
          }
        } else if (entry.priceEnteredAtSale) {
          entry.unitPriceCents = null;
        }
        updatePriceSummary();
      });
      priceInput.addEventListener("blur", (e) => {
        const entry = draft.addons.find((a) => a.addonId === addon.addonId);
        if (!entry) return;
        const raw = String(e.target.value || "").trim();
        if (!raw || raw === "-" || raw.endsWith(".")) {
          $("addon-price-error").hidden = false;
          $("addon-price-error").textContent =
            "Enter a complete price (e.g. 0.300 or -0.100).";
          return;
        }
        try {
          const minor = state.money.parse(raw);
          entry.unitPriceCents = minor;
          entry.priceAdjusted = entry.priceEnteredAtSale
            ? false
            : minor !== entry.configuredUnitPriceCents;
          entry.draftText = state.money.formatPlain(minor);
          e.target.value = entry.draftText;
          $("addon-price-error").hidden = true;
          updatePriceSummary();
        } catch (err) {
          $("addon-price-error").hidden = false;
          $("addon-price-error").textContent = err.message;
        }
      });
    }
    host.appendChild(row);
  }
  updatePriceSummary();
}

function updatePriceSummary() {
  const detail = $("price-summary-detail");
  const breakdown = $("customize-price-breakdown");
  const draft = getDraft();
  if (!draft) {
    if (detail) detail.innerHTML = "";
    updateCustomizeLineTotalPreview();
    return;
  }
  const base = Number(draft.unitPriceCents || 0);
  let charges = 0;
  let reductions = 0;
  for (const a of draft.addons) {
    const p = Number(a.unitPriceCents || 0) * Number(a.quantity || 1);
    if (p > 0) charges += p;
    else if (p < 0) reductions += p;
  }
  const net = charges + reductions;
  const unit = base + net;
  const qty = Number(draft.quantity || 1);
  const lineTotal = unit * qty;
  state.priceBreakdownOpen = Boolean(breakdown?.open);
  if (detail) {
    detail.innerHTML = `
      <div><dt>Base selling price</dt><dd>${escapeHtml(formatPrice(base))}</dd></div>
      <div><dt>Add-on charges</dt><dd>${escapeHtml(formatSignedPrice(charges))}</dd></div>
      <div><dt>Reductions</dt><dd>${escapeHtml(formatSignedPrice(reductions))}</dd></div>
      <div><dt>Net adjustment</dt><dd>${escapeHtml(formatSignedPrice(net))}</dd></div>
      <div><dt>Unit total</dt><dd><strong>${escapeHtml(formatPrice(unit))}</strong></dd></div>
      <div><dt>Quantity</dt><dd>${qty}</dd></div>
    `;
  }
  updateCustomizeLineTotalPreview();
  if (unit < 0 || lineTotal < 0) {
    $("addon-price-error").hidden = false;
    $("addon-price-error").textContent =
      "Final unit/line total cannot be negative.";
  }
}

function renderSelectedInstructions() {
  const host = $("instr-chip-list");
  const section = $("selected-instr-section");
  if (!host) return;
  const draft = getDraft();
  host.innerHTML = "";
  if (!draft?.instructions?.length) {
    if (section) section.hidden = true;
    return;
  }
  if (section) section.hidden = false;
  draft.instructions.forEach((text, idx) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip this-item-chip";
    chip.setAttribute("role", "listitem");
    chip.innerHTML = `<span class="this-item-chip-text">${escapeHtml(text)}</span>
      <button type="button" class="this-item-chip-remove" aria-label="Remove ${escapeHtml(text)}">✕</button>`;
    chip.querySelector("button").addEventListener("click", () => {
      draft.instructions.splice(idx, 1);
      renderSelectedInstructions();
    });
    host.appendChild(chip);
  });
}

function renderInstrList() {
  renderSelectedInstructions();
}

function currentLineOptions() {
  const line = getEditingLine();
  return {
    modifiers: line?.instructionModifiers?.length
      ? line.instructionModifiers
      : DEFAULT_MODIFIERS,
    targets: line?.instructionTargets?.length
      ? line.instructionTargets
      : DEFAULT_TARGETS,
  };
}

function renderInstrChips() {
  const { modifiers, targets } = currentLineOptions();
  const line = getEditingLine();
  const modHost = $("mod-chips");
  const targetHost = $("target-chips");
  const standHost = $("standalone-chips");
  if (!modHost || !targetHost) return;
  modHost.innerHTML = "";
  targetHost.innerHTML = "";
  if (standHost) standHost.innerHTML = "";

  if (state.kitchenStep === 1) {
    for (const m of modifiers) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip kitchen-choice";
      btn.textContent = m;
      btn.addEventListener("click", () => {
        state.selectedMod = m;
        state.selectedTargets = [];
        setKitchenStep(2);
        showInstrFeedback(`Tap what to ${String(m).toLowerCase()}`);
      });
      modHost.appendChild(btn);
    }
    for (const s of line?.instructionStandalone || []) {
      if (!standHost) break;
      const btn = document.createElement("button");
      btn.type = "button";
      const already = Boolean(
        getDraft()?.instructions?.some(
          (i) => i.trim().toLowerCase() === String(s).trim().toLowerCase()
        )
      );
      btn.className = `chip kitchen-choice${already ? " is-selected" : ""}`;
      btn.innerHTML = already
        ? `<span class="kitchen-choice-check" aria-hidden="true">✓</span><span>${escapeHtml(s)}</span>`
        : escapeHtml(s);
      btn.setAttribute("aria-pressed", already ? "true" : "false");
      btn.addEventListener("click", () => addStandaloneInstruction(s));
      standHost.appendChild(btn);
    }
    return;
  }

  // Step 2: tap one ingredient → add "<Action> <Ingredient>" and return to step 1.
  for (const t of targets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip kitchen-choice";
    btn.textContent = t;
    btn.addEventListener("click", () => {
      state.selectedTargets = [t];
      addInstruction();
    });
    targetHost.appendChild(btn);
  }
  syncKitchenTargetsOk();
}

function addStandaloneInstruction(text) {
  const draft = getDraft();
  if (!draft) return;
  const exists = draft.instructions.some(
    (i) => i.trim().toLowerCase() === text.toLowerCase()
  );
  if (exists) {
    showInstrFeedback("Already added", { error: true });
    return;
  }
  draft.instructions.push(text);
  renderSelectedInstructions();
  showInstrFeedback(`Added ${text}`);
}

function syncOrderNoteFromInput() {
  const draft = getDraft();
  if (!draft) return;
  draft.orderNote = String($("custom-note")?.value || "").trim();
}

function addInstruction() {
  const draft = getDraft();
  if (!draft) return;
  if (!state.selectedMod || !state.selectedTargets.length) return;
  const text = `${state.selectedMod} ${joinInstructionTargets(state.selectedTargets)}`;
  const exists = draft.instructions.some(
    (i) => i.trim().toLowerCase() === text.toLowerCase()
  );
  if (exists) {
    showInstrFeedback("Already added", { error: true });
    return;
  }
  draft.instructions.push(text);
  showInstrFeedback(`Added ${text}`);
  state.selectedMod = null;
  state.selectedTargets = [];
  setKitchenStep(1);
  renderSelectedInstructions();
  // Refresh step-1 chips so standalone selected ✓ states update if needed.
  renderInstrChips();
}

function validateDraftPrices() {
  const draft = getDraft();
  if (!draft) return false;
  if (!commitCustomizeQty()) return false;
  if (!commitCustomizeUnitPrice()) return false;
  for (const a of draft.addons) {
    const raw = String(a.draftText ?? "").trim();
    if (a.priceEnteredAtSale && (!raw || raw === "-" || /\.$/.test(raw))) {
      $("addon-price-error").hidden = false;
      $("addon-price-error").textContent = `Enter a price for ${a.name}.`;
      setCustomizeTab("extras");
      $("addon-pick-list")
        ?.querySelector(`[data-addon-price="${CSS.escape(a.addonId)}"]`)
        ?.focus();
      return false;
    }
    if (!a.priceEnteredAtSale && (!raw || raw === "-" || /\.$/.test(raw))) {
      $("addon-price-error").hidden = false;
      $("addon-price-error").textContent = `Complete the price for ${a.name}.`;
      setCustomizeTab("extras");
      return false;
    }
    try {
      const minor = state.money.parse(raw);
      a.unitPriceCents = minor;
      a.priceAdjusted = a.priceEnteredAtSale
        ? false
        : minor !== Number(a.configuredUnitPriceCents);
      a.draftText = state.money.formatPlain(minor);
    } catch (err) {
      $("addon-price-error").hidden = false;
      $("addon-price-error").textContent = `${a.name}: ${err.message}`;
      setCustomizeTab("extras");
      return false;
    }
  }
  const base = Number(draft.unitPriceCents || 0);
  const addons = draft.addons.reduce(
    (s, a) => s + Number(a.unitPriceCents || 0) * Number(a.quantity || 1),
    0
  );
  if (base + addons < 0) {
    $("addon-price-error").hidden = false;
    $("addon-price-error").textContent =
      "Final unit/line total cannot be negative.";
    return false;
  }
  if (!state.canAdjustAddonPrices) {
    for (const a of draft.addons) {
      if (a.priceAdjusted && !a.priceEnteredAtSale) {
        $("addon-price-error").hidden = false;
        $("addon-price-error").textContent =
          "Administrator permission required to adjust add-on prices.";
        setCustomizeTab("extras");
        return false;
      }
    }
  }
  if (!state.canAdjustBasePrices && draft.basePriceAdjusted) {
    $("customize-price-error").hidden = false;
    $("customize-price-error").textContent =
      "Administrator permission required to override the item selling price.";
    return false;
  }
  $("addon-price-error").hidden = true;
  $("customize-price-error").hidden = true;
  return true;
}

function applyCustomization() {
  const draft = getDraft();
  const line = getEditingLine();
  if (!draft || !line) return;
  if ($("customize-apply-btn")?.disabled) return;
  if (!validateDraftPrices()) return;
  syncOrderNoteFromInput();
  line.quantity = draft.quantity;
  line.configuredPriceCents = Number(draft.configuredPriceCents || 0);
  line.priceCents = Number(draft.unitPriceCents || 0);
  line.basePriceAdjusted = Boolean(draft.basePriceAdjusted);
  line.instructions = [...draft.instructions];
  line.orderNote = String(draft.orderNote || "").trim();
  line.addons = draft.addons.map((a) => ({
    addonId: a.addonId,
    name: a.name,
    quantity: a.quantity || 1,
    priceEnteredAtSale: Boolean(a.priceEnteredAtSale),
    configuredUnitPriceCents: a.priceEnteredAtSale
      ? null
      : a.configuredUnitPriceCents,
    unitPriceCents: a.unitPriceCents,
    effectivePriceCents: a.unitPriceCents,
    priceAdjusted: Boolean(a.priceAdjusted) && !a.priceEnteredAtSale,
    taxApplicable: a.taxApplicable !== false,
  }));
  const wasNew = Boolean(line._pendingCustomize);
  line._pendingCustomize = false;
  state.customizeDraft = null;
  closeCustomizeDialog();
  focusCartLine(line.lineId, { follow: true });
  renderCart();
  if (wasNew) {
    const label = line.variantName
      ? `${line.name} — ${line.variantName}`
      : line.name;
    showToast(
      splitInUse()
        ? `Added ${label} to order ${lineSplitNo(line)}`
        : `Added ${label}`
    );
  }
  const applyBtn = $("customize-apply-btn");
  if (applyBtn) applyBtn.textContent = "Apply Customization";
}

function closeCustomizeDialog() {
  const dialog = $("instr-dialog");
  document.body.classList.remove("customize-open");
  if (dialog?.open) dialog.close();
  const trigger = state._customizeTrigger;
  state._customizeTrigger = null;
  if (trigger?.focus) {
    try {
      trigger.focus();
    } catch {
      /* ignore */
    }
  }
}

/** Structured kitchen instructions + optional free-text note (note last, for tickets). */
function lineInstructionsForOrder(line) {
  const instr = [...(line.instructions || [])];
  const note = String(line.orderNote || "").trim();
  if (note && !instr.some((i) => i.toLowerCase() === note.toLowerCase())) {
    instr.push(note);
  }
  return instr;
}

function cancelCustomization() {
  const draft = getDraft();
  const line = getEditingLine();
  if (draft?.isNew && line) {
    state.cart = state.cart.filter((l) => l.lineId !== line.lineId);
  }
  state.customizeDraft = null;
  state.editingLineId = null;
  closeCustomizeDialog();
  renderCart();
  const applyBtn = $("customize-apply-btn");
  if (applyBtn) applyBtn.textContent = "Apply Customization";
}

function setStatus(message, ok = true) {
  const el = $("send-status");
  if (el) {
    el.hidden = true;
    el.textContent = "";
    el.className = `status-line ${ok ? "ok" : "err"}`;
  }
  if (!message) return;
  showToast(message, { duration: 2000 });
}

function fieldHtml(id, label, value, { wide = false, placeholder = "", inputMode = "" } = {}) {
  return `<label class="field${wide ? " wide" : ""}">
    <span>${label}</span>
    <input id="${id}" type="text" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(placeholder)}" ${
      inputMode ? `inputmode="${inputMode}"` : ""
    } autocomplete="off" />
  </label>`;
}

function activeBlockRate(blockNumber) {
  const norm = String(blockNumber || "").trim().replace(/\s+/g, "").toUpperCase();
  return (state.blockRates || []).find(
    (row) => String(row.blockNumber || "").trim().replace(/\s+/g, "").toUpperCase() === norm
  );
}

// Mobile order-type buttons mirror the existing select. Keep all fulfillment,
// pricing and draft behavior on the original select `change` path.
function syncOrderTypeQuickButtons() {
  const selectedId = $("order-type")?.value || "";
  const host = $("order-type-quick");
  if (!host) return;
  host.querySelectorAll("button[data-order-type-id]").forEach((button) => {
    const selected = button.dataset.orderTypeId === selectedId;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function renderOrderTypeQuickButtons() {
  const host = $("order-type-quick");
  const select = $("order-type");
  if (!host || !select) return;
  const fragment = document.createDocumentFragment();
  for (const type of state.orderTypes || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "order-type-option";
    button.dataset.orderTypeId = type.orderTypeId;
    button.textContent = type.name || type.code || "Order type";
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      if (select.value === type.orderTypeId) return;
      select.value = type.orderTypeId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    fragment.appendChild(button);
  }
  host.replaceChildren(fragment);
  syncOrderTypeQuickButtons();
}

function fillOrderTypeSelect() {
  const select = $("order-type");
  if (!select) return;
  const previous = select.value;
  const types = state.orderTypes || [];
  select.innerHTML = types
    .map(
      (row) =>
        `<option value="${escapeHtml(row.orderTypeId)}">${escapeHtml(row.name)}</option>`
    )
    .join("");
  const still = types.some((row) => row.orderTypeId === previous);
  if (still) select.value = previous;
  else {
    const takeaway = types.find((row) => row.code === "TAKEAWAY");
    select.value = (takeaway || types[0])?.orderTypeId || "";
  }
  renderOrderTypeQuickButtons();
}

function syncDeliveryFromInput(raw, { format = false } = {}) {
  const money = state.money;
  if (!money) return;
  const text = String(raw ?? "").trim();
  if (!text) {
    state.fulfillment.deliveryChargeCents = null;
    updateFeeNote();
    renderCart();
    return;
  }
  try {
    const cents = money.parse(text);
    if (cents < 0) throw new Error("Delivery charge cannot be negative.");
    state.fulfillment.deliveryChargeCents = cents;
    const suggested = state.fulfillment.expectedBlockRateCents;
    state.fulfillment.deliveryFeeOverride =
      suggested == null || cents !== suggested;
    if (format) {
      const input = $("dl-charge");
      if (input) input.value = money.formatPlain(cents);
    }
  } catch {
    state.fulfillment.deliveryChargeCents = null;
  }
  updateFeeNote();
  renderCart();
}

function withDeliveryTaxHint(text) {
  const hint = deliveryTaxHint();
  return hint ? `${text} · ${hint}` : text;
}

function updateFeeNote() {
  const note = $("fee-note");
  if (!note) return;
  const money = state.money;
  const block = state.fulfillment.blockNumber;
  const suggested = state.fulfillment.expectedBlockRateCents;
  const chargeInput = $("dl-charge");
  let text = "";
  let isCustom = false;
  if (!block) {
    text = "Enter a block number.";
  } else if (suggested == null) {
    const entered = state.fulfillment.deliveryChargeCents != null;
    text = withDeliveryTaxHint(
      entered ? "Custom delivery charge" : "No saved rate for this block"
    );
    isCustom = entered;
  } else if (state.fulfillment.deliveryChargeCents == null) {
    text = "Enter a delivery charge using the shop currency.";
  } else if (state.fulfillment.deliveryFeeOverride) {
    text = withDeliveryTaxHint("Custom delivery charge");
    isCustom = true;
  } else {
    text = withDeliveryTaxHint(
      `Suggested block rate: ${money ? money.format(suggested) : suggested}`
    );
  }
  note.textContent = text;
  note.classList.toggle("is-custom", isCustom);
  note.title = text;
  if (chargeInput) chargeInput.title = text;
}

function applyBlockRate(blockNumber, { keepManual = false } = {}) {
  const norm = String(blockNumber || "").trim().replace(/\s+/g, "").toUpperCase();
  state.fulfillment.blockNumber = norm;
  const rate = activeBlockRate(norm);
  if (!rate) {
    state.fulfillment.expectedBlockRateCents = null;
    if (!keepManual) {
      state.fulfillment.deliveryChargeCents = null;
      state.fulfillment.deliveryFeeOverride = false;
    }
    return;
  }
  state.fulfillment.expectedBlockRateCents = rate.chargeCents;
  if (!keepManual) {
    state.fulfillment.deliveryChargeCents = rate.chargeCents;
    state.fulfillment.deliveryFeeOverride = false;
  }
}

function commitBlockInput(raw) {
  const norm = String(raw || "").trim().replace(/\s+/g, "").toUpperCase();
  const prev = state.fulfillment.blockNumber || "";
  if (norm === prev) {
    const input = $("dl-block");
    if (input) input.value = prev;
    return;
  }
  if (norm && !/^[A-Z0-9-]{1,20}$/.test(norm)) {
    const note = $("fee-note");
    if (note) {
      note.textContent = "Enter a block number using letters, numbers, or hyphens (max 20).";
      note.classList.remove("is-custom");
    }
    return;
  }
  const nextRate = norm ? activeBlockRate(norm) : null;
  const hadManual =
    state.fulfillment.deliveryFeeOverride && state.fulfillment.deliveryChargeCents != null;
  if (hadManual) {
    const message = nextRate
      ? "Selecting a different block will reset the delivery charge to that block's rate."
      : "This block has no saved rate. The current delivery charge will be cleared until you enter one for this order.";
    if (!window.confirm(message)) {
      const input = $("dl-block");
      if (input) input.value = prev;
      return;
    }
  }
  if (!norm) {
    state.fulfillment.blockNumber = "";
    state.fulfillment.expectedBlockRateCents = null;
    state.fulfillment.deliveryChargeCents = null;
    state.fulfillment.deliveryFeeOverride = false;
  } else {
    applyBlockRate(norm);
  }
  renderFulfillmentFields();
  renderCart();
  persistActiveCart();
}

function applySuggestedRate(cents) {
  if (!Number.isSafeInteger(cents)) return;
  state.fulfillment.expectedBlockRateCents = cents;
  state.fulfillment.deliveryChargeCents = cents;
  state.fulfillment.deliveryFeeOverride = false;
  const input = $("dl-charge");
  if (input && state.money) input.value = state.money.formatPlain(cents);
  updateFeeNote();
  renderCart();
}

function readFulfillmentInputs() {
  const read = (id) => {
    const el = $(id);
    return el ? el.value.trim() : null;
  };
  const type = selectedOrderType();
  if (!type) return;
  if (type.behavior === "COUNTER") {
    const value = read("ff-counter");
    if (value != null) state.fulfillment.counterLabel = value;
  }
  if (type.behavior === "TABLE") {
    const table = read("ff-table");
    if (table != null) state.fulfillment.tableNumber = table;
  }
  if (type.behavior === "CAR_HOP") {
    const vehicle = read("ff-vehicle");
    const parking = read("ff-parking");
    if (vehicle != null) state.fulfillment.vehicleNumber = vehicle;
    if (parking != null) state.fulfillment.parkingLocation = parking;
  }
}

/** Canonical phone string from customer API objects or fulfillment state. */
function customerContactPhone(source) {
  if (!source || typeof source !== "object") return "";
  return String(
    source.customerPhone ??
      source.phone ??
      source.contactPhone ??
      source.contact_number ??
      source.contact ??
      source.mobile ??
      ""
  ).trim();
}

function selectedCustomerId(f = state.fulfillment) {
  return String(f?.customerId || f?.customer_id || "").trim();
}

/** Single source of truth: Delivery needs a customer id + non-empty contact number. */
function hasValidDeliveryCustomer(f = state.fulfillment) {
  return Boolean(selectedCustomerId(f) && customerContactPhone(f));
}

function normalizeFulfillmentCustomerFields(f = state.fulfillment) {
  if (!f || typeof f !== "object") return f;
  const id = selectedCustomerId(f);
  const phone = customerContactPhone(f);
  f.customerId = id;
  f.customerPhone = phone;
  if (f.customerName == null) f.customerName = "";
  return f;
}

function customerPickerHtml(required) {
  const stateClass = required ? "customer-picker--missing" : "customer-picker--optional";
  const triggerLabel = required ? "Customer required" : "+ Add customer (optional)";
  return `<div class="customer-picker wide customer-picker-collapsed ${stateClass}" data-required="${required ? "1" : "0"}">
    <button type="button" id="cust-expand" class="btn ghost customer-add-trigger${required ? " customer-required-missing" : ""}" aria-invalid="${required ? "true" : "false"}">
      ${required ? `<span class="cust-status-icon" aria-hidden="true">!</span>` : ""}
      ${escapeHtml(triggerLabel)}
    </button>
    <div class="customer-picker-body" hidden>
      <div class="customer-search-row">
        <input id="cust-search" type="search" placeholder="Name or phone" autocomplete="off" enterkeyhint="search" inputmode="search" aria-label="Name or phone" />
        <button type="button" id="cust-add" class="btn ghost customer-new-btn">+ New</button>
      </div>
      <div id="cust-results" class="cust-results" hidden></div>
    </div>
  </div>`;
}

function deliveryBlockChargeStatus(f = state.fulfillment) {
  const block = String(f.blockNumber || "").trim();
  const cents = f.deliveryChargeCents;
  const chargeValid = Number.isSafeInteger(cents) && cents >= 0;
  if (!block) return { ok: false, label: "Block missing" };
  if (!chargeValid) return { ok: false, label: "Delivery charge missing" };
  if (!activeBlockRate(block) && !f.deliveryFeeOverride) {
    return { ok: false, label: "Delivery charge missing" };
  }
  return { ok: true, label: "" };
}

function isDigitsHeavyQuery(q) {
  const t = String(q || "").trim();
  if (!t || /[A-Za-z]/.test(t)) return false;
  return /\d/.test(t);
}

function syncCustSearchInputMode(input) {
  if (!input) return;
  input.setAttribute("inputmode", isDigitsHeavyQuery(input.value) ? "tel" : "search");
}

function customerHitPlace(row) {
  const addr = preferredAddress(row);
  if (!addr) return "";
  const bits = [];
  if (addr.blockNumber) bits.push(`Block ${addr.blockNumber}`);
  const label = String(addr.label || "").trim();
  const building = String(addr.buildingNumber || "").trim();
  if (label) bits.push(label);
  else if (building) bits.push(`Building ${building}`);
  else if (addr.roadNumber) bits.push(`Road ${addr.roadNumber}`);
  return bits.join(" · ");
}

function deliveryCustomerCardHtml(f) {
  const name = String(f.customerName || "").trim() || "Customer";
  const phone = customerContactPhone(f);
  const blockStatus = deliveryBlockChargeStatus(f);
  if (!blockStatus.ok) state._deliveryDetailsExpanded = true;
  const expanded = Boolean(state._deliveryDetailsExpanded);
  const toneClass = blockStatus.ok ? "cust-summary--ok" : "cust-summary--warn";
  const chargeCents = f.deliveryChargeCents;
  const chargeValid = Number.isSafeInteger(chargeCents) && chargeCents >= 0;
  const chargePlain =
    chargeValid && state.money ? state.money.formatPlain(chargeCents) : "";
  const chargeLabel =
    chargeValid && state.money
      ? state.money.format(chargeCents)
      : chargeValid
        ? String(chargeCents)
        : "—";
  const blockLabel = String(f.blockNumber || "").trim();
  const editedMark = f.deliveryFeeOverride
    ? ' <span class="delivery-fee-edited">(edited)</span>'
    : "";
  const pinSvg =
    '<svg class="cust-pin" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10 2a6 6 0 0 0-6 6c0 4.5 6 10 6 10s6-5.5 6-10a6 6 0 0 0-6-6zm0 8.2a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4z"/></svg>';
  const deliveryLine = blockStatus.ok
    ? `${pinSvg}<span>Block ${escapeHtml(blockLabel)} · Delivery ${escapeHtml(chargeLabel)}</span>${editedMark}`
    : `<span class="cust-status-icon" aria-hidden="true">!</span><span>${escapeHtml(blockStatus.label)}</span>`;
  const suggestions = (state.blockRates || [])
    .map((row) => `<option value="${escapeHtml(row.blockNumber)}"></option>`)
    .join("");
  return `<div class="cust-summary wide cust-delivery-card ${toneClass}" data-cust-tone="${blockStatus.ok ? "ok" : "warn"}">
    <div class="cust-delivery-row">
      <p class="cust-delivery-main"><span class="cust-status-icon" aria-hidden="true">✓</span> ${escapeHtml([name, phone].filter(Boolean).join(" · "))}</p>
      <button type="button" id="cust-change" class="btn ghost delivery-details-toggle" aria-label="Change customer">Change customer</button>
    </div>
    <div class="cust-delivery-row">
      <p class="cust-delivery-main cust-delivery-block">${deliveryLine}</p>
      <button type="button" id="dl-details-toggle" class="btn ghost delivery-details-toggle" aria-expanded="${expanded ? "true" : "false"}" aria-label="${expanded ? "Done editing delivery" : "Edit delivery"}">${expanded ? "Done" : "Edit delivery"}</button>
    </div>
    <div class="delivery-details-fields" ${expanded ? "" : "hidden"}>
      <div class="fee-row fee-row-compact">
        <label class="field">
          <span>Block number</span>
          <input id="dl-block" class="delivery-compact-input" type="text" value="${escapeHtml(f.blockNumber || "")}" list="dl-block-list" autocomplete="off" />
          <datalist id="dl-block-list">${suggestions}</datalist>
        </label>
        <label class="field">
          <span>Delivery charge</span>
          <input id="dl-charge" class="delivery-compact-input" type="text" inputmode="decimal" value="${escapeHtml(chargePlain)}" autocomplete="off" title="" />
        </label>
      </div>
      <p id="fee-note" class="fee-note fee-note-compact"></p>
    </div>
  </div>`;
}

/** Display-only address line; skips label when it duplicates building number. */
function formatCustomerAddressLine(f) {
  const label = String(f?.addressLabel || "").trim();
  const building = String(f?.buildingNumber || "").trim();
  const road = String(f?.roadNumber || "").trim();
  const block = String(f?.blockNumber || "").trim();
  const buildingPart = building ? `Building ${building}` : "";
  const labelLower = label.toLowerCase();
  const labelDuplicatesBuilding =
    Boolean(building) &&
    (labelLower === building.toLowerCase() || labelLower === buildingPart.toLowerCase());
  const parts = [];
  if (label && !labelDuplicatesBuilding) parts.push(label);
  if (buildingPart) parts.push(buildingPart);
  if (road) parts.push(`Road ${road}`);
  if (block) parts.push(`Block ${block}`);
  return parts.join(" · ");
}

function customerCardStatus(f = state.fulfillment, { delivery = false } = {}) {
  const hasId = Boolean(selectedCustomerId(f));
  const phone = customerContactPhone(f);
  if (!delivery) {
    return { tone: "neutral", label: hasId ? "Customer" : "Optional", icon: "" };
  }
  if (!hasId) {
    return { tone: "missing", label: "Customer required", icon: "!" };
  }
  if (!phone) {
    return { tone: "warn", label: "Add contact number", icon: "!" };
  }
  if (hasValidDeliveryCustomer(f)) {
    return { tone: "ok", label: "Customer ready", icon: "✓" };
  }
  return { tone: "warn", label: "Add contact number", icon: "!" };
}

function customerSummaryHtml(f, { addresses = false, delivery = false } = {}) {
  if (!selectedCustomerId(f)) return "";
  const name = String(f.customerName || "").trim() || "Customer";
  const phone = customerContactPhone(f);
  const status = customerCardStatus(f, { delivery });
  const toneClass =
    status.tone === "ok"
      ? "cust-summary--ok"
      : status.tone === "warn"
        ? "cust-summary--warn"
        : status.tone === "missing"
          ? "cust-summary--missing"
          : "";
  const canCompact =
    (delivery ? hasValidDeliveryCustomer(f) : Boolean(selectedCustomerId(f) && phone)) &&
    !state._customerCardExpanded;
  if (canCompact) {
    const bits = [name, phone].filter(Boolean);
    return `<div class="cust-summary wide cust-summary--compact ${toneClass}" data-cust-tone="${escapeHtml(status.tone)}">
      <button type="button" id="cust-compact-toggle" class="cust-compact-row" aria-expanded="false">
        <span class="cust-compact-text"><span class="cust-status-icon" aria-hidden="true">✓</span> ${escapeHtml(bits.join(" · "))}</span>
        <span class="cust-compact-change">Change</span>
      </button>
    </div>`;
  }
  const phoneHtml = phone
    ? `<a class="cust-summary-phone" href="tel:${escapeHtml(phone.replace(/\s+/g, ""))}">${escapeHtml(phone)}</a>`
    : "";
  const place = formatCustomerAddressLine(f);
  const pinSvg =
    '<svg class="cust-pin" viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M10 2a6 6 0 0 0-6 6c0 4.5 6 10 6 10s6-5.5 6-10a6 6 0 0 0-6-6zm0 8.2a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4z"/></svg>';
  const addressHtml = addresses
    ? `<p class="cust-summary-address">${pinSvg}<span class="cust-summary-address-text">${escapeHtml(place || "No saved address")}</span></p>
    ${f.addressNote ? `<p class="muted cust-summary-note">${escapeHtml(f.addressNote)}</p>` : ""}`
    : "";
  const moreItems = [
    `<button type="button" id="cust-edit" role="menuitem">Edit customer</button>`,
    addresses ? `<button type="button" id="cust-add-address" role="menuitem">+ Add address</button>` : "",
  ]
    .filter(Boolean)
    .join("");
  const phoneAction =
    delivery && !phone
      ? `<button type="button" id="cust-add-phone" class="btn ghost small">Add contact number</button>`
      : "";
  const addressAction = addresses
    ? `<button type="button" id="cust-pick-address" class="btn ghost small">Change address</button>`
    : "";
  const collapseAction =
    delivery && hasValidDeliveryCustomer(f)
      ? `<button type="button" id="cust-compact-toggle" class="btn ghost small" aria-expanded="true">Done</button>`
      : "";
  const readyMark =
    status.tone === "ok"
      ? `<span class="cust-status-icon cust-summary-ready-mark" aria-hidden="true">✓</span>`
      : status.tone === "warn"
        ? `<span class="cust-summary-status cust-summary-status-inline"><span class="cust-status-icon" aria-hidden="true">!</span>${escapeHtml(status.label)}</span>`
        : "";
  return `<div class="cust-summary wide ${toneClass}" data-cust-tone="${escapeHtml(status.tone)}">
    <div class="cust-summary-top">
      <div class="cust-summary-identity">
        ${readyMark}
        <strong class="cust-summary-name">${escapeHtml(name)}</strong>
        ${phoneHtml}
      </div>
      ${collapseAction}
    </div>
    ${addressHtml}
    <div class="cust-summary-actions">
      <button type="button" id="cust-change" class="btn ghost small">Change customer</button>
      ${addressAction}
      ${phoneAction}
      <div class="cust-more">
        <button type="button" id="cust-more-btn" class="btn ghost small" aria-haspopup="menu" aria-expanded="false" aria-controls="cust-more-menu">More</button>
        <div id="cust-more-menu" class="cust-more-menu" role="menu" hidden>${moreItems}</div>
      </div>
    </div>
  </div>`;
}

function activeAddresses(customer) {
  return (customer?.addresses || []).filter((row) => row && row.isActive !== false);
}

function preferredAddress(customer) {
  const rows = activeAddresses(customer);
  return rows.find((row) => row.isDefault) || rows[0] || null;
}

function applySavedAddress(address) {
  state.fulfillment.addressId = address?.addressId || "";
  state.fulfillment.addressLabel = address?.label || "";
  state.fulfillment.buildingNumber = address?.buildingNumber || "";
  state.fulfillment.roadNumber = address?.roadNumber || "";
  state.fulfillment.addressNote = address?.addressNote || "";
  applyBlockRate(address?.blockNumber || "");
}

function selectCustomer(customer, { stayInPicker = false } = {}) {
  const customerId = selectedCustomerId(customer);
  if (!customerId) return;
  const phone = customerContactPhone(customer);
  if (!phone) {
    promptCustomerPhoneInPicker({ ...customer, customerId });
    return;
  }
  hidePickerPhonePrompt();
  state.addressBook = activeAddresses(customer);
  state.fulfillment.customerId = customerId;
  state.fulfillment.customerName = customer.name || "";
  state.fulfillment.customerPhone = phone;
  normalizeFulfillmentCustomerFields();
  applySavedAddress(preferredAddress(customer));
  state._customerCardExpanded = false;
  const pickerSearch = $("picker-cust-search");
  if (pickerSearch) pickerSearch.value = "";
  const pickerResults = $("picker-cust-results");
  if (pickerResults) {
    pickerResults.hidden = true;
    pickerResults.innerHTML = "";
  }
  if ($("send-status") && /customer with a contact/i.test($("send-status").textContent || "")) {
    setStatus("");
  }
  renderFulfillmentFields();
  renderCart();
  persistActiveCart();
  if (stayInPicker) {
    openAddressPicker();
    return;
  }
  if (selectedOrderType()?.behavior === "DELIVERY" && state.addressBook.length > 1) {
    openAddressPicker("address");
    return;
  }
  void maybeResumeReviewAfterCustomerGate();
}

function clearSelectedCustomer() {
  state.addressBook = [];
  state.fulfillment.customerId = "";
  state.fulfillment.addressId = "";
  state.fulfillment.addressLabel = "";
  state.fulfillment.customerName = "";
  state.fulfillment.customerPhone = "";
  state.fulfillment.buildingNumber = "";
  state.fulfillment.roadNumber = "";
  state.fulfillment.addressNote = "";
  state.fulfillment.blockNumber = "";
  state.fulfillment.deliveryChargeCents = null;
  state.fulfillment.deliveryFeeOverride = false;
  state.fulfillment.expectedBlockRateCents = null;
  state._customerCardExpanded = false;
  renderFulfillmentFields();
  renderCart();
  persistActiveCart();
  $("cust-search")?.focus();
}

function scheduleCustomerSearch() {
  clearTimeout(state._custTimer);
  const q = $("cust-search")?.value.trim() || "";
  state._custTimer = setTimeout(() => runCustomerSearch(q), 200);
}

function schedulePickerSearch() {
  clearTimeout(state._pickerTimer);
  const q = $("picker-cust-search")?.value.trim() || "";
  state._pickerTimer = setTimeout(
    () =>
      runCustomerSearch(q, {
        hostId: "picker-cust-results",
        inputId: "picker-cust-search",
        stayInPicker: true,
      }),
    200
  );
}

async function runCustomerSearch(q, { hostId = "cust-results", inputId = "cust-search", stayInPicker = false } = {}) {
  const host = $(hostId);
  if (!host) return;
  if (!q) {
    host.hidden = true;
    host.innerHTML = "";
    return;
  }
  const res = await api(`/v1/customers?q=${encodeURIComponent(q)}`);
  if (($(inputId)?.value.trim() || "") !== q) return;
  const rows = res.ok ? res.json.customers || [] : [];
  if (!rows.length) {
    host.hidden = false;
    host.innerHTML = `<p class="muted cust-empty">No customer found - <button type="button" class="linkish" data-cust-empty-new="1">+ New customer</button></p>`;
    host.querySelector("[data-cust-empty-new]")?.addEventListener("click", () => {
      openCustomerDialog("create", { prefill: q });
    });
    return;
  }
  host.hidden = false;
  host.innerHTML = rows
    .map((row) => {
      const place = customerHitPlace(row);
      return `<button type="button" class="cust-hit" data-id="${escapeHtml(row.customerId)}">
        <span class="cust-hit-main">
          <strong>${escapeHtml(row.name || "")}</strong>
          <span class="cust-hit-phone">${escapeHtml(row.phone || "")}</span>
          ${place ? `<span class="cust-hit-place">${escapeHtml(place)}</span>` : ""}
        </span>
      </button>`;
    })
    .join("");
  host.querySelectorAll(".cust-hit").forEach((button) => {
    button.addEventListener("click", () => {
      const match = rows.find((row) => row.customerId === button.dataset.id);
      if (match) selectCustomer(match, { stayInPicker });
    });
  });
}

function closeCustomerDialog() {
  const dialog = $("customer-dialog");
  if (dialog?.open) dialog.close();
  const err = $("cust-error");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  const dup = $("cust-dup");
  if (dup) dup.hidden = true;
}

function openCustomerDialog(mode = "create", { prefill = "" } = {}) {
  state._customerMode = mode;
  state._dupCustomer = null;
  const editing = mode === "edit";
  const title = $("customer-dialog-title");
  if (title) title.textContent = editing ? "Edit customer" : "Add customer";
  const profile = $("cust-profile-fields");
  const address = $("cust-address-fields");
  if (profile) profile.hidden = false;
  if (address) address.hidden = editing;
  const another = $("cust-save-another");
  if (another) another.hidden = editing;
  const save = $("cust-save");
  if (save) save.textContent = editing ? "Save customer" : "Save customer";
  if (editing) {
    $("cust-name").value = state.fulfillment.customerName || "";
    $("cust-phone").value = state.fulfillment.customerPhone || "";
  } else {
    for (const id of ["cust-name", "cust-phone", "cust-label", "cust-building", "cust-road", "cust-block", "cust-note"]) {
      const el = $(id);
      if (el) el.value = "";
    }
    const typed = String(prefill || $("cust-search")?.value || "").trim();
    if (typed) {
      if (isDigitsHeavyQuery(typed)) $("cust-phone").value = typed;
      else $("cust-name").value = typed;
    }
  }
  closeCustomerDialog();
  $("customer-dialog")?.showModal();
  (isDigitsHeavyQuery(prefill || $("cust-search")?.value || "") ? $("cust-phone") : $("cust-name"))?.focus();
}

function showCustomerError(message) {
  const err = $("cust-error");
  if (!err) return;
  err.hidden = !message;
  err.textContent = message || "";
}

function customerFormBody() {
  return {
    name: $("cust-name")?.value || "",
    phone: $("cust-phone")?.value || "",
    label: $("cust-label")?.value || "",
    buildingNumber: $("cust-building")?.value || "",
    roadNumber: $("cust-road")?.value || "",
    blockNumber: $("cust-block")?.value || "",
    addressNote: $("cust-note")?.value || "",
  };
}

function deliveryNeedsBlock() {
  return selectedOrderType()?.behavior === "DELIVERY";
}

async function saveNewCustomer({ another = false } = {}) {
  const saveBtn = $("cust-save");
  const extraBtn = $("cust-save-another");
  if (saveBtn?.disabled) return;
  showCustomerError("");
  const dup = $("cust-dup");
  if (dup) dup.hidden = true;
  if (state._customerMode === "edit") {
    if (saveBtn) saveBtn.disabled = true;
    try {
      const res = await api(`/v1/customers/${encodeURIComponent(state.fulfillment.customerId)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: $("cust-name")?.value || "",
          phone: $("cust-phone")?.value || "",
        }),
      });
      if (res.status === 409 && res.json?.code === "CUSTOMER_PHONE_EXISTS") {
        showCustomerError("Customer already exists. Select existing customer.");
        return;
      }
      if (!res.ok) {
        showCustomerError(res.json?.error || "Could not save the customer.");
        return;
      }
      const saved = res.json.customer;
      state.fulfillment.customerName = saved.name;
      state.fulfillment.customerPhone = saved.phone;
      state.addressBook = activeAddresses(saved);
      closeCustomerDialog();
      renderFulfillmentFields();
      persistActiveCart();
      showToast("Customer saved");
      void maybeResumeReviewAfterCustomerGate();
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
    return;
  }
  const body = customerFormBody();
  if (deliveryNeedsBlock() && !String(body.blockNumber).trim()) {
    showCustomerError("Enter a block number.");
    return;
  }
  if (saveBtn) saveBtn.disabled = true;
  if (extraBtn) extraBtn.disabled = true;
  try {
    const res = await api("/v1/customers", { method: "POST", body: JSON.stringify(body) });
    if (res.status === 409 && res.json?.code === "CUSTOMER_PHONE_EXISTS" && res.json.customer) {
      state._dupCustomer = res.json.customer;
      const text = $("cust-dup-text");
      if (text) text.textContent = "Customer already exists. Select existing customer.";
      if (dup) dup.hidden = false;
      return;
    }
    if (!res.ok) {
      showCustomerError(res.json?.error || "Could not save the customer.");
      return;
    }
    selectCustomer(res.json.customer);
    showToast("Customer saved");
    if (!another) {
      closeCustomerDialog();
      void maybeResumeReviewAfterCustomerGate();
      return;
    }
    state._customerMode = "extra";
    for (const id of ["cust-label", "cust-building", "cust-road", "cust-block", "cust-note"]) {
      const el = $(id);
      if (el) el.value = "";
    }
    if ($("customer-dialog-title")) $("customer-dialog-title").textContent = "Add another address";
    if (saveBtn) saveBtn.textContent = "Save address";
    if (extraBtn) extraBtn.hidden = true;
    $("cust-block")?.focus();
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (extraBtn) extraBtn.disabled = false;
  }
}

async function saveExtraAddressFromCustomerDialog() {
  const customerId = state.fulfillment.customerId;
  if (!customerId) return saveNewCustomer({ another: false });
  const body = {
    label: $("cust-label")?.value || "",
    buildingNumber: $("cust-building")?.value || "",
    roadNumber: $("cust-road")?.value || "",
    blockNumber: $("cust-block")?.value || "",
    addressNote: $("cust-note")?.value || "",
  };
  if (!String(body.blockNumber).trim()) {
    showCustomerError("Enter a block number.");
    return;
  }
  const res = await api(`/v1/customers/${encodeURIComponent(customerId)}/addresses`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    showCustomerError(res.json?.error || "Could not save the address.");
    return;
  }
  const created = res.json.customer;
  const previous = new Set((state.addressBook || []).map((row) => row.addressId));
  const rows = activeAddresses(created);
  const newest = rows.find((row) => !previous.has(row.addressId)) || rows[rows.length - 1];
  state.addressBook = rows;
  if (newest) applySavedAddress(newest);
  closeCustomerDialog();
  renderFulfillmentFields();
  renderCart();
  persistActiveCart();
  showToast("Address saved");
}

function closeAddressDialog() {
  const dialog = $("address-dialog");
  if (dialog?.open) dialog.close();
  const err = $("addr-error");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
}

function openAddressEditor(address) {
  if (!state.fulfillment.customerId) return;
  state._editingAddressId = address?.addressId || "";
  const title = $("address-dialog-title");
  if (title) title.textContent = address ? "Edit address" : "Add address";
  $("addr-label").value = address?.label || "";
  $("addr-building").value = address?.buildingNumber || "";
  $("addr-road").value = address?.roadNumber || "";
  $("addr-block").value = address?.blockNumber || "";
  $("addr-note").value = address?.addressNote || "";
  $("addr-default").checked = Boolean(address?.isDefault);
  const err = $("addr-error");
  if (err) err.hidden = true;
  $("address-dialog")?.showModal();
}

async function openAddressPicker(mode) {
  const host = $("address-picker-list");
  if (!host) return;
  if (mode === "customer" || mode === "address") state._pickerMode = mode;
  if (state.fulfillment.customerId && !(state.addressBook || []).length) {
    const res = await api(`/v1/customers/${encodeURIComponent(state.fulfillment.customerId)}`);
    if (res.ok && res.json.customer?.customerId === state.fulfillment.customerId) {
      state.addressBook = activeAddresses(res.json.customer);
    }
  }
  const focusCustomer = state._pickerMode === "customer";
  const dialog = $("address-picker-dialog");
  dialog?.classList.toggle("picker-mode-customer", focusCustomer);
  dialog?.classList.toggle("picker-mode-address", !focusCustomer);
  dialog?.classList.toggle(
    "picker-gate-delivery",
    Boolean(state._resumeReviewAfterCustomer && focusCustomer)
  );
  if (!focusCustomer && mode === "address") dialog?.classList.remove("show-customer-search");
  const title = $("address-picker-title");
  if (title) {
    title.textContent =
      state._resumeReviewAfterCustomer && focusCustomer
        ? "Delivery needs a customer"
        : focusCustomer
          ? "Select customer"
          : "Change address";
  }
  const current = $("picker-current");
  if (current) {
    const who = [state.fulfillment.customerName, customerContactPhone(state.fulfillment)]
      .filter(Boolean)
      .join(" · ");
    current.textContent = who || (focusCustomer ? "Search or add a customer" : "Selected customer");
  }
  const adjust = $("address-picker-adjust");
  if (adjust) adjust.hidden = selectedOrderType()?.behavior !== "DELIVERY";
  const rows = state.addressBook || [];
  host.innerHTML = rows.length
    ? rows
        .map(
          (row) => `<div class="address-pick">
            <button type="button" class="address-pick-main${row.addressId === state.fulfillment.addressId ? " is-selected" : ""}" data-id="${escapeHtml(row.addressId)}">
              <strong>${escapeHtml(row.label || "Address")}${row.isDefault ? " · Default" : ""}</strong>
              <span>${escapeHtml(
                [
                  row.buildingNumber ? `Building ${row.buildingNumber}` : "",
                  row.roadNumber ? `Road ${row.roadNumber}` : "",
                  row.blockNumber ? `Block ${row.blockNumber}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")
              )}</span>
            </button>
            <button type="button" class="btn ghost small" data-edit="${escapeHtml(row.addressId)}">Edit</button>
          </div>`
        )
        .join("")
    : `<p class="muted">No saved address yet.</p>`;
  host.querySelectorAll(".address-pick-main").forEach((button) => {
    button.addEventListener("click", () => {
      const match = rows.find((row) => row.addressId === button.dataset.id);
      if (!match) return;
      applySavedAddress(match);
      renderFulfillmentFields();
      renderCart();
      persistActiveCart();
      if (state._resumeReviewAfterCustomer) {
        void maybeResumeReviewAfterCustomerGate();
        return;
      }
      $("address-picker-dialog")?.close();
    });
  });
  host.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const match = rows.find((row) => row.addressId === button.dataset.edit);
      state._openingNestedCustomerDialog = true;
      $("address-picker-dialog")?.close();
      if (match) openAddressEditor(match);
    });
  });
  if (dialog && !dialog.open) dialog.showModal();
  if (focusCustomer) $("picker-cust-search")?.focus();
}

function openOrderAddressDialog() {
  $("order-addr-building").value = state.fulfillment.buildingNumber || "";
  $("order-addr-road").value = state.fulfillment.roadNumber || "";
  $("order-addr-note").value = state.fulfillment.addressNote || "";
  $("order-address-dialog")?.showModal();
}

async function saveAddressEditor() {
  const err = $("addr-error");
  const customerId = state.fulfillment.customerId;
  const body = {
    label: $("addr-label")?.value || "",
    buildingNumber: $("addr-building")?.value || "",
    roadNumber: $("addr-road")?.value || "",
    blockNumber: $("addr-block")?.value || "",
    addressNote: $("addr-note")?.value || "",
    isDefault: Boolean($("addr-default")?.checked),
  };
  if (!String(body.blockNumber).trim()) {
    if (err) {
      err.hidden = false;
      err.textContent = "Enter a block number.";
    }
    return;
  }
  const editing = state._editingAddressId;
  const path = editing
    ? `/v1/customers/${encodeURIComponent(customerId)}/addresses/${encodeURIComponent(editing)}`
    : `/v1/customers/${encodeURIComponent(customerId)}/addresses`;
  const res = await api(path, { method: editing ? "PUT" : "POST", body: JSON.stringify(body) });
  if (!res.ok) {
    if (err) {
      err.hidden = false;
      err.textContent = res.json?.error || "Could not save the address.";
    }
    return;
  }
  const previous = new Set((state.addressBook || []).map((row) => row.addressId));
  const saved = res.json.customer;
  state.addressBook = activeAddresses(saved);
  const chosen = editing
    ? state.addressBook.find((row) => row.addressId === editing)
    : state.addressBook.find((row) => !previous.has(row.addressId));
  if (chosen) applySavedAddress(chosen);
  closeAddressDialog();
  renderFulfillmentFields();
  renderCart();
  persistActiveCart();
  showToast("Address saved");
}

function renderFulfillmentFields() {
  const host = $("fulfillment-fields");
  if (!host) return;
  syncOrderTypeQuickButtons();
  const type = selectedOrderType();
  normalizeFulfillmentCustomerFields();
  const f = state.fulfillment;
  if (!type) {
    host.innerHTML = `<p class="fee-warn">No active order types. Add one in Shop Settings.</p>`;
    return;
  }
  const delivery = type.behavior === "DELIVERY";
  if (delivery && f.blockNumber) {
    const rate = activeBlockRate(f.blockNumber);
    if (rate && !f.deliveryFeeOverride) {
      f.expectedBlockRateCents = rate.chargeCents;
      f.deliveryChargeCents = rate.chargeCents;
    } else if (rate) {
      f.expectedBlockRateCents = rate.chargeCents;
      if (f.deliveryChargeCents === rate.chargeCents) f.deliveryFeeOverride = false;
    }
  }
  const hasCustomer = Boolean(selectedCustomerId(f));
  const deliveryCustomerOk = delivery && hasValidDeliveryCustomer(f);
  const summary = customerSummaryHtml(f, { addresses: delivery, delivery });
  // Never show "+ Add customer" alongside an already-selected customer card.
  const picker = hasCustomer ? "" : customerPickerHtml(delivery);
  let html = deliveryCustomerOk
    ? deliveryCustomerCardHtml(f)
    : hasCustomer
      ? summary
      : picker;
  if (type.behavior === "COUNTER") {
    html += fieldHtml("ff-counter", "Counter", f.counterLabel, {
      wide: true,
      placeholder: "Optional",
    });
  } else if (type.behavior === "TABLE") {
    html += fieldHtml("ff-table", "Table number", f.tableNumber, {
      wide: true,
      placeholder: "Required",
    });
  } else if (type.behavior === "CAR_HOP") {
    html +=
      fieldHtml("ff-vehicle", "Vehicle number", f.vehicleNumber, {
        placeholder: "Optional",
      }) +
      fieldHtml("ff-parking", "Parking location", f.parkingLocation, {
        wide: true,
        placeholder: "Optional",
      });
  }
  host.innerHTML = html;
  refreshFulfillmentValidationUi();
  $("cust-expand")?.addEventListener("click", () => {
    const picker = host.querySelector(".customer-picker");
    const body = host.querySelector(".customer-picker-body");
    const trigger = $("cust-expand");
    if (!picker || !body) return;
    picker.classList.remove("customer-picker-collapsed");
    body.hidden = false;
    if (trigger) trigger.hidden = true;
    $("cust-search")?.focus();
  });
  const custSearch = $("cust-search");
  if (custSearch) {
    syncCustSearchInputMode(custSearch);
    custSearch.addEventListener("input", () => {
      syncCustSearchInputMode(custSearch);
      scheduleCustomerSearch();
    });
    custSearch.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const hits = host.querySelectorAll("#cust-results .cust-hit");
      if (hits.length !== 1) return;
      event.preventDefault();
      hits[0].click();
    });
  }
  $("cust-add")?.addEventListener("click", () =>
    openCustomerDialog("create", { prefill: $("cust-search")?.value || "" })
  );
  $("cust-change")?.addEventListener("click", () => openAddressPicker("customer"));
  $("cust-edit")?.addEventListener("click", () => openCustomerDialog("edit"));
  $("cust-pick-address")?.addEventListener("click", () => openAddressPicker("address"));
  $("cust-add-address")?.addEventListener("click", () => openAddressEditor(null));
  $("cust-add-phone")?.addEventListener("click", () => {
    void openAddressPicker("customer").then(() => {
      promptCustomerPhoneInPicker({
        customerId: selectedCustomerId(),
        name: state.fulfillment.customerName || "",
        phone: "",
      });
    });
  });
  host.querySelectorAll("#cust-compact-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      state._customerCardExpanded = !state._customerCardExpanded;
      renderFulfillmentFields();
    });
  });
  bindCustomerMoreMenu(host);
  if (delivery && deliveryCustomerOk) {
    $("dl-details-toggle")?.addEventListener("click", () => {
      const next = !Boolean(state._deliveryDetailsExpanded);
      state._deliveryDetailsExpanded = next;
      renderFulfillmentFields();
    });
    const block = $("dl-block");
    block?.addEventListener("change", () => commitBlockInput(block.value));
    block?.addEventListener("blur", () => commitBlockInput(block.value));
    $("dl-charge")?.addEventListener("input", (event) => {
      syncDeliveryFromInput(event.target.value);
      persistActiveCart();
    });
    $("dl-charge")?.addEventListener("blur", (event) => {
      syncDeliveryFromInput(event.target.value, { format: true });
      persistActiveCart();
    });
    updateFeeNote();
  }
  host.querySelectorAll("input").forEach((input) => {
    if (input.id === "dl-charge" || input.id === "dl-block" || input.id === "cust-search") return;
    input.addEventListener("input", () => {
      readFulfillmentInputs();
      persistActiveCart();
    });
  });
  syncReviewWithCart();
}

function fulfillmentSummary() {
  const type = selectedOrderType();
  const f = state.fulfillment;
  if (!type) return "";
  if (type.behavior === "DELIVERY") {
    return [f.customerName, f.customerPhone, f.blockNumber ? `Block ${f.blockNumber}` : "", f.buildingNumber, f.roadNumber]
      .filter(Boolean)
      .join(" · ");
  }
  const who = [f.customerName, f.customerPhone].filter(Boolean).join(" · ");
  if (type.behavior === "TABLE") {
    return [f.tableNumber ? `Table ${f.tableNumber}` : "", who].filter(Boolean).join(" · ");
  }
  if (type.behavior === "CAR_HOP") {
    return [f.vehicleNumber, f.parkingLocation, who].filter(Boolean).join(" · ");
  }
  if (type.behavior === "COUNTER") return [f.counterLabel, who].filter(Boolean).join(" · ");
  return who;
}

function fulfillmentPayload() {
  const type = selectedOrderType();
  const f = state.fulfillment;
  const body = {};
  if (!type) return body;
  if (f.customerId) {
    body.customerId = f.customerId;
    body.customerName = f.customerName;
    body.customerPhone = f.customerPhone;
  }
  if (type.behavior === "COUNTER") body.counterLabel = f.counterLabel;
  if (type.behavior === "DELIVERY") {
    body.customerId = f.customerId;
    body.addressId = f.addressId;
    body.customerName = f.customerName;
    body.customerPhone = f.customerPhone;
    body.buildingNumber = f.buildingNumber;
    body.roadNumber = f.roadNumber;
    body.addressNote = f.addressNote;
    body.blockNumber = f.blockNumber;
    body.deliveryChargeCents = f.deliveryChargeCents;
    body.deliveryFeeOverride = Boolean(f.deliveryFeeOverride);
    body.expectedBlockRateCents = f.expectedBlockRateCents;
  }
  if (type.behavior === "TABLE") body.tableNumber = f.tableNumber;
  if (type.behavior === "CAR_HOP") {
    body.vehicleNumber = f.vehicleNumber;
    body.parkingLocation = f.parkingLocation;
  }
  return body;
}

function deliveryMissingCustomerContact() {
  const type = selectedOrderType();
  if (type?.behavior !== "DELIVERY") return false;
  normalizeFulfillmentCustomerFields();
  return !hasValidDeliveryCustomer();
}

function markCustomerRequiredUi() {
  const trigger = $("cust-expand");
  const picker = trigger?.closest(".customer-picker");
  const missing = deliveryMissingCustomerContact();
  if (trigger) {
    trigger.classList.toggle("customer-required-missing", missing);
    trigger.setAttribute("aria-invalid", missing ? "true" : "false");
  }
  picker?.classList.toggle("customer-picker--missing", missing);
  picker?.classList.toggle("customer-picker--optional", !missing && picker?.dataset.required !== "1");
}

function bindCustomerMoreMenu(host) {
  const moreBtn = host?.querySelector("#cust-more-btn");
  const menu = host?.querySelector("#cust-more-menu");
  if (!moreBtn || !menu) return;
  let onDoc = null;
  let onKey = null;
  const closeMenu = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    moreBtn.setAttribute("aria-expanded", "false");
    if (onDoc) document.removeEventListener("click", onDoc);
    if (onKey) document.removeEventListener("keydown", onKey);
    onDoc = null;
    onKey = null;
  };
  moreBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!menu.hidden) {
      closeMenu();
      return;
    }
    menu.hidden = false;
    moreBtn.setAttribute("aria-expanded", "true");
    onDoc = (ev) => {
      if (menu.contains(ev.target) || moreBtn.contains(ev.target)) return;
      closeMenu();
    };
    onKey = (ev) => {
      if (ev.key === "Escape") closeMenu();
    };
    setTimeout(() => {
      document.addEventListener("click", onDoc);
      document.addEventListener("keydown", onKey);
    }, 0);
  });
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => closeMenu());
  });
}

function refreshFulfillmentValidationUi() {
  normalizeFulfillmentCustomerFields();
  markCustomerRequiredUi();
  if (!deliveryMissingCustomerContact()) {
    const status = $("send-status");
    if (status && /customer with a contact/i.test(status.textContent || "")) {
      setStatus("");
    }
  }
}

function focusReviewSendButton() {
  const btn = $("review-btn") || $("review-order-btn");
  requestAnimationFrame(() => btn?.focus());
}

function hidePickerPhonePrompt() {
  state._pendingPhoneCustomer = null;
  const panel = $("picker-phone-prompt");
  const err = $("picker-phone-error");
  if (panel) panel.hidden = true;
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  const input = $("picker-phone-input");
  if (input) input.value = "";
}

function promptCustomerPhoneInPicker(customer) {
  state._pendingPhoneCustomer = customer;
  const panel = $("picker-phone-prompt");
  const name = $("picker-phone-name");
  const err = $("picker-phone-error");
  const input = $("picker-phone-input");
  if (name) name.textContent = customer.name || "Customer";
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  if (input) input.value = "";
  if (panel) panel.hidden = false;
  input?.focus();
}

async function confirmPendingCustomerPhone() {
  const customer = state._pendingPhoneCustomer;
  const phone = String($("picker-phone-input")?.value || "").trim();
  const err = $("picker-phone-error");
  if (!customer?.customerId) return;
  if (!phone) {
    if (err) {
      err.hidden = false;
      err.textContent = "Enter a contact number.";
    }
    $("picker-phone-input")?.focus();
    return;
  }
  const saveBtn = $("picker-phone-save");
  if (saveBtn) saveBtn.disabled = true;
  try {
    const res = await api(`/v1/customers/${encodeURIComponent(customer.customerId)}`, {
      method: "PUT",
      body: JSON.stringify({
        name: customer.name || "",
        phone,
      }),
    });
    if (!res.ok) {
      if (err) {
        err.hidden = false;
        err.textContent = res.json?.error || "Could not save the contact number.";
      }
      return;
    }
    hidePickerPhonePrompt();
    selectCustomer(res.json.customer);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function maybeResumeReviewAfterCustomerGate() {
  if (!state._resumeReviewAfterCustomer) return;
  normalizeFulfillmentCustomerFields();
  if (deliveryMissingCustomerContact()) return;
  refreshFulfillmentValidationUi();
  state._completingCustomerGate = true;
  state._resumeReviewAfterCustomer = false;
  const dialog = $("address-picker-dialog");
  if (dialog?.open) dialog.close();
  await openReview();
  state._completingCustomerGate = false;
  if (!$("review-dialog")?.open) focusReviewSendButton();
}

async function openDeliveryCustomerGate() {
  state._pickerMode = "customer";
  hidePickerPhonePrompt();
  await openAddressPicker("customer");
  const title = $("address-picker-title");
  if (title) title.textContent = "Delivery needs a customer";
  const dialog = $("address-picker-dialog");
  dialog?.setAttribute("aria-labelledby", "address-picker-title");
  const f = state.fulfillment;
  // Already have a customer but no contact number — ask for phone in the gate.
  if (selectedCustomerId(f) && !customerContactPhone(f)) {
    promptCustomerPhoneInPicker({
      customerId: selectedCustomerId(f),
      name: f.customerName || "",
      phone: "",
    });
    return;
  }
  const search = $("picker-cust-search");
  if (search) {
    search.setAttribute("inputmode", "tel");
    search.focus();
  }
}

function validateFulfillmentForSend() {
  const type = selectedOrderType();
  if (!type) return { ok: false, error: "Choose an order type." };
  readFulfillmentInputs();
  normalizeFulfillmentCustomerFields();
  if (type.behavior === "TABLE" && !state.fulfillment.tableNumber) {
    return { ok: false, error: "Enter a table number." };
  }
  if (type.behavior === "DELIVERY") {
    if (!hasValidDeliveryCustomer()) {
      return { ok: false, error: "Select a customer with a contact number." };
    }
    if (!state.fulfillment.addressId) {
      return { ok: false, error: "Select a delivery address." };
    }
    if (!state.fulfillment.blockNumber) {
      return { ok: false, error: "Enter a block number." };
    }
    const cents = state.fulfillment.deliveryChargeCents;
    if (!Number.isSafeInteger(cents) || cents < 0) {
      return { ok: false, error: "Enter a valid delivery charge." };
    }
    if (!activeBlockRate(state.fulfillment.blockNumber) && !state.fulfillment.deliveryFeeOverride) {
      return { ok: false, error: "No saved rate for this block. Enter a delivery charge." };
    }
  }
  return { ok: true };
}

function resetFulfillmentForNewOrder() {
  state.fulfillment = blankFulfillment();
  renderFulfillmentFields();
}

function fulfillmentHasDetails() {
  const f = state.fulfillment || {};
  return [
    f.customerId,
    f.addressId,
    f.addressLabel,
    f.customerName,
    f.customerPhone,
    f.buildingNumber,
    f.roadNumber,
    f.blockNumber,
    f.addressNote,
    f.tableNumber,
    f.vehicleNumber,
    f.parkingLocation,
    f.counterLabel,
  ].some((value) => String(value || "").trim())
    || f.deliveryFeeOverride === true
    || Number.isInteger(f.deliveryChargeCents);
}

async function loadOrderSetup() {
  const [typesRes, ratesRes] = await Promise.all([
    api("/v1/order-types"),
    api("/v1/block-delivery-rates"),
  ]);
  if (!typesRes.ok) return;
  state.orderTypes = (typesRes.json.orderTypes || []).filter((row) => row.isActive);
  state.blockRates = ratesRes.ok
    ? (ratesRes.json.rates || []).filter((row) => row.isActive)
    : [];
  fillOrderTypeSelect();
  renderFulfillmentFields();
}

function formatLineAmountOnly(cents) {
  if (state.money?.formatPlain) return state.money.formatPlain(cents);
  const decimals = 3;
  const factor = 10 ** decimals;
  return (Number(cents || 0) / factor).toFixed(decimals);
}

function reviewLineHtml(l, { bareLineAmount = false } = {}) {
  const label = l.variantName
    ? `Edit ${l.name} — ${l.variantName}`
    : `Edit ${l.name}`;
  const editButtonHtml = `<button type="button" class="review-edit" data-act="edit" aria-label="${escapeHtml(label)}">
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14.7 2.3a1 1 0 0 1 1.4 0l1.6 1.6a1 1 0 0 1 0 1.4l-9.5 9.5-3.2.8a.5.5 0 0 1-.6-.6l.8-3.2 9.5-9.5z"/></svg>
        Edit
      </button>`;
  return renderOrderLineItemHtml(
    {
      ...l,
      itemName: l.name,
      lineTotalCents: lineUnitCents(l) * Number(l.quantity || 0),
      addons: (l.addons || []).map((a) => ({
        ...a,
        appliedPriceCents: addonAppliedPrice(a),
      })),
    },
    {
      escapeHtml,
      formatMoney: formatPrice,
      formatLineMoney: bareLineAmount ? formatLineAmountOnly : formatPrice,
      formatSignedMoney: formatSignedPrice,
      editButtonHtml,
    }
  );
}

function paintReview() {
  const totals = cartTotals();
  const type = selectedOrderType();
  const destination = fulfillmentSummary();
  const meta = $("review-meta");
  if (meta) {
    const hasCustomer = Boolean(selectedCustomerId());
    const summary = `${escapeHtml(type?.name || "")}${destination ? ` · ${escapeHtml(destination)}` : ""}`;
    const numberLabel = state.editingOrderId ? "Editing" : "Draft";
    const numberTitle = state.editingOrderId
      ? "Saving replaces this accepted order."
      : "This draft number is not accepted until the order is sent.";
    meta.innerHTML = `<span class="review-order-id" title="${numberTitle}">${numberLabel} ${escapeHtml(state.orderNumber)}</span>
      <div class="review-customer-row">
        <span class="muted">${summary || "No customer"}</span>
        <span class="review-customer-actions">
          ${
            hasCustomer
              ? `<button type="button" class="review-edit" id="review-edit-customer">Edit</button>`
              : ""
          }
          <button type="button" class="review-edit" id="review-change-customer">${hasCustomer ? "Change" : "Add customer"}</button>
        </span>
      </div>`;
  }
  const splitGroups = splitInUse()
    ? splitIds().filter((n) => linesForSplit(n).length)
    : [];
  const linesHtml = splitGroups.length
    ? splitGroups
        .map((n) => {
          const lines = linesForSplit(n);
          return `<section class="review-split">
            <header class="review-split-head">
              <strong class="review-split-title">Order ${n}</strong>
              <strong class="review-split-total">${formatSplitGroupTotalLabel(formatPrice(splitItemsCents(lines)))}</strong>
            </header>
            <div class="review-lines">${reviewLinesHtml(lines, { hideSingleCategory: true, bareLineAmount: true })}</div>
          </section>`;
        })
        .join("")
    : `<div class="review-lines">${reviewLinesHtml(state.cart)}</div>`;
  $("review-body").innerHTML = `
    ${linesHtml}
    ${renderTaxSummaryHtml(cartTaxEstimate(), {
      compact: true,
      itemCount: totals.count,
    })}
  `;
  const confirm = $("review-confirm");
  if (confirm && !state.sending) {
    confirm.textContent = state.editingOrderId ? "Save changes" : "Confirm & Send";
  }
}

function syncReviewWithCart() {
  const dialog = $("review-dialog");
  if (!dialog?.open) return;
  if (!state.cart.length) {
    dialog.close();
    setStatus("Add at least one item before sending.", false);
    return;
  }
  paintReview();
}

function printSettings() {
  return state.config?.printSettings || {};
}

function syncOrderPrintChoice() {
  const ps = printSettings();
  const wrap = $("review-print-wrap");
  const kitchen = $("review-print-kitchen");
  const cashier = $("review-print-cashier");
  if (!wrap || !kitchen || !cashier) return;
  const editing = Boolean(state.editingOrderId);
  const allowKitchen = ps.kitchenAutoPrint !== false;
  const allowCashier =
    ps.cashierAutoPrint !== false && ps.cashierAutoPrintOnPayment !== false;
  const ask = ps.askBeforePrint !== false;
  wrap.hidden = !allowKitchen && !allowCashier;
  kitchen.closest("label").hidden = !allowKitchen;
  cashier.closest("label").hidden = !allowCashier;
  if (!ask) {
    kitchen.checked = editing ? false : allowKitchen;
    cashier.checked = editing ? false : allowCashier;
    kitchen.disabled = true;
    cashier.disabled = true;
    return;
  }
  kitchen.disabled = !allowKitchen;
  cashier.disabled = !allowCashier;
  if (!Object.prototype.hasOwnProperty.call(kitchen.dataset, "userTouched")) {
    kitchen.checked = editing ? false : allowKitchen;
  }
  if (!Object.prototype.hasOwnProperty.call(cashier.dataset, "userTouched")) {
    cashier.checked = editing ? false : allowCashier;
  }
}

function syncPaymentPrintChoice() {
  const ps = printSettings();
  const wrap = $("payment-print-wrap");
  const box = $("payment-print-cashier");
  if (!wrap || !box) return;
  const allow =
    ps.cashierAutoPrint !== false && ps.cashierAutoPrintOnPayment !== false;
  const ask = ps.askBeforePrint !== false;
  wrap.hidden = !allow;
  if (!ask) {
    box.checked = allow;
    box.disabled = true;
    return;
  }
  box.disabled = false;
  if (!Object.prototype.hasOwnProperty.call(box.dataset, "userTouched")) {
    box.checked = allow;
  }
}

function wantKitchenPrint() {
  const ps = printSettings();
  if (ps.kitchenAutoPrint === false) return false;
  if (ps.askBeforePrint === false) return true;
  return Boolean($("review-print-kitchen")?.checked);
}

function wantCashierBillAtOrder() {
  const ps = printSettings();
  if (ps.cashierAutoPrint === false) return false;
  if (ps.askBeforePrint === false) return true;
  return Boolean($("review-print-cashier")?.checked);
}

function wantCashierPrint() {
  const ps = printSettings();
  if (ps.cashierAutoPrint === false) return false;
  if (ps.askBeforePrint === false) return true;
  return Boolean($("payment-print-cashier")?.checked);
}

async function openReview() {
  if (!state.cart.length) {
    setStatus("Add at least one item before sending.", false);
    return;
  }
  readFulfillmentInputs();
  normalizeFulfillmentCustomerFields();
  refreshFulfillmentValidationUi();
  if (deliveryMissingCustomerContact()) {
    setStatus("Select a customer with a contact number.", false);
    state._resumeReviewAfterCustomer = true;
    await openDeliveryCustomerGate();
    return;
  }
  const ready = validateFulfillmentForSend();
  if (!ready.ok) {
    setStatus(ready.error, false);
    return;
  }
  setStatus("");
  await syncDraftNumber();
  paintReview();
  syncOrderPrintChoice();
  const dialog = $("review-dialog");
  if (!dialog.open) dialog.showModal();
  watchReviewNumber();
  $("review-confirm")?.focus();
}

function editReviewLine(lineId, trigger) {
  if (!state.cart.some((l) => l.lineId === lineId)) return;
  state._customizeTrigger = trigger || null;
  openInstructions(lineId);
}

async function sendTestOrder() {
  if (state.sending) return;
  if (!state.cart.length) {
    setStatus("Add at least one item before sending.", false);
    return;
  }
  state.sending = true;
  $("review-confirm").disabled = true;
  const rb = $("review-btn") || $("review-order-btn");
  if (rb) rb.disabled = true;
  setStatus(state.editingOrderId ? "Saving order changes…" : "Sending test order…");

  const ready = validateFulfillmentForSend();
  if (!ready.ok) {
    state.sending = false;
    $("review-confirm").disabled = false;
    if (rb) rb.disabled = false;
    setStatus(ready.error, false);
    return;
  }
  const type = selectedOrderType();
  if (!state.submissionId) state.submissionId = newSubmissionId();
  const body = {
    orderNumber: state.orderNumber,
    ...(state.editingOrderId ? { orderId: state.editingOrderId } : {}),
    submissionId: state.submissionId,
    orderTypeId: type.orderTypeId,
    orderType: type.code,
    ticketRevision: 1,
    printKitchen: wantKitchenPrint(),
    printCashier: wantCashierBillAtOrder(),
    fulfillment: fulfillmentPayload(),
    lines: state.cart.map((l) => {
      const configured = lineConfiguredPrice(l);
      const applied = Number(l.priceCents || 0);
      const overridden =
        Boolean(l.basePriceAdjusted) || applied !== configured;
      const instructions = lineInstructionsForOrder(l);
      if (splitInUse()) instructions.unshift(`Order ${lineSplitNo(l)}`);
      return {
        itemId: l.itemId,
        variantId: l.variantId || undefined,
        unitBasePriceCents: applied,
        ...(overridden
          ? {
              basePriceOverride: true,
              configuredUnitBasePriceCents: configured,
            }
          : {}),
        quantity: l.quantity,
        instructions,
        addons: (l.addons || []).map((a) => ({
          addonId: a.addonId,
          quantity: a.quantity || 1,
          ...(a.priceAdjusted || a.priceEnteredAtSale
            ? { unitPriceCents: Number(a.unitPriceCents) }
            : {}),
        })),
      };
    }),
  };

  try {
    const res = await api("/v1/test-orders", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 401) {
        persistActiveCart();
        if ($("review-dialog")?.open) $("review-dialog").close();
        showLogin("This sign-in is no longer valid. The order was not sent, and the cart is still here.");
        return;
      }
      if (
        res.json?.code === "SUBMISSION_CONFLICT" ||
        res.json?.code === "SUBMISSION_REQUIRED" ||
        res.json?.code === "ORDER_NUMBER_USED" ||
        res.json?.code === "ORDER_ALREADY_PAID" ||
        res.json?.code === "ORDER_NOT_EDITABLE"
      ) {
        setStatus(res.json.error || "This order was not accepted.", false);
        return;
      }
      if (res.json?.code === "DELIVERY_RATE_CHANGED") {
        applySuggestedRate(res.json.configuredChargeCents, res.json.blockNumber);
        if ($("review-dialog").open) $("review-dialog").close();
      }
      setStatus(res.json?.error || "Send failed", false);
      return;
    }
    const sentOrderNumber = res.json.order?.order_number || state.orderNumber;
    const sentOrderId = res.json.order.order_id;
    state.lastOrderId = sentOrderId;
    const created = res.json.created;
    const edited = Boolean(res.json.edited);
    if ($("review-dialog").open) $("review-dialog").close();

    pushPrintNotice({
      tone: "ok",
      text: edited
        ? `Order ${sentOrderNumber} updated.`
        : created
          ? `Order ${sentOrderNumber} accepted.`
          : `Order ${sentOrderNumber} was already accepted.`,
    });
    await prepareNextOrderAfterDispatch(sentOrderNumber);
    watchSentOrderTickets(sentOrderId, sentOrderNumber);
    void openPaymentOffer(sentOrderId);
  } catch (err) {
    setStatus(err.message || "Network error", false);
  } finally {
    state.sending = false;
    $("review-confirm").disabled = false;
    const rb2 = $("review-btn") || $("review-order-btn");
    if (rb2) rb2.disabled = false;
  }
}

function isJobDispatched(status) {
  return status === "DISPATCHED" || status === "CONFIRMED";
}

function allOrderJobsComplete(jobs) {
  if (!Array.isArray(jobs) || !jobs.length) return false;
  return jobs.every((j) => isJobDispatched(j.status));
}

function jobsIncludeOrderNumber(jobs, orderNumber) {
  const target = String(orderNumber || "");
  if (!target) return false;
  return (jobs || []).some((job) => {
    try {
      return JSON.parse(job.payload_snapshot || "{}").orderNumber === target;
    } catch {
      return false;
    }
  });
}

async function watchSentOrderTickets(orderId, sentOrderNumber) {
  if (!orderId) return;
  for (let attempt = 0; attempt < 12; attempt++) {
    await sleep(attempt === 0 ? 1600 : 800);
    const jobs = (await refreshJobs({ quiet: true, orderId })) || [];
    if (allOrderJobsComplete(jobs)) return;
    if (jobs.some((job) => PRINT_ATTENTION.has(job.status))) {
      pushPrintNotice({
        tone: "err",
        sticky: true,
        text: `Order ${sentOrderNumber}: some tickets still need attention.`,
      });
      return;
    }
  }
}

function clearPrinterView() {
  setPrintDrawer(false);
}

async function prepareNextOrderAfterDispatch(sentOrderNumber) {
  const sent = sentOrderNumber || state.orderNumber;
  state.lastOrderId = null;
  state.submissionId = "";
  state.orderNumber = "";
  await ensureDraftIdentity({ fresh: true });
  emptyCart({
    status: `Order ${sent} accepted — cart cleared for the next order.`,
  });
  resetFulfillmentForNewOrder();
  clearPrinterView();
  showToast(`Order ${sent} accepted`);
  refreshJobs({ quiet: true });
}

const PRINT_ATTENTION = new Set(["FAILED", "UNKNOWN", "NEEDS_REVIEW"]);
const PRINT_CONFIRM = new Set(["DISPATCHED", "UNKNOWN", "NEEDS_REVIEW"]);
const PRINT_REPRINT = new Set(["FAILED", "UNKNOWN", "NEEDS_REVIEW", "DISPATCHED", "CONFIRMED"]);

async function refreshJobs({ quiet = false, orderId = state.lastOrderId } = {}) {
  const [printersRes, stationsRes, jobsRes] = await Promise.all([
    api("/v1/printers"),
    api("/v1/stations"),
    api(
      orderId
        ? `/v1/print-jobs?orderId=${encodeURIComponent(orderId)}`
        : "/v1/print-jobs"
    ),
  ]);
  if (!printersRes.ok || !stationsRes.ok || !jobsRes.ok) {
    if (printersRes.status === 401 || jobsRes.status === 401) {
      showLogin("Session expired. Sign in again.");
    }
    return [];
  }
  state.printers = printersRes.json.printers || [];
  state.stations = stationsRes.json.stations || [];
  const jobs = jobsRes.json.jobs || [];
  noteJobUpdates(jobs, { quiet });
  renderPrinterStatus(jobs);
  await renderTicketCards(jobs);
  return jobs;
}

function jobNoticeKey(job) {
  return `${job.job_id}:${job.status}`;
}

function jobContext(job) {
  let payload = {};
  try {
    payload = JSON.parse(job.payload_snapshot || "{}");
  } catch {
    payload = {};
  }
  const station = state.stations.find((row) => row.station_id === job.station_id);
  const printer = state.printers.find((row) => row.printer_id === job.printer_id);
  return {
    payload,
    stationName: station?.name || job.station_id || "Station",
    orderNumber: payload.orderNumber || "—",
    printer,
  };
}

function jobNotice(job) {
  const ctx = jobContext(job);
  const where = `${ctx.stationName} · order ${ctx.orderNumber}`;
  if (job.status === "DISPATCHED" && ctx.printer?.connection_type === "MOCK") {
    return { tone: "ok", text: `Mock ticket generated for ${where}. Not a physical print.` };
  }
  if (job.status === "DISPATCHED") {
    return { tone: "ok", text: `Ticket handed off for ${where}. Not confirmed as printed.` };
  }
  if (job.status === "CONFIRMED") {
    return { tone: "ok", text: `Operator confirmed the ticket for ${where}.` };
  }
  if (PRINT_ATTENTION.has(job.status)) {
    const detail = job.last_error ? ` ${job.last_error}` : "";
    return { tone: "err", sticky: true, text: `${job.status} for ${where}.${detail}` };
  }
  return null;
}

function noteJobUpdates(jobs, { quiet = false } = {}) {
  if (!state._jobNoticeKeys) state._jobNoticeKeys = new Set();
  updatePrintBadge(jobs);
  if (!state._jobNoticeReady || quiet) {
    for (const job of jobs) state._jobNoticeKeys.add(jobNoticeKey(job));
    state._jobNoticeReady = true;
    return;
  }
  for (const job of jobs) {
    const key = jobNoticeKey(job);
    if (state._jobNoticeKeys.has(key)) continue;
    state._jobNoticeKeys.add(key);
    const notice = jobNotice(job);
    if (notice) pushPrintNotice(notice);
  }
}

function updatePrintBadge(jobs) {
  const count = jobs.filter((job) => PRINT_ATTENTION.has(job.status)).length;
  const badge = $("print-jobs-count");
  const button = $("print-jobs-btn");
  if (!badge || !button) return;
  badge.hidden = count === 0;
  badge.textContent = count > 9 ? "9+" : String(count);
  button.setAttribute(
    "aria-label",
    count ? `Print jobs, ${count} need attention` : "Print jobs"
  );
}

function pushPrintNotice({ text, tone = "ok", sticky = false } = {}) {
  const host = $("print-notices");
  if (!host || !text) return;
  const el = document.createElement("div");
  el.className = `print-notice ${tone}`;
  el.innerHTML = `<span>${escapeHtml(text)}</span><button type="button" aria-label="Dismiss notice">✕</button>`;
  el.querySelector("button").addEventListener("click", () => el.remove());
  host.appendChild(el);
  if (!sticky) setTimeout(() => el.remove(), 4200);
}

function setPrintDrawer(open) {
  const drawer = $("print-jobs-drawer");
  const backdrop = $("print-jobs-backdrop");
  const button = $("print-jobs-btn");
  if (!drawer) return;
  drawer.hidden = !open;
  if (backdrop) backdrop.hidden = !open;
  if (button) button.setAttribute("aria-expanded", open ? "true" : "false");
}

function renderPrinterStatus(jobs) {
  const host = $("printer-status");
  host.innerHTML = "";
  const stationByPrinter = {};
  for (const s of state.stations) {
    if (s.printer_id) stationByPrinter[s.printer_id] = s.name;
  }
  for (const p of state.printers) {
    const related = jobs.filter((j) => j.printer_id === p.printer_id);
    const worst = pickStatus(related.map((j) => j.status));
    const card = document.createElement("div");
    card.className = "printer-card";
    card.innerHTML = `
      <strong>${escapeHtml(p.display_name)}</strong>
      <div>Station: ${escapeHtml(stationByPrinter[p.printer_id] || "—")}</div>
      <div>Type: ${escapeHtml(p.connection_type)}</div>
      <div>Jobs: ${related.length}${worst ? ` · <span class="status-badge ${worst}">${worst}</span>` : ""}</div>
    `;
    host.appendChild(card);
  }
  if (state.config?.physicalPrintEnabled && state.role === "admin") {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent =
      "Physical printing is enabled in server config. Use admin reprint/confirm APIs carefully — MOCK remains the supported test path.";
    host.appendChild(note);
  }
}

async function renderTicketCards(jobs) {
  const host = $("ticket-cards");
  host.innerHTML = "";
  if (!jobs.length) {
    host.innerHTML = `<p class="empty">No print jobs yet for this order.</p>`;
    return;
  }
  const printerName = Object.fromEntries(
    state.printers.map((p) => [p.printer_id, p.display_name])
  );
  const stationName = Object.fromEntries(
    state.stations.map((s) => [s.station_id, s.name])
  );

  for (const job of jobs) {
    let payload = {};
    try {
      payload = JSON.parse(job.payload_snapshot || "{}");
    } catch {
      payload = {};
    }
    const items = (payload.items || [])
      .map(
        (i) =>
          `${i.quantity} × ${i.name}${(i.instructions || []).length ? ` (${i.instructions.join(", ")})` : ""}`
      )
      .join("<br>");
    const card = document.createElement("article");
    card.className = "ticket-card";
    card.innerHTML = `
      <h3>${escapeHtml(job.job_type)} · ${escapeHtml(stationName[job.station_id] || job.station_id || "—")}</h3>
      <div><span class="status-badge ${job.status}">${escapeHtml(job.status)}</span></div>
      <p class="muted">Order ${escapeHtml(payload.orderNumber || "—")}</p>
      <p>${items || "<span class='muted'>No items</span>"}</p>
      <p class="muted">Printer: ${escapeHtml(printerName[job.printer_id] || job.printer_id)}${
        state.printers.find((row) => row.printer_id === job.printer_id)?.connection_type === "MOCK"
          ? " · MOCK, not a physical print"
          : ""
      }</p>
      ${job.last_error ? `<p class="ticket-error">${escapeHtml(job.last_error)}</p>` : ""}
      <div class="ticket-actions"></div>
    `;
    const actions = card.querySelector(".ticket-actions");
    const view = document.createElement("button");
    view.type = "button";
    view.className = "btn ghost small";
    view.textContent = "View ticket";
    view.addEventListener("click", () => openPreview(job.job_id));
    actions.appendChild(view);
    if (state.role === "admin" && PRINT_REPRINT.has(job.status)) {
      const reprint = document.createElement("button");
      reprint.type = "button";
      reprint.className = "btn ghost small";
      reprint.textContent = "Reprint";
      reprint.addEventListener("click", () => reprintJob(job.job_id));
      actions.appendChild(reprint);
    }
    if (state.role === "admin" && PRINT_CONFIRM.has(job.status)) {
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "btn ghost small";
      confirm.textContent = "Confirm";
      confirm.addEventListener("click", () => confirmPrintJob(job.job_id));
      actions.appendChild(confirm);
    }
    host.appendChild(card);
  }
}

async function reprintJob(jobId) {
  const res = await api(`/v1/print-jobs/${encodeURIComponent(jobId)}/reprint`, {
    method: "POST",
    body: "{}",
  });
  if (!res.ok) {
    pushPrintNotice({ tone: "err", sticky: true, text: res.json?.error || "Reprint was not started." });
    return;
  }
  pushPrintNotice({ tone: "ok", text: "Reprint queued. The original job was not marked successful." });
  await refreshJobs();
}

async function confirmPrintJob(jobId) {
  const res = await api(`/v1/print-jobs/${encodeURIComponent(jobId)}/confirm`, {
    method: "POST",
    body: JSON.stringify({ note: "Confirmed from Sales" }),
  });
  if (!res.ok) {
    pushPrintNotice({ tone: "err", sticky: true, text: res.json?.error || "Job was not confirmed." });
    return;
  }
  pushPrintNotice({
    tone: "ok",
    text: "Job marked confirmed by the operator. This is not a new physical print.",
  });
  await refreshJobs();
}

async function openPreview(jobId) {
  const res = await api(`/v1/print-jobs/${encodeURIComponent(jobId)}/preview`);
  if (!res.ok) {
    setStatus(res.json?.error || "Preview failed", false);
    return;
  }
  $("preview-title").textContent = `${res.json.jobType} · ${res.json.printerName} · ${res.json.status}`;
  $("preview-text").textContent = res.json.text || "";
  $("preview-dialog").showModal();
}

function pickStatus(statuses) {
  const order = [
    "FAILED",
    "UNKNOWN",
    "NEEDS_REVIEW",
    "DISPATCHING",
    "PENDING",
    "DISPATCHED",
    "CONFIRMED",
  ];
  for (const s of order) {
    if (statuses.includes(s)) return s;
  }
  return "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function bootstrapData() {
  const [menuRes, cfgRes, catRes] = await Promise.all([
    api("/v1/menu-items?includeInactive=0"),
    api("/v1/config"),
    api("/v1/menu-categories?includeInactive=0"),
  ]);
  if (!menuRes.ok) {
    if (menuRes.status === 401) showLogin("Session expired.");
    else setStatus(menuRes.json?.error || "Failed to load menu", false);
    return;
  }
  state.menu = menuRes.json.menuItems || [];
  state.categories = catRes.ok ? catRes.json.categories || [] : [];
  state.subcategories = catRes.ok ? catRes.json.subcategories || [] : [];
  state.config = cfgRes.ok ? cfgRes.json : null;
  if (cfgRes.ok) {
    state.canAdjustAddonPrices = Boolean(state.config?.canAdjustAddonPrices);
    state.canAdjustBasePrices = Boolean(state.config?.canAdjustBasePrices);
  }
  if (state.config?.shop) {
    state.money = createMoneyFormatter(state.config.shop);
  } else {
    state.money = createMoneyFormatter({
      currencyLabel: "QR",
      currencyDecimals: 2,
    });
  }
  renderCategories();
  renderMenu();
  await loadOrderSetup();
  const restored = restoreActiveCartIfAny();
  const editId = new URLSearchParams(location.search).get("editOrder");
  if (editId) history.replaceState(null, "", location.pathname);
  let editStarted = false;
  if (editId) editStarted = await beginEdit(editId);
  if (!editStarted) {
    if (restored && !state.submissionId) state.submissionId = newSubmissionId();
    if (!restored) await ensureDraftIdentity({ fresh: true });
    else if (!state.editingOrderId) await syncDraftNumber();
    renderCart();
    updateHeldCartUi();
    const jobs = (await refreshJobs()) || [];
    if (restored && !state.editingOrderId && jobsIncludeOrderNumber(jobs, state.orderNumber)) {
      await prepareNextOrderAfterDispatch(state.orderNumber);
    } else if (restored) {
      showToast("Cart restored after refresh.", { duration: 3000 });
    }
  } else {
    updateHeldCartUi();
  }
  // One cashier payment screen: Order Management links here, too.
  const payOrder = new URLSearchParams(location.search).get("payOrder");
  if (payOrder && canReceivePayment() && !editId) {
    history.replaceState(null, "", location.pathname);
    void openTakePayment(payOrder);
  }
}

function canReceivePayment() {
  return Boolean(state.staff && state.permissions.includes("sales.payment.receive"));
}

function canEditOrders() {
  if (state.role === "admin" || state.role === "device") return true;
  return Boolean(state.staff && state.permissions.includes("sales.order.create"));
}

function cartLineFromDraft(raw) {
  const item = state.menu.find((row) => row.item_id === raw.itemId);
  const stored = Array.isArray(raw.instructions) ? raw.instructions : [];
  const split = /^Order (\d+)$/.exec(stored[0] || "");
  const instructions = split ? stored.slice(1) : stored;
  return {
    lineId: `line_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    itemId: raw.itemId,
    name: raw.name || item?.name || "Item",
    variantId: raw.variantId || null,
    variantName: raw.variantName || "",
    imageUrl: item?.image_url || "",
    configuredPriceCents: Number(raw.configuredPriceCents ?? raw.priceCents ?? 0),
    priceCents: Number(raw.priceCents || 0),
    basePriceAdjusted: Boolean(raw.basePriceAdjusted),
    taxApplicable: raw.taxApplicable !== false,
    stationIds: item?.stationIds || [],
    instructionModifiers: item?.instructionModifiers || DEFAULT_MODIFIERS,
    instructionTargets: item?.instructionTargets || DEFAULT_TARGETS,
    instructionStandalone: item?.instructionStandalone || [],
    availableAddons: (item?.addons || []).filter((addon) => addon.isActive),
    quantity: Math.max(1, Number(raw.quantity) || 1),
    instructions,
    orderNote: "",
    addons: (raw.addons || []).map((addon) => ({
      addonId: addon.addonId,
      name: addon.name,
      quantity: addon.quantity || 1,
      unitPriceCents: Number(addon.unitPriceCents || 0),
      configuredUnitPriceCents: Number(
        addon.configuredUnitPriceCents ?? addon.unitPriceCents ?? 0
      ),
      priceAdjusted: Boolean(addon.priceAdjusted),
      priceEnteredAtSale: Boolean(addon.priceAdjusted),
    })),
    splitNo: split ? Number(split[1]) : 1,
  };
}

async function beginEdit(orderId) {
  if (!orderId) return false;
  if (!canEditOrders()) {
    setStatus("You do not have permission to edit orders.", false);
    return false;
  }
  if (cartHasItems() && state.editingOrderId !== orderId) {
    if (!confirmLeaveCart("Editing this order")) return false;
  }
  const res = await api(`/v1/orders/${encodeURIComponent(orderId)}/edit-draft`);
  if (res.status === 401) {
    showLogin("This sign-in is no longer valid.");
    return false;
  }
  if (!res.ok) {
    setStatus(res.json?.error || "This order cannot be edited.", false);
    return false;
  }
  const draft = res.json;
  state.editingOrderId = draft.orderId;
  state.orderNumber = draft.orderNumber || "";
  state.submissionId = newSubmissionId();
  state.lastOrderId = null;
  delete $("review-print-kitchen")?.dataset.userTouched;
  delete $("review-print-cashier")?.dataset.userTouched;
  state.fulfillment = { ...blankFulfillment(), ...(draft.fulfillment || {}) };
  normalizeFulfillmentCustomerFields();
  const typeSelect = $("order-type");
  if (typeSelect) {
    const known = (state.orderTypes || []).some((row) => row.orderTypeId === draft.orderTypeId);
    if (known) typeSelect.value = draft.orderTypeId;
    else {
      const byCode = (state.orderTypes || []).find((row) => row.code === draft.orderTypeCode);
      if (byCode) typeSelect.value = byCode.orderTypeId;
    }
  }
  state.cart = (draft.lines || []).map((line, index) => {
    const built = cartLineFromDraft(line);
    built.lineId = `line_edit_${index}_${Math.random().toString(16).slice(2)}`;
    return built;
  });
  state.activeSplit = Math.max(1, ...state.cart.map((line) => lineSplitNo(line)));
  focusCartLine(null);
  showOrderNumber();
  renderFulfillmentFields();
  renderCart();
  persistActiveCart();
  $("payment-dialog")?.close();
  $("payment-offer-dialog")?.close();
  $("pending-dialog")?.close();
  setStatus(`Editing order ${draft.orderNumber}. Change it, then review and save.`);
  return true;
}

function paymentAttemptKey(orderId) {
  return `gtct.cashSettlement.${orderId}`;
}

function readPaymentAttempt(orderId) {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(paymentAttemptKey(orderId)) || "null");
    if (parsed && /^[A-Za-z0-9_-]{8,80}$/.test(String(parsed.submissionId || ""))) {
      if (Number.isSafeInteger(Number(parsed.amountCents)) && parsed.currencyCode) {
        return {
          submissionId: String(parsed.submissionId),
          amountCents: Number(parsed.amountCents),
          currencyCode: String(parsed.currencyCode),
          tender: parsed.tender === "BANK" ? "BANK" : "CASH",
          bankAccountId: String(parsed.bankAccountId || ""),
          submitted: parsed.submitted === true,
        };
      }
    }
  } catch {
    /* use the in-memory attempt */
  }
  if (state.payment.orderId === orderId && state.payment.attempt?.submissionId) {
    return state.payment.attempt;
  }
  return null;
}

function storePaymentAttempt(orderId, attempt) {
  state.payment.orderId = orderId;
  state.payment.attempt = attempt;
  try {
    sessionStorage.setItem(paymentAttemptKey(orderId), JSON.stringify(attempt));
  } catch {
    /* the in-memory attempt still retries with the same id */
  }
}

function clearPaymentAttempt(orderId) {
  state.payment.attempt = null;
  try {
    sessionStorage.removeItem(paymentAttemptKey(orderId));
  } catch {
    /* nothing stored */
  }
}

function ensurePaymentAttempt(orderId, view) {
  const existing = readPaymentAttempt(orderId);
  if (existing) return existing;
  const attempt = {
    submissionId: newSubmissionId(),
    amountCents: Number(view.balanceCents),
    currencyCode: String(view.currencyCode || ""),
    tender: "CASH",
    bankAccountId: "",
    submitted: false,
  };
  storePaymentAttempt(orderId, attempt);
  return attempt;
}

function paymentMoney(view) {
  return createMoneyFormatter({
    currencyLabel: view?.currencyLabel || view?.currencyCode || "",
    currencyDecimals: view?.currencyDecimals,
  });
}

function showPaymentError(message) {
  const el = $("payment-error");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

function closePaymentUi() {
  for (const id of ["payment-offer-dialog", "payment-dialog"]) {
    const dialog = $(id);
    if (dialog?.open) dialog.close();
  }
  setPendingDrawer(false);
}

function setPendingDrawer(open) {
  const drawer = $("pending-payments-drawer");
  const backdrop = $("pending-backdrop");
  const btn = $("pending-payments-btn");
  if (drawer) drawer.hidden = !open;
  if (backdrop) backdrop.hidden = !open;
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
}

// P2-E2C3B: a single TEST payment entry, shared by Sales and Order Management.
// All new payments use the existing idempotent payment-allocations endpoint.
function exactPaymentUnits(raw, decimals) {
  const text = String(raw ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, part = ""] = text.split(".");
  if (part.length > decimals) return null;
  const units = Number(whole) * 10 ** decimals + Number(part.padEnd(decimals, "0"));
  return Number.isSafeInteger(units) ? units : null;
}

function paymentInputText(cents, decimals) {
  return (Number(cents) / 10 ** decimals).toFixed(decimals);
}

function selectedEntryMode() {
  return document.querySelector('input[name="pay-entry-mode"]:checked')?.value || "CASH";
}

function paymentEntryAmounts(view) {
  const decimals = Number(view?.currencyDecimals ?? 2);
  const mode = selectedEntryMode();
  const cashCents = exactPaymentUnits($("payment-cash-input").value, decimals);
  const bankCents = exactPaymentUnits($("payment-bank-input").value, decimals);
  const creditCents = exactPaymentUnits($("payment-credit-input").value, decimals);
  if ([cashCents, bankCents, creditCents].some((n) => n === null)) return null;
  if (mode === "CASH" && (bankCents || creditCents)) return null;
  if (mode === "BANK" && (cashCents || creditCents)) return null;
  if (mode === "CREDIT" && (cashCents || bankCents)) return null;
  const total = cashCents + bankCents + creditCents;
  if (!Number.isSafeInteger(total)) return null;
  return { cashCents, bankCents, creditCents, total };
}

function renderPaymentAccounts() {
  const select = $("payment-bank-account");
  if (!select) return;
  const selected = select.value;
  select.innerHTML = '<option value="">Select account</option>' + (state.payment.accounts || [])
    .filter((a) => a.accountType === "OPERATIONAL" && a.isActive)
    .map((a) => `<option value="${escapeHtml(a.accountId)}">${escapeHtml(a.displayName + " · " + a.bankName)}</option>`)
    .join("");
  if ([...select.options].some((o) => o.value === selected)) select.value = selected;
}

function resetEntryMode(mode = "CASH") {
  const view = state.payment.view;
  if (!view) return;
  const decimals = Number(view.currencyDecimals ?? 2);
  const remaining = Number(view.unallocatedCents ?? view.balanceCents ?? 0);
  document.querySelectorAll('input[name="pay-entry-mode"]').forEach((el) => {
    el.checked = el.value === mode;
  });
  const fields = { CASH: "payment-cash-input", BANK: "payment-bank-input", CREDIT: "payment-credit-input" };
  for (const id of Object.values(fields)) $(id).value = paymentInputText(0, decimals);
  if (fields[mode]) $(fields[mode]).value = paymentInputText(remaining, decimals);
  renderPaymentEntry();
}

// Credit is never anonymous: the server also validates this customer/shop binding.
function creditSelectionNeeded() {
  const parts = state.payment.view ? paymentEntryAmounts(state.payment.view) : null;
  return selectedEntryMode() === "CREDIT" || Number(parts?.creditCents || 0) > 0;
}
function creditCustomerError(message) {
  const node = $("payment-credit-customer-error");
  if (node) { node.hidden = !message; node.textContent = message || ""; }
}
function renderCreditCustomer() {
  const wrap = $("payment-credit-customer-wrap");
  if (!wrap) return;
  const needed = creditSelectionNeeded();
  wrap.hidden = !needed;
  if (!needed) return;
  const customer = state.payment.creditCustomer;
  $("payment-credit-selected").hidden = !customer;
  $("payment-credit-lookup").hidden = Boolean(customer);
  $("payment-credit-selected-name").textContent = customer
    ? [customer.name, customer.phone].filter(Boolean).join(" · ") : "";
  $("payment-credit-change").hidden = Boolean(state.payment.view?.customerId || state.payment.view?.creditCustomerId);
  const locked = state.payment.confirming || state.payment.uncertain;
  for (const id of ["payment-credit-search", "payment-credit-create-toggle", "payment-credit-new-name", "payment-credit-new-phone", "payment-credit-create-save", "payment-credit-change"]) {
    const el = $(id); if (el && id !== "payment-credit-create-save") el.disabled = locked;
  }
}
function selectPaymentCreditCustomer(customer) {
  if (!customer?.customerId) return;
  state.payment.creditCustomer = { customerId: customer.customerId,
    name: customer.name || "", phone: customer.phone || "" };
  $("payment-credit-search").value = "";
  $("payment-credit-results").hidden = true;
  $("payment-credit-results").replaceChildren();
  $("payment-credit-create").hidden = true;
  creditCustomerError("");
  renderPaymentEntry();
}
let paymentCreditSearchSeq = 0;
let paymentCreditSearchTimer = null;
async function searchPaymentCreditCustomers() {
  const input = $("payment-credit-search");
  const host = $("payment-credit-results");
  const q = input?.value.trim() || "";
  const seq = ++paymentCreditSearchSeq;
  if (!host || q.length < 2 || !creditSelectionNeeded()) {
    if (host) { host.hidden = true; host.replaceChildren(); }
    return;
  }
  try {
    const res = await api(`/v1/customers?q=${encodeURIComponent(q)}`);
    if (seq !== paymentCreditSearchSeq || input.value.trim() !== q || !$("payment-dialog")?.open) return;
    const customers = res.ok ? res.json?.customers || [] : [];
    host.innerHTML = customers.length ? customers.map((customer) =>
      `<button type="button" class="payment-credit-result" data-credit-customer-id="${escapeHtml(customer.customerId)}"><span>${escapeHtml(customer.name)}</span><small>${escapeHtml(customer.phone)}</small></button>`
    ).join("") : '<p class="muted">No matching customers</p>';
    host.hidden = false;
    host.querySelectorAll("[data-credit-customer-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const match = customers.find((x) => x.customerId === button.dataset.creditCustomerId);
        if (match) selectPaymentCreditCustomer(match);
      });
    });
  } catch { creditCustomerError("Could not search customers."); }
}
async function createPaymentCreditCustomer() {
  const btn = $("payment-credit-create-save");
  if (btn.disabled || state.payment.confirming || state.payment.uncertain) return;
  const name = $("payment-credit-new-name").value.trim();
  const phone = $("payment-credit-new-phone").value.trim();
  if (!name || !phone) { creditCustomerError("Enter customer name and phone."); return; }
  btn.disabled = true;
  creditCustomerError("");
  try {
    const res = await api("/v1/customers", { method:"POST", body:JSON.stringify({name,phone}) });
    if (res.ok && res.json?.customer) {
      selectPaymentCreditCustomer(res.json.customer);
    } else if (res.status === 409 && res.json?.customer) {
      selectPaymentCreditCustomer(res.json.customer);
    } else {
      creditCustomerError(res.json?.error || "Could not save the customer.");
    }
  } catch { creditCustomerError("Could not save the customer."); }
  finally { btn.disabled = false; }
}

function renderPaymentEntry() {
  const view = state.payment.view;
  if (!view) return;
  const mode = selectedEntryMode();
  const blocked = state.payment.confirming || state.payment.uncertain;
  $("payment-entry-fields").classList.toggle("is-single", mode !== "SPLIT");
  for (const [key, inputId] of [
    ["CASH", "payment-cash-field"], ["BANK", "payment-bank-field"], ["CREDIT", "payment-credit-field"]
  ]) {
    $(inputId).hidden = mode !== "SPLIT" && mode !== key;
  }
  document.querySelectorAll('input[name="pay-entry-mode"]').forEach((el) => { el.disabled = blocked; });
  for (const id of ["payment-cash-input", "payment-bank-input", "payment-credit-input"]) $(id).disabled = blocked;
  const amounts = paymentEntryAmounts(view);
  const remaining = Number(view.unallocatedCents ?? view.balanceCents ?? 0);
  const money = paymentMoney(view);
  const bankRequired = mode === "BANK" || (mode === "SPLIT" && (amounts?.bankCents || 0) > 0);
  $("payment-bank-fields").hidden = !bankRequired;
  const hasAccounts = (state.payment.accounts || []).some((a) => a.accountType === "OPERATIONAL" && a.isActive);
  $("payment-bank-empty").hidden = !bankRequired || hasAccounts;
  $("payment-bank-account").disabled = blocked || !hasAccounts;
  const creditRequired = Number(amounts?.creditCents || 0) > 0;
  renderCreditCustomer();
  const valid = Boolean(amounts && amounts.total > 0 && amounts.total <= remaining &&
    (!creditRequired || state.payment.creditCustomer?.customerId) &&
    (!bankRequired || (hasAccounts && $("payment-bank-account").value)));
  $("payment-remaining").textContent = amounts && amounts.total <= remaining
    ? money.format(remaining - amounts.total) : "—";
  $("payment-remaining").classList.toggle("payment-invalid", !amounts || amounts.total > remaining);
  const confirm = $("payment-confirm");
  confirm.disabled = blocked || !valid;
  confirm.hidden = remaining <= 0;
  confirm.textContent = state.payment.confirming ? "Recording…" : "Record Payment";
}

function renderPayment(view) {
  state.payment.view = view;
  const money = paymentMoney(view);
  const remaining = Number(view?.unallocatedCents ?? view?.balanceCents ?? 0);
  $("payment-order-number").textContent = view?.orderNumber ? `Order ${view.orderNumber}` : "";
  const customer = [view?.customerName || view?.creditCustomerName,
    view?.customerPhone || view?.creditCustomerPhone].filter(Boolean).join(" · ");
  $("payment-customer").textContent = customer || "No customer on this order";
  const selectedId = view?.customerId || view?.creditCustomerId;
  if (selectedId && (!state.payment.creditCustomer || state.payment.creditCustomer.customerId !== selectedId)) {
    state.payment.creditCustomer = { customerId: selectedId,
      name: view?.customerName || view?.creditCustomerName || "Customer",
      phone: view?.customerPhone || view?.creditCustomerPhone || "" };
  }
  $("payment-total").textContent = view ? money.format(view.orderTotalCents) : "—";
  $("payment-paid").textContent = view ? money.format(view.paidCents || 0) : "—";
  $("payment-credit-total").textContent = view ? money.format(view.creditCents || 0) : "—";
  $("payment-due").textContent = view ? money.format(remaining) : "—";
  const label = { PAID: "Paid", CREDIT: "Credit", PARTIAL: "Partial", UNPAID: "Unpaid" };
  const status = $("payment-status");
  status.textContent = label[view?.paymentStatus] || "Unpaid";
  status.className = `pay-status ${view?.paymentStatus === "PAID" ? "paid" : "unpaid"}`;
  $("payment-choice").hidden = remaining <= 0;
  $("payment-edit").hidden = remaining <= 0 || Boolean(view?.hasAllocations) ||
    !canEditOrders() || !(view?.orderId || state.payment.orderId);
  $("payment-renew").hidden = true;
  syncPaymentPrintChoice();
  renderPaymentEntry();
}

async function readServerPayment(orderId) {
  return api(`/v1/orders/${encodeURIComponent(orderId)}/settlements`);
}

async function openPaymentOffer(orderId) {
  if (!canReceivePayment() || !orderId) return;
  const dialog = $("payment-offer-dialog");
  if (!dialog) return;
  state.payment.orderId = orderId;
  $("payment-offer-text").textContent = "Checking payment status…";
  $("payment-offer-take").hidden = true;
  if (!dialog.open) dialog.showModal();
  void refreshPendingCount();
  const res = await readServerPayment(orderId);
  if (!dialog.open || state.payment.orderId !== orderId) return;
  if (res.status === 401) {
    dialog.close();
    showLogin("This sign-in is no longer valid.");
    return;
  }
  if (!res.ok || !res.json?.orderNumber) {
    $("payment-offer-text").textContent =
      "The order was accepted. Payment status could not be confirmed.";
    return;
  }
  const allocated = Number(res.json.unallocatedCents ?? res.json.balanceCents) <= 0;
  const who = res.json.customerName ? ` for ${res.json.customerName}` : "";
  $("payment-offer-text").textContent = allocated
    ? `Order ${res.json.orderNumber}${who}: ${res.json.paymentStatus === "PAID" ? "Paid" : "Payment allocated"}.`
    : `Order ${res.json.orderNumber}${who} was accepted. Payment is pending.`;
  $("payment-offer-take").hidden = allocated;
}

async function openTakePayment(orderId, { fromPending = false } = {}) {
  if (!canReceivePayment() || !orderId) return;
  const dialog = $("payment-dialog");
  if (!dialog) return;
  state.payment.orderId = orderId;
  state.payment.fromPending = fromPending;
  state.payment.confirming = false;
  state.payment.uncertain = false;
  state.payment.unifiedSubmission = null;
  state.payment.view = null;
  state.payment.accounts = [];
  state.payment.creditCustomer = null;
  ++paymentCreditSearchSeq;
  clearTimeout(paymentCreditSearchTimer);
  $("payment-credit-search").value = "";
  $("payment-credit-results").hidden = true;
  $("payment-credit-results").replaceChildren();
  $("payment-credit-create").hidden = true;
  creditCustomerError("");
  setPendingDrawer(false);
  const offer = $("payment-offer-dialog");
  if (offer?.open) offer.close();
  showPaymentError("");
  $("payment-order-number").textContent = "Loading order…";
  $("payment-customer").textContent = "";
  $("payment-confirm").disabled = true;
  if (!dialog.open) dialog.showModal();
  const res = await readServerPayment(orderId);
  if (!dialog.open || state.payment.orderId !== orderId) return;
  if (res.status === 401) { dialog.close(); showLogin("Session expired."); return; }
  if (!res.ok || !res.json) {
    showPaymentError(res.json?.error || "Order could not be opened.");
    $("payment-confirm").hidden = true;
    return;
  }
  state.payment.view = res.json;
  if (Number(res.json.unallocatedCents ?? res.json.balanceCents) > 0) {
    const accounts = await api("/v1/bank-accounts");
    if (!dialog.open || state.payment.orderId !== orderId) return;
    state.payment.accounts = accounts.ok ? accounts.json?.accounts || [] : [];
  }
  renderPaymentAccounts();
  renderPayment(res.json);
  resetEntryMode("CASH");
}

function showPaidPayment(view) {
  state.payment.view = view;
  state.payment.confirming = false;
  clearPaymentAttempt(view.orderId || state.payment.orderId);
  showPaymentError("");
  renderPayment(view);
  void refreshPendingCount();
}

async function confirmUnifiedPayment() {
  const orderId = state.payment.orderId;
  const view = state.payment.view;
  if (!orderId || !view || state.payment.confirming || state.payment.uncertain) return;
  const parts = paymentEntryAmounts(view);
  const remaining = Number(view.unallocatedCents ?? view.balanceCents ?? 0);
  if (!parts || parts.total <= 0 || parts.total > remaining) {
    showPaymentError("Enter a valid amount within the available balance.");
    return;
  }
  const creditCustomerId = parts.creditCents ? state.payment.creditCustomer?.customerId || "" : "";
  if (parts.creditCents && !creditCustomerId) {
    showPaymentError("Select a customer for credit.");
    $("payment-credit-search").focus();
    return;
  }
  const bankAccountId = parts.bankCents ? $("payment-bank-account").value : "";
  if (parts.bankCents && !bankAccountId) {
    showPaymentError("Select an operational bank account.");
    return;
  }
  state.payment.confirming = true;
  renderPaymentEntry();
  showPaymentError("");
  try {
    // Always read the authoritative balance immediately before posting.
    const fresh = await readServerPayment(orderId);
    if (fresh.status === 401) { $("payment-dialog")?.close(); showLogin("Session expired."); return; }
    if (!fresh.ok || !fresh.json) {
      showPaymentError("Could not verify the order. Nothing was recorded.");
      return;
    }
    if (Number(fresh.json.unallocatedCents ?? fresh.json.balanceCents) !== remaining ||
        fresh.json.currencyCode !== view.currencyCode ||
        fresh.json.orderTotalCents !== view.orderTotalCents) {
      state.payment.view = fresh.json;
      showPaymentError("Order balance changed. Review the payment before continuing.");
      renderPayment(fresh.json);
      resetEntryMode("CASH");
      return;
    }
    // Keep one submission ID for retries. Never silently resubmit with another ID.
    const signature = JSON.stringify([parts.cashCents, parts.bankCents, parts.creditCents, bankAccountId, creditCustomerId, view.currencyCode]);
    const previous = state.payment.unifiedSubmission;
    if (previous && previous.signature !== signature) {
      showPaymentError("Reopen this order before changing a pending payment.");
      state.payment.uncertain = true;
      return;
    }
    const submission = previous || { id: newSubmissionId(), signature };
    state.payment.unifiedSubmission = submission;
    let result;
    try {
      result = await api(`/v1/orders/${encodeURIComponent(orderId)}/payment-allocations`, {
        method: "POST",
        body: JSON.stringify({ submissionId: submission.id,
          cashCents: parts.cashCents, bankCents: parts.bankCents,
          creditCents: parts.creditCents, bankAccountId: bankAccountId || undefined,
          creditCustomerId: creditCustomerId || undefined,
          currencyCode: view.currencyCode,
          printCashier: wantCashierPrint() })
      });
    } catch {
      // A timeout can mean the server already committed. Lock editing, allow only same-ID retry.
      state.payment.uncertain = true;
      showPaymentError("Connection interrupted. Reopen the order to check the payment before retrying.");
      return;
    }
    if (!result.ok) {
      if (result.status === 401) { $("payment-dialog")?.close(); showLogin("Session expired."); return; }
      showPaymentError(result.json?.error || "Payment was not recorded.");
      if ([409, 500, 503].includes(result.status)) state.payment.uncertain = true;
      else state.payment.unifiedSubmission = null; // proven rejected input, no commit
      return;
    }
    state.payment.unifiedSubmission = null;
    const cashierPrint = result.json?.cashierPrint;
    if (cashierPrint && cashierPrint.ok === false) {
      showPaymentError(
        `Payment recorded, but cashier receipt was not queued: ${cashierPrint.error || "printer missing"}. Assign a printer to CASHIER (or keep an active NETWORK printer).`
      );
    }
    const updated = await readServerPayment(orderId);
    if (!updated.ok || !updated.json) {
      state.payment.uncertain = true;
      showPaymentError("Recorded. Reopen this order to refresh the balance.");
      return;
    }
    renderPayment(updated.json);
    resetEntryMode("CASH");
    void refreshPendingCount();
    if (!(cashierPrint && cashierPrint.ok === false)) showPaymentError("");
  } finally {
    state.payment.confirming = false;
    if (state.payment.view) renderPaymentEntry();
  }
}

async function recoverUncertainPayment(orderId, err, serverError) {
  let status = null;
  try {
    status = await readServerPayment(orderId);
  } catch {
    status = null;
  }
  if (status?.ok && status.json?.paymentStatus === "PAID") {
    showPaidPayment(status.json);
    return;
  }
  const code = serverError?.code || "";
  if (code === "ALREADY_PAID") {
    showPaymentError("This order is already paid. The status could not be reloaded. It was not paid again.");
    return;
  }
  if (code === "SUBMISSION_CONFLICT") {
    showPaymentError("This confirmation does not match the earlier payment attempt. The order was not paid again.");
    if (status?.ok && status.json?.paymentStatus !== "PAID") {
      state.payment.view = status.json;
      renderPayment(status.json);
      $("payment-renew").hidden = false;
    }
    return;
  }
  if (code === "PAYMENT_IN_PROGRESS" || code === "PAYMENT_CONFLICT") {
    showPaymentError(serverError.error || "This payment could not be confirmed. Check the order before trying again.");
    return;
  }
  showPaymentError(
    status?.ok
      ? "The payment was not confirmed. This order is still unpaid. You can confirm again."
      : "The payment was not confirmed. Check the connection, then confirm again. Do not treat this order as paid."
  );
  if (err) return;
}

async function renewPaymentAttempt() {
  const orderId = state.payment.orderId;
  if (!orderId || state.payment.confirming) return;
  const status = await readServerPayment(orderId);
  if (!status.ok || status.json?.paymentStatus === "PAID") {
    if (status.json?.paymentStatus === "PAID") showPaidPayment(status.json);
    else showPaymentError(status.json?.error || "Payment status could not be confirmed.");
    return;
  }
  clearPaymentAttempt(orderId);
  ensurePaymentAttempt(orderId, status.json);
  state.payment.view = status.json;
  renderPayment(status.json);
  showPaymentError("A new confirmation is ready. Confirm payment when the amount is correct.");
}

async function refreshPendingCount() {
  const btn = $("pending-payments-btn");
  if (!btn) return;
  if (!canReceivePayment()) {
    btn.hidden = true;
    setPendingDrawer(false);
    return;
  }
  btn.hidden = false;
  const res = await api("/v1/pending-payments");
  if (!res.ok) return;
  const count = (res.json?.orders || []).length;
  const badge = $("pending-payments-count");
  if (badge) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
}

function pendingQuery() {
  return ($("pending-search")?.value || "").trim().toLowerCase();
}

function orderMatchesPendingSearch(order, query) {
  if (!query) return true;
  const haystack = [order.orderNumber, order.customerName, order.customerPhone]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function renderPendingOrders() {
  const list = $("pending-payments-list");
  if (!list) return;
  const orders = state.pendingOrders;
  const query = pendingQuery();
  const matched = orders.filter((order) => orderMatchesPendingSearch(order, query));
  if (!orders.length) {
    list.innerHTML = `<p class="muted">No unpaid orders.</p>`;
    return;
  }
  if (!matched.length) {
    list.innerHTML = `<p class="muted">No unpaid orders match that search.</p>`;
    return;
  }
  list.innerHTML = matched
    .map((order) => {
      const money = paymentMoney(order);
      const customer = [order.customerName, order.customerPhone].filter(Boolean).join(" · ");
      return `<article class="pending-payment-card">
        <div>
          <strong>${escapeHtml(order.orderNumber || "")}</strong>
          <span class="pay-status unpaid">Unpaid</span>
        </div>
        <p>${escapeHtml(customer || "No customer on this order")}</p>
        <p class="pending-payment-due">${escapeHtml(money.format(order.balanceCents))}</p>
        <button type="button" class="btn primary" data-pay-order="${escapeHtml(order.orderId)}">Take Payment</button>
      </article>`;
    })
    .join("");
}

async function openPendingPayments() {
  if (!canReceivePayment()) return;
  setPendingDrawer(true);
  const list = $("pending-payments-list");
  list.innerHTML = `<p class="muted">Loading unpaid orders…</p>`;
  const res = await api("/v1/pending-payments");
  if (res.status === 401) {
    setPendingDrawer(false);
    showLogin("This sign-in is no longer valid.");
    return;
  }
  if (!res.ok) {
    state.pendingOrders = [];
    list.innerHTML = `<p class="error">${escapeHtml(res.json?.error || "Unpaid orders could not be loaded.")}</p>`;
    return;
  }
  const orders = res.json?.orders || [];
  state.pendingOrders = orders;
  const badge = $("pending-payments-count");
  if (badge) {
    badge.textContent = String(orders.length);
    badge.hidden = orders.length === 0;
  }
  renderPendingOrders();
}

function bindUi() {
  try {
    state.virtualKeyboardOn = localStorage.getItem("gtct.virtualKeyboard") !== "0";
  } catch {
    state.virtualKeyboardOn = true;
  }
  // Phones already have their own keyboard; the on-screen POS keyboard would cover it.
  if (window.matchMedia?.("(max-width: 599px)").matches) state.virtualKeyboardOn = false;
  state.virtualKeyboard = initVirtualKeyboard({ enabled: state.virtualKeyboardOn });
  document.body.classList.toggle("vk-enabled", state.virtualKeyboardOn);

  $("login-btn").addEventListener("click", (e) => {
    e.preventDefault();
    login();
  });
  for (const id of ["login-username", "login-password"]) {
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        login();
      }
    });
    $(id).addEventListener("input", () => setLoginError(""));
  }
  $("toggle-password-btn").addEventListener("click", () => {
    const input = $("login-password");
    const btn = $("toggle-password-btn");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.setAttribute("aria-pressed", show ? "true" : "false");
    input.focus();
  });
  $("logout-btn").addEventListener("click", () => {
    setNavMenu(false);
    logout();
  });
  $("menu-search").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderMenu();
  });
  $("caller-id-btn")?.addEventListener("click", () => {
    openCallerIdDialog(state.callerPayload);
  });
  $("caller-id-close")?.addEventListener("click", () => closeCallerIdDialog());
  $("caller-id-dismiss")?.addEventListener("click", () => void dismissCallerId());
  $("caller-id-lookup-btn")?.addEventListener("click", () => void lookupCallerFromInput());
  $("caller-id-use")?.addEventListener("click", () => void useCallerOnOrder());
  $("caller-id-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void lookupCallerFromInput();
    }
  });
  const salesViewportMq = window.matchMedia("(max-width: 1023px)");
  const onSalesViewportChange = () => syncSalesViewForViewport();
  if (salesViewportMq.addEventListener) {
    salesViewportMq.addEventListener("change", onSalesViewportChange);
  } else if (salesViewportMq.addListener) {
    salesViewportMq.addListener(onSalesViewportChange);
  }
  $("nav-print-jobs-btn")?.addEventListener("click", () => {
    setNavMenu(false);
    const open = $("print-jobs-drawer")?.hidden !== false;
    setPrintDrawer(open);
    if (open) refreshJobs({ quiet: true });
  });
  $("clear-cart-btn").addEventListener("click", () => {
    const wasEditing = Boolean(state.editingOrderId);
    if (!cartHasItems() && !wasEditing && !fulfillmentHasDetails()) return;
    if (!window.confirm("Clear this order, including the customer and address?")) return;
    hideCartUndo();
    if ($("review-dialog")?.open) $("review-dialog").close();
    emptyCart({ status: "Cart cleared." });
    resetFulfillmentForNewOrder();
    renderMenu();
    if (wasEditing) void ensureDraftIdentity({ fresh: true });
  });
  $("cart-undo-btn")?.addEventListener("click", () => undoCartRemove());
  $("cart-lines")?.addEventListener("scroll", onCartLinesScroll, {
    passive: true,
  });
  const reviewBtn = $("review-btn") || $("review-order-btn");
  reviewBtn?.addEventListener("click", openReview);
  $("review-cancel").addEventListener("click", () => $("review-dialog").close());
  $("review-body")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act='edit']");
    if (!btn || !$("review-body").contains(btn)) return;
    const lineId = btn.closest("[data-line-id]")?.dataset.lineId;
    if (!lineId) return;
    editReviewLine(lineId, btn);
  });
  $("review-meta")?.addEventListener("click", (e) => {
    if (e.target.closest("#review-edit-customer")) {
      if (!state.fulfillment.customerId) return;
      openCustomerDialog("edit");
      return;
    }
    if (e.target.closest("#review-change-customer")) {
      openAddressPicker("customer");
    }
  });
  $("review-print-kitchen")?.addEventListener("change", () => {
    $("review-print-kitchen").dataset.userTouched = "1";
  });
  $("review-print-cashier")?.addEventListener("change", () => {
    $("review-print-cashier").dataset.userTouched = "1";
  });
  $("payment-print-cashier")?.addEventListener("change", () => {
    $("payment-print-cashier").dataset.userTouched = "1";
  });
  $("review-confirm").addEventListener("click", sendTestOrder);
  $("pending-payments-btn")?.addEventListener("click", () => {
    setNavMenu(false);
    void openPendingPayments();
  });
  $("shift-menu-close")?.addEventListener("click", () => closeShiftMenu());
  $("shift-open-btn")?.addEventListener("click", () => openShiftDialog("open"));
  $("shift-change-btn")?.addEventListener("click", () => openShiftDialog("change"));
  $("shift-close-btn")?.addEventListener("click", () => {
    void closeBusinessShiftFlow();
  });
  $("shift-dialog-cancel")?.addEventListener("click", () => closeShiftDialog());
  $("shift-dialog-x")?.addEventListener("click", () => closeShiftDialog());
  $("shift-dialog-confirm")?.addEventListener("click", () => {
    void confirmShiftDialog();
  });
  $("shift-dialog")?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeShiftDialog();
  });
  $("pending-payments-close")?.addEventListener("click", () => setPendingDrawer(false));
  $("pending-search")?.addEventListener("input", () => {
    if (state.pendingOrders) renderPendingOrders();
  });
  $("pending-backdrop")?.addEventListener("click", () => setPendingDrawer(false));
  $("pending-payments-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-pay-order]");
    if (!button) return;
    void openTakePayment(button.dataset.payOrder, { fromPending: true });
  });
  $("payment-offer-later")?.addEventListener("click", () => $("payment-offer-dialog")?.close());
  $("payment-offer-take")?.addEventListener("click", () => {
    const orderId = state.payment.orderId;
    if (orderId) void openTakePayment(orderId);
  });
  $("payment-edit")?.addEventListener("click", () => {
    const orderId = state.payment.orderId;
    if (!orderId) return;
    void beginEdit(orderId);
  });
  $("payment-back")?.addEventListener("click", () => {
    $("payment-dialog")?.close();
    if (state.payment.fromPending) void openPendingPayments();
  });
  $("payment-confirm")?.addEventListener("click", () => {
    void confirmUnifiedPayment();
  });
  document.querySelectorAll('input[name="pay-entry-mode"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (!state.payment.confirming && !state.payment.uncertain) resetEntryMode(input.value);
    });
  });
  for (const id of ["payment-cash-input", "payment-bank-input", "payment-credit-input"]) {
    $(id)?.addEventListener("input", () => {
      if (!state.payment.confirming && !state.payment.uncertain) renderPaymentEntry();
    });
  }
  $("payment-bank-account")?.addEventListener("change", () => renderPaymentEntry());
  $("payment-credit-search")?.addEventListener("input", () => {
    clearTimeout(paymentCreditSearchTimer);
    paymentCreditSearchTimer = setTimeout(searchPaymentCreditCustomers, 200);
  });
  $("payment-credit-change")?.addEventListener("click", () => {
    if (state.payment.confirming || state.payment.uncertain || (state.payment.view?.customerId || state.payment.view?.creditCustomerId)) return;
    state.payment.creditCustomer = null;
    renderPaymentEntry();
    $("payment-credit-search").focus();
  });
  $("payment-credit-create-toggle")?.addEventListener("click", () => {
    const box = $("payment-credit-create");
    box.hidden = !box.hidden;
    if (!box.hidden) $("payment-credit-new-name").focus();
  });
  $("payment-credit-create-save")?.addEventListener("click", () => void createPaymentCreditCustomer());
  $("payment-renew")?.addEventListener("click", () => {
    void renewPaymentAttempt();
  });
  $("refresh-jobs-btn").addEventListener("click", refreshJobs);
  $("split-bar")?.addEventListener("click", (e) => {
    const remove = e.target.closest("[data-split-remove]");
    if (remove) {
      const n = Number(remove.dataset.splitRemove);
      if (linesForSplit(n).length) return;
      if (lineSplitNo({ splitNo: state.activeSplit }) === n) {
        const rest = splitIds().filter((id) => id !== n);
        state.activeSplit = rest[rest.length - 1] || 1;
      }
      renderCart();
      return;
    }
    if (e.target.closest("[data-split-add]")) {
      addSplitOrder();
      return;
    }
    const pick = e.target.closest("[data-split]");
    if (!pick) return;
    const n = lineSplitNo({ splitNo: Number(pick.dataset.split) });
    state.activeSplit = n;
    state._scrollToSplitAfterRender = linesForSplit(n).length ? n : null;
    renderCart();
  });
  $("new-order-btn")?.addEventListener("click", () => {
    if (cartHasItems() && !confirmLeaveCart("Start a new order")) return;
    state.lastOrderId = null;
    state.submissionId = "";
    state.orderNumber = "";
    emptyCart({ status: "New test order number ready." });
    resetFulfillmentForNewOrder();
    void ensureDraftIdentity({ fresh: true });
    refreshJobs();
  });
  $("hold-cart-btn")?.addEventListener("click", holdActiveCart);
  $("hold-confirm-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    confirmHoldCart();
  });
  $("hold-cancel-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    closeHoldDialog();
  });
  $("hold-label-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmHoldCart();
    }
  });
  $("hold-dialog")?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeHoldDialog();
  });
  $("cust-cancel")?.addEventListener("click", closeCustomerDialog);
  $("cust-save")?.addEventListener("click", () => {
    if (state._customerMode === "extra") saveExtraAddressFromCustomerDialog();
    else saveNewCustomer();
  });
  $("cust-save-another")?.addEventListener("click", () => {
    if (state._customerMode === "extra") return;
    saveNewCustomer({ another: true });
  });
  $("cust-use-existing")?.addEventListener("click", () => {
    const existing = state._dupCustomer;
    closeCustomerDialog();
    if (existing) selectCustomer(existing);
  });
  $("customer-dialog")?.addEventListener("close", () => {
    const err = $("cust-error");
    if (err) err.hidden = true;
    if (state._completingCustomerGate) return;
    if (state._resumeReviewAfterCustomer && deliveryMissingCustomerContact()) {
      void openDeliveryCustomerGate();
      return;
    }
    if (state._resumeReviewAfterCustomer && !deliveryMissingCustomerContact()) {
      void maybeResumeReviewAfterCustomerGate();
    }
  });
  $("addr-cancel")?.addEventListener("click", closeAddressDialog);
  $("addr-save")?.addEventListener("click", () => {
    saveAddressEditor();
  });
  $("picker-cust-search")?.addEventListener("input", schedulePickerSearch);
  $("picker-show-customer")?.addEventListener("click", () => {
    $("address-picker-dialog")?.classList.add("show-customer-search");
    $("picker-cust-search")?.focus();
  });
  $("picker-new-customer")?.addEventListener("click", () => {
    state._openingNestedCustomerDialog = true;
    $("address-picker-dialog")?.close();
    openCustomerDialog("create");
  });
  $("picker-phone-cancel")?.addEventListener("click", () => {
    hidePickerPhonePrompt();
    $("picker-cust-search")?.focus();
  });
  $("picker-phone-save")?.addEventListener("click", () => {
    void confirmPendingCustomerPhone();
  });
  $("picker-phone-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void confirmPendingCustomerPhone();
    }
  });
  $("address-picker-cancel")?.addEventListener("click", () => $("address-picker-dialog")?.close());
  $("address-picker-clear")?.addEventListener("click", () => {
    $("address-picker-dialog")?.close();
    clearSelectedCustomer();
  });
  $("address-picker-add")?.addEventListener("click", () => {
    state._openingNestedCustomerDialog = true;
    $("address-picker-dialog")?.close();
    openAddressEditor(null);
  });
  $("address-picker-adjust")?.addEventListener("click", () => {
    state._openingNestedCustomerDialog = true;
    $("address-picker-dialog")?.close();
    openOrderAddressDialog();
  });
  $("address-picker-dialog")?.addEventListener("close", () => {
    hidePickerPhonePrompt();
    if (state._completingCustomerGate || state._openingNestedCustomerDialog) {
      state._openingNestedCustomerDialog = false;
      return;
    }
    if (state._resumeReviewAfterCustomer) {
      state._resumeReviewAfterCustomer = false;
      focusReviewSendButton();
    }
  });
  $("order-addr-cancel")?.addEventListener("click", () => $("order-address-dialog")?.close());
  $("order-addr-apply")?.addEventListener("click", () => {
    state.fulfillment.buildingNumber = $("order-addr-building")?.value.trim() || "";
    state.fulfillment.roadNumber = $("order-addr-road")?.value.trim() || "";
    state.fulfillment.addressNote = $("order-addr-note")?.value.trim() || "";
    $("order-address-dialog")?.close();
    renderFulfillmentFields();
    renderCart();
    persistActiveCart();
  });
  $("order-type")?.addEventListener("change", () => {
    renderFulfillmentFields();
    refreshFulfillmentValidationUi();
    renderCart();
    persistActiveCart();
  });
  document.querySelectorAll("#app-nav a.nav-link[href], #app-nav a.nav-dropdown-link[href]").forEach((link) => {
    link.addEventListener("click", () => {
      persistActiveCart();
      setNavMenu(false);
      closeNavPops();
    });
  });
  document.querySelectorAll("#app-nav details.nav-pop").forEach((panel) => {
    panel.addEventListener("toggle", () => {
      if (!panel.open) return;
      document.querySelectorAll("#app-nav details.nav-pop").forEach((other) => {
        if (other !== panel) other.open = false;
      });
    });
  });
  document.addEventListener("pointerdown", (event) => {
    const nav = $("app-nav");
    if (!nav || nav.contains(event.target)) return;
    closeNavPops();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeNavPops();
  });
  $("customize-qty-dec")?.addEventListener("click", () => changeCustomizeQty(-1));
  $("customize-qty-inc")?.addEventListener("click", () => changeCustomizeQty(1));
  $("customize-qty")?.addEventListener("input", onCustomizeQtyInput);
  $("customize-qty")?.addEventListener("blur", () => commitCustomizeQty());
  $("customize-qty")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCustomizeQty();
      e.target.blur();
    }
  });
  $("customize-unit-price")?.addEventListener("input", onCustomizeUnitPriceInput);
  $("customize-unit-price")?.addEventListener("focus", (e) => {
    if (!state.canAdjustBasePrices) return;
    e.target.select();
  });
  $("customize-unit-price")?.addEventListener("blur", () =>
    commitCustomizeUnitPrice()
  );
  $("customize-unit-price")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCustomizeUnitPrice();
      e.target.blur();
    }
  });
  $("customize-price-reset")?.addEventListener("click", resetCustomizeUnitPrice);
  $("kitchen-step-back")?.addEventListener("click", () => {
    state.selectedMod = null;
    state.selectedTargets = [];
    setKitchenStep(1);
    showInstrFeedback("");
  });
  $("kitchen-targets-ok")?.addEventListener("click", () => {
    addInstruction();
  });
  $("tab-notes")?.addEventListener("click", () => setCustomizeTab("notes"));
  $("tab-extras")?.addEventListener("click", () => setCustomizeTab("extras"));
  $("customize-price-breakdown")?.addEventListener("toggle", () => {
    state.priceBreakdownOpen = Boolean($("customize-price-breakdown")?.open);
    updatePriceSummary();
  });
  $("cart-tax-summary")?.addEventListener("click", (event) => {
    const button = event.target.closest("#cart-price-breakdown-toggle");
    if (!button) return;
    state.cartPriceBreakdownOpen = !state.cartPriceBreakdownOpen;
    const detail = $("cart-price-breakdown");
    if (detail) detail.hidden = !state.cartPriceBreakdownOpen;
    button.textContent = state.cartPriceBreakdownOpen
      ? "Hide breakdown"
      : "Price breakdown";
    button.setAttribute("aria-expanded", String(state.cartPriceBreakdownOpen));
  });
  $("instr-form")?.addEventListener("submit", (e) => {
    // Keep method=dialog for semantics, but never auto-close via implicit submit.
    e.preventDefault();
  });
  $("customize-apply-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    applyCustomization();
  });
  $("customize-cancel-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    cancelCustomization();
  });
  $("instr-dialog")?.addEventListener("cancel", (e) => {
    e.preventDefault();
    cancelCustomization();
  });
  $("instr-dialog")?.addEventListener("close", () => {
    document.body.classList.remove("customize-open");
  });
  // Guard against the opening pointer event dismissing the dialog in some browsers.
  $("instr-dialog")?.addEventListener("click", (e) => {
    if (e.target === $("instr-dialog")) e.stopPropagation();
  });
  $("custom-note")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      syncOrderNoteFromInput();
    }
  });
  $("custom-note")?.addEventListener("input", syncOrderNoteFromInput);
  $("preview-close")?.addEventListener("click", () => {
    $("preview-dialog").close();
  });
  $("variant-close-btn")?.addEventListener("click", closeVariantPicker);
  $("pk-close-btn")?.addEventListener("click", closeProductKnowledge);
  $("pk-dialog")?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeProductKnowledge();
  });
  $("pk-dialog")?.addEventListener("close", () => {
    state.pkItem = null;
    state.pkPayload = null;
  });
  document.querySelectorAll(".pk-tab").forEach((btn) => {
    btn.addEventListener("click", () => setPkTab(btn.dataset.pkTab));
  });
  $("variant-dialog")?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeVariantPicker();
  });
  $("print-jobs-btn")?.addEventListener("click", () => {
    const open = $("print-jobs-drawer")?.hidden !== false;
    setPrintDrawer(open);
    if (open) refreshJobs({ quiet: true });
  });
  $("print-jobs-close")?.addEventListener("click", () => setPrintDrawer(false));
  $("print-jobs-backdrop")?.addEventListener("click", () => setPrintDrawer(false));
  $("mobile-cart-bar")?.addEventListener("click", () => {
    setNavMenu(false);
    if (!cartHasItems()) return;
    void openReview();
  });
  $("close-cart-drawer")?.addEventListener("click", () => setCartDrawer(false));
  $("cart-add-more-items")?.addEventListener("click", () => setCartDrawer(false));
  $("cart-drawer-backdrop")?.addEventListener("click", () => setCartDrawer(false));
  $("nav-menu-btn")?.addEventListener("click", () => {
    setNavMenu(!state.navMenuOpen);
  });
  $("nav-menu-backdrop")?.addEventListener("click", () => setNavMenu(false));
  $("app-nav")?.addEventListener("click", (e) => {
    const t = e.target;
    if (t && (t.matches("a.nav-link") || t.closest("a.nav-link"))) {
      setNavMenu(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("print-jobs-drawer")?.hidden) {
      e.preventDefault();
      setPrintDrawer(false);
      return;
    }
    if (state.navMenuOpen) {
      e.preventDefault();
      setNavMenu(false);
      return;
    }
    if (
      state.cartDrawerOpen &&
      !$("review-dialog")?.open &&
      !$("instr-dialog")?.open &&
      !$("variant-dialog")?.open &&
      !$("pk-dialog")?.open
    ) {
      e.preventDefault();
      setCartDrawer(false);
    }
  });
  window.addEventListener("resize", () => {
    if (!isMobileSalesLayout()) {
      if (state.navMenuOpen) setNavMenu(false);
      if (state.cartDrawerOpen) setCartDrawer(false);
    }
    syncScrollLock();
  });
}

function isMobileSalesLayout() {
  return window.matchMedia("(max-width: 1023px)").matches;
}

function lockPageScroll(lock) {
  if (lock) {
    if (document.body.classList.contains("page-scroll-lock")) return;
    state._scrollLockY = window.scrollY || 0;
    document.body.classList.add("page-scroll-lock");
    document.body.style.top = `-${state._scrollLockY}px`;
  } else {
    if (!document.body.classList.contains("page-scroll-lock")) return;
    document.body.classList.remove("page-scroll-lock");
    document.body.style.top = "";
    window.scrollTo(0, state._scrollLockY || 0);
  }
}

function syncScrollLock() {
  const shouldLock =
    isMobileSalesLayout() && (state.cartDrawerOpen || state.navMenuOpen);
  lockPageScroll(shouldLock);
}

function closeNavPops() {
  document.querySelectorAll("#app-nav details.nav-pop").forEach((panel) => {
    panel.open = false;
  });
}

function setNavMenu(open) {
  const next = Boolean(open);
  const btn = $("nav-menu-btn");
  const backdrop = $("nav-menu-backdrop");
  if (next && !state.navMenuOpen) {
    state._navTrigger = document.activeElement;
  }
  state.navMenuOpen = next;
  document.body.classList.toggle("nav-menu-open", next);
  if (!next) closeNavPops();
  if (btn) {
    btn.setAttribute("aria-expanded", next ? "true" : "false");
    btn.setAttribute("aria-label", next ? "Close navigation menu" : "Open navigation menu");
  }
  if (backdrop) backdrop.hidden = !next;
  syncScrollLock();
  if (next) {
    const first = $("app-nav")?.querySelector(
      ".nav-primary a.nav-link:not([hidden]), .nav-icon-btn, .nav-account-btn"
    );
    first?.focus();
  } else if (state._navTrigger?.focus) {
    state._navTrigger.focus();
    state._navTrigger = null;
  }
}

function setCartDrawer(open) {
  const next = Boolean(open) && isMobileSalesLayout();
  if (next && !state.cartDrawerOpen) {
    state._cartTrigger = document.activeElement;
  }
  state.cartDrawerOpen = next;
  document.body.classList.toggle("cart-drawer-open", next);
  const backdrop = $("cart-drawer-backdrop");
  const closeBtn = $("close-cart-drawer");
  if (backdrop) backdrop.hidden = !next;
  if (closeBtn) closeBtn.hidden = !next;
  syncScrollLock();
  if (next) {
    closeBtn?.focus();
  } else if (state._cartTrigger?.focus) {
    state._cartTrigger.focus();
    state._cartTrigger = null;
  }
}

function revealSalesMenuTop() {
  const grid = $("menu-grid");
  if (grid) grid.scrollTop = 0;
  const workspace = document.querySelector(".sales-app .workspace");
  if (workspace) workspace.scrollTop = 0;
  const pane = $("menu-pane");
  if (pane) pane.scrollTop = 0;
  requestAnimationFrame(() => {
    if (grid) grid.scrollTop = 0;
  });
}

function applySalesView() {
  document.body.classList.remove("sales-density-compact", "sales-hide-photos");
}

async function init() {
  registerPwa();
  state.salesView = readSalesViewPrefs();
  applySalesView();
  bindUi();
  const ok = await ensureSession();
  if (ok) await bootstrapData();
}

init();
