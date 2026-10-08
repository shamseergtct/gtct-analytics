import { useEffect, useMemo, useState } from "react";
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
import { useBankAccounts } from "../../hooks/useBankAccounts.js";
import { numMoney } from "../../utils/money.js";
import {
  buildDeliveryBoyPaymentModeChoices,
  resolveDeliveryBoyAssignedPaymentModes,
  resolveDeliveryBoyCommission,
} from "../../utils/externalSales.js";
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
  assignedPaymentModes: [],
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
  bankAccounts: bankAccountsProp = [],
  loading,
  onMessage,
  onError,
}) {
  const { user } = useAuth();
  // Load ALL shop bank accounts for edit UI (active + inactive, operational + reserve).
  const { accounts: hookedBanks, loading: loadingBanks } = useBankAccounts(
    clientId,
    { activeOnly: false, purpose: "all" }
  );
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

  const allBankAccounts = useMemo(() => {
    const fromProp = Array.isArray(bankAccountsProp) ? bankAccountsProp : [];
    const merged = new Map();
    [...fromProp, ...(hookedBanks || [])].forEach((row) => {
      if (row?.id) merged.set(row.id, row);
    });
    return [...merged.values()].sort((a, b) =>
      String(a.accountName || a.bankName || "").localeCompare(
        String(b.accountName || b.bankName || "")
      )
    );
  }, [bankAccountsProp, hookedBanks]);

  // Assignable banks for Delivery Entry (active operational only).
  const operationalBanks = useMemo(
    () =>
      allBankAccounts.filter((row) => {
        if (!row?.id || row.isActive === false) return false;
        const type = String(row.accountType || "")
          .trim()
          .toUpperCase();
        return type !== "RESERVE";
      }),
    [allBankAccounts]
  );

  const paymentModeChoices = useMemo(
    () =>
      buildDeliveryBoyPaymentModeChoices({
        deliveryBoyName: form.name || "Delivery account",
        bankAccounts: allBankAccounts,
        includeInactiveBanks: true,
        includeReserveBanks: true,
      }),
    [form.name, allBankAccounts]
  );

  const assignablePaymentModeChoices = useMemo(
    () => paymentModeChoices.filter((row) => row.canAssign !== false),
    [paymentModeChoices]
  );

  // When banks finish loading after the modal opens, include them in the
  // enable/disable list (keep existing toggles; auto-enable new banks only
  // for new boys / unconfigured boys).
  useEffect(() => {
    if (!isOpen) return;
    const choiceValues = paymentModeChoices.map((row) => row.value);
    if (!choiceValues.length) return;

    setForm((current) => {
      const existing = new Set(current.assignedPaymentModes || []);
      const editingRow = editingId
        ? deliveryBoys.find((row) => row.id === editingId)
        : null;
      const assignableValues = paymentModeChoices
        .filter((row) => row.canAssign !== false)
        .map((row) => row.value);
      const configured = editingRow?.assignedPaymentModesConfigured === true;
      if (configured) {
        // Keep only still-valid assignable selections; do not auto-enable new banks.
        const next = [...existing].filter((value) =>
          assignableValues.includes(value)
        );
        if (
          next.length === existing.size &&
          next.every((value) => existing.has(value))
        ) {
          return current;
        }
        return { ...current, assignedPaymentModes: next };
      }
      // New / legacy: default to all assignable options once banks are known.
      const allEnabled = assignableValues;
      const same =
        allEnabled.length === existing.size &&
        allEnabled.every((value) => existing.has(value));
      if (same) return current;
      return { ...current, assignedPaymentModes: allEnabled };
    });
  }, [isOpen, paymentModeChoices, editingId, deliveryBoys]);

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
    const allModes = buildDeliveryBoyPaymentModeChoices({
      deliveryBoyName: "Delivery account",
      bankAccounts: allBankAccounts,
      includeInactiveBanks: true,
      includeReserveBanks: true,
    })
      .filter((row) => row.canAssign !== false)
      .map((row) => row.value);
    setForm({ ...EMPTY, assignedPaymentModes: allModes });
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
      assignedPaymentModes: resolveDeliveryBoyAssignedPaymentModes(
        row,
        operationalBanks.length ? operationalBanks : allBankAccounts
      ),
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

  function togglePaymentMode(modeValue) {
    setForm((current) => {
      const set = new Set(current.assignedPaymentModes || []);
      if (set.has(modeValue)) set.delete(modeValue);
      else set.add(modeValue);
      return { ...current, assignedPaymentModes: [...set] };
    });
  }

  function setAllPaymentModes(enabled) {
    setForm((current) => ({
      ...current,
      assignedPaymentModes: enabled
        ? assignablePaymentModeChoices.map((row) => row.value)
        : [],
    }));
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
    const allowedChoiceValues = new Set(
      assignablePaymentModeChoices.map((row) => row.value)
    );
    const assignedPaymentModes = (form.assignedPaymentModes || [])
      .map(String)
      .filter((value) => allowedChoiceValues.has(value));
    const assignedPaymentAccountIds = assignedPaymentModes
      .filter((value) => value.startsWith("BANK:"))
      .map((value) => value.slice("BANK:".length))
      .filter((id) => operationalBanks.some((row) => row.id === id));

    if (!assignedPaymentModes.length) {
      setModalError("Enable at least one payment option (Cash, delivery account, or a bank).");
      return;
    }

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
        assignedPaymentModes,
        assignedPaymentModesConfigured: true,
        assignedPaymentAccountIds,
        updatedAt: serverTimestamp(),
        updatedAtMs: Date.now(),
        updatedBy: user?.uid || null,
      };

      let boyId = editingId;
      if (editingId) {
        await updateDoc(doc(db, "delivery_boys", editingId), payload);
        // Keep linked user terminal / payment assignments in sync.
        if (deliveryBoys.find((row) => row.id === editingId)?.linkedUserId) {
          const linkedUserId = deliveryBoys.find(
            (row) => row.id === editingId
          ).linkedUserId;
          await updateDoc(doc(db, "users", linkedUserId), {
            assignedTerminalIds,
            assignedPaymentModes,
            assignedPaymentAccountIds,
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
          assignedPaymentModes,
          assignedPaymentAccountIds,
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
                <th className="px-4 py-3">Payment accounts</th>
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
                    colSpan={7}
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
                  const payModes = resolveDeliveryBoyAssignedPaymentModes(
                    row,
                    operationalBanks
                  );
                  const payNames = payModes
                    .map((value) => {
                      if (value === "CASH") return "Cash";
                      if (value === "DELIVERY_ACCOUNT") return row.name || "Delivery";
                      if (value.startsWith("BANK:")) {
                        const id = value.slice(5);
                        const acc = operationalBanks.find((a) => a.id === id);
                        return (
                          acc?.accountName ||
                          acc?.bankName ||
                          String(id).slice(0, 6)
                        );
                      }
                      return value;
                    })
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
                        {payNames || "—"}
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
                    colSpan={7}
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

              <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-white">
                    Payment options (enable / disable)
                  </div>
                  <div className="flex gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => setAllPaymentModes(true)}
                      className="rounded-lg border border-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-800"
                    >
                      Enable all
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllPaymentModes(false)}
                      className="rounded-lg border border-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-800"
                    >
                      Disable all
                    </button>
                  </div>
                </div>
                <p className="text-xs text-slate-500">
                  All shop payment accounts are listed. Enable/disable Cash,
                  delivery account, and banks for Delivery Entry. Inactive and
                  reserve banks are shown but cannot be enabled for bills.
                </p>
                {loadingBanks && !allBankAccounts.length ? (
                  <p className="text-xs text-slate-400">Loading bank accounts…</p>
                ) : null}
                {paymentModeChoices.map((choice) => {
                  const enabled = form.assignedPaymentModes.includes(
                    choice.value
                  );
                  const locked = choice.canAssign === false;
                  const meta =
                    choice.kind === "delivery"
                      ? "Delivery account"
                      : choice.kind === "cash"
                        ? "Cash"
                        : choice.isReserve
                          ? "Reserve"
                          : choice.inactive
                            ? "Inactive"
                            : "Bank";
                  return (
                    <label
                      key={choice.value}
                      className={`flex items-center justify-between gap-3 rounded-lg border border-slate-800/80 bg-slate-950/50 px-3 py-2 text-sm text-slate-300 ${
                        locked ? "opacity-60" : ""
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <input
                          type="checkbox"
                          checked={enabled && !locked}
                          disabled={locked}
                          onChange={() => {
                            if (!locked) togglePaymentMode(choice.value);
                          }}
                          className="h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-950 text-blue-600 disabled:opacity-40"
                        />
                        <span className="truncate font-medium text-white">
                          {choice.label}
                        </span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">
                          {meta}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          locked
                            ? "bg-slate-800 text-slate-500"
                            : enabled
                              ? "bg-emerald-950/70 text-emerald-300"
                              : "bg-slate-800 text-slate-500"
                        }`}
                      >
                        {locked
                          ? choice.isReserve
                            ? "Reserve"
                            : "Inactive"
                          : enabled
                            ? "Enabled"
                            : "Disabled"}
                      </span>
                    </label>
                  );
                })}
                {!loadingBanks && !allBankAccounts.length ? (
                  <p className="text-xs text-amber-200">
                    No bank accounts found for this shop. Add them under Bank
                    Accounts, then reopen this form.
                  </p>
                ) : null}
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
