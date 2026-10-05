import { formatMoneyLocale } from "../../utils/money.js";

function moneyDisplay(value) {
  if (value == null || value === "") return "";
  const parsed = Number(String(value).replace(/,/g, ""));
  if (!Number.isFinite(parsed)) return String(value);
  return formatMoneyLocale(parsed);
}

export default function DueBalanceList({
  columns = [],
  rows = [],
  emptyMessage,
}) {
  const dataRows = rows.filter((row) => row.id !== "__grand_total__");
  const totalRow = rows.find((row) => row.id === "__grand_total__");

  if (!dataRows.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-10 text-center text-sm text-slate-400 print:border-slate-300 print:bg-white print:text-slate-600">
        {emptyMessage || "No outstanding balances."}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 print:border-slate-300">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500 print:bg-slate-100 print:text-slate-700">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-3 py-3 font-semibold ${
                  col.align === "right" ? "text-right" : "text-left"
                }`}
                style={{
                  textAlign: col.align === "right" ? "right" : "left",
                }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row) => (
            <tr
              key={row.id}
              className="border-t border-slate-800 text-slate-200 print:border-slate-200 print:text-slate-900"
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-3 py-2.5 align-top ${
                    col.align === "right"
                      ? "text-right tabular-nums whitespace-nowrap"
                      : "text-left"
                  }`}
                  style={{
                    textAlign: col.align === "right" ? "right" : "left",
                  }}
                >
                  {col.key === "balance"
                    ? moneyDisplay(row[col.key])
                    : row[col.key] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totalRow ? (
          <tfoot>
            <tr className="border-t-2 border-slate-600 bg-slate-900/80 font-semibold text-white print:border-slate-400 print:bg-slate-100 print:text-slate-900">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-3 py-3 align-top ${
                    col.align === "right"
                      ? "text-right tabular-nums whitespace-nowrap"
                      : "text-left"
                  }`}
                  style={{
                    textAlign: col.align === "right" ? "right" : "left",
                  }}
                >
                  {col.key === "balance"
                    ? moneyDisplay(totalRow.balance)
                    : col.key === "partyName"
                      ? "Total"
                      : ""}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
