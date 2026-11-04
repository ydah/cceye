import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionFile, parseUsageLineDetailed, scanSessionFiles } from "../src/log-parser.ts";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cceye-log-parser-"));
}

describe("scanSessionFiles", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("finds jsonl files recursively", async () => {
    tempDir = createTempDir();
    fs.mkdirSync(path.join(tempDir, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "root.jsonl"), "");
    fs.writeFileSync(path.join(tempDir, "a", "b", "nested.jsonl"), "");
    fs.writeFileSync(path.join(tempDir, "a", "b", "ignored.txt"), "");

    const files = await scanSessionFiles(tempDir);
    const relative = files.map((file) => path.relative(tempDir, file).split(path.sep).join("/")).sort();
    expect(relative).toEqual(["a/b/nested.jsonl", "root.jsonl"]);
  });

  it("returns empty list when root cannot be read", async () => {
    tempDir = createTempDir();
    const files = await scanSessionFiles(path.join(tempDir, "missing"));
    expect(files).toEqual([]);
  });
});

describe("parseSessionFile", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses valid usage lines and skips invalid ones", async () => {
    tempDir = createTempDir();
    const file = path.join(tempDir, "session.jsonl");
    const validLine = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
        model: "claude-sonnet-4-5-20250929",
        id: "msg-1",
      },
      requestId: "req-1",
      costUSD: 0.5,
    });
    const invalidUsageLine = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      message: { usage: { input_tokens: "x", output_tokens: 1 }, model: "claude-sonnet-4-5-20250929" },
    });
    const booleanTokenLine = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      message: { usage: { input_tokens: true, output_tokens: 1 }, model: "claude-sonnet-4-5-20250929" },
    });
    const nullTokenLine = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      message: { usage: { input_tokens: null, output_tokens: 1 }, model: "claude-sonnet-4-5-20250929" },
    });
    const invalidTimestampLine = JSON.stringify({
      timestamp: "not-a-date",
      message: { usage: { input_tokens: 1, output_tokens: 1 }, model: "claude-sonnet-4-5-20250929" },
    });
    const noUsageLine = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      message: { model: "claude-sonnet-4-5-20250929" },
    });

    fs.writeFileSync(
      file,
      [
        validLine,
        invalidUsageLine,
        booleanTokenLine,
        nullTokenLine,
        invalidTimestampLine,
        noUsageLine,
        "{not-json}",
        "",
      ].join("\n")
    );

    const { entries, parsedBytes } = await parseSessionFile(file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      model: "claude-sonnet-4-5-20250929",
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      messageId: "msg-1",
      requestId: "req-1",
      costUSD: 0.5,
    });
    expect(parsedBytes).toBeGreaterThan(0);
  });

  it("supports startOffset for incremental parsing", async () => {
    tempDir = createTempDir();
    const file = path.join(tempDir, "incremental.jsonl");

    const first = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      message: { usage: { input_tokens: 1, output_tokens: 2 }, model: "first", id: "m1" },
      requestId: "r1",
    });
    const second = JSON.stringify({
      timestamp: "2026-02-11T11:00:00.000Z",
      message: { usage: { input_tokens: 3, output_tokens: 4 }, model: "second", id: "m2" },
      requestId: "r2",
    });
    fs.writeFileSync(file, `${first}\n${second}\n`);

    const startOffset = Buffer.byteLength(first, "utf8") + 1;
    const result = await parseSessionFile(file, startOffset);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.model).toBe("second");
    expect(result.parsedBytes).toBeGreaterThan(startOffset);
  });

  it("parses a complete final line without a newline", async () => {
    tempDir = createTempDir();
    const file = path.join(tempDir, "no-final-newline.jsonl");
    fs.writeFileSync(
      file,
      JSON.stringify({
        timestamp: "2026-02-11T10:00:00.000Z",
        message: { usage: { input_tokens: 1, output_tokens: 2 }, model: "final-line" },
      })
    );

    const result = await parseSessionFile(file);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.model).toBe("final-line");
    expect(result.parsedBytes).toBe(fs.statSync(file).size);
  });

  it("sanitizes control characters in model labels", () => {
    const result = parseUsageLineDetailed(
      JSON.stringify({
        timestamp: "2026-02-11T10:00:00.000Z",
        message: { usage: { input_tokens: 1, output_tokens: 2 }, model: "model-\u001b[31m" },
      })
    );

    expect(result.entry?.model).toBe("model-�[31m");
  });

  it("coerces unknown optional fields to safe defaults", async () => {
    tempDir = createTempDir();
    const file = path.join(tempDir, "unknown-fields.jsonl");
    const line = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      message: { usage: { input_tokens: 1, output_tokens: 2 }, model: 123, id: 456 },
      requestId: 789,
      costUSD: "1.23",
    });
    fs.writeFileSync(file, `${line}\n`);

    const { entries } = await parseSessionFile(file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      model: "unknown",
      messageId: null,
      requestId: null,
      costUSD: 1.23,
    });
  });

  it("supports numeric string tokens and top-level model fallback", async () => {
    tempDir = createTempDir();
    const file = path.join(tempDir, "string-numbers.jsonl");
    const line = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      model: "top-level-model",
      message: {
        usage: {
          input_tokens: "10",
          output_tokens: "20",
          cache_creation_input_tokens: "30",
          cache_read_input_tokens: "40",
        },
      },
      costUSD: "0.15",
    });
    fs.writeFileSync(file, `${line}\n`);

    const { entries } = await parseSessionFile(file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      model: "top-level-model",
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40,
      costUSD: 0.15,
    });
  });

  it("rejects boolean and null token values instead of coercing them", async () => {
    tempDir = createTempDir();
    const file = path.join(tempDir, "invalid-token-types.jsonl");
    const booleanTokenLine = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      message: {
        usage: {
          input_tokens: true,
          output_tokens: 2,
        },
        model: "top-level-model",
      },
    });
    const nullTokenLine = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      message: {
        usage: {
          input_tokens: 1,
          output_tokens: null,
        },
        model: "top-level-model",
      },
    });
    fs.writeFileSync(file, `${booleanTokenLine}\n${nullTokenLine}\n`);

    const { entries } = await parseSessionFile(file);
    expect(entries).toEqual([]);
  });

  it("keeps invalid cost strings as null", async () => {
    tempDir = createTempDir();
    const file = path.join(tempDir, "invalid-cost.jsonl");
    const invalidStringCostLine = JSON.stringify({
      timestamp: "2026-02-11T10:00:00.000Z",
      message: { usage: { input_tokens: 1, output_tokens: 2 }, model: "claude-sonnet-4-5-20250929" },
      costUSD: "not-a-number",
    });
    const blankStringCostLine = JSON.stringify({
      timestamp: "2026-02-11T10:01:00.000Z",
      message: { usage: { input_tokens: 3, output_tokens: 4 }, model: "claude-sonnet-4-5-20250929" },
      costUSD: "   ",
    });
    fs.writeFileSync(file, `${invalidStringCostLine}\n${blankStringCostLine}\n`);

    const { entries } = await parseSessionFile(file);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.costUSD).toBeNull();
    expect(entries[1]?.costUSD).toBeNull();
  });

  it("skips JSONL records above the parser line limit", async () => {
    tempDir = createTempDir();
    const file = path.join(tempDir, "oversized.jsonl");
    fs.writeFileSync(file, `${"x".repeat(2 * 1024 * 1024 + 1)}\n`);

    const result = await parseSessionFile(file);

    expect(result.entries).toEqual([]);
    expect(result.parsedBytes).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("rejects oversized direct parser input", () => {
    const result = parseUsageLineDetailed("x".repeat(2 * 1024 * 1024 + 1));

    expect(result).toEqual({ entry: null, reason: "line_too_large" });
  });
});
