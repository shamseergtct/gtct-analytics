import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Searchable payment-mode combobox for External Bill Entry.
 * Options keep existing values (CASH / CREDIT / BANK:<id> / …); labels only.
 */
export default function PaymentModeSearchSelect({
  options = [],
  value = "",
  onChange,
  required = false,
  disabled = false,
  inputClassName = "",
  placeholder = "Search payment mode…",
}) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = useMemo(
    () => options.find((option) => option.value === value) || null,
    [options, value]
  );

  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return options;
    return options.filter((option) =>
      String(option.label || "")
        .toLowerCase()
        .includes(search)
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) {
      setQuery(selected?.label || "");
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

  function selectOption(option) {
    onChange?.(option?.value || "");
    setQuery(option?.label || "");
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        required={required && !value}
        disabled={disabled}
        value={open ? query : selected?.label || query}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            setQuery(selected?.label || "");
          }
          if (event.key === "Enter" && open && filtered[0]) {
            event.preventDefault();
            selectOption(filtered[0]);
          }
        }}
        className={inputClassName}
        placeholder={placeholder}
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={open}
        role="combobox"
      />

      {open && !disabled ? (
        <div className="absolute z-40 mt-1 max-h-56 w-full overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-1 shadow-2xl">
          {filtered.length ? (
            filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => selectOption(option)}
                className={`flex w-full rounded-lg px-3 py-2 text-left text-sm font-medium hover:bg-slate-800 ${
                  option.value === value
                    ? "bg-slate-800 text-white"
                    : "text-slate-200"
                }`}
              >
                {option.label}
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-slate-500">
              No matching payment modes.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
