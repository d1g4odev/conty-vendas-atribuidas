const DECIMAL = /^(\d+)(?:\.(\d{1,2}))?$/;

export function toCents(value: string | number): number | null {
  const text = typeof value === "number" ? String(value) : value.trim();
  const match = DECIMAL.exec(text);
  if (!match) return null;
  const [, whole = "0", fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

