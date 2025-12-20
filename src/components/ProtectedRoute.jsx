// src/routes/ProtectedRoute.jsx
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useClient } from "../context/ClientContext";

export default function ProtectedRoute({ children, requireClient = false }) {
  const { user, authLoading, profile, role, isDisabled } = useAuth();
  const { activeClientId, loadingClients } = useClient();
  const location = useLocation();

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
        <div className="flex flex-col items-center gap-2">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
          <span className="text-sm text-slate-400">Checking authentication…</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // 🚫 Disabled account
  if (isDisabled) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
        <div className="max-w-md w-full rounded-2xl border border-red-700/40 bg-red-900/20 px-6 py-5 text-center">
          <div className="text-red-300 font-semibold text-lg">Account disabled</div>
          <div className="text-sm text-red-200 mt-2">
            Your account has been disabled by Super Admin. Please contact GTCT support.
          </div>
        </div>
      </div>
    );
  }

  // 🧾 Not provisioned
  if (!profile || !role) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
        <div className="max-w-md w-full rounded-2xl border border-amber-700/40 bg-amber-900/20 px-6 py-5 text-center">
          <div className="text-amber-300 font-semibold text-lg">Account not provisioned</div>
          <div className="text-sm text-amber-200 mt-2">
            Your login is valid, but your access profile is missing. Ask Super Admin to create your user profile.
          </div>
        </div>
      </div>
    );
  }

  if (requireClient) {
    if (loadingClients) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
          <div className="flex flex-col items-center gap-2">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
            <span className="text-sm text-slate-400">Loading shops…</span>
          </div>
        </div>
      );
    }

    if (!activeClientId) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100 p-4">
          <div className="rounded-xl border border-amber-700/40 bg-amber-900/20 px-6 py-4 text-center">
            <div className="text-amber-300 font-semibold">No Active Client</div>
            <div className="text-sm text-amber-200 mt-1">
              Please select a client to continue.
            </div>
          </div>
        </div>
      );
    }
  }

  return children ? children : <Outlet />;
}
