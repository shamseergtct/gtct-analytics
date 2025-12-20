// src/pages/Parties.jsx
import { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  updateDoc,
  where,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";

const PARTY_TYPES = ["Customer", "Supplier", "Both"];

export default function Parties() {
  const { activeClientId, activeClientData } = useClient();

  const [loading, setLoading] = useState(true);
  const [parties, setParties] = useState([]);
  const [pageError, setPageError] = useState("");

  const [search, setSearch] = useState("");

  // modal
  const [isOpen, setIsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [modalError, setModalError] = useState("");

  // delete
  const [deletingId, setDeletingId] = useState(null);

  // form
  const [name, setName] = useState("");
  const [type, setType] = useState("Customer");
  const [contact, setContact] = useState("");
  const [taxNumber, setTaxNumber] = useState("");

  async function fetchParties() {
    if (!activeClientId) {
      setLoading(false);
      setParties([]);
      setPageError("");
      return;
    }

    setLoading(true);
    setPageError("");

    try {
      const ref = collection(db, "parties");

      // ✅ IMPORTANT: Match your enabled index:
      // parties: clientId ASC + name ASC
      const qy = query(
        ref,
        where("clientId", "==", activeClientId),
        orderBy("name", "asc")
      );

      const snap = await getDocs(qy);
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      setParties(rows);
    } catch (e) {
      console.error("❌ Fetch parties error:", e);
      setPageError(e?.message || "Failed to load parties");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchParties();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeClientId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return parties;

    return parties.filter((p) => {
      const s = `${p.name || ""} ${p.type || ""} ${p.contact || ""} ${p.taxNumber || ""}`.toLowerCase();
      return s.includes(q);
    });
  }, [parties, search]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setType("Customer");
    setContact("");
    setTaxNumber("");
    setModalError("");
  }

  function openAdd() {
    resetForm();
    setIsOpen(true);
  }

  function openEdit(party) {
    setEditingId(party.id);
    setName(party.name || "");
    setType(party.type || "Customer");
    setContact(party.contact || "");
    setTaxNumber(party.taxNumber || "");
    setModalError("");
    setIsOpen(true);
  }

  function closeModal() {
    setIsOpen(false);
    setSaving(false);
    setModalError("");
  }

  async function handleSave(e) {
    e.preventDefault();
    setModalError("");

    if (!activeClientId) {
      setModalError("Please select a client first.");
      return;
    }
    if (!name.trim()) {
      setModalError("Party name is required.");
      return;
    }
    if (!PARTY_TYPES.includes(type)) {
      setModalError("Invalid party type.");
      return;
    }

    setSaving(true);

    const payload = {
      clientId: activeClientId,
      name: name.trim(),
      type,
      contact: contact.trim(),
      taxNumber: taxNumber.trim() || "",
      updatedAt: serverTimestamp(),
    };

    try {
      if (editingId) {
        await updateDoc(doc(db, "parties", editingId), payload);
      } else {
        await addDoc(collection(db, "parties"), {
          ...payload,
          createdAt: serverTimestamp(),
        });
      }

      await fetchParties();
      closeModal();
    } catch (e2) {
      console.error("❌ Save party error:", e2);
      setModalError(e2?.message || "Failed to save party");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(party) {
    if (!party?.id) return;

    const ok = window.confirm(`Delete party "${party.name}"?`);
    if (!ok) return;

    setDeletingId(party.id);
    setPageError("");

    try {
      await deleteDoc(doc(db, "parties", party.id));
      await fetchParties();
    } catch (e) {
      console.error("❌ Delete party error:", e);
      setPageError(e?.message || "Failed to delete party");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Parties</h1>
          <p className="text-sm text-slate-400">
            Manage Customers & Suppliers (Active Client:{" "}
            <span className="text-slate-200 font-semibold">
              {activeClientData?.name || "No client selected"}
            </span>
            )
          </p>
        </div>

        <div className="flex gap-2 w-full md:w-auto">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search parties…"
            className="w-full md:w-72 rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-600"
          />
          <button
            onClick={openAdd}
            disabled={!activeClientId}
            className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-medium disabled:opacity-60"
          >
            + Add
          </button>
        </div>
      </div>

      {!activeClientId ? (
        <div className="rounded-xl border border-amber-700/40 bg-amber-900/20 p-3 text-amber-200 text-sm">
          Please select an active client to manage parties.
        </div>
      ) : null}

      {pageError ? (
        <div className="rounded-lg border border-red-800 bg-red-950/40 text-red-200 px-3 py-2">
          {pageError}
        </div>
      ) : null}

      {/* List */}
      <div className="rounded-xl border border-slate-800 bg-slate-950/50 overflow-hidden">
        <div className="grid grid-cols-12 gap-2 px-4 py-3 text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
          <div className="col-span-5">Name</div>
          <div className="col-span-3">Type</div>
          <div className="col-span-3">Contact</div>
          <div className="col-span-1 text-right">Actions</div>
        </div>

        {loading ? (
          <div className="px-4 py-6 text-slate-300">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-6 text-slate-400">No parties found.</div>
        ) : (
          filtered.map((p) => (
            <div
              key={p.id}
              className="grid grid-cols-12 gap-2 px-4 py-3 border-b border-slate-900 hover:bg-slate-900/40"
            >
              <div className="col-span-5 text-slate-100 font-medium">{p.name}</div>
              <div className="col-span-3 text-slate-300">{p.type}</div>
              <div className="col-span-3 text-slate-300">{p.contact || "-"}</div>

              <div className="col-span-1 flex justify-end gap-2">
                <button
                  onClick={() => openEdit(p)}
                  className="text-blue-400 hover:text-blue-300 text-sm"
                >
                  Edit
                </button>

                <button
                  onClick={() => handleDelete(p)}
                  disabled={deletingId === p.id}
                  className="text-red-400 hover:text-red-300 text-sm disabled:opacity-60"
                >
                  {deletingId === p.id ? "…" : "Del"}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal */}
      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={closeModal} />

          <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 shadow-xl">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <div className="text-slate-100 font-semibold">
                {editingId ? "Edit Party" : "Add Party"}
              </div>
              <button onClick={closeModal} className="text-slate-400 hover:text-slate-200">
                ✕
              </button>
            </div>

            <form onSubmit={handleSave} className="px-5 py-4 space-y-4">
              <div>
                <label className="text-sm text-slate-300">Name *</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600"
                  placeholder="Party name"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-slate-300">Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600"
                  >
                    {PARTY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-sm text-slate-300">Contact</label>
                  <input
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600"
                    placeholder="Phone / WhatsApp"
                  />
                </div>
              </div>

              <div>
                <label className="text-sm text-slate-300">Tax Number (optional)</label>
                <input
                  value={taxNumber}
                  onChange={(e) => setTaxNumber(e.target.value)}
                  className="mt-1 w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600"
                  placeholder="VAT / GST number"
                />
              </div>

              {modalError ? (
                <div className="rounded-lg border border-red-800 bg-red-950/40 text-red-200 px-3 py-2 text-sm">
                  {modalError}
                </div>
              ) : null}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-lg border border-slate-700 bg-slate-900 text-slate-200 px-4 py-2 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-medium disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
