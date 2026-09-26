import { formatIsoDate } from "../utils/dateFormat.js";

export default function DateInput({
  value,
  className = "",
  disabled = false,
  required = false,
  onChange,
  "aria-label": ariaLabel,
  ...props
}) {
  function handleChange(event) {
    onChange?.(event);
    // Close the native date picker after a selection across browsers.
    event.currentTarget.blur();
  }

  return (
    <span
      className={`relative block min-h-10 overflow-hidden text-center has-[:focus]:ring-2 has-[:focus]:ring-blue-500/50 ${
        disabled ? "opacity-60" : ""
      } ${className}`}
    >
      <input
        {...props}
        type="date"
        value={value || ""}
        disabled={disabled}
        required={required}
        aria-label={ariaLabel}
        onChange={handleChange}
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none flex h-full min-h-10 items-center justify-center px-3 text-inherit"
      >
        {formatIsoDate(value, "dd/mm/yyyy")}
      </span>
    </span>
  );
}
