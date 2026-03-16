import { randomUUID } from "node:crypto";

import {
  type SessionCheckpointInput,
  SessionCheckpointInputSchema,
  type SessionCheckpointRecord,
  SessionCheckpointRecordSchema,
} from "./session-schema.js";

export function resolveCheckpointScope(input: Pick<SessionCheckpointInput, "sessionId" | "scope">): string {
  return input.scope || `session:${input.sessionId}`;
}

export function buildSessionCheckpointRecord(rawInput: unknown): SessionCheckpointRecord {
  const input = SessionCheckpointInputSchema.parse(rawInput);
  return SessionCheckpointRecordSchema.parse({
    ...input,
    checkpointId: randomUUID(),
    resolvedScope: resolveCheckpointScope(input),
  });
}
