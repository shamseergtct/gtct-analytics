// src/pages/SuperAdmin.jsx
import { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import {
  createUserWithEmailAndPassword,
  getAuth,
  signOut,
} from "firebase/auth";
import { getApps, initializeApp } from "firebase/app";

import { db, firebaseConfig } from "../firebase";
import { useAuth } from "../context/AuthContext";

// ✅ Secondary auth (does not affect current session)
function getSecondaryAuth() {
  const name = "secondary-auth";
  const existing = getApps().find((a) => a.name === name);
  const secondaryApp = existing || initializeApp(firebaseConfig, name);
  return getAuth(secondaryApp);
}

export default function SuperAdmin() {
  const { user, isSuperAdmin } = useAuth();

  const [tab, setTab] = useState("shops"); // 'shops' | 'users'
  const [shops, setShops] = useState([]);
  const [loadingShops, setLoadingShops] = useState(true);

  // ✅ Users list
  const [allUsers, setAllUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);

  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  // Shop creation form
  const [shopId, setShopId] = useState("");
  const [shopName, setShopName] = useState("");
  const [shopCurrency, setShopCurrency] = useState("INR");
  const [creatingShop, setCreatingShop] = useState(false);

  // User creation form
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState("admin"); // admin | partner
  const [selectedShopIds, setSelectedShopIds] = useState([]);
  const [creatingUser, setCreatingUser] = useState(false);

  const shopsById = useMemo(() => {
    const map = {};
    for (const s of shops) map[s.id] = s;
    return map;
  }, [shops]);

  async function loadShops() {
    setErr("");
    setMsg("");
    setLoadingShops(true);
    try {
      const qy = query(collection(db, "clients"), orderBy("createdAt", "desc"));
      const snap = await getDocs(qy);
      setShops(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to load shops");
    } finally {
      setLoadingShops(false);
    }
  }

  async function loadUsers() {
    setLoadingUsers(true);
    try {
      const qy = query(collection(db, "users"), orderBy("createdAt", "desc"));
      const snap = await getDocs(qy);
      setAllUsers(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to load users");
    } finally {
      setLoadingUsers(false);
    }
  }

  useEffect(() => {
    loadShops();
  }, []);

  useEffect(() => {
    if (tab === "users") loadUsers();
  }, [tab]);

  if (!isSuperAdmin) {
    return (
      <div className="p-6 text-slate-100">
        <div className="text-xl font-semibold">Access denied</div>
        <div className="opacity-80 text-sm mt-1">
          This page is only for <b>super_admin</b>.
        </div>
      </div>
    );
  }

  // -----------------------------
  // Create Shop
  // -----------------------------
  async function handleCreateShop(e) {
    e.preventDefault();
    setErr("");
    setMsg("");

    const id = String(shopId || "").trim();
    const name = String(shopName || "").trim();
    const currency = String(shopCurrency || "").trim() || "INR";

    if (!id || !name) {
      setErr("Shop ID and Name are required.");
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      setErr("Shop ID can use letters, numbers, _ and - only.");
      return;
    }

    setCreatingShop(true);
    try {
      await setDoc(doc(db, "clients", id), {
        clientId: id,
        name,
        currency,
        createdAt: Date.now(),
        createdBy: user?.uid || null,
      });

      setShopId("");
      setShopName("");
      setShopCurrency("INR");
      setMsg(`✅ Shop created: ${id}`);
      await loadShops();
    } catch (e2) {
      console.error(e2);
      setErr(e2?.message || "Failed to create shop");
    } finally {
      setCreatingShop(false);
    }
  }

  // -----------------------------
  // Create User
  // -----------------------------
  async function handleCreateUser(e) {
    e.preventDefault();
    setErr("");
    setMsg("");

    const email = String(newEmail || "").trim().toLowerCase();
    const password = String(newPassword || "");
    const roleToSet = newRole === "partner" ? "partner" : "admin";

    if (!email || !password) {
      setErr("Email and Password are required.");
      return;
    }
    if (password.length < 6) {
      setErr("Password must be at least 6 characters.");
      return;
    }
    if (!selectedShopIds.length) {
      setErr("Please assign at least 1 shop.");
      return;
    }

    setCreatingUser(true);
    try {
      const secondaryAuth = getSecondaryAuth();
      const cred = await createUserWithEmailAndPassword(
        secondaryAuth,
        email,
        password
      );
      const uid = cred.user.uid;

      await setDoc(doc(db, "users", uid), {
        uid,
        email,
        role: roleToSet,
        assignedShops: selectedShopIds,
        createdBy: user?.uid || null,
        createdAt: Date.now(),
        isActive: true,
      });

      await signOut(secondaryAuth);

      setNewEmail("");
      setNewPassword("");
      setNewRole("admin");
      setSelectedShopIds([]);
      setMsg(`✅ User created: ${email} (${roleToSet})`);

      await loadUsers();
    } catch (e2) {
      console.error(e2);
      setErr(e2?.message || "Failed to create user");
    } finally {
      setCreatingUser(false);
    }
  }

  // -----------------------------
  // ✅ Phase 2: Disable / Enable user (Firestore-only)
  // -----------------------------
  async function toggleUserActive(targetUid, nextActive) {
    setErr("");
    setMsg("");
    try {
      // prevent disabling yourself (safety)
      if (targetUid === user?.uid && nextActive === false) {
        setErr("You cannot disable your own super admin account.");
        return;
      }

      await updateDoc(doc(db, "users", targetUid), {
        isActive: nextActive,
        updatedAt: Date.now(),
        updatedBy: user?.uid || null,
      });

      setMsg(`✅ User ${nextActive ? "enabled" : "disabled"}: ${targetUid}`);
      await loadUsers();
    } catch (e) {
      console.error(e);
      setErr(e?.message || "Failed to update user status");
    }
  }

  function toggleShopSelection(id) {
    setSelectedShopIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  }

  return (
    <div className="p-4 md:p-6 text-slate-100">
      <div className="text-2xl font-semibold mb-1">Super Admin</div>
      <div className="text-sm opacity-80 mb-5">
        Multi-tenant shop + user management (RBAC)
      </div>

      <div className="flex gap-2 mb-5">
        <button
          className={`px-4 py-2 rounded border ${
            tab === "shops"
              ? "bg-slate-800 border-slate-700"
              : "border-slate-800 hover:bg-slate-900"
          }`}
          onClick={() => setTab("shops")}
        >
          Shop Management
        </button>
        <button
          className={`px-4 py-2 rounded border ${
            tab === "users"
              ? "bg-slate-800 border-slate-700"
              : "border-slate-800 hover:bg-slate-900"
          }`}
          onClick={() => setTab("users")}
        >
          User Management
        </button>
      </div>

      {err && (
        <div className="mb-4 text-sm text-red-200 bg-red-950/40 border border-red-900 rounded-xl p-2">
          {err}
        </div>
      )}
      {msg && (
        <div className="mb-4 text-sm text-emerald-200 bg-emerald-950/30 border border-emerald-900/40 rounded-xl p-2">
          {msg}
        </div>
      )}

      {/* SHOPS TAB */}
      {tab === "shops" && (
        <div className="grid lg:grid-cols-2 gap-6">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="font-semibold mb-3">Create New Shop</div>
            <form onSubmit={handleCreateShop} className="space-y-3">
              <div>
                <div className="text-xs opacity-80 mb-1">Client ID (shop id)</div>
                <input
                  className="w-full p-2 rounded bg-slate-950 border border-slate-800"
                  value={shopId}
                  onChange={(e) => setShopId(e.target.value)}
                  placeholder="shop_001"
                />
              </div>

              <div>
                <div className="text-xs opacity-80 mb-1">Shop Name</div>
                <input
                  className="w-full p-2 rounded bg-slate-950 border border-slate-800"
                  value={shopName}
                  onChange={(e) => setShopName(e.target.value)}
                  placeholder="My Shop"
                />
              </div>

              <div>
                <div className="text-xs opacity-80 mb-1">Currency</div>
                <input
                  className="w-full p-2 rounded bg-slate-950 border border-slate-800"
                  value={shopCurrency}
                  onChange={(e) => setShopCurrency(e.target.value)}
                  placeholder="INR, BHD, AED..."
                />
              </div>

              <button
                disabled={creatingShop}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 px-4 py-2 rounded"
              >
                {creatingShop ? "Creating…" : "Create Shop"}
              </button>
            </form>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="font-semibold mb-3">All Shops</div>
            {loadingShops ? (
              <div className="opacity-80">Loading…</div>
            ) : (
              <div className="space-y-2">
                {shops.length === 0 && (
                  <div className="opacity-70 text-sm">No shops yet.</div>
                )}
                {shops.map((s) => (
                  <div
                    key={s.id}
                    className="p-3 rounded border border-slate-800 bg-slate-950"
                  >
                    <div className="font-semibold">{s.name || s.id}</div>
                    <div className="text-xs opacity-80">
                      ID: {s.id} • Currency: {s.currency || "-"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* USERS TAB */}
      {tab === "users" && (
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Create User */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="font-semibold mb-3">Create New User</div>
            <form onSubmit={handleCreateUser} className="space-y-3">
              <div>
                <div className="text-xs opacity-80 mb-1">Email</div>
                <input
                  className="w-full p-2 rounded bg-slate-950 border border-slate-800"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="user@email.com"
                />
              </div>

              <div>
                <div className="text-xs opacity-80 mb-1">Password</div>
                <input
                  type="password"
                  className="w-full p-2 rounded bg-slate-950 border border-slate-800"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Temporary password"
                />
              </div>

              <div>
                <div className="text-xs opacity-80 mb-1">Role</div>
                <select
                  className="w-full p-2 rounded bg-slate-950 border border-slate-800"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                >
                  <option value="admin">admin</option>
                  <option value="partner">partner</option>
                </select>
              </div>

              <div>
                <div className="text-xs opacity-80 mb-2">
                  Assign Shops (multi-select)
                </div>
                <div className="max-h-56 overflow-auto rounded border border-slate-800 bg-slate-950 p-2 space-y-2">
                  {loadingShops ? (
                    <div className="opacity-70 text-sm p-2">Loading shops…</div>
                  ) : shops.length === 0 ? (
                    <div className="opacity-70 text-sm p-2">
                      No shops found. Create a shop first.
                    </div>
                  ) : (
                    shops.map((s) => (
                      <label
                        key={s.id}
                        className="flex items-center gap-2 text-sm p-2 rounded hover:bg-slate-900 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedShopIds.includes(s.id)}
                          onChange={() => toggleShopSelection(s.id)}
                        />
                        <span className="font-medium">{s.name || s.id}</span>
                        <span className="text-xs opacity-70">({s.id})</span>
                      </label>
                    ))
                  )}
                </div>
              </div>

              <button
                disabled={creatingUser || loadingShops || shops.length === 0}
                className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 px-4 py-2 rounded"
              >
                {creatingUser ? "Creating…" : "Create User"}
              </button>
            </form>

            {/* Existing Users */}
            <div className="mt-6 bg-slate-950 border border-slate-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="font-semibold">Existing Users</div>
                <button
                  onClick={loadUsers}
                  className="px-3 py-1.5 text-xs rounded bg-slate-800 hover:bg-slate-700 border border-slate-700"
                >
                  Refresh
                </button>
              </div>

              {loadingUsers ? (
                <div className="opacity-70 text-sm">Loading users…</div>
              ) : allUsers.length === 0 ? (
                <div className="opacity-70 text-sm">No users found.</div>
              ) : (
                <div className="space-y-3">
                  {allUsers.map((u) => (
                    <div
                      key={u.id}
                      className="p-3 rounded border border-slate-800 bg-slate-900 flex justify-between items-start"
                    >
                      <div>
                        <div className="font-medium">{u.email || u.id}</div>
                        <div className="text-xs opacity-80">
                          Role: <b>{u.role || "-"}</b>
                        </div>
                        <div className="text-xs opacity-70">
                          Shops:{" "}
                          {Array.isArray(u.assignedShops) && u.assignedShops.length
                            ? u.assignedShops.join(", ")
                            : "—"}
                        </div>
                        <div className="text-xs mt-1">
                          Status:{" "}
                          <span
                            className={
                              u.isActive === false
                                ? "text-red-400"
                                : "text-emerald-400"
                            }
                          >
                            {u.isActive === false ? "Disabled" : "Active"}
                          </span>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            toggleUserActive(u.id, u.isActive === false)
                          }
                          className={`px-3 py-1 text-xs rounded ${
                            u.isActive === false
                              ? "bg-emerald-600 hover:bg-emerald-700"
                              : "bg-red-600 hover:bg-red-700"
                          }`}
                        >
                          {u.isActive === false ? "Enable" : "Disable"}
                        </button>

                        {/* Phase 3 later */}
                        <button
                          disabled
                          className="px-3 py-1 text-xs rounded bg-slate-700 opacity-50 cursor-not-allowed"
                        >
                          Reset Password
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="text-xs opacity-70 mt-3">
                Tip: You cannot disable your own super admin account.
              </div>
            </div>
          </div>

          {/* Notes */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="font-semibold mb-2">Phase 2 Notes</div>
            <ul className="text-sm opacity-80 list-disc pl-5 space-y-2">
              <li>Disable/Enable is stored in Firestore as <code>isActive</code>.</li>
              <li>Firestore rules block disabled users completely.</li>
              <li>Next Phase 3: Reset password using Cloud Function (secure).</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
