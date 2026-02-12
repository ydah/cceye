import fs from "fs";
import path from "path";
import type { Config } from "./config.js";
import { calculateCost } from "./cost-calculator.js";
import { parseSessionFile, scanSessionFiles, type UsageEntry } from "./log-parser.js";
import type { ModelPricing } from "./pricing.js";
import type { State } from "./state-store.js";

export async function collectUsageEntries(
  config: Config,
  state: State,
  pricing: ModelPricing,
  logger: {
    warn(message: string): void;
  }
): Promise<UsageEntry[]> {
  const files = await scanSessionFiles(config.claude_data_dir);
  const allEntries: UsageEntry[] = [];
  const processedHashes = new Set<string>();

  for (const file of files) {
    const stat = fs.statSync(file);
    const key = path.relative(config.claude_data_dir, file);
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
      allEntries.push(entry);
    }

    state.fileIndex[key] = {
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      parsedBytes: stat.size,
    };
  }

  if (!files.length) {
    logger.warn(`no session logs found in ${config.claude_data_dir}`);
  }

  return allEntries;
}
