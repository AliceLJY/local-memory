import { describe, expect, it } from "bun:test";

import { summarizeConflictLifecycle } from "../conflict-lifecycle.js";
import { buildConflictCandidateRecord } from "../conflict-engine.js";

function createConflictRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...buildConflictCandidateRecord({
      canonicalKey: "user-reply-style",
      category: "preferences",
      fingerprint: "user-reply-style--durable-1--source-1--new-text",
      reason: "promotion_conflicts_with_existing_durable",
      existing: {
        memoryId: "durable-1",
        text: "User prefers concise, direct replies.",
        category: "preferences",
        scope: "memory:agent",
        importance: 0.84,
        metadata: "{\"source\":\"agent\"}",
        canonicalKey: "user-reply-style",
      },
      incoming: {
        text: "User prefers colloquial writing that stays grounded and non-salesy.",
        category: "preferences",
        scope: "memory:agent",
        importance: 0.78,
        metadata: "{\"source\":\"agent\"}",
        source: "agent",
        sourceMemoryId: "source-1",
        sourceCategory: "events",
      },
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: "2026-03-10T00:00:00.000Z",
    }),
    ...overrides,
  };
}

describe("summarizeConflictLifecycle", () => {
  it("marks newly opened conflicts as fresh", () => {
    const record = createConflictRecord();
    const summary = summarizeConflictLifecycle(record as any, new Date("2026-03-10T12:00:00.000Z"));

    expect(summary.attention).toBe("fresh");
    expect(summary.openAgeDays).toBe(0);
    expect(summary.reopenCount).toBe(0);
    expect(summary.needsAttention).toBe(false);
  });

  it("marks older or reopened conflicts as aging/stale/escalated", () => {
    const aging = summarizeConflictLifecycle(
      createConflictRecord({ createdAt: "2026-03-08T00:00:00.000Z" }) as any,
      new Date("2026-03-10T00:00:00.000Z"),
    );
    const stale = summarizeConflictLifecycle(
      createConflictRecord({ createdAt: "2026-03-05T00:00:00.000Z" }) as any,
      new Date("2026-03-10T00:00:00.000Z"),
    );
    const escalated = summarizeConflictLifecycle(
      createConflictRecord({ status: "open", reopenCount: 3 }) as any,
      new Date("2026-03-10T12:00:00.000Z"),
    );

    expect(aging.attention).toBe("aging");
    expect(stale.attention).toBe("stale");
    expect(stale.needsAttention).toBe(true);
    expect(escalated.attention).toBe("escalated");
    expect(escalated.needsAttention).toBe(true);
  });

  it("marks resolved conflicts as resolved", () => {
    const record = createConflictRecord({
      status: "kept-existing",
      resolvedAt: "2026-03-10T02:00:00.000Z",
      reopenCount: 1,
    });
    const summary = summarizeConflictLifecycle(record as any, new Date("2026-03-10T12:00:00.000Z"));

    expect(summary.attention).toBe("resolved");
    expect(summary.isOpen).toBe(false);
    expect(summary.reopenCount).toBe(1);
  });
});
