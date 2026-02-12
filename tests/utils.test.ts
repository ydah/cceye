import { describe, expect, it } from "vitest";
import {
  formatIsoUtc,
  getDailyPeriod,
  getMonthlyPeriod,
  getWeeklyPeriod,
  minutesFromNow,
} from "../src/utils.ts";

describe("utils", () => {
  it("returns daily period boundaries in timezone", () => {
    const now = new Date("2026-02-11T12:34:56.000Z");
    const period = getDailyPeriod("UTC", now);
    expect(period.start.toISOString()).toBe("2026-02-11T00:00:00.000Z");
    expect(period.end).toBe(now);
  });

  it("returns weekly and monthly period boundaries", () => {
    const now = new Date("2026-02-11T12:00:00.000Z");
    const weekly = getWeeklyPeriod("UTC", now);
    const monthly = getMonthlyPeriod("UTC", now);

    expect(weekly.start.toISOString()).toBe("2026-02-09T00:00:00.000Z");
    expect(monthly.start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("formats dates and computes future minutes", () => {
    const now = new Date("2026-02-11T12:00:00.000Z");
    expect(new Date(formatIsoUtc(now)).toISOString()).toBe(now.toISOString());
    expect(minutesFromNow(5, now).toISOString()).toBe("2026-02-11T12:05:00.000Z");
  });
});
