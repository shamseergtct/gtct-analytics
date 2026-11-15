/* TEST-only order monitor; no delivery payment / commission operations. */
import { registerPwa } from "./pwa.js";
registerPwa();
const $ = id => document.getElementById(id);
const state = { session: null, page: 1, pageSize: 60, busy: false, expandedOrderIds: new Set() };

async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, json };
}
function node(tag, className, textValue) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (textValue !== undefined) e.textContent = String(textValue);
  return e;
}
function showLogin(message) {
  state.session = null;
  $('login-view').hidden = false;
  $('main-view').hidden = true;
  $('login-error').hidden = !message;
  $('login-error').textContent = message || '';
}
function showMain() {
  $('login-view').hidden = true;
  $('main-view').hidden = false;
  $('session-role').textContent = state.session.fullName || state.session.role;
  void refresh();
}
function filters() {
  const params = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize) });
  for (const [key, id] of [['behavior', 'behavior'], ['date', 'order-date'], ['q', 'order-search']]) {
    const value = $(id).value.trim();
    if (value) params.set(key, value);
  }
  return params.toString();
}
function stageBadge(text, theme) {
  return node('span', `monitor-pill ${theme || ''}`, text);
}
function titleCase(value) {
  return String(value || '').replaceAll('_', ' ');
}
function statusClass(value) {
  if (['FINISHED','READY_FOR_DELIVERY','DELIVERED','PAID'].includes(value)) return 'is-success';
  if (['CANCEL_REQUESTED','CANCELLED','RECHECK','REJECTED','VOID'].includes(value)) return 'is-danger';
  if (['PREPARING','ACCEPTED','PROCESSING'].includes(value)) return 'is-progress';
  if (['CREDIT','CREDIT_APPROVED'].includes(value)) return 'is-credit';
  return 'is-neutral';
}
const TYPE_ORDER = ['DELIVERY', 'TAKEAWAY', 'COUNTER', 'TABLE', 'CAR_HOP'];
const LANE_ORDER = [
  { key: 'pending', deliveryLabel: 'Pending', otherLabel: 'Pending' },
  { key: 'ready', deliveryLabel: 'Ready for delivery', otherLabel: 'Ready' },
  { key: 'out', deliveryLabel: 'Out for delivery', otherLabel: 'Out for delivery' },
  { key: 'delivered', deliveryLabel: 'Delivered', otherLabel: 'Completed' },
];
function orderTypeKey(order) {
  return String(order.fulfillmentBehavior || order.orderTypeName || 'OTHER').toUpperCase();
}
function boardLane(order) {
  const life = order.deliveryLifecycle || {};
  const dispatch = order.dispatch || {};
  const prepRaw = order.preparation?.stage || 'NEW';
  const claimed = Boolean(order.deliveryBoyName);
  const type = orderTypeKey(order);

  if (order.fulfillmentStatus === 'VOID') return 'pending';

  if (type === 'DELIVERY') {
    if (life.status === 'DELIVERED') return 'delivered';
    if (['CANCELLED', 'CANCEL_REQUESTED'].includes(life.status)) return 'pending';
    if (claimed) return 'out';
    if (dispatch.ready) return 'ready';
    return 'pending';
  }

  // Counter / takeaway / dine-in / car-hop: ready when kitchen finished.
  if (prepRaw === 'FINISHED' && String(order.paymentStatus || '').toUpperCase() === 'PAID') {
    return 'delivered';
  }
  if (prepRaw === 'FINISHED') return 'ready';
  return 'pending';
}
function compareOrders(a, b) {
  const tokenA = Number(a.tokenNumber);
  const tokenB = Number(b.tokenNumber);
  if (Number.isFinite(tokenA) && Number.isFinite(tokenB) && tokenA !== tokenB) return tokenB - tokenA;
  return String(b.orderNumber || '').localeCompare(String(a.orderNumber || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}
function renderBoard(orders) {
  const host = $('monitor-list');
  host.replaceChildren();
  const byType = new Map();
  for (const order of orders || []) {
    const type = orderTypeKey(order);
    if (!byType.has(type)) {
      byType.set(type, { ready: [], pending: [], out: [], delivered: [] });
    }
    byType.get(type)[boardLane(order)].push(order);
  }
  const types = [...byType.keys()].sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a);
    const ib = TYPE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  if (!types.length) {
    host.append(node('p', 'monitor-empty', 'No orders for this filter.'));
    return;
  }
  for (const type of types) {
    const buckets = byType.get(type);
    const typeCount = LANE_ORDER.reduce((n, lane) => n + buckets[lane.key].length, 0);
    const section = node('section', 'monitor-type-section');
    section.append(node('h2', 'monitor-type-heading', `${titleCase(type)} · ${typeCount}`));
    for (const lane of LANE_ORDER) {
      const rows = buckets[lane.key].sort(compareOrders);
      if (!rows.length) continue;
      const laneEl = node('div', `monitor-lane monitor-lane-${lane.key}`);
      const label = type === 'DELIVERY' ? lane.deliveryLabel : lane.otherLabel;
      laneEl.append(node('h3', 'monitor-lane-heading', `${label} · ${rows.length}`));
      const grid = node('div', 'monitor-lane-grid');
      for (const order of rows) grid.append(renderOrder(order));
      laneEl.append(grid);
      section.append(laneEl);
    }
    host.append(section);
  }
}
function smallBadge(value, className) {
  return stageBadge(value, className || 'is-neutral');
}
function renderOrder(order) {
  const article = node('article', 'monitor-order');
  const prep = order.preparation || {};
  const dispatch = order.dispatch || {};
  const prepRaw = prep.stage || 'NEW';
  const kitchen = prepRaw === 'FINISHED' ? 'FINISHED'
    : ['PREPARING','ACCEPTED'].includes(prepRaw) ? 'PROCESSING' : 'NEW';
  const life = order.deliveryLifecycle || {};
  const riderPay = order.deliveryPaymentReport || {};

  const header = node('div', 'monitor-card-head');
  const identity = node('div', 'monitor-card-identity');
  identity.append(node('h2', 'monitor-number', order.orderNumber || 'Order'));
  if (Number.isFinite(Number(order.tokenNumber)) && order.tokenNumber != null && String(order.tokenNumber) !== '') {
    identity.append(node('span', 'monitor-token', `TOKEN ${String(order.tokenNumber).padStart(3, '0')}`));
  }
  header.append(identity);
  header.append(node('span', 'monitor-type', titleCase(order.fulfillmentBehavior || order.orderTypeName || 'ORDER')));
  article.append(header);

  const meta = node('div', 'monitor-card-meta');
  if (order.customerName) meta.append(node('span', 'monitor-customer', order.customerName));
  const address = [order.blockNumber && `Block ${order.blockNumber}`, order.roadNumber && `Road ${order.roadNumber}`, order.buildingNumber && `Building ${order.buildingNumber}`].filter(Boolean).join(' · ');
  if (address) meta.append(node('span', 'monitor-address', address));
  article.append(meta);

  const badges = node('div', 'monitor-card-statuses');
  if (order.fulfillmentStatus === 'VOID') badges.append(smallBadge('VOID', 'is-danger'));
  else badges.append(smallBadge(kitchen, statusClass(kitchen)));
  if (order.fulfillmentStatus !== 'VOID' && order.fulfillmentBehavior === 'DELIVERY') {
    if (life.status === 'DELIVERED') badges.append(smallBadge('DELIVERED', 'is-success'));
    else if (life.status === 'CANCEL_REQUESTED') badges.append(smallBadge('CANCEL REQUESTED', 'is-danger'));
    else if (life.status === 'CANCELLED') badges.append(smallBadge('CANCELLED', 'is-danger'));
    else if (dispatch.ready) badges.append(smallBadge('READY FOR DELIVERY', 'is-success'));
  }
  const credit = order.shopCreditAuthorization?.state === 'APPROVED' || riderPay.shopAuthorized;
  const payment = String(order.paymentStatus || 'UNPAID').toUpperCase();
  if (order.fulfillmentStatus === 'VOID') { /* Void is not unpaid or a payment reversal. */ }
  else if (payment === 'PAID') badges.append(smallBadge('PAID', 'is-success'));
  else if (credit || payment === 'CREDIT') badges.append(smallBadge('CREDIT', 'is-credit'));
  else if (payment === 'PARTIAL') badges.append(smallBadge('PARTIAL', 'is-progress'));
  else badges.append(smallBadge('UNPAID', 'is-neutral'));
  article.append(badges);

  const footer = node('div', 'monitor-card-footer');
  if (order.deliveryBoyName) footer.append(node('span', 'monitor-rider', `Rider: ${order.deliveryBoyName}`));
  else footer.append(node('span', 'monitor-footer-spacer', ''));
  const canDispatch = state.session.permissions.includes('sales.orders.dispatch');
  if (order.fulfillmentStatus !== 'VOID' && dispatch.canMarkReady && canDispatch) {
    const btn = node('button', 'btn primary monitor-ready', 'Ready for delivery');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      if (!window.confirm(`Confirm all items packed for ${order.orderNumber}?`)) return;
      btn.disabled = true;
      const result = await api(`/v1/order-monitor/${encodeURIComponent(order.orderId)}/ready`, 'POST', { expectedRevision: dispatch.revision });
      if (!result.ok) window.alert(result.json.error || 'Could not confirm. Refresh and review.');
      await refresh();
    });
    footer.append(btn);
  } else if (order.fulfillmentStatus !== 'VOID' && dispatch.canUnmarkReady && canDispatch) {
    const btn = node('button', 'btn ghost monitor-ready monitor-unready', 'Back to pending');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      if (!window.confirm(`Move ${order.orderNumber} back to Pending?`)) return;
      btn.disabled = true;
      const result = await api(`/v1/order-monitor/${encodeURIComponent(order.orderId)}/unready`, 'POST', { expectedRevision: dispatch.revision });
      if (!result.ok) window.alert(result.json.error || 'Could not update status. Refresh and review.');
      await refresh();
    });
    footer.append(btn);
  }
  article.append(footer);

  // Management tasks are preserved but hidden until explicitly opened.
  const details = node('details', 'monitor-detail');
  details.open = state.expandedOrderIds.has(order.orderId);
  details.addEventListener('toggle', () => {
    if (details.open) state.expandedOrderIds.add(order.orderId);
    else state.expandedOrderIds.delete(order.orderId);
  });
  const summary = node('summary', 'monitor-detail-trigger', 'Details');
  details.append(summary);
  const detailBody = node('div', 'monitor-detail-body');
  const stations = node('ul', 'monitor-station-list');
  for (const station of prep.stations || []) {
    stations.append(node('li', '', `${station.stationName}: ${station.status}`));
  }
  if (prep.unassignedLineCount) stations.append(node('li', '', `${prep.unassignedLineCount} item(s) need kitchen station routing`));
  if (stations.childElementCount) detailBody.append(stations);
  if (dispatch.status) detailBody.append(node('p','monitor-meta',`Dispatch: ${titleCase(dispatch.status)}`));
  if (riderPay.status && order.deliveryBoyName) detailBody.append(node('p','monitor-meta',`Rider payment: ${titleCase(riderPay.status)}`));
  if (order.fulfillmentBehavior === 'DELIVERY' && state.session.permissions.includes('sales.orders.view') &&
    ['admin','cashier'].includes(state.session.role)) {
    const life = order.deliveryLifecycle || {};
    const p = order.deliveryPaymentReport || {};
    if (life.status === 'CANCEL_REQUESTED' && life.reason) {
      detailBody.append(node('p','monitor-meta',`Cancellation reason: ${life.reason}`));
    }
    if (life.status === 'CANCEL_REQUESTED') {
      const actions = node('div','monitor-review-actions');
      for (const [action, caption] of [['APPROVE_CANCEL','Approve delivery cancellation'],
        ['REJECT_CANCEL','Reject cancellation request']]) {
        const btn=node('button','btn ghost',caption);btn.type='button';
        btn.addEventListener('click',async()=>{
          if (!confirm(`${caption} for ${order.orderNumber}? Invoice is NOT voided/refunded.`)) return;
          btn.disabled=true;
          const res=await api(`/v1/delivery-review/${encodeURIComponent(order.orderId)}/cancellation`,'POST',
            {action,expectedVersion:life.version});
          if (!res.ok) alert(res.json.error||'Review failed.');
          await refresh();
        });
        actions.append(btn);
      }
      detailBody.append(actions);
    }
    if (p.status === 'SHOP_PAID_REPORTED') {
      const info=node('div','monitor-review-actions');
      info.append(node('p','monitor-meta','Delivery Boy reports paid at shop. Verify against actual cashier settlement; do not approve a second payment.'));
      const link=node('a','btn ghost','Open Orders to record/check payment');
      link.href='/orders.html';
      info.append(link);detailBody.append(info);
    }
    // Credit entered by the shop is authoritative, not a new rider-approval queue.
    const alreadyShopApproved = p.shopAuthorized || order.shopCreditAuthorization?.state === 'APPROVED';
    if (alreadyShopApproved) {
      const info=node('div','monitor-review-actions');
      info.append(node('p','monitor-meta',`Customer Credit approved by ${p.reviewedBy || order.shopCreditAuthorization?.approved_by || 'shop'} — visible to Delivery Boy. Receivable ledger posting pending.`));
      const revoke=node('button','btn ghost','Revoke shop credit authorization');
      revoke.type='button';
      revoke.addEventListener('click',async()=>{
        const note=prompt(`Reason to revoke credit authorization for ${order.orderNumber}?`);
        if (note === null) return;
        if (note.trim().length < 3) {alert('Enter a reason (at least 3 characters).');return;}
        if (!confirm(`Revoke shop credit authorization for ${order.orderNumber}? No finance entry is reversed.`)) return;
        revoke.disabled=true;
        const res=await api(`/v1/delivery-review/${encodeURIComponent(order.orderId)}/shop-credit`,'POST',
          {action:'REVOKE',expectedVersion:Number(order.shopCreditAuthorization?.version || p.shopCreditVersion || 0),note:note.trim()});
        if (!res.ok) alert(res.json.error || 'Could not revoke.');
        await refresh();
      });
      info.append(revoke);detailBody.append(info);
    } else if (order.paymentStatus !== 'PAID' &&
        !['CANCELLED','CANCEL_REQUESTED'].includes(life.status)) {
      const link=node('a','btn ghost','Open Orders · Cash / Bank / Credit');
      link.href='/orders.html';
      detailBody.append(link);
    }
    if (p.status === 'CREDIT_REPORTED') {
      const info=node('div','monitor-review-actions');
      info.append(node('p','monitor-meta',
        'Rider requests customer credit. Check with the shop, then record the correct Cash / Bank / Credit allocation in Orders. No separate credit approval is required.'));
      const link=node('a','btn ghost','Open Orders · Record verified payment');
      link.href='/orders.html';
      info.append(link);detailBody.append(info);
    }
  }
  details.append(detailBody);
  article.append(details);
  return article;
}
async function refresh() {
  if (!state.session || state.busy || document.hidden) return;
  state.busy = true;
  try {
    $('monitor-status').textContent = 'Loading orders…';
    const result = await api(`/v1/order-monitor?${filters()}`);
    if (result.status === 401) return showLogin('Sign in to continue.');
    if (result.status === 403) { $('monitor-status').textContent = 'You do not have permission to monitor orders.'; return; }
    if (!result.ok) { $('monitor-status').textContent = result.json.error || 'Could not load orders.'; return; }
    const data = result.json;
    renderBoard(data.orders || []);
    $('monitor-status').textContent = `${data.total} orders`;
    $('page-label').textContent = `Page ${data.page}`;
    $('prev-page').disabled = state.page <= 1;
    $('next-page').disabled = state.page * data.pageSize >= data.total;
  } catch { $('monitor-status').textContent = 'Connection lost. Refresh to try again.'; }
  finally { state.busy = false; }
}
async function signIn() {
  const result = await api('/v1/session/login', 'POST', {
    username: $('login-username').value.trim(), password: $('login-password').value,
  });
  if (!result.ok) return showLogin(result.json.error || 'Sign-in failed.');
  $('login-password').value = '';
  await startSession();
}
async function startSession() {
  const result = await api('/v1/session/me');
  if (!result.ok || !result.json.authenticated) return showLogin('Sign in to monitor orders.');
  if (result.json.role === 'kitchen') {
    window.location.replace('/prep.html');
    return;
  }
  state.session = result.json;
  showMain();
}
$('login-btn').addEventListener('click', () => void signIn());
$('logout-btn').addEventListener('click', async () => { await api('/v1/session/logout', 'POST'); showLogin(); });
$('refresh-btn').addEventListener('click', () => void refresh());
for (const [id, mode] of [['view-grid', 'grid'], ['view-list', 'list']]) {
  $(id).addEventListener('click', () => {
    $('monitor-list').classList.toggle('is-list', mode === 'list');
    $('view-grid').setAttribute('aria-pressed', String(mode === 'grid'));
    $('view-list').setAttribute('aria-pressed', String(mode === 'list'));
  });
}

for (const id of ['behavior', 'order-date', 'order-search']) {
  $(id).addEventListener(id === 'order-search' ? 'change' : 'change', () => { state.page = 1; void refresh(); });
}
$('prev-page').addEventListener('click', () => { state.page = Math.max(1, state.page - 1); void refresh(); });
$('next-page').addEventListener('click', () => { state.page += 1; void refresh(); });
window.setInterval(() => { if (state.session && !document.hidden) void refresh(); }, 8000);
await startSession();
