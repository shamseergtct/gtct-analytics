/**
 * On-screen QWERTY + numeric pad for POS touch entry.
 * Attaches to search/text/tel/decimal fields; keeps physical typing working.
 */
const LETTER_ROWS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];

const STATE = {
  enabled: true,
  target: null,
  mode: "text",
  shift: false,
  caps: false,
  root: null,
  panel: null,
  keysHost: null,
  titleEl: null,
  savedInputMode: null,
  suppressFocusUntil: 0,
  // The keyboard opens only when staff tap a field, never when the app moves
  // focus by itself (e.g. after closing a dialog).
  lastTap: { el: null, at: 0 },
};

function wasTapped(el) {
  return Boolean(el) && STATE.lastTap.el === el && Date.now() - STATE.lastTap.at < 1000;
}

function onPointerDown(event) {
  const el = event.target?.closest?.("input, textarea");
  if (!el || el.closest?.("#vk-panel")) return;
  STATE.lastTap = { el, at: Date.now() };
  // Tapping a field that already has focus does not fire focusin.
  if (STATE.enabled && document.activeElement === el && isEditableInput(el)) {
    window.setTimeout(() => showKeyboard(el), 0);
  }
}

function isEditableInput(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.closest?.("[data-vk='off']")) return false;
  const tag = String(el.tagName || "").toLowerCase();
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  const type = String(el.type || "text").toLowerCase();
  if (
    [
      "button",
      "submit",
      "reset",
      "checkbox",
      "radio",
      "file",
      "hidden",
      "image",
      "range",
      "color",
      "date",
      "time",
      "datetime-local",
      "month",
      "week",
    ].includes(type)
  ) {
    return false;
  }
  return true;
}

function detectMode(el) {
  const forced = String(el.getAttribute("data-vk") || "")
    .trim()
    .toLowerCase();
  if (forced === "text" || forced === "search" || forced === "password") return "text";
  if (forced === "number" || forced === "numeric") return "number";
  if (forced === "decimal") return "decimal";
  if (forced === "tel" || forced === "phone") return "tel";

  const type = String(el.type || "text").toLowerCase();
  const mode = String(el.getAttribute("inputmode") || "").toLowerCase();
  if (type === "tel" || mode === "tel") return "tel";
  if (mode === "decimal" || mode === "numeric" || type === "number") {
    return mode === "numeric" || type === "number" ? "number" : "decimal";
  }
  if (type === "password") return "text";
  if (type === "search" || mode === "search") return "text";
  return "text";
}

function modeTitle(mode) {
  if (mode === "tel") return "Phone pad";
  if (mode === "decimal") return "Number pad";
  if (mode === "number") return "Number pad";
  return "Keyboard";
}

function dispatchInput(el) {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function insertText(el, text) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const value = String(el.value || "");
  const next = value.slice(0, start) + text + value.slice(end);
  const max = el.maxLength > 0 ? el.maxLength : null;
  if (max != null && next.length > max) return;
  el.value = next;
  const caret = start + text.length;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    /* some input types ignore selection */
  }
  dispatchInput(el);
}

function deleteBackward(el) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const value = String(el.value || "");
  if (start !== end) {
    el.value = value.slice(0, start) + value.slice(end);
    try {
      el.setSelectionRange(start, start);
    } catch {
      /* ignore */
    }
  } else if (start > 0) {
    el.value = value.slice(0, start - 1) + value.slice(start);
    try {
      el.setSelectionRange(start - 1, start - 1);
    } catch {
      /* ignore */
    }
  } else {
    return;
  }
  dispatchInput(el);
}

function clearValue(el) {
  el.value = "";
  try {
    el.setSelectionRange(0, 0);
  } catch {
    /* ignore */
  }
  dispatchInput(el);
}

function ensureDom() {
  if (STATE.panel) return;
  const panel = document.createElement("div");
  panel.id = "vk-panel";
  panel.className = "vk-panel";
  panel.hidden = true;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "On-screen keyboard");
  panel.innerHTML = `
    <strong class="vk-title" hidden>Keyboard</strong>
    <div class="vk-keys" data-vk-keys></div>
  `;
  if (typeof panel.showPopover === "function") panel.popover = "manual";
  document.body.appendChild(panel);
  STATE.panel = panel;
  STATE.keysHost = panel.querySelector("[data-vk-keys]");
  STATE.titleEl = panel.querySelector(".vk-title");

  panel.addEventListener("pointerdown", (event) => {
    // Keep focus on the input while tapping keys.
    if (event.target.closest("button")) event.preventDefault();
  });
  panel.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-vk-key], button[data-vk-act]");
    if (!btn) return;
    event.preventDefault();
    const act = btn.getAttribute("data-vk-act");
    if (act === "done" || btn.getAttribute("data-vk-key") === "done") {
      hideKeyboard({ blur: true });
      return;
    }
    if (act === "clear") {
      if (STATE.target) clearValue(STATE.target);
      return;
    }
    const key = btn.getAttribute("data-vk-key");
    if (!key || !STATE.target) return;
    handleKey(key);
  });
}

function keyButton(label, key, extraClass = "") {
  const cls = extraClass ? `vk-key ${extraClass}` : "vk-key";
  return `<button type="button" class="${cls}" data-vk-key="${key}" aria-label="${label}">${label}</button>`;
}

function renderKeys() {
  ensureDom();
  const host = STATE.keysHost;
  const mode = STATE.mode;
  STATE.titleEl.textContent = modeTitle(mode);

  if (mode === "tel" || mode === "number" || mode === "decimal") {
    const showDot = mode === "decimal";
    const extra = mode === "tel" ? "+" : showDot ? "." : "";
    const extraKey = mode === "tel" ? "+" : ".";
    host.innerHTML = `
      <div class="vk-numpad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => keyButton(String(n), String(n))).join("")}
        ${
          extra
            ? keyButton(extra, extraKey, "vk-key-muted")
            : keyButton("ABC", "mode-text", "vk-key-action")
        }
        ${keyButton("0", "0")}
        ${keyButton("⌫", "backspace", "vk-key-action")}
      </div>
      <div class="vk-row vk-row-bottom">
        ${keyButton("ABC", "mode-text", "vk-key-action")}
        ${keyButton("Clear", "clear", "vk-key-action")}
        ${keyButton("Done", "done", "vk-key-done vk-key-wide")}
      </div>
    `;
    return;
  }

  const upper = STATE.shift || STATE.caps;
  const rows = LETTER_ROWS.map((row, index) => {
    const keys = row
      .map((ch) => {
        const label = upper ? ch.toUpperCase() : ch;
        return keyButton(label, ch);
      })
      .join("");
    if (index === 2) {
      return `<div class="vk-row vk-row-letters">${keyButton(
        STATE.caps ? "CAPS" : "⇧",
        "shift",
        `vk-key-action vk-key-shift${STATE.shift || STATE.caps ? " is-on" : ""}`
      )}${keys}${keyButton("⌫", "backspace", "vk-key-action")}</div>`;
    }
    return `<div class="vk-row vk-row-letters">${keys}</div>`;
  }).join("");

  const digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
    .map((d) => keyButton(d, d, "vk-key-digit"))
    .join("");
  host.innerHTML = `
    <div class="vk-row vk-row-digits">${digits}</div>
    ${rows}
    <div class="vk-row vk-row-bottom">
      ${keyButton("123", "mode-num", "vk-key-action vk-key-wide")}
      ${keyButton("@", "@", "vk-key-muted")}
      ${keyButton("space", "space", "vk-key-space")}
      ${keyButton(".", ".", "vk-key-muted")}
      ${keyButton("Clear", "clear", "vk-key-action")}
      ${keyButton("Done", "done", "vk-key-done vk-key-wide")}
    </div>
  `;
}

function handleKey(key) {
  const el = STATE.target;
  if (!el) return;
  if (key === "clear") {
    clearValue(el);
    return;
  }
  if (key === "backspace") {
    deleteBackward(el);
    return;
  }
  if (key === "space") {
    insertText(el, " ");
    return;
  }
  if (key === "shift") {
    if (STATE.shift) {
      STATE.caps = !STATE.caps;
      STATE.shift = false;
    } else {
      STATE.shift = true;
    }
    renderKeys();
    return;
  }
  if (key === "mode-num") {
    STATE.mode = "decimal";
    renderKeys();
    return;
  }
  if (key === "mode-text") {
    STATE.mode = "text";
    renderKeys();
    return;
  }
  let text = key;
  if (STATE.mode === "text" && /^[a-z]$/i.test(key)) {
    text = STATE.shift || STATE.caps ? key.toUpperCase() : key.toLowerCase();
    if (STATE.shift && !STATE.caps) {
      STATE.shift = false;
      renderKeys();
    }
  }
  if ((STATE.mode === "decimal" || STATE.mode === "number") && key === ".") {
    if (String(el.value || "").includes(".")) return;
  }
  insertText(el, text);
}

/**
 * On the Sales screen the keyboard sits under the menu area only, so the cart
 * stays fully visible. Elsewhere it is a centred tray.
 */
function placePanel(el) {
  const panel = STATE.panel;
  if (!panel) return;
  const pane = el?.closest?.("#menu-pane");
  const dock = Boolean(pane) && window.innerWidth >= 900;
  panel.classList.toggle("vk-docked", dock);
  document.body.classList.toggle("vk-dock-menu", dock);
  if (dock) {
    const r = pane.getBoundingClientRect();
    panel.style.left = `${Math.max(0, Math.round(r.left))}px`;
    panel.style.width = `${Math.round(r.width)}px`;
  } else {
    panel.style.left = "";
    panel.style.width = "";
  }
}

function setDialogHost(dialog) {
  document.querySelectorAll("dialog.vk-host").forEach((d) => {
    if (d !== dialog) d.classList.remove("vk-host");
  });
  if (dialog) dialog.classList.add("vk-host");
}

/**
 * An open modal dialog covers the page and blocks taps outside it. So while a
 * dialog field is being typed in, the keyboard lives inside that dialog, and is
 * shown in the browser's top layer (popover) so it is drawn above it and
 * positioned against the screen, not the dialog.
 */
function bringPanelToFront(el) {
  const panel = STATE.panel;
  const dialog = el?.closest?.("dialog[open]") || null;
  setDialogHost(dialog);
  const host = dialog || document.body;
  if (panel.parentElement !== host) {
    try {
      if (panel.matches(":popover-open")) panel.hidePopover();
    } catch {
      /* ignore */
    }
    host.appendChild(panel);
  }
  if (typeof panel.showPopover === "function") {
    try {
      if (panel.matches(":popover-open")) panel.hidePopover();
      panel.showPopover();
    } catch {
      /* the panel is still fixed at the bottom of the screen */
    }
  }
}

function keyboardHeight() {
  return STATE.panel && !STATE.panel.hidden ? STATE.panel.getBoundingClientRect().height : 0;
}

/** Publish the keyboard height so lists can leave room for it (CSS var --vk-h). */
function syncKeyboardSpace() {
  const h = Math.round(keyboardHeight());
  document.documentElement.style.setProperty("--vk-h", `${h}px`);
}

function scrollableParent(el) {
  let node = el?.parentElement;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

/**
 * Keep the field visible above the keyboard. Search boxes go near the top so
 * the results under them stay in view; other fields only move if covered.
 */
function scrollTargetIntoView(el) {
  if (!el) return;
  syncKeyboardSpace();
  const rect = el.getBoundingClientRect();
  const visibleBottom = window.innerHeight - keyboardHeight() - 12;
  const isSearch =
    String(el.type || "").toLowerCase() === "search" ||
    String(el.getAttribute("data-vk") || "").toLowerCase() === "search";
  let delta = 0;
  if (isSearch && rect.top > 96) delta = rect.top - 96;
  else if (rect.bottom > visibleBottom) delta = rect.bottom - visibleBottom;
  else if (rect.top < 8) delta = rect.top - 8;
  if (!delta) return;
  const scroller = scrollableParent(el);
  scroller.scrollBy({ top: delta, behavior: "smooth" });
  if (scroller !== document.scrollingElement) {
    window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      const vb = window.innerHeight - keyboardHeight() - 12;
      if (r.bottom > vb) window.scrollBy({ top: r.bottom - vb, behavior: "smooth" });
    }, 250);
  }
}

function restoreInputMode(el, saved) {
  if (!el) return;
  if (saved == null || saved === "") el.removeAttribute("inputmode");
  else el.setAttribute("inputmode", saved);
}

function showKeyboard(el) {
  if (!STATE.enabled || !isEditableInput(el)) return;
  ensureDom();
  if (STATE.target && STATE.target !== el) {
    restoreInputMode(STATE.target, STATE.savedInputMode);
    STATE.savedInputMode = null;
  }
  const switching = STATE.target === el;
  STATE.target = el;
  if (!switching) {
    STATE.mode = detectMode(el);
    STATE.shift = false;
    STATE.caps = false;
    STATE.savedInputMode = el.getAttribute("inputmode");
    // Reduce OS soft-keyboard overlap on tablets while VK is open.
    el.setAttribute("inputmode", "none");
  }
  renderKeys();
  STATE.panel.hidden = false;
  bringPanelToFront(el);
  placePanel(el);
  document.body.classList.add("vk-open");
  window.setTimeout(() => scrollTargetIntoView(el), 50);
}

function hideKeyboard({ blur = false } = {}) {
  STATE.lastTap = { el: null, at: 0 }; // a closed keyboard needs a new tap to open
  const target = STATE.target;
  const saved = STATE.savedInputMode;
  STATE.target = null;
  STATE.savedInputMode = null;
  restoreInputMode(target, saved);
  if (STATE.panel) {
    STATE.panel.hidden = true;
    try {
      if (STATE.panel.matches(":popover-open")) STATE.panel.hidePopover();
    } catch {
      /* ignore */
    }
  }
  setDialogHost(null);
  if (STATE.panel && STATE.panel.parentElement !== document.body) {
    document.body.appendChild(STATE.panel);
  }
  document.body.classList.remove("vk-open", "vk-dock-menu");
  document.documentElement.style.setProperty("--vk-h", "0px");
  if (blur && target) {
    STATE.suppressFocusUntil = Date.now() + 250;
    target.blur();
  }
}

function onFocusIn(event) {
  if (!STATE.enabled) return;
  if (Date.now() < STATE.suppressFocusUntil) return;
  const el = event.target;
  if (!isEditableInput(el)) return;
  if (el.closest?.("#vk-panel")) return;
  if (!wasTapped(el)) return;
  showKeyboard(el);
}

function onFocusOut(event) {
  const next = event.relatedTarget;
  if (next && (STATE.panel?.contains(next) || isEditableInput(next))) return;
  // Delay hide so key taps that briefly blur can reclaim focus.
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active && isEditableInput(active)) {
      if (active !== STATE.target) {
        if (wasTapped(active)) showKeyboard(active);
        else hideKeyboard();
      }
      return;
    }
    if (STATE.panel && !STATE.panel.hidden && document.activeElement === STATE.target) {
      return;
    }
    if (!STATE.target) return;
    if (document.activeElement === STATE.target) return;
    hideKeyboard();
  }, 120);
}

function onKeyDown(event) {
  if (event.key === "Escape" && STATE.panel && !STATE.panel.hidden) {
    hideKeyboard({ blur: true });
  }
}

/**
 * @param {{ root?: ParentNode, enabled?: boolean }} [options]
 */
export function initVirtualKeyboard(options = {}) {
  STATE.enabled = options.enabled !== false;
  STATE.root = options.root || document;
  ensureDom();
  renderKeys();
  STATE.root.addEventListener("pointerdown", onPointerDown, true);
  STATE.root.addEventListener("focusin", onFocusIn, true);
  STATE.root.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", () => {
    if (STATE.target && STATE.panel && !STATE.panel.hidden) {
      placePanel(STATE.target);
      syncKeyboardSpace();
    }
  });
  return {
    show: showKeyboard,
    hide: hideKeyboard,
    setEnabled(on) {
      STATE.enabled = Boolean(on);
      if (!STATE.enabled) hideKeyboard({ blur: true });
      document.body.classList.toggle("vk-enabled", STATE.enabled);
    },
    isOpen() {
      return Boolean(STATE.panel && !STATE.panel.hidden);
    },
  };
}

export function refreshVirtualKeyboard() {
  if (STATE.target && document.activeElement === STATE.target) {
    showKeyboard(STATE.target);
  }
}
