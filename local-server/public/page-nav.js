/* Back + Home buttons on every staff page. Home always opens Sales ("/").
   Injected into the page header; pages without a header get a slim bar. */
(function () {
  "use strict";
  const path = location.pathname;
  // Sales is the home page; setup/recovery run before sign-in; monitor only redirects.
  const SKIP = ["/", "/index.html", "/setup.html", "/recovery.html", "/monitor.html"];
  if (SKIP.includes(path)) return;

  const ICON_BACK =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M15.7 5.3a1 1 0 0 1 0 1.4L10.4 12l5.3 5.3a1 1 0 1 1-1.4 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.4 0z"/></svg>';
  const ICON_HOME =
    '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M11.3 3.3a1 1 0 0 1 1.4 0l8 7.5a1 1 0 0 1-1.4 1.4L19 11.9V19a2 2 0 0 1-2 2h-3a1 1 0 0 1-1-1v-4h-2v4a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2v-7.1l-.3.3a1 1 0 0 1-1.4-1.4l8-7.5z"/></svg>';

  function goBack() {
    let sameSite = false;
    try {
      sameSite = Boolean(document.referrer) && new URL(document.referrer).origin === location.origin;
    } catch {
      sameSite = false;
    }
    if (sameSite && history.length > 1) history.back();
    else location.href = "/";
  }

  function build() {
    const nav = document.createElement("nav");
    nav.className = "page-nav";
    nav.setAttribute("aria-label", "Page navigation");
    nav.innerHTML =
      `<button type="button" class="page-nav-btn" data-page-nav="back" aria-label="Back">${ICON_BACK}<span>Back</span></button>` +
      `<a class="page-nav-btn" href="/" data-page-nav="home" aria-label="Home (Sales)">${ICON_HOME}<span>Home</span></a>`;
    nav.querySelector('[data-page-nav="back"]').addEventListener("click", goBack);
    return nav;
  }

  function mount() {
    if (document.querySelector(".page-nav")) return;
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/page-nav.css";
    document.head.appendChild(css);

    const nav = build();
    const header =
      document.querySelector("#main-view header.topbar") ||
      document.querySelector("header.topbar") ||
      document.querySelector("body > header");
    if (header && header.firstElementChild) {
      // Keep the header's left/right layout: put the buttons beside the title.
      const lead = document.createElement("div");
      lead.className = "page-nav-lead";
      header.insertBefore(lead, header.firstElementChild);
      lead.appendChild(nav);
      lead.appendChild(lead.nextElementSibling);
    } else {
      const bar = document.createElement("div");
      bar.className = "page-nav-bar";
      bar.appendChild(nav);
      document.body.insertBefore(bar, document.body.firstChild);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
