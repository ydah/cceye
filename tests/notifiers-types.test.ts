import { describe, expect, expectTypeOf, it } from "vitest";
import type { Alert, Notifier } from "../src/notifiers/types.ts";

describe("notifier types", () => {
  it("keeps Alert and Notifier contracts", async () => {
    const alert: Alert = {
      level: "warning",
      window: "daily",
      currentCost: 1,
      threshold: 2,
      timestamp: new Date(),
    };

    const notifier: Notifier = {
      name: "test",
      send: async (_a: Alert) => undefined,
    };

    expect(alert.level).toBe("warning");
    expect(notifier.name).toBe("test");
    expectTypeOf(alert.window).toMatchTypeOf<"daily" | "weekly" | "monthly">();
  });
});
