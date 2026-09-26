function pad(value) {
  return String(value).padStart(2, "0");
}

function validDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function formatIsoDate(value, fallback = "") {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : fallback;
}

export function dateFromValue(value) {
  if (value?.toDate instanceof Function) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string" && value) {
    const isoFormatted = formatIsoDate(value);
    if (isoFormatted) {
      const [year, month, day] = value.slice(0, 10).split("-").map(Number);
      return new Date(year, month - 1, day, 12, 0, 0);
    }
    return new Date(value);
  }
  return null;
}

export function formatDateValue(value, fallback = "") {
  if (typeof value === "string") {
    const formattedIso = formatIsoDate(value);
    if (formattedIso) return formattedIso;
  }
  const date = dateFromValue(value);
  return validDate(date)
    ? `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
    : fallback;
}

export function formatDateTimeValue(value, fallback = "") {
  const date = dateFromValue(value);
  return validDate(date)
    ? `${formatDateValue(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : fallback;
}

export function formatIsoRange(from, to, separator = " – ") {
  return `${formatIsoDate(from, "-")}${separator}${formatIsoDate(to, "-")}`;
}
