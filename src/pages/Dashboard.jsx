import { useNavigate } from "react-router-dom";
import { useClient } from "../context/ClientContext";
import {
  Users,
  Clock3,
  ReceiptText,
  HandCoins,
  Landmark,
  RefreshCcw,
  Building2,
  Package,
  BarChart3,
  CalendarCheck2,
} from "lucide-react";

export default function Dashboard() {
  const { activeClientId } = useClient();
  const nav = useNavigate();

  const cards = [
    { title: "Client", icon: Users, to: "/clients", requiresShop: false },
    { title: "Z Report", icon: Clock3, to: "/shift-close", requiresShop: true },
    {
      title: "Purchase & Expenses",
      icon: ReceiptText,
      to: "/purchases",
      requiresShop: true,
    },
    {
      title: "Payment & Transfer",
      icon: HandCoins,
      to: "/payments-receipts",
      requiresShop: true,
    },
    {
      title: "Bank Account",
      icon: Landmark,
      to: "/bank-accounts",
      requiresShop: true,
    },
    {
      title: "Internal Transfer",
      icon: RefreshCcw,
      to: "/internal-transfers",
      requiresShop: true,
    },
    { title: "Party", icon: Building2, to: "/parties", requiresShop: true },
    { title: "Inventory", icon: Package, to: "/inventory", requiresShop: true },
    {
      title: "Report Hub",
      icon: BarChart3,
      to: "/reports-hub",
      requiresShop: true,
    },
    {
      title: "End of the Day",
      icon: CalendarCheck2,
      to: "/reports/end-of-day",
      requiresShop: true,
    },
  ];

  return (
    <div className="max-w-6xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">Dashboard</h1>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {cards.map(({ title, icon: Icon, to, requiresShop }) => {
          const disabled = requiresShop && !activeClientId;
          return (
            <button
              key={title}
              type="button"
              onClick={() => !disabled && nav(to)}
              disabled={disabled}
              className={[
                "rounded-2xl border border-slate-800 p-5 transition flex flex-col items-center justify-center gap-3 min-h-[120px]",
                disabled
                  ? "bg-slate-900/40 text-slate-500 cursor-not-allowed opacity-60"
                  : "bg-slate-900 hover:bg-slate-800/60 text-slate-100",
              ].join(" ")}
            >
              <div
                className={[
                  "h-11 w-11 rounded-xl flex items-center justify-center",
                  disabled ? "bg-slate-800/50" : "bg-slate-800",
                ].join(" ")}
              >
                <Icon
                  className={[
                    "h-6 w-6",
                    disabled ? "text-slate-500" : "text-slate-200",
                  ].join(" ")}
                />
              </div>
              <span className="font-bold text-center text-sm sm:text-base leading-tight">
                {title}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
