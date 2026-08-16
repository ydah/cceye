import { describe, expect, it, vi } from "vitest";
import { buildReportRows, printReportRows } from "../src/reporting.ts";
import type { UsageEntry } from "../src/log-parser.ts";

function entry(overrides: Partial<UsageEntry>): UsageEntry {
  return {
    timestamp: new Date("2026-02-15T10:00:00.000Z"),
    model: "claude-sonnet-4-20250514",
    project: "project-a",
    session: "session-one",
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 2,
    cacheReadTokens: 1,
    messageId: null,
    requestId: null,
    costUSD: 0.1,
    ...overrides,
  };
}

describe("buildReportRows", () => {
  it("builds daily and monthly buckets with date range filtering", () => {
    const rows = buildReportRows(
      [
        entry({ timestamp: new Date("2026-02-15T01:00:00.000Z"), costUSD: 0.1 }),
        entry({ timestamp: new Date("2026-02-15T05:00:00.000Z"), costUSD: 0.2 }),
        entry({ timestamp: new Date("2026-02-16T05:00:00.000Z"), costUSD: 0.3 }),
      ],
      "daily",
      {
        since: "20260215",
        until: "20260215",
        json: false,
        breakdown: false,
        timezone: "UTC",
      }
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "2026-02-15",
      totalCost: 0.30000000000000004,
      inputTokens: 20,
      outputTokens: 10,
      cacheCreationTokens: 4,
      cacheReadTokens: 2,
    });
  });

  it("builds session buckets from project/session metadata", () => {
    const rows = buildReportRows(
      [
        entry({ session: "session-one", costUSD: 0.1 }),
        entry({ session: "session-one", costUSD: 0.2 }),
        entry({ session: "session-two", costUSD: 0.3 }),
      ],
      "session",
      {
        json: false,
        breakdown: false,
        timezone: "UTC",
      }
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.key).toBe("project-a/session-one");
    expect(rows[0]?.totalCost).toBeCloseTo(0.3, 8);
    expect(rows[1]?.key).toBe("project-a/session-two");
  });
});

describe("printReportRows", () => {
  it("prints plain and json output", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const rows = [
      {
        key: "2026-02-15",
        totalCost: 0.3,
        inputTokens: 20,
        outputTokens: 10,
        cacheCreationTokens: 4,
        cacheReadTokens: 2,
        byModel: { m: 0.3 },
        byProject: { p: 0.3 },
      },
    ];

    printReportRows(rows, { json: false, breakdown: true, timezone: "UTC" });
    expect(String(log.mock.calls[0]?.[0])).toContain("models=[m=$0.3000]");

    printReportRows(rows, { json: true, breakdown: false, timezone: "UTC" });
    expect(String(log.mock.calls[1]?.[0])).toContain('"key": "2026-02-15"');
  });

  it("prints project/session breakdowns with coverage and Other", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    log.mockClear();
    const row = {
      key: "2026-02-15",
      totalCost: 3,
      inputTokens: 20,
      outputTokens: 10,
      cacheCreationTokens: 4,
      cacheReadTokens: 2,
      byModel: { m1: 2, m2: 1 },
      byProject: { p1: 2, p2: 1 },
      bySession: { "p1/s1": 2, "p2/s2": 1 },
      coverage: { eventCoverageRatio: 0.5, tokenCoverageRatio: 0.5, unpricedEvents: 1, complete: false },
    };

    printReportRows([row], { json: false, breakdown: true, breakdownDimension: "project", showCoverage: true, top: 1, other: true, timezone: "UTC" });
    printReportRows([row], { json: false, breakdown: true, breakdownDimension: "session", timezone: "UTC" });
    expect(String(log.mock.calls[0]?.[0])).toContain("PARTIAL (1 unpriced)");
    expect(String(log.mock.calls[0]?.[0])).toContain("projects=[p1=$2.0000, Other=$1.0000]");
    expect(String(log.mock.calls[1]?.[0])).toContain("sessions=[p1/s1=$2.0000, p2/s2=$1.0000]");
  });
});
