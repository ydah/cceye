#!/usr/bin/env node
import fs from "fs";
import { spawn } from "child_process";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import yaml from "yaml";
import { loadConfigFromArgs, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { evaluateThresholds } from "./threshold-engine.js";
import { NotificationRouter } from "./notifiers/index.js";
import {
  clearNotificationFlags,
  loadState,
  recordRecoveryNotification,
  recordNotification,
  resetWindowIfNeeded,
  saveState,
  shouldNotify,
  updateLastPoll,
} from "./state-store.js";
import {
  addNotificationHistory,
  loadData,
  markUpdated,
  saveData,
  updateCurrentCosts,
  updateHourlyTrend,
  updateModelBreakdown,
  updateProjectBreakdown,
  updateCoverage,
} from "./data-store.js";
import { Scheduler } from "./scheduler.js";
import { Dashboard } from "./dashboard/index.js";
import { loadPricing } from "./pricing.js";
import { periodRange } from "./aggregator.js";
import { collectUsageEntries } from "./usage-collector.js";
import { collectUsageIncrementally } from "./ingestion/incremental-collector.js";
import { SqliteUsageStorage } from "./storage/sqlite-storage.js";
import { backupLegacyFilesBeforeFirstDatabaseUse } from "./storage/legacy-migration.js";
import type { PendingDelivery, UsageStorage, UsageSummary } from "./storage/storage.js";
import { hourlyTrend, nextPoll, toModelBreakdown, toProjectBreakdown } from "./polling-metrics.js";
import {
  buildReportRowsFromStorage,
  buildSessionReportRowsFromStorage,
  printReportRows,
  type ReportCommand,
  type ReportOptions,
} from "./reporting.js";
import { reconcileUsage } from "./billing/reconciliation.js";
import { syncAnthropicBilling } from "./billing/billing-sync.js";
import { formatMoneyNanos } from "./money.js";
import { runDoctor } from "./diagnostics/doctor.js";
import { drainDeliveryOutbox } from "./notifiers/outbox-worker.js";
import { backupDatabase, rebuildDatabase } from "./storage/database-management.js";
import { acquireDatabaseLock } from "./storage/database-lock.js";

export { collectUsageEntries, hourlyTrend, nextPoll, toModelBreakdown, toProjectBreakdown };

const daemonDebugFlags = ["--debug", "-d"];

export async function main(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  if (hasFlag(cliArgs, ["--help", "-h"])) {
    console.log(cliUsage());
    return;
  }
  if (hasFlag(cliArgs, ["--version", "-v"])) {
    console.log(readPackageVersion());
    return;
  }
  const command = findCommand(cliArgs);
  const debugMode = command === "debug" || hasFlag(cliArgs, daemonDebugFlags);
  if (!command || command === "debug") {
    const daemonArgs = command === "debug" ? removeCommandFromArgs(cliArgs) : cliArgs;
    await startDaemon({ dashboard: false, debug: debugMode }, daemonArgs);
    return;
  }
  if (command === "dashboard") {
    await startDaemon({ dashboard: true, debug: debugMode }, cliArgs);
    return;
  }
  if (command === "status") {
    await showStatus(cliArgs);
    return;
  }
  if (isReportCommand(command)) {
    await showReport(command, cliArgs);
    return;
  }
  if (command === "prices") {
    await showPriceExplanation(cliArgs);
    return;
  }
  if (command === "billing") {
    await showBilling(cliArgs);
    return;
  }
  if (command === "reconcile") {
    await showReconciliation(cliArgs);
    return;
  }
  if (command === "doctor") {
    await showDoctor(cliArgs);
    return;
  }
  if (command === "notifications") {
    await manageNotifications(cliArgs);
    return;
  }
  if (command === "alerts") {
    await manageAlerts(cliArgs);
    return;
  }
  if (command === "notify") {
    await notifyTest(cliArgs);
    return;
  }
  if (command === "db") {
    await manageDatabase(cliArgs);
    return;
  }
  if (command === "init") {
    await initConfig();
    return;
  }
  if (command === "install") {
    await installLaunchAgent(cliArgs);
    return;
  }
  if (command === "uninstall") {
    await uninstallLaunchAgent(cliArgs);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

export function cliUsage(): string {
  return `Usage: cceye [command] [options]

Commands:
  status       Run one poll cycle and print current totals
  daily        Print the daily report
  weekly       Print the weekly report
  monthly      Print the monthly report
  session      Print the session report
  prices       Explain model pricing provenance
  billing      Sync or inspect optional Anthropic billing data
  reconcile    Compare local usage with provider billing
  doctor       Check configuration, ingestion, pricing, and database health
  notifications reset  Clear notification cooldown state explicitly
  alerts retry ID  Retry one failed notification delivery
  notify test     Send a test notification without changing threshold state
  db check        Check database integrity
  db backup      Create a database backup
  db rebuild     Rebuild the database from JSONL logs
  dashboard    Start the terminal dashboard
  init         Create a configuration file
  install      Install the macOS LaunchAgent
  uninstall    Remove the macOS LaunchAgent

Options:
  --config PATH  Use a custom configuration file
  --json         Emit machine-readable output where supported
  --offline      Do not fetch pricing data
  --channel NAME Select a notification channel for notify test
  --output PATH  Write a database backup to this path
  --show-coverage Include pricing coverage in report text
  --top N         Limit report breakdown entries
  --other         Aggregate omitted breakdown entries as Other
  --help         Show this help
  --version      Show the package version`;
}

function hasFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

export function shouldResetNotificationFlagsAtStartup(cliArgs: string[]): boolean {
  return cliArgs.length === 0;
}

export function resetNotificationFlagsAtStartupIfNeeded(cliArgs: string[]): void {
  if (!shouldResetNotificationFlagsAtStartup(cliArgs)) {
    return;
  }
  const state = loadState();
  clearNotificationFlags(state);
  saveState(state);
}

function isDebugFlag(arg: string): boolean {
  return daemonDebugFlags.includes(arg);
}

export function readPackageVersion(): string {
  const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

function findCommand(args: string[]): string | undefined {
  const optionWithValue = new Set(["--config", "--since", "--until", "--timezone", "--breakdown", "--channel", "--output", "--top"]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string") {
      continue;
    }
    if (optionWithValue.has(arg)) {
      i += 1;
      continue;
    }
    if (isDebugFlag(arg)) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return undefined;
}

function isReportCommand(command: string): command is ReportCommand {
  return command === "daily" || command === "weekly" || command === "monthly" || command === "session";
}

function readOptionValue(args: string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index < 0) {
    return undefined;
  }
  const next = args[index + 1];
  return typeof next === "string" ? next : undefined;
}

function parseDateFilter(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d{8}$/.test(value)) {
    throw new Error(`${flag} must be YYYYMMDD`);
  }
  return value;
}

export function removeCommandFromArgs(args: string[]): string[] {
  const output: string[] = [];
  let commandRemoved = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string") {
      continue;
    }

    if (arg === "--config") {
      output.push(arg);
      const configPath = args[i + 1];
      if (typeof configPath === "string") {
        output.push(configPath);
        i += 1;
      }
      continue;
    }
    if (isDebugFlag(arg)) {
      output.push(arg);
      continue;
    }

    if (!commandRemoved) {
      commandRemoved = true;
      continue;
    }

    output.push(arg);
  }

  return output;
}

function removeOptionPair(args: string[], optionName: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === optionName) {
      i += 1;
      continue;
    }
    const value = args[i];
    if (typeof value === "string") {
      result.push(value);
    }
  }
  return result;
}

/* v8 ignore start */
export async function startDaemon(
  options: { dashboard: boolean; debug: boolean },
  cliArgs: string[] = process.argv.slice(2)
): Promise<void> {
  const config = loadConfigFromArgs(cliArgs);
  const logger = createLogger(config);
  logger.silent = options.dashboard || !options.debug;
  const router = new NotificationRouter(config, { suppressConsole: options.dashboard });
  const pricing = await loadPricing({ aliases: config.pricing.aliases });
  const releaseLock = acquireDatabaseLock(config.storage.database_path, "daemon");
  let storage: SqliteUsageStorage | null = null;
  try {
    backupLegacyFilesBeforeFirstDatabaseUse(config.storage.database_path);
    storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();
  } catch (error) {
    await (storage as SqliteUsageStorage | undefined)?.close();
    releaseLock();
    throw error;
  }
  if (!storage) {
    releaseLock();
    throw new Error("database could not be opened");
  }
  const daemonStorage = storage;
  let dashboardRef: Dashboard | undefined;
  let pollInFlight = false;
  const runPoll = async (): Promise<void> => {
    if (pollInFlight) {
      logger.warn("previous poll still running, skipping this cycle");
      return;
    }
    pollInFlight = true;
    try {
      await pollOnce(config, pricing, router, logger, options.dashboard, dashboardRef, true, daemonStorage);
    } finally {
      pollInFlight = false;
    }
  };

  const scheduler = new Scheduler(config.polling_interval_milliseconds, runPoll, logger);
  let dashboardRefreshTimer: NodeJS.Timeout | null = null;

  let shuttingDown = false;
  const handleSigint = () => {
    shutdownDaemon();
  };
  const handleSigterm = () => {
    shutdownDaemon();
  };
  const shutdownDaemon = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    scheduler.stop();
    if (dashboardRefreshTimer) {
      clearInterval(dashboardRefreshTimer);
      dashboardRefreshTimer = null;
    }
    dashboardRef?.destroy();
    void daemonStorage.close();
    releaseLock();
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    shutdown(logger);
  };

  try {
    if (options.dashboard) {
      dashboardRef = new Dashboard();
      dashboardRef.onQuit(shutdownDaemon);
      dashboardRef.onRefresh(() => {
        const data = loadData();
        const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
        dashboardRef?.update(data, config, lastUpdated, nextPoll(config.polling_interval_milliseconds), "Fetching...");
        runPoll().catch((error) => logger.error(String(error)));
      });
      dashboardRef.onWindowChange(() => {
        const data = loadData();
        const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
        dashboardRef?.update(data, config, lastUpdated, nextPoll(config.polling_interval_milliseconds));
      });
    }

    scheduler.start();

    if (dashboardRef) {
      const data = loadData();
      const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
      dashboardRef.update(data, config, lastUpdated, nextPoll(config.polling_interval_milliseconds));
      dashboardRefreshTimer = setInterval(() => {
        const current = loadData();
        const currentUpdated = current.lastUpdated ? new Date(current.lastUpdated) : null;
        dashboardRef?.update(
          current,
          config,
          currentUpdated,
          nextPoll(config.polling_interval_milliseconds)
        );
      }, config.dashboard.refresh_interval_seconds * 1000);
    }

    process.on("SIGINT", handleSigint);
    process.on("SIGTERM", handleSigterm);
  } catch (error) {
    dashboardRef?.destroy();
    await daemonStorage.close();
    releaseLock();
    throw error;
  }
}
/* v8 ignore stop */

export async function pollOnce(
  config: Config,
  pricing: Awaited<ReturnType<typeof loadPricing>>,
  router: NotificationRouter,
  logger: ReturnType<typeof createLogger>,
  dashboardMode: boolean,
  dashboard?: Dashboard,
  sendNotifications = true,
  storage?: UsageStorage
): Promise<void> {
  const ledger = storage ?? new SqliteUsageStorage(config.storage.database_path);
  try {
    if (!storage) {
      await ledger.migrate();
    }
    const state = loadState();
    resetWindowIfNeeded(state, config.timezone);

  const collection = await collectUsageIncrementally(config, ledger, pricing, logger);
  const drained = await drainDeliveryOutbox(ledger, router, logger, { maxRetries: config.alerts.max_retries });
  await applyDeliveredOutboxState(state, ledger, drained.deliveredDeliveries);
  const basis = config.cost_mode === "display" ? "reported" : config.cost_mode === "calculate" ? "estimated" : "hybrid";
  const dailySummary = await ledger.queryUsage({ ...periodRange("daily", config.timezone), basis });
  const weeklySummary = await ledger.queryUsage({ ...periodRange("weekly", config.timezone), basis });
  const monthlySummary = await ledger.queryUsage({ ...periodRange("monthly", config.timezone), basis });
  const daily = toAggregatedCost(dailySummary);
  const weekly = toAggregatedCost(weeklySummary);
  const monthly = toAggregatedCost(monthlySummary);

  const results = evaluateThresholds(
    { daily: daily.total, weekly: weekly.total, monthly: monthly.total },
    config.thresholds
  );

  for (const result of results) {
    if (result.level === null || result.threshold === null) {
      continue;
    }
    const level = result.level;
    const threshold = result.threshold;

    if (!sendNotifications) {
      continue;
    }

    const notify = shouldNotify(result.window, level, state, config.notification_cooldown_minutes);
    if (!notify) {
      continue;
    }

    const alertFingerprint = `${result.window}:${level}:${periodRange(result.window, config.timezone).fromMs}`;
    const existingAlert = await ledger.getAlert(alertFingerprint);
    if (existingAlert?.state === "firing") {
      await ledger.createAlert({
        ...existingAlert,
        currentAmountNanos: dollarsToNanos(result.currentCost),
        lastSeenAtMs: Date.now(),
      });
      if (
        state.activeAlerts[result.window] !== level &&
        (await ledger.hasDeliveredDelivery(alertFingerprint, "firing"))
      ) {
        recordNotification(state, {
          timestamp: new Date(existingAlert.lastSeenAtMs).toISOString(),
          window: result.window,
          level,
          cost: result.currentCost,
          threshold,
        });
      }
      continue;
    }

    const alert = {
      level,
      window: result.window,
      currentCost: result.currentCost,
      threshold,
      timestamp: new Date(),
    };

    const alertId = alertFingerprint;
    const pendingDeliveries: PendingDelivery[] = router.channelNames().map((channel) => ({
      id: randomUUID(),
      alertId,
      channel,
      transition: "firing",
      status: "pending",
      attempts: 0,
      nextAttemptAtMs: alert.timestamp.getTime(),
      lastError: null,
      idempotencyKey: `${alertId}:${channel}:firing`,
      createdAtMs: alert.timestamp.getTime(),
      deliveredAtMs: null,
    }));
    await ledger.transaction((tx) => {
      tx.createAlertSync({
        id: alertId,
        fingerprint: alertFingerprint,
        windowKey: result.window,
        windowStartMs: periodRange(result.window, config.timezone).fromMs,
        level,
        state: "firing",
        currentAmountNanos: dollarsToNanos(result.currentCost),
        thresholdAmountNanos: dollarsToNanos(threshold),
        firstSeenAtMs: alert.timestamp.getTime(),
        lastSeenAtMs: alert.timestamp.getTime(),
        resolvedAtMs: null,
      });
      for (const delivery of pendingDeliveries) {
        tx.enqueueDeliverySync(delivery);
      }
    });

    const deliveryResults = await Promise.all(
      pendingDeliveries.map((delivery) =>
        router.sendChannel(delivery.channel, { ...alert, idempotencyKey: delivery.idempotencyKey })
      )
    );
    const channels = deliveryResults
      .filter((delivery) => delivery.status === "success")
      .map((delivery) => delivery.channel);
    for (const delivery of deliveryResults) {
      if (delivery.status === "failed") {
        logger.error(`notification ${delivery.channel} failed: ${delivery.error}`);
      }
      const pending = pendingDeliveries.find((candidate) => candidate.channel === delivery.channel);
      if (pending) {
        const succeeded = delivery.status === "success";
        const attempts = pending.attempts + 1;
        await ledger.updateDelivery({
          ...pending,
          status: succeeded ? "delivered" : attempts >= config.alerts.max_retries ? "dead" : "retrying",
          attempts,
          nextAttemptAtMs: succeeded ? pending.nextAttemptAtMs : Date.now() + retryDelayMs(attempts),
          lastError: delivery.status === "failed" ? delivery.error : null,
          deliveredAtMs: succeeded ? Date.now() : null,
        });
      }
    }
    if (channels.length > 0) {
      recordNotification(state, {
        timestamp: alert.timestamp.toISOString(),
        window: result.window,
        level,
        cost: result.currentCost,
        threshold,
      });
    }

    const data = loadData();
    addNotificationHistory(data, {
      timestamp: alert.timestamp.toISOString(),
      level,
      window: result.window,
      currentCost: result.currentCost,
      threshold,
      channels,
      deliveryResults,
    });
    saveData(data);
  }

  if (sendNotifications && config.alerts.notify_on_recovery) {
    const costsByWindow = { daily: daily.total, weekly: weekly.total, monthly: monthly.total } as const;
    for (const window of ["daily", "weekly", "monthly"] as const) {
      if (results.some((result) => result.window === window) || !state.activeAlerts[window]) {
        continue;
      }
      const level = state.activeAlerts[window];
      const threshold = config.thresholds[window][level];
      const currentCost = costsByWindow[window];
      if (currentCost === null) {
        continue;
      }
      const timestamp = new Date();
      const periodStartMs = periodRange(window, config.timezone).fromMs;
      const recoveryFingerprint = `${window}:recovery:${periodStartMs}`;
      const existingRecovery = await ledger.getAlert(recoveryFingerprint);
      if (existingRecovery) {
        if (
          state.activeAlerts[window] !== null &&
          (await ledger.hasDeliveredDelivery(recoveryFingerprint, "recovery"))
        ) {
          recordRecoveryNotification(state, {
            timestamp: new Date(existingRecovery.lastSeenAtMs).toISOString(),
            window,
            level,
            cost: currentCost,
            threshold,
          });
        }
        continue;
      }
      const alertId = recoveryFingerprint;
      await ledger.resolveAlert({
        fingerprint: `${window}:${level}:${periodStartMs}`,
        currentAmountNanos: dollarsToNanos(currentCost),
        resolvedAtMs: timestamp.getTime(),
      });
      const pendingDeliveries: PendingDelivery[] = router.channelNames().map((channel) => ({
        id: randomUUID(),
        alertId,
        channel,
        transition: "recovery",
        status: "pending",
        attempts: 0,
        nextAttemptAtMs: timestamp.getTime(),
        lastError: null,
        idempotencyKey: `${alertId}:${channel}:recovery`,
        createdAtMs: timestamp.getTime(),
        deliveredAtMs: null,
      }));
      await ledger.transaction((tx) => {
        tx.createAlertSync({
          id: alertId,
          fingerprint: recoveryFingerprint,
          windowKey: window,
          windowStartMs: periodRange(window, config.timezone).fromMs,
          level,
          state: "resolved",
          currentAmountNanos: dollarsToNanos(currentCost),
          thresholdAmountNanos: dollarsToNanos(threshold),
          firstSeenAtMs: timestamp.getTime(),
          lastSeenAtMs: timestamp.getTime(),
          resolvedAtMs: timestamp.getTime(),
        });
        for (const delivery of pendingDeliveries) {
          tx.enqueueDeliverySync(delivery);
        }
      });
      const deliveryResults = await Promise.all(
        pendingDeliveries.map((delivery) =>
          router.sendChannel(delivery.channel, {
            level,
            window,
            currentCost,
            threshold,
            timestamp,
            transition: "recovery",
            idempotencyKey: delivery.idempotencyKey,
          })
        )
      );
      const channels = deliveryResults.filter((delivery) => delivery.status === "success").map((delivery) => delivery.channel);
      for (const delivery of deliveryResults) {
        const pending = pendingDeliveries.find((candidate) => candidate.channel === delivery.channel);
        if (!pending) {
          continue;
        }
        const succeeded = delivery.status === "success";
        const attempts = pending.attempts + 1;
        await ledger.updateDelivery({
          ...pending,
          status: succeeded ? "delivered" : attempts >= config.alerts.max_retries ? "dead" : "retrying",
          attempts,
          nextAttemptAtMs: succeeded ? pending.nextAttemptAtMs : Date.now() + retryDelayMs(attempts),
          lastError: delivery.status === "failed" ? delivery.error : null,
          deliveredAtMs: succeeded ? Date.now() : null,
        });
      }
      if (channels.length > 0) {
        recordRecoveryNotification(state, {
          timestamp: timestamp.toISOString(),
          window,
          level,
          cost: currentCost,
          threshold,
        });
      }
      const data = loadData();
      addNotificationHistory(data, {
        timestamp: timestamp.toISOString(),
        level,
        window,
        currentCost,
        threshold,
        channels,
        deliveryResults,
        transition: "recovery",
      });
      saveData(data);
    }
  }

  updateLastPoll(state);
  saveState(state);

  const data = loadData();
  data.deliveryCounts = await ledger.getDeliveryCounts();
  data.costBasis = basis;
  updateCurrentCosts(data, {
    daily: daily.total,
    weekly: weekly.total,
    monthly: monthly.total,
  });
  updateModelBreakdown(data, {
    daily: toModelBreakdown(daily.byModel),
    weekly: toModelBreakdown(weekly.byModel),
    monthly: toModelBreakdown(monthly.byModel),
  });
  updateProjectBreakdown(data, {
    daily: toProjectBreakdown(daily.byProject),
    weekly: toProjectBreakdown(weekly.byProject),
    monthly: toProjectBreakdown(monthly.byProject),
  });
  updateCoverage(
    data,
    { daily: dailySummary.coverage, weekly: weeklySummary.coverage, monthly: monthlySummary.coverage },
    pricing.status,
    collection.metrics
  );
  const trendFromMs = Date.now() - 24 * 60 * 60 * 1000;
  const trend = await ledger.queryHourlyTrend({
    fromMs: trendFromMs,
    untilMs: Date.now() + 1,
    basis,
  });
  updateHourlyTrend(
    data,
    trend.flatMap((point) =>
      point.amountNanos === null
        ? []
        : [{ hour: new Date(point.hourStartMs).toISOString(), cost: Number(point.amountNanos) / 1_000_000_000 }]
    )
  );
  markUpdated(data);
  saveData(data);

  if (dashboardMode) {
    const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
    dashboard?.update(data, config, lastUpdated, nextPoll(config.polling_interval_milliseconds));
  }

    logger.info("polling cycle completed");
  } finally {
    if (!storage) {
      await ledger.close();
    }
  }
}

async function applyDeliveredOutboxState(
  state: ReturnType<typeof loadState>,
  storage: UsageStorage,
  deliveries: PendingDelivery[]
): Promise<void> {
  for (const delivery of deliveries) {
    const alert = await storage.getAlert(delivery.alertId);
    if (!alert) {
      continue;
    }
    const window = alert.windowKey as "daily" | "weekly" | "monthly";
    const entry = {
      timestamp: new Date(alert.lastSeenAtMs).toISOString(),
      window,
      level: alert.level,
      cost: Number(alert.currentAmountNanos) / 1_000_000_000,
      threshold: Number(alert.thresholdAmountNanos) / 1_000_000_000,
    };
    if (delivery.transition === "firing" && state.activeAlerts[window] !== alert.level) {
      recordNotification(state, entry);
      continue;
    }
    if (delivery.transition === "recovery" && state.activeAlerts[window] !== null) {
      recordRecoveryNotification(state, entry);
    }
  }
}

function toAggregatedCost(summary: UsageSummary): {
  total: number | null;
  byModel: Record<string, number | null>;
  byProject: Record<string, number | null>;
  tokenBreakdown: { input: number; output: number; cacheCreation: number; cacheRead: number };
} {
  return {
    total: nanosToNumber(summary.totalAmountNanos),
    byModel: Object.fromEntries(summary.byModel.map((item) => [item.key, nanosToNumber(item.amountNanos)])),
    byProject: Object.fromEntries(summary.byProject.map((item) => [item.key, nanosToNumber(item.amountNanos)])),
    tokenBreakdown: {
      input: summary.inputTokens,
      output: summary.outputTokens,
      cacheCreation: summary.cacheCreationTokens,
      cacheRead: summary.cacheReadTokens,
    },
  };
}

const nanosToNumber = (amount: bigint | null): number | null => (amount === null ? null : Number(amount) / 1_000_000_000);

const dollarsToNanos = (amount: number): bigint => BigInt(Math.round(amount * 1_000_000_000));

const retryDelayMs = (attempt: number): number => {
  const base = Math.min(60 * 60 * 1000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * Math.max(1, Math.floor(base * 0.2)));
};

export async function showStatus(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfigFromArgs(cliArgs);
  const logger = createLogger(config);
  logger.silent = true;
  const pricing = await loadPricing({ aliases: config.pricing.aliases });
  const releaseLock = acquireDatabaseLock(config.storage.database_path, "status command");
  let storage: SqliteUsageStorage | null = null;
  try {
    backupLegacyFilesBeforeFirstDatabaseUse(config.storage.database_path);
    storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();
    await pollOnce(config, pricing, new NotificationRouter(config), logger, false, undefined, false, storage);
  } finally {
    await storage?.close();
    releaseLock();
  }
  const data = loadData();
  const output = {
    daily: data.currentCosts.daily,
    weekly: data.currentCosts.weekly,
    monthly: data.currentCosts.monthly,
    coverage: data.coverage,
    pricingStatus: data.pricingStatus,
    ingestionHealth: data.ingestionHealth,
    deliveryCounts: data.deliveryCounts,
    costBasis: data.costBasis,
  };
  if (hasFlag(cliArgs, ["--json"])) {
    console.log(JSON.stringify(output));
    return;
  }
  console.log(
    `Daily: ${formatDisplayCost(output.daily)}, Weekly: ${formatDisplayCost(output.weekly)}, Monthly: ${formatDisplayCost(output.monthly)}`
  );
  console.log(
    `Pricing coverage: ${((output.coverage.monthly?.eventCoverageRatio ?? 1) * 100).toFixed(1)}% (${output.pricingStatus})`
  );
}

const formatDisplayCost = (amount: number | null): string => (amount === null ? "UNPRICED" : `$${amount.toFixed(2)}`);

export async function showReport(command: ReportCommand, cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const since = parseDateFilter(readOptionValue(cliArgs, "--since"), "--since");
  const until = parseDateFilter(readOptionValue(cliArgs, "--until"), "--until");
  const reportTimezone = readOptionValue(cliArgs, "--timezone");
  const json = hasFlag(cliArgs, ["--json"]);
  const breakdownValue = readOptionValue(cliArgs, "--breakdown");
  const breakdown = hasFlag(cliArgs, ["--breakdown"]);
  const offline = hasFlag(cliArgs, ["--offline"]);
  const topValue = readOptionValue(cliArgs, "--top");
  const top = topValue === undefined ? undefined : Number(topValue);
  if (top !== undefined && (!Number.isInteger(top) || top <= 0)) {
    throw new Error("--top must be a positive integer");
  }

  const configArgs = removeOptionPair(removeOptionPair(cliArgs, "--since"), "--until");
  const config = loadConfigFromArgs(configArgs);
  const pricing = await loadPricing({ offline, aliases: config.pricing.aliases });
  const logger = createLogger(config);

  const reportOptions: ReportOptions = {
    json,
    breakdown,
    timezone: reportTimezone ?? config.timezone,
    breakdownDimension:
      breakdownValue === "project" || breakdownValue === "session" || breakdownValue === "model"
        ? breakdownValue
        : command === "session"
          ? "session"
          : "model",
    showCoverage: hasFlag(cliArgs, ["--show-coverage"]),
    ...(top !== undefined ? { top } : {}),
    other: hasFlag(cliArgs, ["--other"]),
  };
  if (since !== undefined) {
    reportOptions.since = since;
  }
  if (until !== undefined) {
    reportOptions.until = until;
  }

  if (command !== "session") {
    const releaseLock = acquireDatabaseLock(config.storage.database_path, "report command");
    let storage: SqliteUsageStorage | null = null;
    try {
      backupLegacyFilesBeforeFirstDatabaseUse(config.storage.database_path);
      storage = new SqliteUsageStorage(config.storage.database_path);
      await storage.migrate();
      await collectUsageIncrementally(config, storage, pricing, logger);
      const basis = config.cost_mode === "display" ? "reported" : config.cost_mode === "calculate" ? "estimated" : "hybrid";
      const rows = await buildReportRowsFromStorage(storage, command, reportOptions, basis);
      printReportRows(rows, reportOptions);
    } finally {
      await storage?.close();
      releaseLock();
    }
    return;
  }
  const releaseLock = acquireDatabaseLock(config.storage.database_path, "session report command");
  let storage: SqliteUsageStorage | null = null;
  try {
    backupLegacyFilesBeforeFirstDatabaseUse(config.storage.database_path);
    storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();
    await collectUsageIncrementally(config, storage, pricing, logger);
    const basis = config.cost_mode === "display" ? "reported" : config.cost_mode === "calculate" ? "estimated" : "hybrid";
    const rows = await buildSessionReportRowsFromStorage(storage, reportOptions, basis);
    printReportRows(rows, reportOptions);
  } finally {
    await storage?.close();
    releaseLock();
  }
}

export async function showPriceExplanation(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const commandIndex = cliArgs.findIndex((arg) => arg === "prices");
  const subcommand = cliArgs[commandIndex + 1];
  if (subcommand !== "explain") {
    throw new Error("usage: cceye prices explain MODEL");
  }
  const model = cliArgs[commandIndex + 2];
  if (!model || model.startsWith("-")) {
    throw new Error("usage: cceye prices explain MODEL");
  }
  const config = loadConfigFromArgs(cliArgs);
  const pricing = await loadPricing({ offline: hasFlag(cliArgs, ["--offline"]), aliases: config.pricing.aliases });
  const explanation = pricing.explain?.(model);
  if (!explanation) {
    throw new Error("pricing explanation is unavailable");
  }
  if (hasFlag(cliArgs, ["--json"])) {
    console.log(JSON.stringify(explanation));
    return;
  }
  console.log(`Raw model: ${explanation.rawModel}`);
  console.log(`Matched model: ${explanation.matchedModel ?? "unpriced"}`);
  console.log(`Match type: ${explanation.matchType}`);
  console.log(`Catalog source: ${explanation.source}`);
  console.log(`Pricing status: ${explanation.status}`);
  console.log(`Catalog hash: ${explanation.catalogHash ?? "unavailable"}`);
  if (!explanation.price) {
    console.log("Price: unavailable");
    return;
  }
  console.log(`Input: $${explanation.price.inputPerMTok.toFixed(4)} / MTok`);
  console.log(`Output: $${explanation.price.outputPerMTok.toFixed(4)} / MTok`);
  console.log(`Cache write: $${explanation.price.cacheCreatePerMTok.toFixed(4)} / MTok`);
  console.log(`Cache read: $${explanation.price.cacheReadPerMTok.toFixed(4)} / MTok`);
}

export async function showBilling(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const commandIndex = cliArgs.findIndex((arg) => arg === "billing");
  const subcommand = cliArgs[commandIndex + 1];
  if (subcommand !== "sync" && subcommand !== "status") {
    throw new Error("usage: cceye billing sync|status [--since YYYYMMDD] [--until YYYYMMDD]");
  }
  const config = loadConfigFromArgs(cliArgs);
  const range = dateRangeFromArgs(cliArgs);
  const releaseLock = acquireDatabaseLock(config.storage.database_path, "billing command");
  let storage: SqliteUsageStorage | null = null;
  try {
    backupLegacyFilesBeforeFirstDatabaseUse(config.storage.database_path);
    storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();
    if (subcommand === "sync") {
      const result = await syncAnthropicBilling(
        config.billing.anthropic,
        storage,
        new Date(range.fromMs),
        new Date(range.untilMs)
      );
      printJsonOrText(
        cliArgs,
        { records: result.records.length, fetchedAt: new Date(result.fetchedAtMs).toISOString() },
        `Billing sync complete: ${result.records.length} records`
      );
      return;
    }
    const records = await storage.queryBilling(range.fromMs, range.untilMs);
    const amount = records.reduce((total, record) => total + record.amountNanos, 0n);
    printJsonOrText(
      cliArgs,
      { records: records.length, amountNanos: amount.toString(), amountUSD: formatMoneyNanos(amount) },
      `Billing records: ${records.length}, total: $${formatMoneyNanos(amount)}`
    );
  } finally {
    await storage?.close();
    releaseLock();
  }
}

export async function showReconciliation(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfigFromArgs(cliArgs);
  const range = dateRangeFromArgs(cliArgs);
  const releaseLock = acquireDatabaseLock(config.storage.database_path, "reconciliation command");
  let storage: SqliteUsageStorage | null = null;
  try {
    backupLegacyFilesBeforeFirstDatabaseUse(config.storage.database_path);
    storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();
    const result = await reconcileUsage(storage, range.fromMs, range.untilMs);
    const output = {
      period: { from: new Date(result.fromMs).toISOString(), until: new Date(result.untilMs).toISOString() },
      localReportedNanos: result.localReportedNanos?.toString() ?? null,
      localEstimatedNanos: result.localEstimatedNanos?.toString() ?? null,
      providerBilledNanos: result.providerBilledNanos.toString(),
      differenceNanos: result.differenceNanos?.toString() ?? null,
      differenceRatio: result.differenceRatio,
      estimatedCoverage: result.estimatedCoverage,
      unpricedEvents: result.unpricedEvents,
    };
    if (hasFlag(cliArgs, ["--json"])) {
      console.log(JSON.stringify(output));
      return;
    }
    console.log(`Period: ${output.period.from} .. ${output.period.until}`);
    console.log(`Local reported cost: ${formatOptionalMoney(result.localReportedNanos)}`);
    console.log(`Local estimated cost: ${formatOptionalMoney(result.localEstimatedNanos)}`);
    console.log(`Provider billed cost: $${formatMoneyNanos(result.providerBilledNanos)}`);
    console.log(`Difference: ${formatOptionalMoney(result.differenceNanos)}`);
    console.log(`Estimated coverage: ${(result.estimatedCoverage.eventCoverageRatio * 100).toFixed(1)}%`);
    console.log(`Unpriced local events: ${result.unpricedEvents}`);
  } finally {
    await storage?.close();
    releaseLock();
  }
}

export async function showDoctor(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfigFromArgs(cliArgs);
  const pricing = await loadPricing({ offline: true, aliases: config.pricing.aliases });
  const releaseLock = acquireDatabaseLock(config.storage.database_path, "doctor command");
  let storage: SqliteUsageStorage | null = null;
  try {
    backupLegacyFilesBeforeFirstDatabaseUse(config.storage.database_path);
    storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();
    const report = await runDoctor(config, storage, pricing);
    if (hasFlag(cliArgs, ["--json"])) {
      console.log(JSON.stringify(report));
    } else {
      for (const check of report.checks) {
        console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}`);
      }
    }
    if (!report.ok) {
      throw new Error("doctor found database or delivery errors");
    }
  } finally {
    await storage?.close();
    releaseLock();
  }
}

export async function manageNotifications(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const commandIndex = cliArgs.findIndex((arg) => arg === "notifications");
  if (cliArgs[commandIndex + 1] !== "reset") {
    throw new Error("usage: cceye notifications reset");
  }
  const state = loadState();
  clearNotificationFlags(state);
  saveState(state);
  console.log("Notification cooldown state reset.");
}

export async function manageAlerts(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const commandIndex = cliArgs.findIndex((arg) => arg === "alerts");
  if (cliArgs[commandIndex + 1] !== "retry") {
    throw new Error("usage: cceye alerts retry DELIVERY_ID");
  }
  const deliveryId = cliArgs[commandIndex + 2];
  if (!deliveryId || deliveryId.startsWith("-")) {
    throw new Error("usage: cceye alerts retry DELIVERY_ID");
  }
  const config = loadConfigFromArgs(cliArgs);
  const releaseLock = acquireDatabaseLock(config.storage.database_path, "alert retry command");
  let storage: SqliteUsageStorage | null = null;
  try {
    backupLegacyFilesBeforeFirstDatabaseUse(config.storage.database_path);
    storage = new SqliteUsageStorage(config.storage.database_path);
    await storage.migrate();
    const retried = await storage.retryDelivery(deliveryId);
    printJsonOrText(
      cliArgs,
      { deliveryId, retried },
      retried ? `Delivery ${deliveryId} queued for retry.` : `Delivery ${deliveryId} was not found or is already delivered.`
    );
  } finally {
    await storage?.close();
    releaseLock();
  }
}

export async function notifyTest(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const commandIndex = cliArgs.findIndex((arg) => arg === "notify");
  if (cliArgs[commandIndex + 1] !== "test") {
    throw new Error("usage: cceye notify test [--channel CHANNEL]");
  }
  const config = loadConfigFromArgs(cliArgs);
  const router = new NotificationRouter(config, { suppressConsole: hasFlag(cliArgs, ["--json"]) });
  const channel = readOptionValue(cliArgs, "--channel");
  if (channel && !router.channelNames().includes(channel)) {
    throw new Error(`notification channel is not configured: ${channel}`);
  }
  const alert = {
    level: "warning" as const,
    window: "daily" as const,
    currentCost: 0,
    threshold: 0,
    timestamp: new Date(),
    transition: "firing" as const,
  };
  const results = channel ? [await router.sendChannel(channel, alert)] : await router.sendDetailed(alert);
  printJsonOrText(
    cliArgs,
    { test: true, results },
    results.length === 0
      ? "No notification channels are enabled."
    : `Test notification: ${results.map((result) => `${result.channel}=${result.status}`).join(", ")}`
  );
  const failures = results.filter((result) => result.status === "failed");
  if (failures.length > 0) {
    throw new Error(`notification test failed: ${failures.map((failure) => failure.channel).join(", ")}`);
  }
}

export async function manageDatabase(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const commandIndex = cliArgs.findIndex((arg) => arg === "db");
  const subcommand = cliArgs[commandIndex + 1];
  if (subcommand !== "check" && subcommand !== "backup" && subcommand !== "rebuild") {
    throw new Error("usage: cceye db check|backup|rebuild");
  }
  const config = loadConfigFromArgs(cliArgs);
  const databasePath = config.storage.database_path;
  if (subcommand === "check") {
    if (!fs.existsSync(databasePath)) {
      printJsonOrText(cliArgs, { ok: false, message: "database not found" }, `Database not found: ${databasePath}`);
      throw new Error(`database not found: ${databasePath}`);
    }
    const releaseLock = acquireDatabaseLock(databasePath, "database check");
    let storage: SqliteUsageStorage | null = null;
    try {
      storage = new SqliteUsageStorage(databasePath);
      const result = await storage.checkIntegrity();
      printJsonOrText(cliArgs, result as unknown as Record<string, unknown>, result.ok ? "Database integrity: ok" : `Database integrity: ${result.message}`);
      if (!result.ok) {
        throw new Error(`database integrity check failed: ${result.message}`);
      }
    } finally {
      await storage?.close();
      releaseLock();
    }
    return;
  }
  if (subcommand === "backup") {
    const requested = readOptionValue(cliArgs, "--output");
    const target = await backupDatabase(databasePath, requested ? path.resolve(requested) : undefined);
    printJsonOrText(cliArgs, { databasePath, backupPath: target }, `Database backup created: ${target}`);
    return;
  }
  const pricing = await loadPricing({ aliases: config.pricing.aliases });
  const logger = createLogger(config);
  logger.silent = true;
  const result = await rebuildDatabase(config, pricing, logger);
  printJsonOrText(cliArgs, result, `Database rebuilt: ${result.databasePath}\nBackup: ${result.backupPath}`);
}

function dateRangeFromArgs(args: string[]): { fromMs: number; untilMs: number } {
  const since = parseDateFilter(readOptionValue(args, "--since"), "--since");
  const until = parseDateFilter(readOptionValue(args, "--until"), "--until");
  const now = new Date();
  const fromMs = since ? parseCompactDate(since).getTime() : now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const untilMs = until ? parseCompactDate(until).getTime() + 24 * 60 * 60 * 1000 : now.getTime() + 1;
  if (fromMs >= untilMs) {
    throw new Error("--since must be before --until");
  }
  return { fromMs, untilMs };
}

function parseCompactDate(value: string): Date {
  return new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))));
}

function formatOptionalMoney(amount: bigint | null): string {
  return amount === null ? "unavailable" : `$${formatMoneyNanos(amount)}`;
}

function printJsonOrText(args: string[], json: Record<string, unknown>, text: string): void {
  if (hasFlag(args, ["--json"])) {
    console.log(JSON.stringify(json));
    return;
  }
  console.log(text);
}

export async function initConfig(): Promise<void> {
  const configDir = path.join(os.homedir(), ".config", "cceye");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(configDir, 0o700);
  const targetPath = path.join(configDir, "config.yaml");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer));
    });

  const dataDir = await ask("Claude data dir (default ~/.claude/projects): ");
  const polling = await ask("Polling interval (milliseconds, default 300000): ");
  const timezone = await ask("Timezone (default Asia/Tokyo): ");
  const costMode = await ask("Cost mode (auto/calculate/display, default auto): ");

  rl.close();

  const normalizedPolling = Number(polling.trim() || "300000");
  const normalizedTimezone = timezone.trim() || "Asia/Tokyo";
  const normalizedCostMode = costMode.trim() || "auto";
  if (!Number.isInteger(normalizedPolling) || normalizedPolling <= 0) {
    throw new Error("polling interval must be a positive integer");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalizedTimezone }).format();
  } catch {
    throw new Error("timezone must be a valid IANA timezone");
  }
  if (!(["auto", "calculate", "display"] as const).includes(normalizedCostMode as "auto" | "calculate" | "display")) {
    throw new Error("cost mode must be auto, calculate, or display");
  }

  const templateCandidates = [
    path.join(process.cwd(), "config.example.yaml"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "config.example.yaml"),
  ];
  const templatePath = templateCandidates.find((candidate) => fs.existsSync(candidate));
  if (!templatePath) {
    throw new Error("config.example.yaml not found");
  }

  const configValue = yaml.parse(fs.readFileSync(templatePath, "utf8")) as Record<string, unknown>;
  configValue.claude_data_dir = dataDir.trim() || "~/.claude/projects";
  configValue.polling_interval_milliseconds = normalizedPolling;
  configValue.timezone = normalizedTimezone;
  configValue.cost_mode = normalizedCostMode;
  const tempPath = `${targetPath}.tmp`;
  fs.writeFileSync(
    tempPath,
    yaml.stringify(configValue, { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN" }),
    { mode: 0o600 }
  );
  fs.chmodSync(tempPath, 0o600);
  fs.renameSync(tempPath, targetPath);
  fs.chmodSync(targetPath, 0o600);

  console.log(`Config written to ${targetPath}`);
}

/* v8 ignore start */
export async function installLaunchAgent(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfigFromArgs(cliArgs);
  const logger = createLogger(config);
  if (process.platform !== "darwin") {
    logger.warn("install is only supported on macOS");
    return;
  }
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.user.cceye.plist");
  const logDir = path.join(os.homedir(), "Library", "Logs", "cceye");
  fs.mkdirSync(path.dirname(plistPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(logDir, 0o700);

  const nodePath = process.execPath;
  const scriptPath = fileURLToPath(new URL("./index.js", import.meta.url));
  const configIndex = cliArgs.findIndex((arg) => arg === "--config");
  const configPath = configIndex >= 0 ? cliArgs[configIndex + 1] : undefined;
  const resolvedConfigPath = configPath ?? path.join(os.homedir(), ".config", "cceye", "config.yaml");
  const xmlEscape = (value: string): string =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");

  if (fs.existsSync(plistPath)) {
    await runLaunchctl(["unload", plistPath]);
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.user.cceye</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>--config</string>
    <string>${xmlEscape(path.resolve(resolvedConfigPath))}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, "stdout.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, "stderr.log")}</string>
</dict>
</plist>
`;

  fs.writeFileSync(plistPath, plist, { mode: 0o600 });
  fs.chmodSync(plistPath, 0o600);
  await runLaunchctl(["load", plistPath]);
  logger.info("launch agent installed");
}
/* v8 ignore stop */

/* v8 ignore start */
export async function uninstallLaunchAgent(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfigFromArgs(cliArgs);
  const logger = createLogger(config);
  if (process.platform !== "darwin") {
    logger.warn("uninstall is only supported on macOS");
    return;
  }
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.user.cceye.plist");
  if (fs.existsSync(plistPath)) {
    await runLaunchctl(["unload", plistPath]);
    fs.unlinkSync(plistPath);
    logger.info("launch agent removed");
  }
}
/* v8 ignore stop */

/* v8 ignore start */
export async function runLaunchctl(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("launchctl", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code && code !== 0) {
        reject(new Error(`launchctl exited with ${code}`));
        return;
      }
      resolve();
    });
  });
}
/* v8 ignore stop */

/* v8 ignore start */
export function shutdown(logger: ReturnType<typeof createLogger>): void {
  logger.info("shutting down");
  process.exit(0);
}
/* v8 ignore stop */

export function isDirectRunPath(executedPath: string | undefined, moduleUrl: string): boolean {
  if (!executedPath) {
    return false;
  }

  const modulePath = fileURLToPath(moduleUrl);
  try {
    return fs.realpathSync(executedPath) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(executedPath) === path.resolve(modulePath);
  }
}

/* v8 ignore start */
const isDirectRun = isDirectRunPath(process.argv[1], import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(errorExitCode(error));
  });
}

/* v8 ignore start */
function errorExitCode(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("authentication failed")) {
    return 7;
  }
  if (message.includes("config") || message.includes("timezone")) {
    return 2;
  }
  if (message.includes("database") || message.includes("state")) {
    return 5;
  }
  if (message.includes("notification")) {
    return 6;
  }
  if (message.includes("unpriced") || message.includes("incomplete")) {
    return 4;
  }
  if (message.includes("no valid Claude data directories")) {
    return 3;
  }
  return 1;
}
/* v8 ignore stop */
/* v8 ignore stop */
