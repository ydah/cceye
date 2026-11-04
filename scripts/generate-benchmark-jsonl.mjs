import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const outputPath = path.resolve(process.argv[2] ?? "./benchmark-usage.jsonl");
const lineCount = Number(process.argv[3] ?? "100000");
if (!Number.isInteger(lineCount) || lineCount <= 0) {
  throw new Error("line count must be a positive integer");
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const stream = fs.createWriteStream(outputPath, { encoding: "utf8" });
for (let index = 0; index < lineCount; index += 1) {
  const line = {
    timestamp: new Date(Date.now() - (lineCount - index) * 1000).toISOString(),
    message: {
      id: `benchmark-${index}`,
      model: "claude-sonnet-4-5-20250929",
      usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    requestId: `request-${index}`,
  };
  if (!stream.write(`${JSON.stringify(line)}\n`)) {
    await new Promise((resolve) => stream.once("drain", resolve));
  }
}
await new Promise((resolve, reject) => {
  stream.end(resolve);
  stream.on("error", reject);
});
process.stdout.write(`wrote ${lineCount} JSONL records to ${outputPath}\n`);
