import fs from "fs";
import path from "path";
import { createUsageEventId } from "./event-id.js";
import { identifySourceFile } from "./file-identity.js";
import { readJsonlIncrementally } from "./jsonl-reader.js";
import { parseUsageLine, scanSessionFiles, type UsageEntry } from "../log-parser.js";
import type { Config } from "../config.js";
import { resolveClaudeDataRoots } from "../claude-data-paths.js";
import { calculateCostExact } from "../cost-calculator.js";
import type { ModelPricing } from "../pricing.js";
import type { EventCost, FileCursor, NormalizedUsageEvent, UsageStorage } from "../storage/storage.js";

export interface IngestionMetrics {
  scannedFiles: number;
  changedFiles: number;
  bytesRead: number;
  parsedLines: number;
  usageLines: number;
  malformedLines: number;
  schemaRejectedLines: number;
  duplicateLines: number;
  unpricedEvents: number;
  lastSuccessfulIngestionMs: number | null;
  durationMs: number;
}

export interface IncrementalCollectionResult {
  entries: UsageEntry[];
  metrics: IngestionMetrics;
}

export const collectUsageIncrementally = async (
  config: Config,
  storage: UsageStorage,
  pricing: ModelPricing,
  logger: { warn(message: string): void }
): Promise<IncrementalCollectionResult> => {
  const startedAt = Date.now();
  const roots = resolveClaudeDataRoots(config.claude_data_dir);
  const entries: UsageEntry[] = [];
  const events: NormalizedUsageEvent[] = [];
  const costs: EventCost[] = [];
  const cursors: FileCursor[] = [];
  const metrics: IngestionMetrics = {
    scannedFiles: 0,
    changedFiles: 0,
    bytesRead: 0,
    parsedLines: 0,
    usageLines: 0,
    malformedLines: 0,
    schemaRejectedLines: 0,
    duplicateLines: 0,
    unpricedEvents: 0,
    lastSuccessfulIngestionMs: null,
    durationMs: 0,
  };

  for (const root of roots) {
    const files = await scanSessionFiles(root);
    metrics.scannedFiles += files.length;
    for (const file of files) {
      const stat = fs.statSync(file);
      const identity = identifySourceFile(file);
      const previous = await storage.getFileCursor(identity);
      const isTruncated = previous !== null && stat.size < previous.committedOffset;
      const generation = isTruncated ? previous.generation + 1 : previous?.generation ?? 0;
      const startOffset = isTruncated ? 0 : previous?.committedOffset ?? 0;
      if (!isTruncated && previous && stat.size === previous.size && stat.mtimeMs === previous.mtimeMs) {
        continue;
      }

      metrics.changedFiles += 1;
      const read = await readJsonlIncrementally(file, startOffset);
      metrics.bytesRead += read.bytesRead;
      metrics.parsedLines += read.records.length + read.rejected.length;
      metrics.malformedLines += read.rejected.length;
      const project = extractProject(root, file);
      const session = extractSession(root, file);

      for (const record of read.records) {
        const entry = parseUsageLine(record.line);
        if (!entry) {
          metrics.malformedLines += 1;
          continue;
        }
        metrics.usageLines += 1;
        entry.project = project;
        entry.session = session;
        entries.push(entry);
        const eventId = createUsageEventId({
          sourceKind: identity.sourceKind,
          messageId: entry.messageId,
          requestId: entry.requestId,
          sessionId: session,
          timestamp: entry.timestamp.toISOString(),
          rawLine: record.line,
        });
        const ingestedAtMs = Date.now();
        events.push({
          eventId,
          source: identity,
          generation,
          occurredAtMs: entry.timestamp.getTime(),
          project,
          session,
          modelRaw: entry.model,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          cacheCreationTokens: entry.cacheCreationTokens,
          cacheReadTokens: entry.cacheReadTokens,
          reportedCostNanos: toMoneyNanos(entry.costUSD),
          schemaFingerprint: null,
          ingestedAtMs,
        });
        const estimated = calculateCostExact(entry, "calculate", pricing);
        if (estimated === null) {
          metrics.unpricedEvents += 1;
        } else {
          costs.push({
            eventId,
            basis: "estimated",
            amountNanos: toMoneyNanos(estimated),
            currency: "USD",
            priceSource: pricing.source ?? null,
            priceCatalogHash: null,
            matchedModel: pricing.explain?.(entry.model).matchedModel ?? entry.model,
            matchType: pricing.explain?.(entry.model).matchType ?? "unknown",
            calculatedAtMs: ingestedAtMs,
          });
        }
        const hybrid =
          config.cost_mode === "display"
            ? entry.costUSD
            : config.cost_mode === "calculate"
              ? estimated
              : entry.costUSD ?? estimated;
        costs.push({
          eventId,
          basis: "hybrid",
          amountNanos: toMoneyNanos(hybrid),
          currency: "USD",
          priceSource: hybrid === entry.costUSD ? "reported" : pricing.source ?? null,
          priceCatalogHash: null,
          matchedModel: entry.model,
          matchType: hybrid === entry.costUSD ? "reported" : pricing.explain?.(entry.model).matchType ?? "unknown",
          calculatedAtMs: ingestedAtMs,
        });
      }

      cursors.push({
        ...identity,
        generation,
        committedOffset: read.committedOffset,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        status: "active",
        lastSeenAtMs: Date.now(),
      });
    }
  }

  if (metrics.scannedFiles === 0) {
    logger.warn(`no session logs found in any of the ${roots.length} configured root(s)`);
  }
  const result = await storage.ingestBatch({ events, costs, cursors });
  metrics.duplicateLines = result.duplicates;
  metrics.lastSuccessfulIngestionMs = Date.now();
  metrics.durationMs = Date.now() - startedAt;
  await storage.recordIngestionHealth(metrics);
  return { entries, metrics };
};

const toMoneyNanos = (value: number | null): bigint | null =>
  value === null || !Number.isFinite(value) ? null : BigInt(Math.round(value * 1_000_000_000));

const extractProject = (root: string, file: string): string => {
  const [project] = path.relative(root, file).split(path.sep);
  return project && project.length > 0 ? project : "unknown";
};

const extractSession = (root: string, file: string): string => {
  const parts = path.relative(root, file).split(path.sep).filter(Boolean);
  if (parts.length >= 3) {
    return parts.at(-2) ?? "unknown";
  }
  return path.basename(file, path.extname(file)) || "unknown";
};
