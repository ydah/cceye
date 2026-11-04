import { describe, expect, it } from "vitest";
import { decimalToNanos, formatMoneyNanos } from "../src/money.ts";

describe("money", () => {
  it("converts decimal values without floating point drift", () => {
    expect(decimalToNanos("1.234567891")).toBe(1234567891n);
    expect(decimalToNanos("-0.25")).toBe(-250000000n);
    expect(formatMoneyNanos(1234567891n)).toBe("1.2345");
    expect(formatMoneyNanos(-250000000n, 2)).toBe("-0.25");
  });

  it("rejects malformed amounts", () => {
    expect(() => decimalToNanos("1.2.3")).toThrow("invalid decimal amount");
  });
});
