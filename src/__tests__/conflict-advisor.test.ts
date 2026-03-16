import { describe, expect, it } from "bun:test";

import { buildConflictCandidateRecord } from "../conflict-engine.js";
import { buildConflictAuditSummary, clusterConflicts, summarizeConflictAdvice } from "../conflict-advisor.js";

function createConflictRecord(overrides: Record<string, unknown> = {}) {
  return {
    ...buildConflictCandidateRecord({
      canonicalKey: "user-reply-style",
      category: "preferences",
      fingerprint: "user-reply-style--durable-1--source-1--new-text",
      reason: "promotion_conflicts_with_existing_durable",
      existing: {
        memoryId: "durable-1",
        text: "User prefers concise, direct, technical replies.",
        category: "preferences",
        scope: "memory:agent",
        importance: 0.84,
        metadata: "{\"source\":\"agent\"}",
        canonicalKey: "user-reply-style",
      },
      incoming: {
        text: "User prefers concise direct technical replies.",
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

describe("summarizeConflictAdvice", () => {
  it("suggests keep_existing for text-equivalent conflicts", () => {
    const advice = summarizeConflictAdvice(createConflictRecord() as any);

    expect(advice.suggestedResolution).toBe("keep_existing");
    expect(advice.confidence).toBe("high");
    expect(advice.similarity).toBe(1);
  });

  it("suggests keep_existing for cross-category canonical key conflicts", () => {
    const advice = summarizeConflictAdvice(createConflictRecord({
      reason: "canonical_key_conflicts_with_existing_durable",
      category: "events",
      incoming: {
        text: "Reply-style observation imported as an event.",
        category: "events",
        scope: "memory:agent",
        importance: 0.78,
        metadata: "{\"source\":\"agent\"}",
        source: "agent",
        sourceMemoryId: "source-2",
        sourceCategory: "events",
      },
    }) as any);

    expect(advice.suggestedResolution).toBe("keep_existing");
    expect(["medium", "high"]).toContain(advice.confidence);
    expect(advice.reasons.some((reason) => reason.includes("canonical key"))).toBe(true);
  });

  it("suggests accept_incoming when the incoming text is a tighter rewrite of the same memory", () => {
    const advice = summarizeConflictAdvice(createConflictRecord({
      existing: {
        memoryId: "durable-1",
        text: "User prefers concise grounded technical replies and avoids sales language in the final copy.",
        category: "preferences",
        scope: "memory:agent",
        importance: 0.84,
        metadata: "{\"source\":\"agent\"}",
        canonicalKey: "user-reply-style",
      },
      incoming: {
        text: "User prefers concise grounded technical replies and avoids sales language.",
        category: "preferences",
        scope: "memory:agent",
        importance: 0.78,
        metadata: "{\"source\":\"agent\"}",
        source: "agent",
        sourceMemoryId: "source-1",
        sourceCategory: "events",
      },
    }) as any);

    expect(advice.suggestedResolution).toBe("accept_incoming");
    expect(advice.confidence).toBe("medium");
    expect(advice.similarity).toBeGreaterThanOrEqual(0.72);
    expect(advice.mergeSuggestion).toBeUndefined();
  });

  it("offers a merged wording suggestion for same-category manual_review conflicts", () => {
    const advice = summarizeConflictAdvice(createConflictRecord({
      existing: {
        memoryId: "durable-1",
        text: "User prefers concise grounded technical replies; avoid sales language.",
        category: "preferences",
        scope: "memory:agent",
        importance: 0.84,
        metadata: "{\"source\":\"agent\"}",
        canonicalKey: "user-reply-style",
      },
      incoming: {
        text: "User prefers concise grounded technical replies; keep the tone colloquial.",
        category: "preferences",
        scope: "memory:agent",
        importance: 0.78,
        metadata: "{\"source\":\"agent\"}",
        source: "agent",
        sourceMemoryId: "source-1",
        sourceCategory: "events",
      },
    }) as any);

    expect(advice.suggestedResolution).toBe("manual_review");
    expect(advice.mergeSuggestion).toContain("User prefers concise grounded technical replies");
    expect(advice.mergeSuggestion).toContain("avoid sales language");
    expect(advice.mergeSuggestion).toContain("keep the tone colloquial");
    expect(advice.reasons.some((reason) => reason.includes("merged durable wording"))).toBe(true);
  });
});

describe("clusterConflicts", () => {
  it("groups conflicts by canonical key, reason, and category", () => {
    const clusters = clusterConflicts([
      createConflictRecord({
        conflictId: "00000000-0000-0000-0000-000000000001",
        updatedAt: "2026-03-10T00:00:00.000Z",
      }) as any,
      createConflictRecord({
        conflictId: "00000000-0000-0000-0000-000000000002",
        updatedAt: "2026-03-11T00:00:00.000Z",
      }) as any,
      createConflictRecord({
        canonicalKey: "project-entity-owner",
        conflictId: "00000000-0000-0000-0000-000000000003",
        fingerprint: "project-entity-owner--durable-1--source-1--new-text",
      }) as any,
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.canonicalKey).toBe("user-reply-style");
    expect(clusters[0]?.totalCount).toBe(2);
    expect(clusters[0]?.latestConflictId).toBe("00000000-0000-0000-0000-000000000002");
    expect(clusters[0]?.attention).toBe("stale");
  });
});

describe("buildConflictAuditSummary", () => {
  it("highlights escalated or stale open clusters first", () => {
    const summary = buildConflictAuditSummary([
      createConflictRecord({
        conflictId: "00000000-0000-0000-0000-000000000001",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }) as any,
      createConflictRecord({
        canonicalKey: "project-entity-owner",
        conflictId: "00000000-0000-0000-0000-000000000002",
        fingerprint: "project-entity-owner--durable-1--source-1--new-text",
        createdAt: "2026-03-15T00:00:00.000Z",
        updatedAt: "2026-03-15T00:00:00.000Z",
      }) as any,
      createConflictRecord({
        conflictId: "00000000-0000-0000-0000-000000000003",
        status: "kept-existing",
        resolvedAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      }) as any,
    ], 3);

    expect(summary.totalConflicts).toBe(3);
    expect(summary.openConflicts).toBe(2);
    expect(summary.attentionCounts.resolved).toBe(1);
    expect(summary.priorityClusters[0]?.attention).toBe("escalated");
    expect(summary.suggestedActions.some((action) => action.includes("escalated"))).toBe(true);
  });

  it("returns a no-open-conflicts message when nothing is pending", () => {
    const summary = buildConflictAuditSummary([
      createConflictRecord({
        conflictId: "00000000-0000-0000-0000-000000000001",
        status: "kept-existing",
        resolvedAt: "2026-03-16T00:00:00.000Z",
      }) as any,
    ], 3);

    expect(summary.openConflicts).toBe(0);
    expect(summary.priorityClusters).toHaveLength(0);
    expect(summary.suggestedActions).toEqual(["No open conflicts need review."]);
  });
});
