import {
  buildReportColumnTotalRow,
  isReportAmountColumn,
  isReportDataRow,
} from "../../utils/reportColumnTotals.js";

export default function ReportTable({ columns = [], rows = [], emptyMessage }) {
  const dataRows = (rows || []).filter(isReportDataRow);
  const totalRow =
    buildReportColumnTotalRow(columns, dataRows) ||
    (rows || []).find(
      (row) => row?.id === "__grand_total__" || row?._isTotal
    ) ||
    null;

  if (!dataRows.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-10 text-center text-sm text-slate-400 print:border-slate-300 print:bg-white print:text-slate-600">
        {emptyMessage || "No rows for this range."}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 print:border-slate-300">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500 print:bg-slate-100 print:text-slate-700">
            {columns.map((col) => {
              const right = isReportAmountColumn(col);
              return (
                <th
                  key={col.key}
                  className={`px-3 py-3 font-semibold ${
                    right ? "text-right" : "text-left"
                  }`}
                  style={right ? { textAlign: "right" } : { textAlign: "left" }}
                >
                  {col.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {dataRows.map((row, index) => (
            <tr
              key={row.id || index}
              className="border-t border-slate-800 text-slate-200 print:border-slate-200 print:text-slate-900"
            >
              {columns.map((col) => {
                const right = isReportAmountColumn(col);
                return (
                  <td
                    key={col.key}
                    className={`px-3 py-2.5 align-top ${
                      right
                        ? "text-right tabular-nums whitespace-nowrap"
                        : "text-left"
                    }`}
                    style={
                      right ? { textAlign: "right" } : { textAlign: "left" }
                    }
                  >
                    {row[col.key] ?? ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        {totalRow ? (
          <tfoot>
            <tr className="border-t-2 border-slate-600 bg-slate-900/80 font-semibold text-white print:border-slate-400 print:bg-slate-100 print:text-slate-900">
              {columns.map((col) => {
                const right = isReportAmountColumn(col);
                return (
                  <td
                    key={col.key}
                    className={`px-3 py-3 align-top ${
                      right
                        ? "text-right tabular-nums whitespace-nowrap"
                        : "text-left"
                    }`}
                    style={
                      right ? { textAlign: "right" } : { textAlign: "left" }
                    }
                  >
                    {totalRow[col.key] ?? ""}
                  </td>
                );
              })}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
