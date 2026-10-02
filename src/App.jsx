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
import ReportsHub from "./pages/ReportsHub";
import PartyReports from "./pages/PartyReports";
import SuperAdmin from "./pages/SuperAdmin";
import Sales from "./pages/Sales"; // ✅ NEW
import ShiftClose from "./pages/ShiftClose";
import PurchaseExpenseEntry from "./pages/PurchaseExpenseEntry";
import PaymentReceiptEntry from "./pages/PaymentReceiptEntry";
import InternalTransferEntry from "./pages/InternalTransferEntry";
import BankAccounts from "./pages/BankAccounts";
import EndOfDay from "./pages/EndOfDay";
import Help from "./pages/Help";


// ✅ NEW: Range Txn Reports (6 tabs)
import TxnReports from "./pages/TxnReports.jsx";

import ProtectedRoute from "./components/ProtectedRoute";
import RoleRoute from "./components/RoleRoute";
import RequireActiveShift from "./components/RequireActiveShift";
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

        {/* ✅ Sales module (Admin + Super Admin only) */}
        <Route
          path="/sales"
          element={
            <RoleRoute allow={["admin", "super_admin"]}>
              <RequireActiveShift>
                <Sales />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        {/* Z-Report entry (requires an open shift; open/close via global status bar) */}
        <Route
          path="/shift-close"
          element={
            <RoleRoute allow={["admin", "super_admin"]}>
              <RequireActiveShift>
                <ShiftClose />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        <Route
          path="/purchases"
          element={
            <RoleRoute allow={["admin", "super_admin"]}>
              <RequireActiveShift>
                <PurchaseExpenseEntry />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        <Route
          path="/payments-receipts"
          element={
            <RoleRoute allow={["admin", "super_admin"]}>
              <RequireActiveShift>
                <PaymentReceiptEntry />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        <Route
          path="/internal-transfers"
          element={
            <RoleRoute allow={["admin", "super_admin"]}>
              <RequireActiveShift>
                <InternalTransferEntry />
              </RequireActiveShift>
            </RoleRoute>
          }
        />

        <Route
          path="/inventory"
          element={
            <RequireActiveShift>
              <Inventory />
            </RequireActiveShift>
          }
        />
        <Route path="/parties" element={<Parties />} />
        <Route path="/bank-accounts" element={<BankAccounts />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/party-reports" element={<PartyReports />} />

        <Route path="/reports" element={<Reports />} />
        <Route path="/reports-hub" element={<ReportsHub />} />
        <Route path="/reports/end-of-day" element={<EndOfDay />} />
        <Route path="/help" element={<Help />} />
        

        {/* ✅ NEW: Transaction Range Reports (6 tabs) */}
        <Route
          path="/reports/transactions"
          element={
            <RoleRoute allow={["admin", "super_admin"]}>
              <TxnReports />
            </RoleRoute>
          }
        />

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
