import { setTimeout as delay } from "timers/promises";
import fs from "fs";
import { z } from "zod";
import { formatIsoUtc } from "./utils.js";

export type BucketWidth = "1m" | "1h" | "1d";

const costReportResultSchema = z
  .object({
    currency: z.string().optional(),
    amount: z.union([z.string(), z.number()]).optional().default("0"),
    description: z.string().optional(),
    cost_type: z.string().optional(),
    model: z.string().optional(),
  })
  .passthrough();

const costReportBucketSchema = z
  .object({
    starting_at: z.string().optional(),
    ending_at: z.string().optional(),
    results: z.array(costReportResultSchema).optional().default([]),
  })
  .passthrough();

const costReportResponseSchema = z
  .object({
    data: z.array(costReportBucketSchema).optional().default([]),
    has_more: z.boolean().optional(),
    next_page: z.string().optional(),
  })
  .passthrough();

export type CostReportResponse = z.infer<typeof costReportResponseSchema>;

export async function fetchCostForPeriod(
  adminApiKey: string,
  startingAt: Date,
  endingAt: Date,
  bucketWidth: BucketWidth,
  options?: { groupByDescription?: boolean }
): Promise<number> {
  let total = 0;
  let nextPage: string | undefined;
  const seenPages = new Set<string>();

  do {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", formatIsoUtc(startingAt));
    url.searchParams.set("ending_at", formatIsoUtc(endingAt));
    url.searchParams.set("bucket_width", bucketWidth);
    url.searchParams.set("limit", "100");
    if (options?.groupByDescription) {
      url.searchParams.append("group_by[]", "description");
    }
    if (nextPage) {
      if (seenPages.has(nextPage)) {
        throw new Error("cost report API returned a repeated page token");
      }
      seenPages.add(nextPage);
      url.searchParams.set("page", nextPage);
    }

    const response = await fetchWithRetry(url.toString(), adminApiKey, 0);
    const payload = parseCostReportResponse(await response.json());
    for (const bucket of payload.data) {
      for (const item of bucket.results) {
        const amount = typeof item.amount === "number" ? item.amount : parseFloat(item.amount);
        if (!Number.isNaN(amount)) {
          total += amount;
        }
      }
    }

    nextPage = payload.has_more ? payload.next_page : undefined;
  } while (nextPage);

  return total;
}

export async function fetchCostReport(
  adminApiKey: string,
  startingAt: Date,
  endingAt: Date,
  bucketWidth: BucketWidth,
  options?: { groupByDescription?: boolean }
): Promise<CostReportResponse> {
  const data: CostReportResponse = { data: [] };
  let nextPage: string | undefined;
  const seenPages = new Set<string>();

  do {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", formatIsoUtc(startingAt));
    url.searchParams.set("ending_at", formatIsoUtc(endingAt));
    url.searchParams.set("bucket_width", bucketWidth);
    url.searchParams.set("limit", "100");
    if (options?.groupByDescription) {
      url.searchParams.append("group_by[]", "description");
    }
    if (nextPage) {
      if (seenPages.has(nextPage)) {
        throw new Error("cost report API returned a repeated page token");
      }
      seenPages.add(nextPage);
      url.searchParams.set("page", nextPage);
    }

    const response = await fetchWithRetry(url.toString(), adminApiKey, 0);
    const payload = parseCostReportResponse(await response.json());
    data.data.push(...payload.data);
    nextPage = payload.has_more ? payload.next_page : undefined;
  } while (nextPage);

  return data;
}

function parseCostReportResponse(payload: unknown): CostReportResponse {
  const parsed = costReportResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("invalid cost report API response format");
  }
  return parsed.data;
}

async function fetchWithRetry(url: string, adminApiKey: string, attempt: number): Promise<Response> {
  const headers = {
    "anthropic-version": "2023-06-01",
    "x-api-key": adminApiKey,
    "User-Agent": `cceye/${readPackageVersion()}`,
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    timeout.unref?.();
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError("authentication failed (check Admin API key)");
      }

      if (response.status === 429) {
        if (attempt >= 3) {
          throw new Error("rate limit exceeded after retries");
        }
        const retryAfter = response.headers.get("retry-after");
        const parsedRetryAfter = retryAfter ? Number(retryAfter) * 1000 : Number.NaN;
        const fallback = 1_000 * 2 ** attempt;
        const waitMs = Number.isFinite(parsedRetryAfter) && parsedRetryAfter >= 0 ? Math.min(parsedRetryAfter, 60_000) : fallback;
        const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(waitMs * 0.2)));
        await delay(waitMs + jitter);
        return fetchWithRetry(url, adminApiKey, attempt + 1);
      }

      if (!response.ok) {
        throw new Error(`cost report API error: ${response.status}`);
      }

      return response;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw error;
    }
    if (attempt >= 3) {
      throw error;
    }
    await delay(1000 * Math.pow(2, attempt));
    return fetchWithRetry(url, adminApiKey, attempt + 1);
  }
}

class AuthenticationError extends Error {}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}
