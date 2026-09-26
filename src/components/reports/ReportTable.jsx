const AMOUNT_KEYS = new Set([
  "in",
  "out",
  "balance",
  "debit",
  "credit",
  "amount",
]);

function isAmountColumn(col) {
  if (col?.align === "right") return true;
  return AMOUNT_KEYS.has(String(col?.key || "").toLowerCase());
}

export default function ReportTable({ columns = [], rows = [], emptyMessage }) {
  if (!rows.length) {
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
              const right = isAmountColumn(col);
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
          {rows.map((row, index) => (
            <tr
              key={row.id || index}
              className="border-t border-slate-800 text-slate-200 print:border-slate-200 print:text-slate-900"
            >
              {columns.map((col) => {
                const right = isAmountColumn(col);
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
      </table>
    </div>
  );
}
