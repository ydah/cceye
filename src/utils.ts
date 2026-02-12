import { addMinutes, formatISO, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import { toZonedTime, fromZonedTime } from "date-fns-tz";

export interface Period {
  start: Date;
  end: Date;
}

export function getDailyPeriod(timezone: string, now: Date = new Date()): Period {
  const zonedNow = toZonedTime(now, timezone);
  const startLocal = startOfDay(zonedNow);
  return {
    start: fromZonedTime(startLocal, timezone),
    end: now,
  };
}

export function getWeeklyPeriod(timezone: string, now: Date = new Date()): Period {
  const zonedNow = toZonedTime(now, timezone);
  const startLocal = startOfWeek(zonedNow, { weekStartsOn: 1 });
  return {
    start: fromZonedTime(startLocal, timezone),
    end: now,
  };
}

export function getMonthlyPeriod(timezone: string, now: Date = new Date()): Period {
  const zonedNow = toZonedTime(now, timezone);
  const startLocal = startOfMonth(zonedNow);
  return {
    start: fromZonedTime(startLocal, timezone),
    end: now,
  };
}

export function formatIsoUtc(date: Date): string {
  return formatISO(date);
}

export function minutesFromNow(minutes: number, now: Date = new Date()): Date {
  return addMinutes(now, minutes);
}
