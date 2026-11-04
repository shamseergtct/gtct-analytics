/** P2-E2A: TEST Local Server delivery pool only; no Firebase sync or cash collection. */
const $ = id => document.getElementById(id);
const state = { me: null, view: 'available', busy: false, suggestionAnchor: '', suggestionsBusy: false };
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
}
function el(tag, cls, content) {
  const x = document.createElement(tag);
  if (cls) x.className = cls;
  if (content != null) x.textContent = String(content);
  return x;
}
function notice(text, error = false) {
  $('message').textContent = text || '';
  $('message').classList.toggle('error', error);
}
function loginView(message = '') {
  $('login-section').hidden = false;
  $('pool-section').hidden = true;
  $('sign-out').hidden = true;
  $('login-error').textContent = message;
  $('login-error').hidden = !message;
}
async function startSession() {
  const r = await api('/v1/session/me');
  if (!r.ok || !r.json.authenticated) { loginView(); return; }
  if (r.json.role !== 'delivery') {
    if (r.json.role === 'kitchen') location.replace('/prep.html');
    else location.replace('/');
    return;
  }
  state.me = r.json;
  $('login-section').hidden = true;
  $('pool-section').hidden = false;
  $('sign-out').hidden = false;
  $('hello').textContent = `${r.json.fullName || 'Delivery'} · Available`;
  await refresh();
}
async function signIn() {
  const username = $('username').value.trim(), password = $('password').value;
  if (!username || !password) return loginView('Enter username and password.');
  $('sign-in').disabled = true;
  try {
    const result = await api('/v1/session/login','POST',{username,password});
    if (!result.ok) { loginView(result.json.error || 'Sign in failed.'); return; }
    $('password').value = '';
    await startSession();
  } catch { loginView('Could not connect to the server.'); }
  finally { $('sign-in').disabled = false; }
}
function refreshBlocks(orders) {
  const previous = $('block').value;
  const blocks = [...new Set([...orders.map(o => o.blockNumber).filter(Boolean),previous].filter(Boolean))]
    .sort((a,b) => a.localeCompare(b,undefined,{numeric:true}));
  $('block').replaceChildren(new Option('All blocks',''),...blocks.map(b => new Option(`Block ${b}`,b)));
  $('block').value = previous;
}
const REPORT_LABELS = {
  UNMARKED: 'Not marked',
  CASH_WITH_BOY: 'Cash with me · pending handover',
  SHOP_PAID_REPORTED: 'Paid at shop · awaiting verification',
  CREDIT_REPORTED: 'Credit · awaiting approval',
  PAID_CONFIRMED: 'Paid at shop · verified',
  CREDIT_APPROVED: 'Credit authorized by shop · receivable posting pending',
  PARTIAL_SHOP: 'Partial shop allocation · check remaining balance',
  CREDIT_REJECTED: 'Credit rejected by shop · change payment method',
};
function amountText(o, amountCents = o.totalCents) {
  const decimals = Math.min(Math.max(Number(o.currencyDecimals) || 2, 0), 4);
  return `${(Number(amountCents || 0) / 10 ** decimals).toFixed(decimals)} ${o.currencyCode || ''}`.trim();
}
function paymentControls(o) {
  const pay = o.paymentReport || { status: 'UNMARKED', version: 0, canMark: true };
  const area = el('section', 'payment-mark');
  const header = el('div', 'payment-heading');
  header.append(el('strong','', 'Customer payment'),
    el('span', pay.status === 'PAID_CONFIRMED' ? 'verified-payment' : 'reported-payment',
      REPORT_LABELS[pay.status] || 'Not marked'));
  area.append(header);
  if (pay.status === 'PAID_CONFIRMED') {
    area.append(el('div', 'payment-note', 'Verified from shop payment ledger. No rider cash to hand over.'));
    return area;
  }
  if (pay.status === 'CREDIT_APPROVED') {
    area.append(el('div', 'payment-note',
      `Approved by ${pay.reviewedBy || 'shop'}. This approval does NOT create a receivable or shop cash posting.`));
    return area;
  }
  if (pay.status === 'PARTIAL_SHOP') {
    area.append(el('div','payment-note',
      `Shop cash ${amountText(o,pay.cashCents || 0)} · Bank ${amountText(o,pay.bankCents || 0)} · Credit ${amountText(o,pay.creditCents || 0)} · Unallocated ${amountText(o,pay.unallocatedCents || 0)}. Ask cashier before collecting remaining amount.`));
    return area;
  }
  if (pay.status === 'CREDIT_REJECTED') {
    area.append(el('div','payment-warning','Shop rejected credit. Choose another payment method.'));
  }
  if (['CANCEL_REQUESTED','CANCELLED'].includes(o.deliveryLifecycle?.status)) {
    area.append(el('p','payment-warning',
      'Cancellation requested/cancelled. Payment changes require cashier resolution.'));
    return area;
  }
  if (pay.amountChanged) area.append(el('div','payment-warning',
    'Order total has changed since the last mark. Review and update.'));
  const choices = [
    ['CASH_WITH_BOY', 'Cash collected by me'],
    ['SHOP_PAID_REPORTED', 'Paid directly at shop'],
    ['CREDIT_REPORTED', 'Customer credit'],
  ];
  const picker = el('select', 'payment-select');
  picker.setAttribute('aria-label', `Payment method for ${o.orderNumber}`);
  picker.append(new Option('Select payment type…',''),
    ...choices.map(([value,label])=>new Option(label,value)));
  picker.value = choices.some(([v]) => v === pay.status) ? pay.status : '';
  const save = el('button','outline save-payment','Save payment mark');
  save.type = 'button';
  save.disabled = !picker.value;
  picker.addEventListener('change', ()=>{
    save.disabled = !picker.value || picker.value === pay.status;
  });
  if (picker.value === pay.status) save.disabled = true;
  save.addEventListener('click', ()=>void savePaymentMark(o,picker,save));
  const fields = el('div','payment-fields');
  fields.append(picker,save); area.append(fields);
  area.append(el('div','payment-note',
    'Reports do not post payments. Shop paid is verified only when cashier records a real payment; credit requires shop approval.'));
  return area;
}
async function savePaymentMark(o,picker,button) {
  const reportType = picker.value;
  if (!reportType) return;
  const explanation = reportType === 'CASH_WITH_BOY'
    ? 'Record full order cash as held by you until end-of-shift handover?'
    : reportType === 'SHOP_PAID_REPORTED'
      ? 'Report payment at shop? This does NOT post a new shop payment.'
      : 'Report customer credit? Cashier must approve before credit is posted.';
  if (!confirm(explanation)) return;
  button.disabled = true;
  try {
    const r = await api(`/v1/delivery-pool/${encodeURIComponent(o.orderId)}/payment-report`,
      'POST',{ reportType, expectedVersion: Number(o.paymentReport?.version || 0) });
    if (!r.ok) {
      notice(r.json.error || 'Payment not marked. Refresh and retry.', true);
      await refresh(true);
      return;
    }
    await refresh(true);
    notice(`${o.orderNumber} payment marked. ${reportType === 'CASH_WITH_BOY' ? 'Cash pending handover.' : 'Cashier confirmation pending.'}`);
  } catch {
    notice('Connection lost. Refresh to check the recorded payment before retrying.', true);
  } finally {button.disabled = false;}
}
function displayCashSummary(groups) {
  const host = $('cash-summary');
  if (!host) return;
  host.replaceChildren();
  if (state.view !== 'mine') {host.hidden = true;return;}
  host.hidden = false;
  const title = el('strong','', 'Cash marked with me');
  host.append(title);
  const list = Array.isArray(groups) ? groups : [];
  if (list.length) {
    list.forEach(g=> host.append(el('div','cash-amount', amountText(g,g.amountCents))));
  } else host.append(el('div','cash-amount','—'));
  host.append(el('p','', 'Not received by shop · handover will be recorded separately.'));
}
const DELIVERY_LABELS = {
  PENDING: 'Pending delivery',
  DELIVERED: 'Delivered',
  CANCEL_REQUESTED: 'Cancellation · awaiting shop approval',
  CANCELLED: 'Delivery cancelled · invoice unchanged',
};
function deliveryControls(o) {
  const life = o.deliveryLifecycle || {status:'PENDING',version:0};
  const box = el('section','delivery-lifecycle');
  const head = el('div','delivery-heading');
  head.append(el('strong','','Delivery status'),
    el('span',`delivery-state status-${life.status.toLowerCase()}`,
      DELIVERY_LABELS[life.status] || 'Pending'));
  box.append(head);
  if (life.reason) box.append(el('p','payment-note',`Note: ${life.reason}`));
  if (life.status !== 'PENDING') return box;
  const buttons = el('div','lifecycle-actions');
  const delivered = el('button','primary','Mark delivered');
  delivered.type='button';
  delivered.addEventListener('click',()=>void updateDelivery(o,'DELIVERED',delivered));
  const request = el('button','outline','Request cancellation');
  request.type='button';
  request.addEventListener('click',()=>void updateDelivery(o,'REQUEST_CANCEL',request));
  buttons.append(delivered,request);
  box.append(buttons);
  return box;
}
async function updateDelivery(order,action,button) {
  const reason = action === 'REQUEST_CANCEL'
    ? prompt(`Why cancel delivery ${order.orderNumber}? (shop approval required)`)
    : '';
  if (reason === null) return;
  if (action === 'REQUEST_CANCEL' && reason.trim().length < 3) {
    notice('Cancellation reason required.',true);return;
  }
  if (action === 'DELIVERED' &&
    !confirm(`Confirm ${order.orderNumber} delivered to customer? This does NOT mark shop payment received.`)) return;
  button.disabled=true;
  try {
    const r=await api(`/v1/delivery-pool/${encodeURIComponent(order.orderId)}/status`,'POST',{
      action, expectedVersion: Number(order.deliveryLifecycle?.version || 0),reason
    });
    if (!r.ok) {notice(r.json.error || 'Status update failed. Refresh.',true);await refresh(true);return;}
    await refresh(true);
    notice(action==='DELIVERED' ? `${order.orderNumber} marked Delivered.`:
      `${order.orderNumber} cancellation requested. Shop must approve.`);
  } catch {notice('Connection lost. Refresh to verify before retry.',true);}
  finally {button.disabled=false;}
}
function drawOrder(o, mine = false) {
  const card = el('article','order');
  const heading = el('header');
  heading.append(el('strong','',o.orderNumber),el('span','token',o.tokenNumber ? `Token ${String(o.tokenNumber).padStart(3,'0')}` : 'TEST'));
  card.append(heading);
  card.append(el('div','route',[o.blockNumber && `Block ${o.blockNumber}`,o.roadNumber && `Road ${o.roadNumber}`,o.buildingNumber && `Building ${o.buildingNumber}`].filter(Boolean).join(' · ') || 'Address not entered'));
  const customer = [o.customerName,o.customerPhone].filter(Boolean).join(' · ');
  if (customer) card.append(el('div','customer',customer));
  const meta = el('div','meta');
  meta.append(el('span','',new Date(o.createdAt).toLocaleTimeString([], { hour:'numeric',minute:'2-digit' })));
  if (mine) meta.append(el('span','',o.status === 'PACKING_RECHECK_REQUIRED'
    ? 'Packing recheck required' : DELIVERY_LABELS[o.deliveryLifecycle?.status] || 'Accepted'));
  card.append(meta);
  if (mine) {
    card.append(el('div','order-total', amountText(o)));
    card.append(deliveryControls(o));
    card.append(paymentControls(o));
  }
  if (!mine) {
    const button = el('button','primary','Accept delivery');
    button.type = 'button';
    button.addEventListener('click', () => void acceptOrder(o, button));
    card.append(button);
  } else {
    const button = el('button','outline route-finder','Find orders on this route');
    button.type = 'button';
    button.addEventListener('click', () => void requestRouteSuggestions(o.orderId));
    card.append(button);
  }
  return card;
}
async function acceptOrder(o, button) {
  if (!confirm(`Accept ${o.orderNumber} for delivery?`)) return;
  button.disabled = true;
  try {
    // The server atomically checks both availability and packing revision.
    const r = await api(`/v1/delivery-pool/${encodeURIComponent(o.orderId)}/accept`,'POST',{
      expectedRevision:o.expectedRevision,
    });
    if (!r.ok) {
      notice(r.json.error || 'Could not accept. Refresh.', true);
      await refresh(true);
      if (state.suggestionAnchor) await requestRouteSuggestions(state.suggestionAnchor,true);
      return;
    }
    notice(`${o.orderNumber} accepted.`);
    state.suggestionAnchor = o.orderId;
    // Re-read from server; never treat the suggestion as an assignment.
    await requestRouteSuggestions(o.orderId, true);
    await refresh(true);
  } catch { notice('Connection lost. Check the order before retrying.', true); }
  finally { button.disabled = false; }
}
function showSuggestions(orders, context = {}) {
  const host = $('suggestions');
  host.replaceChildren();
  if (!orders.length) { host.hidden = true; return; }
  host.hidden = false;
  const title = el('h2','',`More in Block ${context.blockNumber || orders[0].blockNumber}`);
  const sub = el('p','hint',`Near ${context.anchorOrderNumber || 'your order'} · Same road first`);
  host.append(title, sub);
  const list = el('div','suggestion-list');
  for (const o of orders) {
    const card = el('article','suggestion-item');
    const info = el('div','suggestion-info');
    const label = el('span', o.sameRoad ? 'suggestion-tag priority' : 'suggestion-tag',
      o.sameRoad ? 'Same road' : 'Same block');
    info.append(label, el('strong','',o.orderNumber));
    info.append(el('div','route',`Block ${o.blockNumber} · Road ${o.roadNumber || '—'}${o.buildingNumber ? ` · Building ${o.buildingNumber}` : ''}`));
    const button = el('button','primary suggestion-accept','Accept');
    button.type = 'button';
    button.setAttribute('aria-label',`Accept ${o.orderNumber}`);
    button.addEventListener('click', () => void acceptOrder(o, button));
    card.append(info,button);
    list.append(card);
  }
  host.append(list);
}
async function requestRouteSuggestions(acceptedOrderId, silent = false) {
  if (state.suggestionsBusy || !state.me) return;
  state.suggestionsBusy = true;
  try {
    const r = await api(`/v1/delivery-pool/suggestions?orderId=${encodeURIComponent(acceptedOrderId)}`);
    if (!r.ok) {
      if (r.status === 401) { loginView('Session expired. Sign in again.'); return; }
      if (!silent) notice(r.json.error || 'Could not find orders.', true);
      state.suggestionAnchor = '';
      $('suggestions').hidden = true;
      return;
    }
    state.suggestionAnchor = acceptedOrderId;
    showSuggestions(r.json.orders || [],r.json);
    if (!(r.json.orders || []).length && !silent) notice('No other available orders in this block.');
  } catch {
    if (!silent) notice('Connection lost. Try again.', true);
  } finally { state.suggestionsBusy = false; }
}
function switchView(view) {
  state.view = view;
  $('available-tab').classList.toggle('active',view==='available');
  $('mine-tab').classList.toggle('active',view==='mine');
  $('available-tab').setAttribute('aria-pressed',String(view==='available'));
  $('mine-tab').setAttribute('aria-pressed',String(view==='mine'));
  $('filters').hidden = view==='mine';
  if ($('cash-summary')) $('cash-summary').hidden = view !== 'mine';
  $('hello').textContent = `${state.me?.fullName || 'Delivery'} · ${view === 'mine' ? 'My orders' : 'Available'}`;
  state.suggestionAnchor = '';
  $('suggestions').hidden = true;
  void refresh();
}
async function refresh(keepNotice = false) {
  if (!state.me || state.busy || document.hidden) return;
  state.busy = true;
  try {
    if (!keepNotice) notice('Loading…');
    const endpoint = state.view === 'mine' ? '/v1/delivery-pool/mine' : '/v1/delivery-pool';
    const params = new URLSearchParams();
    if (state.view === 'available') {
      if ($('block').value) params.set('block',$('block').value);
      if ($('road').value.trim()) params.set('road',$('road').value.trim());
    }
    const r = await api(endpoint + (params.size ? `?${params}` : ''));
    if (r.status===401) { loginView('Session expired. Sign in again.'); return; }
    if (!r.ok) { notice(r.json.error || 'Could not load orders.',true); return; }
    const list = r.json.orders || [];
    displayCashSummary(r.json.pendingCashByCurrency || []);
    const host = $('delivery-list');
    host.replaceChildren(...(list.length ? list.map(o=>drawOrder(o,state.view==='mine')) : [el('div','empty',state.view==='mine'?'No accepted orders.':'No ready orders match your filters.') ]));
    if (state.view === 'available' && !$('block').value && !$('road').value.trim()) refreshBlocks(list);
    if (!keepNotice) notice(`${list.length} ${state.view==='mine'?'accepted':'available'} order(s)`);
  } catch { notice('Connection lost. Try Refresh.',true); }
  finally { state.busy = false; }
}
$('sign-in').addEventListener('click',()=>void signIn());
for(const id of ['username','password']) $(id).addEventListener('keydown',ev=>{if(ev.key==='Enter')void signIn()});
$('sign-out').addEventListener('click',async()=>{await api('/v1/session/logout','POST',{});state.me=null;state.suggestionAnchor='';$('suggestions').hidden=true;loginView()});
$('available-tab').addEventListener('click',()=>switchView('available'));
$('mine-tab').addEventListener('click',()=>switchView('mine'));
$('refresh').addEventListener('click',()=>void refresh());
$('block').addEventListener('change',()=>void refresh());
$('road').addEventListener('change',()=>void refresh());
setInterval(()=>{
  if (state.me && state.view==='available')void refresh();
  if (state.me && state.suggestionAnchor)void requestRouteSuggestions(state.suggestionAnchor,true);
},8000);
void startSession();
