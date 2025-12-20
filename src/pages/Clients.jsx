import { useMemo, useState, useEffect } from "react";
import {
  addDoc,
  collection,
  serverTimestamp,
  deleteDoc,
  doc,
  updateDoc,
} from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext";

export default function Clients() {
  const nav = useNavigate();
  const { clients, loadingClients, activeClientId, setActiveClient } = useClient();

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const initialForm = {
    name: "",
    location: "",
    currency: "AED",
    contact_number: "",
  };

  // ✅ IMPORTANT: form state (you missed this)
  const [form, setForm] = useState(initialForm);

  // ✅ Sort (optional)
  const sorted = useMemo(() => {
    return [...clients].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [clients]);

  // ✅ Guaranteed form clear when modal closes
  useEffect(() => {
    if (!open) {
      setForm(initialForm);
      setError("");
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ✅ Select client and redirect to Transactions
  const openClientTransactions = (client) => {
    setActiveClient(client.id, client); // (id, data) if your context supports it
    nav("/transactions");
  };

  const onAdd = async (e) => {
    e.preventDefault();
    setError("");

    if (!form.name.trim()) {
      setError("Client name is required.");
      return;
    }

    setSaving(true);
    try {
      await addDoc(collection(db, "clients"), {
        name: form.name.trim(),
        location: form.location.trim(),
        currency: (form.currency || "AED").trim().toUpperCase(),
        contact_number: form.contact_number.trim(),
        createdAt: serverTimestamp(),
      });

      // ✅ Close modal — useEffect will auto clear form
      setOpen(false);
    } catch (err) {
      console.error(err);
      setError(err?.message || "Failed to add client.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (e, c) => {
    e.stopPropagation();

    const ok = window.confirm(`Delete client "${c.name}"? This cannot be undone.`);
    if (!ok) return;

    try {
      await deleteDoc(doc(db, "clients", c.id));

      // If deleted client was active, clear selection
      if (c.id === activeClientId) {
        localStorage.removeItem("gtct_active_client_id");
        setActiveClient("", null);
      }
    } catch (err) {
      console.error(err);
      alert(err?.message || "Failed to delete client");
    }
  };

  const handleEdit = async (e, c) => {
    e.stopPropagation();

    const name = prompt("Client name:", c.name ?? "");
    if (name === null) return;

    const location = prompt("Location:", c.location ?? "");
    if (location === null) return;

    const currency = prompt("Currency:", c.currency ?? "AED");
    if (currency === null) return;

    const contact_number = prompt("Contact number:", c.contact_number ?? "");
    if (contact_number === null) return;

    try {
      await updateDoc(doc(db, "clients", c.id), {
        name: name.trim(),
        location: location.trim(),
        currency: currency.trim().toUpperCase(),
        contact_number: contact_number.trim(),
      });

      // If edited client is active, refresh active data in context (optional)
      if (c.id === activeClientId) {
        setActiveClient(c.id, {
          ...c,
          name: name.trim(),
          location: location.trim(),
          currency: currency.trim().toUpperCase(),
          contact_number: contact_number.trim(),
        });
      }
    } catch (err) {
      console.error(err);
      alert(err?.message || "Failed to update client");
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">Clients</h2>
          <p className="text-sm text-slate-400">
            Add clients and choose the active client for bookkeeping.
          </p>
        </div>

        <button
          onClick={() => setOpen(true)}
          className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:opacity-90"
        >
          + Add Client
        </button>
      </div>

      {/* Card */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        {loadingClients ? (
          <div className="text-slate-300">Loading clients…</div>
        ) : sorted.length === 0 ? (
          <div className="text-slate-300">
            No clients yet. Click <span className="font-semibold">Add Client</span>.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-slate-300">
                <tr className="border-b border-slate-800">
                  <th className="py-3 pr-4">Name</th>
                  <th className="py-3 pr-4">Location</th>
                  <th className="py-3 pr-4">Contact</th>
                  <th className="py-3 pr-2 text-right">Status / Actions</th>
                </tr>
              </thead>

              <tbody>
                {sorted.map((c) => {
                  const isActive = c.id === activeClientId;

                  return (
                    <tr
                      key={c.id}
                      className={[
                        "border-b border-slate-800/60 cursor-pointer",
                        isActive ? "bg-slate-800/40" : "hover:bg-slate-800/20",
                      ].join(" ")}
                      onClick={() => openClientTransactions(c)}
                      title="Click to open Transactions for this client"
                    >
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-white">{c.name}</span>
                          {isActive ? (
                            <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-200 border border-emerald-500/30">
                              Active
                            </span>
                          ) : null}
                        </div>
                        <div className="text-xs text-slate-400">
                          Currency: {c.currency || "AED"}
                        </div>
                      </td>

                      <td className="py-3 pr-4 text-slate-200">
                        {c.location || <span className="text-slate-500">—</span>}
                      </td>

                      <td className="py-3 pr-4 text-slate-200">
                        {c.contact_number || <span className="text-slate-500">—</span>}
                      </td>

                      <td className="py-3 pr-2 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openClientTransactions(c);
                            }}
                            className="text-xs text-sky-300 hover:text-sky-200 underline underline-offset-4"
                          >
                            Click to open
                          </button>

                          <button
                            type="button"
                            onClick={(e) => handleEdit(e, c)}
                            className="text-xs rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-1.5 text-slate-200 hover:bg-slate-800/40"
                          >
                            Edit
                          </button>

                          <button
                            type="button"
                            onClick={(e) => handleDelete(e, c)}
                            className="text-xs rounded-lg border border-red-900 bg-red-950/30 px-3 py-1.5 text-red-200 hover:bg-red-950/50"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal */}
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
          />

          <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white">Add Client</h3>
                <p className="text-sm text-slate-400">
                  Create a new shop/client in Firestore.
                </p>
              </div>

              <button
                onClick={() => setOpen(false)}
                className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                Close
              </button>
            </div>

            <form className="mt-4 space-y-3" onSubmit={onAdd}>
              <div>
                <label className="text-sm text-slate-300">Client Name *</label>
                <input
                  className="mt-1 w-full rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Al Baraka"
                  required
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-slate-300">Location</label>
                  <input
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                    value={form.location}
                    onChange={(e) => setForm({ ...form, location: e.target.value })}
                    placeholder="Bahrain / Kerala"
                  />
                </div>

                <div>
                  <label className="text-sm text-slate-300">Currency</label>
                  <input
                    className="mt-1 w-full rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                    value={form.currency}
                    onChange={(e) => setForm({ ...form, currency: e.target.value })}
                    placeholder="AED"
                  />
                </div>
              </div>

              <div>
                <label className="text-sm text-slate-300">Contact Number</label>
                <input
                  className="mt-1 w-full rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                  value={form.contact_number}
                  onChange={(e) =>
                    setForm({ ...form, contact_number: e.target.value })
                  }
                  placeholder="+973 XXXXXXXX"
                />
              </div>

              {error ? (
                <div className="rounded-xl border border-red-900 bg-red-950/40 p-2 text-sm text-red-200">
                  {error}
                </div>
              ) : null}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
                >
                  Cancel
                </button>

                <button
                  disabled={saving}
                  className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:opacity-90 disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save Client"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
