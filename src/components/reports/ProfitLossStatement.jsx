import { formatMoney, formatMoneyLocale } from "../../utils/money.js";
function money(value) {
  return formatMoneyLocale(value);
}

function LineRow({ label, amount, bold = false, tone }) {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-1 py-2.5 ${
        bold ? "font-semibold" : ""
      }`}
    >
      <span
        className={`text-sm ${
          bold
            ? "text-slate-100 print:text-slate-900"
            : "text-slate-300 print:text-slate-700"
        }`}
      >
        {label}
      </span>
      <span
        className={`tabular-nums text-sm ${
          tone ||
          (bold
            ? "text-white print:text-slate-900"
            : "text-slate-100 print:text-slate-900")
        }`}
      >
        {money(amount)}
      </span>
    </div>
  );
}

export default function ProfitLossStatement({ pnl, emptyMessage }) {
  if (!pnl) {
    return (
      <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-10 text-center text-sm text-slate-400 print:border-slate-300 print:bg-white print:text-slate-600">
        {emptyMessage || "No P&L data for this range."}
      </div>
    );
  }

  const {
    totalRevenue = 0,
    totalExpenses = 0,
    netProfit = 0,
    expenseCategories = [],
  } = pnl;

  const profitTone =
    Number(netProfit) >= 0
      ? "text-emerald-500"
      : "text-rose-500";

  return (
    <div className="space-y-5 rounded-xl border border-slate-800 bg-slate-950/30 p-4 sm:p-5 print:border-slate-300 print:bg-white">
      <section>
        <h3 className="border-b border-slate-800 pb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 print:border-slate-200 print:text-slate-600">
          Revenue
        </h3>
        <div className="mt-1">
          <LineRow label="Sales Revenue" amount={totalRevenue} />
          <div className="border-t border-slate-800 pt-1 print:border-slate-200">
            <LineRow label="Total Revenue" amount={totalRevenue} bold />
          </div>
        </div>
      </section>

      <section>
        <h3 className="border-b border-slate-800 pb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 print:border-slate-200 print:text-slate-600">
          Operating Expenses
        </h3>
        <div className="mt-1">
          {expenseCategories.length ? (
            expenseCategories.map((row) => (
              <LineRow
                key={row.category}
                label={row.label}
                amount={row.amount}
              />
            ))
          ) : (
            <p className="py-3 text-sm text-slate-500">
              No operating expenses in this range.
            </p>
          )}
          <div className="border-t border-slate-800 pt-1 print:border-slate-200">
            <LineRow label="Total Expenses" amount={totalExpenses} bold />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-3 print:border-slate-300 print:bg-slate-50">
        <div className="flex items-center justify-between gap-4">
          <span className="text-base font-bold text-white print:text-slate-900">
            Net Profit
          </span>
          <span className={`text-xl font-bold tabular-nums ${profitTone}`}>
            {money(netProfit)}
          </span>
        </div>
      </section>
    </div>
  );
}
