const state = {
  role: null,
  staff: false,
  permissions: [],
  users: [],
  mode: "",
  userId: "",
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

function showLogin(message = "") {
  $("login-view").hidden = false;
  $("main-view").hidden = true;
  setLoginError(message);
}

function canManage() {
  return state.role === "admin" && state.staff && state.permissions.includes("staff.manage");
}

function showMain() {
  $("login-view").hidden = true;
  $("main-view").hidden = false;
  $("session-role").textContent = state.role || "";
  const allowed = canManage();
  $("denied-block").hidden = allowed;
  $("admin-shell").hidden = !allowed;
}

function setStatus(message = "", ok = true) {
  const el = $("user-status");
  el.hidden = !message;
  el.textContent = message || "";
  el.className = `status-line ${ok ? "ok" : "err"}`;
}

function applySession(data) {
  state.role = data?.role || null;
  state.staff = Boolean(data?.staff);
  state.permissions = Array.isArray(data?.permissions) ? data.permissions : [];
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
    const me = await api("/v1/session/me");
    if (!me.ok || !me.json?.authenticated) {
      setLoginError("Signed in, but the session cookie was not kept.");
      return;
    }
    applySession(me.json);
    showMain();
    if (canManage()) await loadUsers();
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

async function logout() {
  await api("/v1/session/logout", { method: "POST", body: "{}" });
  state.role = null;
  state.staff = false;
  state.permissions = [];
  state.users = [];
  showLogin();
}

async function ensureSession() {
  const me = await api("/v1/session/me");
  if (!me.ok || !me.json?.authenticated) {
    showLogin();
    return;
  }
  applySession(me.json);
  showMain();
  if (canManage()) await loadUsers();
}

function roleLabel(role) {
  if (role === "admin") return "Admin";
  if (role === "cashier") return "Cashier";
  return "None";
}

function filteredUsers() {
  const q = $("user-search").value.trim().toLowerCase();
  if (!q) return state.users;
  return state.users.filter((user) =>
    `${user.fullName} ${user.username}`.toLowerCase().includes(q)
  );
}

function renderUsers() {
  const body = $("user-rows");
  const users = filteredUsers();
  body.innerHTML = "";
  if (!users.length) {
    body.innerHTML = `<tr><td colspan="5">No staff match.</td></tr>`;
    return;
  }
  for (const user of users) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="Staff name">${escapeHtml(user.fullName)}</td>
      <td data-label="Username">${escapeHtml(user.username)}</td>
      <td data-label="Role">${escapeHtml(roleLabel(user.role))}</td>
      <td data-label="Status">${user.isActive ? "Active" : "Inactive"}</td>
      <td data-label="Actions"></td>
    `;
    const actions = tr.lastElementChild;
    actions.className = "user-actions";
    actions.append(
      actionButton("Edit", () => openDialog("edit", user)),
      actionButton("Permissions", () => openDialog("permissions", user)),
      actionButton("Reset password", () => openDialog("password", user))
    );
    body.appendChild(tr);
  }
}

function actionButton(label, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn ghost small";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadUsers() {
  const res = await api("/v1/staff-users");
  if (!res.ok) {
    setStatus(res.json?.error || "Could not load staff.", false);
    return;
  }
  state.users = res.json.users || [];
  renderUsers();
}

function setDialogError(message = "") {
  const el = $("user-dialog-error");
  el.hidden = !message;
  el.textContent = message || "";
}

function showFields(mode) {
  const show = (id, on) => {
    $(id).hidden = !on;
  };
  show("name-field", mode === "add" || mode === "edit");
  show("username-field", mode === "add");
  show("password-field", mode === "add" || mode === "password");
  show("confirm-field", mode === "add" || mode === "password");
  show("role-field", mode === "add" || mode === "edit");
  show("active-field", mode === "add" || mode === "edit");
  show("permission-fields", mode === "permissions");
  $("password-label").textContent = mode === "password" ? "New password" : "Password";
  $("user-name").required = mode === "add" || mode === "edit";
  $("user-username").required = mode === "add";
  $("user-password").required = mode === "add" || mode === "password";
  $("user-confirm").required = mode === "add" || mode === "password";
}

function openDialog(mode, user = null) {
  state.mode = mode;
  state.userId = user?.userId || "";
  setDialogError("");
  $("user-name").value = user?.fullName || "";
  $("user-username").value = mode === "add" ? "" : user?.username || "";
  $("user-password").value = "";
  $("user-confirm").value = "";
  $("user-role").value = user?.role === "admin" ? "admin" : "cashier";
  $("user-active").checked = user ? Boolean(user.isActive) : true;
  const grants = user?.permissions || [];
  $("perm-price").checked = grants.includes("sales.price_override");
  $("perm-addon").checked = grants.includes("sales.addon_price_override");
  const adminRole = (user?.role || "cashier") === "admin";
  $("perm-price").disabled = mode === "permissions" && adminRole;
  $("perm-addon").disabled = mode === "permissions" && adminRole;
  if (mode === "permissions" && adminRole) {
    $("perm-price").checked = true;
    $("perm-addon").checked = true;
  }
  const titles = {
    add: "Add user",
    edit: "Edit user",
    permissions: "Permissions",
    password: "Reset password",
  };
  $("user-dialog-title").textContent = titles[mode] || "User";
  showFields(mode);
  $("user-dialog").hidden = false;
  const focus =
    mode === "password"
      ? $("user-password")
      : mode === "permissions"
        ? $("perm-price")
        : $("user-name");
  focus.focus();
}

function closeDialog() {
  $("user-dialog").hidden = true;
  $("user-password").value = "";
  $("user-confirm").value = "";
  state.mode = "";
  state.userId = "";
}

function selectedPermissions() {
  const codes = [];
  if ($("perm-price").checked) codes.push("sales.price_override");
  if ($("perm-addon").checked) codes.push("sales.addon_price_override");
  return codes;
}

async function saveUser(event) {
  event.preventDefault();
  setDialogError("");
  const btn = $("user-save");
  btn.disabled = true;
  try {
    let res;
    if (state.mode === "add") {
      res = await api("/v1/staff-users", {
        method: "POST",
        body: JSON.stringify({
          fullName: $("user-name").value.trim(),
          username: $("user-username").value.trim(),
          password: $("user-password").value,
          confirmPassword: $("user-confirm").value,
          role: $("user-role").value,
          isActive: $("user-active").checked,
          permissions: [],
        }),
      });
    } else if (state.mode === "edit") {
      res = await api(`/v1/staff-users/${encodeURIComponent(state.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          fullName: $("user-name").value.trim(),
          role: $("user-role").value,
          isActive: $("user-active").checked,
        }),
      });
    } else if (state.mode === "permissions") {
      const user = state.users.find((row) => row.userId === state.userId);
      if (user?.role === "admin") {
        closeDialog();
        return;
      }
      res = await api(`/v1/staff-users/${encodeURIComponent(state.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({ permissions: selectedPermissions() }),
      });
    } else if (state.mode === "password") {
      res = await api(`/v1/staff-users/${encodeURIComponent(state.userId)}/password`, {
        method: "POST",
        body: JSON.stringify({
          password: $("user-password").value,
          confirmPassword: $("user-confirm").value,
        }),
      });
    }
    if (!res?.ok) {
      setDialogError(res?.json?.error || "Could not save.");
      return;
    }
    closeDialog();
    setStatus("Saved.");
    await loadUsers();
  } finally {
    btn.disabled = false;
  }
}

$("login-btn").addEventListener("click", login);
$("toggle-password-btn").addEventListener("click", () => {
  const input = $("login-password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("toggle-password-btn").textContent = show ? "Hide" : "Show";
});
$("login-password").addEventListener("keydown", (event) => {
  if (event.key === "Enter") login();
});
$("logout-btn").addEventListener("click", logout);
$("add-user-btn").addEventListener("click", () => openDialog("add"));
$("user-search").addEventListener("input", renderUsers);
$("user-cancel").addEventListener("click", closeDialog);
$("user-form").addEventListener("submit", saveUser);
$("user-dialog").addEventListener("click", (event) => {
  if (event.target === $("user-dialog")) closeDialog();
});

ensureSession();
