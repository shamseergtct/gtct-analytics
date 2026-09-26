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

function nowYear() {
  return new Date().getFullYear();
}

function makeDefaultClientSettings(currency = "AED") {
  return {
    currency: String(currency || "AED").trim().toUpperCase(),

    // ✅ Warehouses (editable list per client)
    warehouses: [{ id: "main", name: "Main Warehouse" }],

    // ✅ Invoice settings (per client, reset yearly)
    invoice: {
      prefix: "INV-",
      suffix: "",
      padding: 4,
      resetYearly: true,
      year: nowYear(),
      nextNumber: 1,
    },

    // ✅ Defaults for invoice (later used in Sales/Invoice page)
    tax: {
      enabled: false,
      type: "percent", // percent | fixed
      rate: 0, // percent value
      amount: 0, // fixed amount
    },
    discount: {
      enabled: false,
      type: "percent", // percent | fixed
      rate: 0,
      amount: 0,
    },
  };
}

function slugId(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
}

export default function Clients() {
  const nav = useNavigate();
  const { clients, loadingClients, activeClientId, setActiveClient } = useClient();

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // ✅ edit mode
  const [editingClient, setEditingClient] = useState(null);

  const initialForm = {
    name: "",
    location: "",
    contact_number: "",
    ...makeDefaultClientSettings("AED"),
  };

  const [form, setForm] = useState(initialForm);

  // temp input for warehouses
  const [newWarehouseName, setNewWarehouseName] = useState("");

  const sorted = useMemo(() => {
    return [...clients].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [clients]);

  // ✅ reset modal state when closed
  useEffect(() => {
    if (!open) {
      setEditingClient(null);
      setForm(initialForm);
      setNewWarehouseName("");
      setError("");
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const openClientTransactions = (client) => {
    setActiveClient(client.id, client);
    nav("/transactions");
  };

  function openAddModal() {
    setEditingClient(null);
    setForm(initialForm);
    setOpen(true);
  }

  function openEditModal(c) {
    // ✅ merge defaults safely (for older clients without these settings)
    const defaults = makeDefaultClientSettings(c.currency || "AED");
    const merged = {
      name: c.name || "",
      location: c.location || "",
      contact_number: c.contact_number || "",
      currency: (c.currency || defaults.currency || "AED").toUpperCase(),
      warehouses: Array.isArray(c.warehouses) && c.warehouses.length ? c.warehouses : defaults.warehouses,
      invoice: { ...defaults.invoice, ...(c.invoice || {}) },
      tax: { ...defaults.tax, ...(c.tax || {}) },
      discount: { ...defaults.discount, ...(c.discount || {}) },
    };

    // ✅ ensure invoice year is present
    if (!merged.invoice.year) merged.invoice.year = nowYear();
    if (!merged.invoice.nextNumber) merged.invoice.nextNumber = 1;
    if (!merged.invoice.padding) merged.invoice.padding = 4;

    setEditingClient(c);
    setForm(merged);
    setOpen(true);
  }

  async function onSave(e) {
    e.preventDefault();
    setError("");

    if (!form.name.trim()) {
      setError("Client name is required.");
      return;
    }

    // ✅ normalize warehouses
    const wh = Array.isArray(form.warehouses) ? form.warehouses : [];
    const cleanedWarehouses = wh
      .map((w) => ({
        id: String(w?.id || slugId(w?.name) || "wh").trim() || "wh",
        name: String(w?.name || "").trim(),
      }))
      .filter((w) => w.name);

    const payload = {
      name: form.name.trim(),
      location: String(form.location || "").trim(),
      currency: String(form.currency || "AED").trim().toUpperCase(),
      contact_number: String(form.contact_number || "").trim(),

      warehouses: cleanedWarehouses.length ? cleanedWarehouses : [{ id: "main", name: "Main Warehouse" }],

      invoice: {
        prefix: String(form.invoice?.prefix || "INV-"),
        suffix: String(form.invoice?.suffix || ""),
        padding: Number(form.invoice?.padding ?? 4) || 4,
        resetYearly: !!form.invoice?.resetYearly,
        year: Number(form.invoice?.year ?? nowYear()) || nowYear(),
        nextNumber: Number(form.invoice?.nextNumber ?? 1) || 1,
      },

      tax: {
        enabled: !!form.tax?.enabled,
        type: form.tax?.type === "fixed" ? "fixed" : "percent",
        rate: Number(form.tax?.rate ?? 0) || 0,
        amount: Number(form.tax?.amount ?? 0) || 0,
      },

      discount: {
        enabled: !!form.discount?.enabled,
        type: form.discount?.type === "fixed" ? "fixed" : "percent",
        rate: Number(form.discount?.rate ?? 0) || 0,
        amount: Number(form.discount?.amount ?? 0) || 0,
      },
    };

    setSaving(true);
    try {
      if (editingClient?.id) {
        await updateDoc(doc(db, "clients", editingClient.id), {
          ...payload,
          updatedAt: serverTimestamp(),
        });

        // refresh active client if editing active
        if (editingClient.id === activeClientId) {
          setActiveClient(editingClient.id, { ...editingClient, ...payload });
        }
      } else {
        await addDoc(collection(db, "clients"), {
          ...payload,
          createdAt: serverTimestamp(),
        });
      }

      setOpen(false);
    } catch (err) {
      console.error(err);
      setError(err?.message || "Failed to save client.");
    } finally {
      setSaving(false);
    }
  }

  const handleDelete = async (e, c) => {
    e.stopPropagation();

    const ok = window.confirm(`Delete client "${c.name}"? This cannot be undone.`);
    if (!ok) return;

    try {
      await deleteDoc(doc(db, "clients", c.id));

      if (c.id === activeClientId) {
        localStorage.removeItem("gtct_active_client_id");
        setActiveClient("", null);
      }
    } catch (err) {
      console.error(err);
      alert(err?.message || "Failed to delete client");
    }
  };

  function addWarehouse() {
    const name = String(newWarehouseName || "").trim();
    if (!name) return;

    const id = slugId(name) || `wh_${Date.now()}`;
    const existing = Array.isArray(form.warehouses) ? form.warehouses : [];

    // avoid duplicates by id
    if (existing.some((w) => String(w.id) === id)) {
      setError("Warehouse already exists (same name).");
      return;
    }

    setForm((p) => ({
      ...p,
      warehouses: [...existing, { id, name }],
    }));
    setNewWarehouseName("");
  }

  function removeWarehouse(id) {
    const existing = Array.isArray(form.warehouses) ? form.warehouses : [];
    const next = existing.filter((w) => String(w.id) !== String(id));
    setForm((p) => ({
      ...p,
      warehouses: next.length ? next : [{ id: "main", name: "Main Warehouse" }],
    }));
  }

  const previewInv = useMemo(() => {
    const prefix = String(form.invoice?.prefix || "INV-");
    const suffix = String(form.invoice?.suffix || "");
    const padding = Number(form.invoice?.padding ?? 4) || 4;
    const nextNumber = Number(form.invoice?.nextNumber ?? 1) || 1;
    const numStr = String(nextNumber).padStart(padding, "0");
    return `${prefix}${numStr}${suffix}`;
  }, [form.invoice]);

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
          onClick={openAddModal}
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
                          Currency: {c.currency || "AED"} • Warehouses:{" "}
                          {Array.isArray(c.warehouses) ? c.warehouses.length : 0}
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
                            Open
                          </button>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openEditModal(c);
                            }}
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
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />

          <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-950 p-5 shadow-xl max-h-[85vh] overflow-auto">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white">
                  {editingClient ? "Edit Client" : "Add Client"}
                </h3>
                <p className="text-sm text-slate-400">
                  Client profile + warehouses + invoice settings.
                </p>
              </div>

              <button
                onClick={() => setOpen(false)}
                className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                Close
              </button>
            </div>

            <form className="mt-4 space-y-4" onSubmit={onSave}>
              {/* Basic */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              </div>

              {/* Warehouses */}
              <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-white font-semibold">Warehouses (per client)</div>
                  <div className="text-xs text-slate-400">
                    Used in Inventory + Invoices
                  </div>
                </div>

                <div className="mt-3 flex gap-2 flex-wrap">
                  {(Array.isArray(form.warehouses) ? form.warehouses : []).map((w) => (
                    <span
                      key={w.id}
                      className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-sm text-slate-200"
                    >
                      {w.name}
                      <button
                        type="button"
                        onClick={() => removeWarehouse(w.id)}
                        className="text-slate-400 hover:text-slate-200"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>

                <div className="mt-3 flex gap-2">
                  <input
                    value={newWarehouseName}
                    onChange={(e) => setNewWarehouseName(e.target.value)}
                    className="w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none focus:ring-2 focus:ring-slate-500"
                    placeholder="Add warehouse name (e.g., Branch 2 Store)"
                  />
                  <button
                    type="button"
                    onClick={addWarehouse}
                    className="rounded-xl border border-slate-800 bg-slate-900 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Invoice Settings */}
              <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="text-white font-semibold">Invoice Number Settings</div>
                  <div className="text-xs text-slate-400">Preview: {previewInv}</div>
                </div>

                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-sm text-slate-300">Prefix</label>
                    <input
                      value={form.invoice?.prefix || ""}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          invoice: { ...(p.invoice || {}), prefix: e.target.value },
                        }))
                      }
                      className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none"
                      placeholder="INV-"
                    />
                  </div>

                  <div>
                    <label className="text-sm text-slate-300">Suffix</label>
                    <input
                      value={form.invoice?.suffix || ""}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          invoice: { ...(p.invoice || {}), suffix: e.target.value },
                        }))
                      }
                      className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none"
                      placeholder=""
                    />
                  </div>

                  <div>
                    <label className="text-sm text-slate-300">Padding (0001)</label>
                    <input
                      type="number"
                      min="1"
                      value={form.invoice?.padding ?? 4}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          invoice: { ...(p.invoice || {}), padding: Number(e.target.value) },
                        }))
                      }
                      className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-sm text-slate-300">Next Number</label>
                    <input
                      type="number"
                      min="1"
                      value={form.invoice?.nextNumber ?? 1}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          invoice: { ...(p.invoice || {}), nextNumber: Number(e.target.value) },
                        }))
                      }
                      className="mt-1 w-full rounded-xl bg-slate-950 border border-slate-800 px-3 py-2 text-slate-100 outline-none"
                    />
                  </div>

                  <div className="sm:col-span-2 flex items-center justify-between gap-3 flex-wrap pt-1">
                    <label className="flex items-center gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={!!form.invoice?.resetYearly}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            invoice: { ...(p.invoice || {}), resetYearly: e.target.checked },
                          }))
                        }
                      />
                      Reset yearly (per year sequence)
                    </label>

                    <div className="text-xs text-slate-400">
                      Current Year:{" "}
                      <input
                        type="number"
                        value={form.invoice?.year ?? nowYear()}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            invoice: { ...(p.invoice || {}), year: Number(e.target.value) },
                          }))
                        }
                        className="ml-2 w-24 rounded-lg bg-slate-950 border border-slate-800 px-2 py-1 text-slate-100 outline-none"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Tax & Discount Defaults */}
              <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
                <div className="text-white font-semibold">Tax & Discount (Defaults)</div>

                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* TAX */}
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                    <label className="flex items-center gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={!!form.tax?.enabled}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            tax: { ...(p.tax || {}), enabled: e.target.checked },
                          }))
                        }
                      />
                      Enable Tax
                    </label>

                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <select
                        value={form.tax?.type || "percent"}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            tax: { ...(p.tax || {}), type: e.target.value },
                          }))
                        }
                        className="rounded-lg bg-slate-900 border border-slate-800 px-2 py-2 text-slate-100"
                      >
                        <option value="percent">Percent</option>
                        <option value="fixed">Fixed</option>
                      </select>

                      {form.tax?.type === "fixed" ? (
                        <input
                          type="number"
                          value={form.tax?.amount ?? 0}
                          onChange={(e) =>
                            setForm((p) => ({
                              ...p,
                              tax: { ...(p.tax || {}), amount: Number(e.target.value) },
                            }))
                          }
                          className="rounded-lg bg-slate-900 border border-slate-800 px-2 py-2 text-slate-100"
                          placeholder="Amount"
                        />
                      ) : (
                        <input
                          type="number"
                          value={form.tax?.rate ?? 0}
                          onChange={(e) =>
                            setForm((p) => ({
                              ...p,
                              tax: { ...(p.tax || {}), rate: Number(e.target.value) },
                            }))
                          }
                          className="rounded-lg bg-slate-900 border border-slate-800 px-2 py-2 text-slate-100"
                          placeholder="%"
                        />
                      )}
                    </div>
                  </div>

                  {/* DISCOUNT */}
                  <div className="rounded-xl border border-slate-800 bg-slate-950 p-3">
                    <label className="flex items-center gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={!!form.discount?.enabled}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            discount: { ...(p.discount || {}), enabled: e.target.checked },
                          }))
                        }
                      />
                      Enable Discount
                    </label>

                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <select
                        value={form.discount?.type || "percent"}
                        onChange={(e) =>
                          setForm((p) => ({
                            ...p,
                            discount: { ...(p.discount || {}), type: e.target.value },
                          }))
                        }
                        className="rounded-lg bg-slate-900 border border-slate-800 px-2 py-2 text-slate-100"
                      >
                        <option value="percent">Percent</option>
                        <option value="fixed">Fixed</option>
                      </select>

                      {form.discount?.type === "fixed" ? (
                        <input
                          type="number"
                          value={form.discount?.amount ?? 0}
                          onChange={(e) =>
                            setForm((p) => ({
                              ...p,
                              discount: { ...(p.discount || {}), amount: Number(e.target.value) },
                            }))
                          }
                          className="rounded-lg bg-slate-900 border border-slate-800 px-2 py-2 text-slate-100"
                          placeholder="Amount"
                        />
                      ) : (
                        <input
                          type="number"
                          value={form.discount?.rate ?? 0}
                          onChange={(e) =>
                            setForm((p) => ({
                              ...p,
                              discount: { ...(p.discount || {}), rate: Number(e.target.value) },
                            }))
                          }
                          className="rounded-lg bg-slate-900 border border-slate-800 px-2 py-2 text-slate-100"
                          placeholder="%"
                        />
                      )}
                    </div>
                  </div>
                </div>
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
                  {saving ? "Saving…" : editingClient ? "Save Changes" : "Save Client"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
