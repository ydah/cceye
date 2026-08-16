import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { readJsonlIncrementally } from "../src/ingestion/jsonl-reader.ts";

describe("readJsonlIncrementally", () => {
  it("preserves byte cursors for CRLF, UTF-8 chunks, and trailing partial lines", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-reader-"));
    const file = path.join(directory, "usage.jsonl");
    const first = JSON.stringify({ text: "日本語" });
    const second = JSON.stringify({ text: "second" });
    const content = `${first}\r\n${second}`;
    fs.writeFileSync(file, content);

    const initial = await readJsonlIncrementally(file, 0, { chunkSize: 3 });
    expect(initial.records.map((record) => record.line.toString("utf8"))).toEqual([first]);
    expect(initial.committedOffset).toBe(Buffer.byteLength(`${first}\r\n`));
    expect(initial.trailingBytes).toBe(Buffer.byteLength(second));

    fs.appendFileSync(file, "\n");
    const completed = await readJsonlIncrementally(file, initial.committedOffset, { chunkSize: 2 });
    expect(completed.records.map((record) => record.line.toString("utf8"))).toEqual([second]);
    expect(completed.committedOffset).toBe(Buffer.byteLength(content) + 1);
  });

  it("removes a BOM only at offset zero and quarantines oversized lines", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cceye-reader-"));
    const file = path.join(directory, "usage.jsonl");
    fs.writeFileSync(file, `\ufeff${JSON.stringify({ ok: true })}\n${"x".repeat(20)}\n`);

    const result = await readJsonlIncrementally(file, 0, { maxLineBytes: 10, chunkSize: 4 });
    expect(result.records).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.committedOffset).toBe(fs.statSync(file).size);
  });
});
