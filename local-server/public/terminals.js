const state = {
  role: null,
  staff: false,
  permissions: [],
  terminals: [],
  lan: null,
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

function canManage() {
  return state.role === "admin" && state.staff && state.permissions.includes("staff.manage");
}

function setStatus(message = "", ok = true) {
  const el = $("terminal-status");
  el.hidden = !message;
  el.textContent = message || "";
  el.className = `status-line ${ok ? "ok" : "err"}`;
}

function showLogin(message = "") {
  $("login-view").hidden = false;
  $("main-view").hidden = true;
  setLoginError(message);
}

function showMain() {
  $("login-view").hidden = true;
  $("main-view").hidden = false;
  $("session-role").textContent = state.role || "";
  const allowed = canManage();
  $("denied-block").hidden = allowed;
  $("admin-shell").hidden = !allowed;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderQr(el, text) {
  el.innerHTML = "";
  if (!text || typeof window.qrcode !== "function") return;
  try {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  } catch {
    el.textContent = "";
  }
}

function renderLan() {
  const lan = state.lan || {};
  const ready = lan.lanAccessReady === true && Boolean(lan.browseUrl);
  const offline = $("connect-offline");
  const grid = $("connect-grid");
  if (ready) {
    offline.hidden = true;
    grid.hidden = false;
    $("url-browse").textContent = lan.browseUrl;
    $("url-pair").textContent = lan.pairUrl || "";
    renderQr($("qr-browse"), lan.browseUrl);
    renderQr($("qr-pair"), lan.pairUrl || "");
    $("lan-status").textContent = `Network ready · ${lan.browseUrl}`;
  } else {
    grid.hidden = true;
    offline.hidden = false;
    offline.textContent =
      "Other devices cannot connect yet: the app is running on this computer only. " +
      "Make sure this PC is connected to the shop Wi-Fi or a LAN cable. The app switches to the network by itself within about a minute; then open this page again.";
    $("lan-status").textContent = lan.browseUrl ? `This computer only · ${lan.browseUrl}` : "This computer only.";
  }
  $("lan-note").textContent = [
    lan.namedUrl ? `PC name address: ${lan.namedUrl}` : "",
    lan.physicalPrintEnabled ? "Physical print: ON" : "Physical print: off",
  ]
    .filter(Boolean)
    .join(" · ");
}

function renderList() {
  const host = $("terminal-list");
  if (!state.terminals.length) {
    host.innerHTML = `<p class="empty">No terminals yet. Add Cashier 1, Counter iPad, etc.</p>`;
    return;
  }
  host.innerHTML = state.terminals
    .map((t) => {
      const paired = t.paired ? "Paired" : "Not paired";
      const active = t.isActive ? "Active" : "Inactive";
      return `<article class="user-card" data-id="${escapeHtml(t.terminalId)}">
        <div>
          <strong>${escapeHtml(t.displayName)}</strong>
          <div class="muted">${escapeHtml(t.code)} · ${escapeHtml(t.purpose)} · ${active} · ${paired}</div>
          <div class="muted">${t.lastSeenAt ? `Last seen ${escapeHtml(t.lastSeenAt)}` : "Never seen"}</div>
        </div>
        <div class="user-card-actions">
          <button type="button" class="btn ghost" data-act="edit">Edit</button>
          <button type="button" class="btn primary" data-act="pair">Pair code</button>
          <button type="button" class="btn ghost" data-act="revoke" ${t.paired ? "" : "disabled"}>Revoke</button>
        </div>
      </article>`;
    })
    .join("");
}

async function loadTerminals() {
  const res = await api("/v1/terminals");
  if (!res.ok) {
    setStatus(res.json?.error || "Could not load terminals.", false);
    return;
  }
  state.terminals = res.json.terminals || [];
  state.lan = res.json.lan || null;
  renderLan();
  renderList();
}

function openEditor(terminal = null) {
  $("terminal-editor").hidden = false;
  $("editor-title").textContent = terminal ? "Edit terminal" : "New terminal";
  $("terminal-id").value = terminal?.terminalId || "";
  $("terminal-name").value = terminal?.displayName || "";
  $("terminal-code").value = terminal?.code || "";
  $("terminal-purpose").value = terminal?.purpose || "any";
  $("terminal-active").checked = terminal ? Boolean(terminal.isActive) : true;
}

async function saveTerminal() {
  const body = {
    terminalId: $("terminal-id").value || undefined,
    displayName: $("terminal-name").value.trim(),
    code: $("terminal-code").value.trim(),
    purpose: $("terminal-purpose").value,
    isActive: $("terminal-active").checked,
  };
  const res = await api("/v1/terminals", { method: "PUT", body: JSON.stringify(body) });
  if (!res.ok) {
    setStatus(res.json?.error || "Save failed.", false);
    return;
  }
  $("terminal-editor").hidden = true;
  setStatus("Terminal saved.", true);
  await loadTerminals();
}

async function issuePair(terminalId) {
  const res = await api(`/v1/terminals/${encodeURIComponent(terminalId)}/pairing-code`, {
    method: "POST",
    body: "{}",
  });
  if (!res.ok) {
    setStatus(res.json?.error || "Could not create pairing code.", false);
    return;
  }
  $("pairing-box").hidden = false;
  $("pairing-meta").textContent = `${res.json.displayName} · expires ${res.json.expiresAt}`;
  $("pairing-code").textContent = res.json.code;
}

async function revokePair(terminalId) {
  if (!window.confirm("Revoke this terminal’s pairing? The tablet must pair again.")) return;
  const res = await api(`/v1/terminals/${encodeURIComponent(terminalId)}/revoke`, {
    method: "POST",
    body: "{}",
  });
  if (!res.ok) {
    setStatus(res.json?.error || "Revoke failed.", false);
    return;
  }
  setStatus("Pairing revoked.", true);
  await loadTerminals();
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
  showLogin();
}

async function ensureSession() {
  const me = await api("/v1/session/me");
  if (!me.ok || !me.json?.authenticated) {
    showLogin();
    return false;
  }
  state.role = me.json.role;
  state.staff = Boolean(me.json.staff);
  state.permissions = me.json.permissions || [];
  showMain();
  if (canManage()) await loadTerminals();
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
  $("add-terminal-btn").addEventListener("click", () => openEditor(null));
  $("cancel-terminal-btn").addEventListener("click", () => {
    $("terminal-editor").hidden = true;
  });
  $("save-terminal-btn").addEventListener("click", saveTerminal);
  $("close-pairing-btn").addEventListener("click", () => {
    $("pairing-box").hidden = true;
  });
  $("terminal-list").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-act]");
    const card = event.target.closest("[data-id]");
    if (!btn || !card) return;
    const id = card.getAttribute("data-id");
    const terminal = state.terminals.find((t) => t.terminalId === id);
    if (!terminal) return;
    if (btn.dataset.act === "edit") openEditor(terminal);
    if (btn.dataset.act === "pair") issuePair(id);
    if (btn.dataset.act === "revoke") revokePair(id);
  });
}

bindUi();
ensureSession();
