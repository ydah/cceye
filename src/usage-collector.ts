import fs from "fs";
import path from "path";
import type { Config } from "./config.js";
import { resolveClaudeDataRoots } from "./claude-data-paths.js";
import { calculateCost } from "./cost-calculator.js";
import { parseSessionFile, scanSessionFiles, type UsageEntry } from "./log-parser.js";
import type { ModelPricing } from "./pricing.js";
import type { State } from "./state-store.js";
import { sanitizeDisplayLabel } from "./utils.js";

function toFileIndexKey(rootCount: number, rootIndex: number, root: string, file: string): string {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (rootCount === 1) {
    return relative;
  }
  return `${rootIndex}::${relative}`;
}

function extractProjectFromFile(root: string, file: string): string {
  const relative = path.relative(root, file);
  const [project] = relative.split(path.sep);
  return project && project.length > 0 ? project : "unknown";
}

function extractSessionFromFile(root: string, file: string): string {
  const relative = path.relative(root, file);
  const parts = relative.split(path.sep).filter((part) => part.length > 0);
  if (parts.length >= 3) {
    return parts[parts.length - 2] ?? "unknown";
  }
  const base = path.basename(file, path.extname(file));
  return base.length > 0 ? base : "unknown";
}

export async function collectUsageEntries(
  config: Config,
  state: State,
  pricing: ModelPricing,
  logger: {
    warn(message: string): void;
  }
): Promise<UsageEntry[]> {
  const roots = resolveClaudeDataRoots(config.claude_data_dir);
  const allEntries: UsageEntry[] = [];
  const processedHashes = new Set<string>();
  let scannedFileCount = 0;

  for (const [rootIndex, root] of roots.entries()) {
    const files = await scanSessionFiles(root);
    scannedFileCount += files.length;

    for (const file of files) {
      const stat = fs.statSync(file);
      const key = toFileIndexKey(roots.length, rootIndex, root, file);
      const project = sanitizeDisplayLabel(extractProjectFromFile(root, file));
      const session = sanitizeDisplayLabel(extractSessionFromFile(root, file));
      const { entries } = await parseSessionFile(file, 0);
      for (const entry of entries) {
        const uniqueHash =
          entry.messageId !== null && entry.requestId !== null ? `${entry.messageId}:${entry.requestId}` : null;
        if (uniqueHash !== null) {
          if (processedHashes.has(uniqueHash)) {
            continue;
          }
          processedHashes.add(uniqueHash);
        }
        const cost = calculateCost(entry, config.cost_mode, pricing);
        entry.costUSD = cost;
        entry.project = project;
        entry.session = session;
        allEntries.push(entry);
      }

      state.fileIndex[key] = {
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        parsedBytes: stat.size,
      };
    }
  }

  if (scannedFileCount === 0) {
    logger.warn(`no session logs found in any of the ${roots.length} configured root(s)`);
  }

  return allEntries;
}
