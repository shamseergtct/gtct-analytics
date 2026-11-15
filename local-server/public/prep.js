import { registerPwa } from "./pwa.js";
registerPwa();

const state = {
  role: null,
  staff: false,
  permissions: [],
  fullName: "",
  stationId: localStorage.getItem("gtct.prepStation") || "",
  board: null,
  busy: false,
  seenNew: null,
  finishedOpen: false,
  finishedQuery: "",
  focusOrderId: null,
  focusStationId: null,
  focusRevision: "",
  focusReturnTo: null,
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

let audioCtx = null;

function unlockAudio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  if (!audioCtx) audioCtx = new AudioCtx();
  if (audioCtx.state === "suspended") void audioCtx.resume();
}

function playNewOrderSound() {
  unlockAudio();
  if (!audioCtx || audioCtx.state !== "running") return;
  const start = audioCtx.currentTime;
  [880, 1175].forEach((freq, index) => {
    const when = start + index * 0.22;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.25, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.18);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(when);
    osc.stop(when + 0.2);
  });
}

function ticketKey(ticket) {
  return `${ticket.orderId}:${ticket.updated || ticket.edited ? "edited" : "new"}`;
}

let wakeLock = null;

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.hidden || $("main-view")?.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function dismissWakeBanner() {
  const banner = $("prep-wake-banner");
  if (!banner) return;
  banner.hidden = true;
  document.body.classList.remove("prep-glow");
}

function showWakeBanner(text) {
  const banner = $("prep-wake-banner");
  if (!banner) return;
  $("prep-wake-text").textContent = text;
  banner.hidden = false;
  document.body.classList.add("prep-glow");
  window.clearTimeout(showWakeBanner._t);
  showWakeBanner._t = window.setTimeout(() => dismissWakeBanner(), 25000);
}

function pushDesktopNotification(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const note = new Notification(title, {
      body,
      tag: "gtct-prep-new",
      renotify: true,
    });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    /* ignore unsupported environments */
  }
}

function ensureNotificationPermission() {
  if (!("Notification" in window) || Notification.permission !== "default") return;
  try {
    void Notification.requestPermission();
  } catch {
    /* ignore */
  }
}

function showOrderNotices(arrivals) {
  const host = $("prep-alerts");
  if (!host) return;
  const fresh = arrivals.filter((ticket) => !(ticket.updated || ticket.edited));
  const edited = arrivals.filter((ticket) => ticket.updated || ticket.edited);
  const parts = [];
  if (fresh.length) parts.push(countLabel(fresh.length, "new order", "new orders"));
  if (edited.length) parts.push(countLabel(edited.length, "edited order", "edited orders"));
  const summary = parts.join(" · ") || countLabel(arrivals.length, "new order", "new orders");

  const note = document.createElement("button");
  note.type = "button";
  note.className = edited.length && !fresh.length ? "prep-alert updated" : "prep-alert";
  note.setAttribute("aria-label", `Dismiss ${summary}`);
  note.innerHTML = `<span>Incoming</span><strong>${escapeHtml(summary)}</strong>`;
  note.addEventListener("click", () => note.remove());
  host.prepend(note);
  window.setTimeout(() => note.remove(), 25000);

  showWakeBanner(summary);
  pushDesktopNotification("GTCT Preparation", summary);
  if (navigator.vibrate) {
    try {
      navigator.vibrate([180, 80, 180]);
    } catch {
      /* ignore */
    }
  }
}

function noticeNewOrders(tickets) {
  const fresh = (tickets || []).filter((ticket) => ticket.status === "NEW");
  const incoming = new Set(fresh.map(ticketKey));
  if (state.seenNew) {
    const arrivals = fresh.filter((ticket) => !state.seenNew.has(ticketKey(ticket)));
    if (arrivals.length) {
      playNewOrderSound();
      showOrderNotices(arrivals);
      // Try to bring the prep tab forward when the tablet was idle/backgrounded.
      try {
        window.focus();
      } catch {
        /* ignore */
      }
    }
  }
  state.seenNew = incoming;
}

function canWork() {
  if (state.role === "admin") return true;
  return state.staff && state.permissions.includes("prep.station.work");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function when(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatToken(ticket) {
  if (ticket?.tokenNumber == null || ticket.tokenNumber === "") return "";
  const n = Number(ticket.tokenNumber);
  if (!Number.isFinite(n)) return String(ticket.tokenNumber);
  return String(Math.trunc(n)).padStart(3, "0");
}

function tokenBadgeHtml(ticket) {
  const token = formatToken(ticket);
  if (!token) return "";
  return `<span class="prep-token" title="Token number">TOKEN ${escapeHtml(token)}</span>`;
}

function placeLine(ticket) {
  if (ticket.fulfillmentBehavior === "TABLE") {
    return ticket.tableNumber ? `Table ${ticket.tableNumber}` : "Dine in";
  }
  if (ticket.fulfillmentBehavior === "CAR_HOP") {
    return [ticket.vehicleNumber, ticket.parkingLocation].filter(Boolean).join(" · ");
  }
  if (ticket.fulfillmentBehavior === "DELIVERY") {
    return [
      ticket.customerName,
      ticket.blockNumber ? `Block ${ticket.blockNumber}` : "",
      ticket.buildingNumber ? `Building ${ticket.buildingNumber}` : "",
      ticket.roadNumber ? `Road ${ticket.roadNumber}` : "",
    ].filter(Boolean).join(" · ");
  }
  return [ticket.customerName, ticket.customerPhone].filter(Boolean).join(" · ");
}

function qty(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : String(number);
}

function lineHtml(line) {
  const notes = [
    line.variantName,
    ...(line.instructions || []),
    ...(line.addons || []).map((addon) =>
      addon.quantity > 1 ? `${addon.name} × ${addon.quantity}` : addon.name
    ),
  ].filter(Boolean);
  const voided = Boolean(line.voided);
  return `<li class="${voided ? "prep-line-voided" : ""}">
    <strong>${escapeHtml(qty(line.quantity))} × ${escapeHtml(line.name)}${
      voided ? ` <span class="prep-void-tag">Voided</span>` : ""
    }</strong>
    ${notes.map((note) => `<div class="prep-note">${escapeHtml(note)}</div>`).join("")}
  </li>`;
}

function cardHtml(ticket) {
  const place = placeLine(ticket);
  const isPreparing = ticket.status === "ACCEPTED";
  const isFinished = ticket.status === "FINISHED";
  const isEdited = Boolean(ticket.updated || ticket.edited);
  const actions = ticket.status === "NEW"
    ? `<div class="prep-actions"><button type="button" class="btn primary" data-accept="${escapeHtml(ticket.orderId)}">Accept</button></div>`
    : "";
  const token = formatToken(ticket);
  const top = isPreparing
    ? `role="button" tabindex="0" data-focus="${escapeHtml(ticket.orderId)}" aria-label="Open preparing order ${escapeHtml(ticket.orderNumber)}${token ? ` token ${token}` : ""}"`
    : "";
  return `<article class="prep-card ${isFinished ? "finished" : ""} ${isPreparing ? "prep-card-openable" : ""} ${isEdited ? "updated edited" : ""}" ${top}>
    <div class="prep-card-head">
      <div class="prep-card-title">
        ${tokenBadgeHtml(ticket)}
        <strong>${escapeHtml(ticket.orderNumber)}</strong>
      </div>
      <span class="prep-time">${escapeHtml(when(ticket.createdAt))}</span>
    </div>
    <div class="prep-card-meta">
      <span class="prep-order-type">${escapeHtml(ticket.orderTypeName || "")}</span>
      ${isEdited ? `<span class="prep-updated">Edited</span>` : ""}
    </div>
    ${place ? `<div class="prep-place" title="${escapeHtml(place)}">${escapeHtml(place)}</div>` : ""}
    <ul class="prep-lines">${(ticket.lines || []).map(lineHtml).join("")}</ul>
    ${isPreparing ? `<span class="prep-open-indicator" aria-hidden="true">View order →</span>` : ""}
    ${actions}
  </article>`;
}

function updateHtml(id, html) {
  const host = $(id);
  // Preserve keyboard focus and scroll position during background polling.
  if (host.innerHTML !== html) host.innerHTML = html;
}

function searchText(ticket) {
  return [
    ticket.orderNumber, formatToken(ticket), ticket.orderTypeName, ticket.customerName,
    ticket.customerPhone, ticket.blockNumber, ticket.buildingNumber,
    ticket.roadNumber, ...(ticket.lines || []).flatMap((line) => [
      line.name, line.variantName, ...(line.instructions || []),
      ...(line.addons || []).map((addon) => addon.name),
    ]),
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function renderFinished(tickets) {
  if (!state.finishedOpen) return;
  const query = state.finishedQuery.trim().toLocaleLowerCase();
  const matching = tickets.filter((ticket) => !query || searchText(ticket).includes(query));
  updateHtml("prep-finished-list", matching.map(cardHtml).join(""));
  $("prep-finished-empty").hidden = matching.length > 0;
}

function closeFocus(restoreFocus = true) {
  const trigger = state.focusReturnTo;
  state.focusOrderId = null;
  state.focusStationId = null;
  state.focusRevision = "";
  state.focusReturnTo = null;
  $("prep-focus-backdrop").hidden = true;
  document.body.classList.remove("prep-focus-open");
  $("prep-shell").inert = false;
  document.querySelector(".topbar").inert = false;
  $("prep-focus-feedback").textContent = "";
  if (restoreFocus && trigger) {
    const replacement = [...$("prep-preparing-list").querySelectorAll("[data-focus]")]
      .find((item) => item.dataset.focus === trigger);
    if (replacement) replacement.focus();
  }
}

function renderFocus(tickets) {
  if (!state.focusOrderId) return;
  const ticket = tickets.find((row) => row.orderId === state.focusOrderId && row.status === "ACCEPTED");
  if (!ticket || state.focusStationId !== state.stationId) {
    closeFocus(false);
    return;
  }
  if (state.focusRevision === ticket.revision) return;
  state.focusRevision = ticket.revision;
  const token = formatToken(ticket);
  const tokenEl = $("prep-focus-token");
  if (tokenEl) {
    tokenEl.hidden = !token;
    tokenEl.textContent = token ? `TOKEN ${token}` : "";
  }
  $("prep-focus-number").textContent = ticket.orderNumber;
  $("prep-focus-meta").textContent = [ticket.orderTypeName, when(ticket.createdAt)].filter(Boolean).join(" · ");
  const place = placeLine(ticket);
  $("prep-focus-body").innerHTML = `
    ${place ? `<p class="prep-focus-place">${escapeHtml(place)}</p>` : ""}
    <ul class="prep-focus-lines">${(ticket.lines || []).map(lineHtml).join("")}</ul>`;
  $("prep-focus-finish").disabled = state.busy || !canWork();
}

function openFocus(orderId) {
  const ticket = (state.board?.tickets || []).find((row) => row.orderId === orderId && row.status === "ACCEPTED");
  if (!ticket) return;
  state.focusOrderId = orderId;
  state.focusStationId = state.stationId;
  state.focusReturnTo = orderId;
  state.focusRevision = "";
  $("prep-focus-feedback").textContent = "";
  $("prep-focus-backdrop").hidden = false;
  document.body.classList.add("prep-focus-open");
  $("prep-shell").inert = true;
  document.querySelector(".topbar").inert = true;
  renderFocus(state.board.tickets || []);
  $("prep-focus-close").focus();
}

function render() {
  const board = state.board;
  const stations = board?.stations || [];
  const stationHtml = stations.map((station) => {
    const selected = station.stationId === state.stationId;
    return `<button type="button" class="chip" role="tab" aria-selected="${selected}" data-station="${escapeHtml(station.stationId)}">${escapeHtml(station.name)}</button>`;
  }).join("");
  updateHtml("station-tabs", stationHtml);
  $("station-title").textContent = board?.station?.name || "Preparation";
  const tickets = board?.tickets || [];
  const preparing = tickets.filter((ticket) => ticket.status === "ACCEPTED");
  const news = tickets.filter((ticket) => ticket.status === "NEW");
  const finished = tickets.filter((ticket) => ticket.status === "FINISHED")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  $("prep-preparing-count").textContent = preparing.length;
  $("prep-new-count").textContent = news.length;
  $("prep-finished-count").textContent = finished.length;
  updateHtml("prep-preparing-list", preparing.length
    ? preparing.map(cardHtml).join("")
    : `<div class="prep-empty">No orders preparing</div>`);
  updateHtml("prep-new-list", news.length
    ? news.map(cardHtml).join("")
    : `<div class="prep-empty">No new orders</div>`);
  renderFinished(finished);
  renderFocus(tickets);
  $("prep-status").textContent = board?.station ? "" : "No preparation stations are set up.";
}

async function loadBoard() {
  if (!canWork() || state.busy) return;
  const query = state.stationId ? `?stationId=${encodeURIComponent(state.stationId)}` : "";
  const result = await api(`/v1/prep-board${query}`);
  if (result.status === 401) {
    showLogin("Sign in to work a preparation station.");
    return;
  }
  if (!result.ok) {
    if (result.status === 403 && state.stationId && state.role === "kitchen") {
      // A station saved by another account on this browser is not an authorization.
      state.stationId = "";
      localStorage.removeItem("gtct.prepStation");
      return loadBoard();
    }
    $("prep-status").textContent = result.json?.error || "Could not load this station.";
    return;
  }
  state.board = result.json;
  if (result.json.station?.stationId) {
    state.stationId = result.json.station.stationId;
    localStorage.setItem("gtct.prepStation", state.stationId);
  } else {
    state.stationId = "";
    localStorage.removeItem("gtct.prepStation");
  }
  render();
  noticeNewOrders(result.json.tickets || []);
}

async function mark(orderId, action) {
  if (state.busy || !state.stationId) return;
  const ticket = (state.board?.tickets || []).find((row) => row.orderId === orderId);
  if (!ticket || !ticket.revision) {
    $("prep-status").textContent = "Refresh the preparation board before updating this order.";
    void loadBoard();
    return;
  }
  state.busy = true;
  $("prep-focus-finish").disabled = true;
  let result;
  try {
    result = await api(`/v1/prep-board/${action}`, {
      method: "POST",
      body: JSON.stringify({
        orderId,
        stationId: state.stationId,
        expectedStatus: ticket.status,
        expectedRevision: ticket.revision,
      }),
    });
  } catch {
    result = { ok: false, status: 0, json: { error: "Connection lost. Check the current ticket before trying again." } };
  }
  state.busy = false;
  $("prep-focus-finish").disabled = false;
  if (!result.ok) {
    const message = result.status === 409
      ? "Another staff member or an order edit changed this ticket. Review the refreshed board."
      : result.json?.error || "Could not update that order.";
    // Refresh but preserve a visible conflict message after rendering.
    await loadBoard();
    $("prep-status").textContent = message;
    if (state.focusOrderId === orderId) $("prep-focus-feedback").textContent = message;
    return;
  }
  await loadBoard();
}

function showLogin(message = "") {
  closeFocus(false);
  $("login-view").hidden = false;
  $("main-view").hidden = true;
  $("login-error").hidden = !message;
  $("login-error").textContent = message;
}

function showMain() {
  $("login-view").hidden = true;
  $("main-view").hidden = false;
  $("session-role").textContent = state.fullName || state.role || "";
  const allowed = canWork();
  for (const a of document.querySelectorAll('#app-nav a[href="/"], #app-nav a[href="/orders.html"]')) {
    a.hidden = state.role === "kitchen";
  }
  $("prep-denied").hidden = allowed;
  $("prep-shell").hidden = !allowed;
  if (allowed) {
    void loadBoard();
    void requestWakeLock();
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
  if (!me.ok) {
    showLogin("Sign-in failed.");
    return;
  }
  state.role = me.json.role;
  state.staff = Boolean(me.json.staff);
  state.permissions = me.json.permissions || [];
  state.fullName = me.json.fullName || "";
  showMain();
}

document.addEventListener("pointerdown", () => {
  unlockAudio();
  ensureNotificationPermission();
  void requestWakeLock();
});
$("prep-wake-banner")?.addEventListener("click", () => dismissWakeBanner());
$("login-btn").addEventListener("click", () => {
  unlockAudio();
  ensureNotificationPermission();
  void login();
});
$("nav-menu-btn").addEventListener("click", () => {
  const open = !document.body.classList.contains("nav-menu-open");
  document.body.classList.toggle("nav-menu-open", open);
  $("nav-menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
});
$("logout-btn").addEventListener("click", async () => {
  await api("/v1/session/logout", { method: "POST" });
  showLogin();
});
$("station-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-station]");
  if (!button) return;
  state.stationId = button.dataset.station || "";
  state.seenNew = null;
  closeFocus(false);
  $("prep-alerts")?.replaceChildren();
  localStorage.setItem("gtct.prepStation", state.stationId);
  unlockAudio();
  void loadBoard();
});
$("prep-board").addEventListener("click", (event) => {
  const accept = event.target.closest("[data-accept]");
  if (accept) {
    void mark(accept.dataset.accept, "accept");
    return;
  }
  const finish = event.target.closest("[data-finish]");
  if (finish) {
    void mark(finish.dataset.finish, "finish");
    return;
  }
  const focused = event.target.closest("[data-focus]");
  if (focused) openFocus(focused.dataset.focus);
});
$("prep-board").addEventListener("keydown", (event) => {
  const focused = event.target.closest("[data-focus]");
  if (focused && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    openFocus(focused.dataset.focus);
  }
});
$("prep-finished-toggle").addEventListener("click", () => {
  state.finishedOpen = !state.finishedOpen;
  $("prep-finished-panel").hidden = !state.finishedOpen;
  $("prep-finished-toggle").setAttribute("aria-expanded", String(state.finishedOpen));
  $("prep-finished-toggle-label").textContent = state.finishedOpen ? "Hide orders ▴" : "Show orders ▾";
  renderFinished((state.board?.tickets || []).filter((ticket) => ticket.status === "FINISHED")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))));
  if (state.finishedOpen) $("prep-finished-search").focus();
});
$("prep-finished-search").addEventListener("input", (event) => {
  state.finishedQuery = event.target.value;
  renderFinished((state.board?.tickets || []).filter((ticket) => ticket.status === "FINISHED"));
});
$("prep-focus-close").addEventListener("click", () => closeFocus());
$("prep-focus-backdrop").addEventListener("click", (event) => {
  if (event.target === $("prep-focus-backdrop")) closeFocus();
});
$("prep-focus-finish").addEventListener("click", () => {
  if (state.focusOrderId) void mark(state.focusOrderId, "finish");
});
document.addEventListener("keydown", (event) => {
  if (!state.focusOrderId) return;
  if (event.key === "Escape") {
    closeFocus();
    return;
  }
  // Keep keyboard navigation inside the active preparation dialog.
  if (event.key === "Tab") {
    const controls = [$("prep-focus-close"), $("prep-focus-finish")].filter((el) => !el.disabled);
    if (!controls.length) return;
    const position = controls.indexOf(document.activeElement);
    if (event.shiftKey && position <= 0) {
      event.preventDefault();
      controls[controls.length - 1].focus();
    } else if (!event.shiftKey && (position === controls.length - 1 || position === -1)) {
      event.preventDefault();
      controls[0].focus();
    }
  }
});

setInterval(() => {
  // Keep polling while backgrounded so new/edited orders can alert a kitchen tablet.
  if ($("main-view").hidden || !canWork()) return;
  void loadBoard();
}, 3000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  void requestWakeLock();
  void loadBoard();
});

const session = await api("/v1/session/me");
if (session.ok && session.json?.authenticated) {
  state.role = session.json.role;
  state.staff = Boolean(session.json.staff);
  state.permissions = session.json.permissions || [];
  state.fullName = session.json.fullName || "";
  showMain();
  void requestWakeLock();
} else {
  showLogin();
}
