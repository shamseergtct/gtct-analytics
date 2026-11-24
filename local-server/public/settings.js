const state = {
  role: null,
  printers: [],
  stations: [],
  config: null,
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

function showMain() {
  $("login-view").hidden = true;
  $("main-view").hidden = false;
  $("session-role").textContent = state.role || "";
  const isAdmin = state.role === "admin";
  $("device-block").hidden = isAdmin;
  $("new-printer-btn").disabled = !isAdmin;
  $("save-printer-btn").disabled = !isAdmin;
  $("save-stations-btn").disabled = !isAdmin;
  if ($("add-station-btn")) $("add-station-btn").disabled = !isAdmin;
  $("preview-btn").disabled = !isAdmin;
  $("test-btn").disabled = !isAdmin;
}

function setStatus(id, message, ok = true) {
  const el = $(id);
  el.hidden = !message;
  el.textContent = message || "";
  el.className = `status-line ${ok ? "ok" : "err"}`;
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
  btn.textContent = "Signing in…";
  btn.setAttribute("aria-busy", "true");
  setLoginError("");
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
    state.role = res.json.role;
    if (state.role !== "admin") {
      setLoginError("Administrator sign-in is required for Printer Settings.");
      await api("/v1/session/logout", { method: "POST", body: "{}" });
      return;
    }
    showMain();
    await refreshAll();
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

async function ensureSession() {
  const me = await api("/v1/session/me");
  if (!me.ok || !me.json?.authenticated) {
    showLogin();
    return false;
  }
  state.role = me.json.role;
  if (state.role !== "admin") {
    showLogin("Administrator sign-in is required for Printer Settings.");
    return false;
  }
  showMain();
  return true;
}

function openPrinterEditor() {
  const dialog = $("printer-editor-dialog");
  if (!dialog) return;
  setStatus("editor-status", "", true);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  $("f-name")?.focus();
}

function closePrinterEditor() {
  const dialog = $("printer-editor-dialog");
  if (!dialog) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  document.querySelectorAll(".printer-list-item.is-selected").forEach((el) => {
    el.classList.remove("is-selected");
  });
}

function clearEditor({ open = true } = {}) {
  $("f-id").value = "";
  $("f-name").value = "";
  $("f-type").value = "MOCK";
  $("f-host").value = "";
  $("f-port").value = "9100";
  $("f-queue").value = "";
  $("f-width").value = "80";
  $("f-active").checked = true;
  $("f-physical").checked = false;
  $("f-beep").checked = true;
  $("f-format").value = "MJ330_RASTER";
  $("editor-title").textContent = "Add printer";
  toggleTypeFields();
  document.querySelectorAll(".printer-list-item.is-selected").forEach((el) => {
    el.classList.remove("is-selected");
  });
  if (open) openPrinterEditor();
}

function fillEditor(p) {
  $("f-id").value = p.printer_id;
  $("f-name").value = p.display_name || "";
  $("f-type").value = p.connection_type || "MOCK";
  $("f-host").value = p.host || "";
  $("f-port").value = p.port ?? 9100;
  $("f-queue").value = p.windows_queue_name || "";
  $("f-width").value = String(p.paper_width_mm || 80);
  $("f-active").checked = Boolean(p.is_active);
  $("f-physical").checked = Boolean(p.capabilities?.physicalDispatchEnabled);
  $("f-beep").checked = Boolean(p.capabilities?.beepOnPrint);
  $("f-format").value = p.capabilities?.format || "TEXT";
  $("editor-title").textContent = `Edit · ${p.display_name}`;
  toggleTypeFields();
  document.querySelectorAll(".printer-list-item").forEach((el) => {
    el.classList.toggle("is-selected", el.dataset.printerId === p.printer_id);
  });
  openPrinterEditor();
}

function toggleTypeFields() {
  const type = $("f-type").value;
  $("f-host").disabled = type !== "NETWORK_TCP";
  $("f-port").disabled = type !== "NETWORK_TCP";
  $("f-queue").disabled = type !== "WINDOWS_SPOOLER";
}

function printerDestination(p) {
  if (p.connection_type === "NETWORK_TCP") {
    const host = String(p.host || "").trim();
    const port = p.port == null || p.port === "" ? "" : String(p.port);
    if (!host) return "IP not set";
    return port ? `${host}:${port}` : host;
  }
  if (p.connection_type === "WINDOWS_SPOOLER") {
    return String(p.windows_queue_name || "").trim() || "Queue not set";
  }
  return "MOCK file output";
}

function renderPrinters() {
  const host = $("printer-list");
  const selectedId = $("f-id")?.value || "";
  host.innerHTML = "";
  if (!state.printers.length) {
    host.innerHTML = `<p class="empty">No printers yet. Add one to get started.</p>`;
  }
  for (const p of state.printers) {
    const stations = (p.stationIds || [])
      .map((id) => state.stations.find((s) => s.station_id === id)?.name || id)
      .join(", ");
    const dest = printerDestination(p);
    const physicalOn = Boolean(p.capabilities?.physicalDispatchEnabled);
    const soundOn = Boolean(p.capabilities?.beepOnPrint);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `printer-list-item${selectedId === p.printer_id ? " is-selected" : ""}`;
    card.dataset.printerId = p.printer_id;
    card.innerHTML = `
      <div class="printer-card-top">
        <p class="printer-card-name">${escapeHtml(p.display_name)}</p>
        <div class="printer-card-badges">
          <span class="printer-badge">${escapeHtml(p.connection_type)}</span>
          ${p.is_active ? "" : '<span class="printer-badge warn">Inactive</span>'}
          <span class="printer-badge ${physicalOn ? "ok" : "muted"}">Physical ${physicalOn ? "ON" : "OFF"}</span>
          <span class="printer-badge ${soundOn ? "ok" : "muted"}">Sound ${soundOn ? "ON" : "OFF"}</span>
        </div>
      </div>
      <div class="printer-card-dest">${escapeHtml(dest)}</div>
      <div class="printer-card-meta">
        <div>Stations · ${escapeHtml(stations || "none")}</div>
        <div>Last test · ${escapeHtml(p.last_test_status || "—")}</div>
      </div>
    `;
    card.addEventListener("click", () => fillEditor(p));
    host.appendChild(card);
  }
  const ps = state.config?.printSettings || {};
  const physicalOn = Boolean(state.config?.physicalPrintEnabled);
  const chip = $("physical-status-chip");
  if (chip) {
    chip.textContent = physicalOn ? "Physical printing · ON" : "Physical printing · OFF";
    chip.className = `printer-status-chip ${physicalOn ? "is-on" : "is-off"}`;
  }
  $("config-flags").textContent =
    `Auto setting ${Boolean(ps.autoPhysicalPrintEnabled) ? "ON" : "OFF"} · env ${
      state.config?.physicalPrintEnvOverride == null
        ? "unset"
        : String(state.config.physicalPrintEnvOverride)
    } · TCP probe ${Boolean(state.config?.allowTcpProbe) ? "ON" : "OFF"}`;
  if ($("auto-physical")) {
    $("auto-physical").checked = Boolean(ps.autoPhysicalPrintEnabled);
    $("auto-kitchen").checked = ps.kitchenAutoPrint !== false;
    $("auto-cashier").checked =
      ps.cashierAutoPrint !== false && ps.cashierAutoPrintOnPayment !== false;
    if ($("ask-before-print")) $("ask-before-print").checked = ps.askBeforePrint !== false;
  }
}

function renderStations() {
  const host = $("station-list");
  host.innerHTML = "";
  for (const s of state.stations.filter((x) => x.is_active && x.station_id)) {
    const row = document.createElement("div");
    row.className = `station-row${state.highlightStation === s.station_id ? " is-new" : ""}`;
    const options = [
      `<option value="">— none —</option>`,
      ...state.printers.map(
        (p) =>
          `<option value="${escapeHtml(p.printer_id)}" ${s.printer_id === p.printer_id ? "selected" : ""}>${escapeHtml(p.display_name)} (${escapeHtml(p.connection_type)})</option>`
      ),
    ].join("");
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(s.name)}</strong>
        <div class="muted">${escapeHtml(s.station_id)}</div>
        ${s.station_id === "station_cashier" ? "" : `<div style="display:flex;gap:6px;margin-top:0.35rem"><button type="button" class="btn ghost small" data-rename-station="${escapeHtml(s.station_id)}">Rename</button><button type="button" class="btn ghost small station-remove-btn" data-remove-station="${escapeHtml(s.station_id)}">Remove</button></div>`}
      </div>
      <select data-station="${escapeHtml(s.station_id)}">${options}</select>
    `;
    host.appendChild(row);
  }
}

async function savePrinter() {
  const body = {
    printerId: $("f-id").value || undefined,
    displayName: $("f-name").value.trim(),
    connectionType: $("f-type").value,
    host: $("f-host").value.trim() || null,
    port: $("f-port").value ? Number($("f-port").value) : null,
    windowsQueueName: $("f-queue").value.trim() || null,
    paperWidthMm: Number($("f-width").value),
    isActive: $("f-active").checked,
    capabilities: {
      physicalDispatchEnabled: $("f-physical").checked,
      beepOnPrint: $("f-beep").checked,
      format: $("f-format").value || "TEXT",
    },
  };
  const res = await api("/v1/printers", {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    setStatus("editor-status", res.json?.error || "Save failed", false);
    return;
  }
  await refreshAll();
  closePrinterEditor();
  clearEditor({ open: false });
}

async function putStation(body) {
  const res = await api("/v1/stations", { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    setStatus("station-status", res.json?.error || "Station save failed", false);
    return false;
  }
  return true;
}

async function addStation() {
  const input = $("new-station-name");
  const name = input.value.trim();
  if (name.length < 2) {
    setStatus("station-status", "Type a station name first, e.g. SANDWICH.", false);
    input.focus();
    return;
  }
  const btn = $("add-station-btn");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const res = await api("/v1/stations", {
      method: "PUT",
      body: JSON.stringify({ name, isActive: true, printerId: null }),
    });
    if (!res.ok) {
      setStatus("station-status", res.json?.error || "Station save failed", false);
      return;
    }
    input.value = "";
    state.highlightStation = res.json.station?.station_id || null;
    await refreshAll();
    setStatus(
      "station-status",
      `✓ Station ${res.json.station?.name || name.toUpperCase()} added successfully. Choose its printer, then press Save assignments.`,
      true
    );
    setTimeout(() => {
      state.highlightStation = null;
      document.querySelector(".station-row.is-new")?.classList.remove("is-new");
    }, 2500);
  } finally {
    btn.disabled = false;
  }
}

async function removeStationSetting(stationId) {
  const station = state.stations.find((s) => s.station_id === stationId);
  if (!station) return;
  if (!window.confirm(`Remove station ${station.name}?`)) return;
  const res = await api(`/v1/stations/${encodeURIComponent(stationId)}`, { method: "DELETE" });
  if (!res.ok) {
    setStatus("station-status", res.json?.error || "Could not remove the station.", false);
    return;
  }
  await refreshAll();
  setStatus("station-status", `✓ Station ${station.name} removed.`, true);
}

async function renameStation(stationId) {
  const station = state.stations.find((s) => s.station_id === stationId);
  if (!station) return;
  const name = window.prompt(
    `New name for ${station.name}.\nMenu items keep this station; only the name changes. Update the preparation_center column in your menu file to match.`,
    station.name
  );
  if (name == null || !name.trim() || name.trim().toUpperCase() === station.name) return;
  const ok = await putStation({
    stationId,
    name: name.trim(),
    description: station.description || "",
    isActive: Boolean(station.is_active),
    printerId: station.printer_id || null,
  });
  if (!ok) return;
  await refreshAll();
  setStatus("station-status", `Renamed to ${name.trim().toUpperCase()}.`, true);
}

async function saveStations() {
  const selects = [...document.querySelectorAll("#station-list select")];
  for (const sel of selects) {
    const stationId = sel.getAttribute("data-station");
    const station = state.stations.find((s) => s.station_id === stationId);
    if (!station) continue;
    const res = await api("/v1/stations", {
      method: "PUT",
      body: JSON.stringify({
        stationId,
        name: station.name,
        description: station.description || "",
        isActive: Boolean(station.is_active),
        printerId: sel.value || null,
      }),
    });
    if (!res.ok) {
      setStatus("station-status", res.json?.error || "Station save failed", false);
      return;
    }
  }
  setStatus("station-status", "Station assignments saved", true);
  await refreshAll();
}

async function previewTicket() {
  const id = $("f-id").value;
  if (!id) {
    setStatus("editor-status", "Save or select a printer first", false);
    return;
  }
  const res = await api(`/v1/printers/${encodeURIComponent(id)}/preview`, {
    method: "POST",
    body: "{}",
  });
  if (!res.ok) {
    setStatus("editor-status", res.json?.error || "Preview failed", false);
    return;
  }
  $("preview-title").textContent = `${res.json.connectionType} · ${res.json.destination}`;
  $("preview-text").textContent = res.json.text || "";
  $("preview-dialog").showModal();
}

async function safeTest() {
  const id = $("f-id").value;
  if (!id) {
    setStatus("editor-status", "Save or select a printer first", false);
    return;
  }
  const printer = state.printers.find((p) => p.printer_id === id);
  const mode = printer?.connection_type === "MOCK" ? "mock_file" : "preview";
  const res = await api(`/v1/printers/${encodeURIComponent(id)}/test`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    setStatus("editor-status", res.json?.error || "Test failed", false);
    return;
  }
  setStatus(
    "editor-status",
    `Safe test OK (${res.json.mode}). Physical data sent: ${res.json.physicalDataSent}`,
    true
  );
  if (res.json.text) {
    $("preview-title").textContent = `Safe test · ${res.json.mode}`;
    $("preview-text").textContent = res.json.text;
    $("preview-dialog").showModal();
  }
  await refreshAll();
}

async function refreshJobs() {
  const res = await api("/v1/print-jobs");
  const host = $("job-history");
  if (!res.ok) {
    host.innerHTML = `<p class="error">${escapeHtml(res.json?.error || "Failed")}</p>`;
    return;
  }
  const jobs = res.json.jobs || [];
  if (!jobs.length) {
    host.innerHTML = `<p class="empty">No print jobs yet.</p>`;
    return;
  }
  host.innerHTML = jobs
    .slice(0, 40)
    .map((j) => {
      let items = "";
      try {
        const payload = JSON.parse(j.payload_snapshot || "{}");
        items = (payload.items || []).map((i) => i.name).join(", ");
      } catch {
        items = "";
      }
      const err = j.last_error ? `<div class="muted">${escapeHtml(j.last_error)}</div>` : "";
      return `<div class="job-row">
        <span class="status-badge ${escapeHtml(j.status)}">${escapeHtml(j.status)}</span>
        <strong>${escapeHtml(j.job_type)}</strong>
        <span class="muted">${escapeHtml(j.station_id || "—")}</span>
        <span class="muted">${escapeHtml(j.printer_id)}</span>
        <span>${escapeHtml(items)}</span>
        ${err}
      </div>`;
    })
    .join("");
}

async function clearJobHistory() {
  if (
    !window.confirm(
      "Clear finished print-job history? PENDING jobs stay. This does not reprint anything."
    )
  ) {
    return;
  }
  const res = await api("/v1/print-jobs/clear-history", {
    method: "POST",
    body: "{}",
  });
  if (!res.ok) {
    setStatus("jobs-status", res.json?.error || "Clear failed", false);
    return;
  }
  setStatus("jobs-status", `Cleared ${Number(res.json?.cleared || 0)} job(s).`, true);
  await refreshJobs();
}

async function savePrintSettings() {
  const res = await api("/v1/print-settings", {
    method: "PUT",
    body: JSON.stringify({
      autoPhysicalPrintEnabled: $("auto-physical").checked,
      kitchenAutoPrint: $("auto-kitchen").checked,
      cashierAutoPrint: $("auto-cashier").checked,
      askBeforePrint: $("ask-before-print")?.checked !== false,
    }),
  });
  if (!res.ok) {
    setStatus("print-settings-status", res.json?.error || "Save failed", false);
    return;
  }
  const held = Number(res.json?.settings?.heldPendingJobs || 0);
  setStatus(
    "print-settings-status",
    held
      ? `Saved. Held ${held} older PENDING job(s) from before enable.`
      : "Print settings saved.",
    true
  );
  await refreshAll();
}

async function refreshAll() {
  const [cfg, printers, stations] = await Promise.all([
    api("/v1/config"),
    api("/v1/printers"),
    api("/v1/stations"),
  ]);
  if (!cfg.ok || !printers.ok || !stations.ok) {
    if (cfg.status === 401 || printers.status === 401) showLogin("Session expired.");
    return;
  }
  state.config = cfg.json;
  state.printers = printers.json.printers || [];
  state.stations = stations.json.stations || [];
  renderPrinters();
  for (const [section, printerId] of [["manual-kot", "mj330-manual-test"], ["manual-receipt", "mj330-manual-receipt"]]) {
    const manual = state.printers.find(p => p.printer_id === printerId);
    $(section).hidden = !(state.config?.physicalPrintEnabled && manual?.is_active &&
      manual.connection_type === "NETWORK_TCP" && manual.host === "192.168.0.110" &&
      manual.port === 9100 && manual.capabilities?.physicalDispatchEnabled);
    if (manual?.last_test_status?.startsWith("ATTEMPTED")) {
      $(section + "-btn").disabled = true;
      $(section + "-result").textContent = "Test already attempted. Check the paper at the printer.";
    }
  }
  renderStations();
  await refreshJobs();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function bindUi() {
  $("save-print-settings-btn")?.addEventListener("click", savePrintSettings);
  $("clear-jobs-btn")?.addEventListener("click", clearJobHistory);
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
  $("new-printer-btn").addEventListener("click", () => clearEditor({ open: true }));
  $("editor-close-btn")?.addEventListener("click", () => {
    closePrinterEditor();
    clearEditor({ open: false });
  });
  $("editor-cancel-btn")?.addEventListener("click", () => {
    closePrinterEditor();
    clearEditor({ open: false });
  });
  $("printer-editor-dialog")?.addEventListener("cancel", () => {
    clearEditor({ open: false });
  });
  $("f-type").addEventListener("change", toggleTypeFields);
  $("save-printer-btn").addEventListener("click", savePrinter);
  $("save-stations-btn").addEventListener("click", saveStations);
  $("add-station-btn").addEventListener("click", addStation);
  $("new-station-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addStation();
    }
  });
  $("station-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rename-station]");
    if (btn) renameStation(btn.getAttribute("data-rename-station"));
    const rm = e.target.closest("[data-remove-station]");
    if (rm) removeStationSetting(rm.getAttribute("data-remove-station"));
  });
  $("preview-btn").addEventListener("click", previewTicket);
  for (const [section, printerId, mode] of [
    ["manual-kot", "mj330-manual-test", "manual_mj330_kot"],
    ["manual-receipt", "mj330-manual-receipt", "manual_mj330_receipt"],
  ]) {
    $(section + "-btn").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      const status = $(section + "-result");
      status.textContent = "Sending one test ticket…";
      try {
        const res = await api(`/v1/printers/${printerId}/test`, {
          method: "POST", body: JSON.stringify({ mode }),
        });
        status.textContent = res.ok ? "Sent to printer. Please confirm paper output." :
          (res.json?.error || "Outcome uncertain. Check the printer.");
      } catch {
        status.textContent = "Outcome uncertain. Check the printer. No automatic retry.";
      }
    });
  }
  $("test-btn").addEventListener("click", safeTest);
  $("refresh-jobs-btn").addEventListener("click", refreshJobs);
  $("preview-close").addEventListener("click", () => $("preview-dialog").close());
}

async function init() {
  bindUi();
  clearEditor({ open: false });
  const ok = await ensureSession();
  if (ok) await refreshAll();
}

init();
