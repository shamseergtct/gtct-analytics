import { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { Landmark, Pencil, Plus, X } from "lucide-react";
import { db } from "../firebase";
import { useClient } from "../context/ClientContext.jsx";

const LABEL_CLASS = "block text-sm font-medium text-gray-300";
const FIELD_CLASS =
  "mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white transition-all focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60";

const EMPTY_FORM = {
  accountName: "",
  bankName: "",
  accountNumber: "",
  isActive: true,
};

export default function BankAccounts() {
  const { activeClientId, activeClientData } = useClient();

  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [search, setSearch] = useState("");

  const [isOpen, setIsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [modalError, setModalError] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!activeClientId) {
      setAccounts([]);
      setLoading(false);
      setPageError("");
      return undefined;
    }

    setLoading(true);
    const accountsQuery = query(
      collection(db, "bank_accounts"),
      where("clientId", "==", activeClientId)
    );

    return onSnapshot(
      accountsQuery,
      (snapshot) => {
        const rows = snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .sort((a, b) =>
            String(a.accountName || "").localeCompare(String(b.accountName || ""))
          );
        setAccounts(rows);
        setLoading(false);
        setPageError("");
      },
      (reason) => {
        setAccounts([]);
        setLoading(false);
        setPageError(reason?.message || "Failed to load bank accounts.");
      }
    );
  }, [activeClientId]);

  useEffect(() => {
    if (!message) return undefined;
    const timeoutId = window.setTimeout(() => setMessage(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [message]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((account) =>
      `${account.accountName || ""} ${account.bankName || ""} ${account.accountNumber || ""}`
        .toLowerCase()
        .includes(q)
    );
  }, [accounts, search]);

  function openAdd() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setModalError("");
    setIsOpen(true);
  }

  function openEdit(account) {
    setEditingId(account.id);
    setForm({
      accountName: account.accountName || "",
      bankName: account.bankName || "",
      accountNumber: account.accountNumber || "",
      isActive: account.isActive !== false,
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

    if (!activeClientId) {
      setModalError("Select an active shop first.");
      return;
    }

    const accountName = String(form.accountName || "").trim();
    const bankName = String(form.bankName || "").trim();
    const accountNumber = String(form.accountNumber || "").trim();

    if (!accountName) {
      setModalError("Account name is required.");
      return;
    }
    if (!bankName) {
      setModalError("Bank name is required.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        clientId: activeClientId,
        accountName,
        bankName,
        accountNumber,
        isActive: Boolean(form.isActive),
      };

      if (editingId) {
        await updateDoc(doc(db, "bank_accounts", editingId), {
          ...payload,
          updatedAt: serverTimestamp(),
          updatedAtMs: Date.now(),
        });
        setMessage("Bank account updated.");
      } else {
        await addDoc(collection(db, "bank_accounts"), {
          ...payload,
          createdAt: serverTimestamp(),
          createdAtMs: Date.now(),
        });
        setMessage("Bank account created.");
      }
      closeModal();
    } catch (reason) {
      setModalError(reason?.message || "Failed to save bank account.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(account) {
    setPageError("");
    try {
      await updateDoc(doc(db, "bank_accounts", account.id), {
        isActive: account.isActive === false,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
      });
      setMessage(
        account.isActive === false
          ? "Bank account enabled."
          : "Bank account disabled."
      );
    } catch (reason) {
      setPageError(reason?.message || "Failed to update bank account.");
    }
  }

  if (!activeClientId) {
    return (
      <div className="rounded-2xl border border-amber-900/50 bg-amber-950/20 p-6 text-amber-100">
        Select an active shop to manage bank accounts.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <Landmark className="h-6 w-6 text-blue-400" />
            Bank Accounts
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Masters for {activeClientData?.name || activeClientId}. Active
            accounts appear as Bank options in payment modes.
          </p>
        </div>
        <button
          type="button"
          onClick={openAdd}
          className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500"
        >
          <Plus size={16} />
          Add Bank Account
        </button>
      </div>

      {pageError ? (
        <div className="rounded-xl border border-red-900 bg-red-950/30 p-3 text-sm text-red-200">
          {pageError}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-emerald-900 bg-emerald-950/30 p-3 text-sm text-emerald-200">
          {message}
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search account, bank, or number…"
          className={FIELD_CLASS}
        />
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/40">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm text-slate-300">
            <thead className="bg-slate-950/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Account Name</th>
                <th className="px-4 py-3">Bank</th>
                <th className="px-4 py-3">Account No.</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    Loading…
                  </td>
                </tr>
              ) : filtered.length ? (
                filtered.map((account) => (
                  <tr
                    key={account.id}
                    className="border-t border-slate-800/80 hover:bg-slate-950/40"
                  >
                    <td className="px-4 py-3 font-medium text-white">
                      {account.accountName}
                    </td>
                    <td className="px-4 py-3">{account.bankName || "—"}</td>
                    <td className="px-4 py-3">
                      {account.accountNumber || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${
                          account.isActive === false
                            ? "bg-slate-800 text-slate-400"
                            : "bg-emerald-950/60 text-emerald-300"
                        }`}
                      >
                        {account.isActive === false ? "Disabled" : "Active"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openEdit(account)}
                          className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:border-blue-500 hover:text-blue-300"
                          aria-label="Edit bank account"
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleActive(account)}
                          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
                        >
                          {account.isActive === false ? "Enable" : "Disable"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    No bank accounts yet. Add Salary, Main, or Maintenance accounts
                    to use them in payment modes.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">
                {editingId ? "Edit Bank Account" : "Add Bank Account"}
              </h2>
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
                Account Name
                <input
                  required
                  value={form.accountName}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      accountName: event.target.value,
                    }))
                  }
                  className={FIELD_CLASS}
                  placeholder="e.g. Salary Account"
                />
              </label>
              <label className={LABEL_CLASS}>
                Bank Name
                <input
                  required
                  value={form.bankName}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      bankName: event.target.value,
                    }))
                  }
                  className={FIELD_CLASS}
                  placeholder="e.g. HDFC Bank"
                />
              </label>
              <label className={LABEL_CLASS}>
                Account Number (optional)
                <input
                  value={form.accountNumber}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      accountNumber: event.target.value,
                    }))
                  }
                  className={FIELD_CLASS}
                  placeholder="XXXX1234"
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
                Active (show in payment mode dropdowns)
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
                >
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
