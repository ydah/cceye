import fs from "fs";
import path from "path";
import readline from "readline";
import { z } from "zod";
import { sanitizeDisplayLabel } from "./utils.js";

export interface UsageEntry {
  timestamp: Date;
  model: string;
  project?: string;
  session?: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  messageId: string | null;
  requestId: string | null;
  costUSD: number | null;
}

export type UsageLineErrorReason =
  | "empty_line"
  | "invalid_json"
  | "schema_rejected"
  | "missing_usage"
  | "invalid_timestamp";

export interface UsageLineParseResult {
  entry: UsageEntry | null;
  reason?: UsageLineErrorReason;
}

export interface FileIndexEntry {
  size: number;
  mtime: string;
  parsedBytes: number;
}

const usageSchema = z
  .object({
    input_tokens: z.preprocess(toTokenNumber, z.number()),
    output_tokens: z.preprocess(toTokenNumber, z.number()),
    cache_creation_input_tokens: z.preprocess(toTokenNumber, z.number()).optional(),
    cache_read_input_tokens: z.preprocess(toTokenNumber, z.number()).optional(),
  })
  .passthrough();

const maxScanDepth = 32;

function toTokenNumber(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

const sessionLineSchema = z
  .object({
    timestamp: z.string(),
    model: z.unknown().optional(),
    message: z
      .object({
        usage: usageSchema.optional(),
        model: z.unknown().optional(),
        id: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    requestId: z.unknown().optional(),
    costUSD: z.unknown().optional(),
  })
  .passthrough();

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function scanSessionFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const stack: Array<{ directory: string; depth: number }> = [{ directory: rootDir, depth: 0 }];

  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < maxScanDepth) {
        stack.push({ directory: fullPath, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

export async function parseSessionFile(
  filePath: string,
  startOffset = 0
): Promise<{ entries: UsageEntry[]; parsedBytes: number }> {
  const entries: UsageEntry[] = [];
  let parsedBytes = startOffset;

  const stream = fs.createReadStream(filePath, { encoding: "utf8", start: startOffset });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    parsedBytes += Buffer.byteLength(line, "utf8") + 1;
    const entry = parseUsageLine(line);
    if (entry) {
      entries.push(entry);
    }
  }

  return { entries, parsedBytes };
}

export function parseUsageLine(line: string | Buffer): UsageEntry | null {
  return parseUsageLineDetailed(line).entry;
}

export function parseUsageLineDetailed(line: string | Buffer): UsageLineParseResult {
  const text = typeof line === "string" ? line : line.toString("utf8");
  if (!text.trim()) {
    return { entry: null, reason: "empty_line" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return { entry: null, reason: "invalid_json" };
  }
  const parsedLine = sessionLineSchema.safeParse(raw);
  if (!parsedLine.success) {
    return { entry: null, reason: "schema_rejected" };
  }

  const parsed = parsedLine.data;
  const usage = parsed.message?.usage;
  if (!usage) {
    return { entry: null, reason: "missing_usage" };
  }

  const timestamp = new Date(parsed.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    return { entry: null, reason: "invalid_timestamp" };
  }

  return {
    entry: {
      timestamp,
      model: sanitizeDisplayLabel(
        typeof parsed.message?.model === "string"
          ? parsed.message.model
          : typeof parsed.model === "string"
            ? parsed.model
            : "unknown"
      ),
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens:
        typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0,
      cacheReadTokens: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
      messageId: typeof parsed.message?.id === "string" ? parsed.message.id : null,
      requestId: typeof parsed.requestId === "string" ? parsed.requestId : null,
      costUSD: toOptionalNumber(parsed.costUSD),
    },
  };
}
