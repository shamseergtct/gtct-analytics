// src/App.jsx
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";

import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Clients from "./pages/Clients";
import Parties from "./pages/Parties.jsx";
import Transactions from "./pages/Transactions";
import Inventory from "./pages/Inventory";
import Reports from "./pages/Reports";
import PartyReports from "./pages/PartyReports";
import SuperAdmin from "./pages/SuperAdmin";

import ProtectedRoute from "./components/ProtectedRoute";
import RoleRoute from "./components/RoleRoute";
import Layout from "./components/Layout";

export default function App() {
  const { user, authLoading } = useAuth();

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
        Loading…
      </div>
    );
  }

  return (
    <Routes>
      {/* Public */}
      <Route
        path="/"
        element={<Navigate to={user ? "/dashboard" : "/login"} replace />}
      />

      <Route
        path="/login"
        element={user ? <Navigate to="/dashboard" replace /> : <Login />}
      />

      {/* Protected + Layout */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />

        {/* ✅ Super Admin only (Admins cannot add clients) */}
        <Route
          path="/clients"
          element={
            <RoleRoute allow={["super_admin"]}>
              <Clients />
            </RoleRoute>
          }
        />

        <Route path="/inventory" element={<Inventory />} />
        <Route path="/parties" element={<Parties />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/party-reports" element={<PartyReports />} />
        <Route path="/reports" element={<Reports />} />

        {/* ✅ Super Admin Console */}
        <Route
          path="/superadmin"
          element={
            <RoleRoute allow={["super_admin"]}>
              <SuperAdmin />
            </RoleRoute>
          }
        />
      </Route>

      {/* 404 */}
      <Route
        path="*"
        element={
          <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
            404 - Page Not Found
          </div>
        }
      />
    </Routes>
  );
}
