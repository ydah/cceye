import fs from "fs";
import path from "path";
import readline from "readline";
import { z } from "zod";

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
  const stack = [rootDir];

  while (stack.length) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
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
    if (!line.trim()) {
      continue;
    }
    try {
      const parsedLine = sessionLineSchema.safeParse(JSON.parse(line) as unknown);
      if (!parsedLine.success) {
        continue;
      }

      const parsed = parsedLine.data;
      const usage = parsed.message?.usage;
      if (!usage) {
        continue;
      }

      const totalCacheCreation =
        typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens
          : 0;
      const cacheReadTokens = typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
      const timestamp = new Date(parsed.timestamp);
      if (Number.isNaN(timestamp.getTime())) {
        continue;
      }

      entries.push({
        timestamp,
        model:
          typeof parsed.message?.model === "string"
            ? parsed.message.model
            : typeof parsed.model === "string"
              ? parsed.model
              : "unknown",
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheCreationTokens: totalCacheCreation,
        cacheReadTokens,
        messageId: typeof parsed.message?.id === "string" ? parsed.message.id : null,
        requestId: typeof parsed.requestId === "string" ? parsed.requestId : null,
        costUSD: toOptionalNumber(parsed.costUSD),
      });
    } catch {
      continue;
    }
  }

  return { entries, parsedBytes };
}
