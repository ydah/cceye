import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("timers/promises", () => ({
  setTimeout: vi.fn(async () => undefined),
}));

function response(options: {
  ok?: boolean;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  return {
    ok: options.ok ?? (options.status >= 200 && options.status < 300),
    status: options.status,
    headers: {
      get: (name: string) => options.headers?.[name.toLowerCase()] ?? null,
    } as Headers,
    json: async () => options.body ?? {},
  } as unknown as Response;
}

describe("cost-fetcher", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches paginated total cost", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        response({
          status: 200,
          body: {
            data: [{ results: [{ amount: "1.5" }, { amount: "bad" }] }],
            has_more: true,
            next_page: "p2",
          },
        })
      )
      .mockResolvedValueOnce(
        response({
          status: 200,
          body: {
            data: [{ results: [{ amount: "2.25" }] }],
            has_more: false,
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchCostForPeriod } = await import("../src/cost-fetcher.ts");
    const total = await fetchCostForPeriod(
      "key",
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-02-11T00:00:00.000Z"),
      "1d",
      { groupByDescription: true }
    );

    expect(total).toBeCloseTo(3.75, 8);
    const firstUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(firstUrl.searchParams.get("bucket_width")).toBe("1d");
    expect(firstUrl.searchParams.getAll("group_by[]")).toContain("description");
    const secondUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(secondUrl.searchParams.get("page")).toBe("p2");
  });

  it("fetches full report across pages", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        response({
          status: 200,
          body: {
            data: [{ starting_at: "a", ending_at: "b", results: [] }],
            has_more: true,
            next_page: "next",
          },
        })
      )
      .mockResolvedValueOnce(
        response({
          status: 200,
          body: {
            data: [{ starting_at: "c", ending_at: "d", results: [] }],
            has_more: false,
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchCostReport } = await import("../src/cost-fetcher.ts");
    const report = await fetchCostReport(
      "key",
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-02-11T00:00:00.000Z"),
      "1h"
    );

    expect(report.data).toHaveLength(2);
  });

  it("retries on 429 and succeeds", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        response({
          status: 429,
          headers: { "retry-after": "0" },
        })
      )
      .mockResolvedValueOnce(
        response({
          status: 200,
          body: { data: [], has_more: false },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchCostForPeriod } = await import("../src/cost-fetcher.ts");
    await fetchCostForPeriod(
      "key",
      new Date("2026-02-01T00:00:00.000Z"),
      new Date("2026-02-11T00:00:00.000Z"),
      "1m"
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails after authentication errors", async () => {
    const fetchMock = vi.fn(async () => response({ status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchCostForPeriod } = await import("../src/cost-fetcher.ts");
    await expect(
      fetchCostForPeriod("bad-key", new Date("2026-02-01T00:00:00.000Z"), new Date("2026-02-11T00:00:00.000Z"), "1d")
    ).rejects.toThrow(/authentication failed/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("throws when API payload schema is invalid", async () => {
    const fetchMock = vi.fn(async () => response({ status: 200, body: { data: "broken" } }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchCostForPeriod } = await import("../src/cost-fetcher.ts");
    await expect(
      fetchCostForPeriod("key", new Date("2026-02-01T00:00:00.000Z"), new Date("2026-02-11T00:00:00.000Z"), "1d")
    ).rejects.toThrow("invalid cost report API response format");
  });
});
