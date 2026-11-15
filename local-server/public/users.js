const state = {
  role: null,
  staff: false,
  permissions: [],
  users: [],
  stations: [],
  mode: "",
  userId: "",
  commissionCurrencyCode: null,
  commissionDecimals: null,
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
    if (canManage()) await loadStaffSetup();
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
  $("backup-health-box").hidden = true;
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
  if (canManage()) await loadStaffSetup();
}

function roleLabel(role) {
  if (role === "admin") return "Admin";
  if (role === "cashier") return "Cashier";
  if (role === "kitchen") return "Kitchen Staff";
  if (role === "delivery") return "Delivery Boy";
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
      ...(["kitchen", "delivery"].includes(user.role) ? [] : [actionButton("Permissions", () => openDialog("permissions", user))]),
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

async function loadBackupHealth() {
  const box = $("backup-health-box");
  if (!canManage()) { box.hidden = true; return; }
  box.hidden = false;
  const label = $("backup-health-message");
  // The shared settings-banner defaults to red; explicitly reset on every refresh.
  box.dataset.healthTone = "neutral";
  label.textContent = "Checking…";
  try {
    const result = await api("/v1/admin/backup-health");
    if (!result.ok) {
      box.dataset.healthTone = "error";
      label.textContent = "Status unavailable — check server logs.";
      return;
    }
    const status = result.json || {};
    switch (status.state) {
      case "OK": box.dataset.healthTone = "ok"; break;
      case "STALE": box.dataset.healthTone = "warning"; break;
      case "DISABLED": box.dataset.healthTone = "neutral"; break;
      default: box.dataset.healthTone = "error"; break;
    }
    const detail = status.latestBackup?.createdAt
      ? ` Last verified: ${new Date(status.latestBackup.createdAt).toLocaleString()}.`
      : "";
    label.textContent = `${status.state || "UNKNOWN"} — ${status.message || "Status unavailable."}${detail}`;
  } catch {
    box.dataset.healthTone = "error";
    label.textContent = "Status unavailable — check server logs.";
  }
}

async function loadStaffSetup() {
  const stations = await api("/v1/staff-users/stations");
  if (stations.ok) state.stations = stations.json?.stations || [];
  else setStatus(stations.json?.error || "Could not load stations.", false);
  const rules = await api('/v1/delivery-commissions');
  state.commissionCurrencyCode = rules.ok ? rules.json?.currencyCode : null;
  state.commissionDecimals = rules.ok ? rules.json?.currencyDecimals : null;
  if(!rules.ok) setStatus('Rider commission setup unavailable: '+(rules.json?.error||'Check commission service.'),false);
  await loadUsers();
  await loadBackupHealth();
}

function selectedStationIds() {
  return [...$("user-stations").querySelectorAll('input[type="checkbox"]:checked')]
    .map((input) => input.value);
}

function renderAssignedStations(ids = []) {
  const host = $("user-stations");
  host.replaceChildren();
  if (!state.stations.length) {
    host.textContent = "No active preparation stations available.";
    return;
  }
  for (const station of state.stations) {
    const label = document.createElement("label");
    label.className = "check-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = station.stationId;
    input.checked = ids.includes(station.stationId);
    const name = document.createElement("span");
    name.textContent = station.name;
    label.append(input, name);
    host.append(label);
  }
}

function minorToInput(n) {
  const d=state.commissionDecimals;
  return (Number(n||0) / (10**d)).toFixed(d);
}
function inputMinor(value) {
  const d=state.commissionDecimals;
  const v=String(value||'').trim();
  const match=v.match(/^(\d{1,10})(?:\.(\d+))?$/);
  if(!match||(match[2]||'').length>d)throw Error(`Use an amount with at most ${d} decimals.`);
  const n=Number(match[1])*10**d + Number((match[2]||'').padEnd(d,'0')||0);
  if(!Number.isSafeInteger(n))throw Error('Amount too large.');
  return n;
}
function commissionVisibility() {
  const show=(state.mode==='add'||state.mode==='edit') && $('user-role').value==='delivery';
  $('rider-commission-field').hidden=!show;
  const m=$('staff-commission-method').value;
  $('staff-commission-amount-row').hidden=!show||!['FIXED_PER_DELIVERY','MANUAL'].includes(m);
  $('staff-commission-basis-row').hidden=!show||!['TIERED_FIXED','PERCENTAGE'].includes(m);
  $('staff-commission-rate-row').hidden=!show||m!=='PERCENTAGE';
  $('staff-commission-tiers-row').hidden=!show||m!=='TIERED_FIXED';
  $('staff-commission-status').textContent=!show?'':!state.commissionCurrencyCode?
    'Commission settings unavailable. Cannot save a Rider without currency configuration.':
    `Currency ${state.commissionCurrencyCode} · daily policy · configured once, used automatically at collection.`;
  for(const node of document.querySelectorAll('.staff-commission-currency'))
    node.textContent=state.commissionCurrencyCode||'—';
}
function loadCommissionRule(rule) {
  const p=rule?.policy||{method:'NONE'};
  $('staff-commission-method').value=p.method||'NONE';
  $('staff-commission-basis').value=p.basis||'TOTAL_BILL';
  $('staff-commission-amount').value=minorToInput(p.amountMinor);
  $('staff-commission-rate').value=((p.rateBps||0)/100).toFixed(2);
  $('staff-commission-tiers').value=(p.tiers||[{thresholdMinor:50*10**state.commissionDecimals,rewardMinor:.5*10**state.commissionDecimals},
    {thresholdMinor:80*10**state.commissionDecimals,rewardMinor:1*10**state.commissionDecimals}]).map(t=>
    `${minorToInput(t.thresholdMinor)} = ${minorToInput(t.rewardMinor)}`).join('\n');
  commissionVisibility();
}
function buildCommissionRule() {
  if(!state.commissionCurrencyCode||!Number.isInteger(state.commissionDecimals))
    throw Error('Commission currency is unavailable. Refresh User Management.');
  const method=$('staff-commission-method').value;
  const p={method,period:'DAILY'};
  if(['FIXED_PER_DELIVERY','MANUAL'].includes(method))p.amountMinor=inputMinor($('staff-commission-amount').value);
  if(['TIERED_FIXED','PERCENTAGE'].includes(method))p.basis=$('staff-commission-basis').value;
  if(method==='PERCENTAGE'){
    const r=String($('staff-commission-rate').value).trim().match(/^(\d{1,3})(?:\.(\d{1,2}))?$/);
    if(!r)throw Error('Enter a percentage with up to 2 decimals.');
    p.rateBps=Number(r[1])*100+Number((r[2]||'').padEnd(2,'0')||0);
    if(p.rateBps>10000)throw Error('Percentage cannot exceed 100%.');
  }
  if(method==='TIERED_FIXED'){
    const lines=$('staff-commission-tiers').value.split('\n').map(v=>v.trim()).filter(Boolean);
    if(!lines.length||lines.length>20)throw Error('Enter 1–20 target slabs.');
    p.tiers=lines.map(line=>{
      const x=line.split('=');
      if(x.length!==2)throw Error('Use Target = Commission, one per line.');
      return {thresholdMinor:inputMinor(x[0]),rewardMinor:inputMinor(x[1])};
    });
    for(let i=1;i<p.tiers.length;i++)if(p.tiers[i].thresholdMinor<=p.tiers[i-1].thresholdMinor)
      throw Error('Target amounts must increase from top to bottom.');
  }
  return p;
}
function updateStationVisibility() {
  $("stations-field").hidden = !(state.mode === "add" || state.mode === "edit") || $("user-role").value !== "kitchen";
  commissionVisibility();
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
  if (message) {
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    $("user-dialog")?.scrollTo?.({ top: 0, behavior: "smooth" });
  }
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
  updateStationVisibility();
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
  $("user-role").value = user?.role || "cashier";
  renderAssignedStations(user?.stationIds || []);
  loadCommissionRule(user?.commissionRule);
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
  $("user-dialog").scrollTop = 0;
  document.body.style.overflow = "hidden";
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
  document.body.style.overflow = "";
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
    const commissionPolicy = (['add','edit'].includes(state.mode) && $('user-role').value==='delivery')
      ? buildCommissionRule() : undefined;
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
          stationIds: $("user-role").value === "kitchen" ? selectedStationIds() : [],
          ...(commissionPolicy ? {commissionPolicy}: {}),
        }),
      });
    } else if (state.mode === "edit") {
      res = await api(`/v1/staff-users/${encodeURIComponent(state.userId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          fullName: $("user-name").value.trim(),
          role: $("user-role").value,
          isActive: $("user-active").checked,
          stationIds: $("user-role").value === "kitchen" ? selectedStationIds() : [],
          ...(commissionPolicy ? {commissionPolicy}: {}),
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
  } catch(error) {
    setDialogError(error.message||'Commission policy is invalid.');
  } finally {
    btn.disabled = false;
  }
}

$("staff-commission-method").addEventListener('change',commissionVisibility);
$("user-role").addEventListener("change", updateStationVisibility);
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

$("backup-health-refresh").addEventListener("click", loadBackupHealth);
