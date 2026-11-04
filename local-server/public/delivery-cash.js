/* P2-E3B UI1: read-only delivery roster + rider-scoped handover display.
 * The existing server validates all amounts, assignments, permissions and idempotency.
 */
const $ = (id) => document.getElementById(id);
let refreshBusy = false;
let selectedRiderId = null; // No rider selected; no cash confirmation in overview.
let snapshot = { riders: [], pending: [], history: [] };
const submissions = new Map(); // Preserve an uncertain network retry's submission ID.

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = String(text);
  return item;
}
async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}
function notice(message, type = '') {
  const box = $('notification');
  box.className = `cash-notice${type ? ` ${type}` : ''}`;
  box.textContent = message;
}
function money(v, dec = 3, cc = 'BHD') {
  const digits = Number.isInteger(Number(dec)) && Number(dec) >= 0 && Number(dec) <= 3 ? Number(dec) : 3;
  return `${(Number(v) / 10 ** digits).toFixed(digits)} ${cc}`;
}
function totals(items) {
  const map = new Map();
  for (const o of items) {
    const key = `${o.currencyCode}:${o.currencyDecimals}`;
    const old = map.get(key);
    if (old) old.amount += o.amountCents;
    else map.set(key, { amount: o.amountCents, currencyCode: o.currencyCode, currencyDecimals: o.currencyDecimals });
  }
  return [...map.values()].map(o => money(o.amount, o.currencyDecimals, o.currencyCode)).join(' + ') || '—';
}
function getRiders() {
  const map = new Map();
  for (const r of snapshot.riders) {
    if (r.userId) map.set(r.userId, { ...r });
  }
  // Retain historical / no-longer-active riders represented by settlements.
  for (const o of [...snapshot.pending, ...snapshot.history]) {
    if (!o.driverUserId) continue;
    if (!map.has(o.driverUserId)) {
      map.set(o.driverUserId, { userId: o.driverUserId, fullName: o.driverName || 'Delivery Boy', isActive: false });
    }
  }
  return [...map.values()].sort((a, b) =>
    Number(Boolean(b.isActive)) - Number(Boolean(a.isActive)) ||
    String(a.fullName).localeCompare(String(b.fullName)));
}
function pendingFor(id) { return snapshot.pending.filter(x => x.driverUserId === id); }
function historyFor(id) { return snapshot.history.filter(x => x.driverUserId === id); }
function btnRider(rider, title, subtitle, count, initials, active) {
  const btn = element('button', 'cash-rider-btn');
  btn.type = 'button';
  btn.setAttribute('aria-pressed', String(selectedRiderId === rider));
  btn.append(element('span', 'cash-avatar', initials));
  const meta = element('span', 'cash-rider-meta');
  meta.append(element('span', 'cash-rider-name', title), element('span', 'cash-rider-sub', subtitle));
  btn.append(meta, element('span', `cash-count${count > 0 ? ' has-pending' : ''}`, count));
  btn.addEventListener('click', () => { selectedRiderId = rider; selectPendingDayForRider(); render(); resetBatchDecision(); void loadBatch(); });
  if (!active) btn.title = 'Inactive rider; history remains visible';
  return btn;
}
function showRiders() {
  const host = $('rider-list'); host.replaceChildren();
  const riders = getRiders();
  $('rider-total').textContent = `${riders.length} riders`;
  host.append(btnRider(null, 'All riders', 'Overview · select a rider to settle', snapshot.pending.length, 'ALL', true));
  const q = $('rider-search').value.trim().toLocaleLowerCase();
  const matching = riders.filter(r => String(r.fullName).toLocaleLowerCase().includes(q));
  for (const r of matching) {
    const count = pendingFor(r.userId).length;
    const sub = `${r.isActive ? 'Active' : 'Inactive'} · ${count} pending invoice${count === 1 ? '' : 's'}`;
    const initials = (r.fullName || '?').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(w => w[0]).join('').toUpperCase();
    host.append(btnRider(r.userId, r.fullName, sub, count, initials, r.isActive));
  }
  if (!matching.length) host.append(element('p', 'cash-empty', 'No delivery boy matches your search.'));
}
// Invoice details are display-only; commission on a daily target is never
// allocated to individual orders without an explicit allocation in accounting.
function displayDetail(value, prefix = '') {
  const clean = String(value ?? '').trim();
  return clean ? prefix + clean : '—';
}
function invoiceDetails(inv, currencyCode, currencyDecimals, historical = false) {
  const card = element('div', 'cash-bill-meta');
  const fields = [
    ['Customer',displayDetail(inv.customerName)],
    ['Block / Location',displayDetail(inv.blockNumber, 'Block ')],
    ['Delivery charge',Number.isSafeInteger(inv.deliveryChargeMinor)
      ? money(inv.deliveryChargeMinor,currencyDecimals,currencyCode) : '—'],
    ['Commission',Number.isSafeInteger(inv.commissionMinor)
      ? (inv.commissionMinor > 0 ? money(inv.commissionMinor,currencyDecimals,currencyCode) : '—')
      : (historical ? 'See settlement total' : 'Calculated at settlement')],
  ];
  for (const [label,value] of fields) {
    const field=element('span','cash-bill-field');
    field.append(element('small','',label),element('span','',value));
    card.append(field);
  }
  return card;
}
function showPending(items) {
  const host = $('pending'); host.replaceChildren();
  if (selectedRiderId === null) {
    host.append(element('p', 'cash-empty', 'Select a delivery boy from the rider list to review their cash and confirm handover.'));
    return;
  }
  if (!items.length) {
    host.append(element('p', 'cash-empty', 'No delivered, unpaid rider cash awaiting handover for this delivery boy.'));
    return;
  }
  for (const o of items) {
    const card = element('article', 'cash-invoice');
    const top = element('div', 'cash-invoice-head');
    const id = element('div');
    id.append(element('strong', 'cash-invoice-id', o.orderNumber),
      element('span', 'cash-ref', `Ref: ${o.orderId}`));
    top.append(id, element('span', 'cash-mini-tag', 'DELIVERED'));
    const body = element('div', 'cash-invoice-details');
    body.append(element('span', 'cash-driver', o.driverName),
      element('strong', 'cash-money', money(o.amountCents, o.currencyDecimals, o.currencyCode)));
    const btn = element('button', 'btn primary cash-confirm', 'Confirm cash received');
    btn.type = 'button';
    btn.addEventListener('click', () => void confirmItem(o, btn));
    card.append(top, body, invoiceDetails(o,o.currencyCode,o.currencyDecimals), btn);
    host.append(card);
  }
}
function showHistory(items) {
  const host = $('history'); host.replaceChildren();
  if (selectedRiderId === null) {
    host.append(element('p', 'cash-empty', 'Select a rider to view their confirmed handover history.'));
    return;
  }
  if (!items.length) {
    host.append(element('p', 'cash-empty', 'No confirmed handovers in the recent history for this rider.'));
    return;
  }
  for (const o of items) {
    const row = element('div', 'cash-history-item');
    const left = element('div');
    left.append(element('strong', '', `${o.orderNumber} · ${o.driverName}`),
      element('span', 'cash-ref', new Date(o.confirmedAt).toLocaleString()));
    row.append(left, element('span', 'cash-history-amount',
      money(o.amountCents, o.currencyDecimals, o.currencyCode)));
    row.append(invoiceDetails(o,o.currencyCode,o.currencyDecimals,true));
    host.append(row);
  }
}
function render() {
  const riders = getRiders();
  if (selectedRiderId && !riders.some(r => r.userId === selectedRiderId)) selectedRiderId = null;
  showRiders();
  const rider = riders.find(r => r.userId === selectedRiderId);
  const pending = rider ? pendingFor(selectedRiderId) : snapshot.pending;
  const history = rider ? historyFor(selectedRiderId) : snapshot.history;
  $('selected-rider-name').textContent = rider?.fullName || 'All riders overview';
  $('selected-rider-hint').textContent = rider
    ? 'Only this rider’s deliveries and confirmed cash handovers are shown.'
    : 'Choose a rider to review invoices and confirm cash handover.';
  $('selected-status').hidden = !rider;
  if (rider) $('selected-status').textContent = rider.isActive ? 'Active rider' : 'Inactive rider';
  $('pending-context').textContent = rider
    ? 'Delivered, eligible invoices held by this rider.'
    : 'Rider selection required before cashier confirmation.';
  $('pending-count').textContent = String(pending.length);
  $('settled-count').textContent = String(history.length);
  $('pending-amount').textContent = totals(pending);
  showPending(pending);
  showHistory(history);
}
async function confirmItem(o, button) {
  if (!selectedRiderId || selectedRiderId !== o.driverUserId) {
    notice('Select the correct rider before confirming a cash handover.', 'bad'); return;
  }
  const display = money(o.amountCents, o.currencyDecimals, o.currencyCode);
  if (!confirm(`Confirm you physically received ${display} from ${o.driverName} for invoice ${o.orderNumber}?\n\nThis posts the full amount as shop cash. No commission will be deducted.`)) return;
  const submissionId = submissions.get(o.orderId) || `handover_${crypto.randomUUID().replaceAll('-', '')}`;
  submissions.set(o.orderId, submissionId);
  button.disabled = true;
  const body = { submissionId, expectedReportVersion: o.reportVersion,
    driverUserId: o.driverUserId, amountCents: o.amountCents, currencyCode: o.currencyCode };
  try {
    const result = await api(`/v1/delivery-cash-handovers/${encodeURIComponent(o.orderId)}/confirm`, 'POST', body);
    if (!result.ok) {
      notice(`${result.json.code || 'ERROR'}: ${result.json.error || 'Could not confirm cash'}`, 'bad');
      button.disabled = false; return;
    }
    submissions.delete(o.orderId);
    notice(`Confirmed: ${o.driverName} · ${o.orderNumber} · ${display}.`, 'good');
    await refresh(false);
  } catch {
    notice('Network error: payment may have posted. Retry the same invoice after connection returns; the original submission ID is retained.', 'bad');
    button.disabled = false;
  }
}
async function refresh(showMessage = true) {
  if (refreshBusy) return;
  refreshBusy = true; $('refresh').disabled = true;
  try {
    const result = await api('/v1/delivery-cash-handovers');
    if (result.status === 401) { location.replace('/monitor.html'); return; }
    if (!result.ok) { notice(result.json.error || 'Cash handover access denied.', 'bad'); return; }
    if (!Array.isArray(result.json.pending) || !Array.isArray(result.json.history)) {
      notice('Unexpected settlement response. No changes were made.', 'bad'); return;
    }
    snapshot = {
      riders: Array.isArray(result.json.riders) ? result.json.riders : [],
      pending: result.json.pending,
      history: result.json.history,
    };
    render();
    if (isCommissionAdmin) {renderRiderDates();await loadBatch();}
    if (showMessage) notice('Rider cash list refreshed. Select a rider to settle.');
  } catch { notice('Cannot load rider cash. Check local server connection.', 'bad'); }
  finally { refreshBusy = false; $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', () => void refresh());
$('rider-search').addEventListener('input', () => showRiders());
void (async () => {
  try {
    const auth = await api('/v1/session/me');
    if (auth.status === 401 || !auth.json.authenticated) { location.replace('/monitor.html'); return; }
    if (!['admin', 'cashier'].includes(auth.json.role) ||
        !auth.json.permissions?.includes('sales.payment.receive')) {
      notice('Only authorized Admin/Cashier users can view and confirm cash handovers.', 'bad'); return;
    }
    isCommissionAdmin = auth.json.role === 'admin' && Boolean(auth.json.staff) &&
      auth.json.permissions.includes('staff.manage');
    $('batch-panel').hidden = !isCommissionAdmin;
    $('batch-history-panel').hidden = !isCommissionAdmin;
    $('shift-panel').hidden = !isCommissionAdmin;
    if (isCommissionAdmin) { batchDayDefault(); await loadTenderBanks(); void loadShiftStatus(); }
    await refresh();
  } catch { notice('Could not verify your session.', 'bad'); }
})();


/* P2-E3C5: the existing Rider Cash page is the SINGLE collection entry point.
 * The previously separate net-settlement service remains the only authority for
 * gross invoice cash, approved commission, net shop cash and journal posting.
 * This script does NOT manufacture accounting entries or calculate expense.
 */
let isCommissionAdmin = false;
let batchSnapshot = null;
let batchClosing = null;
let batchLoadEpoch = 0;
let batchConfirmBusy = false;
let batchRetryBody = null;
let batchTenderDraft = null;
let tenderBanks = [];
const correctionRetries = new Map();
const BATCH_API = '/v1/delivery-rider-settlements';

function batchDayDefault() {
  // Do not assume yesterday is the only date eligible for collection.
  // Once the selected rider's pending dates load, select their oldest date.
  const local = new Date();
  $('batch-day').value = [local.getFullYear(), String(local.getMonth()+1).padStart(2,'0'),
    String(local.getDate()).padStart(2,'0')].join('-');
}
function riderPendingDays(riderId) {
  const grouped = new Map();
  for (const order of snapshot.pending) {
    if (order.driverUserId !== riderId || !/^\d{4}-\d{2}-\d{2}$/.test(order.businessDate || '')) continue;
    const date = order.businessDate;
    grouped.set(date, (grouped.get(date)||0)+1);
  }
  return [...grouped].sort(([a],[b])=>a.localeCompare(b));
}
function renderRiderDates() {
  const host=$('batch-pending-days'); if (!host) return;
  host.replaceChildren();
  if (!selectedRiderId) {host.textContent='Choose a rider to see their pending business dates.';return;}
  const days=riderPendingDays(selectedRiderId);
  if (!days.length) {host.textContent='No pending dates in recent invoice list. You can still select a date manually.';return;}
  for (const [date,count] of days) {
    const b=element('button','cash-day-chip',`${date} · ${count} bill${count===1?'':'s'}`);
    b.type='button';b.setAttribute('aria-pressed',String(date===$('batch-day').value));
    b.addEventListener('click',()=>{$('batch-day').value=date;resetBatchDecision();void loadBatch();});
    host.append(b);
  }
}
function selectPendingDayForRider(){
  const days=riderPendingDays(selectedRiderId);
  if (days.length) $('batch-day').value=days[0][0];
  renderRiderDates();
}
let activeShift=null;
async function loadShiftStatus(){
  if (!isCommissionAdmin) return;
  const el=$('shift-state');if(!el)return;
  try {
    const r=await batchRequest('/v1/business-shift');
    activeShift=r.active || null;
    const suggested=r.suggestedBusinessDate || $('batch-day').value;
    if(activeShift){
      el.textContent=`Open POS shift: ${activeShift.businessDate} · Last token ${activeShift.lastTokenNumber}. Closing does NOT settle cash.`;
      $('shift-close').disabled=false; $('shift-open').disabled=true;
      // Suggest the shop-local calendar date for a new shift, never change rider collection date.
      $('shift-next-date').value=suggested;
    } else {
      el.textContent='No open POS shift. Admin can open a shift for new Sales orders. Previous rider collections remain accessible.';
      $('shift-close').disabled=true; $('shift-open').disabled=false;
      $('shift-next-date').value=suggested;
    }
  } catch(e) {
    activeShift=null; el.textContent=`Unable to load POS shift: ${e.message}`;
    $('shift-close').disabled=true; $('shift-open').disabled=true;
  }
}
async function changeShift(action){
  if(!isCommissionAdmin)return;
  const close=action==='close';
  if(close&&!activeShift)return;
  const day=$('shift-next-date').value;
  if(!close&&!/^\d{4}-\d{2}-\d{2}$/.test(day))return;
  const warning=close
    ? `Close POS shift ${activeShift.businessDate}? Existing shift's orders may no longer be editable. This does NOT collect Rider cash, create commission or reconcile accounts.`
    : `Open new POS shift for ${day}? New bills will be recorded with THIS business date. Rider collections for older dates stay available.`;
  if(!confirm(warning))return;
  const b=$(`shift-${action}`);b.disabled=true;
  try {
    await batchRequest(`/v1/business-shift/${action}`,'POST',close?{shiftId:activeShift.shiftId,confirm:true}:{businessDate:day});
    $('shift-feedback').textContent=`POS shift ${action} successful. Rider collection date was not changed.`;
    await loadShiftStatus();
  }catch(e){ $('shift-feedback').textContent=`Shift ${action} failed: ${e.message}`;await loadShiftStatus(); }
}
function batchNotice(message, kind = '') {
  const box = $('batch-note');
  box.className = `cash-subnotice${kind ? ' ' + kind : ''}`;
  box.textContent = message;
}
async function batchRequest(path, method = 'GET', payload) {
  const res = await fetch(path, {method, credentials:'same-origin',
    headers:{Accept:'application/json', ...(payload ? {'Content-Type':'application/json'} : {})},
    ...(payload ? {body:JSON.stringify(payload)} : {})});
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(Error(`${body.code || res.status}: ${body.error || 'Request failed'}`),
    {status:res.status});
  return body;
}
function setBatchText(id, value) { $(id).textContent = String(value); }
function batchMoney(n, p = batchSnapshot?.preview) {
  if (n == null || !p || !p.currencyCode) return '—';
  return money(n, p.currencyDecimals, p.currencyCode);
}
function minorInputValue(n,p) {
  const decimals=Number(p?.currencyDecimals??3);
  return Number.isSafeInteger(n)?(n/10**decimals).toFixed(decimals):'';
}
function parseMinorInput(text,p) {
  const d=Number(p?.currencyDecimals??3);
  const raw=String(text??'').trim();
  if(!/^\d+(?:\.\d+)?$/.test(raw))return null;
  const parts=raw.split('.');
  if((parts[1]||'').length>d)return null;
  const major=Number(parts[0]),fraction=Number((parts[1]||'').padEnd(d,'0'));
  const minor=major*10**d+fraction;
  return Number.isSafeInteger(minor)&&minor>=0?minor:null;
}
function banksOptions(host, selected) {
  host.replaceChildren(new Option('Select Operational account',''));
  for(const a of tenderBanks)host.append(new Option(`${a.displayName} · ${a.bankName}`,a.accountId));
  host.value=selected||'';
}
async function loadTenderBanks() {
  try {
    const data=await batchRequest('/v1/bank-accounts');
    tenderBanks=(data.accounts||[]).filter(a=>a.isActive&&a.accountType==='OPERATIONAL');
  }catch{tenderBanks=[];}
  banksOptions($('batch-tender-bank-account'),batchTenderDraft?.bankAccountId);
}
function draftTender(p,net) {
  if(!p||!Number.isSafeInteger(net)||net<0)return null;
  if(!batchTenderDraft || batchTenderDraft.key!==`${p.riderUserId}:${p.businessDate}:${p.snapshotHash}`) {
    batchTenderDraft={key:`${p.riderUserId}:${p.businessDate}:${p.snapshotHash}`,
      cashMinor:net,bankMinor:0,bankAccountId:'',note:''};
  }
  // Commission toggle can change the net amount. Preserve bank allocation up to net.
  if(batchTenderDraft.bankMinor>net){batchTenderDraft.bankMinor=0;batchTenderDraft.bankAccountId='';}
  batchTenderDraft.cashMinor=net-batchTenderDraft.bankMinor;
  return batchTenderDraft;
}
function tenderMatchesForm(d,p,net) {
  return Boolean(d && d.cashMinor+d.bankMinor===net &&
    parseMinorInput($('batch-tender-cash').value,p)===d.cashMinor &&
    parseMinorInput($('batch-tender-bank').value,p)===d.bankMinor &&
    (!d.bankMinor || ($('batch-tender-bank-account').value===d.bankAccountId &&
      tenderBanks.some(a=>a.accountId===d.bankAccountId))));
}
function renderTender(p,net) {
  const d=draftTender(p,net);
  const busy=batchConfirmBusy||Boolean(batchRetryBody)||!p?.invoiceCount;
  const fields=[['batch-tender-cash',d?.cashMinor],['batch-tender-bank',d?.bankMinor]];
  for(const [id,value] of fields) {
    const el=$(id); el.disabled=busy;
    if(document.activeElement!==el)el.value=d?minorInputValue(value,p):'';
  }
  $('batch-tender-bank-account').disabled=busy||!d?.bankMinor;
  banksOptions($('batch-tender-bank-account'),d?.bankAccountId);
  $('batch-tender-note').disabled=busy;
  if(document.activeElement!==$('batch-tender-note'))$('batch-tender-note').value=d?.note||'';
  setBatchText('batch-summary-cash',batchMoney(d?.cashMinor,p));
  setBatchText('batch-summary-bank',batchMoney(d?.bankMinor,p));
  const valid=tenderMatchesForm(d,p,net);
  const el=$('batch-tender-status');
  el.className='cash-tender-info'+(!valid&&d?' is-error':'');
  el.textContent=!d?'Choose rider and date to edit payment methods.':!valid
    ?'Choose a valid Operational bank account; Cash + Bank must equal net collection.'
    :`Collection split balanced: ${batchMoney(d.cashMinor,p)} cash + ${batchMoney(d.bankMinor,p)} bank.`;
  return valid;
}
function handleTenderField(type) {
  const p=batchSnapshot?.preview;
  if(!p||!batchTenderDraft||batchRetryBody)return;
  const available=batchAvailable(p);
  const net=p.grossMinor-($('batch-pay-commission').checked?available.amount:0);
  if(type==='cash'||type==='bank') {
    const field=$(`batch-tender-${type}`);
    const value=parseMinorInput(field.value,p);
    if(value===null||value>net){
      $('batch-tender-status').textContent='Enter a valid amount not greater than net collection.';
      $('batch-tender-status').className='cash-tender-info is-error';
      $('batch-confirm').disabled=true;return;
    }
    if(type==='cash'){batchTenderDraft.cashMinor=value;batchTenderDraft.bankMinor=net-value;}
    else {batchTenderDraft.bankMinor=value;batchTenderDraft.cashMinor=net-value;}
    if(batchTenderDraft.bankMinor===0)batchTenderDraft.bankAccountId='';
  }else if(type==='account') batchTenderDraft.bankAccountId=$('batch-tender-bank-account').value;
  else if(type==='note') batchTenderDraft.note=$('batch-tender-note').value.trim();
  renderBatch();
}
function resetBatchDecision() {
  ++batchLoadEpoch; // invalidate in-flight quotes for a different rider or date
  batchRetryBody = null;
  batchTenderDraft = null;
  batchSnapshot = null;
  batchClosing = null;
  $('batch-pay-commission').checked = false;
  renderBatch();
}
// P2-E3C8: explain WHY a saved commission is not yet payable.
// Never turn a provisional estimate into cash deduction without server eligibility.
function batchUnavailableReason(p, closing) {
  if (closing?.error) return `Commission check failed: ${closing.error}. Nothing is deducted. Refresh before collecting.`;
  if (!closing) return 'Commission eligibility is still loading. Wait for the check before collecting.';
  if (!closing.activePolicy) return `No commission rule is effective for ${p.businessDate}. Review this Delivery Boy in User Management.`;
  if (Number(closing.skippedOrders) > 0) return `${closing.skippedOrders} delivered invoice(s) failed the commission currency/amount checks. Reconcile before collection.`;
  const estimate = closing.estimatedCommissionMinor;
  if (!Number.isSafeInteger(estimate) || estimate <= 0) return 'Saved rule calculates no positive commission for this business date.';
  const formatted = batchMoney(estimate,p);
  if (closing.currentBusinessDate && p.businessDate >= closing.currentBusinessDate)
    return `Estimated daily commission: ${formatted}. This business date has not ended in the shop timezone (${closing.currentBusinessDate}); automatic commission deduction is finalized after the calendar day, not by POS shift closure. No second approval is required.`;
  if (closing.alreadyAccrued)
    return `Estimated daily commission: ${formatted}, but an accrual is already recorded and no unpaid payable was found. Reconcile the commission ledger before collecting.`;
  if (!closing.eligibleDeliveryCount)
    return 'No eligible delivered bills exist for this commission period.';
  return `Estimated daily commission: ${formatted}, but it is not eligible for posting yet. Refresh and review the business date, saved rule and invoice currency.`;
}
function batchAvailable(p) {
  if (!p) return {amount:0, auto:false, explanation:'Select a rider and date.'};
  if (p.accrual?.paid) return {amount:0, auto:false, explanation:'Commission was already paid. It cannot be deducted again.'};
  if (p.accrual) return {amount:p.accrual.amountMinor, auto:false,
    explanation:`Saved commission ${batchMoney(p.accrual.amountMinor,p)}. This settles payable without creating duplicate expense.`};
  if (batchClosing?.canAccrue && /^[a-f0-9]{64}$/.test(String(batchClosing.factsHash||'')) &&
      Number.isSafeInteger(batchClosing.estimatedCommissionMinor) && batchClosing.estimatedCommissionMinor > 0)
    return {amount:batchClosing.estimatedCommissionMinor, auto:true,
      explanation:`Saved Rider rule: ${batchMoney(batchClosing.estimatedCommissionMinor,p)} daily commission. Expense and payable will be booked once when this collection is confirmed. No second approval.`};
  return {amount:0, auto:false, explanation:batchUnavailableReason(p,batchClosing)};
}
function makeTenderCorrectionEditor(entry,tender) {
  const wrap=element('details','cash-tender-edit');
  const summary=element('summary','','Edit collection payment methods · audited correction');
  wrap.append(summary);
  const info=element('p','cash-correction-notice',
    'Only Cash/Bank classification and reference may be corrected. Invoice totals, rider and commission remain immutable.');
  wrap.append(info);
  const grid=element('div','cash-tender-edit-grid');
  function field(label,text,type='text') {
    const l=element('label','',label),el=document.createElement(type==='select'?'select':'input');
    if(type!=='select'){el.type='text';el.inputMode='decimal';}
    l.append(el);grid.append(l);return el;
  }
  const cash=field('Cash received',null);
  const bank=field('Bank received',null);
  const account=field('Operational bank account',null,'select');
  const note=field('Reference / note',null);
  cash.value=minorInputValue(tender.cashMinor,entry);
  bank.value=minorInputValue(tender.bankMinor,entry);
  note.value=tender.note||'';
  banksOptions(account,tender.bankAccountId);
  bank.addEventListener('change',()=>{
    const n=parseMinorInput(bank.value,entry);
    if(n!==null&&n<=entry.shopCashMinor)cash.value=minorInputValue(entry.shopCashMinor-n,entry);
  });
  cash.addEventListener('change',()=>{
    const n=parseMinorInput(cash.value,entry);
    if(n!==null&&n<=entry.shopCashMinor)bank.value=minorInputValue(entry.shopCashMinor-n,entry);
  });
  wrap.append(grid);
  const actions=element('div','cash-tender-edit-actions');
  const save=element('button','btn ghost','Save audited correction');save.type='button';
  const status=element('span','cash-correction-notice','');
  actions.append(save,status);wrap.append(actions);
  save.addEventListener('click',async()=>{
    const cashMinor=parseMinorInput(cash.value,entry),bankMinor=parseMinorInput(bank.value,entry);
    if(cashMinor===null||bankMinor===null||cashMinor+bankMinor!==entry.shopCashMinor ||
       (bankMinor>0&&!tenderBanks.some(a=>a.accountId===account.value))){
      status.textContent='Cash + Bank must equal original net receipt and an active Operational bank account is required.';return;
    }
    const fields={cashMinor,bankMinor,bankAccountId:bankMinor?account.value:null,note:note.value.trim()};
    const existing=correctionRetries.get(entry.settlementId);
    const payload={expectedTenderVersion:tender.version,tender:fields,
      submissionId:existing?.submissionId||`correct_${crypto.randomUUID().replaceAll('-','')}`};
    if(existing&&JSON.stringify(existing)!==JSON.stringify(payload)){
      status.textContent='Previous correction outcome uncertain. Refresh before changing values.';return;
    }
    if(!existing && !confirm(`Correct settlement ${entry.settlementId}? Changes are audited; original invoice payments and commission will not change.`))return;
    correctionRetries.set(entry.settlementId,payload);save.disabled=true;
    try {
      await batchRequest(`${BATCH_API}/${encodeURIComponent(entry.settlementId)}/correct-tender`,'POST',payload);
      correctionRetries.delete(entry.settlementId);
      status.textContent='Correction recorded; refreshing history.';
      await refresh(false);
      batchNotice('Payment method correction recorded in audit history.','good');
    } catch(e) {status.textContent=e.message+' — retry same values, or refresh to inspect the record.';save.disabled=false;}
  });
  return wrap;
}
function renderBatch() {
  const p = batchSnapshot?.preview || null;
  const o = p?.overview;
  setBatchText('batch-total-bills', o?.totalDeliveredBills ?? '—');
  setBatchText('batch-total', o ? batchMoney(o.totalDeliveredMinor,p) : '—');
  setBatchText('batch-shop-paid', o ? batchMoney(o.directShopPaidMinor,p) : '—');
  setBatchText('batch-credit', o ? batchMoney(o.customerCreditAllocatedMinor,p) : '—');
  setBatchText('batch-count',p?.invoiceCount ?? '—');
  setBatchText('batch-gross',p ? batchMoney(p.grossMinor,p) : '—');
  const available = batchAvailable(p);
  setBatchText('batch-commission',p ? batchMoney(available.amount,p) : '—');
  setBatchText('batch-commission-detail',available.explanation);
  const opt = $('batch-pay-commission');
  opt.disabled = !p?.invoiceCount || !Number.isSafeInteger(available.amount) ||
    available.amount <= 0 || available.amount > p.grossMinor || batchConfirmBusy;
  if (opt.disabled) opt.checked = false;
  // Existing rider rule is already authorized by Staff Admin when the user was saved.
  const auto = Boolean(opt.checked && available.auto);
  const retained = opt.checked ? available.amount : 0;
  const net = p ? p.grossMinor - retained : null;
  setBatchText('batch-net',batchMoney(net,p));
  setBatchText('batch-summary-gross',batchMoney(p?.grossMinor,p));
  setBatchText('batch-summary-commission',batchMoney(p ? retained : null,p));
  setBatchText('batch-summary-net',batchMoney(net,p));
  const tenderValid=renderTender(p,net);
  const rows = $('batch-lines'); rows.replaceChildren();
  const invoices = p?.orders || [];
  setBatchText('batch-lines-count',`${invoices.length} bills`);
  if (!invoices.length) rows.append(element('p','cash-empty','No eligible pending rider cash invoices for this date.'));
  for (const inv of invoices) {
    const item = element('div');
    item.className='cash-bill-line';
    const heading=element('div','cash-bill-line-head');
    heading.append(element('strong','',inv.orderNumber),element('strong','',batchMoney(inv.amountMinor,p)));
    item.append(heading,invoiceDetails(inv,p.currencyCode,p.currencyDecimals));
    rows.append(item);
  }
  const history = $('batch-history'); history.replaceChildren();
  const items = (batchSnapshot?.history || []).filter(x=>x.riderUserId === selectedRiderId).slice(0,100);
  if (!items.length) history.append(element('p','cash-empty',selectedRiderId ? 'No batch settlements for this rider.' : 'Select a rider to view batch history.'));
  for (const entry of items) {
    const row = element('div','cash-history-item');
    const label = element('div');
    label.append(element('strong','',`${entry.businessDate} · ${entry.invoiceCount} bills`),
      element('span','cash-ref',`Gross ${money(entry.grossMinor,entry.currencyDecimals,entry.currencyCode)} · Commission ${money(entry.commissionMinor,entry.currencyDecimals,entry.currencyCode)}`));
    row.append(label,element('strong','cash-history-amount',money(entry.shopCashMinor,entry.currencyDecimals,entry.currencyCode)));
    const breakdown=element('details','cash-history-breakdown');
    const summary=element('summary','',`View ${entry.invoiceCount} invoice details`);
    breakdown.append(summary);
    const note=element('p','cash-bill-footnote',entry.commissionAllocationNote ||
      'Commission is recorded at settlement level; no invoice split is assumed.');
    breakdown.append(note);
    for(const inv of entry.orders || []) {
      const invoice=element('div','cash-bill-line');
      const head=element('div','cash-bill-line-head');
      head.append(element('strong','',inv.orderNumber),element('strong','',
        money(inv.amountMinor,entry.currencyDecimals,entry.currencyCode)));
      invoice.append(head,invoiceDetails(inv,entry.currencyCode,entry.currencyDecimals,true));
      breakdown.append(invoice);
    }
    if (!Array.isArray(entry.orders)) breakdown.append(element('p','cash-bill-footnote','Invoice details unavailable for this older history record.'));
    const tender=entry.tender||{cashMinor:entry.shopCashMinor,bankMinor:0,bankAccountId:null,version:0,note:''};
    row.append(element('div','cash-history-tender',
      `Shop received: Cash ${money(tender.cashMinor,entry.currencyDecimals,entry.currencyCode)} · Bank ${money(tender.bankMinor,entry.currencyDecimals,entry.currencyCode)}${tender.note?' · '+tender.note:''}`));
    const wrap=element('div','cash-history-entry');
    wrap.append(row,breakdown);
    wrap.append(makeTenderCorrectionEditor(entry,tender));
    history.append(wrap);
  }
  // Fail closed when a configured commission is positive but cannot yet be
  // accrued/paid: accepting gross cash would lose the intended rider offset.
  // A missing/error commission preview is also not a reason to post zero.
  const estimate = batchClosing?.estimatedCommissionMinor;
  const commissionUnknown = Boolean(p?.invoiceCount && !p?.accrual &&
    (!batchClosing || batchClosing.error));
  const positiveButBlocked = Boolean(p?.invoiceCount && !p?.accrual?.paid &&
    ((Number.isSafeInteger(estimate) && estimate > 0 &&
      (available.amount <= 0 || available.amount > p.grossMinor)) ||
     (p.accrual && available.amount > p.grossMinor)));
  $('batch-confirm').disabled = batchConfirmBusy || !isCommissionAdmin || !selectedRiderId ||
    !p?.invoiceCount || commissionUnknown || positiveButBlocked || !tenderValid;
}
async function loadBatch() {
  if (!isCommissionAdmin) return;
  const epoch = ++batchLoadEpoch;
  const rider = selectedRiderId;
  const date = $('batch-day').value;
  batchSnapshot = null; batchClosing = null;
  renderBatch();
  batchNotice(rider ? 'Loading rider collection…' : 'Select a rider from the list to review collections.');
  try {
    const query = rider && date ? `?riderUserId=${encodeURIComponent(rider)}&businessDate=${encodeURIComponent(date)}` : '';
    const result = await batchRequest(BATCH_API + query);
    if (epoch !== batchLoadEpoch) return;
    batchSnapshot = result;
    if (result.preview) {
      try {
        const closing = await batchRequest(`/v1/delivery-commissions/${encodeURIComponent(rider)}/closing-preview?businessDate=${encodeURIComponent(date)}`);
        if (epoch !== batchLoadEpoch) return;
        batchClosing = closing;
      } catch(error) {
        if (epoch !== batchLoadEpoch) return;
        batchClosing = {error:error.message};
      }
    }
    renderBatch();
    const available=batchAvailable(result.preview);
    if(!batchRetryBody && result.preview && available.amount>0 && available.amount<=result.preview.grossMinor){
      $('batch-pay-commission').checked=true; renderBatch();
    }
    const commissionBlocked = result.preview && !result.preview.accrual?.paid &&
      ((Number.isSafeInteger(batchClosing?.estimatedCommissionMinor) &&
        batchClosing.estimatedCommissionMinor > 0 &&
        (available.amount <= 0 || available.amount > result.preview.grossMinor)) ||
       (!result.preview.accrual && (!batchClosing || batchClosing.error)));
    const oldShiftStillOpen=Boolean(batchClosing?.shopCalendarBusinessDate &&
      batchClosing?.activeShiftBusinessDate===date &&
      batchClosing.shopCalendarBusinessDate>date);
    const warning=oldShiftStillOpen
      ? ` WARNING: POS shift still uses ${date} for NEW sales. If more deliveries are created on this date after commission is finalized, further collections will be blocked for reconciliation. Open the correct new POS shift before new sales.` : '';
    batchNotice((!result.preview ? 'Select a rider to begin.' : commissionBlocked
      ? `Collection is paused: ${available.explanation}`
      : available.amount > 0
        ? 'Saved rider commission is available. Review the net cash and confirm.'
        : 'No unpaid commission to deduct. Review the displayed breakdown before confirming.') + warning,
      commissionBlocked ? 'bad' : oldShiftStillOpen ? 'caution' : 'good');
  } catch(error) {
    if (epoch !== batchLoadEpoch) return;
    batchSnapshot = null; batchClosing = null;
    renderBatch();
    batchNotice(error.message, 'bad');
  }
}
async function confirmBatch() {
  if (batchConfirmBusy || !isCommissionAdmin) return;
  const p = batchSnapshot?.preview;
  if (!p?.invoiceCount || p.riderUserId !== selectedRiderId || p.businessDate !== $('batch-day').value) return;
  const available = batchAvailable(p);
  const payCommission = $('batch-pay-commission').checked;
  // Commission already authorized in Staff User Management. No second approval.
  const commission = payCommission ? available.amount : 0;
  if (!Number.isSafeInteger(commission) || commission < 0 || commission > p.grossMinor) {
    batchNotice('Invalid commission; refresh the rider collection.', 'bad');return;
  }
  if(!tenderMatchesForm(batchTenderDraft,p,p.grossMinor-commission)){
    batchNotice('Cash/Bank payment details are incomplete. Check the collection split.', 'bad');return;
  }
  const body = {tender:{cashMinor:batchTenderDraft.cashMinor,bankMinor:batchTenderDraft.bankMinor,
      bankAccountId:batchTenderDraft.bankMinor>0?batchTenderDraft.bankAccountId:null,note:batchTenderDraft.note},
    riderUserId:selectedRiderId,businessDate:p.businessDate,payCommission,
    expectedFactsHash:payCommission && available.auto?batchClosing.factsHash:'',
    expectedSnapshotHash:p.snapshotHash, expectedGrossMinor:p.grossMinor,
    expectedCommissionMinor:commission,
    submissionId:batchRetryBody?.submissionId || `net_${crypto.randomUUID().replaceAll('-','')}`};
  // Always reuse the exact payload after an uncertain network response.
  if (batchRetryBody && JSON.stringify(batchRetryBody) !== JSON.stringify(body)) {
    batchNotice('A previous submission is pending. Refresh before changing collection values.', 'bad'); return;
  }
  if (!batchRetryBody && !confirm(`Receive ${batchMoney(batchTenderDraft.cashMinor,p)} cash + ${batchMoney(batchTenderDraft.bankMinor,p)} bank from rider?\nGross customer collections: ${batchMoney(p.grossMinor,p)}\nCommission retained: ${batchMoney(commission,p)}\n${p.invoiceCount} invoices will be marked paid. Confirm?`)) return;
  batchRetryBody = body;
  batchConfirmBusy = true;
  renderBatch();
  try {
    const response = await batchRequest(BATCH_API,'POST',body);
    batchRetryBody = null;
    const confirmed = money(response.shopCashMinor,response.currencyDecimals,response.currencyCode);
    const id = response.settlementId;
    batchConfirmBusy = false;
    // Refresh both immutable invoice handovers and batch history.
    await refresh(false);
    batchNotice(`Confirmed settlement ${id}: physically received ${confirmed}.`, 'good');
    notice('Rider collection confirmed. Existing invoice and cash records have been refreshed.', 'good');
  } catch (error) {
    batchConfirmBusy = false;
    renderBatch();
    batchNotice(`${error.message}. If the connection failed, retry without changing the selection or amounts.`, 'bad');
  }
}
$('batch-day').addEventListener('change', () => {resetBatchDecision();renderRiderDates();void loadBatch();});
$('shift-close').addEventListener('click',()=>void changeShift('close'));
$('shift-open').addEventListener('click',()=>void changeShift('open'));
$('batch-refresh').addEventListener('click', () => {resetBatchDecision();void refresh();});
$('batch-pay-commission').addEventListener('change', () => {batchRetryBody=null;renderBatch();});
$('batch-confirm').addEventListener('click', () => void confirmBatch());

$('batch-tender-cash').addEventListener('input',()=>handleTenderField('cash'));
$('batch-tender-bank').addEventListener('input',()=>handleTenderField('bank'));
$('batch-tender-bank-account').addEventListener('change',()=>handleTenderField('account'));
$('batch-tender-note').addEventListener('change',()=>handleTenderField('note'));
