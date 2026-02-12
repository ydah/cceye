import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionFile, scanSessionFiles } from "../src/log-parser.ts";

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
    const relative = files.map((file) => path.relative(tempDir, file)).sort();
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
      [validLine, invalidUsageLine, invalidTimestampLine, noUsageLine, "{not-json}", ""].join("\n")
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
      costUSD: null,
    });
  });
});
