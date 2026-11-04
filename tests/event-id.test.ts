import { describe, expect, it } from "vitest";
import { createUsageEventId } from "../src/ingestion/event-id.ts";

describe("createUsageEventId", () => {
  it("does not collapse identical id-less lines from different projects", () => {
    const base = {
      sourceKind: "claude",
      messageId: null,
      requestId: null,
      timestamp: "2026-08-16T00:00:00.000Z",
      rawLine: Buffer.from('{"timestamp":"2026-08-16T00:00:00.000Z"}'),
    };

    expect(createUsageEventId({ ...base, sessionId: "project-a/session-one" })).not.toBe(
      createUsageEventId({ ...base, sessionId: "project-b/session-one" })
    );
    expect(createUsageEventId({ ...base, sessionId: "project-a/session-one" })).toBe(
      createUsageEventId({ ...base, sessionId: "project-a/session-one" })
    );
  });
});
