/** Rider Cash collection print — same Thermal / A4 flow as External Bill Collect. */

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatMajor(minor, decimals = 3) {
  const digits =
    Number.isInteger(Number(decimals)) && Number(decimals) >= 0 && Number(decimals) <= 3
      ? Number(decimals)
      : 3;
  const n = Number(minor);
  if (!Number.isFinite(n)) return (0).toFixed(digits);
  return (n / 10 ** digits).toFixed(digits);
}

function moneyText(minor, decimals, currency) {
  const cc = String(currency || 'BHD').trim();
  return `${cc} ${formatMajor(minor, decimals)}`;
}

function tokenLabel(token) {
  if (token == null || token === '') return '—';
  const n = Number(token);
  if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) {
    return String(n).padStart(3, '0');
  }
  return String(token);
}

function customerLabel(bill) {
  return String(bill?.customerName || '').trim() || '—';
}

function compareBillAsc(a, b) {
  return String(a?.orderNumber || '').localeCompare(String(b?.orderNumber || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function groupBillsByDate(bills = []) {
  const groups = new Map();
  for (const bill of bills) {
    const key = bill.businessDate || 'Bills';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bill);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([date, rows]) => {
      const sorted = [...rows].sort(compareBillAsc);
      const amountTotal = sorted.reduce((s, r) => s + Number(r.amountMinor || 0), 0);
      const commissionTotal = sorted.reduce(
        (s, r) => s + (Number.isSafeInteger(Number(r.commissionMinor)) ? Number(r.commissionMinor) : 0),
        0
      );
      return { date, bills: sorted, amountTotal, commissionTotal };
    });
}

function summaryBlockHtml({ summary, currency, decimals, compact }) {
  const money = (minor) => moneyText(minor, decimals, currency);
  const item = (label, value) =>
    compact
      ? `<div class="row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`
      : `<div><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
  const body = [
    item('Bills', String(summary.bills || 0)),
    item('Total Amount', money(summary.totalAmountMinor)),
    item('Shop Paid', money(summary.shopPaidMinor)),
    item('Credit', money(summary.creditMinor)),
    item('Commission', money(summary.commissionMinor)),
    item('Payable', money(summary.payableMinor)),
  ].join('');
  return compact ? `<div class="foot">${body}</div>` : `<div class="summary">${body}</div>`;
}

function buildThermalHtml({ shopName, boyName, businessDate, dateGroups, summary, currency, decimals }) {
  const sections = dateGroups
    .map((group) => {
      const rows = group.bills
        .map(
          (bill) => `
            <tr>
              <td class="bill">${escapeHtml(bill.orderNumber || '—')}</td>
              <td class="tok">${escapeHtml(tokenLabel(bill.tokenNumber))}</td>
              <td class="loc">${escapeHtml(customerLabel(bill))}</td>
              <td class="num">${escapeHtml(moneyText(bill.amountMinor, decimals, currency))}</td>
            </tr>`
        )
        .join('');
      return `
      <div class="term">
        <div class="term-h">
          <b>${escapeHtml(group.date)}</b>
          <span>${group.bills.length} · ${escapeHtml(moneyText(group.amountTotal, decimals, currency))}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th class="bill">Bill</th>
              <th class="tok">Token</th>
              <th class="loc">Customer</th>
              <th class="num">Amount</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="3"><b>Total</b></td>
              <td class="num"><b>${escapeHtml(moneyText(group.amountTotal, decimals, currency))}</b></td>
            </tr>
          </tfoot>
        </table>
      </div>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Rider Cash · ${escapeHtml(boyName)}</title>
  <style>
    @page { size: 80mm auto; margin: 3mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; color: #111; }
    .wrap { width: 74mm; }
    .shop { font-size: 13px; font-weight: 800; text-align: center; }
    .meta { font-size: 10px; text-align: center; margin-top: 4px; }
    .line { border-top: 1px dashed #000; margin: 6px 0; }
    .term { margin-top: 8px; }
    .term-h { display: flex; justify-content: space-between; gap: 6px; font-size: 10px;
      border-bottom: 1px solid #000; padding-bottom: 3px; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 10px; }
    th, td { padding: 2px 0; vertical-align: top; }
    th { text-align: left; font-size: 9px; }
    tfoot td { border-top: 1px dashed #000; padding-top: 3px; }
    .num { text-align: right; white-space: nowrap; }
    .bill { width: 28%; white-space: nowrap; }
    .tok { width: 14%; text-align: center; }
    .loc { width: 34%; }
    .foot { margin-top: 8px; font-size: 10px; font-weight: 700; }
    .foot .row { display: flex; justify-content: space-between; gap: 8px; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="shop">${escapeHtml(shopName || 'Shop')}</div>
    <div class="meta">
      <div><b>${escapeHtml(boyName || 'Delivery Boy')}</b></div>
      <div>${escapeHtml(businessDate || '—')}</div>
    </div>
    <div class="line"></div>
    ${sections}
    <div class="line"></div>
    ${summaryBlockHtml({ summary, currency, decimals, compact: true })}
  </div>
  <script>
    window.onload = function () { window.focus(); window.print(); };
  </script>
</body>
</html>`;
}

function buildA4Html({ shopName, boyName, businessDate, dateGroups, summary, currency, decimals }) {
  const sections = dateGroups
    .map((group) => {
      const rows = group.bills
        .map(
          (bill) => `
            <tr>
              <td>${escapeHtml(bill.orderNumber || '—')}</td>
              <td>${escapeHtml(tokenLabel(bill.tokenNumber))}</td>
              <td>${escapeHtml(customerLabel(bill))}</td>
              <td class="num">${escapeHtml(moneyText(bill.amountMinor, decimals, currency))}</td>
              <td class="num">${escapeHtml(
                moneyText(
                  Number.isSafeInteger(Number(bill.commissionMinor)) ? Number(bill.commissionMinor) : 0,
                  decimals,
                  currency
                )
              )}</td>
            </tr>`
        )
        .join('');
      return `
      <section class="card">
        <div class="card-h">
          <b>${escapeHtml(group.date)}</b>
          <span>${group.bills.length} bill${group.bills.length === 1 ? '' : 's'} · ${escapeHtml(
            moneyText(group.amountTotal, decimals, currency)
          )}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Bill No.</th>
              <th>Token</th>
              <th>Customer</th>
              <th class="num">Amount</th>
              <th class="num">Commission</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
          <tfoot>
            <tr>
              <td colspan="3"><b>Total</b></td>
              <td class="num"><b>${escapeHtml(moneyText(group.amountTotal, decimals, currency))}</b></td>
              <td class="num"><b>${escapeHtml(moneyText(group.commissionTotal, decimals, currency))}</b></td>
            </tr>
          </tfoot>
        </table>
      </section>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Rider Cash · ${escapeHtml(boyName)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    body { margin: 0; font-family: Arial, sans-serif; color: #111; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .muted { color: #555; font-size: 12px; margin-bottom: 14px; }
    .card { border: 1px solid #ccc; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
    .card-h { display: flex; justify-content: space-between; gap: 10px; padding: 8px 10px; background: #ececec; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td { border-top: 1px solid #e5e5e5; padding: 6px 10px; text-align: left; vertical-align: top; }
    th { background: #fafafa; font-size: 11px; text-transform: uppercase; color: #555; }
    .num { text-align: right; white-space: nowrap; }
    .summary { border: 1px solid #111; border-radius: 8px; padding: 10px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .summary .label { font-size: 10px; text-transform: uppercase; color: #666; }
    .summary .value { font-size: 13px; font-weight: 700; }
  </style>
</head>
<body>
  <h1>${escapeHtml(shopName || 'Shop')}</h1>
  <div class="muted">Rider Cash Collection · ${escapeHtml(boyName || 'Delivery Boy')} · ${escapeHtml(
    businessDate || '—'
  )}</div>
  ${sections}
  ${summaryBlockHtml({ summary, currency, decimals, compact: false })}
  <script>
    window.onload = function () { window.focus(); window.print(); };
  </script>
</body>
</html>`;
}

export function buildRiderCashPrintHtml({
  mode = 'THERMAL',
  shopName,
  boyName,
  businessDate,
  bills = [],
  summary = {},
  currency = 'BHD',
  currencyDecimals = 3,
}) {
  const dateGroups = groupBillsByDate(bills);
  const payload = {
    shopName,
    boyName,
    businessDate,
    dateGroups,
    summary,
    currency,
    decimals: currencyDecimals,
  };
  return mode === 'THERMAL' ? buildThermalHtml(payload) : buildA4Html(payload);
}

function printViaHiddenIframe(html) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute(
    'style',
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  );
  iframe.srcdoc = html;
  document.body.appendChild(iframe);
  const runPrint = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      /* ignore */
    }
    window.setTimeout(() => {
      try {
        iframe.remove();
      } catch {
        /* ignore */
      }
    }, 120_000);
  };
  iframe.onload = () => window.setTimeout(runPrint, 50);
  window.setTimeout(runPrint, 800);
  return iframe;
}

export function openRiderCashPrint(html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const popup = window.open(url, '_blank', 'width=720,height=900,scrollbars=yes');
  if (!popup) {
    URL.revokeObjectURL(url);
    return printViaHiddenIframe(html);
  }
  window.setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }, 60_000);
  window.setTimeout(() => {
    try {
      if (!popup.closed) {
        popup.focus();
        popup.print();
      }
    } catch {
      /* HTML onload print backup */
    }
  }, 600);
  return popup;
}

export function moneyPreview(minor, decimals, currency) {
  return moneyText(minor, decimals, currency);
}

export function formatPrintToken(token) {
  return tokenLabel(token);
}
