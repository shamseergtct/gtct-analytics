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

function clearEditor() {
  $("f-id").value = "";
  $("f-name").value = "";
  $("f-type").value = "MOCK";
  $("f-host").value = "";
  $("f-port").value = "9100";
  $("f-queue").value = "";
  $("f-width").value = "80";
  $("f-active").checked = true;
  $("f-physical").checked = false;
  $("editor-title").textContent = "Add printer";
  toggleTypeFields();
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
  $("editor-title").textContent = `Edit: ${p.display_name}`;
  toggleTypeFields();
}

function toggleTypeFields() {
  const type = $("f-type").value;
  $("f-host").disabled = type !== "NETWORK_TCP";
  $("f-port").disabled = type !== "NETWORK_TCP";
  $("f-queue").disabled = type !== "WINDOWS_SPOOLER";
}

function renderPrinters() {
  const host = $("printer-list");
  host.innerHTML = "";
  for (const p of state.printers) {
    const stations = (p.stationIds || [])
      .map((id) => state.stations.find((s) => s.station_id === id)?.name || id)
      .join(", ");
    const dest =
      p.connection_type === "NETWORK_TCP"
        ? `${p.host}:${p.port}`
        : p.connection_type === "WINDOWS_SPOOLER"
          ? p.windows_queue_name
          : "MOCK file";
    const card = document.createElement("button");
    card.type = "button";
    card.className = "printer-list-item";
    card.innerHTML = `
      <strong>${escapeHtml(p.display_name)}</strong>
      <span class="pill">${escapeHtml(p.connection_type)}</span>
      ${p.is_active ? "" : '<span class="pill warn">INACTIVE</span>'}
      <div class="muted">${escapeHtml(dest || "—")}</div>
      <div class="muted">Stations: ${escapeHtml(stations || "none")}</div>
      <div class="muted">Status: ${escapeHtml(p.last_test_status || "—")}</div>
      <div class="muted">Physical flag: ${p.capabilities?.physicalDispatchEnabled ? "ON" : "OFF"} · Server physical: ${state.config?.physicalPrintEnabled ? "ON" : "OFF"}</div>
    `;
    card.addEventListener("click", () => fillEditor(p));
    host.appendChild(card);
  }
  $("config-flags").textContent = `Server: physicalPrint=${Boolean(state.config?.physicalPrintEnabled)} · tcpProbe=${Boolean(state.config?.allowTcpProbe)}.`;
}

function renderStations() {
  const host = $("station-list");
  host.innerHTML = "";
  for (const s of state.stations) {
    const row = document.createElement("div");
    row.className = "station-row";
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
  setStatus("editor-status", `Saved ${res.json.printer.display_name}`, true);
  await refreshAll();
  fillEditor(res.json.printer);
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
      return `<div class="job-row">
        <span class="status-badge ${escapeHtml(j.status)}">${escapeHtml(j.status)}</span>
        <strong>${escapeHtml(j.job_type)}</strong>
        <span class="muted">${escapeHtml(j.station_id || "—")}</span>
        <span class="muted">${escapeHtml(j.printer_id)}</span>
        <span>${escapeHtml(items)}</span>
      </div>`;
    })
    .join("");
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
  $("new-printer-btn").addEventListener("click", clearEditor);
  $("f-type").addEventListener("change", toggleTypeFields);
  $("save-printer-btn").addEventListener("click", savePrinter);
  $("save-stations-btn").addEventListener("click", saveStations);
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
  clearEditor();
  const ok = await ensureSession();
  if (ok) await refreshAll();
}

init();
