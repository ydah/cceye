import { describe, expect, it } from "vitest";
import { evaluateThresholds } from "../src/threshold-engine.ts";

const thresholds = {
  daily: { warning: 5, critical: 10 },
  weekly: { warning: 25, critical: 50 },
  monthly: { warning: 80, critical: 150 },
};

describe("evaluateThresholds", () => {
  it("returns critical over warning when both conditions match", () => {
    const result = evaluateThresholds(
      {
        daily: 12,
        weekly: 25,
        monthly: 70,
      },
      thresholds
    );

    expect(result).toEqual([
      { window: "daily", level: "critical", currentCost: 12, threshold: 10 },
      { window: "weekly", level: "warning", currentCost: 25, threshold: 25 },
    ]);
  });

  it("returns empty array when all windows are below warning", () => {
    const result = evaluateThresholds(
      {
        daily: 1,
        weekly: 2,
        monthly: 3,
      },
      thresholds
    );
    expect(result).toEqual([]);
  });
});
