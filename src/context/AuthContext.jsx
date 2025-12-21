// src/context/AuthContext.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";

const AuthContext = createContext(null);

const LS_ACTIVE_CLIENT = "gtct_active_client_id";

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  // users/{uid}
  const [profile, setProfile] = useState(null);
  const [isDisabled, setIsDisabled] = useState(false);

  const [authLoading, setAuthLoading] = useState(true);

  // ✅ optional, used by Login UI
  const [authError, setAuthError] = useState("");

  // ✅ helper: load profile anytime (also used after create/updates)
  const loadProfile = async (u) => {
    if (!u) {
      setProfile(null);
      setIsDisabled(false);
      return null;
    }

    const ref = doc(db, "users", u.uid);
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      setProfile(null);
      setIsDisabled(false);
      return null;
    }

    const data = snap.data();
    setProfile(data);
    setIsDisabled(data?.isActive === false);
    return data;
  };

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setAuthLoading(true);
      setUser(u || null);
      setAuthError("");

      // reset
      setProfile(null);
      setIsDisabled(false);

      if (!u) {
        setAuthLoading(false);
        return;
      }

      try {
        const data = await loadProfile(u);

        // ✅ optional but recommended:
        // If user is disabled in Firestore → sign them out immediately
        if (data?.isActive === false) {
          await signOut(auth);
          localStorage.removeItem(LS_ACTIVE_CLIENT);
          setUser(null);
          setProfile(null);
          setIsDisabled(true);
        }
      } catch (e) {
        console.error("AuthContext profile load error:", e);
        setProfile(null);
        setIsDisabled(false);
      } finally {
        setAuthLoading(false);
      }
    });

    return () => unsub();
  }, []);

  async function login(email, password) {
    setAuthError("");
    await signInWithEmailAndPassword(
      auth,
      String(email).trim().toLowerCase(),
      String(password)
    );
  }

  async function logout() {
    try {
      await signOut(auth);
    } finally {
      // ✅ clear app state
      setUser(null);
      setProfile(null);
      setIsDisabled(false);
      setAuthError("");

      // ✅ clear active client
      localStorage.removeItem(LS_ACTIVE_CLIENT);
    }
  }

  // ✅ manual refresh profile (useful after role/shop updates)
  async function reloadProfile() {
    try {
      if (!auth.currentUser) return null;
      return await loadProfile(auth.currentUser);
    } catch (e) {
      console.error("reloadProfile error:", e);
      return null;
    }
  }

  const role = profile?.role || null;
  const assignedShops = Array.isArray(profile?.assignedShops)
    ? profile.assignedShops.filter(Boolean)
    : [];

  const isSuperAdmin = role === "super_admin";
  const isAdmin = role === "admin";
  const isPartner = role === "partner";

  // ✅ nicer display helpers
  const displayName =
    (profile?.name && String(profile.name).trim()) ||
    (user?.email ? user.email.split("@")[0] : "User");

  const value = useMemo(
    () => ({
      user,
      profile,
      role,
      assignedShops,
      isSuperAdmin,
      isAdmin,
      isPartner,
      isDisabled,
      authLoading,

      authError,
      setAuthError,

      login,
      logout,
      reloadProfile,

      displayName,
    }),
    [
      user,
      profile,
      role,
      assignedShops,
      isSuperAdmin,
      isAdmin,
      isPartner,
      isDisabled,
      authLoading,
      authError,
      displayName,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider />");
  return ctx;
}
