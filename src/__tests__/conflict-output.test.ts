import { describe, expect, it } from "bun:test";

import { buildConflictAuditSummary } from "../conflict-advisor.js";
import { buildConflictCandidateRecord } from "../conflict-engine.js";
import { formatConflictAuditMarkdown } from "../conflict-output.js";

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

describe("formatConflictAuditMarkdown", () => {
  it("renders audit counts, filters, and priority clusters", () => {
    const summary = buildConflictAuditSummary([
      createConflictRecord({
        conflictId: "00000000-0000-0000-0000-000000000001",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }) as any,
    ], 3);

    const markdown = formatConflictAuditMarkdown(summary, {
      generatedAt: "2026-03-16T16:00:00.000Z",
      limit: 100,
      top: 3,
      status: "open",
      canonicalKey: "user-reply-style",
    });

    expect(markdown).toContain("# Conflict Audit");
    expect(markdown).toContain("Generated: 2026-03-16T16:00:00.000Z");
    expect(markdown).toContain("Filters: status=open, canonicalKey=user-reply-style, limit=100, top=3");
    expect(markdown).toContain("## Suggested Actions");
    expect(markdown).toContain("## Priority Clusters");
    expect(markdown).toContain("Cluster key:");
    expect(markdown).toContain("Advice:");
  });

  it("renders an empty priority-cluster section when nothing is open", () => {
    const summary = buildConflictAuditSummary([
      createConflictRecord({
        conflictId: "00000000-0000-0000-0000-000000000001",
        status: "kept-existing",
        resolvedAt: "2026-03-16T00:00:00.000Z",
      }) as any,
    ], 3);

    const markdown = formatConflictAuditMarkdown(summary, {
      generatedAt: "2026-03-16T16:00:00.000Z",
      limit: 50,
      top: 5,
    });

    expect(markdown).toContain("## Priority Clusters");
    expect(markdown).toContain("- None");
  });
});
