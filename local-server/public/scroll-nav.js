(() => {
  if (window.__gtctScrollNav) return;
  window.__gtctScrollNav = true;

  function isScrollable(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") return false;
    return el.scrollHeight > el.clientHeight + 8;
  }

  function preferredTargets() {
    return [
      document.querySelector(".menu-grid"),
      document.querySelector(".prep-board"),
      document.querySelector(".prep-column-new"),
      document.querySelector(".prep-column-preparing"),
      document.querySelector(".prep-lanes"),
      document.querySelector(".prep-columns"),
      document.querySelector(".orders-board"),
      document.querySelector(".cart-lines"),
      document.querySelector("main"),
      document.querySelector("#main-view"),
      document.scrollingElement,
    ].filter(Boolean);
  }

  function deepestScrollable(root) {
    let best = null;
    let bestArea = 0;
    const walk = (node) => {
      if (!(node instanceof Element)) return;
      if (isScrollable(node)) {
        const area = node.clientWidth * node.clientHeight;
        if (area > bestArea) {
          best = node;
          bestArea = area;
        }
      }
      for (const child of node.children) walk(child);
    };
    walk(root);
    return best;
  }

  function scrollTarget() {
    for (const el of preferredTargets()) {
      if (el === document.scrollingElement) continue;
      if (isScrollable(el)) return el;
      const nested = deepestScrollable(el);
      if (nested) return nested;
    }
    const page = document.scrollingElement || document.documentElement;
    if (page.scrollHeight > page.clientHeight + 8) return page;
    return deepestScrollable(document.body) || page;
  }

  function step() {
    return Math.max(180, Math.floor(window.innerHeight * 0.75));
  }

  function go(dir) {
    const target = scrollTarget();
    const delta = step() * (dir === "up" ? -1 : 1);
    if (typeof target.scrollBy === "function") {
      target.scrollBy({ top: delta, behavior: "smooth" });
    } else {
      target.scrollTop += delta;
    }
  }

  function chevron(dir) {
    return dir === "up"
      ? '<svg class="scroll-nav-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6.7 14.7a1 1 0 0 1 0-1.4l4.6-4.6a1 1 0 0 1 1.4 0l4.6 4.6a1 1 0 1 1-1.4 1.4L12 11.4l-3.9 3.3a1 1 0 0 1-1.4 0z"/></svg>'
      : '<svg class="scroll-nav-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6.7 9.3a1 1 0 0 1 1.4 0L12 12.6l3.9-3.3a1 1 0 1 1 1.4 1.4l-4.6 4.6a1 1 0 0 1-1.4 0l-4.6-4.6a1 1 0 0 1 0-1.4z"/></svg>';
  }

  function mount() {
    if (document.getElementById("scroll-nav")) return;
    const nav = document.createElement("div");
    nav.id = "scroll-nav";
    nav.className = "scroll-nav";
    nav.setAttribute("role", "group");
    nav.setAttribute("aria-label", "Page scroll");
    nav.innerHTML = `
      <button type="button" class="scroll-nav-btn" data-scroll-dir="up" aria-label="Go up" title="Go up">
        ${chevron("up")}
        <span class="scroll-nav-label">Up</span>
      </button>
      <button type="button" class="scroll-nav-btn" data-scroll-dir="down" aria-label="Go down" title="Go down">
        ${chevron("down")}
        <span class="scroll-nav-label">Down</span>
      </button>
    `;
    nav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-scroll-dir]");
      if (!btn) return;
      go(btn.getAttribute("data-scroll-dir"));
    });

    const actions = document.querySelector(".topbar-actions");
    if (actions) {
      nav.classList.add("scroll-nav--topbar");
      const before =
        actions.querySelector("#nav-menu-btn") ||
        actions.querySelector("#app-nav") ||
        actions.querySelector(".app-nav");
      if (before) actions.insertBefore(nav, before);
      else actions.appendChild(nav);
      return;
    }
    document.body.appendChild(nav);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
