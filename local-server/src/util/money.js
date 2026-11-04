/**
 * Shop money helpers. price_cents is integer minor units (not IEEE floats).
 * Display scale = 10 ^ currency_decimals for the active shop.
 * Changing decimals does NOT rescale stored values.
 */

export function minorFactor(decimals) {
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 4) {
    throw Object.assign(new Error("currency_decimals must be 0–4"), {
      status: 400,
    });
  }
  return 10 ** d;
}

export function formatMoneyMinor(minorUnits, shop) {
  const decimals = Number(shop?.currency_decimals ?? 2);
  const label = String(shop?.currency_label || shop?.currency_code || "").trim();
  const factor = minorFactor(decimals);
  const n = Number(minorUnits || 0);
  const negative = n < 0;
  const abs = Math.abs(Math.trunc(n));
  const whole = Math.floor(abs / factor);
  const frac = abs % factor;
  const wholeStr = whole.toLocaleString("en-US");
  const fracStr =
    decimals > 0 ? `.${String(frac).padStart(decimals, "0")}` : "";
  const amount = `${negative ? "-" : ""}${wholeStr}${fracStr}`;
  return label ? `${label} ${amount}` : amount;
}

export function parseMoneyInput(raw, decimals) {
  let text = String(raw ?? "").trim().replace(/,/g, "");
  if (text.startsWith(".")) text = `0${text}`;
  else if (text.startsWith("-.")) text = `-0${text.slice(1)}`;
  if (!text) {
    throw Object.assign(new Error("Price is required"), { status: 400 });
  }
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw Object.assign(new Error("Invalid price format"), { status: 400 });
  }
  const d = Number(decimals);
  const parts = text.replace(/^-/, "").split(".");
  if (parts[1] && parts[1].length > d) {
    throw Object.assign(
      new Error(`Price allows at most ${d} decimal place(s)`),
      { status: 400 }
    );
  }
  const factor = minorFactor(d);
  const whole = Number(parts[0] || "0");
  const frac = parts[1] ? Number(parts[1].padEnd(d, "0")) : 0;
  if (!Number.isInteger(whole) || !Number.isInteger(frac)) {
    throw Object.assign(new Error("Invalid price"), { status: 400 });
  }
  let minor = whole * factor + frac;
  if (text.startsWith("-")) minor = -minor;
  return minor;
}

export function moneyInputStep(decimals) {
  const d = Number(decimals ?? 2);
  if (d <= 0) return "1";
  return `0.${"0".repeat(d - 1)}1`;
}
