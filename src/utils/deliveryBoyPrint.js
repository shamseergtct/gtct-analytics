import { formatIsoDate } from "./dateFormat.js";
import { formatMoney, numMoney, roundMoney } from "./money.js";
import { openHtmlPrintWindow } from "./openPrintWindow.js";
import {
  compareBillingTerminals,
  isDeliveryBoyAccountPayment,
  normalizeExternalSaleType,
  parseBillSequence,
} from "./externalSales.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function compareBillNumberAsc(a, b) {
  const seqA = parseBillSequence(a?.billNumber);
  const seqB = parseBillSequence(b?.billNumber);
  if (seqA != null && seqB != null && seqA !== seqB) return seqA - seqB;
  if (seqA != null && seqB == null) return -1;
  if (seqA == null && seqB != null) return 1;
  return String(a?.billNumber || "").localeCompare(
    String(b?.billNumber || ""),
    undefined,
    { numeric: true, sensitivity: "base" }
  );
}

function paymentAccountMeta(bill) {
  if (isDeliveryBoyAccountPayment(bill)) {
    return {
      key: "DELIVERY_ACCOUNT",
      label: "Delivery Boy Account",
      sort: 0,
    };
  }
  const mode = String(bill?.paymentMode || "")
    .trim()
    .toUpperCase();
  if (mode === "CREDIT") {
    return { key: "CREDIT", label: "Credit", sort: 90 };
  }
  if (mode === "BANK") {
    const accountId = String(bill?.bankAccountId || "").trim() || "_bank";
    const accountName =
      String(bill?.bankAccountNameSnapshot || "").trim() || "Bank";
    return {
      key: `BANK:${accountId}`,
      label: `Bank: ${accountName}`,
      sort: 50,
    };
  }
  return { key: "CASH", label: "Cash", sort: 20 };
}

export function listDeliveryBoyPrintBills(bills = [], deliveryBoyId) {
  const boyId = String(deliveryBoyId || "").trim();
  return (bills || [])
    .filter((bill) => {
      if (!boyId || bill?.voided === true) return false;
      if (normalizeExternalSaleType(bill.saleType) !== "DELIVERY") return false;
      return bill.deliveryBoyId === boyId;
    })
    .sort(compareBillNumberAsc);
}

export function groupDeliveryBoyPrintBillsByPayment(bills = []) {
  const groups = new Map();
  for (const bill of bills) {
    const meta = paymentAccountMeta(bill);
    if (!groups.has(meta.key)) {
      groups.set(meta.key, {
        ...meta,
        bills: [],
        amountTotal: 0,
        commissionTotal: 0,
      });
    }
    const group = groups.get(meta.key);
    group.bills.push(bill);
    group.amountTotal += numMoney(bill.billAmount);
    group.commissionTotal += numMoney(bill.commissionAmount);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      bills: [...group.bills].sort(compareBillNumberAsc),
      amountTotal: roundMoney(group.amountTotal),
      commissionTotal: roundMoney(group.commissionTotal),
    }))
    .sort(
      (a, b) =>
        a.sort - b.sort || String(a.label).localeCompare(String(b.label))
    );
}

export function groupDeliveryBoyPrintBillsByTerminal(bills = []) {
  const groups = new Map();
  for (const bill of bills) {
    const terminalId = bill.terminalId || "_unknown";
    if (!groups.has(terminalId)) {
      groups.set(terminalId, {
        terminalId: bill.terminalId || "",
        terminalName: bill.terminalNameSnapshot || "Unknown terminal",
        sortOrder: bill.terminalSortOrder,
        bills: [],
      });
    }
    groups.get(terminalId).bills.push(bill);
  }

  return [...groups.values()]
    .map((group) => {
      const billsSorted = [...group.bills].sort(compareBillNumberAsc);
      const paymentGroups = groupDeliveryBoyPrintBillsByPayment(billsSorted);
      return {
        ...group,
        bills: billsSorted,
        paymentGroups,
        amountTotal: roundMoney(
          paymentGroups.reduce((sum, row) => sum + numMoney(row.amountTotal), 0)
        ),
        commissionTotal: roundMoney(
          paymentGroups.reduce(
            (sum, row) => sum + numMoney(row.commissionTotal),
            0
          )
        ),
      };
    })
    .sort((a, b) =>
      compareBillingTerminals(
        { name: a.terminalName, sortOrder: a.sortOrder },
        { name: b.terminalName, sortOrder: b.sortOrder }
      )
    );
}

function billLocation(bill) {
  return (
    String(bill?.customerLocation || "").trim() ||
    String(bill?.customerName || "").trim() ||
    "—"
  );
}

function summaryBlockHtml({ summary, currencyPrefix, currencyDecimals, compact }) {
  const item = (label, value) =>
    compact
      ? `<div class="row"><span>${escapeHtml(label)}</span><span>${escapeHtml(
          value
        )}</span></div>`
      : `<div><div class="label">${escapeHtml(
          label
        )}</div><div class="value">${escapeHtml(value)}</div></div>`;

  const money = (amount) =>
    `${currencyPrefix}${formatMoney(amount, currencyDecimals)}`;

  const body = [
    item("Bills", String(summary.bills || 0)),
    item("Total Amount", money(summary.totalAmount)),
    item("Shop Paid", money(summary.shopPaidAmount)),
    item("Credit", money(summary.creditAmount)),
    item("Commission", money(summary.commission)),
    item("Payable", money(summary.payableAmount)),
  ].join("");

  return compact
    ? `<div class="foot">${body}</div>`
    : `<div class="summary">${body}</div>`;
}

function buildThermalHtml({
  shopName,
  boyName,
  businessDate,
  terminalGroups,
  summary,
  currencyPrefix,
  currencyDecimals,
}) {
  const dateLabel = formatIsoDate(businessDate) || businessDate || "—";
  const sections = terminalGroups
    .map((terminal) => {
      const paymentBlocks = terminal.paymentGroups
        .map((payment) => {
          const rows = payment.bills
            .map(
              (bill) => `
            <tr>
              <td class="bill">${escapeHtml(bill.billNumber)}</td>
              <td class="loc">${escapeHtml(billLocation(bill))}</td>
              <td class="num">${escapeHtml(currencyPrefix)}${escapeHtml(
                formatMoney(bill.billAmount, currencyDecimals)
              )}</td>
            </tr>`
            )
            .join("");
          return `
          <div class="acct">
            <div class="acct-h">
              <b>${escapeHtml(payment.label)}</b>
              <span>${payment.bills.length} · ${escapeHtml(
                currencyPrefix
              )}${escapeHtml(
                formatMoney(payment.amountTotal, currencyDecimals)
              )}</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th class="bill">Bill</th>
                  <th class="loc">Location</th>
                  <th class="num">Amount</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr>
                  <td colspan="2"><b>Total</b></td>
                  <td class="num"><b>${escapeHtml(currencyPrefix)}${escapeHtml(
                    formatMoney(payment.amountTotal, currencyDecimals)
                  )}</b></td>
                </tr>
              </tfoot>
            </table>
          </div>`;
        })
        .join("");

      return `
      <div class="term">
        <div class="term-h">
          <b>${escapeHtml(terminal.terminalName)}</b>
          <span>${terminal.bills.length} · ${escapeHtml(
            currencyPrefix
          )}${escapeHtml(
            formatMoney(terminal.amountTotal, currencyDecimals)
          )}</span>
        </div>
        ${paymentBlocks}
      </div>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Delivery Collection · ${escapeHtml(boyName)}</title>
  <style>
    @page { size: 80mm auto; margin: 3mm; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; color: #111; }
    .wrap { width: 74mm; }
    .shop { font-size: 13px; font-weight: 800; text-align: center; }
    .meta { font-size: 10px; text-align: center; margin-top: 4px; }
    .line { border-top: 1px dashed #000; margin: 6px 0; }
    .term { margin-top: 8px; }
    .term-h, .acct-h { display: flex; justify-content: space-between; gap: 6px; font-size: 10px; }
    .term-h { border-bottom: 1px solid #000; padding-bottom: 3px; margin-bottom: 4px; }
    .acct { margin: 6px 0; }
    .acct-h { border-bottom: 1px dashed #000; padding-bottom: 2px; margin-bottom: 2px; }
    table { width: 100%; border-collapse: collapse; font-size: 10px; }
    th, td { padding: 2px 0; vertical-align: top; }
    th { text-align: left; font-size: 9px; }
    tfoot td { border-top: 1px dashed #000; padding-top: 3px; }
    .num { text-align: right; white-space: nowrap; }
    .bill { width: 18%; white-space: nowrap; }
    .loc { width: 52%; }
    .foot { margin-top: 8px; font-size: 10px; font-weight: 700; }
    .foot .row { display: flex; justify-content: space-between; gap: 8px; margin-top: 2px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="shop">${escapeHtml(shopName || "Shop")}</div>
    <div class="meta">
      <div><b>${escapeHtml(boyName || "Delivery Boy")}</b></div>
      <div>${escapeHtml(dateLabel)}</div>
    </div>
    <div class="line"></div>
    ${sections}
    <div class="line"></div>
    ${summaryBlockHtml({
      summary,
      currencyPrefix,
      currencyDecimals,
      compact: true,
    })}
  </div>
  <script>
    window.onload = function () {
      window.focus();
      window.print();
    };
  </script>
</body>
</html>`;
}

function buildFullHtml({
  shopName,
  boyName,
  businessDate,
  terminalGroups,
  summary,
  currencyPrefix,
  currencyDecimals,
}) {
  const dateLabel = formatIsoDate(businessDate) || businessDate || "—";
  const sections = terminalGroups
    .map((terminal) => {
      const paymentBlocks = terminal.paymentGroups
        .map((payment) => {
          const rows = payment.bills
            .map(
              (bill) => `
            <tr>
              <td>${escapeHtml(bill.billNumber)}</td>
              <td>${escapeHtml(billLocation(bill))}</td>
              <td class="num">${escapeHtml(currencyPrefix)}${escapeHtml(
                formatMoney(bill.billAmount, currencyDecimals)
              )}</td>
              <td class="num">${escapeHtml(currencyPrefix)}${escapeHtml(
                formatMoney(bill.commissionAmount, currencyDecimals)
              )}</td>
            </tr>`
            )
            .join("");
          return `
          <section class="card nested">
            <div class="card-h">
              <b>${escapeHtml(payment.label)}</b>
              <span>${payment.bills.length} bill${
                payment.bills.length === 1 ? "" : "s"
              } · ${escapeHtml(currencyPrefix)}${escapeHtml(
                formatMoney(payment.amountTotal, currencyDecimals)
              )}</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Bill No.</th>
                  <th>Location</th>
                  <th class="num">Amount</th>
                  <th class="num">Commission</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
              <tfoot>
                <tr>
                  <td colspan="2"><b>Total</b></td>
                  <td class="num"><b>${escapeHtml(currencyPrefix)}${escapeHtml(
                    formatMoney(payment.amountTotal, currencyDecimals)
                  )}</b></td>
                  <td class="num"><b>${escapeHtml(currencyPrefix)}${escapeHtml(
                    formatMoney(payment.commissionTotal, currencyDecimals)
                  )}</b></td>
                </tr>
              </tfoot>
            </table>
          </section>`;
        })
        .join("");

      return `
      <section class="card">
        <div class="card-h terminal">
          <b>${escapeHtml(terminal.terminalName)}</b>
          <span>${terminal.bills.length} bill${
            terminal.bills.length === 1 ? "" : "s"
          } · ${escapeHtml(currencyPrefix)}${escapeHtml(
            formatMoney(terminal.amountTotal, currencyDecimals)
          )}</span>
        </div>
        <div class="card-body">${paymentBlocks}</div>
      </section>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Delivery Collection · ${escapeHtml(boyName)}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    body { margin: 0; font-family: Arial, sans-serif; color: #111; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .muted { color: #555; font-size: 12px; margin-bottom: 14px; }
    .card { border: 1px solid #ccc; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
    .card.nested { margin: 10px; }
    .card-h { display: flex; justify-content: space-between; gap: 10px; padding: 8px 10px; background: #f5f5f5; font-size: 12px; }
    .card-h.terminal { background: #ececec; font-size: 13px; }
    .card-body { padding-bottom: 4px; }
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
  <h1>${escapeHtml(shopName || "Shop")}</h1>
  <div class="muted">Delivery Collection · ${escapeHtml(
    boyName || "Delivery Boy"
  )} · ${escapeHtml(dateLabel)}</div>
  ${sections}
  ${summaryBlockHtml({
    summary,
    currencyPrefix,
    currencyDecimals,
    compact: false,
  })}
  <script>
    window.onload = function () {
      window.focus();
      window.print();
    };
  </script>
</body>
</html>`;
}

export function buildDeliveryBoyCollectionPrintHtml({
  mode = "THERMAL",
  shopName,
  boyName,
  businessDate,
  bills = [],
  summary = {},
  currency = "",
  currencyDecimals,
}) {
  const currencyPrefix = currency ? `${currency} ` : "";
  const sortedBills = [...bills].sort(compareBillNumberAsc);
  const terminalGroups = groupDeliveryBoyPrintBillsByTerminal(sortedBills);
  const payload = {
    shopName,
    boyName,
    businessDate,
    terminalGroups,
    summary,
    currencyPrefix,
    currencyDecimals,
  };
  return mode === "THERMAL"
    ? buildThermalHtml(payload)
    : buildFullHtml(payload);
}

export function openDeliveryBoyCollectionPrint(html) {
  return openHtmlPrintWindow(html, { width: 720, height: 900, autoPrint: true });
}
