import { setTimeout as delay } from "timers/promises";
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
    "User-Agent": "cceye/1.0.0",
  };

  try {
    const response = await fetch(url, { headers });
    if (response.status === 401 || response.status === 403) {
      throw new Error("authentication failed (check Admin API key)");
    }

    if (response.status === 429) {
      if (attempt >= 3) {
        throw new Error("rate limit exceeded after retries");
      }
      const retryAfter = response.headers.get("retry-after");
      const waitMs = retryAfter ? Number(retryAfter) * 1000 : 1000 * Math.pow(2, attempt);
      await delay(waitMs);
      return fetchWithRetry(url, adminApiKey, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(`cost report API error: ${response.status}`);
    }

    return response;
  } catch (error) {
    if (attempt >= 3) {
      throw error;
    }
    await delay(1000 * Math.pow(2, attempt));
    return fetchWithRetry(url, adminApiKey, attempt + 1);
  }
}
