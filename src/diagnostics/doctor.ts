import fs from "fs";
import path from "path";
import { resolveClaudeDataRoots } from "../claude-data-paths.js";
import type { Config } from "../config.js";
import type { ModelPricing } from "../pricing.js";
import type { UsageStorage } from "../storage/storage.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "error";
  message: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export const runDoctor = async (
  config: Config,
  storage: UsageStorage,
  pricing?: Pick<ModelPricing, "status" | "source" | "cacheUpdatedAt">
): Promise<DoctorReport> => {
  const checks: DoctorCheck[] = [];
  checks.push({ name: "Config", status: "ok", message: "configuration schema is valid" });
  try {
    const roots = resolveClaudeDataRoots(config.claude_data_dir);
    const existingRoots = roots.filter((root) => fs.existsSync(root));
    checks.push({ name: "Claude data roots", status: existingRoots.length === roots.length && roots.length > 0 ? "ok" : "warn", message: `${existingRoots.length}/${roots.length} root(s) available` });
    const files = roots.flatMap((root) => listJsonlFiles(root));
    checks.push({ name: "JSONL files", status: files.length > 0 ? "ok" : "warn", message: `${files.length} file(s) found` });
  } catch (error) {
    checks.push({ name: "Claude data roots", status: "error", message: error instanceof Error ? error.message : String(error) });
  }

  const integrity = await storage.checkIntegrity();
  checks.push({ name: "Database integrity", status: integrity.ok ? "ok" : "error", message: integrity.message });
  const health = await storage.getLatestIngestionHealth();
  if (!health) {
    checks.push({ name: "Ingestion", status: "warn", message: "no ingestion cycle recorded" });
  } else {
    const parserErrors = health.malformedLines + health.schemaRejectedLines;
    checks.push({ name: "Ingestion", status: parserErrors > 0 ? "warn" : "ok", message: `${health.usageLines} usage lines, ${parserErrors} parser errors` });
    checks.push({ name: "Ingestion bytes", status: "ok", message: `${health.bytesRead} bytes read in ${health.durationMs}ms` });
    const lag = health.lastSuccessfulIngestionMs === null ? null : Math.max(0, Date.now() - health.lastSuccessfulIngestionMs);
    checks.push({ name: "Ingestion lag", status: lag !== null && lag < 15 * 60 * 1000 ? "ok" : "warn", message: lag === null ? "unknown" : `${Math.round(lag / 1000)}s since last successful ingestion` });
    checks.push({ name: "Duplicates", status: health.duplicateLines > 0 ? "warn" : "ok", message: `${health.duplicateLines} duplicate event(s)` });
    const summary = await storage.queryUsage({ fromMs: 0, untilMs: Date.now() + 1, basis: "estimated" });
    const unpricedModels = summary.byModel.filter((item) => item.unpricedEvents > 0).map((item) => item.key);
    checks.push({ name: "Unpriced events", status: health.unpricedEvents > 0 ? "warn" : "ok", message: unpricedModels.length > 0 ? `${health.unpricedEvents} event(s): ${unpricedModels.slice(0, 10).join(", ")}` : `${health.unpricedEvents} event(s)` });
  }
  const parent = path.dirname(config.storage.database_path);
  let writable = true;
  try {
    fs.accessSync(parent, fs.constants.W_OK);
  } catch {
    writable = false;
  }
  checks.push({ name: "Database write permission", status: writable ? "ok" : "error", message: writable ? "database directory is writable" : "database directory is not writable" });
  const deliveries = await storage.getDeliveryCounts();
  checks.push({ name: "Dead deliveries", status: deliveries.dead > 0 ? "error" : "ok", message: `${deliveries.dead} dead, ${deliveries.retrying} retrying, ${deliveries.pending} pending` });
  checks.push({ name: "Pricing", status: pricing?.status === "fresh" ? "ok" : pricing?.status ? "warn" : "warn", message: pricing ? `${pricing.status}${pricing.source ? ` (${pricing.source})` : ""}` : "status unavailable" });
  if (pricing?.cacheUpdatedAt) {
    const ageHours = Math.max(0, Date.now() - pricing.cacheUpdatedAt) / (60 * 60 * 1000);
    checks.push({ name: "Pricing cache age", status: ageHours <= 24 ? "ok" : "warn", message: `${ageHours.toFixed(1)}h` });
  } else {
    checks.push({ name: "Pricing cache age", status: "warn", message: "unavailable" });
  }
  const enabledChannels = Object.entries(config.notifications).filter(([, value]) => value.enabled).map(([name]) => name);
  checks.push({ name: "Notifications", status: enabledChannels.length > 0 ? "ok" : "warn", message: enabledChannels.length > 0 ? enabledChannels.join(", ") : "no channels enabled" });
  checks.push({ name: "Billing", status: config.billing.anthropic.enabled ? "ok" : "warn", message: config.billing.anthropic.enabled ? "enabled (manual sync)" : "disabled" });
  if (process.platform === "darwin") {
    const plistPath = path.join(process.env.HOME ?? "", "Library", "LaunchAgents", "com.user.cceye.plist");
    const configured = fs.existsSync(plistPath) && fs.readFileSync(plistPath, "utf8").includes(config.storage.database_path);
    checks.push({ name: "LaunchAgent config", status: configured ? "ok" : "warn", message: configured ? "installed with current database path" : "not installed or path differs" });
  }
  return { checks, ok: checks.every((check) => check.status !== "error") };
};

const listJsonlFiles = (root: string): string[] => {
  if (!fs.existsSync(root)) {
    return [];
  }
  const results: string[] = [];
  const stack: Array<{ directory: string; depth: number }> = [{ directory: path.resolve(root), depth: 0 }];
  const maxDepth = 32;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of fs.readdirSync(current.directory, { withFileTypes: true })) {
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ directory: fullPath, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }
  return results;
};
