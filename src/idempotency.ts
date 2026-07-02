import { createHash } from "node:crypto";

export function buildIdempotentRecordId(prefix: string, key?: string): string | undefined {
  const normalized = key?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}
