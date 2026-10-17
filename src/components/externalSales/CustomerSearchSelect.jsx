import { useEffect, useMemo, useRef, useState } from "react";
import { getPartyCode, partyMatchesQuery } from "../../utils/partyCode.js";

function customerPhone(customer) {
  return String(
    customer?.phone || customer?.mobile || customer?.contact || ""
  ).trim();
}

export function customerOptionLabel(customer) {
  if (!customer) return "";
  const name = String(customer.name || "").trim() || "Customer";
  const code = getPartyCode(customer);
  const phone = customerPhone(customer);
  const bits = [name];
  if (code) bits.push(code);
  if (phone) bits.push(phone);
  return bits.join(" · ");
}

/**
 * Searchable customer combobox — match by name, code, or mobile number.
 */
export default function CustomerSearchSelect({
  customers = [],
  value = "",
  onChange,
  onSelectCustomer,
  required = false,
  disabled = false,
  inputClassName = "",
  placeholder = "Search name or mobile…",
  allowFreeText = false,
  freeTextValue = "",
  onFreeTextChange,
}) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = useMemo(
    () => customers.find((row) => row.id === value) || null,
    [customers, value]
  );

  const filtered = useMemo(() => {
    const list = Array.isArray(customers) ? customers : [];
    const search = open ? query : "";
    if (!String(search || "").trim()) return list.slice(0, 80);
    return list.filter((row) => partyMatchesQuery(row, search)).slice(0, 80);
  }, [customers, open, query]);

  useEffect(() => {
    if (!open) {
      if (allowFreeText && !value) {
        setQuery(freeTextValue || "");
      } else {
        setQuery(selected ? customerOptionLabel(selected) : "");
      }
    }
  }, [open, selected, allowFreeText, freeTextValue, value]);

  useEffect(() => {
    function onPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  function selectCustomer(customer) {
    onChange?.(customer?.id || "");
    onSelectCustomer?.(customer || null);
    setQuery(customer ? customerOptionLabel(customer) : "");
    setOpen(false);
  }

  function commitFreeText() {
    if (!allowFreeText) return;
    const text = String(query || "").trim();
    onChange?.("");
    onFreeTextChange?.(text);
    onSelectCustomer?.(null);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        required={required && !value && !(allowFreeText && freeTextValue)}
        disabled={disabled}
        value={
          open
            ? query
            : selected
              ? customerOptionLabel(selected)
              : allowFreeText
                ? freeTextValue || query
                : query
        }
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(event) => {
          const next = event.target.value;
          setQuery(next);
          setOpen(true);
          if (allowFreeText) {
            onChange?.("");
            onFreeTextChange?.(next);
          }
        }}
        onBlur={() => {
          if (allowFreeText && open) {
            // Defer so option click can win the race.
            window.setTimeout(() => {
              if (!rootRef.current?.contains(document.activeElement)) {
                commitFreeText();
              }
            }, 120);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            setQuery(
              selected
                ? customerOptionLabel(selected)
                : allowFreeText
                  ? freeTextValue || ""
                  : ""
            );
          }
          if (event.key === "Enter" && open) {
            event.preventDefault();
            if (filtered[0]) selectCustomer(filtered[0]);
            else if (allowFreeText) commitFreeText();
          }
        }}
        className={inputClassName}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && !disabled ? (
        <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-slate-700 bg-slate-950 py-1 shadow-xl">
          {filtered.length ? (
            filtered.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm text-slate-100 hover:bg-slate-800"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectCustomer(row)}
                >
                  <span className="font-medium">{row.name || "Customer"}</span>
                  <span className="text-xs text-slate-400">
                    {[getPartyCode(row), customerPhone(row)]
                      .filter(Boolean)
                      .join(" · ") || "No phone"}
                  </span>
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-sm text-slate-500">
              {allowFreeText
                ? "No match — keep typing for a free-text location"
                : "No customers match"}
            </li>
          )}
        </ul>
      ) : null}
    </div>
  );
}
