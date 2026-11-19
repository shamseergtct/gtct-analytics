function $(id) {
  return document.getElementById(id);
}

function setError(message) {
  const el = $("reset-error");
  const ok = $("reset-ok");
  ok.hidden = true;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function setOk(message) {
  const el = $("reset-ok");
  $("reset-error").hidden = true;
  el.hidden = false;
  el.textContent = message;
}

async function loadStatus() {
  try {
    const res = await fetch("/v1/recovery/status", { credentials: "same-origin" });
    const body = await res.json().catch(() => ({}));
    const enabled = Boolean(body.supportMasterEnabled);
    $("support-panel").hidden = !enabled;
    $("support-disabled").hidden = enabled;
  } catch {
    $("support-panel").hidden = true;
    $("support-disabled").hidden = false;
  }
}

async function resetPassword() {
  const btn = $("reset-btn");
  setError("");
  btn.disabled = true;
  try {
    const res = await fetch("/v1/recovery/support-reset", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        masterKey: $("master-key").value,
        username: $("username").value,
        password: $("password").value,
        confirmPassword: $("confirm").value,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error || "Password could not be reset.");
      return;
    }
    $("master-key").value = "";
    $("password").value = "";
    $("confirm").value = "";
    setOk(`Password reset for ${body.username}. You can sign in now.`);
  } catch {
    setError("Could not reach the restaurant server.");
  } finally {
    btn.disabled = false;
  }
}

$("reset-btn")?.addEventListener("click", () => void resetPassword());
void loadStatus();
