import crypto from "crypto";

export interface EventIdInput {
  sourceKind: string;
  messageId: string | null;
  requestId: string | null;
  sourceEventId?: string | null;
  sessionId?: string | null;
  timestamp: string;
  rawLine: Buffer;
}

export const createUsageEventId = (input: EventIdInput): string => {
  const identity = input.messageId && input.requestId
    ? [input.messageId, input.requestId].join("\0")
    : input.sourceEventId
      ? input.sourceEventId
      : [input.sessionId ?? "", input.timestamp, sha256(input.rawLine)].join("\0");
  return sha256(Buffer.from(`${input.sourceKind}\0${identity}`));
};

const sha256 = (value: Buffer): string => crypto.createHash("sha256").update(value).digest("hex");
