import { useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { Pencil, Plus, X } from "lucide-react";
import { db } from "../../firebase";
import { useAuth } from "../../context/AuthContext";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  FIELD_CLASS,
  LABEL_CLASS,
} from "./externalSalesUi.js";

const EMPTY = { name: "", isActive: true };

export default function TerminalManager({
  clientId,
  terminals,
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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return terminals;
    return terminals.filter((row) =>
      String(row.name || "")
        .toLowerCase()
        .includes(q)
    );
  }, [terminals, search]);

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY);
    setModalError("");
    setIsOpen(true);
  }

  function openEdit(row) {
    setEditingId(row.id);
    setForm({
      name: row.name || "",
      isActive: row.isActive !== false,
    });
    setModalError("");
    setIsOpen(true);
  }

  function closeModal() {
    setIsOpen(false);
    setSaving(false);
    setModalError("");
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
      setModalError("Terminal name is required.");
      return;
    }
    const duplicate = terminals.some(
      (row) =>
        row.id !== editingId &&
        String(row.name || "")
          .trim()
          .toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      setModalError("A terminal with this name already exists.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        clientId,
        name,
        isActive: Boolean(form.isActive),
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
        updatedBy: user?.uid || null,
      };
      if (editingId) {
        await updateDoc(doc(db, "billing_terminals", editingId), payload);
        onMessage?.("Terminal updated.");
      } else {
        await addDoc(collection(db, "billing_terminals"), {
          ...payload,
          createdAt: serverTimestamp(),
          createdAtMs: Date.now(),
          createdBy: user?.uid || null,
        });
        onMessage?.("Terminal created.");
      }
      closeModal();
    } catch (reason) {
      setModalError(reason?.message || "Failed to save terminal.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(row) {
    onError?.("");
    try {
      await updateDoc(doc(db, "billing_terminals", row.id), {
        isActive: row.isActive === false,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
        updatedBy: user?.uid || null,
      });
      onMessage?.(
        row.isActive === false ? "Terminal activated." : "Terminal deactivated."
      );
    } catch (reason) {
      onError?.(reason?.message || "Failed to update terminal.");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Billing Terminals</h2>
          <p className="text-sm text-slate-400">
            Configure POS counters used on external sales bills. Deactivate
            instead of deleting.
          </p>
        </div>
        <button type="button" onClick={openAdd} className={BTN_PRIMARY}>
          <Plus size={16} />
          Add Terminal
        </button>
      </div>

      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search terminals…"
        className={FIELD_CLASS}
      />

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <table className="min-w-full text-left text-sm text-slate-300">
          <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            ) : filtered.length ? (
              filtered.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-slate-800/80 hover:bg-slate-950/40"
                >
                  <td className="px-4 py-3 font-medium text-white">
                    {row.name}
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
                        aria-label="Edit terminal"
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
              ))
            ) : (
              <tr>
                <td colSpan={3} className="px-4 py-8 text-center text-slate-500">
                  No billing terminals yet. Add Main POS, Counter 1, etc.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">
                {editingId ? "Edit Terminal" : "Add Terminal"}
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
                Terminal Name
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
                  placeholder="e.g. Main POS"
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
