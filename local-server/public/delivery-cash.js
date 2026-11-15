/* P2-E3B UI1: read-only delivery roster + rider-scoped handover display.
 * The existing server validates all amounts, assignments, permissions and idempotency.
 */
import {
  buildRiderCashPrintHtml,
  openRiderCashPrint,
  moneyPreview,
  formatPrintToken,
} from './delivery-cash-print.js';

const $ = (id) => document.getElementById(id);
let refreshBusy = false;
let selectedRiderId = null; // No rider selected; no cash confirmation in overview.
let expandedBoyId = null;
let snapshot = { riders: [], pending: [], history: [] };
const submissions = new Map(); // Preserve an uncertain network retry's submission ID.
let shopDisplayName = 'Shop';
let printPreview = null;
let printMode = 'THERMAL';

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
function moneyAmount(v, dec = 3) {
  const digits = Number.isInteger(Number(dec)) && Number(dec) >= 0 && Number(dec) <= 3 ? Number(dec) : 3;
  return (Number(v) / 10 ** digits).toFixed(digits);
}
/** Collect-page style: "BHD 1.200" */
function moneyLabel(v, dec = 3, cc = 'BHD') {
  return `${String(cc || 'BHD').trim()} ${moneyAmount(v, dec)}`;
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
function selectRider(riderId) {
  selectedRiderId = riderId || null;
  if (riderId) expandedBoyId = riderId;
  selectPendingDayForRider();
  render();
  resetBatchDecision();
  void loadBatch();
}
function billsForRider(riderId) {
  const preview = batchSnapshot?.preview;
  if (
    preview?.riderUserId === riderId &&
    Array.isArray(preview.orders) &&
    preview.orders.length
  ) {
    return preview.orders.map((o) => ({
      orderNumber: o.orderNumber,
      tokenNumber: o.tokenNumber,
      amountMinor: Number(o.amountMinor || 0),
      commissionMinor: Number.isSafeInteger(o.commissionMinor) ? o.commissionMinor : 0,
      customerName: o.customerName || '',
      businessDate: preview.businessDate || '',
      currencyCode: preview.currencyCode || 'BHD',
      currencyDecimals: preview.currencyDecimals ?? 3,
    }));
  }
  return pendingFor(riderId).map((o) => ({
    orderNumber: o.orderNumber,
    tokenNumber: o.tokenNumber,
    amountMinor: Number(o.amountCents || 0),
    commissionMinor: Number.isSafeInteger(o.commissionMinor) ? o.commissionMinor : 0,
    customerName: o.customerName || '',
    businessDate: o.businessDate || '',
    currencyCode: o.currencyCode || 'BHD',
    currencyDecimals: o.currencyDecimals ?? 3,
  }));
}
function formatBillToken(token) {
  if (token == null || token === '') return '—';
  const n = Number(token);
  if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) {
    return String(n).padStart(3, '0');
  }
  return String(token);
}
function buildBillGroups(bills) {
  const groups = new Map();
  for (const bill of bills) {
    const key = bill.businessDate || 'Bills';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bill);
  }
  return [...groups.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
}
function renderBillDetails(riderId) {
  const wrap = element('div', 'cash-bill-groups');
  const bills = billsForRider(riderId);
  const rider = getRiders().find((r) => r.userId === riderId);
  const pending = pendingFor(riderId);
  const overview =
    batchSnapshot?.preview?.riderUserId === riderId
      ? batchSnapshot.preview.overview
      : null;
  const available = batchAvailable(batchSnapshot?.preview);
  const sample = bills[0] || pending[0];
  const dec = sample?.currencyDecimals ?? 3;
  const cc = sample?.currencyCode || 'BHD';
  const totalMinor = overview
    ? Number(overview.totalDeliveredMinor || 0)
    : pending.reduce((s, o) => s + Number(o.amountCents || 0), 0);
  const shopPaid = overview ? Number(overview.directShopPaidMinor || 0) : 0;
  const credit = overview ? Number(overview.customerCreditAllocatedMinor || 0) : 0;
  const commission =
    Number.isSafeInteger(available?.amount) ? available.amount : 0;
  const balance = pending.reduce((s, o) => s + Number(o.amountCents || 0), 0);

  const shell = element('div', 'cash-expand-shell');
  const shellHead = element('div', 'cash-expand-shell-head');
  shellHead.append(
    element('strong', '', rider?.fullName || 'Delivery Boy'),
    element(
      'span',
      '',
      `${bills.length || pending.length} bill${(bills.length || pending.length) === 1 ? '' : 's'} · ${moneyLabel(totalMinor, dec, cc)}`
    )
  );
  shell.append(shellHead);

  const groupsHost = element('div', 'cash-bill-groups-inner');
  if (!bills.length) {
    groupsHost.append(element('p', 'cash-empty', 'No pending bills for this rider.'));
  } else {
    for (const [groupName, rows] of buildBillGroups(bills)) {
      const groupTotal = rows.reduce((s, r) => s + Number(r.amountMinor || 0), 0);
      const groupComm = rows.reduce((s, r) => s + Number(r.commissionMinor || 0), 0);
      const group = element('div', 'cash-bill-group');
      const head = element('div', 'cash-bill-group-head');
      head.append(
        element('strong', '', groupName || 'Bills'),
        element(
          'span',
          '',
          `${rows.length} bill${rows.length === 1 ? '' : 's'} · ${moneyLabel(groupTotal, dec, cc)}`
        )
      );
      group.append(head);
      const scroll = element('div', 'cash-bills-scroll');
      const table = document.createElement('table');
      table.className = 'cash-bills-table';
      table.innerHTML = `<colgroup>
        <col class="col-bill">
        <col class="col-token">
        <col class="col-amount">
        <col class="col-commission">
        <col class="col-customer">
      </colgroup>
      <thead><tr>
        <th scope="col" class="col-bill">Bill No.</th>
        <th scope="col" class="col-token">Token</th>
        <th scope="col" class="num col-amount">Amount</th>
        <th scope="col" class="num col-commission">Commission</th>
        <th scope="col" class="col-customer">Customer</th>
      </tr></thead>`;
      const tbody = document.createElement('tbody');
      for (const bill of rows) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="col-bill"></td><td class="col-token"></td><td class="num col-amount"></td><td class="num col-commission"></td><td class="col-customer"></td>`;
        tr.children[0].textContent = bill.orderNumber || '—';
        tr.children[1].textContent = formatBillToken(bill.tokenNumber);
        const commissionMinor = Number.isSafeInteger(Number(bill.commissionMinor))
          ? Number(bill.commissionMinor)
          : 0;
        tr.children[2].textContent = moneyLabel(Number(bill.amountMinor) || 0, dec, cc);
        tr.children[3].textContent = moneyLabel(commissionMinor, dec, cc);
        const customer = String(bill.customerName ?? '').trim();
        tr.children[4].textContent = customer && customer !== '—' ? customer : '—';
        tbody.append(tr);
      }
      table.append(tbody);
      const tfoot = document.createElement('tfoot');
      tfoot.innerHTML = `<tr>
        <td class="col-bill">Total</td>
        <td class="col-token"></td>
        <td class="num col-amount"></td>
        <td class="num col-commission"></td>
        <td class="col-customer"></td>
      </tr>`;
      const footCells = tfoot.querySelectorAll('td');
      footCells[2].textContent = moneyLabel(groupTotal, dec, cc);
      footCells[3].textContent = moneyLabel(groupComm, dec, cc);
      table.append(tfoot);
      scroll.append(table);
      group.append(scroll);
      groupsHost.append(group);
    }
  }
  shell.append(groupsHost);

  const foot = element('div', 'cash-expand-foot');
  const metrics = [
    ['Bills', String(bills.length || pending.length)],
    ['Total Amount', moneyLabel(totalMinor, dec, cc)],
    ['Shop Paid', moneyLabel(shopPaid, dec, cc), 'shop'],
    ['Credit', moneyLabel(credit, dec, cc), 'credit'],
    ['Commission', moneyLabel(commission, dec, cc), 'comm'],
    ['Payable', moneyLabel(balance, dec, cc), 'pay'],
  ];
  for (const [label, value, tone] of metrics) {
    const cell = element('div', `cash-expand-metric${tone ? ` is-${tone}` : ''}`);
    cell.append(element('span', '', label), element('strong', '', value));
    foot.append(cell);
  }
  shell.append(foot);

  const actions = element('div', 'cash-expand-actions');
  const printBtn = element('button', 'btn ghost small', 'Print');
  printBtn.type = 'button';
  printBtn.disabled = !bills.length;
  printBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openPrintPreview({
      riderId,
      boyName: rider?.fullName || 'Delivery Boy',
      bills,
      businessDate: $('batch-day')?.value || bills[0]?.businessDate || '',
      currency: cc,
      currencyDecimals: dec,
      summary: {
        bills: bills.length || pending.length,
        totalAmountMinor: totalMinor,
        shopPaidMinor: shopPaid,
        creditMinor: credit,
        commissionMinor: commission,
        payableMinor: balance,
      },
    });
  });
  actions.append(printBtn);
  shell.append(actions);

  wrap.append(shell);
  return wrap;
}

function closePrintPreview() {
  printPreview = null;
  const modal = $('cash-print-modal');
  if (modal) modal.hidden = true;
}

function openPrintPreview(payload) {
  if (!payload?.bills?.length) {
    notice('No bills to print for this rider.', 'bad');
    return;
  }
  printPreview = payload;
  printMode = 'THERMAL';
  const modal = $('cash-print-modal');
  if (!modal) return;
  modal.hidden = false;
  $('cash-print-subtitle').textContent =
    `${payload.boyName} · ${payload.businessDate || '—'}`;
  renderPrintPreview();
}

function renderPrintPreview() {
  const host = $('cash-print-preview');
  if (!host || !printPreview) return;
  const thermalBtn = $('cash-print-mode-thermal');
  const a4Btn = $('cash-print-mode-a4');
  if (thermalBtn) thermalBtn.classList.toggle('is-active', printMode === 'THERMAL');
  if (a4Btn) a4Btn.classList.toggle('is-active', printMode === 'A4');

  const bills = [...(printPreview.bills || [])].sort((a, b) =>
    String(a.orderNumber || '').localeCompare(String(b.orderNumber || ''), undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  );
  const groups = new Map();
  for (const bill of bills) {
    const key = bill.businessDate || 'Bills';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bill);
  }
  const dateGroups = [...groups.entries()].sort(([a], [b]) => String(a).localeCompare(String(b)));
  const dec = printPreview.currencyDecimals ?? 3;
  const cc = printPreview.currency || 'BHD';
  const slip = element('div', `cash-print-slip ${printMode === 'THERMAL' ? 'is-thermal' : 'is-a4'}`);
  slip.append(element('div', 'shop', shopDisplayName || 'Shop'));
  const meta = element('div', 'meta');
  meta.append(
    element('div', '', printPreview.boyName || 'Delivery Boy'),
    element('div', '', printPreview.businessDate || '—')
  );
  slip.append(meta, element('div', 'line'));

  if (!dateGroups.length) {
    slip.append(element('p', 'empty', 'No bills to print for this delivery boy.'));
  } else {
    for (const [date, rows] of dateGroups) {
      const amountTotal = rows.reduce((s, r) => s + Number(r.amountMinor || 0), 0);
      const commTotal = rows.reduce(
        (s, r) => s + (Number.isSafeInteger(Number(r.commissionMinor)) ? Number(r.commissionMinor) : 0),
        0
      );
      const head = element('div', 'group-h');
      head.append(
        element('span', '', date),
        element('span', '', `${rows.length} · ${moneyPreview(amountTotal, dec, cc)}`)
      );
      slip.append(head);
      const table = document.createElement('table');
      if (printMode === 'THERMAL') {
        table.innerHTML = `<thead><tr>
          <th>Bill</th><th class="tok">Token</th><th>Customer</th><th class="num">Amount</th>
        </tr></thead>`;
      } else {
        table.innerHTML = `<thead><tr>
          <th>Bill No.</th><th>Token</th><th>Customer</th><th class="num">Amount</th><th class="num">Commission</th>
        </tr></thead>`;
      }
      const tbody = document.createElement('tbody');
      for (const bill of rows) {
        const tr = document.createElement('tr');
        if (printMode === 'THERMAL') {
          tr.innerHTML = `<td></td><td class="tok"></td><td></td><td class="num"></td>`;
          tr.children[0].textContent = bill.orderNumber || '—';
          tr.children[1].textContent = formatPrintToken(bill.tokenNumber);
          tr.children[2].textContent = String(bill.customerName || '').trim() || '—';
          tr.children[3].textContent = moneyPreview(bill.amountMinor, dec, cc);
        } else {
          tr.innerHTML = `<td></td><td></td><td></td><td class="num"></td><td class="num"></td>`;
          tr.children[0].textContent = bill.orderNumber || '—';
          tr.children[1].textContent = formatPrintToken(bill.tokenNumber);
          tr.children[2].textContent = String(bill.customerName || '').trim() || '—';
          tr.children[3].textContent = moneyPreview(bill.amountMinor, dec, cc);
          tr.children[4].textContent = moneyPreview(
            Number.isSafeInteger(Number(bill.commissionMinor)) ? Number(bill.commissionMinor) : 0,
            dec,
            cc
          );
        }
        tbody.append(tr);
      }
      table.append(tbody);
      const tfoot = document.createElement('tfoot');
      if (printMode === 'THERMAL') {
        tfoot.innerHTML = `<tr><td colspan="3"><b>Total</b></td><td class="num"></td></tr>`;
        tfoot.querySelector('.num').textContent = moneyPreview(amountTotal, dec, cc);
      } else {
        tfoot.innerHTML = `<tr><td colspan="3"><b>Total</b></td><td class="num"></td><td class="num"></td></tr>`;
        const nums = tfoot.querySelectorAll('.num');
        nums[0].textContent = moneyPreview(amountTotal, dec, cc);
        nums[1].textContent = moneyPreview(commTotal, dec, cc);
      }
      table.append(tfoot);
      slip.append(table);
    }
  }

  slip.append(element('div', 'line'));
  const summary = element('div', 'summary');
  const s = printPreview.summary || {};
  const summaryRows = [
    ['Bills', String(s.bills || 0)],
    ['Total Amount', moneyPreview(s.totalAmountMinor, dec, cc)],
    ['Shop Paid', moneyPreview(s.shopPaidMinor, dec, cc)],
    ['Credit', moneyPreview(s.creditMinor, dec, cc)],
    ['Commission', moneyPreview(s.commissionMinor, dec, cc)],
    ['Payable', moneyPreview(s.payableMinor, dec, cc)],
  ];
  for (const [label, value] of summaryRows) {
    const cell = document.createElement('div');
    if (printMode === 'THERMAL') {
      cell.append(element('span', '', label), element('span', '', value));
    } else {
      cell.append(element('div', 'label', label), element('div', 'value', value));
    }
    summary.append(cell);
  }
  slip.append(summary);
  host.replaceChildren(slip);
  const confirm = $('cash-print-confirm');
  if (confirm) confirm.disabled = !bills.length;
}

function confirmPrintPreview() {
  if (!printPreview?.bills?.length) return;
  try {
    const html = buildRiderCashPrintHtml({
      mode: printMode,
      shopName: shopDisplayName || 'Shop',
      boyName: printPreview.boyName,
      businessDate: printPreview.businessDate,
      bills: printPreview.bills,
      summary: printPreview.summary,
      currency: printPreview.currency,
      currencyDecimals: printPreview.currencyDecimals,
    });
    openRiderCashPrint(html);
    closePrintPreview();
  } catch (err) {
    notice(err?.message || 'Failed to open print preview.', 'bad');
  }
}

async function loadShopName() {
  try {
    const res = await api('/v1/shop-settings');
    if (res.ok) {
      const name = String(res.json?.shop?.displayName || '').trim();
      if (name) shopDisplayName = name;
    }
  } catch {
    /* keep default */
  }
}
function showRiders() {
  const host = $('rider-list');
  if (host) host.replaceChildren();
  const riders = getRiders();
  if ($('rider-total')) $('rider-total').textContent = `${riders.length} riders`;
  if (host) {
    host.append(btnRider(null, 'All riders', 'Overview · select a rider to settle', snapshot.pending.length, 'ALL', true));
  }
  const q = ($('rider-search')?.value || '').trim().toLocaleLowerCase();
  const matching = riders.filter(r => String(r.fullName).toLocaleLowerCase().includes(q));
  for (const r of matching) {
    const count = pendingFor(r.userId).length;
    const sub = `${r.isActive ? 'Active' : 'Inactive'} · ${count} pending invoice${count === 1 ? '' : 's'}`;
    const initials = (r.fullName || '?').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(w => w[0]).join('').toUpperCase();
    if (host) host.append(btnRider(r.userId, r.fullName, sub, count, initials, r.isActive));
  }
  if (host && !matching.length) host.append(element('p', 'cash-empty', 'No delivery boy matches your search.'));

  const body = $('boy-summary-body');
  if (body) {
    body.replaceChildren();
    if (!matching.length) {
      const empty = document.createElement('tr');
      empty.innerHTML = '<td colspan="7" class="cash-empty-cell">No delivery boys found.</td>';
      body.append(empty);
    } else {
      for (const r of matching) {
        const pending = pendingFor(r.userId);
        const pendingMinor = pending.reduce((sum, o) => sum + Number(o.amountCents || 0), 0);
        const sample = pending[0] || historyFor(r.userId)[0];
        const dec = sample?.currencyDecimals ?? 3;
        const cc = sample?.currencyCode || 'BHD';
        const selected = selectedRiderId === r.userId;
        const expanded = expandedBoyId === r.userId;
        const overview =
          selected && batchSnapshot?.preview?.riderUserId === r.userId
            ? batchSnapshot.preview.overview
            : null;
        const available = selected ? batchAvailable(batchSnapshot?.preview) : null;
        const tr = document.createElement('tr');
        tr.className = 'cash-summary-row';
        if (selected) tr.classList.add('is-selected');
        if (expanded) tr.classList.add('is-expanded');
        tr.innerHTML = `
          <td><button type="button" class="boy-name"></button></td>
          <td class="num"></td>
          <td class="num"></td>
          <td class="num"></td>
          <td class="num"></td>
          <td class="num"></td>
          <td class="chev"><span class="cash-chevron" aria-hidden="true">▾</span></td>`;
        tr.querySelector('.boy-name').textContent = r.fullName || 'Delivery Boy';
        tr.children[1].textContent = overview
          ? moneyLabel(overview.totalDeliveredMinor, dec, cc)
          : pending.length
            ? moneyLabel(pendingMinor, dec, cc)
            : '—';
        tr.children[2].textContent = overview
          ? moneyLabel(overview.directShopPaidMinor, dec, cc)
          : '—';
        tr.children[3].textContent = overview
          ? moneyLabel(overview.customerCreditAllocatedMinor, dec, cc)
          : '—';
        tr.children[4].textContent =
          selected && available && Number.isSafeInteger(available.amount)
            ? moneyLabel(available.amount, dec, cc)
            : '—';
        tr.children[5].textContent = pending.length
          ? moneyLabel(pendingMinor, dec, cc)
          : '—';
        tr.addEventListener('click', (e) => {
          e.preventDefault();
          if (expandedBoyId === r.userId && selectedRiderId === r.userId) {
            expandedBoyId = null;
            showRiders();
            return;
          }
          expandedBoyId = r.userId;
          if (selectedRiderId !== r.userId) selectRider(r.userId);
          else showRiders();
        });
        body.append(tr);
        if (expanded) {
          const detail = document.createElement('tr');
          detail.className = 'cash-detail-row';
          const td = document.createElement('td');
          td.colSpan = 7;
          td.append(renderBillDetails(r.userId));
          detail.append(td);
          body.append(detail);
        }
      }
    }
  }

  const select = $('collect-rider');
  if (select) {
    const previous = select.value;
    select.replaceChildren();
    select.append(new Option('Select delivery boy…', ''));
    for (const r of riders) {
      select.append(
        new Option(
          `${r.fullName || 'Delivery Boy'}${r.isActive === false ? ' (inactive)' : ''}`,
          r.userId
        )
      );
    }
    select.value = selectedRiderId || previous || '';
    if (selectedRiderId) select.value = selectedRiderId;
  }

  if ($('collections-count')) {
    const n = selectedRiderId
      ? (batchSnapshot?.history || []).filter((x) => x.riderUserId === selectedRiderId).length
      : 0;
    $('collections-count').textContent = String(n);
  }
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
  // Keep compatibility node updated but never surface it in the page layout.
  if ($('selected-status')) {
    $('selected-status').textContent = rider
      ? (rider.isActive ? 'Active rider' : 'Inactive rider')
      : '';
  }
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
    await loadShopName();
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
  if (!selectedRiderId) { host.hidden = true; return; }
  const days=riderPendingDays(selectedRiderId);
  host.hidden = days.length === 0;
  for (const [date,count] of days) {
    const b=element('button','cash-day-chip',`${date} · ${count}`);
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
  if (!box) return;
  const text = String(message || '').trim();
  // Keep the form quiet — only surface errors/warnings and success confirms.
  const show = Boolean(text) && (kind === 'bad' || kind === 'caution' || kind === 'good');
  box.hidden = !show;
  box.className = `cash-subnotice${kind ? ` ${kind}` : ''}`;
  box.textContent = show ? text : '';
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
function setBatchText(id, value) {
  const el = $(id);
  if (!el) return;
  const text = String(value);
  if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
    el.value = text;
  } else {
    el.textContent = text;
  }
}
function batchMoney(n, p = batchSnapshot?.preview) {
  if (n == null || !p || !p.currencyCode) return '—';
  return moneyLabel(n, p.currencyDecimals, p.currencyCode);
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
  const remainingEl = $('batch-tender-remaining');
  if (remainingEl) {
    if (!d || !Number.isSafeInteger(net)) remainingEl.value = '—';
    else {
      const rem = net - Number(d.cashMinor || 0) - Number(d.bankMinor || 0);
      remainingEl.value = batchMoney(rem, p);
    }
  }
  const valid=tenderMatchesForm(d,p,net);
  const el=$('batch-tender-status');
  if (el) {
    const err = Boolean(d) && !valid;
    el.hidden = !err;
    el.className = 'cash-tender-info' + (err ? ' is-error' : '');
    el.textContent = err
      ? 'Cash + Bank must equal Balance. Select a bank account when bank amount is used.'
      : '';
  }
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
      const st=$('batch-tender-status');
      if (st) {
        st.hidden=false;
        st.textContent='Enter a valid amount not greater than Balance.';
        st.className='cash-tender-info is-error';
      }
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
  {
    const detail = $('batch-commission-detail');
    if (detail) {
      const show = Boolean(p) && available.amount <= 0 && available.explanation;
      detail.hidden = !show;
      detail.textContent = show ? available.explanation : '';
    }
  }
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
  if ($('collections-count')) $('collections-count').textContent = String(items.length);
  if (!items.length) {
    history.append(element('p','cash-empty',selectedRiderId ? 'No collections for this rider yet.' : 'Select a rider to view collections.'));
  }
  const riderName = getRiders().find((r) => r.userId === selectedRiderId)?.fullName || 'Rider';
  for (const entry of items) {
    const tender=entry.tender||{cashMinor:entry.shopCashMinor,bankMinor:0,bankAccountId:null,version:0,note:''};
    const card = element('article', 'cash-collection-card');
    const head = element('div', 'cash-collection-card-head');
    head.append(
      element('strong', '', `${riderName} · ${entry.businessDate}`),
      element('time', '', `${entry.invoiceCount} bill${entry.invoiceCount === 1 ? '' : 's'}`)
    );
    card.append(head);
    const metrics = element('div', 'cash-collection-metrics');
    const cells = [
      ['Payable', moneyLabel(entry.grossMinor, entry.currencyDecimals, entry.currencyCode),
        Number(entry.commissionMinor) > 0
          ? `Comm. ${moneyLabel(entry.commissionMinor, entry.currencyDecimals, entry.currencyCode)}`
          : ''],
      ['Cash', moneyLabel(tender.cashMinor, entry.currencyDecimals, entry.currencyCode), ''],
      ['Bank', moneyLabel(tender.bankMinor, entry.currencyDecimals, entry.currencyCode),
        tender.note || ''],
      ['Remaining', moneyLabel(0, entry.currencyDecimals, entry.currencyCode), 'Settled'],
    ];
    for (const [label, value, note] of cells) {
      const cell = element('div', 'cash-metric');
      cell.append(element('span', '', label), element('strong', '', value));
      if (note) cell.append(element('small', '', note));
      metrics.append(cell);
    }
    card.append(metrics);
    const breakdown=element('details','cash-history-breakdown');
    breakdown.append(element('summary','',`View ${entry.invoiceCount} invoice details`));
    breakdown.append(element('p','cash-bill-footnote',entry.commissionAllocationNote ||
      'Commission is recorded at settlement level; no invoice split is assumed.'));
    for(const inv of entry.orders || []) {
      const invoice=element('div','cash-bill-line');
      const billHead=element('div','cash-bill-line-head');
      billHead.append(element('strong','',inv.orderNumber),element('strong','',
        money(inv.amountMinor,entry.currencyDecimals,entry.currencyCode)));
      invoice.append(billHead,invoiceDetails(inv,entry.currencyCode,entry.currencyDecimals,true));
      breakdown.append(invoice);
    }
    if (!Array.isArray(entry.orders)) breakdown.append(element('p','cash-bill-footnote','Invoice details unavailable for this older history record.'));
    card.append(breakdown);
    card.append(makeTenderCorrectionEditor(entry,tender));
    history.append(card);
  }
  // Keep summary table in sync when preview loads.
  showRiders();
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
  batchNotice('');
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
    if (commissionBlocked) {
      batchNotice(`Collection paused: ${available.explanation}`, 'bad');
    } else if (oldShiftStillOpen) {
      batchNotice(`POS shift still on ${date}. Open the correct shift before new sales.`, 'caution');
    } else {
      batchNotice('');
    }
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
$('collect-rider')?.addEventListener('change', () => {
  selectRider($('collect-rider').value || null);
});

$('batch-tender-cash').addEventListener('input',()=>handleTenderField('cash'));
$('batch-tender-bank').addEventListener('input',()=>handleTenderField('bank'));
$('batch-tender-bank-account').addEventListener('change',()=>handleTenderField('account'));
$('batch-tender-note').addEventListener('change',()=>handleTenderField('note'));

$('cash-print-close')?.addEventListener('click', () => closePrintPreview());
$('cash-print-cancel')?.addEventListener('click', () => closePrintPreview());
$('cash-print-confirm')?.addEventListener('click', () => confirmPrintPreview());
$('cash-print-mode-thermal')?.addEventListener('click', () => {
  printMode = 'THERMAL';
  renderPrintPreview();
});
$('cash-print-mode-a4')?.addEventListener('click', () => {
  printMode = 'A4';
  renderPrintPreview();
});
$('cash-print-modal')?.addEventListener('click', (e) => {
  if (e.target === $('cash-print-modal')) closePrintPreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && printPreview) closePrintPreview();
});
