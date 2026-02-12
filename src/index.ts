#!/usr/bin/env node
import fs from "fs";
import { spawn } from "child_process";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
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
} from "./data-store.js";
import { Scheduler } from "./scheduler.js";
import { Dashboard } from "./dashboard/index.js";
import { loadPricing } from "./pricing.js";
import { aggregateByPeriod } from "./aggregator.js";
import { collectUsageEntries } from "./usage-collector.js";
import { hourlyTrend, nextPoll, toModelBreakdown } from "./polling-metrics.js";

export { collectUsageEntries, hourlyTrend, nextPoll, toModelBreakdown };

const daemonDebugFlags = ["--debug", "-d"];

export async function main(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  if (hasFlag(cliArgs, ["--version", "-v"])) {
    console.log(readPackageVersion());
    return;
  }
  resetNotificationFlagsAtStartupIfNeeded(cliArgs);

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
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string") {
      continue;
    }
    if (arg === "--config") {
      i += 1;
      continue;
    }
    if (isDebugFlag(arg)) {
      continue;
    }
    return arg;
  }
  return undefined;
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
  let dashboardRef: Dashboard | undefined;

  const scheduler = new Scheduler(config.polling_interval_milliseconds, async () => {
    await pollOnce(config, pricing, router, logger, options.dashboard, dashboardRef);
  }, logger);

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
    dashboardRef?.destroy();
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
      pollOnce(config, pricing, router, logger, true, dashboardRef).catch((error) => logger.error(String(error)));
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
  sendNotifications = true
): Promise<void> {
  const state = loadState();
  resetWindowIfNeeded(state, config.timezone);

  const entries = await collectUsageEntries(config, state, pricing, logger);

  const daily = aggregateByPeriod(entries, "daily", config.timezone);
  const weekly = aggregateByPeriod(entries, "weekly", config.timezone);
  const monthly = aggregateByPeriod(entries, "monthly", config.timezone);

  const results = evaluateThresholds(
    { daily: daily.total, weekly: weekly.total, monthly: monthly.total },
    config.thresholds
  );

  for (const result of results) {
    if (!result.level || !result.threshold) {
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

    const channels = await router.send(alert);
    recordNotification(state, {
      timestamp: alert.timestamp.toISOString(),
      window: result.window,
      level: result.level,
      cost: result.currentCost,
      threshold: result.threshold,
    });

    const data = loadData();
    addNotificationHistory(data, {
      timestamp: alert.timestamp.toISOString(),
      level: result.level,
      window: result.window,
      currentCost: result.currentCost,
      threshold: result.threshold,
      channels,
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
  updateHourlyTrend(data, hourlyTrend(entries));
  markUpdated(data);
  saveData(data);

  if (dashboardMode) {
    const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
    dashboard?.update(data, config, lastUpdated, nextPoll(config.polling_interval_milliseconds));
  }

  logger.info("polling cycle completed");
}

export async function showStatus(cliArgs: string[] = process.argv.slice(2)): Promise<void> {
  const config = loadConfigFromArgs(cliArgs);
  const logger = createLogger(config);
  const pricing = await loadPricing();
  await pollOnce(config, pricing, new NotificationRouter(config), logger, false, undefined, false);
  const data = loadData();
  logger.info(
    `Daily: $${data.currentCosts.daily.toFixed(2)}, Weekly: $${data.currentCosts.weekly.toFixed(
      2
    )}, Monthly: $${data.currentCosts.monthly.toFixed(2)}`
  );
}

export async function initConfig(): Promise<void> {
  const configDir = path.join(os.homedir(), ".config", "cceye");
  fs.mkdirSync(configDir, { recursive: true });
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

  const template = fs.readFileSync(templatePath, "utf8");
  const content = template
    .replace("claude_data_dir: \"~/.claude/projects\"", `claude_data_dir: "${dataDir.trim() || "~/.claude/projects"}"`)
    .replace(/polling_interval_(?:minutes|milliseconds):\s+\d+/, `polling_interval_milliseconds: ${polling.trim() || "300000"}`)
    .replace("timezone: \"Asia/Tokyo\"", `timezone: "${timezone.trim() || "Asia/Tokyo"}"`)
    .replace("cost_mode: \"auto\"", `cost_mode: "${costMode.trim() || "auto"}"`);

  fs.writeFileSync(targetPath, content);
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
  fs.mkdirSync(logDir, { recursive: true });

  const nodePath = process.execPath;
  const scriptPath = fileURLToPath(new URL("./index.js", import.meta.url));

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

  fs.writeFileSync(plistPath, plist);
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
  } else {
    logger.warn("launch agent not found");
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
