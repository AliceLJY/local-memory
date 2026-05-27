import { describe, expect, it } from "bun:test";

import { persistSkill, retrieveSkills } from "../skill-engine.js";
import { SkillInputSchema } from "../skill-schema.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";

const TEST_SCOPE = "project:test";

// ---------------------------------------------------------------------------
// Mock Helpers
// ---------------------------------------------------------------------------

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
      async vectorSearch(
        _vector: number[],
        limit = 5,
        _minScore = 0.3,
        _scopeFilter?: string[],
      ): Promise<MemorySearchResult[]> {
        // Return all entries as results with descending mock scores
        return entries
          .slice(0, limit)
          .map((entry, index) => ({
            entry,
            score: 0.95 - index * 0.1,
          }));
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
    implementationType: "instruction_sequence" as const,
    implementation: "1. Confirm production target. 2. Run pre-deploy checks. 3. Tag release. 4. Notify channel.",
    scope: TEST_SCOPE,
    source: "agent" as const,
    tags: ["deploy", "production"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: SkillInputSchema validation
// ---------------------------------------------------------------------------

describe("SkillInputSchema validation", () => {
  it("accepts valid skill input", () => {
    const input = validSkillInput();
    const parsed = SkillInputSchema.parse(input);
    expect(parsed.name).toBe("deploy_production");
    expect(parsed.implementationType).toBe("instruction_sequence");
  });

  it("rejects empty name", () => {
    expect(() => SkillInputSchema.parse(validSkillInput({ name: "" }))).toThrow();
  });

  it("rejects name exceeding max length", () => {
    const longName = "x".repeat(121);
    expect(() => SkillInputSchema.parse(validSkillInput({ name: longName }))).toThrow();
  });

  it("rejects empty description", () => {
    expect(() => SkillInputSchema.parse(validSkillInput({ description: "" }))).toThrow();
  });

  it("rejects description exceeding max length", () => {
    const longDesc = "x".repeat(501);
    expect(() => SkillInputSchema.parse(validSkillInput({ description: longDesc }))).toThrow();
  });

  it("rejects empty implementation", () => {
    expect(() => SkillInputSchema.parse(validSkillInput({ implementation: "" }))).toThrow();
  });

  it("rejects implementation exceeding max length", () => {
    const longImpl = "x".repeat(5001);
    expect(() => SkillInputSchema.parse(validSkillInput({ implementation: longImpl }))).toThrow();
  });

  it("rejects invalid implementationType", () => {
    expect(() => SkillInputSchema.parse(validSkillInput({ implementationType: "ruby" }))).toThrow();
  });

  it("accepts only instruction_sequence after v2.5 schema 收缩", () => {
    const parsed = SkillInputSchema.parse(validSkillInput({ implementationType: "instruction_sequence" }));
    expect(parsed.implementationType).toBe("instruction_sequence");
  });

  it("rejects pre-v2.5 implementationType values (bash/python/mcp_tool_chain)", () => {
    // v2.5 (2026-05-27) schema 收缩——这些旧值不再被新写入接受
    // 但 parseSkillFromEntry 仍能读出老 metadata 里的 bash/python（backward compat，见下面 retrieveSkills 测试）
    for (const oldType of ["bash", "python", "mcp_tool_chain"]) {
      expect(() => SkillInputSchema.parse(validSkillInput({ implementationType: oldType }))).toThrow();
    }
  });

  it("accepts optional inputSchema", () => {
    const parsed = SkillInputSchema.parse(validSkillInput({
      inputSchema: { type: "object", properties: { env: { type: "string" } } },
    }));
    expect(parsed.inputSchema).toBeDefined();
  });

  it("accepts optional verification", () => {
    const parsed = SkillInputSchema.parse(validSkillInput({
      verification: "curl -f https://prod.example.com/health",
    }));
    expect(parsed.verification).toBe("curl -f https://prod.example.com/health");
  });

  it("defaults source to manual", () => {
    const input = { ...validSkillInput() };
    delete (input as Record<string, unknown>).source;
    const parsed = SkillInputSchema.parse(input);
    expect(parsed.source).toBe("manual");
  });

  it("defaults tags to empty array", () => {
    const input = { ...validSkillInput() };
    delete (input as Record<string, unknown>).tags;
    const parsed = SkillInputSchema.parse(input);
    expect(parsed.tags).toEqual([]);
  });

  it("rejects too many tags", () => {
    expect(() => SkillInputSchema.parse(validSkillInput({
      tags: ["a", "b", "c", "d", "e", "f", "g"],
    }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: persistSkill
// ---------------------------------------------------------------------------

describe("persistSkill", () => {
  it("stores a new skill and returns StoredSkillRecord", async () => {
    const { store } = createMockStore();
    const embedder = createMockEmbedder();
    const result = await persistSkill(store, embedder, validSkillInput());

    expect(result.name).toBe("deploy_production");
    expect(result.implementationType).toBe("instruction_sequence");
    expect(result.scope).toBe(TEST_SCOPE);
    expect(result.id).toBeTruthy();
    expect(result.storedAt).toBeTruthy();
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
  });

  it("stores with category 'patterns' and importance 0.85", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();
    await persistSkill(store, embedder, validSkillInput());

    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe("patterns");
    expect(entries[0].importance).toBe(0.85);
  });

  it("builds full text with skill structure", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();
    await persistSkill(store, embedder, validSkillInput());

    const text = entries[0].text;
    expect(text).toContain("Skill: deploy_production");
    expect(text).toContain("Description: Deploy to production environment");
    expect(text).toContain("Trigger: When user says");
    expect(text).toContain("Type: instruction_sequence");
    expect(text).toContain("Implementation: 1. Confirm production target");
  });

  it("includes skill metadata in entry", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();
    await persistSkill(store, embedder, validSkillInput());

    const meta = JSON.parse(entries[0].metadata || "{}");
    expect(meta.skill).toBeDefined();
    expect(meta.skill.name).toBe("deploy_production");
    expect(meta.skill.implementationType).toBe("instruction_sequence");
    expect(meta.capture).toBe("skill_schema_v1");
    expect(meta.boundary.layer).toBe("durable");
    expect(meta.evolution).toBeDefined();
    expect(meta.evolution.version).toBe(1);
  });

  it("uses deterministic ID from scope + name (idempotent)", async () => {
    const { store } = createMockStore();
    const embedder = createMockEmbedder();

    const first = await persistSkill(store, embedder, validSkillInput());
    const second = await persistSkill(store, embedder, validSkillInput());

    // Same scope + name should produce same ID
    expect(first.id).toBe(second.id);
  });

  it("updates existing skill on second store (version bump)", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    await persistSkill(store, embedder, validSkillInput());
    expect(entries).toHaveLength(1);

    await persistSkill(store, embedder, validSkillInput({
      implementation: "#!/bin/bash\necho 'new deploy...'",
    }));

    // Still only 1 entry (updated, not duplicated)
    expect(entries).toHaveLength(1);

    const meta = JSON.parse(entries[0].metadata || "{}");
    expect(meta.evolution.version).toBe(2);
  });

  it("preserves different skills with different names", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    await persistSkill(store, embedder, validSkillInput({ name: "skill_a" }));
    await persistSkill(store, embedder, validSkillInput({ name: "skill_b" }));

    expect(entries).toHaveLength(2);
    expect(entries[0].id).not.toBe(entries[1].id);
  });

  it("includes canonicalKey in metadata", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();
    await persistSkill(store, embedder, validSkillInput());

    const meta = JSON.parse(entries[0].metadata || "{}");
    expect(meta.canonicalKey).toBe("patterns:skill:deploy_production");
  });

  it("throws on invalid input", async () => {
    const { store } = createMockStore();
    const embedder = createMockEmbedder();

    await expect(persistSkill(store, embedder, { name: "" })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: retrieveSkills
// ---------------------------------------------------------------------------

describe("retrieveSkills", () => {
  it("returns matching skills with scores", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    // Manually add a skill-like entry
    await persistSkill(
      { store: store.store, update: store.update, getById: store.getById },
      embedder,
      validSkillInput(),
    );

    const results = await retrieveSkills(store, embedder, "deploy to production");

    expect(results).toHaveLength(1);
    expect(results[0].skill.name).toBe("deploy_production");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("filters out non-skill pattern entries", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    // Add a non-skill patterns entry (no skill metadata)
    entries.push({
      id: "non-skill-entry",
      text: "Workflow pattern: some pattern",
      vector: [10, 1, 0],
      category: "patterns",
      scope: TEST_SCOPE,
      importance: 0.8,
      timestamp: Date.now(),
      metadata: JSON.stringify({ source: "agent", capture: "workflow_pattern_schema_v1" }),
    });

    const results = await retrieveSkills(store, embedder, "some query");
    expect(results).toHaveLength(0);
  });

  it("filters out non-patterns category entries", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    // Add an entry with a different category
    entries.push({
      id: "events-entry",
      text: "Some event happened",
      vector: [5, 1, 0],
      category: "events",
      scope: TEST_SCOPE,
      importance: 0.7,
      timestamp: Date.now(),
      metadata: "{}",
    });

    const results = await retrieveSkills(store, embedder, "event query");
    expect(results).toHaveLength(0);
  });

  it("returns empty array when no skills match", async () => {
    const { store } = createMockStore();
    const embedder = createMockEmbedder();

    // No entries at all
    const results = await retrieveSkills(store, embedder, "anything");
    expect(results).toEqual([]);
  });

  it("respects limit parameter", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    // Add multiple skill entries
    for (let i = 0; i < 5; i++) {
      entries.push({
        id: `skill-${i}`,
        text: `Skill: skill_${i}`,
        vector: [i, 1, 0],
        category: "patterns",
        scope: TEST_SCOPE,
        importance: 0.85,
        timestamp: Date.now() + i,
        metadata: JSON.stringify({
          source: "agent",
          capture: "skill_schema_v1",
          skill: {
            name: `skill_${i}`,
            description: `Skill ${i}`,
            triggerPattern: "trigger",
            implementationType: "bash",
            implementation: `echo ${i}`,
            successCount: 0,
            failureCount: 0,
          },
        }),
      });
    }

    const results = await retrieveSkills(store, embedder, "skill query", undefined, 2);
    expect(results).toHaveLength(2);
  });

  it("defaults limit to 3", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    // Add 5 skill entries
    for (let i = 0; i < 5; i++) {
      entries.push({
        id: `skill-${i}`,
        text: `Skill: skill_${i}`,
        vector: [i, 1, 0],
        category: "patterns",
        scope: TEST_SCOPE,
        importance: 0.85,
        timestamp: Date.now() + i,
        metadata: JSON.stringify({
          source: "agent",
          capture: "skill_schema_v1",
          skill: {
            name: `skill_${i}`,
            description: `Skill ${i}`,
            triggerPattern: "trigger",
            implementationType: "bash",
            implementation: `echo ${i}`,
            successCount: 0,
            failureCount: 0,
          },
        }),
      });
    }

    const results = await retrieveSkills(store, embedder, "skill query");
    expect(results).toHaveLength(3);
  });

  it("clamps limit to range [1, 10]", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    // Add 1 entry
    entries.push({
      id: "skill-0",
      text: "Skill: test_skill",
      vector: [1, 1, 0],
      category: "patterns",
      scope: TEST_SCOPE,
      importance: 0.85,
      timestamp: Date.now(),
      metadata: JSON.stringify({
        source: "agent",
        capture: "skill_schema_v1",
        skill: {
          name: "test_skill",
          description: "A test skill",
          triggerPattern: "trigger",
          implementationType: "bash",
          implementation: "echo test",
          successCount: 0,
          failureCount: 0,
        },
      }),
    });

    // limit=0 should clamp to 1
    const results = await retrieveSkills(store, embedder, "test", undefined, 0);
    expect(results).toHaveLength(1);
  });

  it("parses skill record fields correctly from metadata", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    entries.push({
      id: "skill-full",
      text: "Skill: full_skill",
      vector: [1, 1, 0],
      category: "patterns",
      scope: TEST_SCOPE,
      importance: 0.85,
      timestamp: 1_700_000_000_000,
      metadata: JSON.stringify({
        source: "manual",
        tags: ["ci", "deploy"],
        capture: "skill_schema_v1",
        skill: {
          name: "full_skill",
          description: "A full featured skill",
          triggerPattern: "When deploying",
          implementationType: "python",
          implementation: "print('hello')",
          inputSchema: { type: "object" },
          verification: "check output",
          successCount: 5,
          failureCount: 1,
          lastRefinedAt: "2025-01-01T00:00:00.000Z",
        },
      }),
    });

    const results = await retrieveSkills(store, embedder, "deploy");
    expect(results).toHaveLength(1);

    const skill = results[0].skill;
    expect(skill.name).toBe("full_skill");
    expect(skill.description).toBe("A full featured skill");
    expect(skill.triggerPattern).toBe("When deploying");
    expect(skill.implementationType).toBe("python");
    expect(skill.implementation).toBe("print('hello')");
    expect(skill.inputSchema).toEqual({ type: "object" });
    expect(skill.verification).toBe("check output");
    expect(skill.source).toBe("manual");
    expect(skill.tags).toEqual(["ci", "deploy"]);
    expect(skill.successCount).toBe(5);
    expect(skill.failureCount).toBe(1);
    expect(skill.lastRefinedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(skill.storedAt).toBeTruthy();
  });

  it("skips entries with malformed metadata", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    entries.push({
      id: "bad-meta",
      text: "Skill: broken",
      vector: [1, 1, 0],
      category: "patterns",
      scope: TEST_SCOPE,
      importance: 0.85,
      timestamp: Date.now(),
      metadata: "not-valid-json{{{",
    });

    const results = await retrieveSkills(store, embedder, "broken");
    expect(results).toHaveLength(0);
  });

  it("skips entries where skill object lacks required fields", async () => {
    const { store, entries } = createMockStore();
    const embedder = createMockEmbedder();

    entries.push({
      id: "incomplete-skill",
      text: "Skill: incomplete",
      vector: [1, 1, 0],
      category: "patterns",
      scope: TEST_SCOPE,
      importance: 0.85,
      timestamp: Date.now(),
      metadata: JSON.stringify({
        skill: { name: "incomplete" },
        // missing implementation
      }),
    });

    const results = await retrieveSkills(store, embedder, "incomplete");
    expect(results).toHaveLength(0);
  });
});
