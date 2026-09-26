import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  AreaChart,
  Area,
  ComposedChart,
} from "recharts";
import { RefreshCw, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { fetchAdvancedAnalytics } from "../../utils/advancedAnalyticsApi.js";
import { formatReportRangeLabel } from "../../utils/reportDateRange.js";

const DONUT_COLORS = [
  "#3b82f6",
  "#14b8a6",
  "#f59e0b",
  "#f43f5e",
  "#8b5cf6",
  "#06b6d4",
  "#84cc16",
  "#fb7185",
  "#64748b",
];

function money(value) {
  const parsed = Number(value);
  return (Number.isFinite(parsed) ? parsed : 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function pct(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  const sign = parsed > 0 ? "+" : "";
  return `${sign}${parsed.toFixed(1)}%`;
}

function varianceTone(metricKey, variancePct) {
  if (variancePct == null || !Number.isFinite(variancePct)) {
    return "text-slate-400";
  }
  // Expenses: decrease is good (green), increase is bad (red).
  if (metricKey === "expenses") {
    if (variancePct < 0) return "text-emerald-400";
    if (variancePct > 0) return "text-rose-400";
    return "text-slate-400";
  }
  // Revenue & net profit: increase is good.
  if (variancePct > 0) return "text-emerald-400";
  if (variancePct < 0) return "text-rose-400";
  return "text-slate-400";
}

function VarianceIcon({ metricKey, variancePct }) {
  if (variancePct == null || !Number.isFinite(variancePct) || variancePct === 0) {
    return <Minus size={14} className="text-slate-500" />;
  }
  const positive =
    metricKey === "expenses" ? variancePct < 0 : variancePct > 0;
  return positive ? (
    <TrendingUp size={14} className="text-emerald-400" />
  ) : (
    <TrendingDown size={14} className="text-rose-400" />
  );
}

function AnalyticsKpiCard({ label, metricKey, kpi, compareYoY }) {
  const tone = varianceTone(metricKey, kpi?.variancePct);
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold tabular-nums text-white">
        {money(kpi?.current)}
      </p>
      {compareYoY ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-500">
            Prior year {money(kpi?.previous)}
          </span>
          <span className={`inline-flex items-center gap-1 font-semibold ${tone}`}>
            <VarianceIcon metricKey={metricKey} variancePct={kpi?.variancePct} />
            {pct(kpi?.variancePct)}
          </span>
        </div>
      ) : (
        <p className="mt-3 text-xs text-slate-500">Current period</p>
      )}
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs shadow-xl">
      <p className="mb-1 font-semibold text-slate-200">{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} className="tabular-nums text-slate-300">
          <span style={{ color: entry.color }}>●</span> {entry.name}:{" "}
          {money(entry.value)}
        </p>
      ))}
    </div>
  );
}

export default function AdvancedAnalytics({
  clientId,
  fromDate,
  toDate,
  rangeLabel,
  compareYoY = false,
  onCompareYoYChange,
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!clientId || !fromDate || !toDate) {
      setData(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchAdvancedAnalytics({
      clientId,
      fromDate,
      toDate,
      compareYoY,
    })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason?.message || "Failed to load analytics.");
          setData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, fromDate, toDate, compareYoY]);

  const donutData = useMemo(() => {
    const cats = data?.current?.expenseCategories || [];
    if (!cats.length) return [];
    const top = cats.slice(0, 7);
    const restAmount = cats.slice(7).reduce((sum, row) => sum + row.amount, 0);
    const rows = top.map((row) => ({
      name: row.label,
      value: row.amount,
      percent: row.percent,
    }));
    if (restAmount > 0) {
      const total = data.current.totalExpenses || 1;
      rows.push({
        name: "Other",
        value: restAmount,
        percent: (restAmount / total) * 100,
      });
    }
    return rows;
  }, [data]);

  const topCategories = (data?.current?.expenseCategories || []).slice(0, 5);
  const priorRangeLabel = data?.priorRange
    ? formatReportRangeLabel(data.priorRange.fromDate, data.priorRange.toDate)
    : "";

  if (!clientId) {
    return (
      <div className="rounded-xl border border-dashed border-slate-700 px-4 py-10 text-center text-sm text-slate-400">
        Select a shop to view advanced analytics.
      </div>
    );
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">
            Advanced Analytics
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            {[
              rangeLabel,
              compareYoY && priorRangeLabel ? `vs ${priorRangeLabel}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        {typeof onCompareYoYChange === "function" ? null : (
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-sm text-slate-200 hover:border-slate-600">
            <input
              type="checkbox"
              checked={compareYoY}
              onChange={(event) => onCompareYoYChange?.(event.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-blue-600 focus:ring-blue-500/40"
            />
            <span className="font-medium">Compare with Previous Year</span>
          </label>
        )}
      </div>

      {error ? (
        <div className="rounded-xl border border-rose-900/60 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      {loading && !data ? (
        <div className="flex items-center gap-2 text-slate-400">
          <RefreshCw size={16} className="animate-spin" />
          Loading analytics…
        </div>
      ) : null}

      {data ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <AnalyticsKpiCard
              label="Total Revenue"
              metricKey="revenue"
              kpi={data.kpis.revenue}
              compareYoY={compareYoY}
            />
            <AnalyticsKpiCard
              label="Total Expenses"
              metricKey="expenses"
              kpi={data.kpis.expenses}
              compareYoY={compareYoY}
            />
            <AnalyticsKpiCard
              label="Net Profit"
              metricKey="netProfit"
              kpi={data.kpis.netProfit}
              compareYoY={compareYoY}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 xl:col-span-3">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-white">
                  Income vs Expense Variance
                </h3>
                <span className="text-xs text-slate-500">
                  {data.current.granularity === "month" ? "Monthly" : "Daily"}
                </span>
              </div>
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  {compareYoY ? (
                    <BarChart
                      data={data.comparisonSeries}
                      margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis
                        dataKey="label"
                        tick={{ fill: "#94a3b8", fontSize: 11 }}
                        axisLine={{ stroke: "#334155" }}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fill: "#94a3b8", fontSize: 11 }}
                        axisLine={{ stroke: "#334155" }}
                        tickLine={false}
                        tickFormatter={(v) =>
                          Math.abs(v) >= 1000
                            ? `${(v / 1000).toFixed(0)}k`
                            : String(v)
                        }
                      />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }} />
                      <Bar
                        dataKey="priorRevenue"
                        name="Prior Revenue"
                        fill="#64748b"
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar
                        dataKey="revenue"
                        name="Revenue"
                        fill="#3b82f6"
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar
                        dataKey="priorExpenses"
                        name="Prior Expenses"
                        fill="#fb7185"
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar
                        dataKey="expenses"
                        name="Expenses"
                        fill="#f43f5e"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  ) : (
                    <ComposedChart
                      data={data.comparisonSeries}
                      margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="netFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis
                        dataKey="label"
                        tick={{ fill: "#94a3b8", fontSize: 11 }}
                        axisLine={{ stroke: "#334155" }}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fill: "#94a3b8", fontSize: 11 }}
                        axisLine={{ stroke: "#334155" }}
                        tickLine={false}
                        tickFormatter={(v) =>
                          Math.abs(v) >= 1000
                            ? `${(v / 1000).toFixed(0)}k`
                            : String(v)
                        }
                      />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }} />
                      <Area
                        type="monotone"
                        dataKey="net"
                        name="Net Profit"
                        stroke="#34d399"
                        fill="url(#netFill)"
                        strokeWidth={2}
                      />
                      <Bar
                        dataKey="revenue"
                        name="Revenue"
                        fill="#3b82f6"
                        radius={[4, 4, 0, 0]}
                      />
                      <Bar
                        dataKey="expenses"
                        name="Expenses"
                        fill="#f43f5e"
                        radius={[4, 4, 0, 0]}
                      />
                    </ComposedChart>
                  )}
                </ResponsiveContainer>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Net = Revenue − Expenses. Green area highlights profit/deficit
                gap across the range.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 xl:col-span-2">
              <h3 className="mb-3 text-sm font-semibold text-white">
                Expense Breakdown
              </h3>
              {donutData.length ? (
                <>
                  <div className="h-52 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={donutData}
                          dataKey="value"
                          nameKey="name"
                          innerRadius={48}
                          outerRadius={78}
                          paddingAngle={2}
                        >
                          {donutData.map((entry, index) => (
                            <Cell
                              key={entry.name}
                              fill={DONUT_COLORS[index % DONUT_COLORS.length]}
                            />
                          ))}
                        </Pie>
                        <Tooltip content={<ChartTooltip />} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <ul className="mt-2 space-y-2">
                    {topCategories.map((row, index) => (
                      <li
                        key={row.category}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className="flex min-w-0 items-center gap-2 text-slate-300">
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{
                              background:
                                DONUT_COLORS[index % DONUT_COLORS.length],
                            }}
                          />
                          <span className="truncate">{row.label}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-slate-200">
                          {row.percent.toFixed(1)}% · {money(row.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="py-10 text-center text-sm text-slate-500">
                  No expenses in this range.
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
              <h3 className="mb-3 text-sm font-semibold text-white">
                Recurring vs Variable Costs
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-wider text-slate-500">
                    Recurring / Fixed
                  </p>
                  <p className="mt-2 text-xl font-bold tabular-nums text-amber-300">
                    {money(data.current.recurringExpenses)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Rent, wages, maintenance baseline
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-wider text-slate-500">
                    Variable
                  </p>
                  <p className="mt-2 text-xl font-bold tabular-nums text-sky-300">
                    {money(data.current.variableExpenses)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Commodity & discretionary spend
                  </p>
                </div>
              </div>
              <div className="mt-4 h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={[
                      {
                        name: "Cost mix",
                        recurring: data.current.recurringExpenses,
                        variable: data.current.variableExpenses,
                      },
                    ]}
                    layout="vertical"
                    margin={{ top: 8, right: 12, left: 8, bottom: 0 }}
                  >
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      width={70}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar
                      dataKey="recurring"
                      name="Recurring"
                      stackId="a"
                      fill="#f59e0b"
                      radius={[4, 0, 0, 4]}
                    />
                    <Bar
                      dataKey="variable"
                      name="Variable"
                      stackId="a"
                      fill="#38bdf8"
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
              <h3 className="mb-3 text-sm font-semibold text-white">
                Profit Trend
              </h3>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={data.comparisonSeries}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="profitArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#22c55e" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis
                      dataKey="label"
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      axisLine={{ stroke: "#334155" }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      axisLine={{ stroke: "#334155" }}
                      tickLine={false}
                      tickFormatter={(v) =>
                        Math.abs(v) >= 1000
                          ? `${(v / 1000).toFixed(0)}k`
                          : String(v)
                      }
                    />
                    <Tooltip content={<ChartTooltip />} />
                    {compareYoY ? (
                      <Area
                        type="monotone"
                        dataKey="priorNet"
                        name="Prior Net"
                        stroke="#64748b"
                        fill="transparent"
                        strokeWidth={2}
                        strokeDasharray="4 4"
                      />
                    ) : null}
                    <Area
                      type="monotone"
                      dataKey="net"
                      name="Net Profit"
                      stroke="#22c55e"
                      fill="url(#profitArea)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          {loading ? (
            <p className="text-xs text-slate-500">Refreshing…</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
