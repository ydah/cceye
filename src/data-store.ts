import fs from "fs";
import os from "os";
import path from "path";
import { formatISO } from "date-fns";
import { z } from "zod";
import type { WindowKey } from "./state-store.js";

export interface ModelCost {
  model: string;
  cost: number;
}

export interface TrendPoint {
  hour: string;
  cost: number;
}

export interface NotificationHistoryEntry {
  timestamp: string;
  level: "warning" | "critical";
  window: WindowKey;
  currentCost: number;
  threshold: number;
  channels: string[];
}

export interface DataStoreState {
  currentCosts: Record<WindowKey, number>;
  modelBreakdown: Record<WindowKey, ModelCost[]>;
  hourlyTrend: TrendPoint[];
  notificationHistory: NotificationHistoryEntry[];
  lastUpdated: string | null;
}

const dataFilePath = path.join(os.homedir(), ".config", "cceye", "data.json");

const windows: WindowKey[] = ["daily", "weekly", "monthly"];

const modelCostSchema = z.object({
  model: z.string(),
  cost: z.number(),
});

const trendPointSchema = z.object({
  hour: z.string(),
  cost: z.number(),
});

const notificationHistoryEntrySchema = z.object({
  timestamp: z.string(),
  level: z.enum(["warning", "critical"]),
  window: z.enum(["daily", "weekly", "monthly"]),
  currentCost: z.number(),
  threshold: z.number(),
  channels: z.array(z.string()),
});

const dataStoreSchema = z
  .object({
    currentCosts: z
      .object({
        daily: z.number().optional(),
        weekly: z.number().optional(),
        monthly: z.number().optional(),
      })
      .partial()
      .optional(),
    modelBreakdown: z
      .object({
        daily: z.array(modelCostSchema).optional(),
        weekly: z.array(modelCostSchema).optional(),
        monthly: z.array(modelCostSchema).optional(),
      })
      .partial()
      .optional(),
    hourlyTrend: z.array(trendPointSchema).optional(),
    notificationHistory: z.array(notificationHistoryEntrySchema).optional(),
    lastUpdated: z.string().nullable().optional(),
  })
  .passthrough();

export function createEmptyData(): DataStoreState {
  return {
    currentCosts: {
      daily: 0,
      weekly: 0,
      monthly: 0,
    },
    modelBreakdown: {
      daily: [],
      weekly: [],
      monthly: [],
    },
    hourlyTrend: [],
    notificationHistory: [],
    lastUpdated: null,
  };
}

export function loadData(): DataStoreState {
  if (!fs.existsSync(dataFilePath)) {
    return createEmptyData();
  }

  try {
    const raw = fs.readFileSync(dataFilePath, "utf8");
    const parsedFile = dataStoreSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsedFile.success) {
      return createEmptyData();
    }

    const parsed = parsedFile.data;
    const emptyData = createEmptyData();
    return {
      ...emptyData,
      lastUpdated: parsed.lastUpdated ?? emptyData.lastUpdated,
      currentCosts: {
        daily: parsed.currentCosts?.daily ?? emptyData.currentCosts.daily,
        weekly: parsed.currentCosts?.weekly ?? emptyData.currentCosts.weekly,
        monthly: parsed.currentCosts?.monthly ?? emptyData.currentCosts.monthly,
      },
      modelBreakdown: {
        daily: parsed.modelBreakdown?.daily ?? emptyData.modelBreakdown.daily,
        weekly: parsed.modelBreakdown?.weekly ?? emptyData.modelBreakdown.weekly,
        monthly: parsed.modelBreakdown?.monthly ?? emptyData.modelBreakdown.monthly,
      },
      notificationHistory: parsed.notificationHistory ?? [],
      hourlyTrend: parsed.hourlyTrend ?? [],
    };
  } catch {
    return createEmptyData();
  }
}

export function saveData(data: DataStoreState): void {
  const dir = path.dirname(dataFilePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${dataFilePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, dataFilePath);
}

export function updateCurrentCosts(data: DataStoreState, costs: Record<WindowKey, number>): void {
  data.currentCosts = { ...data.currentCosts, ...costs };
}

export function updateModelBreakdown(
  data: DataStoreState,
  breakdown: Partial<Record<WindowKey, ModelCost[]>>
): void {
  for (const window of windows) {
    if (breakdown[window]) {
      data.modelBreakdown[window] = breakdown[window];
    }
  }
}

export function updateHourlyTrend(
  data: DataStoreState,
  trend: TrendPoint[],
  now: Date = new Date()
): void {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  data.hourlyTrend = trend.filter((point) => new Date(point.hour).getTime() >= cutoff);
}

export function addNotificationHistory(
  data: DataStoreState,
  entry: NotificationHistoryEntry,
  maxEntries = 50
): void {
  data.notificationHistory = [entry, ...data.notificationHistory].slice(0, maxEntries);
}

export function markUpdated(data: DataStoreState, now: Date = new Date()): void {
  data.lastUpdated = formatISO(now);
}
