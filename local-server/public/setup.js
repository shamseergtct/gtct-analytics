const $ = (id) => document.getElementById(id);

function showError(message) {
  const el = $("setup-error");
  el.hidden = !message;
  el.textContent = message || "";
}

async function loadStatus() {
  const res = await fetch("/v1/setup/status", { credentials: "same-origin" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    showError(body.error || "Could not read setup status.");
    return null;
  }
  if (!body.needsSetup) {
    $("setup-form").hidden = true;
    $("setup-done").hidden = false;
    $("setup-done").textContent =
      "Setup is already complete on this PC. Opening the main application…";
    setTimeout(() => {
      window.location.replace("/");
    }, 800);
    return body;
  }
  $("backup-dir").value = body.suggestedBackupDir || "";
  return body;
}

$("setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const btn = $("setup-submit");
  btn.disabled = true;
  try {
    const payload = {
      shopName: $("shop-name").value.trim(),
      addressText: $("shop-address").value.trim(),
      fullName: $("admin-name").value.trim(),
      username: $("admin-username").value.trim(),
      password: $("admin-password").value,
      confirmPassword: $("admin-confirm").value,
      backupDir: $("backup-dir").value.trim(),
    };
    const res = await fetch("/v1/setup/bootstrap", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(body.error || "Setup failed.");
      return;
    }
    $("setup-form").hidden = true;
    $("setup-done").hidden = false;
    setTimeout(() => {
      window.location.replace(body?.next?.printers || "/settings.html");
    }, 900);
  } catch (err) {
    showError(err instanceof Error ? err.message : "Setup failed.");
  } finally {
    btn.disabled = false;
  }
});

loadStatus().catch((err) => {
  showError(err instanceof Error ? err.message : "Setup failed to load.");
});
