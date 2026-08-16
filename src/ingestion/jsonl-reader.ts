import fs from "fs";

export interface JsonlRecord {
  line: Buffer;
  startOffset: number;
  endOffset: number;
}

export interface RejectedJsonlRecord {
  startOffset: number;
  endOffset: number;
  reason: "line_too_large";
}

export interface JsonlReadResult {
  records: JsonlRecord[];
  rejected: RejectedJsonlRecord[];
  committedOffset: number;
  bytesRead: number;
  trailingBytes: number;
}

const defaultChunkSize = 64 * 1024;
export const maxJsonlLineBytes = 2 * 1024 * 1024;

export const readJsonlIncrementally = async (
  filePath: string,
  startOffset: number,
  options?: { chunkSize?: number; maxLineBytes?: number; allowTrailingLine?: boolean }
): Promise<JsonlReadResult> => {
  const chunkSize = options?.chunkSize ?? defaultChunkSize;
  const maxLineBytes = options?.maxLineBytes ?? maxJsonlLineBytes;
  const records: JsonlRecord[] = [];
  const rejected: RejectedJsonlRecord[] = [];
  let pending = Buffer.alloc(0);
  let pendingStartOffset = startOffset;
  let streamOffset = startOffset;
  let committedOffset = startOffset;
  let bytesRead = 0;
  let discarding = false;
  let discardedStartOffset = startOffset;

  const stream = fs.createReadStream(filePath, { start: startOffset, highWaterMark: chunkSize });
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytesRead += buffer.length;
    if (discarding) {
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex < 0) {
        streamOffset += buffer.length;
        continue;
      }
      const endOffset = streamOffset + newlineIndex + 1;
      rejected.push({ startOffset: discardedStartOffset, endOffset, reason: "line_too_large" });
      committedOffset = endOffset;
      streamOffset = endOffset;
      pending = buffer.subarray(newlineIndex + 1);
      pendingStartOffset = endOffset;
      discarding = false;
    } else {
      pending = Buffer.concat([pending, buffer]);
    }

    while (!discarding) {
      const newlineIndex = pending.indexOf(0x0a);
      if (newlineIndex < 0) {
        if (pending.length > maxLineBytes) {
          discardedStartOffset = pendingStartOffset;
          streamOffset = pendingStartOffset + pending.length;
          pending = Buffer.alloc(0);
          pendingStartOffset = streamOffset;
          discarding = true;
        }
        break;
      }

      const rawLine = pending.subarray(0, newlineIndex);
      const endOffset = pendingStartOffset + newlineIndex + 1;
      if (rawLine.length > maxLineBytes) {
        rejected.push({ startOffset: pendingStartOffset, endOffset, reason: "line_too_large" });
      } else {
        const line = stripCarriageReturn(rawLine);
        records.push({
          line: removeBom(line, pendingStartOffset),
          startOffset: pendingStartOffset,
          endOffset,
        });
      }
      committedOffset = endOffset;
      pending = pending.subarray(newlineIndex + 1);
      pendingStartOffset = endOffset;
    }

    if (!discarding) {
      streamOffset = pendingStartOffset + pending.length;
    }
  }

  if (discarding) {
    rejected.push({ startOffset: discardedStartOffset, endOffset: streamOffset, reason: "line_too_large" });
    committedOffset = streamOffset;
  } else if (options?.allowTrailingLine && pending.length > 0) {
    const endOffset = pendingStartOffset + pending.length;
    if (pending.length > maxLineBytes) {
      rejected.push({ startOffset: pendingStartOffset, endOffset, reason: "line_too_large" });
    } else {
      const line = stripCarriageReturn(pending);
      records.push({
        line: removeBom(line, pendingStartOffset),
        startOffset: pendingStartOffset,
        endOffset,
      });
    }
    committedOffset = endOffset;
    pending = Buffer.alloc(0);
  }

  return {
    records,
    rejected,
    committedOffset,
    bytesRead,
    trailingBytes: discarding ? 0 : pending.length,
  };
};

const stripCarriageReturn = (line: Buffer): Buffer => (line.at(-1) === 0x0d ? line.subarray(0, -1) : line);

const removeBom = (line: Buffer, startOffset: number): Buffer => {
  if (startOffset === 0 && line.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return line.subarray(3);
  }
  return line;
};
