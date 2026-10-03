import { formatMoney, formatMoneyLocale } from "../../utils/money.js";
function money(value) {
  return formatMoneyLocale(value);
}

function LineRow({ label, amount, bold = false, tone }) {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-1 py-2 ${
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

export default function CashFlowStatement({ cashflow, emptyMessage }) {
  if (!cashflow?.sections?.length) {
    return (
      <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 px-4 py-10 text-center text-sm text-slate-400 print:border-slate-300 print:bg-white print:text-slate-600">
        {emptyMessage || "No cash flow data for this range."}
      </div>
    );
  }

  const net = Number(cashflow.netLiquidityChange || 0);
  const netTone = net >= 0 ? "text-emerald-500" : "text-rose-500";

  return (
    <div className="space-y-5 rounded-xl border border-slate-800 bg-slate-950/30 p-4 sm:p-5 print:border-slate-300 print:bg-white">
      {cashflow.sections.map((section) => (
        <section key={section.key}>
          <h3 className="border-b border-slate-800 pb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 print:border-slate-200 print:text-slate-600">
            {section.title}
          </h3>
          <div className="mt-1">
            {section.lines.map((line) => (
              <LineRow
                key={`${section.key}-${line.label}`}
                label={line.label}
                amount={line.amount}
              />
            ))}
            <div className="border-t border-slate-800 pt-1 print:border-slate-200">
              <LineRow
                label={section.totalLabel}
                amount={section.total}
                bold
                tone={section.key === "net" ? netTone : undefined}
              />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
