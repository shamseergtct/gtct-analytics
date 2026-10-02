// src/pages/Parties.jsx
import { useEffect, useMemo, useRef, useState } from "react";
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
  writeBatch,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";
import {
  PARTY_BULK_TYPES,
  downloadPartyImportTemplate,
  exportPartiesCsv,
  parsePartiesCsv,
} from "../utils/partyBulk.js";
import { getPartyCode, nextPartyCode } from "../utils/partyCode.js";
import ModuleHelpButton from "../components/ModuleHelpButton.jsx";

const PARTY_TYPES = PARTY_BULK_TYPES;
const FIRESTORE_BATCH_LIMIT = 450;
const FIELD_CLASS =
  "mt-1 h-10 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm leading-normal text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-600";

export default function Parties() {
  const { activeClientId, activeClientData } = useClient();

  const [loading, setLoading] = useState(true);
  const [parties, setParties] = useState([]);
  const [pageError, setPageError] = useState("");
  const [pageNotice, setPageNotice] = useState("");

  const [search, setSearch] = useState("");

  // modal
  const [isOpen, setIsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [modalError, setModalError] = useState("");

  // bulk import
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importPreview, setImportPreview] = useState(null);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const fileInputRef = useRef(null);

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
      const s = `${getPartyCode(p)} ${p.name || ""} ${p.type || ""} ${p.contact || ""} ${p.phone || ""} ${p.taxNumber || ""}`.toLowerCase();
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
      phone: contact.trim(),
      taxNumber: taxNumber.trim() || "",
      updatedAt: serverTimestamp(),
    };

    try {
      if (editingId) {
        const existing = parties.find((p) => p.id === editingId);
        if (!getPartyCode(existing) && (type === "Customer" || type === "Both")) {
          payload.partyCode = nextPartyCode(parties, "C");
        }
        await updateDoc(doc(db, "parties", editingId), payload);
      } else {
        if (type === "Customer" || type === "Both") {
          payload.partyCode = nextPartyCode(parties, "C");
        }
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

  function handleExport() {
    if (!activeClientId) {
      setPageError("Please select a client first.");
      return;
    }
    setPageError("");
    exportPartiesCsv({
      parties,
      shopName: activeClientData?.name || "shop",
    });
    setPageNotice(
      `Exported ${parties.length} part${parties.length === 1 ? "y" : "ies"} for ${
        activeClientData?.name || "this shop"
      }.`
    );
  }

  function openImport() {
    setImportError("");
    setImportPreview(null);
    setSkipDuplicates(true);
    setImportOpen(true);
  }

  function closeImport() {
    setImportOpen(false);
    setImporting(false);
    setImportError("");
    setImportPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onImportFileChange(e) {
    const file = e.target.files?.[0];
    setImportError("");
    setImportPreview(null);
    if (!file) return;

    try {
      const text = await file.text();
      const { rows, errors } = parsePartiesCsv(text);
      if (rows.length === 0 && errors.length === 0) {
        setImportError("No party rows found in the file.");
        return;
      }
      setImportPreview({ rows, errors, fileName: file.name });
    } catch (err) {
      console.error("❌ Read party CSV error:", err);
      setImportError(err?.message || "Failed to read CSV file.");
    }
  }

  async function handleImportConfirm() {
    if (!activeClientId) {
      setImportError("Please select a client first.");
      return;
    }
    const rows = importPreview?.rows || [];
    if (rows.length === 0) {
      setImportError("Nothing to import.");
      return;
    }

    setImporting(true);
    setImportError("");
    setPageError("");
    setPageNotice("");

    try {
      const existingKeys = new Set(
        parties.map(
          (p) => `${String(p.name || "").trim().toLowerCase()}|${String(p.type || "").trim().toLowerCase()}`
        )
      );

      let created = 0;
      let skipped = 0;
      let batch = writeBatch(db);
      let opsInBatch = 0;

      async function flushBatch() {
        if (opsInBatch === 0) return;
        await batch.commit();
        batch = writeBatch(db);
        opsInBatch = 0;
      }

      for (const row of rows) {
        const key = `${row.name.toLowerCase()}|${row.type.toLowerCase()}`;
        if (skipDuplicates && existingKeys.has(key)) {
          skipped += 1;
          continue;
        }

        const ref = doc(collection(db, "parties"));
        batch.set(ref, {
          clientId: activeClientId,
          name: row.name,
          type: row.type,
          contact: row.contact || "",
          taxNumber: row.taxNumber || "",
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        existingKeys.add(key);
        created += 1;
        opsInBatch += 1;

        if (opsInBatch >= FIRESTORE_BATCH_LIMIT) {
          await flushBatch();
        }
      }

      await flushBatch();
      await fetchParties();
      closeImport();
      setPageNotice(
        `Imported ${created} part${created === 1 ? "y" : "ies"} into ${
          activeClientData?.name || "this shop"
        }${skipped ? ` (${skipped} duplicate${skipped === 1 ? "" : "s"} skipped)` : ""}.`
      );
    } catch (err) {
      console.error("❌ Import parties error:", err);
      setImportError(err?.message || "Failed to import parties.");
    } finally {
      setImporting(false);
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

        <div className="flex flex-wrap gap-2 w-full md:w-auto">
          <ModuleHelpButton moduleId="parties" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search parties…"
            className="w-full md:w-56 rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-600"
          />
          <button
            type="button"
            onClick={handleExport}
            disabled={!activeClientId || loading}
            className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-100 px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={openImport}
            disabled={!activeClientId}
            className="rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-100 px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            Import CSV
          </button>
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

      {pageNotice ? (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 text-emerald-200 px-3 py-2 text-sm">
          {pageNotice}
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
              <div className="col-span-5 text-slate-100 font-medium">
                {p.name}
                {getPartyCode(p) ? (
                  <span className="ml-2 font-mono text-xs font-normal text-slate-500">
                    {getPartyCode(p)}
                  </span>
                ) : null}
              </div>
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
                  className={FIELD_CLASS}
                  placeholder="Party name"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
                <div>
                  <label className="text-sm text-slate-300">Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className={FIELD_CLASS}
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
                    className={FIELD_CLASS}
                    placeholder="Phone / WhatsApp"
                  />
                </div>
              </div>

              <div>
                <label className="text-sm text-slate-300">Tax Number (optional)</label>
                <input
                  value={taxNumber}
                  onChange={(e) => setTaxNumber(e.target.value)}
                  className={FIELD_CLASS}
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

      {/* Bulk import modal */}
      {importOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={closeImport} />

          <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-950 shadow-xl">
            <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
              <div>
                <div className="text-slate-100 font-semibold">Import Parties (CSV)</div>
                <div className="text-xs text-slate-400 mt-0.5">
                  Into shop:{" "}
                  <span className="text-slate-200">
                    {activeClientData?.name || "No client selected"}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={closeImport}
                className="text-slate-400 hover:text-slate-200"
              >
                ✕
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <p className="text-sm text-slate-400">
                Columns: <span className="text-slate-200">Name, Type, Contact, Tax Number</span>.
                Types: {PARTY_TYPES.join(", ")}. Import only affects the active shop.
              </p>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    downloadPartyImportTemplate(activeClientData?.name || "shop")
                  }
                  className="rounded-lg border border-slate-700 bg-slate-900 text-slate-200 px-3 py-1.5 text-sm hover:bg-slate-800"
                >
                  Download template
                </button>
              </div>

              <div>
                <label className="text-sm text-slate-300">CSV file</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={onImportFileChange}
                  className="mt-1 block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-slate-100 hover:file:bg-slate-700"
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={skipDuplicates}
                  onChange={(e) => setSkipDuplicates(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-900"
                />
                Skip duplicates (same name + type already in this shop)
              </label>

              {importPreview ? (
                <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-300 space-y-1">
                  <div>
                    File:{" "}
                    <span className="text-slate-100">{importPreview.fileName}</span>
                  </div>
                  <div>
                    Valid rows:{" "}
                    <span className="text-emerald-300">{importPreview.rows.length}</span>
                  </div>
                  {importPreview.errors.length > 0 ? (
                    <div className="text-amber-200">
                      Skipped / invalid: {importPreview.errors.length}
                      <ul className="mt-1 max-h-28 overflow-auto text-xs text-amber-200/90 list-disc pl-4">
                        {importPreview.errors.slice(0, 8).map((msg) => (
                          <li key={msg}>{msg}</li>
                        ))}
                        {importPreview.errors.length > 8 ? (
                          <li>…and {importPreview.errors.length - 8} more</li>
                        ) : null}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {importError ? (
                <div className="rounded-lg border border-red-800 bg-red-950/40 text-red-200 px-3 py-2 text-sm">
                  {importError}
                </div>
              ) : null}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeImport}
                  className="rounded-lg border border-slate-700 bg-slate-900 text-slate-200 px-4 py-2 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleImportConfirm}
                  disabled={
                    importing || !importPreview?.rows?.length || !activeClientId
                  }
                  className="rounded-lg bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 font-medium disabled:opacity-60"
                >
                  {importing
                    ? "Importing…"
                    : `Import ${importPreview?.rows?.length || 0}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
