// src/App.jsx
import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";

import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Clients from "./pages/Clients";
import Parties from "./pages/Parties.jsx";
import Transactions from "./pages/Transactions";
import Inventory from "./pages/Inventory";
import StaffInventory from "./pages/StaffInventory";
import InventoryDailyExpense from "./pages/InventoryDailyExpense";
import Reports from "./pages/Reports";
import ReportsHub from "./pages/ReportsHub";
import PartyReports from "./pages/PartyReports";
import SuperAdmin from "./pages/SuperAdmin";
import Sales from "./pages/Sales"; // ✅ NEW
import ExternalSales from "./pages/ExternalSales";
import ShiftClose from "./pages/ShiftClose";
import PurchaseExpenseEntry from "./pages/PurchaseExpenseEntry";
import PurchaseOrders from "./pages/PurchaseOrders";
import PaymentReceiptEntry from "./pages/PaymentReceiptEntry";
import InternalTransferEntry from "./pages/InternalTransferEntry";
import BankAccounts from "./pages/BankAccounts";
import EndOfDay from "./pages/EndOfDay";
import Help from "./pages/Help";


// ✅ NEW: Range Txn Reports (6 tabs)
import TxnReports from "./pages/TxnReports.jsx";
import DeliveryApp from "./delivery/DeliveryApp.jsx";

import ProtectedRoute from "./components/ProtectedRoute";
import RoleRoute from "./components/RoleRoute";
import RequireActiveShift from "./components/RequireActiveShift";
import Layout from "./components/Layout";

export default function App() {
  const { user, authLoading, isDeliveryBoy, isStaff } = useAuth();

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-100">
        Loading…
      </div>
    );
  }

  const postLoginPath = isDeliveryBoy
    ? "/delivery"
    : isStaff
      ? "/staff-inventory"
      : "/dashboard";

  return (
    <Routes>
      {/* Public */}
      <Route
        path="/"
        element={
          <Navigate to={user ? postLoginPath : "/login"} replace />
        }
      />

      <Route
        path="/login"
        element={user ? <Navigate to={postLoginPath} replace /> : <Login />}
      />

      {/* GTCT Delivery Entry (SPA path — works on hosting that only serves index.html) */}
      <Route path="/delivery" element={<DeliveryApp />} />
      <Route
        path="/delivery.html"
        element={<Navigate to="/delivery" replace />}
      />

      {/* Delivery boys stay on Delivery Entry — not Analytics shell */}
      {isDeliveryBoy ? (
        <Route path="*" element={<Navigate to="/delivery" replace />} />
      ) : null}

      {/* Protected + Layout */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route
          path="/dashboard"
          element={
            isStaff ? <Navigate to="/staff-inventory" replace /> : <Dashboard />
          }
        />

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
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <RequireActiveShift>
                <Sales />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        {/* External Sales / Sales Bill Entry (not a POS checkout) */}
        <Route
          path="/external-sales"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <RequireActiveShift>
                <ExternalSales />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        {/* Z-Report entry (requires an open shift; open/close via global status bar) */}
        <Route
          path="/shift-close"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <RequireActiveShift>
                <ShiftClose />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        <Route
          path="/purchases"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <RequireActiveShift>
                <PurchaseExpenseEntry />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        <Route
          path="/purchase-orders"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <PurchaseOrders />
            </RoleRoute>
          }
        />
        <Route
          path="/payments-receipts"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <RequireActiveShift>
                <PaymentReceiptEntry />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        <Route
          path="/internal-transfers"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <RequireActiveShift>
                <InternalTransferEntry />
              </RequireActiveShift>
            </RoleRoute>
          }
        />

        <Route
          path="/inventory"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <RequireActiveShift>
                <Inventory />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        <Route
          path="/staff-inventory"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin", "staff"]}>
              <RequireActiveShift>
                <StaffInventory />
              </RequireActiveShift>
            </RoleRoute>
          }
        />
        <Route
          path="/inventory-daily-expense"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <InventoryDailyExpense />
            </RoleRoute>
          }
        />
        <Route
          path="/parties"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <Parties />
            </RoleRoute>
          }
        />
        <Route
          path="/bank-accounts"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <BankAccounts />
            </RoleRoute>
          }
        />
        <Route
          path="/transactions"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin"]}>
              <Transactions />
            </RoleRoute>
          }
        />
        <Route
          path="/party-reports"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin", "partner"]}>
              <PartyReports />
            </RoleRoute>
          }
        />

        <Route
          path="/reports"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin", "partner"]}>
              <Reports />
            </RoleRoute>
          }
        />
        <Route
          path="/reports-hub"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin", "partner"]}>
              <ReportsHub />
            </RoleRoute>
          }
        />
        <Route
          path="/reports/end-of-day"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin", "partner"]}>
              <EndOfDay />
            </RoleRoute>
          }
        />
        <Route path="/help" element={<Help />} />

        {/* ✅ NEW: Transaction Range Reports (6 tabs) */}
        <Route
          path="/reports/transactions"
          element={
            <RoleRoute allow={["admin", "shop_admin", "super_admin", "partner"]}>
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
