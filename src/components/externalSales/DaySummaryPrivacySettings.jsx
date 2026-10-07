import { useEffect, useState } from "react";
import {
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { Lock } from "lucide-react";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import {
  hashDaySummaryPassword,
  setDaySummarySessionUnlocked,
} from "../../utils/daySummaryPrivacy.js";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_CLASS,
  LABEL_CLASS,
} from "./externalSalesUi.js";

export default function DaySummaryPrivacySettings({
  clientId,
  onMessage,
  onError,
}) {
  const { user } = useAuth();
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!clientId) {
      setHasPassword(false);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const settingsRef = doc(db, "client_settings", clientId);
    return onSnapshot(
      settingsRef,
      (snapshot) => {
        const data = snapshot.exists() ? snapshot.data() : null;
        setHasPassword(Boolean(String(data?.daySummaryPasswordHash || "").trim()));
        setLoading(false);
      },
      () => {
        setHasPassword(false);
        setLoading(false);
      }
    );
  }, [clientId]);

  async function savePassword(event) {
    event.preventDefault();
    onError?.("");
    if (!clientId) {
      onError?.("Select an active shop first.");
      return;
    }
    const next = String(password || "");
    const confirmValue = String(confirm || "");
    if (next.length < 4) {
      onError?.("Password must be at least 4 characters.");
      return;
    }
    if (next !== confirmValue) {
      onError?.("Password and confirmation do not match.");
      return;
    }

    setSaving(true);
    try {
      const hash = await hashDaySummaryPassword(next);
      await setDoc(
        doc(db, "client_settings", clientId),
        {
          clientId,
          daySummaryPasswordHash: hash,
          daySummaryPasswordUpdatedAt: serverTimestamp(),
          daySummaryPasswordUpdatedBy: user?.uid || null,
          updatedAt: serverTimestamp(),
          updatedBy: user?.uid || null,
        },
        { merge: true }
      );
      setDaySummarySessionUnlocked(clientId, false);
      setPassword("");
      setConfirm("");
      onMessage?.("Day Summary password saved. Summary will ask for it when opened.");
    } catch (reason) {
      onError?.(reason?.message || "Failed to save Day Summary password.");
    } finally {
      setSaving(false);
    }
  }

  async function clearPassword() {
    onError?.("");
    if (!clientId) {
      onError?.("Select an active shop first.");
      return;
    }
    if (hasPassword) {
      const ok = window.confirm(
        "Remove the Day Summary password? Anyone on this shop can view the summary without a password."
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      await setDoc(
        doc(db, "client_settings", clientId),
        {
          clientId,
          daySummaryPasswordHash: "",
          daySummaryPasswordUpdatedAt: serverTimestamp(),
          daySummaryPasswordUpdatedBy: user?.uid || null,
          updatedAt: serverTimestamp(),
          updatedBy: user?.uid || null,
        },
        { merge: true }
      );
      setPassword("");
      setConfirm("");
      onMessage?.("Day Summary password removed.");
    } catch (reason) {
      onError?.(reason?.message || "Failed to clear Day Summary password.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4 sm:p-5">
      <div className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-slate-950 text-slate-300">
          <Lock size={15} />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-white">
            Day Summary privacy
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            Optional password required to view Day Summary &amp; standing balances
            on the Daily List.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <form onSubmit={savePassword} className="space-y-3">
          <p className="text-xs text-slate-400">
            Status:{" "}
            <span className={hasPassword ? "text-amber-300" : "text-emerald-300"}>
              {hasPassword ? "Password protected" : "No password (open)"}
            </span>
          </p>

          <label className={LABEL_CLASS}>
            New password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={FIELD_CLASS}
              placeholder="At least 4 characters"
              autoComplete="new-password"
            />
          </label>
          <label className={LABEL_CLASS}>
            Confirm password
            <input
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className={FIELD_CLASS}
              placeholder="Repeat password"
              autoComplete="new-password"
            />
          </label>

          <div className="flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={saving} className={BTN_PRIMARY}>
              {saving ? "Saving…" : hasPassword ? "Change password" : "Set password"}
            </button>
            {hasPassword ? (
              <button
                type="button"
                disabled={saving}
                onClick={clearPassword}
                className={BTN_SECONDARY}
              >
                Remove password
              </button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
