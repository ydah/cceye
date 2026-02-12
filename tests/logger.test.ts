import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.ts";

describe("createLogger", () => {
  it("creates winston logger with requested level and console transport", () => {
    const logger = createLogger({
      log_level: "debug",
    });

    expect(logger.level).toBe("debug");
    expect(logger.transports.length).toBe(1);
  });
});
