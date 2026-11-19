/* TEST-only order monitor; no delivery payment / commission operations. */
import { registerPwa } from "./pwa.js";
import { renderBoard } from "./orderBoard.js";
registerPwa();
const $ = (id) => document.getElementById(id);
const state = {
  session: null,
  page: 1,
  pageSize: 60,
  busy: false,
  expandedOrderIds: new Set(),
};

async function api(path, method = "GET", body) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, json };
}

function boardApi(path, method = "GET", body) {
  return api(path, method, body);
}

function boardCtx() {
  return {
    session: state.session,
    expandedOrderIds: state.expandedOrderIds,
    api: boardApi,
    onRefresh: refresh,
  };
}

function showLogin(message) {
  state.session = null;
  $("login-view").hidden = false;
  $("main-view").hidden = true;
  $("login-error").hidden = !message;
  $("login-error").textContent = message || "";
}
function showMain() {
  $("login-view").hidden = true;
  $("main-view").hidden = false;
  $("session-role").textContent = state.session.fullName || state.session.role;
  void refresh();
}
function filters() {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  for (const [key, id] of [
    ["behavior", "behavior"],
    ["date", "order-date"],
    ["q", "order-search"],
  ]) {
    const value = $(id).value.trim();
    if (value) params.set(key, value);
  }
  return params.toString();
}

async function refresh() {
  if (!state.session || state.busy || document.hidden) return;
  state.busy = true;
  try {
    $("monitor-status").textContent = "Loading orders…";
    const result = await api(`/v1/order-monitor?${filters()}`);
    if (result.status === 401) return showLogin("Sign in to continue.");
    if (result.status === 403) {
      $("monitor-status").textContent = "You do not have permission to monitor orders.";
      return;
    }
    if (!result.ok) {
      $("monitor-status").textContent = result.json.error || "Could not load orders.";
      return;
    }
    const data = result.json;
    renderBoard($("monitor-list"), data.orders || [], boardCtx());
    $("monitor-status").textContent = `${data.total} orders`;
    $("page-label").textContent = `Page ${data.page}`;
    $("prev-page").disabled = state.page <= 1;
    $("next-page").disabled = state.page * data.pageSize >= data.total;
  } catch {
    $("monitor-status").textContent = "Connection lost. Refresh to try again.";
  } finally {
    state.busy = false;
  }
}
async function signIn() {
  const result = await api("/v1/session/login", "POST", {
    username: $("login-username").value.trim(),
    password: $("login-password").value,
  });
  if (!result.ok) return showLogin(result.json.error || "Sign-in failed.");
  $("login-password").value = "";
  await startSession();
}
async function startSession() {
  const result = await api("/v1/session/me");
  if (!result.ok || !result.json.authenticated) return showLogin("Sign in to monitor orders.");
  if (result.json.role === "kitchen") {
    window.location.replace("/prep.html");
    return;
  }
  state.session = result.json;
  showMain();
}
$("login-btn").addEventListener("click", () => void signIn());
$("logout-btn").addEventListener("click", async () => {
  await api("/v1/session/logout", "POST");
  showLogin();
});
$("refresh-btn").addEventListener("click", () => void refresh());
for (const [id, mode] of [
  ["view-grid", "grid"],
  ["view-list", "list"],
]) {
  $(id).addEventListener("click", () => {
    $("monitor-list").classList.toggle("is-list", mode === "list");
    $("view-grid").setAttribute("aria-pressed", String(mode === "grid"));
    $("view-list").setAttribute("aria-pressed", String(mode === "list"));
  });
}

for (const id of ["behavior", "order-date", "order-search"]) {
  $(id).addEventListener("change", () => {
    state.page = 1;
    void refresh();
  });
}
$("prev-page").addEventListener("click", () => {
  state.page = Math.max(1, state.page - 1);
  void refresh();
});
$("next-page").addEventListener("click", () => {
  state.page += 1;
  void refresh();
});
window.setInterval(() => {
  if (state.session && !document.hidden) void refresh();
}, 8000);
await startSession();
