import { describe, expect, it } from "bun:test";

import { persistSkill, recordSkillOutcome } from "../skill-engine.js";
import { WorkflowObservationInputSchema } from "../workflow-observation-schema.js";
import type { MemoryEntry } from "../store.js";

const TEST_SCOPE = "project:test";

function createMockStore() {
  const entries: MemoryEntry[] = [];
  let seq = 1;

  return {
    entries,
    store: {
      async store(entry: Omit<MemoryEntry, "id" | "timestamp"> & { id?: string }): Promise<MemoryEntry> {
        const stored: MemoryEntry = {
          ...entry,
          id: entry.id || `auto-${String(seq).padStart(12, "0")}`,
          timestamp: 1_700_000_000_000 + seq,
          metadata: entry.metadata || "{}",
        };
        seq += 1;
        entries.push(stored);
        return stored;
      },
      async update(id: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry | null> {
        const index = entries.findIndex((e) => e.id === id);
        if (index < 0) return null;
        entries[index] = {
          ...entries[index],
          ...updates,
          timestamp: updates.timestamp ?? entries[index].timestamp,
        };
        return entries[index];
      },
      async getById(id: string): Promise<MemoryEntry | null> {
        return entries.find((e) => e.id === id) || null;
      },
      async vectorSearch(): Promise<never[]> {
        return [];
      },
    },
  };
}

function createMockEmbedder() {
  return {
    async embedPassage(text: string): Promise<number[]> {
      return [text.length, 1, 0];
    },
  };
}

function validSkillInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "deploy_production",
    description: "Deploy to production environment with safety checks",
    triggerPattern: "When user says 'deploy to prod' or 'release'",
    implementationType: "bash" as const,
    implementation: "#!/bin/bash\necho 'deploying...'",
    scope: TEST_SCOPE,
    source: "agent" as const,
    tags: ["deploy", "production"],
    ...overrides,
  };
}

function getSkillMeta(entry: MemoryEntry): Record<string, unknown> {
  const meta = JSON.parse(entry.metadata || "{}");
  return (meta.skill || {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// WorkflowObservationInputSchema accepts skillId
// ---------------------------------------------------------------------------

describe("WorkflowObservationInputSchema skillId field", () => {
  it("accepts optional skillId on input", () => {
    const parsed = WorkflowObservationInputSchema.parse({
      workflowId: "skill_run",
      summary: "ran deploy_production",
      skillId: "a1b2c3d4-deadbeef-0000-0000-000000000000",
    });
    expect(parsed.skillId).toBe("a1b2c3d4-deadbeef-0000-0000-000000000000");
  });

  it("allows omission of skillId (backward-compatible)", () => {
    const parsed = WorkflowObservationInputSchema.parse({
      workflowId: "resume_context",
      summary: "fresh window recovered continuity",
    });
    expect(parsed.skillId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recordSkillOutcome — outcome mapping
// ---------------------------------------------------------------------------

describe("recordSkillOutcome outcome mapping", () => {
  it("success outcome bumps successCount and leaves failureCount unchanged", async () => {
    const mock = createMockStore();
    const embedder = createMockEmbedder();
    const stored = await persistSkill(mock.store, embedder, validSkillInput());

    const result = await recordSkillOutcome(mock.store, stored.id, "success");

    expect(result.updated).toBe(true);
    if (!result.updated) throw new Error("guard");
    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(0);
    expect(result.lastRefinedAt).toBeTypeOf("string");

    const skill = getSkillMeta(mock.entries[0]);
    expect(skill.successCount).toBe(1);
    expect(skill.failureCount).toBe(0);
  });

  it("failure outcome bumps failureCount and leaves successCount unchanged", async () => {
    const mock = createMockStore();
    const embedder = createMockEmbedder();
    const stored = await persistSkill(mock.store, embedder, validSkillInput({ name: "skill_fail" }));

    const result = await recordSkillOutcome(mock.store, stored.id, "failure");

    expect(result.updated).toBe(true);
    if (!result.updated) throw new Error("guard");
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(1);
  });

  it("corrected outcome maps to failureCount +1 (counts as failure in binary mapping)", async () => {
    const mock = createMockStore();
    const embedder = createMockEmbedder();
    const stored = await persistSkill(mock.store, embedder, validSkillInput({ name: "skill_corrected" }));

    const result = await recordSkillOutcome(mock.store, stored.id, "corrected");

    expect(result.updated).toBe(true);
    if (!result.updated) throw new Error("guard");
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(1);
  });

  it("missed outcome maps to failureCount +1 (counts as failure in binary mapping)", async () => {
    const mock = createMockStore();
    const embedder = createMockEmbedder();
    const stored = await persistSkill(mock.store, embedder, validSkillInput({ name: "skill_missed" }));

    const result = await recordSkillOutcome(mock.store, stored.id, "missed");

    expect(result.updated).toBe(true);
    if (!result.updated) throw new Error("guard");
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(1);
  });

  it("accumulates counts across multiple outcomes on the same skill", async () => {
    const mock = createMockStore();
    const embedder = createMockEmbedder();
    const stored = await persistSkill(mock.store, embedder, validSkillInput({ name: "skill_accumulate" }));

    await recordSkillOutcome(mock.store, stored.id, "success");
    await recordSkillOutcome(mock.store, stored.id, "success");
    await recordSkillOutcome(mock.store, stored.id, "failure");
    await recordSkillOutcome(mock.store, stored.id, "corrected");
    const final = await recordSkillOutcome(mock.store, stored.id, "success");

    expect(final.updated).toBe(true);
    if (!final.updated) throw new Error("guard");
    expect(final.successCount).toBe(3);
    expect(final.failureCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// recordSkillOutcome — error handling
// ---------------------------------------------------------------------------

describe("recordSkillOutcome error handling", () => {
  it("returns skill_not_found when skillId does not exist (does not throw)", async () => {
    const mock = createMockStore();
    const result = await recordSkillOutcome(mock.store, "nonexistent-skill-id", "success");
    expect(result.updated).toBe(false);
    if (result.updated) throw new Error("guard");
    expect(result.reason).toBe("skill_not_found");
  });

  it("returns not_a_skill when entry exists but category is not 'patterns'", async () => {
    const mock = createMockStore();
    await mock.store.store({
      id: "non-skill-entry",
      text: "ordinary event memory",
      vector: [1, 2, 3],
      category: "events",
      scope: TEST_SCOPE,
      importance: 0.5,
      metadata: JSON.stringify({ skill: { name: "ghost", implementation: "..." } }),
    });

    const result = await recordSkillOutcome(mock.store, "non-skill-entry", "success");
    expect(result.updated).toBe(false);
    if (result.updated) throw new Error("guard");
    expect(result.reason).toBe("not_a_skill");
  });

  it("returns skill_metadata_missing when category is 'patterns' but skill metadata is absent", async () => {
    const mock = createMockStore();
    await mock.store.store({
      id: "patterns-without-skill-block",
      text: "generic pattern",
      vector: [1, 2, 3],
      category: "patterns",
      scope: TEST_SCOPE,
      importance: 0.5,
      metadata: JSON.stringify({ tags: ["generic"] }),
    });

    const result = await recordSkillOutcome(mock.store, "patterns-without-skill-block", "success");
    expect(result.updated).toBe(false);
    if (result.updated) throw new Error("guard");
    expect(result.reason).toBe("skill_metadata_missing");
  });
});

// ---------------------------------------------------------------------------
// recordSkillOutcome — metadata integrity
// ---------------------------------------------------------------------------

describe("recordSkillOutcome metadata integrity", () => {
  it("preserves all other skill fields when updating counts", async () => {
    const mock = createMockStore();
    const embedder = createMockEmbedder();
    const input = validSkillInput({ name: "skill_integrity", verification: "check exit code is 0" });
    const stored = await persistSkill(mock.store, embedder, input);

    await recordSkillOutcome(mock.store, stored.id, "success");

    const skill = getSkillMeta(mock.entries[0]);
    expect(skill.name).toBe("skill_integrity");
    expect(skill.description).toBe(input.description);
    expect(skill.triggerPattern).toBe(input.triggerPattern);
    expect(skill.implementationType).toBe("bash");
    expect(skill.implementation).toBe(input.implementation);
    expect(skill.verification).toBe("check exit code is 0");
  });

  it("preserves top-level metadata fields (tags, source, evolution) when updating counts", async () => {
    const mock = createMockStore();
    const embedder = createMockEmbedder();
    const stored = await persistSkill(mock.store, embedder, validSkillInput({ name: "skill_top_meta" }));

    await recordSkillOutcome(mock.store, stored.id, "failure");

    const meta = JSON.parse(mock.entries[0].metadata || "{}");
    expect(meta.source).toBe("agent");
    expect(meta.tags).toEqual(["deploy", "production"]);
    expect(meta.evolution).toBeDefined();
    expect(meta.canonicalKey).toBe("patterns:skill:skill_top_meta");
  });

  it("sets lastRefinedAt to an ISO-8601 timestamp on each update", async () => {
    const mock = createMockStore();
    const embedder = createMockEmbedder();
    const stored = await persistSkill(mock.store, embedder, validSkillInput({ name: "skill_timestamp" }));

    const before = Date.now();
    const result = await recordSkillOutcome(mock.store, stored.id, "success");
    const after = Date.now();

    expect(result.updated).toBe(true);
    if (!result.updated) throw new Error("guard");
    const refinedAt = Date.parse(result.lastRefinedAt);
    expect(refinedAt).toBeGreaterThanOrEqual(before);
    expect(refinedAt).toBeLessThanOrEqual(after);
  });
});
