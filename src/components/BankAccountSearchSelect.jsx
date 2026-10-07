import { useEffect, useMemo, useRef, useState } from "react";

const FIELD_CLASS =
  "mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white transition-all focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60";

/**
 * Searchable bank account combobox.
 */
export default function BankAccountSearchSelect({
  accounts = [],
  value = "",
  onChange,
  excludeId = "",
  label = "Bank Account",
  placeholder = "Search bank account…",
  required = false,
  disabled = false,
  className = "",
  balanceText = "",
}) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = useMemo(
    () => accounts.find((account) => account.id === value) || null,
    [accounts, value]
  );

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return accounts
      .filter((account) => account.id !== excludeId)
      .filter((account) => {
        if (!search) return true;
        return `${account.accountName || ""} ${account.bankName || ""} ${account.accountNumber || ""}`
          .toLowerCase()
          .includes(search);
      })
      .slice(0, 40);
  }, [accounts, excludeId, query]);

  useEffect(() => {
    if (!open) {
      setQuery(selected ? selected.accountName || "" : "");
    }
  }, [open, selected]);

  useEffect(() => {
    function onPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function selectAccount(account) {
    onChange?.(account?.id || "");
    setQuery(account ? account.accountName || "" : "");
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <label className="block text-sm font-medium text-gray-300">
        <span className="flex flex-wrap items-baseline justify-between gap-2">
          <span>{label}</span>
          {balanceText ? (
            <span className="text-xs font-semibold tabular-nums text-sky-300">
              {balanceText}
            </span>
          ) : null}
        </span>
        <input
          type="text"
          required={required && !value}
          disabled={disabled}
          value={open ? query : selected ? selected.accountName || "" : query}
          onFocus={() => {
            setOpen(true);
            setQuery("");
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            if (value) onChange?.("");
          }}
          className={FIELD_CLASS}
          placeholder={
            accounts.length
              ? placeholder
              : "No active bank accounts — add one under Bank Accounts"
          }
          autoComplete="off"
        />
      </label>

      {open && !disabled ? (
        <div className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-1 shadow-2xl">
          {filtered.length ? (
            filtered.map((account) => (
              <button
                key={account.id}
                type="button"
                onClick={() => selectAccount(account)}
                className={`flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-slate-800 ${
                  account.id === value ? "bg-blue-950/40" : ""
                }`}
              >
                <span className="text-sm font-medium text-white">
                  {account.accountName}
                </span>
                <span className="text-xs text-slate-400">
                  {[account.bankName, account.accountNumber]
                    .filter(Boolean)
                    .join(" · ") || "Active account"}
                </span>
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-slate-500">
              No matching bank accounts.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
