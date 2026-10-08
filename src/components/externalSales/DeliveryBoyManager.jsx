import { useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import {
  createUserWithEmailAndPassword,
  getAuth,
  signOut,
} from "firebase/auth";
import { getApps, initializeApp } from "firebase/app";
import { Pencil, Plus, X } from "lucide-react";
import { db, firebaseConfig } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import { numMoney } from "../../utils/money.js";
import { resolveDeliveryBoyCommission } from "../../utils/externalSales.js";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_CLASS,
  FIELD_NUMBER_CLASS,
  LABEL_CLASS,
} from "./externalSalesUi.js";

const EMPTY = {
  name: "",
  isActive: true,
  commissionEnabled: false,
  commissionRate: "",
  assignedTerminalIds: [],
  loginEmail: "",
  loginPassword: "",
};

function getSecondaryAuth() {
  const name = "secondary-auth";
  const existing = getApps().find((app) => app.name === name);
  const secondaryApp = existing || initializeApp(firebaseConfig, name);
  return getAuth(secondaryApp);
}

export default function DeliveryBoyManager({
  clientId,
  deliveryBoys,
  terminals = [],
  loading,
  onMessage,
  onError,
}) {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");

  const activeTerminals = useMemo(
    () => (terminals || []).filter((row) => row.isActive !== false),
    [terminals]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return deliveryBoys;
    return deliveryBoys.filter((row) =>
      String(row.name || "")
        .toLowerCase()
        .includes(q)
    );
  }, [deliveryBoys, search]);

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY);
    setModalError("");
    setIsOpen(true);
  }

  function openEdit(row) {
    const commission = resolveDeliveryBoyCommission(row);
    setEditingId(row.id);
    setForm({
      name: row.name || "",
      isActive: row.isActive !== false,
      commissionEnabled: commission.enabled,
      commissionRate: commission.rate ? String(commission.rate) : "",
      assignedTerminalIds: Array.isArray(row.assignedTerminalIds)
        ? row.assignedTerminalIds.map(String)
        : [],
      loginEmail: "",
      loginPassword: "",
    });
    setModalError("");
    setIsOpen(true);
  }

  function closeModal() {
    setIsOpen(false);
    setSaving(false);
    setModalError("");
  }

  function toggleTerminal(terminalId) {
    setForm((current) => {
      const set = new Set(current.assignedTerminalIds || []);
      if (set.has(terminalId)) set.delete(terminalId);
      else set.add(terminalId);
      return { ...current, assignedTerminalIds: [...set] };
    });
  }

  async function handleSave(event) {
    event.preventDefault();
    setModalError("");
    if (!clientId) {
      setModalError("Select an active shop first.");
      return;
    }
    const name = String(form.name || "").trim();
    if (!name) {
      setModalError("Delivery boy name is required.");
      return;
    }
    const duplicate = deliveryBoys.some(
      (row) =>
        row.id !== editingId &&
        String(row.name || "")
          .trim()
          .toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      setModalError("A delivery boy with this name already exists.");
      return;
    }

    const commissionEnabled = Boolean(form.commissionEnabled);
    const rateNum = numMoney(form.commissionRate);
    if (commissionEnabled) {
      if (form.commissionRate === "" || form.commissionRate == null) {
        setModalError("Commission rate is required when commission is enabled.");
        return;
      }
      if (rateNum < 0) {
        setModalError("Commission rate cannot be negative.");
        return;
      }
      if (rateNum > 100) {
        setModalError("Commission rate cannot exceed 100%.");
        return;
      }
    }

    const assignedTerminalIds = (form.assignedTerminalIds || [])
      .map(String)
      .filter(Boolean);
    const loginEmail = String(form.loginEmail || "").trim().toLowerCase();
    const loginPassword = String(form.loginPassword || "");
    const creatingLogin = Boolean(loginEmail || loginPassword);
    if (creatingLogin) {
      if (!loginEmail || !loginPassword) {
        setModalError("Login email and password are both required.");
        return;
      }
      if (loginPassword.length < 6) {
        setModalError("Login password must be at least 6 characters.");
        return;
      }
      if (!assignedTerminalIds.length) {
        setModalError("Assign at least one terminal before creating a login.");
        return;
      }
    }

    setSaving(true);
    try {
      const payload = {
        clientId,
        name,
        isActive: Boolean(form.isActive),
        commissionEnabled,
        commissionRate: commissionEnabled ? rateNum : 0,
        assignedTerminalIds,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
        updatedBy: user?.uid || null,
      };

      let boyId = editingId;
      if (editingId) {
        await updateDoc(doc(db, "delivery_boys", editingId), payload);
        // Keep linked user terminal assignments in sync.
        if (deliveryBoys.find((row) => row.id === editingId)?.linkedUserId) {
          const linkedUserId = deliveryBoys.find(
            (row) => row.id === editingId
          ).linkedUserId;
          await updateDoc(doc(db, "users", linkedUserId), {
            assignedTerminalIds,
            name,
            isActive: Boolean(form.isActive),
            updatedAt: Date.now(),
            updatedBy: user?.uid || null,
          });
        }
        onMessage?.("Delivery boy updated.");
      } else {
        const created = await addDoc(collection(db, "delivery_boys"), {
          ...payload,
          createdAt: serverTimestamp(),
          createdAtMs: Date.now(),
          createdBy: user?.uid || null,
        });
        boyId = created.id;
        onMessage?.("Delivery boy created.");
      }

      if (creatingLogin && boyId) {
        const existing = deliveryBoys.find((row) => row.id === boyId);
        if (existing?.linkedUserId) {
          setModalError(
            "This delivery boy already has a login. Update terminals above; password resets are done in Super Admin."
          );
          setSaving(false);
          return;
        }

        const secondaryAuth = getSecondaryAuth();
        const cred = await createUserWithEmailAndPassword(
          secondaryAuth,
          loginEmail,
          loginPassword
        );
        const uid = cred.user.uid;
        await setDoc(doc(db, "users", uid), {
          uid,
          email: loginEmail,
          name,
          role: "delivery_boy",
          assignedShops: [clientId],
          deliveryBoyId: boyId,
          assignedTerminalIds,
          createdBy: user?.uid || null,
          createdAt: Date.now(),
          isActive: Boolean(form.isActive),
        });
        await updateDoc(doc(db, "delivery_boys", boyId), {
          linkedUserId: uid,
          linkedUserEmail: loginEmail,
          updatedAt: serverTimestamp(),
          updatedAtMs: Date.now(),
          updatedBy: user?.uid || null,
        });
        await signOut(secondaryAuth);
        onMessage?.(
          `Delivery boy saved. Login created for Delivery Entry: ${loginEmail}`
        );
      }

      closeModal();
    } catch (reason) {
      setModalError(reason?.message || "Failed to save delivery boy.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(row) {
    onError?.("");
    try {
      await updateDoc(doc(db, "delivery_boys", row.id), {
        isActive: row.isActive === false,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
        updatedBy: user?.uid || null,
      });
      if (row.linkedUserId) {
        await updateDoc(doc(db, "users", row.linkedUserId), {
          isActive: row.isActive === false,
          updatedAt: Date.now(),
          updatedBy: user?.uid || null,
        });
      }
      onMessage?.(
        row.isActive === false
          ? "Delivery boy activated."
          : "Delivery boy deactivated."
      );
    } catch (reason) {
      onError?.(reason?.message || "Failed to update delivery boy.");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Delivery Boys</h2>
          <p className="text-sm text-slate-400">
            Manage delivery staff, terminal assignments, and Delivery Entry
            logins. Commission is on delivery charge only.
          </p>
        </div>
        <button type="button" onClick={openAdd} className={BTN_PRIMARY}>
          <Plus size={16} />
          Add Delivery Boy
        </button>
      </div>

      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search delivery boys…"
        className={FIELD_CLASS}
      />

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-[720px] w-full text-left text-sm text-slate-300 sm:min-w-full">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Terminals</th>
                <th className="px-4 py-3">Login</th>
                <th className="px-4 py-3">Commission</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-slate-500"
                  >
                    Loading…
                  </td>
                </tr>
              ) : filtered.length ? (
                filtered.map((row) => {
                  const commission = resolveDeliveryBoyCommission(row);
                  const termIds = Array.isArray(row.assignedTerminalIds)
                    ? row.assignedTerminalIds
                    : [];
                  const termNames = termIds
                    .map(
                      (id) =>
                        terminals.find((t) => t.id === id)?.name || id.slice(0, 6)
                    )
                    .join(", ");
                  return (
                    <tr
                      key={row.id}
                      className="border-t border-slate-800/80 hover:bg-slate-950/40"
                    >
                      <td className="px-4 py-3 font-medium text-white">
                        {row.name}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">
                        {termNames || "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-400">
                        {row.linkedUserEmail || "—"}
                      </td>
                      <td className="px-4 py-3">
                        {commission.enabled ? (
                          <span className="text-emerald-300">
                            {commission.rate}%
                          </span>
                        ) : (
                          <span className="text-slate-500">Off</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                            row.isActive === false
                              ? "bg-slate-800 text-slate-400"
                              : "bg-emerald-950/60 text-emerald-300"
                          }`}
                        >
                          {row.isActive === false ? "Inactive" : "Active"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => openEdit(row)}
                            className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:border-blue-500 hover:text-blue-300"
                            aria-label="Edit delivery boy"
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleActive(row)}
                            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
                          >
                            {row.isActive === false ? "Activate" : "Deactivate"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-slate-500"
                  >
                    No delivery boys yet. Add staff used for delivery bills.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">
                {editingId ? "Edit Delivery Boy" : "Add Delivery Boy"}
              </h3>
              <button
                type="button"
                onClick={closeModal}
                className="rounded-lg border border-slate-700 p-2 text-slate-400 hover:text-white"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            {modalError ? (
              <div className="mb-3 rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
                {modalError}
              </div>
            ) : null}
            <form onSubmit={handleSave} className="space-y-4">
              <label className={LABEL_CLASS}>
                Name
                <input
                  required
                  autoFocus
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  className={FIELD_CLASS}
                  placeholder="e.g. Nasir"
                />
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      isActive: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-blue-600"
                />
                Active
              </label>

              <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <div className="text-sm font-semibold text-white">
                  Assigned terminals
                </div>
                <p className="text-xs text-slate-500">
                  Delivery Entry only allows these terminals. Enforced in
                  Firestore rules.
                </p>
                {activeTerminals.length ? (
                  activeTerminals.map((terminal) => (
                    <label
                      key={terminal.id}
                      className="flex items-center gap-2 text-sm text-slate-300"
                    >
                      <input
                        type="checkbox"
                        checked={form.assignedTerminalIds.includes(terminal.id)}
                        onChange={() => toggleTerminal(terminal.id)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-blue-600"
                      />
                      {terminal.name}
                    </label>
                  ))
                ) : (
                  <p className="text-xs text-amber-200">
                    No active terminals. Create terminals in Setup first.
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 space-y-3">
                <div className="text-sm font-semibold text-white">
                  Delivery Commission
                </div>
                <p className="text-xs text-slate-500">
                  Calculated on delivery charge only. Changing this rate does
                  not alter historical bills.
                </p>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={form.commissionEnabled}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        commissionEnabled: event.target.checked,
                      }))
                    }
                    className="h-4 w-4 rounded border-slate-600 bg-slate-950 text-blue-600"
                  />
                  Enable commission for this delivery boy
                </label>
                <label className={LABEL_CLASS}>
                  Commission Rate (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    disabled={!form.commissionEnabled}
                    value={form.commissionRate}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        commissionRate: event.target.value,
                      }))
                    }
                    className={FIELD_NUMBER_CLASS}
                    placeholder="e.g. 10"
                  />
                </label>
              </div>

              <div className="space-y-3 rounded-xl border border-sky-900/50 bg-sky-950/20 p-3">
                <div className="text-sm font-semibold text-sky-100">
                  Delivery Entry login
                </div>
                <p className="text-xs text-slate-400">
                  Creates a <b>delivery_boy</b> account for{" "}
                  <code className="text-sky-200">/delivery.html</code>. Leave
                  blank if not creating a login now.
                  {editingId &&
                  deliveryBoys.find((row) => row.id === editingId)
                    ?.linkedUserEmail
                    ? ` Current: ${
                        deliveryBoys.find((row) => row.id === editingId)
                          .linkedUserEmail
                      }`
                    : ""}
                </p>
                <label className={LABEL_CLASS}>
                  Email
                  <input
                    type="email"
                    autoComplete="off"
                    value={form.loginEmail}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        loginEmail: event.target.value,
                      }))
                    }
                    className={FIELD_CLASS}
                    placeholder="boy@example.com"
                    disabled={Boolean(
                      editingId &&
                        deliveryBoys.find((row) => row.id === editingId)
                          ?.linkedUserId
                    )}
                  />
                </label>
                <label className={LABEL_CLASS}>
                  Password
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={form.loginPassword}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        loginPassword: event.target.value,
                      }))
                    }
                    className={FIELD_CLASS}
                    placeholder="Min 6 characters"
                    disabled={Boolean(
                      editingId &&
                        deliveryBoys.find((row) => row.id === editingId)
                          ?.linkedUserId
                    )}
                  />
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className={BTN_SECONDARY}
                >
                  Cancel
                </button>
                <button type="submit" disabled={saving} className={BTN_PRIMARY}>
                  {saving ? "Saving…" : editingId ? "Update" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
