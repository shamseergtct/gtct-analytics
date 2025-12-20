// src/pages/Dashboard.jsx
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";

import {
  Users,
  Building2,
  ArrowLeftRight,
  BarChart3,
} from "lucide-react";

export default function Dashboard() {
  const { user } = useAuth();
  const { activeClientId, activeClientData } = useClient();
  const nav = useNavigate();

  const cards = [
    {
      title: "Clients",
      desc: "Manage your shops / businesses",
      icon: Users,
      to: "/clients",
    },
    {
      title: "Parties",
      desc: "Customers & Suppliers",
      icon: Building2,
      to: "/parties",
      disabled: !activeClientId,
    },
    {
      title: "Transactions",
      desc: "Sales, Purchase, Expenses",
      icon: ArrowLeftRight,
      to: "/transactions",
      disabled: !activeClientId,
    },
    {
      title: "Reports",
      desc: "Daily & Monthly summaries",
      icon: BarChart3,
      to: "/reports",
      disabled: !activeClientId,
    },
  ];

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-slate-400 mt-1">
            Signed in as <span className="text-slate-200">{user?.email}</span>
          </p>
        </div>

        {/* Active client badge */}
        {activeClientData?.name ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/15 px-4 py-2 text-sm text-emerald-200">
            Active Client:{" "}
            <span className="font-semibold">{activeClientData.name}</span>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/15 px-4 py-2 text-sm text-amber-200">
            No client selected
          </div>
        )}
      </div>

      {/* Quick Actions */}
      <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(({ title, desc, icon: Icon, to, disabled }) => (
          <button
            key={title}
            onClick={() => !disabled && nav(to)}
            disabled={disabled}
            className={[
              "rounded-2xl border p-5 text-left transition",
              disabled
                ? "border-slate-800 bg-slate-900/40 text-slate-500 cursor-not-allowed"
                : "border-slate-800 bg-slate-900 hover:bg-slate-800/60",
            ].join(" ")}
          >
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-slate-800 flex items-center justify-center">
                <Icon className="h-5 w-5 text-slate-200" />
              </div>
              <div>
                <div className="font-semibold text-slate-100">{title}</div>
                <div className="text-sm text-slate-400">{desc}</div>
              </div>
            </div>

            {disabled && (
              <div className="mt-3 text-xs text-amber-400">
                Select a client to continue
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Info Panel */}
      <div className="mt-10 rounded-2xl border border-slate-800 bg-slate-900 p-6">
        <h2 className="text-xl font-semibold">How to get started</h2>
        <ol className="mt-3 space-y-2 text-slate-300 list-decimal pl-5">
          <li>Create or select a <strong>Client</strong></li>
          <li>Add <strong>Customers & Suppliers</strong></li>
          <li>Record daily <strong>Transactions</strong></li>
          <li>Download <strong>Reports</strong> anytime</li>
        </ol>
      </div>
    </div>
  );
}
