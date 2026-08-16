#!/usr/bin/env node
import fs from "fs";
import { spawn } from "child_process";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import yaml from "yaml";
import { loadConfigFromArgs, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { evaluateThresholds } from "./threshold-engine.js";
import { NotificationRouter } from "./notifiers/index.js";
import {
  clearNotificationFlags,
  loadState,
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
} from "./data-store.js";
import { Scheduler } from "./scheduler.js";
import { Dashboard } from "./dashboard/index.js";
import { loadPricing } from "./pricing.js";
import { periodRange } from "./aggregator.js";
import { collectUsageEntries } from "./usage-collector.js";
import { collectUsageIncrementally } from "./ingestion/incremental-collector.js";
import { SqliteUsageStorage } from "./storage/sqlite-storage.js";
import type { UsageStorage, UsageSummary } from "./storage/storage.js";
import { hourlyTrend, nextPoll, toModelBreakdown, toProjectBreakdown } from "./polling-metrics.js";
import { buildReportRows, printReportRows, type ReportCommand, type ReportOptions } from "./reporting.js";

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
  dashboard    Start the terminal dashboard
  init         Create a configuration file
  install      Install the macOS LaunchAgent
  uninstall    Remove the macOS LaunchAgent

Options:
  --config PATH  Use a custom configuration file
  --json         Emit machine-readable output where supported
  --offline      Do not fetch pricing data
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
  const optionWithValue = new Set(["--config", "--since", "--until", "--timezone"]);
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
  const pricing = await loadPricing();
  const storage = new SqliteUsageStorage(config.storage.database_path);
  await storage.migrate();
  let dashboardRef: Dashboard | undefined;
  let pollInFlight = false;
  const runPoll = async (): Promise<void> => {
    if (pollInFlight) {
      logger.warn("previous poll still running, skipping this cycle");
      return;
    }
    pollInFlight = true;
    try {
      await pollOnce(config, pricing, router, logger, options.dashboard, dashboardRef, true, storage);
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
    void storage.close();
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    shutdown(logger);
  };

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
  if (!storage) {
    await ledger.migrate();
  }
  const state = loadState();
  resetWindowIfNeeded(state, config.timezone);

  const collection = await collectUsageIncrementally(config, ledger, pricing, logger);
  const entries = collection.entries;
  const basis = config.cost_mode === "display" ? "reported" : config.cost_mode === "calculate" ? "estimated" : "hybrid";
  const daily = toAggregatedCost(await ledger.queryUsage({ ...periodRange("daily", config.timezone), basis }));
  const weekly = toAggregatedCost(await ledger.queryUsage({ ...periodRange("weekly", config.timezone), basis }));
  const monthly = toAggregatedCost(await ledger.queryUsage({ ...periodRange("monthly", config.timezone), basis }));

  const results = evaluateThresholds(
    { daily: daily.total, weekly: weekly.total, monthly: monthly.total },
    config.thresholds
  );

  for (const result of results) {
    if (!result.level || result.threshold === null) {
      continue;
    }

    if (!sendNotifications) {
      continue;
    }

    const notify = shouldNotify(result.window, result.level, state, config.notification_cooldown_minutes);
    if (!notify) {
      continue;
    }

    const alert = {
      level: result.level,
      window: result.window,
      currentCost: result.currentCost,
      threshold: result.threshold,
      timestamp: new Date(),
    };

    const deliveryResults = await router.sendDetailed(alert);
    const channels = deliveryResults
      .filter((delivery) => delivery.status === "success")
      .map((delivery) => delivery.channel);
    for (const delivery of deliveryResults) {
      if (delivery.status === "failed") {
        logger.error(`notification ${delivery.channel} failed: ${delivery.error}`);
      }
    }
    if (channels.length > 0) {
      recordNotification(state, {
        timestamp: alert.timestamp.toISOString(),
        window: result.window,
        level: result.level,
        cost: result.currentCost,
        threshold: result.threshold,
      });
    }

    const data = loadData();
    addNotificationHistory(data, {
      timestamp: alert.timestamp.toISOString(),
      level: result.level,
      window: result.window,
      currentCost: result.currentCost,
      threshold: result.threshold,
      channels,
      deliveryResults,
    });
    saveData(data);
  }

  updateLastPoll(state);
  saveState(state);

  const data = loadData();
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
  if (entries.length > 0) {
    updateHourlyTrend(data, hourlyTrend(entries));
  }
  markUpdated(data);
  saveData(data);

  if (dashboardMode) {
    const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
    dashboard?.update(data, config, lastUpdated, nextPoll(config.polling_interval_milliseconds));
  }

  logger.info("polling cycle completed");
  if (!storage) {
    await ledger.close();
  }
}

function toAggregatedCost(summary: UsageSummary): {
  total: number;
  byModel: Record<string, number>;
  byProject: Record<string, number>;
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

const nanosToNumber = (amount: bigint | null): number => (amount === null ? 0 : Number(amount) / 1_000_000_000);

export async function showStatus(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfigFromArgs(cliArgs);
  const logger = createLogger(config);
  const pricing = await loadPricing();
  const storage = new SqliteUsageStorage(config.storage.database_path);
  await storage.migrate();
  await pollOnce(config, pricing, new NotificationRouter(config), logger, false, undefined, false, storage);
  await storage.close();
  const data = loadData();
  const output = {
    daily: data.currentCosts.daily,
    weekly: data.currentCosts.weekly,
    monthly: data.currentCosts.monthly,
  };
  if (hasFlag(cliArgs, ["--json"])) {
    console.log(JSON.stringify(output));
    return;
  }
  console.log(
    `Daily: $${output.daily.toFixed(2)}, Weekly: $${output.weekly.toFixed(2)}, Monthly: $${output.monthly.toFixed(2)}`
  );
}

export async function showReport(command: ReportCommand, cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const since = parseDateFilter(readOptionValue(cliArgs, "--since"), "--since");
  const until = parseDateFilter(readOptionValue(cliArgs, "--until"), "--until");
  const reportTimezone = readOptionValue(cliArgs, "--timezone");
  const json = hasFlag(cliArgs, ["--json"]);
  const breakdown = hasFlag(cliArgs, ["--breakdown"]);
  const offline = hasFlag(cliArgs, ["--offline"]);

  const configArgs = removeOptionPair(removeOptionPair(cliArgs, "--since"), "--until");
  const config = loadConfigFromArgs(configArgs);
  const pricing = await loadPricing({ offline });
  const state = loadState();
  const logger = createLogger(config);
  const entries = await collectUsageEntries(config, state, pricing, logger);

  const reportOptions: ReportOptions = {
    json,
    breakdown,
    timezone: reportTimezone ?? config.timezone,
  };
  if (since !== undefined) {
    reportOptions.since = since;
  }
  if (until !== undefined) {
    reportOptions.until = until;
  }

  const rows = buildReportRows(entries, command, reportOptions);
  printReportRows(rows, reportOptions);
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
  configValue.polling_interval_milliseconds = Number(polling.trim() || "300000");
  configValue.timezone = timezone.trim() || "Asia/Tokyo";
  configValue.cost_mode = costMode.trim() || "auto";
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
  fs.mkdirSync(logDir, { recursive: true });

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
    process.exit(1);
  });
}
/* v8 ignore stop */
