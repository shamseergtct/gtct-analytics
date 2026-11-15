import { createMoneyFormatter } from "./money.js";

const AVAIL = [
  { id: "ALL", label: "All" },
  { id: "AVAILABLE", label: "Available" },
  { id: "SOLD_OUT", label: "Sold out" },
  { id: "INACTIVE", label: "Inactive" },
];

const state = {
  role: null,
  items: [],
  stations: [],
  categories: [],
  subcategoriesByCategory: {},
  shop: null,
  money: createMoneyFormatter({ currencyLabel: "QR", currencyDecimals: 2 }),
  tab: "items",
  availFilter: "ALL",
  categoryFilter: "ALL",
  subcategoryFilter: "ALL",
  search: "",
  selectedId: null,
  editorOpen: false,
  editorTab: "basic",
  _editorTrigger: null,
  dirty: false,
  formDirty: false,
  photoDraft: { savedUrl: "", file: null, objectUrl: "", remove: false },
  saving: false,
  formStatus: "active",
  instructionCustomized: false,
  selectedModIds: new Set(),
  selectedTargetIds: new Set(),
  selectedStandIds: new Set(),
  addonAssignments: new Map(), // addonId -> { enabled, overrideText }
  /** @type {Array<{variantId:string,name:string,priceText:string,sku:string,code:string,sortOrder:number,isActive:boolean,isSoldOut:boolean,isDefault:boolean}>} */
  formVariants: [],
  /** @type {string[]} */
  formIngredients: [],
  kitchenLibrary: { modifiers: [], targets: [], standalone: [] },
  addons: [],
  libTab: "modifiers",
  libSearch: "",
  libShowInactive: false,
  addonSearch: "",
  addonShowInactive: false,
  expandedCats: new Set(),
  editingCatId: null,
  editingSubId: null,
  dataCleaning: null,
  dataCleaningBusy: false,
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

function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toast(message, isError = false) {
  const el = $("toast");
  el.hidden = false;
  el.textContent = message;
  el.className = `toast${isError ? " error" : ""}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, isError ? 5200 : 3200);
}

async function downloadCsv(path, fallbackName) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "text/csv,application/json" },
  });
  if (res.status === 401) {
    showLogin("Session expired.");
    return;
  }
  if (!res.ok) {
    let message = "Download failed";
    try {
      const json = await res.json();
      message = json.error || message;
    } catch {
      /* ignore */
    }
    toast(message, true);
    return;
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const match = /filename="([^"]+)"/i.exec(disposition);
  const filename = match?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportMenuItems() {
  await downloadCsv(
    "/v1/menu-items/export.csv",
    `menu-items-${new Date().toISOString().slice(0, 10)}.csv`
  );
}

async function downloadImportTemplate() {
  await downloadCsv(
    "/v1/menu-items/import-template.csv",
    "menu-items-template.csv"
  );
}

async function importMenuItemsFile(file) {
  if (!file) return;
  const csv = await file.text();
  if (!csv.trim()) {
    toast("File is empty", true);
    return;
  }
  const res = await api("/v1/menu-items/import", {
    method: "POST",
    body: JSON.stringify({ csv }),
  });
  if (res.status === 401) {
    showLogin("Session expired.");
    return;
  }
  const summary = res.json?.summary;
  if (!res.ok && !summary) {
    toast(res.json?.error || "Import failed", true);
    return;
  }
  const created = summary?.created || 0;
  const updated = summary?.updated || 0;
  const errors = summary?.errors || res.json?.errors || [];
  await loadAll();
  if (errors.length) {
    toast(
      `Imported ${created} new, ${updated} updated. ${errors.length} row issue(s): ${errors[0]}`,
      true
    );
  } else {
    toast(`Imported ${created} new, updated ${updated}.`);
  }
}

function stationLabel(item) {
  if (!item.stationIds?.length) return "— NONE";
  const map = Object.fromEntries(state.stations.map((s) => [s.station_id, s.name]));
  return item.stationIds.map((id) => map[id] || id).join(", ");
}

function statusLabel(item) {
  if (!item.is_active) return { key: "inactive", text: "Inactive" };
  if (item.is_sold_out) return { key: "sold_out", text: "Sold out" };
  return { key: "active", text: "Active" };
}

function photoPending() {
  return Boolean(state.photoDraft?.file || state.photoDraft?.remove);
}

function syncDirty() {
  state.dirty = Boolean(state.formDirty || photoPending());
}

function markDirty() {
  state.formDirty = true;
  syncDirty();
}

function clearDirty() {
  state.formDirty = false;
  syncDirty();
}

function confirmLeaveEditor() {
  if (!state.dirty) return true;
  return window.confirm("Discard unsaved changes?");
}

function showLogin(msg = "") {
  $("login-view").hidden = false;
  $("main-view").hidden = true;
  const el = $("login-error");
  el.hidden = !msg;
  el.textContent = msg;
}

function showMain() {
  $("login-view").hidden = true;
  $("main-view").hidden = false;
  $("session-role").textContent = state.role || "";
  const admin = state.role === "admin";
  $("device-block").hidden = admin;
  $("admin-shell").hidden = !admin;
}

async function ensureSession() {
  const me = await api("/v1/session/me");
  if (!me.ok || !me.json?.authenticated) {
    showLogin();
    return false;
  }
  state.role = me.json.role;
  showMain();
  return true;
}

async function login() {
  const username = String($("login-username").value || "").trim();
  const password = String($("login-password").value || "");
  if (!username || !password) {
    showLogin("Enter your username and password.");
    return;
  }
  const btn = $("login-btn");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  btn.setAttribute("aria-busy", "true");
  showLogin("");
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
    const me = await api("/v1/session/me");
    state.role = me.json?.role || res.json.role;
    showMain();
    await bootstrap();
  } catch (err) {
    showLogin(err.message || "Sign-in failed");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
    btn.removeAttribute("aria-busy");
  }
}

async function logout() {
  await api("/v1/session/logout", { method: "POST", body: "{}" });
  state.role = null;
  showLogin();
}

function setTab(tab) {
  if (state.editorOpen && tab !== "items" && !confirmLeaveEditor()) return;
  if (tab !== "items") closeEditor(true);
  state.tab = tab;
  document.querySelectorAll(".ms-tabs > .ms-tab[data-tab]").forEach((btn) => {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  $("panel-items").hidden = tab !== "items";
  $("panel-categories").hidden = tab !== "categories";
  $("panel-notes").hidden = tab !== "notes";
  if ($("panel-addons")) $("panel-addons").hidden = tab !== "addons";
  if (tab === "notes") renderKitchenLibrary();
  if (tab === "addons") renderAddonsLibrary();
}

function filteredItems() {
  const q = state.search.trim().toLowerCase();
  return state.items.filter((item) => {
    if (state.availFilter === "AVAILABLE" && (!item.is_active || item.is_sold_out)) {
      return false;
    }
    if (state.availFilter === "SOLD_OUT" && !item.is_sold_out) return false;
    if (state.availFilter === "INACTIVE" && item.is_active) return false;
    if (state.categoryFilter !== "ALL" && item.category_id !== state.categoryFilter) {
      return false;
    }
    if (
      state.subcategoryFilter !== "ALL" &&
      item.subcategory_id !== state.subcategoryFilter
    ) {
      return false;
    }
    if (!q) return true;
    const hay = [item.name, item.sku || "", item.code || ""].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function renderAvailFilters() {
  const host = $("avail-filters");
  host.innerHTML = "";
  for (const f of AVAIL) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ms-chip${state.availFilter === f.id ? " active" : ""}`;
    btn.textContent = f.label;
    btn.addEventListener("click", () => {
      state.availFilter = f.id;
      renderAvailFilters();
      renderItemList();
    });
    host.appendChild(btn);
  }
}

function renderFilterSelects() {
  const cat = $("filter-category");
  const sub = $("filter-subcategory");
  const catVal = state.categoryFilter;
  const subVal = state.subcategoryFilter;
  cat.innerHTML = `<option value="ALL">All categories</option>`;
  for (const c of state.categories.filter((x) => x.is_active)) {
    const opt = document.createElement("option");
    opt.value = c.category_id;
    opt.textContent = c.name;
    cat.appendChild(opt);
  }
  cat.value = catVal;
  const subs =
    catVal !== "ALL" ? state.subcategoriesByCategory[catVal] || [] : [];
  sub.innerHTML = `<option value="ALL">All subcategories</option>`;
  for (const s of subs.filter((x) => x.is_active)) {
    const opt = document.createElement("option");
    opt.value = s.subcategory_id;
    opt.textContent = s.name;
    sub.appendChild(opt);
  }
  if ([...sub.options].some((o) => o.value === subVal)) sub.value = subVal;
  else state.subcategoryFilter = "ALL";
}

function listPriceLabel(item) {
  if (item.hasVariants) {
    const active = (item.variants || []).filter(
      (v) => v.isActive !== false && !v.isSoldOut
    );
    if (!active.length) return "No active size price";
    const prices = active.map((v) => Number(v.priceCents));
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    if (!Number.isFinite(min)) return "No active size price";
    if (min === max) return state.money.format(min);
    return `From ${state.money.format(min)}`;
  }
  return state.money.format(item.price_cents);
}

function renderItemList() {
  const host = $("item-list");
  const items = filteredItems();
  host.innerHTML = "";
  if (!items.length) {
    host.innerHTML = `<div class="empty-state">No menu items match these filters.</div>`;
    return;
  }
  for (const item of items) {
    const st = statusLabel(item);
    const row = document.createElement("article");
    row.className = "item-row";
    const bits = [
      item.category,
      item.subcategory,
      item.sku ? `SKU ${item.sku}` : item.code ? `Code ${item.code}` : "",
      stationLabel(item) === "— NONE" ? "No preparation" : stationLabel(item),
      st.text,
      item.taxApplicable !== false ? "Taxable" : "No tax",
    ].filter(Boolean);
    row.innerHTML = `
      <div class="item-thumb">${
        item.image_url
          ? `<img src="${escapeHtml(item.image_url)}" alt="" />`
          : escapeHtml((item.name || "?").slice(0, 1))
      }</div>
      <div class="item-main">
        <div class="item-copy">
          <strong>${escapeHtml(item.name)}</strong>
          <div class="item-subline">${escapeHtml(bits.join(" · "))}</div>
        </div>
        <div class="item-price">${escapeHtml(listPriceLabel(item))}</div>
      </div>
      <div class="item-actions">
        <button type="button" class="btn ghost small" data-act="sold">${
          item.is_sold_out ? "Available" : "Sold out"
        }</button>
        <button type="button" class="btn primary small" data-act="edit">Edit</button>
      </div>
    `;
    row.querySelector('[data-act="edit"]').addEventListener("click", (e) => {
      state._editorTrigger = e.currentTarget;
      openEditor(item);
    });
    row.querySelector('[data-act="sold"]').addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSoldOut(item);
    });
    host.appendChild(row);
  }
}

function renderCategorySelects(selectedCat = "", selectedSub = "") {
  const cat = $("f-category");
  const sub = $("f-subcategory");
  cat.innerHTML = `<option value="">Select category…</option>`;
  for (const c of state.categories.filter((x) => x.is_active)) {
    const opt = document.createElement("option");
    opt.value = c.category_id;
    opt.textContent = c.name;
    cat.appendChild(opt);
  }
  if (selectedCat) cat.value = selectedCat;
  const fillSubs = () => {
    const id = cat.value;
    sub.innerHTML = `<option value="">— None —</option>`;
    for (const s of (state.subcategoriesByCategory[id] || []).filter((x) => x.is_active)) {
      const opt = document.createElement("option");
      opt.value = s.subcategory_id;
      opt.textContent = s.name;
      sub.appendChild(opt);
    }
    if (selectedSub && [...sub.options].some((o) => o.value === selectedSub)) {
      sub.value = selectedSub;
    }
  };
  fillSubs();
  cat.onchange = () => {
    selectedSub = "";
    fillSubs();
    markDirty();
  };
}

function renderStations(selected = "") {
  const sel = $("f-station");
  sel.innerHTML = `<option value="">None — No Preparation</option>`;
  for (const s of state.stations.filter(
    (x) => x.is_active && x.station_id !== "station_cashier"
  )) {
    const opt = document.createElement("option");
    opt.value = s.station_id;
    opt.textContent = s.name;
    sel.appendChild(opt);
  }
  sel.value = selected || "";
}

function renderSegment() {
  document.querySelectorAll("#avail-segment button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.status === state.formStatus);
  });
}

function renderCheckGrid(hostId, options, selectedIds, idKey, onToggle) {
  const host = $(hostId);
  if (!host) return;
  host.innerHTML = "";
  if (!options.length) {
    host.innerHTML = `<span class="muted">None in library</span>`;
    return;
  }
  for (const opt of options) {
    const id = opt[idKey];
    const label = document.createElement("label");
    label.className = "check-chip";
    const checked = selectedIds.has(id);
    label.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""} /> <span>${escapeHtml(opt.name)}</span>`;
    label.querySelector("input").addEventListener("change", (e) => {
      onToggle(id, e.target.checked);
      markDirty();
    });
    if (!state.instructionCustomized && hostId !== "item-stand-checks") {
      label.querySelector("input").disabled = true;
    }
    host.appendChild(label);
  }
}

function updateInstrModeHint() {
  const hint = $("instr-mode-hint");
  const custom = state.instructionCustomized;
  if (hint) {
    hint.textContent = custom
      ? "Customized for this item — only checked options appear on Sales."
      : "Using shop defaults (all active modifiers and targets).";
  }
  const fields = $("instr-custom-fields");
  if (fields) fields.hidden = !custom;
  const summary = $("instr-summary");
  if (summary) {
    summary.textContent = custom
      ? `${state.selectedModIds.size} modifiers · ${state.selectedTargetIds.size} ingredients · ${state.selectedStandIds.size} standalone notes`
      : "Shop defaults apply to this item.";
  }
  $("instr-use-defaults")?.classList.toggle("active", !custom);
  $("instr-customize")?.classList.toggle("active", custom);
  const disabled = !custom;
  ["mods-select-all", "mods-clear", "tgts-select-all", "tgts-clear"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = disabled;
  });
}

function renderItemCustomization() {
  updateInstrModeHint();
  const mods = (state.kitchenLibrary.modifiers || []).filter((m) => m.isActive);
  const tgts = (state.kitchenLibrary.targets || []).filter((t) => t.isActive);
  const stands = (state.kitchenLibrary.standalone || []).filter((s) => s.isActive);
  renderCheckGrid("item-mod-checks", mods, state.selectedModIds, "modifierId", (id, on) => {
    if (on) state.selectedModIds.add(id);
    else state.selectedModIds.delete(id);
  });
  renderCheckGrid("item-target-checks", tgts, state.selectedTargetIds, "targetId", (id, on) => {
    if (on) state.selectedTargetIds.add(id);
    else state.selectedTargetIds.delete(id);
  });
  renderCheckGrid("item-stand-checks", stands, state.selectedStandIds, "standaloneId", (id, on) => {
    if (on) state.selectedStandIds.add(id);
    else state.selectedStandIds.delete(id);
  });
  renderItemAddonAssignments();
}

function addonLibraryPriceLabel(addon) {
  if (!addon || addon.priceCents == null) return "Price not set";
  if (addon.priceCents === 0) return "Free";
  if (addon.priceCents < 0) return state.money.format(addon.priceCents);
  return `+ ${state.money.format(addon.priceCents)}`;
}

function renderItemAddonAssignments() {
  const host = $("item-addon-checks");
  if (!host) return;
  host.innerHTML = "";
  const list = (state.addons || []).filter((a) => a.isActive);
  if (!list.length) {
    host.innerHTML = `<p class="muted">No add-ons in library. Create some in the Add-ons tab.</p>`;
    return;
  }
  for (const addon of list) {
    const asg = state.addonAssignments.get(addon.addonId) || {
      enabled: false,
      overrideText: "",
    };
    const row = document.createElement("div");
    row.className = "addon-assign-row";
    const priceLabel = addonLibraryPriceLabel(addon);
    const placeholder =
      addon.priceCents == null ? "Ask at sale" : "Library default";
    row.innerHTML = `
      <label class="check-chip">
        <input type="checkbox" data-addon="${escapeHtml(addon.addonId)}" ${asg.enabled ? "checked" : ""} />
        <span>${escapeHtml(addon.name)} — ${escapeHtml(priceLabel)}</span>
      </label>
      <label class="field override-field">
        <span>Item price</span>
        <input type="text" inputmode="decimal" placeholder="${escapeHtml(placeholder)}" data-override="${escapeHtml(addon.addonId)}" value="${escapeHtml(asg.overrideText)}" ${asg.enabled ? "" : "disabled"} />
      </label>`;
    row.querySelector('[data-addon]').addEventListener("change", (e) => {
      const cur = state.addonAssignments.get(addon.addonId) || { enabled: false, overrideText: "" };
      cur.enabled = e.target.checked;
      state.addonAssignments.set(addon.addonId, cur);
      row.querySelector("[data-override]").disabled = !e.target.checked;
      markDirty();
    });
    row.querySelector("[data-override]").addEventListener("input", (e) => {
      const cur = state.addonAssignments.get(addon.addonId) || { enabled: true, overrideText: "" };
      cur.overrideText = e.target.value;
      state.addonAssignments.set(addon.addonId, cur);
      markDirty();
    });
    host.appendChild(row);
  }
}

function renderKitchenLibrary() {
  const host = $("kitchen-lib-list");
  if (!host) return;
  document.querySelectorAll("#instr-lib-tabs .ms-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lib === state.libTab);
  });
  const key =
    state.libTab === "modifiers"
      ? "modifiers"
      : state.libTab === "targets"
        ? "targets"
        : "standalone";
  const idKey =
    state.libTab === "modifiers"
      ? "modifierId"
      : state.libTab === "targets"
        ? "targetId"
        : "standaloneId";
  let rows = state.kitchenLibrary[key] || [];
  if (!state.libShowInactive) rows = rows.filter((r) => r.isActive);
  const q = state.libSearch.trim().toLowerCase();
  if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  if (!rows.length) {
    host.innerHTML = `<p class="muted">No options yet.</p>`;
    return;
  }
  host.innerHTML = rows
    .map((r) => {
      const id = r[idKey];
      return `<div class="lib-row">
        <div><strong>${escapeHtml(r.name)}</strong>
          <span class="status-pill ${r.isActive ? "ok" : "off"}">${r.isActive ? "Active" : "Inactive"}</span>
        </div>
        <div class="item-actions">
          <button type="button" class="btn ghost small" data-rename="${escapeHtml(id)}">Rename</button>
          <button type="button" class="btn ghost small" data-toggle="${escapeHtml(id)}">${r.isActive ? "Deactivate" : "Activate"}</button>
        </div>
      </div>`;
    })
    .join("");
  host.querySelectorAll("[data-rename]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-rename");
      const row = rows.find((r) => r[idKey] === id);
      const name = window.prompt("Rename", row?.name || "");
      if (!name?.trim()) return;
      await upsertLibraryOption(id, name.trim(), row?.isActive !== false);
    });
  });
  host.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-toggle");
      const row = rows.find((r) => r[idKey] === id);
      await upsertLibraryOption(id, row.name, !row.isActive);
    });
  });
}

async function upsertLibraryOption(id, name, isActive) {
  const path =
    state.libTab === "modifiers"
      ? "/v1/kitchen-modifiers"
      : state.libTab === "targets"
        ? "/v1/kitchen-targets"
        : "/v1/kitchen-standalone";
  const body =
    state.libTab === "modifiers"
      ? { modifierId: id || undefined, name, isActive }
      : state.libTab === "targets"
        ? { targetId: id || undefined, name, isActive }
        : { standaloneId: id || undefined, name, isActive };
  const res = await api(path, { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    toast(res.json?.error || "Save failed", true);
    return;
  }
  await loadAll();
  renderKitchenLibrary();
  toast("Library updated");
}

function renderAddonsLibrary() {
  const host = $("addon-lib-list");
  if (!host) return;
  let rows = state.addons || [];
  if (!state.addonShowInactive) rows = rows.filter((a) => a.isActive);
  const q = state.addonSearch.trim().toLowerCase();
  if (q) rows = rows.filter((a) => a.name.toLowerCase().includes(q));
  if (!rows.length) {
    host.innerHTML = `<p class="muted">No add-ons yet.</p>`;
    return;
  }
  host.innerHTML = rows
    .map((a) => {
      const price = addonLibraryPriceLabel(a);
      const kind = a.priceCents == null
        ? "Ask at sale"
        : a.isFree
          ? "Free"
          : a.isReduction
            ? "Reduction"
            : "Paid";
      const taxLabel = a.taxApplicable !== false ? "Taxable" : "No Tax";
      return `<div class="lib-row">
        <div>
          <strong>${escapeHtml(a.name)}</strong>
          <span class="muted">${escapeHtml(price)}</span>
          <span class="status-pill ok">${escapeHtml(kind)}</span>
          <span class="status-pill ${a.taxApplicable !== false ? "ok" : "off"}">${escapeHtml(taxLabel)}</span>
          <span class="status-pill ${a.isActive ? "ok" : "off"}">${a.isActive ? "Active" : "Inactive"}</span>
        </div>
        <div class="item-actions">
          <button type="button" class="btn ghost small" data-edit-addon="${escapeHtml(a.addonId)}">Edit</button>
          <button type="button" class="btn ghost small" data-toggle-addon="${escapeHtml(a.addonId)}">${a.isActive ? "Deactivate" : "Activate"}</button>
        </div>
      </div>`;
    })
    .join("");
  host.querySelectorAll("[data-edit-addon]").forEach((btn) => {
    btn.addEventListener("click", () => editAddonPrompt(btn.getAttribute("data-edit-addon")));
  });
  host.querySelectorAll("[data-toggle-addon]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-toggle-addon");
      const a = state.addons.find((x) => x.addonId === id);
      const res = await api("/v1/addons", {
        method: "PUT",
        body: JSON.stringify({
          addonId: id,
          name: a.name,
          priceCents: a.priceCents,
          isActive: !a.isActive,
          taxApplicable: a.taxApplicable !== false,
        }),
      });
      if (!res.ok) {
        toast(res.json?.error || "Update failed", true);
        return;
      }
      await loadAll();
      renderAddonsLibrary();
    });
  });
}

function openAddonEditor(addonId = null) {
  const existing = addonId
    ? state.addons.find((a) => a.addonId === addonId)
    : null;
  const panel = $("addon-editor");
  if (!panel) return;
  panel.hidden = false;
  $("addon-edit-id").value = existing?.addonId || "";
  $("addon-edit-name").value = existing?.name || "";
  $("addon-edit-price").value =
    existing && existing.priceCents != null
      ? state.money.formatPlain(existing.priceCents)
      : "";
  $("addon-edit-active").checked = existing ? existing.isActive !== false : true;
  if ($("addon-edit-tax")) {
    $("addon-edit-tax").checked = existing
      ? existing.taxApplicable !== false
      : true;
  }
  $("addon-editor-title").textContent = existing ? "Edit add-on" : "New add-on";
  $("addon-price-prefix").textContent =
    state.shop?.currencyLabel || state.shop?.currencyCode || "QR";
  $("addon-edit-error").hidden = true;
  $("addon-edit-name").focus();
}

function closeAddonEditor() {
  const panel = $("addon-editor");
  if (panel) panel.hidden = true;
  $("addon-edit-id").value = "";
  $("addon-edit-name").value = "";
  $("addon-edit-price").value = "";
  $("addon-edit-error").hidden = true;
}

async function saveAddonEditor() {
  const name = $("addon-edit-name").value.trim();
  const errEl = $("addon-edit-error");
  errEl.hidden = true;
  if (!name) {
    errEl.hidden = false;
    errEl.textContent = "Name is required.";
    return;
  }
  const priceRaw = $("addon-edit-price").value.trim();
  let priceCents = null;
  if (priceRaw) {
    try {
      priceCents = state.money.parse(priceRaw);
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = err.message;
      return;
    }
  }
  const addonId = $("addon-edit-id").value || undefined;
  $("addon-save-btn").disabled = true;
  try {
    const res = await api("/v1/addons", {
      method: "PUT",
      body: JSON.stringify({
        addonId,
        name,
        priceCents,
        isActive: $("addon-edit-active").checked,
        taxApplicable: $("addon-edit-tax")
          ? $("addon-edit-tax").checked
          : true,
      }),
    });
    if (!res.ok) {
      errEl.hidden = false;
      errEl.textContent = res.json?.error || "Save failed";
      return;
    }
    closeAddonEditor();
    await loadAll();
    renderAddonsLibrary();
    toast(`Add-on “${res.json.addon.name}” saved`);
  } finally {
    $("addon-save-btn").disabled = false;
  }
}

/** @deprecated kept name for call sites — opens inline editor */
async function editAddonPrompt(addonId) {
  openAddonEditor(addonId);
}

function renderItemInstructionChips() {
  renderItemCustomization();
}

function renderGlobalNotes() {
  renderKitchenLibrary();
}

function blankVariantRow() {
  return {
    variantId: "",
    name: "",
    priceText: "0",
    sku: "",
    code: "",
    sortOrder: state.formVariants.length,
    isActive: true,
    isSoldOut: false,
    isDefault: false,
  };
}

function syncVariantsFromDom() {
  const host = $("variant-list");
  if (!host) return;
  host.querySelectorAll(".variant-row").forEach((row, idx) => {
    const v = state.formVariants[idx];
    if (!v) return;
    v.name = row.querySelector("[data-v-name]")?.value || "";
    v.priceText = row.querySelector("[data-v-price]")?.value || "0";
    v.sku = row.querySelector("[data-v-sku]")?.value || "";
    v.code = row.querySelector("[data-v-code]")?.value || "";
    v.sortOrder = Number(row.querySelector("[data-v-sort]")?.value || idx);
    v.isActive = Boolean(row.querySelector("[data-v-active]")?.checked);
    v.isSoldOut = Boolean(row.querySelector("[data-v-sold]")?.checked);
    v.isDefault = Boolean(row.querySelector("[data-v-default]")?.checked);
  });
}

function renderVariantEditor() {
  const host = $("variant-list");
  const has = $("f-has-variants");
  if (!host || !has) return;
  const enabled = has.checked;
  host.hidden = !enabled;
  const offHint = $("variant-off-hint");
  const onHint = $("variant-on-hint");
  if (offHint) offHint.hidden = enabled;
  if (onHint) onHint.hidden = !enabled;
  $("add-variant-btn").disabled = !enabled;
  if (!enabled) {
    host.innerHTML = "";
    return;
  }
  if (!state.formVariants.length) {
    host.innerHTML = `<p class="muted">No variants yet. Add Small / Medium / Large or custom names.</p>`;
    return;
  }
  host.innerHTML = state.formVariants
    .map(
      (v, i) => `
    <div class="variant-row" data-idx="${i}">
      <label class="field">
        <span>Name</span>
        <input data-v-name type="text" maxlength="80" value="${escapeHtml(v.name)}" placeholder="e.g. Large" />
      </label>
      <label class="field">
        <span>Price</span>
        <input data-v-price type="text" inputmode="decimal" value="${escapeHtml(v.priceText)}" />
      </label>
      <label class="field variant-opt">
        <span>Sort</span>
        <input data-v-sort type="number" step="1" value="${escapeHtml(String(v.sortOrder))}" />
      </label>
      <label class="field variant-opt">
        <span>SKU / Code</span>
        <div class="variant-sku-code">
          <input data-v-sku type="text" placeholder="SKU" value="${escapeHtml(v.sku || "")}" />
          <input data-v-code type="text" placeholder="Code" value="${escapeHtml(v.code || "")}" />
        </div>
      </label>
      <div class="variant-flags">
        <label class="check-inline"><input data-v-active type="checkbox" ${v.isActive ? "checked" : ""} /> Active</label>
        <label class="check-inline"><input data-v-sold type="checkbox" ${v.isSoldOut ? "checked" : ""} /> Sold out</label>
        <label class="check-inline"><input data-v-default type="checkbox" ${v.isDefault ? "checked" : ""} /> Default</label>
        <button type="button" class="btn ghost small" data-v-remove="${i}">Remove</button>
      </div>
    </div>`
    )
    .join("");
  host.querySelectorAll("[data-v-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      syncVariantsFromDom();
      const i = Number(btn.getAttribute("data-v-remove"));
      state.formVariants.splice(i, 1);
      markDirty();
      renderVariantEditor();
    });
  });
  host.querySelectorAll("input").forEach((el) => {
    el.addEventListener("input", markDirty);
    el.addEventListener("change", markDirty);
  });
}

function setEditorTab(tab) {
  const allowed = ["basic", "variants", "kitchen", "knowledge"];
  state.editorTab = allowed.includes(tab) ? tab : "basic";
  document.querySelectorAll("[data-editor-tab]").forEach((btn) => {
    const on = btn.dataset.editorTab === state.editorTab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll("[data-editor-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.editorPanel !== state.editorTab;
  });
}

function updateSaveLabel() {
  const btn = $("save-btn");
  if (!btn || state.saving) return;
  btn.textContent = $("f-item-id")?.value ? "Save Changes" : "Save Item";
}

function openEditor(item = null, { keepTab = false } = {}) {
  state.editorOpen = true;
  $("fab-add").hidden = true;
  document.body.classList.add("item-editor-open");
  if (!item) {
    state.selectedId = null;
    $("f-item-id").value = "";
    $("f-name").value = "";
    $("f-price").value = "";
    $("f-sku").value = "";
    $("f-code").value = "";
    $("f-sort").value = "0";
    $("f-description").value = "";
    clearProductKnowledgeForm();
    resetPhotoDraft("");
    state.formStatus = "active";
    if ($("f-tax-applicable")) $("f-tax-applicable").checked = true;
    if ($("f-has-variants")) $("f-has-variants").checked = false;
    state.formVariants = [];
    state.formIngredients = [];
    state.instructionCustomized = false;
    state.selectedModIds = new Set();
    state.selectedTargetIds = new Set();
    state.selectedStandIds = new Set();
    state.addonAssignments = new Map();
    $("editor-title").textContent = "Create Menu Item";
    if ($("editor-subtitle")) {
      $("editor-subtitle").hidden = true;
      $("editor-subtitle").textContent = "";
    }
    if ($("editor-tech-id")) {
      $("editor-tech-id").textContent = "New item — ID assigned on save.";
    }
    $("editor-hint").textContent = "Required fields marked *";
    renderCategorySelects();
    renderStations();
  } else {
    state.selectedId = item.item_id;
    $("f-item-id").value = item.item_id;
    $("f-name").value = item.name || "";
    $("f-price").value = state.money.formatPlain(item.price_cents);
    $("f-sku").value = item.sku || "";
    $("f-code").value = item.code || "";
    $("f-sort").value = String(item.sort_order ?? 0);
    $("f-description").value = item.description || "";
    clearProductKnowledgeForm();
    state.formStatus = statusLabel(item).key;
    if ($("f-tax-applicable")) {
      $("f-tax-applicable").checked = item.taxApplicable !== false;
    }
    if ($("f-has-variants")) {
      $("f-has-variants").checked = Boolean(item.hasVariants);
    }
    state.formVariants = (item.variants || []).map((v, i) => ({
      variantId: v.variantId,
      name: v.name,
      priceText: state.money.formatPlain(v.priceCents),
      sku: v.sku || "",
      code: v.code || "",
      sortOrder: v.sortOrder ?? i,
      isActive: v.isActive !== false,
      isSoldOut: Boolean(v.isSoldOut),
      isDefault: Boolean(v.isDefault),
    }));
    const cfg = item.instructionConfig || {};
    state.instructionCustomized = Boolean(item.instructionCustomized || cfg.customized);
    state.selectedModIds = new Set((cfg.modifiers || []).map((m) => m.modifierId));
    state.selectedTargetIds = new Set((cfg.targets || []).map((t) => t.targetId));
    state.selectedStandIds = new Set((cfg.standalone || []).map((s) => s.standaloneId));
    state.addonAssignments = new Map();
    for (const a of state.addons || []) {
      const assigned = (item.addons || []).find((x) => x.addonId === a.addonId);
      state.addonAssignments.set(a.addonId, {
        enabled: Boolean(assigned),
        overrideText:
          assigned && assigned.priceOverrideCents != null
            ? state.money.formatPlain(assigned.priceOverrideCents)
            : "",
      });
    }
    $("editor-title").textContent = "Edit Menu Item";
    if ($("editor-subtitle")) {
      $("editor-subtitle").hidden = false;
      $("editor-subtitle").textContent = item.name || "";
    }
    if ($("editor-tech-id")) {
      $("editor-tech-id").textContent = `Item ID ${item.item_id}`;
    }
    $("editor-hint").textContent = "Changes stay in this draft until you save.";
    renderCategorySelects(item.category_id || "", item.subcategory_id || "");
    renderStations(item.stationIds?.[0] || "");
    resetPhotoDraft(item.image_url || "");
  }
  renderSegment();
  renderVariantEditor();
  renderItemInstructionChips();
  renderIngredientChips();
  updatePkCounts();
  $("form-error").hidden = true;
  if ($("variant-error")) $("variant-error").hidden = true;
  renderItemList();
  if (!keepTab) setEditorTab("basic");
  else setEditorTab(state.editorTab);
  document.querySelectorAll("[data-editor-tab]").forEach((btn) => {
    btn.classList.remove("has-error");
  });
  updateSaveLabel();
  clearDirty();
  const dlg = $("item-editor-dialog");
  if (dlg && typeof dlg.showModal === "function" && !dlg.open) dlg.showModal();
  if (!keepTab) $("f-name")?.focus();
  if (item?.item_id) {
    void loadProductKnowledgeIntoForm(item.item_id);
  }
}

function clearProductKnowledgeForm() {
  state.formIngredients = [];
  const ids = [
    "f-pk-detailed",
    "f-pk-quick",
    "f-pk-features",
    "f-pk-allergens",
    "f-pk-brand",
    "f-pk-ingredient-brand",
    "f-pk-prep-min",
    "f-pk-prep-max",
    "f-pk-serving-style",
    "f-pk-serving-with",
    "f-pk-service-notes",
    "f-pk-training",
    "f-pk-ingredient-input",
  ];
  for (const id of ids) {
    if ($(id)) $(id).value = "";
  }
  if ($("f-pk-allergen-verified")) $("f-pk-allergen-verified").checked = false;
  renderIngredientChips();
  updatePkCounts();
}

function applyProductKnowledgeToForm(pk) {
  if (!pk) return;
  if ($("f-pk-detailed")) $("f-pk-detailed").value = pk.detailedDescription || "";
  if ($("f-pk-quick")) $("f-pk-quick").value = pk.salesmanQuickAnswer || "";
  if ($("f-pk-features")) $("f-pk-features").value = pk.specialFeatures || "";
  if ($("f-pk-allergens")) $("f-pk-allergens").value = pk.allergenNotes || "";
  if ($("f-pk-allergen-verified")) {
    $("f-pk-allergen-verified").checked = Boolean(pk.allergenVerified);
  }
  if ($("f-pk-brand")) $("f-pk-brand").value = pk.brand || "";
  if ($("f-pk-ingredient-brand")) {
    $("f-pk-ingredient-brand").value = pk.ingredientBrand || "";
  }
  if ($("f-pk-prep-min")) {
    $("f-pk-prep-min").value =
      pk.prepTimeMin != null ? String(pk.prepTimeMin) : "";
  }
  if ($("f-pk-prep-max")) {
    $("f-pk-prep-max").value =
      pk.prepTimeMax != null ? String(pk.prepTimeMax) : "";
  }
  if ($("f-pk-serving-style")) {
    $("f-pk-serving-style").value = pk.servingStyle || "";
  }
  if ($("f-pk-serving-with")) {
    $("f-pk-serving-with").value = pk.servingAccompaniments || "";
  }
  if ($("f-pk-service-notes")) {
    $("f-pk-service-notes").value = pk.serviceNotes || "";
  }
  if ($("f-pk-training")) {
    $("f-pk-training").value = pk.staffTrainingNotes || "";
  }
  state.formIngredients = [...(pk.ingredients || [])];
  renderIngredientChips();
  updatePkCounts();
}

async function loadProductKnowledgeIntoForm(itemId) {
  const res = await api(
    `/v1/menu-items/${encodeURIComponent(itemId)}/product-knowledge`
  );
  if (!res.ok) return;
  if (state.selectedId !== itemId) return;
  applyProductKnowledgeToForm(res.json?.productKnowledge);
}

function renderIngredientChips() {
  const host = $("f-pk-ingredients");
  if (!host) return;
  host.innerHTML = "";
  for (const name of state.formIngredients) {
    const chip = document.createElement("span");
    chip.className = "pk-chip";
    const label = document.createElement("span");
    label.textContent = name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "pk-chip-remove";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.formIngredients = state.formIngredients.filter((n) => n !== name);
      markDirty();
      renderIngredientChips();
    });
    chip.appendChild(label);
    chip.appendChild(remove);
    host.appendChild(chip);
  }
}

function addIngredientFromInput() {
  const input = $("f-pk-ingredient-input");
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  if (name.length > 80) {
    toast("Ingredient name is too long", true);
    return;
  }
  const key = name.toLowerCase();
  if (state.formIngredients.some((n) => n.toLowerCase() === key)) {
    input.value = "";
    return;
  }
  if (state.formIngredients.length >= 40) {
    toast("At most 40 ingredients", true);
    return;
  }
  state.formIngredients.push(name);
  input.value = "";
  markDirty();
  renderIngredientChips();
}

function updatePkCounts() {
  const pairs = [
    ["f-description", "f-description-count"],
    ["f-pk-detailed", "f-pk-detailed-count"],
    ["f-pk-quick", "f-pk-quick-count"],
  ];
  for (const [fieldId, countId] of pairs) {
    const field = $(fieldId);
    const count = $(countId);
    if (field && count) count.textContent = String(field.value.length);
  }
}

function collectProductKnowledge() {
  const prepMinRaw = $("f-pk-prep-min")?.value?.trim() ?? "";
  const prepMaxRaw = $("f-pk-prep-max")?.value?.trim() ?? "";
  let prepTimeMin = null;
  let prepTimeMax = null;
  if (prepMinRaw !== "") {
    prepTimeMin = Number(prepMinRaw);
    if (!Number.isInteger(prepTimeMin) || prepTimeMin < 0 || prepTimeMin > 999) {
      throw new Error("Prep time from must be a whole number 0–999");
    }
  }
  if (prepMaxRaw !== "") {
    prepTimeMax = Number(prepMaxRaw);
    if (!Number.isInteger(prepTimeMax) || prepTimeMax < 0 || prepTimeMax > 999) {
      throw new Error("Prep time to must be a whole number 0–999");
    }
  }
  if (
    prepTimeMin != null &&
    prepTimeMax != null &&
    prepTimeMax < prepTimeMin
  ) {
    throw new Error("Prep time to must be greater than or equal to from");
  }
  return {
    detailedDescription: $("f-pk-detailed")?.value.trim() || "",
    salesmanQuickAnswer: $("f-pk-quick")?.value.trim() || "",
    specialFeatures: $("f-pk-features")?.value.trim() || "",
    ingredients: [...state.formIngredients],
    allergenNotes: $("f-pk-allergens")?.value.trim() || "",
    allergenVerified: Boolean($("f-pk-allergen-verified")?.checked),
    brand: $("f-pk-brand")?.value.trim() || "",
    ingredientBrand: $("f-pk-ingredient-brand")?.value.trim() || "",
    prepTimeMin,
    prepTimeMax,
    servingStyle: $("f-pk-serving-style")?.value.trim() || "",
    servingAccompaniments: $("f-pk-serving-with")?.value.trim() || "",
    serviceNotes: $("f-pk-service-notes")?.value.trim() || "",
    staffTrainingNotes: $("f-pk-training")?.value.trim() || "",
  };
}

function closeEditor(force = false) {
  if (!force && !confirmLeaveEditor()) return false;
  resetPhotoDraft("");
  state.editorOpen = false;
  state.selectedId = null;
  clearDirty();
  $("fab-add").hidden = false;
  document.body.classList.remove("item-editor-open");
  const dlg = $("item-editor-dialog");
  if (dlg?.open) dlg.close();
  renderItemList();
  const trigger = state._editorTrigger;
  state._editorTrigger = null;
  if (trigger && typeof trigger.focus === "function") trigger.focus();
  return true;
}

async function toggleSoldOut(item) {
  const markingSoldOut = !item.is_sold_out;
  const ok = window.confirm(
    markingSoldOut
      ? `Mark “${item.name}” as sold out?`
      : `Mark “${item.name}” as available again?`
  );
  if (!ok) return;
  const res = await api(
    `/v1/menu-items/${encodeURIComponent(item.item_id)}/availability`,
    {
      method: "PATCH",
      body: JSON.stringify({ isSoldOut: !item.is_sold_out }),
    }
  );
  if (!res.ok) {
    toast(res.json?.error || "Update failed", true);
    return;
  }
  await loadAll({ keepEditor: true });
  toast(
    res.json.menuItem.is_sold_out
      ? `“${res.json.menuItem.name}” marked Sold out`
      : `“${res.json.menuItem.name}” available`
  );
}

function collectForm() {
  const name = $("f-name").value.trim();
  const categoryId = $("f-category").value;
  const errors = [];
  if (!name) errors.push("Name is required.");
  if (!categoryId) errors.push("Category is required.");
  let priceCents;
  try {
    priceCents = state.money.parse($("f-price").value);
  } catch (err) {
    errors.push(err.message);
  }
  const sortOrder = Number($("f-sort").value || 0);
  if (!Number.isInteger(sortOrder)) errors.push("Sort order must be an integer.");
  if (errors.length) throw new Error(errors.join(" "));
  const station = $("f-station").value;
  return {
    itemId: $("f-item-id").value || undefined,
    name,
    priceCents,
    categoryId,
    subcategoryId: $("f-subcategory").value || null,
    stationIds: station ? [station] : [],
    sku: $("f-sku").value.trim(),
    code: $("f-code").value.trim(),
    sortOrder,
    description: $("f-description").value.trim(),
    isActive: state.formStatus !== "inactive",
    isSoldOut: state.formStatus === "sold_out",
    taxApplicable: $("f-tax-applicable")
      ? $("f-tax-applicable").checked
      : true,
    hasVariants: $("f-has-variants") ? $("f-has-variants").checked : false,
    variants: (() => {
      syncVariantsFromDom();
      if (!$("f-has-variants")?.checked) return [];
      return state.formVariants.map((v, i) => {
        let priceCents;
        try {
          priceCents = state.money.parse(v.priceText);
        } catch (err) {
          throw new Error(`Variant “${v.name || i + 1}”: ${err.message}`);
        }
        if (priceCents < 0) {
          throw new Error(`Variant “${v.name || i + 1}”: price cannot be negative`);
        }
        if (!String(v.name || "").trim()) {
          throw new Error(`Variant ${i + 1}: name is required`);
        }
        return {
          variantId: v.variantId || undefined,
          name: String(v.name).trim(),
          priceCents,
          sku: v.sku || null,
          code: v.code || "",
          sortOrder: Number.isInteger(Number(v.sortOrder))
            ? Number(v.sortOrder)
            : i,
          isActive: v.isActive !== false,
          isSoldOut: Boolean(v.isSoldOut),
          isDefault: Boolean(v.isDefault),
        };
      });
    })(),
    instructionCustomize: state.instructionCustomized,
    useShopDefaults: !state.instructionCustomized,
    modifierIds: [...state.selectedModIds],
    targetIds: [...state.selectedTargetIds],
    standaloneIds: [...state.selectedStandIds],
    addonAssignments: [...state.addonAssignments.entries()]
      .filter(([, v]) => v.enabled)
      .map(([addonId, v]) => {
        let priceOverrideCents = null;
        const raw = String(v.overrideText || "").trim();
        if (raw !== "") {
          priceOverrideCents = state.money.parse(raw);
        }
        return { addonId, priceOverrideCents };
      }),
    productKnowledge: collectProductKnowledge(),
  };
}

function editorTabForMessage(message) {
  const text = String(message || "");
  if (/variant/i.test(text)) return "variants";
  if (/prep time|ingredient|allergen|quick answer/i.test(text)) return "knowledge";
  return "basic";
}

function showFormError(message) {
  $("form-error").hidden = false;
  $("form-error").textContent = message;
  const tab = editorTabForMessage(message);
  document.querySelectorAll("[data-editor-tab]").forEach((btn) => {
    btn.classList.toggle("has-error", btn.dataset.editorTab === tab);
  });
  setEditorTab(tab);
  if ($("variant-error")) {
    const isVariant = tab === "variants";
    $("variant-error").hidden = !isVariant;
    $("variant-error").textContent = isVariant ? message : "";
  }
  const focusMap = {
    basic: "f-name",
    variants: "f-has-variants",
    knowledge: "f-pk-quick",
  };
  $(focusMap[tab] || "f-name")?.focus();
}

async function saveItem(e) {
  e.preventDefault();
  if (state.saving) return;
  $("form-error").hidden = true;
  if ($("variant-error")) $("variant-error").hidden = true;
  let payload;
  try {
    // Sync variant fields before validation so typed names/prices are kept
    syncVariantsFromDom();
    payload = collectForm();
  } catch (err) {
    showFormError(err.message);
    return;
  }
  if (state.photoDraft.file) {
    const photoCheck = validatePhotoFile(state.photoDraft.file);
    if (photoCheck) {
      showFormError(photoCheck);
      return;
    }
  }
  state.saving = true;
  $("save-btn").disabled = true;
  $("save-btn").textContent = "Saving…";
  try {
    const res = await api("/v1/menu-items", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      showFormError(res.json?.error || "Save failed");
      return;
    }
    const saved = res.json.menuItem;
    const photoError = await applyPendingPhoto(saved.item_id);
    if (photoError) {
      adoptSavedItemIdentity(saved);
      state.formDirty = false;
      syncDirty();
      await loadAll();
      showFormError(
        `Saved “${saved.name}”, but the photo was not updated. ${photoError} Save again to retry the photo. This item was not duplicated.`
      );
      return;
    }
    resetPhotoDraft("");
    clearDirty();
    const vCount = (saved.variants || []).filter((v) => v.isActive !== false)
      .length;
    toast(
      saved.hasVariants
        ? `Saved “${saved.name}” (${vCount} variant${vCount === 1 ? "" : "s"})`
        : `Saved “${saved.name}”`
    );
    await loadAll();
    closeEditor(true);
  } catch (err) {
    showFormError(err.message || "Save failed");
  } finally {
    state.saving = false;
    $("save-btn").disabled = false;
    updateSaveLabel();
  }
}

const PHOTO_MIME = {
  "image/jpeg": true,
  "image/jpg": true,
  "image/png": true,
  "image/webp": true,
};

function revokePhotoObjectUrl() {
  if (state.photoDraft?.objectUrl) {
    URL.revokeObjectURL(state.photoDraft.objectUrl);
    state.photoDraft.objectUrl = "";
  }
}

function resetPhotoDraft(savedUrl = "") {
  revokePhotoObjectUrl();
  state.photoDraft = {
    savedUrl: savedUrl || "",
    file: null,
    objectUrl: "",
    remove: false,
  };
  if ($("f-photo")) $("f-photo").value = "";
  renderPhotoPreview();
  syncDirty();
}

function renderPhotoPreview() {
  const host = $("photo-preview");
  const status = $("photo-status");
  const restore = $("restore-photo-btn");
  const choose = $("choose-photo-btn");
  const removeBtn = $("clear-photo-btn");
  if (!host) return;
  const draft = state.photoDraft;
  const pending = photoPending();
  if (restore) restore.hidden = !pending;
  if (choose) {
    choose.textContent =
      draft.file || (draft.savedUrl && !draft.remove) ? "Change photo" : "Choose photo";
  }
  if (removeBtn) {
    removeBtn.disabled = !draft.file && !(draft.savedUrl && !draft.remove);
  }
  host.replaceChildren();
  if (draft.file && draft.objectUrl) {
    const img = document.createElement("img");
    img.src = draft.objectUrl;
    img.alt = "";
    host.appendChild(img);
  } else if (draft.savedUrl && !draft.remove) {
    const img = document.createElement("img");
    img.src = draft.savedUrl;
    img.alt = "";
    host.appendChild(img);
  } else {
    host.textContent = "No photo";
  }
  if (!status) return;
  status.classList.remove("is-error");
  if (draft.file) {
    status.hidden = false;
    status.textContent = draft.savedUrl
      ? "New photo selected. It replaces the saved photo when you save."
      : "Photo selected. It is stored when you save.";
  } else if (draft.remove) {
    status.hidden = false;
    status.textContent =
      "Photo will be removed when you save. Cancel keeps the saved photo.";
  } else {
    status.hidden = true;
    status.textContent = "";
  }
}

function setPhotoStatus(message, { error = false } = {}) {
  const status = $("photo-status");
  if (!status) return;
  status.hidden = !message;
  status.textContent = message || "";
  status.classList.toggle("is-error", Boolean(error && message));
}

function validatePhotoFile(file) {
  if (!file) return "Choose an image file.";
  const type = String(file.type || "").toLowerCase();
  if (!PHOTO_MIME[type]) return "Use a JPEG, PNG, or WebP image.";
  if (!file.size) return "Empty image file.";
  if (file.size > 4_500_000) return "Image too large (max ~3.3MB).";
  return "";
}

function onPhotoFileChosen() {
  const file = $("f-photo")?.files?.[0];
  if ($("f-photo")) $("f-photo").value = "";
  if (!file) return;
  const err = validatePhotoFile(file);
  if (err) {
    setPhotoStatus(err, { error: true });
    return;
  }
  revokePhotoObjectUrl();
  state.photoDraft.file = file;
  state.photoDraft.objectUrl = URL.createObjectURL(file);
  state.photoDraft.remove = false;
  renderPhotoPreview();
  syncDirty();
}

function markPhotoRemoved() {
  const draft = state.photoDraft;
  if (!draft.file && !(draft.savedUrl && !draft.remove)) return;
  revokePhotoObjectUrl();
  draft.file = null;
  draft.objectUrl = "";
  draft.remove = Boolean(draft.savedUrl);
  if ($("f-photo")) $("f-photo").value = "";
  renderPhotoPreview();
  syncDirty();
}

function restoreOriginalPhoto() {
  const savedUrl = state.photoDraft.savedUrl || "";
  resetPhotoDraft(savedUrl);
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = String(reader.result || "");
      resolve(raw.includes(",") ? raw.split(",")[1] : raw);
    };
    reader.onerror = () => reject(new Error("Could not read the image file."));
    reader.readAsDataURL(file);
  });
}

async function applyPendingPhoto(itemId) {
  const draft = state.photoDraft;
  if (draft.file) {
    const err = validatePhotoFile(draft.file);
    if (err) return err;
    let base64Data;
    try {
      base64Data = await readFileBase64(draft.file);
    } catch (ex) {
      return ex.message || "Could not read the image file.";
    }
    const res = await api(`/v1/menu-items/${encodeURIComponent(itemId)}/image`, {
      method: "POST",
      body: JSON.stringify({
        mimeType: draft.file.type || "image/jpeg",
        base64Data,
      }),
    });
    if (!res.ok) {
      return (
        res.json?.error ||
        "Photo upload failed. The saved photo was not changed."
      );
    }
    return "";
  }
  if (draft.remove && draft.savedUrl) {
    const res = await api(`/v1/menu-items/${encodeURIComponent(itemId)}/image`, {
      method: "DELETE",
    });
    if (!res.ok) {
      return (
        res.json?.error ||
        "Photo could not be removed. The saved photo is still in place."
      );
    }
    return "";
  }
  return "";
}

function adoptSavedItemIdentity(item) {
  state.selectedId = item.item_id;
  $("f-item-id").value = item.item_id;
  $("editor-title").textContent = "Edit Menu Item";
  if ($("editor-subtitle")) {
    $("editor-subtitle").hidden = false;
    $("editor-subtitle").textContent = item.name || "";
  }
  if ($("editor-tech-id")) {
    $("editor-tech-id").textContent = `Item ID ${item.item_id}`;
  }
  state.photoDraft.savedUrl = item.image_url || "";
  updateSaveLabel();
  renderPhotoPreview();
}

function renderCategoriesTab() {
  const host = $("category-admin-list");
  host.innerHTML = "";
  const showInactive = $("show-inactive-cats").checked;
  const cats = state.categories.filter((c) => showInactive || c.is_active);
  if (!cats.length) {
    host.innerHTML = `<div class="empty-state">No categories yet.</div>`;
    return;
  }
  for (const cat of cats) {
    const open = state.expandedCats.has(cat.category_id);
    const card = document.createElement("div");
    card.className = "cat-card";
    const editing = state.editingCatId === cat.category_id;
    card.innerHTML = `
      <div class="cat-card-head" data-act="toggle">
        <strong>${escapeHtml(cat.name)}</strong>
        <span class="badge status-${cat.is_active ? "active" : "inactive"}">● ${
          cat.is_active ? "Active" : "Inactive"
        }</span>
        <span class="muted">${cat.subcategoryCount || 0} sub · ${cat.itemCount || 0} items</span>
        <span class="muted">${open ? "▾" : "▸"}</span>
      </div>
      <div class="cat-card-body" ${open ? "" : "hidden"}>
        <div class="item-actions" style="margin-bottom:10px">
          <button type="button" class="btn ghost small" data-act="edit-cat">Rename</button>
          <button type="button" class="btn ghost small" data-act="toggle-cat">${
            cat.is_active ? "Deactivate" : "Activate"
          }</button>
          <button type="button" class="btn ghost small" data-act="add-sub">+ Add subcategory</button>
        </div>
        <div data-edit-cat ${editing ? "" : "hidden"} class="inline-edit">
          <input type="text" value="${escapeHtml(cat.name)}" maxlength="64" />
          <button type="button" class="btn primary small" data-act="save-cat">Save</button>
          <button type="button" class="btn ghost small" data-act="cancel-cat">Cancel</button>
        </div>
        <div data-subs></div>
      </div>
    `;
    card.querySelector('[data-act="toggle"]').addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      if (open) state.expandedCats.delete(cat.category_id);
      else state.expandedCats.add(cat.category_id);
      renderCategoriesTab();
    });
    card.querySelector('[data-act="edit-cat"]').addEventListener("click", () => {
      state.editingCatId = cat.category_id;
      state.expandedCats.add(cat.category_id);
      renderCategoriesTab();
    });
    card.querySelector('[data-act="cancel-cat"]').addEventListener("click", () => {
      state.editingCatId = null;
      renderCategoriesTab();
    });
    card.querySelector('[data-act="save-cat"]').addEventListener("click", async () => {
      const name = card.querySelector("[data-edit-cat] input").value.trim();
      const res = await api("/v1/menu-categories", {
        method: "PUT",
        body: JSON.stringify({
          categoryId: cat.category_id,
          name,
          isActive: Boolean(cat.is_active),
          sortOrder: cat.sort_order,
        }),
      });
      if (!res.ok) {
        toast(res.json?.error || "Save failed", true);
        return;
      }
      state.editingCatId = null;
      await loadAll();
      toast(`Category saved as “${res.json.category.name}”`);
    });
    card.querySelector('[data-act="toggle-cat"]').addEventListener("click", async () => {
      const res = await api("/v1/menu-categories", {
        method: "PUT",
        body: JSON.stringify({
          categoryId: cat.category_id,
          name: cat.name,
          isActive: !cat.is_active,
          sortOrder: cat.sort_order,
        }),
      });
      if (!res.ok) {
        toast(res.json?.error || "Update failed", true);
        return;
      }
      await loadAll();
    });
    card.querySelector('[data-act="add-sub"]').addEventListener("click", async () => {
      const name = window.prompt("New subcategory name");
      if (!name?.trim()) return;
      const res = await api("/v1/menu-subcategories", {
        method: "PUT",
        body: JSON.stringify({ categoryId: cat.category_id, name: name.trim() }),
      });
      if (!res.ok) {
        toast(res.json?.error || "Could not add subcategory", true);
        return;
      }
      state.expandedCats.add(cat.category_id);
      await loadAll();
      toast(`Added “${res.json.subcategory.name}”`);
    });

    const subsHost = card.querySelector("[data-subs]");
    const subs = state.subcategoriesByCategory[cat.category_id] || [];
    if (!subs.length) {
      subsHost.innerHTML = `<p class="muted">No subcategories</p>`;
    } else {
      for (const sub of subs) {
        if (!showInactive && !sub.is_active) continue;
        const row = document.createElement("div");
        row.className = "sub-row";
        const editingSub = state.editingSubId === sub.subcategory_id;
        row.innerHTML = editingSub
          ? `<div class="inline-edit">
               <input type="text" value="${escapeHtml(sub.name)}" maxlength="64" />
               <button type="button" class="btn primary small" data-act="save-sub">Save</button>
               <button type="button" class="btn ghost small" data-act="cancel-sub">Cancel</button>
             </div>`
          : `<strong style="flex:1">${escapeHtml(sub.name)}</strong>
             <span class="muted">${sub.itemCount || 0} items</span>
             <span class="badge status-${sub.is_active ? "active" : "inactive"}">● ${
               sub.is_active ? "Active" : "Inactive"
             }</span>
             <button type="button" class="btn ghost small" data-act="edit-sub">Rename</button>
             <button type="button" class="btn ghost small" data-act="toggle-sub">${
               sub.is_active ? "Deactivate" : "Activate"
             }</button>`;
        if (editingSub) {
          row.querySelector('[data-act="save-sub"]').addEventListener("click", async () => {
            const name = row.querySelector("input").value.trim();
            const res = await api("/v1/menu-subcategories", {
              method: "PUT",
              body: JSON.stringify({
                subcategoryId: sub.subcategory_id,
                categoryId: sub.category_id,
                name,
                isActive: Boolean(sub.is_active),
                sortOrder: sub.sort_order,
              }),
            });
            if (!res.ok) {
              toast(res.json?.error || "Save failed", true);
              return;
            }
            state.editingSubId = null;
            await loadAll();
            toast(`Subcategory saved as “${res.json.subcategory.name}”`);
          });
          row.querySelector('[data-act="cancel-sub"]').addEventListener("click", () => {
            state.editingSubId = null;
            renderCategoriesTab();
          });
        } else {
          row.querySelector('[data-act="edit-sub"]').addEventListener("click", () => {
            state.editingSubId = sub.subcategory_id;
            renderCategoriesTab();
          });
          row.querySelector('[data-act="toggle-sub"]').addEventListener("click", async () => {
            const res = await api("/v1/menu-subcategories", {
              method: "PUT",
              body: JSON.stringify({
                subcategoryId: sub.subcategory_id,
                categoryId: sub.category_id,
                name: sub.name,
                isActive: !sub.is_active,
                sortOrder: sub.sort_order,
              }),
            });
            if (!res.ok) {
              toast(res.json?.error || "Update failed", true);
              return;
            }
            await loadAll();
          });
        }
        subsHost.appendChild(row);
      }
    }
    host.appendChild(card);
  }
}

async function addCategory() {
  const name = window.prompt("New category name");
  if (!name?.trim()) return;
  const res = await api("/v1/menu-categories", {
    method: "PUT",
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!res.ok) {
    toast(res.json?.error || "Could not add category", true);
    return;
  }
  await loadAll();
  toast(`Category “${res.json.category.name}” created`);
}

/** Create a category from the item editor and select it. */
async function addCategoryFromItemForm() {
  const name = window.prompt("New category name");
  if (!name?.trim()) return;
  const res = await api("/v1/menu-categories", {
    method: "PUT",
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!res.ok) {
    toast(res.json?.error || "Could not add category", true);
    return;
  }
  const category = res.json.category;
  await loadAll({ keepEditor: true });
  renderCategorySelects(category.category_id, "");
  markDirty();
  toast(`Category “${category.name}” created`);
  $("f-category")?.focus();
}

/** Create a subcategory under the selected category from the item editor. */
async function addSubcategoryFromItemForm() {
  const categoryId = $("f-category")?.value || "";
  if (!categoryId) {
    toast("Select or create a category first.", true);
    $("f-category")?.focus();
    return;
  }
  const name = window.prompt("New subcategory name");
  if (!name?.trim()) return;
  const res = await api("/v1/menu-subcategories", {
    method: "PUT",
    body: JSON.stringify({ categoryId, name: name.trim() }),
  });
  if (!res.ok) {
    toast(res.json?.error || "Could not add subcategory", true);
    return;
  }
  const subcategory = res.json.subcategory;
  await loadAll({ keepEditor: true });
  renderCategorySelects(categoryId, subcategory.subcategory_id);
  markDirty();
  toast(`Added “${subcategory.name}”`);
  $("f-subcategory")?.focus();
}

async function saveKitchenNotes() {
  const res = await api("/v1/kitchen-notes", {
    method: "PUT",
    body: JSON.stringify({
      modifiers: state.globalMods,
      targets: state.globalTargets,
    }),
  });
  if (!res.ok) {
    toast(res.json?.error || "Save failed", true);
    return;
  }
  state.globalMods = res.json.modifiers || [];
  state.globalTargets = res.json.targets || [];
  renderGlobalNotes();
  toast("Kitchen notes saved");
}

async function loadAll({ keepEditor = false } = {}) {
  const selected = state.selectedId;
  const [itemsRes, stationsRes, catsRes, shopRes, libRes, addonsRes] = await Promise.all([
    api("/v1/menu-items?includeInactive=1"),
    api("/v1/stations"),
    api("/v1/menu-categories?includeInactive=1"),
    api("/v1/shop-settings"),
    api("/v1/kitchen-library?includeInactive=1"),
    api("/v1/addons?includeInactive=1"),
  ]);
  if ([itemsRes, stationsRes, catsRes, shopRes].some((r) => r.status === 401)) {
    showLogin("Session expired.");
    return;
  }
  state.items = itemsRes.json.menuItems || [];
  state.stations = stationsRes.json.stations || [];
  state.categories = catsRes.json.categories || [];
  state.subcategoriesByCategory = catsRes.json.subcategoriesByCategory || {};
  state.shop = shopRes.json.shop;
  state.money = createMoneyFormatter(state.shop);
  $("currency-pill").textContent = `${state.shop.currencyCode} · ${state.shop.currencyDecimals} dp`;
  $("price-prefix").textContent = state.shop.currencyLabel || state.shop.currencyCode;
  if ($("addon-price-prefix")) {
    $("addon-price-prefix").textContent =
      state.shop.currencyLabel || state.shop.currencyCode;
  }
  state.kitchenLibrary = libRes.json?.library || {
    modifiers: [],
    targets: [],
    standalone: [],
  };
  state.addons = addonsRes.json?.addons || [];
  renderAvailFilters();
  renderFilterSelects();
  renderItemList();
  renderCategoriesTab();
  if (state.tab === "notes") renderKitchenLibrary();
  if (state.tab === "addons") renderAddonsLibrary();
  if (keepEditor && selected && state.editorOpen) {
    /* keep open form; list refreshed */
  }
}

async function bootstrap() {
  if (state.role !== "admin") return;
  await loadAll();
  setTab("items");
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
  document.querySelectorAll(".ms-tabs > .ms-tab[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });
  $("menu-search").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderItemList();
  });
  $("filter-category").addEventListener("change", (e) => {
    state.categoryFilter = e.target.value;
    state.subcategoryFilter = "ALL";
    renderFilterSelects();
    renderItemList();
  });
  $("filter-subcategory").addEventListener("change", (e) => {
    state.subcategoryFilter = e.target.value;
    renderItemList();
  });
  $("new-item-btn").addEventListener("click", (e) => {
    state._editorTrigger = e.currentTarget;
    openEditor();
  });
  $("export-items-btn")?.addEventListener("click", () => {
    void exportMenuItems();
  });
  $("import-template-btn")?.addEventListener("click", () => {
    void downloadImportTemplate();
  });
  $("import-items-btn")?.addEventListener("click", () => {
    $("import-items-file")?.click();
  });
  $("import-items-file")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    void importMenuItemsFile(file);
  });
  $("fab-add").addEventListener("click", (e) => {
    state._editorTrigger = e.currentTarget;
    openEditor();
  });
  $("close-editor-btn").addEventListener("click", () => closeEditor());
  $("reset-form-btn").addEventListener("click", () => closeEditor());
  $("item-editor-dialog")?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeEditor();
  });
  document.querySelectorAll("[data-editor-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setEditorTab(btn.dataset.editorTab));
  });
  $("choose-photo-btn")?.addEventListener("click", () => $("f-photo")?.click());
  $("f-photo")?.addEventListener("change", (e) => {
    e.stopPropagation();
    onPhotoFileChosen();
  });
  $("restore-photo-btn")?.addEventListener("click", restoreOriginalPhoto);
  $("item-form").addEventListener("submit", saveItem);
  $("item-form").addEventListener("input", (e) => {
    markDirty();
    if (
      e.target &&
      ["f-description", "f-pk-detailed", "f-pk-quick"].includes(e.target.id)
    ) {
      updatePkCounts();
    }
  });
  $("item-form").addEventListener("change", markDirty);
  $("f-pk-ingredient-add")?.addEventListener("click", addIngredientFromInput);
  $("f-pk-ingredient-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addIngredientFromInput();
    }
  });
  $("f-has-variants")?.addEventListener("change", () => {
    const box = $("f-has-variants");
    if (!box.checked && state.formVariants.some((v) => v.variantId)) {
      const ok = window.confirm(
        "Turn off variants? Existing sizes stay in the database but become inactive. They are not deleted."
      );
      if (!ok) {
        box.checked = true;
        return;
      }
    }
    if (box.checked && !state.formVariants.length) {
      state.formVariants.push(blankVariantRow());
    }
    renderVariantEditor();
    markDirty();
    if ($("f-has-variants").checked) {
      const first = $("variant-list")?.querySelector("[data-v-name]");
      first?.focus();
    }
  });
  $("add-variant-btn")?.addEventListener("click", () => {
    // Adding a variant implies Has Variants ON
    if ($("f-has-variants") && !$("f-has-variants").checked) {
      $("f-has-variants").checked = true;
    }
    syncVariantsFromDom();
    state.formVariants.push(blankVariantRow());
    renderVariantEditor();
    markDirty();
    const rows = $("variant-list")?.querySelectorAll("[data-v-name]");
    rows?.[rows.length - 1]?.focus();
  });
  document.querySelectorAll("#avail-segment button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.formStatus = btn.dataset.status;
      renderSegment();
      markDirty();
    });
  });
  $("clear-photo-btn").addEventListener("click", markPhotoRemoved);
  $("add-category-btn").addEventListener("click", addCategory);
  $("f-add-category-btn")?.addEventListener("click", () => {
    void addCategoryFromItemForm();
  });
  $("f-add-subcategory-btn")?.addEventListener("click", () => {
    void addSubcategoryFromItemForm();
  });
  $("show-inactive-cats").addEventListener("change", renderCategoriesTab);

  $("instr-use-defaults")?.addEventListener("click", () => {
    state.instructionCustomized = false;
    state.selectedModIds = new Set();
    state.selectedTargetIds = new Set();
    markDirty();
    renderItemCustomization();
  });
  $("instr-customize")?.addEventListener("click", () => {
    state.instructionCustomized = true;
    if (!state.selectedModIds.size) {
      for (const m of state.kitchenLibrary.modifiers.filter((x) => x.isActive)) {
        state.selectedModIds.add(m.modifierId);
      }
    }
    if (!state.selectedTargetIds.size) {
      for (const t of state.kitchenLibrary.targets.filter((x) => x.isActive)) {
        state.selectedTargetIds.add(t.targetId);
      }
    }
    markDirty();
    renderItemCustomization();
  });
  $("mods-select-all")?.addEventListener("click", () => {
    for (const m of state.kitchenLibrary.modifiers.filter((x) => x.isActive)) {
      state.selectedModIds.add(m.modifierId);
    }
    markDirty();
    renderItemCustomization();
  });
  $("mods-clear")?.addEventListener("click", () => {
    state.selectedModIds = new Set();
    markDirty();
    renderItemCustomization();
  });
  $("tgts-select-all")?.addEventListener("click", () => {
    for (const t of state.kitchenLibrary.targets.filter((x) => x.isActive)) {
      state.selectedTargetIds.add(t.targetId);
    }
    markDirty();
    renderItemCustomization();
  });
  $("tgts-clear")?.addEventListener("click", () => {
    state.selectedTargetIds = new Set();
    markDirty();
    renderItemCustomization();
  });

  document.querySelectorAll("#instr-lib-tabs .ms-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.libTab = btn.dataset.lib;
      renderKitchenLibrary();
    });
  });
  $("lib-search")?.addEventListener("input", (e) => {
    state.libSearch = e.target.value;
    renderKitchenLibrary();
  });
  $("lib-show-inactive")?.addEventListener("change", (e) => {
    state.libShowInactive = e.target.checked;
    renderKitchenLibrary();
  });
  $("add-lib-btn")?.addEventListener("click", async () => {
    const name = $("new-lib-name").value.trim();
    if (!name) return;
    await upsertLibraryOption(null, name, true);
    $("new-lib-name").value = "";
  });
  $("new-addon-btn")?.addEventListener("click", () => openAddonEditor(null));
  $("addon-save-btn")?.addEventListener("click", saveAddonEditor);
  $("addon-cancel-btn")?.addEventListener("click", closeAddonEditor);
  $("addon-edit-name")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveAddonEditor();
    }
  });
  $("addon-search")?.addEventListener("input", (e) => {
    state.addonSearch = e.target.value;
    renderAddonsLibrary();
  });
  $("addon-show-inactive")?.addEventListener("change", (e) => {
    state.addonShowInactive = e.target.checked;
    renderAddonsLibrary();
  });
}

const CLEAN_SCOPE_LABELS = {
  transactions: "Transaction cleaning",
  items: "Clean items",
  customers: "Clean customers",
  master: "Master data cleaning",
};

function renderDataCleaningSummary(summary) {
  const host = $("data-cleaning-summary");
  if (!host) return;
  if (!summary?.counts) {
    host.textContent = "Could not load counts.";
    return;
  }
  const c = summary.counts;
  host.innerHTML = `
    <div><strong>Shop</strong> ${escapeHtml(summary.shopId)}</div>
    <div>Test orders: <strong>${c.testOrders}</strong> · All orders: <strong>${c.allOrders}</strong></div>
    <div>Menu items: <strong>${c.menuItems}</strong> · Categories: <strong>${c.categories}</strong></div>
    <div>Customers: <strong>${c.customers}</strong> · Add-ons: <strong>${c.addons}</strong></div>
    <div>Confirm with: <code>${escapeHtml(summary.confirmPhrase)}</code></div>
  `;
  const phrase = $("data-cleaning-phrase");
  if (phrase && !phrase.value) {
    phrase.placeholder = summary.confirmPhrase || "CLEAN …";
  }
}

async function openDataCleaningDialog() {
  if (state.role !== "admin") {
    toast("Admin only", true);
    return;
  }
  const dlg = $("data-cleaning-dialog");
  if (!dlg) return;
  const err = $("data-cleaning-error");
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  $("data-cleaning-summary").textContent = "Loading counts…";
  if (!dlg.open) dlg.showModal();
  const res = await api("/v1/admin/data-cleaning/summary");
  if (!res.ok) {
    $("data-cleaning-summary").textContent =
      res.json?.error || "Could not load summary.";
    return;
  }
  state.dataCleaning = res.json;
  renderDataCleaningSummary(res.json);
}

async function runDataCleaningScope(scope) {
  if (state.dataCleaningBusy) return;
  const label = CLEAN_SCOPE_LABELS[scope] || scope;
  const expected =
    state.dataCleaning?.confirmPhrase ||
    `CLEAN ${state.shop?.shopId || state.shop?.shop_id || ""}`;
  const typed = String($("data-cleaning-phrase")?.value || "").trim();
  const err = $("data-cleaning-error");
  if (typed !== expected) {
    if (err) {
      err.hidden = false;
      err.textContent = `Type ${expected} exactly to enable this action.`;
    }
    $("data-cleaning-phrase")?.focus();
    return;
  }
  if (
    !window.confirm(
      `${label} cannot be undone.\n\nShop: ${state.dataCleaning?.shopId || ""}\nContinue?`
    )
  ) {
    return;
  }
  state.dataCleaningBusy = true;
  if (err) {
    err.hidden = true;
    err.textContent = "";
  }
  try {
    const res = await api("/v1/admin/data-cleaning", {
      method: "POST",
      body: JSON.stringify({
        scope,
        confirm: true,
        confirmPhrase: typed,
      }),
    });
    if (!res.ok) {
      if (err) {
        err.hidden = false;
        err.textContent = res.json?.error || "Cleaning failed";
      }
      toast(res.json?.error || "Cleaning failed", true);
      return;
    }
    state.dataCleaning = res.json.summary || state.dataCleaning;
    renderDataCleaningSummary(state.dataCleaning);
    $("data-cleaning-phrase").value = "";
    toast(`${label} finished.`);
    if (scope === "items" || scope === "master" || scope === "customers") {
      await loadAll();
    }
  } finally {
    state.dataCleaningBusy = false;
  }
}

function bindDataCleaningSecret() {
  const badge = document.querySelector(".test-badge");
  if (!badge || badge.dataset.cleanBound === "1") return;
  badge.dataset.cleanBound = "1";
  badge.title = badge.title || "TEST";
  let timer = null;
  let armed = false;
  const clear = () => {
    if (timer) window.clearTimeout(timer);
    timer = null;
    armed = false;
  };
  const start = (event) => {
    if (state.role !== "admin") return;
    if (event.type === "mousedown" && event.button !== 0) return;
    armed = true;
    timer = window.setTimeout(() => {
      if (!armed) return;
      armed = false;
      openDataCleaningDialog();
    }, 1200);
  };
  badge.addEventListener("mousedown", start);
  badge.addEventListener("touchstart", start, { passive: true });
  badge.addEventListener("mouseup", clear);
  badge.addEventListener("mouseleave", clear);
  badge.addEventListener("touchend", clear);
  badge.addEventListener("touchcancel", clear);
  badge.addEventListener("contextmenu", (e) => e.preventDefault());

  document.querySelectorAll("[data-clean-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const scope = btn.getAttribute("data-clean-scope");
      if (scope) runDataCleaningScope(scope);
    });
  });
}

async function init() {
  bindUi();
  bindDataCleaningSecret();
  const ok = await ensureSession();
  if (ok) await bootstrap();
}

init();
