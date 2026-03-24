import { describe, expect, it } from "bun:test";

import { buildConflictCandidateRecord } from "../conflict-engine.js";
import { buildConflictEscalationItem, escalateConflicts } from "../conflict-escalation.js";

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
        text: "User prefers colloquial, grounded technical replies.",
        category: "preferences",
        scope: "memory:agent",
        importance: 0.78,
        metadata: "{\"source\":\"agent\"}",
        source: "agent",
        sourceMemoryId: "source-1",
        sourceCategory: "events",
      },
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    }),
    ...overrides,
  };
}

describe("buildConflictEscalationItem", () => {
  it("only returns an escalation item for stale or escalated open conflicts", () => {
    const staleItem = buildConflictEscalationItem(
      createConflictRecord() as any,
      new Date("2026-03-16T00:00:00.000Z"),
    );
    const freshItem = buildConflictEscalationItem(
      createConflictRecord({
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      }) as any,
      new Date("2026-03-16T12:00:00.000Z"),
    );

    expect(staleItem?.attention).toBe("escalated");
    expect(freshItem).toBeNull();
  });
});

describe("escalateConflicts", () => {
  it("previews eligible stale conflicts without mutating them", async () => {
    const records = [
      createConflictRecord({
        conflictId: "00000000-0000-0000-0000-000000000001",
      }),
      createConflictRecord({
        conflictId: "00000000-0000-0000-0000-000000000002",
        createdAt: "2026-03-16T00:00:00.000Z",
        updatedAt: "2026-03-16T00:00:00.000Z",
      }),
    ];
    const replaced: any[] = [];

    const result = await escalateConflicts({
      conflictStore: {
        async listRecent() {
          return records as any;
        },
        async replace(record: any) {
          replaced.push(record);
          return record;
        },
      } as any,
    }, {
      attention: "escalated",
      limit: 100,
      top: 10,
      apply: false,
    }, { now: new Date("2026-03-17T00:00:00.000Z") });

    expect(result.apply).toBe(false);
    expect(result.eligible).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.items[0]?.action).toBe("pending");
    expect(replaced).toHaveLength(0);
  });

  it("applies escalation metadata exactly once per attention bucket", async () => {
    const records = [
      createConflictRecord({
        conflictId: "00000000-0000-0000-0000-000000000001",
      }),
    ];
    const replaced: any[] = [];

    const result = await escalateConflicts({
      conflictStore: {
        async listRecent() {
          return records as any;
        },
        async replace(record: any) {
          replaced.push(record);
          return record;
        },
      } as any,
    }, {
      attention: "escalated",
      limit: 100,
      top: 10,
      apply: true,
      notes: "auto escalation test",
    });

    expect(result.escalated).toBe(1);
    expect(result.items[0]?.action).toBe("escalated");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]?.escalationCount).toBe(1);
    expect(replaced[0]?.lastEscalationAttention).toBe("escalated");

    const second = await escalateConflicts({
      conflictStore: {
        async listRecent() {
          return replaced as any;
        },
        async replace(record: any) {
          replaced[0] = record;
          return record;
        },
      } as any,
    }, {
      attention: "escalated",
      limit: 100,
      top: 10,
      apply: true,
    });

    expect(second.escalated).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.items[0]?.action).toBe("already-escalated");
  });
});
