export type MoneyNanos = bigint;

export const decimalToNanos = (value: string | number): MoneyNanos => {
  const text = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    throw new Error("invalid decimal amount");
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ""] = unsigned.split(".");
  const padded = `${fraction}000000000`;
  const nanos = BigInt(whole ?? "0") * 1_000_000_000n + BigInt(padded.slice(0, 9));
  return negative ? -nanos : nanos;
};

export const formatMoneyNanos = (amount: MoneyNanos, decimals = 4): string => {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / 1_000_000_000n;
  const fraction = absolute % 1_000_000_000n;
  const fractionText = fraction.toString().padStart(9, "0").slice(0, decimals).padEnd(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${fractionText}`;
};
