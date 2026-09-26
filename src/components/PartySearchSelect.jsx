import { useEffect, useMemo, useRef, useState } from "react";

const FIELD_CLASS =
  "mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-normal normal-case tracking-normal text-white transition-all focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/60 disabled:opacity-60";

/**
 * Searchable party combobox for customer/vendor pickers.
 */
export default function PartySearchSelect({
  parties = [],
  value = "",
  onChange,
  label = "Select Party",
  placeholder = "Search party…",
  emptyLabel = "No matching parties.",
  loading = false,
  disabled = false,
  className = "",
  allowClear = false,
  clearLabel = "All parties",
}) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = useMemo(
    () => parties.find((party) => party.id === value) || null,
    [parties, value]
  );

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return parties
      .filter((party) => {
        if (!search) return true;
        return `${party.name || ""} ${party.contact || ""} ${party.phone || ""} ${party.type || ""}`
          .toLowerCase()
          .includes(search);
      })
      .slice(0, 50);
  }, [parties, query]);

  useEffect(() => {
    if (!open) {
      setQuery(selected?.name || "");
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

  function selectParty(party) {
    onChange?.(party?.id || "");
    setQuery(party?.name || "");
    setOpen(false);
  }

  function clearSelection() {
    onChange?.("");
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={rootRef} className={`relative max-w-md ${className}`}>
      <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500">
        {label}
        <input
          type="text"
          disabled={disabled || loading}
          value={open ? query : selected?.name || query}
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
            loading
              ? "Loading…"
              : parties.length
                ? placeholder
                : "No parties found"
          }
          autoComplete="off"
        />
      </label>

      {open && !disabled && !loading ? (
        <div className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-1 shadow-2xl">
          {allowClear ? (
            <button
              type="button"
              onClick={clearSelection}
              className={`mb-0.5 flex w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-800 ${
                !value ? "bg-blue-950/40 text-blue-200" : "text-slate-300"
              }`}
            >
              {clearLabel}
            </button>
          ) : null}
          {filtered.length ? (
            filtered.map((party) => (
              <button
                key={party.id}
                type="button"
                onClick={() => selectParty(party)}
                className={`flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-slate-800 ${
                  party.id === value ? "bg-blue-950/40" : ""
                }`}
              >
                <span className="text-sm font-medium text-white">
                  {party.name || party.id}
                </span>
                <span className="text-xs text-slate-400">
                  {[party.type, party.contact || party.phone]
                    .filter(Boolean)
                    .join(" · ") || "Party"}
                </span>
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-slate-500">{emptyLabel}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
