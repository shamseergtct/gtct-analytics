import { registerPwa } from "./pwa.js";

const $ = (id) => document.getElementById(id);
registerPwa();

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

function setError(message = "") {
  const el = $("pair-error");
  el.hidden = !message;
  el.textContent = message || "";
}

function showPaired(terminal) {
  $("pair-form").hidden = true;
  $("paired-view").hidden = false;
  $("paired-label").textContent = `Paired as ${terminal.displayName} (${terminal.code})`;
}

async function refresh() {
  const res = await api("/v1/terminals/me");
  if (res.ok && res.json?.terminal) showPaired(res.json.terminal);
}

async function pair() {
  const code = $("pair-code").value.trim();
  if (!code) {
    setError("Enter the pairing code from Admin.");
    return;
  }
  const btn = $("pair-btn");
  btn.disabled = true;
  setError("");
  try {
    const res = await api("/v1/terminals/pair", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    if (!res.ok) {
      setError(res.json?.error || "Pairing failed.");
      return;
    }
    showPaired(res.json.terminal);
  } finally {
    btn.disabled = false;
  }
}

$("pair-btn").addEventListener("click", pair);
$("pair-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    pair();
  }
});
refresh();
