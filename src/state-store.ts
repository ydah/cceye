import fs from "fs";
import os from "os";
import path from "path";
import { formatISO, isAfter, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import { toZonedTime, fromZonedTime } from "date-fns-tz";
import { z } from "zod";

const windowKeys = ["daily", "weekly", "monthly"] as const;
const levelKeys = ["warning", "critical"] as const;

export type WindowKey = (typeof windowKeys)[number];
export type LevelKey = (typeof levelKeys)[number];

export interface NotificationHistoryEntry {
  timestamp: string;
  window: WindowKey;
  level: LevelKey;
  cost: number;
  threshold: number;
  transition?: "firing" | "recovery" | undefined;
}

export interface FileIndexEntry {
  size: number;
  mtime: string;
  parsedBytes: number;
}

export interface CachedCostWindow {
  total: number;
  byModel: Record<string, number>;
}

export interface State {
  lastPollAt: string | null;
  notifications: Record<`${WindowKey}:${LevelKey}`, string | null>;
  notificationHistory: NotificationHistoryEntry[];
  fileIndex: Record<string, FileIndexEntry>;
  cachedCosts: Record<WindowKey, CachedCostWindow>;
  activeAlerts: Record<WindowKey, LevelKey | null>;
}

const stateFilePath = path.join(os.homedir(), ".config", "cceye", "state.json");

const notificationHistoryEntrySchema = z.object({
  timestamp: z.string(),
  window: z.enum(windowKeys),
  level: z.enum(levelKeys),
  cost: z.number(),
  threshold: z.number(),
  transition: z.enum(["firing", "recovery"]).optional(),
});

const fileIndexEntrySchema = z.object({
  size: z.number(),
  mtime: z.string(),
  parsedBytes: z.number(),
});

const cachedCostWindowSchema = z.object({
  total: z.number(),
  byModel: z.record(z.string(), z.number()),
});

const stateFileSchema = z
  .object({
    lastPollAt: z.string().nullable().optional(),
    notifications: z.record(z.string(), z.string().nullable()).optional(),
    notificationHistory: z.array(notificationHistoryEntrySchema).optional(),
    fileIndex: z.record(z.string(), fileIndexEntrySchema).optional(),
    cachedCosts: z
      .object({
        daily: cachedCostWindowSchema.optional(),
        weekly: cachedCostWindowSchema.optional(),
        monthly: cachedCostWindowSchema.optional(),
      })
      .partial()
      .optional(),
    activeAlerts: z.record(z.string(), z.enum(levelKeys).nullable()).optional(),
  })
  .passthrough();

function emptyCachedWindow(): CachedCostWindow {
  return { total: 0, byModel: {} };
}

function createEmptyNotifications(): Record<`${WindowKey}:${LevelKey}`, string | null> {
  return {
    "daily:warning": null,
    "daily:critical": null,
    "weekly:warning": null,
    "weekly:critical": null,
    "monthly:warning": null,
    "monthly:critical": null,
  };
}

function notificationKey(window: WindowKey, level: LevelKey): `${WindowKey}:${LevelKey}` {
  return `${window}:${level}`;
}

function createEmptyState(): State {
  return {
    lastPollAt: null,
    notifications: createEmptyNotifications(),
    notificationHistory: [],
    fileIndex: {},
    cachedCosts: {
      daily: emptyCachedWindow(),
      weekly: emptyCachedWindow(),
      monthly: emptyCachedWindow(),
    },
    activeAlerts: { daily: null, weekly: null, monthly: null },
  };
}

export function loadState(): State {
  if (!fs.existsSync(stateFilePath)) {
    return createEmptyState();
  }

  const raw = fs.readFileSync(stateFilePath, "utf8");
  try {
    const parsedFile = stateFileSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsedFile.success) {
      return createEmptyState();
    }

    const parsed = parsedFile.data;
    const emptyState = createEmptyState();
    return {
      ...emptyState,
      lastPollAt: parsed.lastPollAt ?? emptyState.lastPollAt,
      notifications: {
        ...emptyState.notifications,
        ...(parsed.notifications ?? {}),
      },
      notificationHistory: parsed.notificationHistory ?? [],
      fileIndex: parsed.fileIndex ?? {},
      cachedCosts: {
        daily: { ...emptyState.cachedCosts.daily, ...(parsed.cachedCosts?.daily ?? {}) },
        weekly: { ...emptyState.cachedCosts.weekly, ...(parsed.cachedCosts?.weekly ?? {}) },
        monthly: { ...emptyState.cachedCosts.monthly, ...(parsed.cachedCosts?.monthly ?? {}) },
      },
      activeAlerts: { ...emptyState.activeAlerts, ...(parsed.activeAlerts ?? {}) },
    };
  } catch {
    return createEmptyState();
  }
}

export function saveState(state: State): void {
  const dir = path.dirname(stateFilePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const tempPath = `${stateFilePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, stateFilePath);
  fs.chmodSync(stateFilePath, 0o600);
}

export function shouldNotify(
  window: WindowKey,
  level: LevelKey,
  state: State,
  cooldownMinutes: number
): boolean {
  const key = notificationKey(window, level);
  const lastNotifiedAt = state.notifications[key];
  if (!lastNotifiedAt) {
    return true;
  }

  const lastDate = new Date(lastNotifiedAt);
  const nextAllowed = new Date(lastDate.getTime() + cooldownMinutes * 60 * 1000);
  return isAfter(new Date(), nextAllowed);
}

export function recordNotification(
  state: State,
  entry: NotificationHistoryEntry,
  maxEntries = 100
): void {
  const key = notificationKey(entry.window, entry.level);
  state.notifications[key] = entry.timestamp;
  state.activeAlerts[entry.window] = entry.level;
  state.notificationHistory = [entry, ...state.notificationHistory].slice(0, maxEntries);
}

export function recordRecoveryNotification(
  state: State,
  entry: Omit<NotificationHistoryEntry, "transition">,
  maxEntries = 100
): void {
  state.activeAlerts[entry.window] = null;
  state.notificationHistory = [{ ...entry, transition: "recovery" as const }, ...state.notificationHistory].slice(0, maxEntries);
}

export function clearNotificationFlags(state: State): void {
  for (const window of windowKeys) {
    for (const level of levelKeys) {
      state.notifications[notificationKey(window, level)] = null;
    }
    state.activeAlerts[window] = null;
  }
}

export function resetWindowIfNeeded(state: State, timezone: string, now: Date = new Date()): void {
  const lastPoll = state.lastPollAt ? new Date(state.lastPollAt) : null;
  if (!lastPoll) {
    return;
  }
  const zonedNow = toZonedTime(now, timezone);

  const dailyStart = fromZonedTime(startOfDay(zonedNow), timezone);
  if (lastPoll < dailyStart) {
    clearWindow(state, "daily");
  }

  const weeklyStart = fromZonedTime(startOfWeek(zonedNow, { weekStartsOn: 1 }), timezone);
  if (lastPoll < weeklyStart) {
    clearWindow(state, "weekly");
  }

  const monthlyStart = fromZonedTime(startOfMonth(zonedNow), timezone);
  if (lastPoll < monthlyStart) {
    clearWindow(state, "monthly");
  }
}

export function updateLastPoll(state: State, now: Date = new Date()): void {
  state.lastPollAt = formatISO(now);
}

function clearWindow(state: State, window: WindowKey): void {
  for (const level of levelKeys) {
    state.notifications[notificationKey(window, level)] = null;
  }
  state.activeAlerts[window] = null;
  state.cachedCosts[window] = emptyCachedWindow();
}
