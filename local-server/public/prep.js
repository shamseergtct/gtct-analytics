const state = {
  role: null,
  staff: false,
  permissions: [],
  fullName: "",
  stationId: localStorage.getItem("gtct.prepStation") || "",
  board: null,
  busy: false,
  seenNew: null,
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
  return `${ticket.orderId}:${ticket.updated ? "updated" : "new"}`;
}

function showOrderNotices(arrivals) {
  const host = $("prep-alerts");
  if (!host) return;
  for (const ticket of arrivals) {
    const note = document.createElement("button");
    note.type = "button";
    note.className = ticket.updated ? "prep-alert updated" : "prep-alert";
    const kind = ticket.updated ? "Order updated" : "New order";
    const number = ticket.orderNumber || "";
    note.setAttribute("aria-label", `Dismiss ${kind} ${number}`);
    note.innerHTML = `<span>${escapeHtml(kind)}</span><strong>${escapeHtml(number)}</strong>`;
    note.addEventListener("click", () => note.remove());
    host.prepend(note);
    window.setTimeout(() => note.remove(), 20000);
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
  return `<li>
    <strong>${escapeHtml(qty(line.quantity))} × ${escapeHtml(line.name)}</strong>
    ${notes.map((note) => `<div class="prep-note">${escapeHtml(note)}</div>`).join("")}
  </li>`;
}

function cardHtml(ticket) {
  const place = placeLine(ticket);
  const actions = ticket.status === "FINISHED"
    ? ""
    : `<div class="prep-actions">
        ${ticket.status === "NEW" ? `<button type="button" class="btn primary" data-accept="${escapeHtml(ticket.orderId)}">Accept</button>` : ""}
        <button type="button" class="btn ${ticket.status === "ACCEPTED" ? "primary" : "ghost"}" data-finish="${escapeHtml(ticket.orderId)}">Finished</button>
      </div>`;
  return `<article class="prep-card ${ticket.status === "FINISHED" ? "finished" : ""} ${ticket.updated ? "updated" : ""}">
    <div class="prep-card-head">
      <strong>${escapeHtml(ticket.orderNumber)}</strong>
      <span class="prep-time">${escapeHtml(when(ticket.createdAt))}</span>
    </div>
    <div>${escapeHtml(ticket.orderTypeName || "")}</div>
    ${place ? `<div class="prep-place">${escapeHtml(place)}</div>` : ""}
    ${ticket.updated ? `<div class="prep-note">Order updated</div>` : ""}
    <ul class="prep-lines">${(ticket.lines || []).map(lineHtml).join("")}</ul>
    ${actions}
  </article>`;
}

function column(title, tickets) {
  const cards = tickets.length
    ? tickets.map(cardHtml).join("")
    : `<p class="hint">None</p>`;
  return `<section class="prep-column"><h2>${escapeHtml(title)} · ${tickets.length}</h2>${cards}</section>`;
}

function render() {
  const board = state.board;
  const stations = board?.stations || [];
  $("station-tabs").innerHTML = stations.map((station) => {
    const selected = station.stationId === state.stationId;
    return `<button type="button" class="chip" role="tab" aria-selected="${selected}" data-station="${escapeHtml(station.stationId)}">${escapeHtml(station.name)}</button>`;
  }).join("");
  $("station-title").textContent = board?.station?.name || "Preparation";
  const tickets = board?.tickets || [];
  $("prep-board").innerHTML = [
    column("New", tickets.filter((ticket) => ticket.status === "NEW")),
    column("Preparing", tickets.filter((ticket) => ticket.status === "ACCEPTED")),
    column("Finished", tickets.filter((ticket) => ticket.status === "FINISHED")),
  ].join("");
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
    $("prep-status").textContent = result.json?.error || "Could not load this station.";
    return;
  }
  state.board = result.json;
  if (result.json.station?.stationId) {
    state.stationId = result.json.station.stationId;
    localStorage.setItem("gtct.prepStation", state.stationId);
  }
  render();
  noticeNewOrders(result.json.tickets || []);
}

async function mark(orderId, action) {
  if (state.busy || !state.stationId) return;
  state.busy = true;
  const result = await api(`/v1/prep-board/${action}`, {
    method: "POST",
    body: JSON.stringify({ orderId, stationId: state.stationId }),
  });
  state.busy = false;
  if (!result.ok) {
    $("prep-status").textContent = result.json?.error || "Could not update that order.";
    return;
  }
  await loadBoard();
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
  const allowed = canWork();
  $("prep-denied").hidden = allowed;
  $("prep-shell").hidden = !allowed;
  if (allowed) void loadBoard();
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

document.addEventListener("pointerdown", unlockAudio);
$("login-btn").addEventListener("click", () => {
  unlockAudio();
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
  if (finish) void mark(finish.dataset.finish, "finish");
});

setInterval(() => {
  if (document.hidden || $("main-view").hidden) return;
  void loadBoard();
}, 3000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void loadBoard();
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
