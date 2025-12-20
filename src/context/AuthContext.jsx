// src/context/AuthContext.jsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "../firebase";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);

  // users/{uid}
  const [profile, setProfile] = useState(null);
  const [isDisabled, setIsDisabled] = useState(false);

  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setAuthLoading(true);
      setUser(u || null);
      setProfile(null);
      setIsDisabled(false);

      if (!u) {
        setAuthLoading(false);
        return;
      }

      try {
        const ref = doc(db, "users", u.uid);
        const snap = await getDoc(ref);

        if (!snap.exists()) {
          setProfile(null);
          setIsDisabled(false);
        } else {
          const data = snap.data();
          setProfile(data);
          setIsDisabled(data?.isActive === false);
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
    await signInWithEmailAndPassword(
      auth,
      String(email).trim(),
      String(password)
    );
  }

  async function logout() {
    await signOut(auth);
  }

  const role = profile?.role || null;
  const assignedShops = Array.isArray(profile?.assignedShops) ? profile.assignedShops : [];
  const isSuperAdmin = role === "super_admin";

  const value = useMemo(
    () => ({
      user,
      profile,
      role,
      assignedShops,
      isSuperAdmin,
      isDisabled,
      authLoading,
      login,
      logout,
    }),
    [user, profile, role, assignedShops, isSuperAdmin, isDisabled, authLoading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider />");
  return ctx;
}
