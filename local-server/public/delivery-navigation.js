/* P2-E3C2. Presentation-only dropdown behavior. Payment and commission services untouched. */
(() => {
  const groups = Array.from(document.querySelectorAll('.delivery-nav-group'));
  if (!groups.length) return;
  for (const group of groups) {
    group.addEventListener('toggle', () => {
      if (!group.open) return;
      for (const other of groups) if (other !== group) other.open = false;
    });
  }
  document.addEventListener('pointerdown', (event) => {
    for (const group of groups) if (!group.contains(event.target)) group.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') for (const group of groups) group.open = false;
  });
  for (const group of groups) {
    group.querySelectorAll('.delivery-sub-link').forEach((link) => {
      link.addEventListener('click', () => { group.open = false; });
    });
  }
  // On the Rider Cash page the existing server session determines if the
  // Commission Setup link is offered. Backend still enforces authorization.
  if (document.body.classList.contains('cash-page')) {
    fetch('/v1/session/me', {credentials: 'same-origin', headers: {Accept: 'application/json'}})
      .then((response) => response.ok ? response.json() : null)
      .then((session) => {
        const admin = Boolean(session?.authenticated && session.role === 'admin' &&
          session.staff && (session.permissions || []).includes('staff.manage'));
        const installed = document.querySelector('#delivery-commission-link')?.dataset.installed === 'yes';
        const link = document.getElementById('delivery-commission-link');
        const unavailable = document.getElementById('delivery-commission-unavailable');
        if (link) link.hidden = !admin || !installed;
        if (unavailable) unavailable.hidden = !admin || installed;
      })
      .catch(() => {
        const link = document.getElementById('delivery-commission-link');
        if (link) link.hidden = true;
      });
  }
})();
