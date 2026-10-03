// src/components/Layout.jsx
import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";

import ShiftStatusBar from "./ShiftStatusBar";
import NotificationPanel from "./NotificationPanel";
import {
  Menu,
  X,
  LayoutDashboard,
  Users,
  ArrowLeftRight,
  BarChart3,
  UserCircle2,
  LogOut,
  Building2,
  Shield,
  Package,
  ShoppingCart,
  ClipboardList,
  FileText,
  Clock3,
  ReceiptText,
  HandCoins,
  CalendarCheck2,
  RefreshCcw,
  Landmark,
  ArrowLeft,
  Home,
  CircleHelp,
} from "lucide-react";

export default function Layout() {
  const { user, role, isSuperAdmin, logout, displayName } = useAuth();

  const { clients, activeClientId, activeClientData, setActiveClient, loadingClients } =
    useClient();

  const nav = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isPartner = role === "partner";
  const partnerCanSwitchShop = isPartner && !loadingClients && clients.length >= 2;
  const showClientDropdownDesktop = !isPartner || partnerCanSwitchShop;
  const showClientDropdownMobile = !isPartner || partnerCanSwitchShop;
  const homePath = isPartner ? "/reports-hub" : "/dashboard";
  const isHome =
    location.pathname === homePath ||
    location.pathname === "/dashboard" ||
    (isPartner && location.pathname === "/reports");

  useEffect(() => {
    if (mobileOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => (document.body.style.overflow = "");
  }, [mobileOpen]);

  const handleLogout = async () => {
    try {
      await logout();
      nav("/login", { replace: true });
    } catch (e) {
      console.error("Logout failed:", e);
    }
  };

  const handleBack = () => {
    if (window.history.length > 1) {
      nav(-1);
      return;
    }
    nav(homePath);
  };

  const handleHome = () => {
    nav(homePath);
  };

  const navButtonClass =
    "inline-flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-2.5 py-2 text-sm font-medium text-slate-200 hover:bg-slate-800 hover:text-white transition-colors";

  const linkClass = ({ isActive }) =>
    [
      "flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition",
      isActive
        ? "bg-slate-800/70 text-white"
        : "text-slate-300 hover:bg-slate-800/40 hover:text-white",
    ].join(" ");

  const activeBadge =
    activeClientData?.name ? (
      <span className="hidden sm:inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-200">
        Active: {activeClientData.name}
      </span>
    ) : (
      <span className="hidden sm:inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs text-amber-200">
        No active client
      </span>
    );

  const baseNavItems = useMemo(
    () => [
      { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { to: "/clients", label: "Clients", icon: Users },
      { to: "/sales", label: "Sales", icon: ShoppingCart },
      { to: "/external-sales", label: "External Sales", icon: ClipboardList },
      { to: "/shift-close", label: "Z-Report", icon: Clock3 },
      { to: "/purchases", label: "Purchases & Expenses", icon: ReceiptText },
      { to: "/payments-receipts", label: "Payments & Receipts", icon: HandCoins },
      { to: "/internal-transfers", label: "Internal Transfers", icon: RefreshCcw },
      { to: "/parties", label: "Parties", icon: Building2 },
      { to: "/bank-accounts", label: "Bank Accounts", icon: Landmark },
      { to: "/transactions", label: "Transactions", icon: ArrowLeftRight },
      { to: "/inventory", label: "Inventory", icon: Package },
      { to: "/reports-hub", label: "Reports Hub", icon: BarChart3 },
      { to: "/reports", label: "Daily Pulse", icon: BarChart3 },
      { to: "/reports/end-of-day", label: "End of Day", icon: CalendarCheck2 },
      { to: "/reports/transactions", label: "Range Reports", icon: FileText },
      { to: "/party-reports", label: "Party Reports", icon: BarChart3 },
      { to: "/help", label: "Help", icon: CircleHelp },
    ],
    []
  );

  const navItems = useMemo(() => {
    if (isPartner) {
      return [
        { to: "/reports-hub", label: "Reports Hub", icon: BarChart3 },
        { to: "/reports", label: "Daily Pulse", icon: BarChart3 },
        { to: "/reports/end-of-day", label: "End of Day", icon: CalendarCheck2 },
        { to: "/reports/transactions", label: "Range Reports", icon: FileText },
        { to: "/party-reports", label: "Party Reports", icon: BarChart3 },
        { to: "/help", label: "Help", icon: CircleHelp },
      ];
    }

    const items = [...baseNavItems];
    if (role === "super_admin") {
      items.unshift({ to: "/superadmin", label: "Super Admin", icon: Shield });
    }
    return items;
  }, [baseNavItems, role, isPartner]);

  const noAccessibleShops = !isSuperAdmin && !loadingClients && clients.length === 0;

  const roleLabel =
    role === "super_admin" ? "Super Admin" : role === "partner" ? "Partner" : "Admin";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="fixed top-0 left-0 right-0 z-40 h-16 border-b border-slate-800/70 bg-slate-950/80 backdrop-blur">
        <div className="h-full flex items-center justify-between px-4 lg:pl-72">
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              className="lg:hidden inline-flex items-center justify-center rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 hover:bg-slate-800"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleBack}
                className={navButtonClass}
                aria-label="Go back"
                title="Back"
              >
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Back</span>
              </button>
              <button
                type="button"
                onClick={handleHome}
                disabled={isHome}
                className={`${navButtonClass} disabled:cursor-default disabled:opacity-50 disabled:hover:bg-slate-900`}
                aria-label="Go home"
                title="Home"
              >
                <Home className="h-4 w-4" />
                <span className="hidden sm:inline">Home</span>
              </button>
            </div>

            <div className="hidden min-[420px]:flex flex-col leading-tight">
              <span className="text-lg font-bold tracking-tight">GTCT Analytics</span>
              <span className="text-xs text-slate-400">
                {role === "super_admin"
                  ? "Super Admin Console"
                  : isPartner
                  ? "Partner Reports"
                  : "Remote Bookkeeping"}
              </span>
            </div>

            {activeBadge}
          </div>

          <div className="flex items-center gap-3">
            {showClientDropdownDesktop ? (
              <div className="hidden md:block">
                <select
                  className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-slate-500 disabled:opacity-60"
                  value={activeClientId || ""}
                  disabled={loadingClients || noAccessibleShops}
                  onChange={(e) => {
                    setActiveClient(e.target.value);
                    nav(isPartner ? "/reports" : "/dashboard");
                  }}
                >
                  <option value="" disabled>
                    {loadingClients
                      ? "Loading shops…"
                      : noAccessibleShops
                      ? "No shops assigned"
                      : "Select client…"}
                  </option>

                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.id}
                    </option>
                  ))}
                </select>

                {noAccessibleShops ? (
                  <div className="mt-1 text-[11px] text-amber-300/80">
                    Your account has no shops assigned. Contact Super Admin.
                  </div>
                ) : null}
              </div>
            ) : null}

            <NotificationPanel />

            <div className="hidden sm:flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2">
              <UserCircle2 className="h-5 w-5 text-slate-300" />
              <div className="leading-tight">
                <div className="text-sm font-medium text-slate-100">
                  {displayName || user?.email || "User"}
                </div>
                <div className="text-xs text-slate-400">
                  {role ? `Role: ${roleLabel}` : "Signed in"}
                </div>
              </div>
            </div>

            <button
              onClick={handleLogout}
              className="inline-flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-950 hover:opacity-90"
            >
              <LogOut className="h-4 w-4" />
              Logout
            </button>
          </div>
        </div>
      </header>

      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:w-68 lg:flex-col lg:border-r lg:border-slate-800/70 lg:bg-slate-950">
        <div className="h-16 border-b border-slate-800/70 px-5 flex items-center">
          <button
            type="button"
            onClick={handleHome}
            className="flex items-center gap-2 rounded-xl text-left hover:opacity-90"
            title="Home"
          >
            <div className="h-9 w-9 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center">
              <BarChart3 className="h-5 w-5 text-slate-200" />
            </div>
            <div className="leading-tight">
              <div className="font-bold">GTCT Analytics</div>
              <div className="text-xs text-slate-400">
                {activeClientData?.name ||
                  (noAccessibleShops ? "No shops assigned" : "No client selected")}
              </div>
            </div>
          </button>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navItems.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={linkClass}>
              {Icon ? <Icon className="h-4 w-4" /> : null}
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {mobileOpen ? (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 bg-slate-950 border-r border-slate-800/70">
            <div className="h-16 border-b border-slate-800/70 px-4 flex items-center justify-between">
              <div className="font-bold">Menu</div>
              <button
                className="inline-flex items-center justify-center rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 hover:bg-slate-800"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex gap-2 border-b border-slate-800/70 p-4">
              <button
                type="button"
                onClick={() => {
                  handleBack();
                  setMobileOpen(false);
                }}
                className={`${navButtonClass} flex-1 justify-center`}
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
              <button
                type="button"
                onClick={() => {
                  handleHome();
                  setMobileOpen(false);
                }}
                className={`${navButtonClass} flex-1 justify-center`}
              >
                <Home className="h-4 w-4" />
                Home
              </button>
            </div>

            {showClientDropdownMobile ? (
              <div className="p-4 border-b border-slate-800/70">
                <div className="text-xs text-slate-400 mb-2">Active Client</div>
                <select
                  className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-slate-500 disabled:opacity-60"
                  value={activeClientId || ""}
                  disabled={loadingClients || noAccessibleShops}
                  onChange={(e) => {
                    setActiveClient(e.target.value);
                    nav(isPartner ? "/reports" : "/dashboard");
                    setMobileOpen(false);
                  }}
                >
                  <option value="" disabled>
                    {loadingClients
                      ? "Loading shops…"
                      : noAccessibleShops
                      ? "No shops assigned"
                      : "Select client…"}
                  </option>

                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.id}
                    </option>
                  ))}
                </select>

                {noAccessibleShops ? (
                  <div className="mt-2 text-[11px] text-amber-300/80">
                    No shops assigned. Contact Super Admin.
                  </div>
                ) : null}
              </div>
            ) : null}

            <nav className="p-4 space-y-1">
              {navItems.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={linkClass}
                  onClick={() => setMobileOpen(false)}
                >
                  {Icon ? <Icon className="h-4 w-4" /> : null}
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
        </div>
      ) : null}

      <main className="pt-16 lg:pl-72">
        <ShiftStatusBar />
        <div className="p-4 sm:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
