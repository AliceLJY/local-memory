import { describe, expect, it } from "bun:test";

import { persistCaseMemory, persistMemory, persistMemoryBatch, persistWorkflowPattern, promoteMemory } from "../capture-engine.js";
import { parseEvolution } from "../memory-evolution.js";

const TEST_SCOPE = "project:test";

function createDeps() {
  const storedEntries: any[] = [];
  const conflicts: any[] = [];
  let seq = 1;

  return {
    storedEntries,
    conflicts,
    deps: {
      embedder: {
        async embedPassage(text: string) {
          return [text.length, 1, 0];
        },
      },
      store: {
        async store(entry: any) {
          const stored = {
            ...entry,
            id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
            timestamp: 1_700_000_000_000 + seq,
          };
          seq += 1;
          storedEntries.push(stored);
          return stored;
        },
        async list(_scopeFilter?: string[], category?: string, limit = 20, offset = 0) {
          return storedEntries
            .filter((entry) => !category || entry.category === category)
            .slice(offset, offset + limit);
        },
        async update(id: string, updates: any) {
          const index = storedEntries.findIndex((entry) => entry.id === id);
          if (index < 0) return null;
          storedEntries[index] = {
            ...storedEntries[index],
            ...updates,
            timestamp: updates.timestamp ?? storedEntries[index].timestamp,
          };
          return storedEntries[index];
        },
        // Mirrors MemoryStore.upsert (mergeInsert on id): honours the caller's id and
        // timestamp verbatim, unlike store() which stamps its own. Belief-history rows
        // depend on both being preserved.
        async upsert(entry: any) {
          const index = storedEntries.findIndex((item) => item.id === entry.id);
          if (index >= 0) {
            storedEntries[index] = { ...entry };
          } else {
            storedEntries.push({ ...entry });
          }
          return entry;
        },
        async getById(id: string) {
          return storedEntries.find((entry) => entry.id === id) || null;
        },
        async get(id: string) {
          const exact = storedEntries.find((entry) => entry.id === id);
          if (exact) return exact;
          const matches = storedEntries.filter((entry) => entry.id.startsWith(id));
          if (matches.length > 1) {
            throw new Error(`Ambiguous prefix "${id}" matches ${matches.length} memories. Use a longer prefix or full ID.`);
          }
          return matches[0] || null;
        },
      },
      conflictStore: {
        async save(record: any) {
          conflicts.push(record);
          return record;
        },
        async replace(record: any) {
          const index = conflicts.findIndex((item) => item.conflictId === record.conflictId);
          if (index >= 0) {
            conflicts[index] = record;
          } else {
            conflicts.push(record);
          }
          return record;
        },
        async getOpenByFingerprint(fingerprint: string) {
          return conflicts.find((item) => item.status === "open" && item.fingerprint === fingerprint) || null;
        },
        async getLatestByFingerprint(fingerprint: string) {
          return conflicts.find((item) => item.fingerprint === fingerprint) || null;
        },
      },
    },
  };
}

describe("persistMemory", () => {
  it("stores durable memory with an explicit scope", async () => {
    const { deps, storedEntries } = createDeps();
    const result = await persistMemory(deps as any, {
      text: "User prefers dark mode",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
      tags: ["ui"],
    });

    expect(result.resolvedScope).toBe(TEST_SCOPE);
    expect(result.canonicalKey).toBe("preferences:user-prefers-dark-mode");
    expect(result.disposition).toBe("stored");
    expect(storedEntries[0].scope).toBe(TEST_SCOPE);
    expect(JSON.parse(storedEntries[0].metadata)).toMatchObject({
      source: "manual",
      tags: ["ui"],
      capture: "store_memory_schema_v1",
      boundary: {
        layer: "durable",
        authority: "structured-memory",
        conflictPolicy: "latest-wins",
        originalCategory: "preferences",
        note: "Structured memory writes are the durable source inside RecallNest.",
      },
      canonicalKey: "preferences:user-prefers-dark-mode",
    });
  });

  it("rejects durable memory writes without a scope", async () => {
    const { deps } = createDeps();

    await expect(persistMemory(deps as any, {
      text: "User prefers dark mode",
      category: "preferences",
      source: "manual",
    })).rejects.toThrow("scope");
  });

  it("infers a slot-aware canonical key for atomic brand-item preferences", async () => {
    const { deps, storedEntries } = createDeps();
    const result = await persistMemory(deps as any, {
      text: "我喜欢吃麦当劳的麦辣鸡翅",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });

    expect(result.canonicalKey).toBe("preferences:brand-item:麦当劳:麦辣鸡翅");
    expect(JSON.parse(storedEntries[0].metadata)).toMatchObject({
      canonicalKey: "preferences:brand-item:麦当劳:麦辣鸡翅",
      preferenceSlot: {
        type: "brand-item",
        brand: "麦当劳",
        item: "麦辣鸡翅",
      },
    });
  });

  it("infers a slot-aware canonical key for reply-style preferences", async () => {
    const { deps, storedEntries } = createDeps();
    const result = await persistMemory(deps as any, {
      text: "User prefers concise, direct replies.",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });

    expect(result.canonicalKey).toBe("preferences:reply-style:concise:direct");
    expect(JSON.parse(storedEntries[0].metadata)).toMatchObject({
      canonicalKey: "preferences:reply-style:concise:direct",
      preferenceSlot: {
        type: "reply-style",
        traits: ["concise", "direct"],
      },
    });
  });

  it("infers a slot-aware canonical key for tool-choice preferences", async () => {
    const { deps, storedEntries } = createDeps();
    const result = await persistMemory(deps as any, {
      text: "Uses Bun over Node.",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });

    expect(result.canonicalKey).toBe("preferences:tool-choice:bun:over:node");
    expect(JSON.parse(storedEntries[0].metadata)).toMatchObject({
      canonicalKey: "preferences:tool-choice:bun:over:node",
      preferenceSlot: {
        type: "tool-choice",
        preferredTool: "bun",
        avoidedTool: "node",
      },
    });
  });

  it("does not infer slot metadata for descriptive non-preference text", async () => {
    const { deps, storedEntries } = createDeps();
    const draftNote = await persistMemory(deps as any, {
      text: "这段文案简洁直接，先别改。",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });
    const migrationNote = await persistMemory(deps as any, {
      text: "文档里写了 uses Bun over Node 的迁移说明。",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });

    expect(draftNote.canonicalKey).toBe("preferences:这段文案简洁直接-先别改");
    expect(migrationNote.canonicalKey).toBe("preferences:文档里写了-uses-bun-over-node-的迁移说明");
    expect(JSON.parse(storedEntries[0].metadata)).not.toHaveProperty("preferenceSlot");
    expect(JSON.parse(storedEntries[1].metadata)).not.toHaveProperty("preferenceSlot");
  });

  it("dedupes an exact canonical durable write instead of storing again", async () => {
    const { deps, storedEntries } = createDeps();
    await persistMemory(deps as any, {
      text: "User prefers dark mode",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
      canonicalKey: "user.reply.style",
    });

    const result = await persistMemory(deps as any, {
      text: "User prefers dark mode",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
      canonicalKey: "user.reply.style",
    });

    expect(result.disposition).toBe("deduped");
    expect(storedEntries).toHaveLength(1);
  });

  it("updates latest-wins categories when canonicalKey matches and text changes", async () => {
    const { deps, storedEntries } = createDeps();
    const first = await persistMemory(deps as any, {
      text: "User prefers concise replies",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
      canonicalKey: "user.reply.style",
    });

    const second = await persistMemory(deps as any, {
      text: "User prefers concise and direct technical replies",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
      canonicalKey: "user.reply.style",
    });

    expect(second.disposition).toBe("updated");
    expect(second.id).toBe(first.id);

    // The canonical row is still updated in place — but the replaced belief is now kept
    // beside it as a superseded history row instead of being overwritten out of existence.
    expect(storedEntries).toHaveLength(2);

    const canonical = storedEntries.find((entry) => entry.id === first.id);
    expect(canonical.text).toContain("direct technical replies");

    const history = storedEntries.find((entry) => entry.id !== first.id);
    expect(history.text).toBe("User prefers concise replies");

    const historyEvo = parseEvolution(history.metadata);
    expect(historyEvo.status).toBe("superseded");
    expect(historyEvo.supersededBy).toBe(first.id);
    expect(historyEvo.validUntil).toBeGreaterThan(0);

    // Bidirectional link: the live belief points back at the version it replaced.
    expect(parseEvolution(canonical.metadata).supersedes).toBe(history.id);
  });

  it("updates the same durable owner when the same atomic preference slot is rephrased", async () => {
    const { deps, storedEntries } = createDeps();
    const first = await persistMemory(deps as any, {
      text: "我喜欢吃麦当劳的麦辣鸡翅",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });

    const second = await persistMemory(deps as any, {
      text: "我很喜欢吃麦当劳的麦辣鸡翅",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });

    expect(first.canonicalKey).toBe("preferences:brand-item:麦当劳:麦辣鸡翅");
    expect(second.canonicalKey).toBe("preferences:brand-item:麦当劳:麦辣鸡翅");
    expect(second.disposition).toBe("updated");
    expect(second.id).toBe(first.id);

    // Rephrasing the same preference slot still lands on one canonical row, plus the
    // archived copy of the wording it replaced.
    expect(storedEntries).toHaveLength(2);
    const history = storedEntries.find((entry) => entry.id !== first.id);
    expect(history.text).toBe("我喜欢吃麦当劳的麦辣鸡翅");
    expect(parseEvolution(history.metadata).status).toBe("superseded");
  });

  it("creates a conflict when the same canonicalKey is reused across durable categories", async () => {
    const { deps, storedEntries, conflicts } = createDeps();
    const baseline = await persistMemory(deps as any, {
      text: "User prefers concise technical replies.",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
      canonicalKey: "user.reply.style.cross-category",
    });

    const result = await persistMemory(deps as any, {
      text: "Reply-style observations imported as an event.",
      category: "events",
      scope: TEST_SCOPE,
      source: "manual",
      canonicalKey: "user.reply.style.cross-category",
    });

    expect(result.disposition).toBe("conflict");
    expect(result.id).toBe(baseline.id);
    expect(typeof result.conflictId).toBe("string");
    expect(storedEntries).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      conflictId: result.conflictId,
      reason: "canonical_key_conflicts_with_existing_durable",
      existing: {
        memoryId: baseline.id,
        category: "preferences",
      },
      incoming: {
        category: "events",
        text: "Reply-style observations imported as an event.",
      },
    });
  });
});

describe("persistMemoryBatch", () => {
  it("applies envelope defaults and per-item overrides", async () => {
    const { deps, storedEntries } = createDeps();
    const result = await persistMemoryBatch(deps as any, {
      scope: "agent:codex",
      source: "agent",
      defaultImportance: 0.65,
      memories: [
        {
          text: "Project RecallNest is the shared memory layer",
          category: "entities",
        },
        {
          text: "Use search_memory at task start",
          category: "patterns",
          importance: 0.9,
          scope: "memory:manual",
          source: "manual",
          tags: ["workflow", "memory"],
          canonicalKey: "workflow.start.search",
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(storedEntries[0].scope).toBe("agent:codex");
    expect(storedEntries[0].importance).toBe(0.65);
    expect(storedEntries[1].scope).toBe("memory:manual");
    expect(storedEntries[1].importance).toBe(0.9);
    expect(result[1].canonicalKey).toBe("workflow-start-search");
    expect(JSON.parse(storedEntries[1].metadata).tags).toEqual(["workflow", "memory"]);
  });
});

describe("persistWorkflowPattern", () => {
  it("stores a structured workflow pattern as durable patterns memory", async () => {
    const { deps, storedEntries } = createDeps();
    const result = await persistWorkflowPattern(deps as any, {
      title: "Cross-window continuity handoff",
      trigger: "When opening a fresh terminal window for the same project",
      steps: [
        "Call resume_context before coding",
        "Review stable context and latest checkpoint",
        "Save checkpoint_session before leaving the window",
      ],
      outcome: "The next window recovers decisions and next actions faster",
      scope: TEST_SCOPE,
      tools: ["resume_context", "checkpoint_session"],
      tags: ["continuity"],
    });

    expect(result.category).toBe("patterns");
    expect(result.disposition).toBe("stored");
    expect(result.canonicalKey).toBe("patterns:cross-window-continuity-handoff");
    expect(result.resolvedScope).toBe(TEST_SCOPE);
    expect(result.tags).toEqual(["continuity", "workflow", "pattern"]);
    expect(result.text).toContain("Workflow pattern: Cross-window continuity handoff");
    expect(result.text).toContain("1. Call resume_context before coding");
    expect(result.text).toContain("Tools: resume_context, checkpoint_session");
    expect(storedEntries[0].category).toBe("patterns");
    expect(JSON.parse(storedEntries[0].metadata)).toMatchObject({
      source: "agent",
      tags: ["continuity", "workflow", "pattern"],
      capture: "workflow_pattern_schema_v1",
      boundary: {
        layer: "durable",
        authority: "structured-memory",
        conflictPolicy: "latest-wins",
        originalCategory: "patterns",
        note: "Structured memory writes are the durable source inside RecallNest.",
      },
      canonicalKey: "patterns:cross-window-continuity-handoff",
      anchor: "Cross-window continuity handoff",
      workflowPattern: {
        title: "Cross-window continuity handoff",
        trigger: "When opening a fresh terminal window for the same project",
        steps: [
          "Call resume_context before coding",
          "Review stable context and latest checkpoint",
          "Save checkpoint_session before leaving the window",
        ],
        outcome: "The next window recovers decisions and next actions faster",
        tools: ["resume_context", "checkpoint_session"],
      },
    });
  });
});

describe("persistCaseMemory", () => {
  it("stores a structured case as durable cases memory", async () => {
    const { deps, storedEntries } = createDeps();
    const result = await persistCaseMemory(deps as any, {
      title: "RecallNest sparse startup context cleanup",
      problem: "resume_context returned noisy transcript fragments instead of a clean project handoff.",
      context: "A fresh RecallNest window was loading issue chatter and unrelated pins into stable context.",
      solutionSteps: [
        "Filter low-signal transcript fragments from stable recall.",
        "Backfill stable context from checkpoint focus, summary, and decisions.",
        "Use task focus fallback only when checkpoint-backed continuity is unavailable.",
      ],
      outcome: "Fresh windows recover project continuity with cleaner stable context and fewer raw transcript leaks.",
      scope: TEST_SCOPE,
      tools: ["resume_context", "checkpoint_session"],
      tags: ["continuity"],
    });

    expect(result.category).toBe("cases");
    expect(result.canonicalKey).toBe("cases:recallnest-sparse-startup-context-cleanup");
    expect(result.resolvedScope).toBe(TEST_SCOPE);
    expect(result.tags).toEqual(["continuity", "case", "solution"]);
    expect(result.text).toContain("Case: RecallNest sparse startup context cleanup");
    expect(result.text).toContain("Problem: resume_context returned noisy transcript fragments");
    expect(result.text).toContain("1. Filter low-signal transcript fragments from stable recall.");
    expect(storedEntries[0].category).toBe("cases");
    expect(JSON.parse(storedEntries[0].metadata)).toMatchObject({
      source: "agent",
      tags: ["continuity", "case", "solution"],
      capture: "case_memory_schema_v1",
      boundary: {
        layer: "durable",
        authority: "structured-memory",
        conflictPolicy: "append-only",
        originalCategory: "cases",
        note: "Structured memory writes are the durable source inside RecallNest.",
      },
      canonicalKey: "cases:recallnest-sparse-startup-context-cleanup",
      anchor: "RecallNest sparse startup context cleanup",
      caseMemory: {
        title: "RecallNest sparse startup context cleanup",
        problem: "resume_context returned noisy transcript fragments instead of a clean project handoff.",
        context: "A fresh RecallNest window was loading issue chatter and unrelated pins into stable context.",
        solutionSteps: [
          "Filter low-signal transcript fragments from stable recall.",
          "Backfill stable context from checkpoint focus, summary, and decisions.",
          "Use task focus fallback only when checkpoint-backed continuity is unavailable.",
        ],
        outcome: "Fresh windows recover project continuity with cleaner stable context and fewer raw transcript leaks.",
        tools: ["resume_context", "checkpoint_session"],
      },
    });
  });

  it("A1: extracts error_signature into metadata from problem text", async () => {
    const { deps, storedEntries } = createDeps();
    await persistCaseMemory(deps as any, {
      title: "Build broke on missing native lib",
      problem: "pip install failed: xmlsec1 not found, exit code 1",
      solutionSteps: ["brew install xmlsec1", "retry pip install"],
      scope: TEST_SCOPE,
      tools: ["pip", "brew"],
    });
    const meta = JSON.parse(storedEntries[0].metadata);
    expect(Array.isArray(meta.error_signature)).toBe(true);
    expect(meta.error_signature.some((s: string) => s.includes("xmlsec1 not found"))).toBe(true);
  });

  it("A1: round-trips optional debugFraming into metadata", async () => {
    const { deps, storedEntries } = createDeps();
    await persistCaseMemory(deps as any, {
      title: "Cron change not applied",
      problem: "service kept old schedule after editing crontab",
      solutionSteps: ["restart the service after editing cron"],
      scope: TEST_SCOPE,
      tools: ["systemctl"],
      debugFraming: {
        rootCause: "implicit_assumption",
        whyPriorFixFailed: "assumed cron reload was automatic",
        defense: "runbook: 改 cron 必 restart 对应服务",
      },
    });
    const meta = JSON.parse(storedEntries[0].metadata);
    expect(meta.debugFraming).toMatchObject({
      rootCause: "implicit_assumption",
      whyPriorFixFailed: "assumed cron reload was automatic",
    });
  });

  it("A1: success-only case yields no reverse-signal error_signature", async () => {
    const { deps, storedEntries } = createDeps();
    await persistCaseMemory(deps as any, {
      title: "Routine weekly digest",
      problem: "need to generate the weekly summary digest on schedule",
      solutionSteps: ["run the digest generator", "review output"],
      outcome: "digest generated successfully, exit code 0",
      scope: TEST_SCOPE,
      tools: ["digest"],
    });
    const meta = JSON.parse(storedEntries[0].metadata);
    // problem 无错误现象 + outcome 成功态(无失败词)不纳入 → 不应抽到 "exit code 0" 反向信号
    expect((meta.error_signature ?? []).some((s: string) => s.includes("exit code 0"))).toBe(false);
  });
});

describe("promoteMemory", () => {
  it("promotes an evidence transcript entry into durable memory with provenance", async () => {
    const { deps, storedEntries } = createDeps();
    const source = await deps.store.store({
      text: "[用户] 用户偏好短句直说。\n\n[助手] 后续回复保持简洁。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session1",
      importance: 0.5,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "User prefers concise, direct replies.",
      category: "preferences",
      scope: TEST_SCOPE,
      canonicalKey: "user.reply.style",
      tags: ["writing"],
    });

    expect(promoted.disposition).toBe("promoted");
    expect(promoted.sourceMemoryId).toBe(source.id);
    expect(promoted.sourceCategory).toBe("events");
    expect(promoted.canonicalKey).toBe("user-reply-style");
    expect(storedEntries).toHaveLength(2);
    expect(JSON.parse(storedEntries[1].metadata)).toMatchObject({
      source: "agent",
      tags: ["writing"],
      capture: "promote_memory_schema_v1",
      boundary: {
        layer: "durable",
        authority: "structured-memory",
        conflictPolicy: "latest-wins",
        originalCategory: "preferences",
        note: "Structured memory writes are the durable source inside RecallNest.",
      },
      canonicalKey: "user-reply-style",
      promotedFrom: {
        memoryId: source.id,
        scope: "cc:session1",
        category: "events",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
        source: "cc",
      },
      preferenceSlot: {
        type: "reply-style",
        traits: ["concise", "direct"],
      },
    });
  });

  it("infers a slot-aware canonical key when promoting an atomic brand-item preference", async () => {
    const { deps, storedEntries } = createDeps();
    const source = await deps.store.store({
      text: "[用户] 我喜欢吃麦当劳的麦辣鸡翅。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session-food-pref",
      importance: 0.5,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "我喜欢吃麦当劳的麦辣鸡翅",
      category: "preferences",
      scope: TEST_SCOPE,
      tags: ["food"],
    });

    expect(promoted.disposition).toBe("promoted");
    expect(promoted.canonicalKey).toBe("preferences:brand-item:麦当劳:麦辣鸡翅");
    expect(JSON.parse(storedEntries[1].metadata)).toMatchObject({
      canonicalKey: "preferences:brand-item:麦当劳:麦辣鸡翅",
      preferenceSlot: {
        type: "brand-item",
        brand: "麦当劳",
        item: "麦辣鸡翅",
      },
    });
  });

  it("accepts a unique source memory prefix for promotion", async () => {
    const { deps } = createDeps();
    const source = await deps.store.store({
      text: "[用户] 用户偏好短句直说。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session-prefix",
      importance: 0.5,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id.slice(0, 8),
      text: "User prefers concise, direct replies.",
      category: "preferences",
      scope: TEST_SCOPE,
      canonicalKey: "user.reply.style.prefix",
      tags: ["writing"],
    });

    expect(promoted.disposition).toBe("promoted");
    expect(promoted.sourceMemoryId).toBe(source.id);
    expect(promoted.canonicalKey).toBe("user-reply-style-prefix");
  });

  it("rejects promoting an already-durable memory", async () => {
    const { deps } = createDeps();
    const durable = await deps.store.store({
      text: "User prefers direct replies.",
      vector: [1, 2, 3],
      category: "preferences",
      scope: "memory:agent",
      importance: 0.8,
      metadata: JSON.stringify({
        source: "agent",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
      }),
    });

    await expect(promoteMemory(deps as any, {
      memoryId: durable.id,
      scope: TEST_SCOPE,
    })).rejects.toThrow("already durable");
  });

  it("creates a conflict candidate instead of silently overwriting durable memory", async () => {
    const { deps, storedEntries, conflicts } = createDeps();
    const source = await deps.store.store({
      text: "[用户] 文章得更口语化，但不能太飘。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session2",
      importance: 0.55,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });
    const durable = await deps.store.store({
      text: "User prefers concise, direct replies.",
      vector: [4, 5, 6],
      category: "preferences",
      scope: "memory:agent",
      importance: 0.9,
      metadata: JSON.stringify({
        source: "agent",
        canonicalKey: "user-reply-style",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "User prefers colloquial writing that stays grounded and non-salesy.",
      category: "preferences",
      scope: TEST_SCOPE,
      canonicalKey: "user.reply.style",
      tags: ["writing"],
    });

    expect(promoted.disposition).toBe("conflict");
    expect(promoted.id).toBe(durable.id);
    expect(typeof promoted.conflictId).toBe("string");
    expect(storedEntries).toHaveLength(2);
    expect(storedEntries[1].text).toBe("User prefers concise, direct replies.");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      conflictId: promoted.conflictId,
      canonicalKey: "user-reply-style",
      reason: "promotion_conflicts_with_existing_durable",
      status: "open",
      existing: {
        memoryId: durable.id,
        text: "User prefers concise, direct replies.",
      },
      incoming: {
        sourceMemoryId: source.id,
        text: "User prefers colloquial writing that stays grounded and non-salesy.",
      },
    });

    const repeated = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "User prefers colloquial writing that stays grounded and non-salesy.",
      category: "preferences",
      scope: TEST_SCOPE,
      canonicalKey: "user.reply.style",
      tags: ["writing"],
    });

    expect(repeated.disposition).toBe("conflict");
    expect(repeated.conflictId).toBe(promoted.conflictId);
    expect(conflicts).toHaveLength(1);
  });

  it("collapses same-slot atomic preference promotions onto the existing durable owner without opening a conflict", async () => {
    const { deps, storedEntries, conflicts } = createDeps();
    const durable = await persistMemory(deps as any, {
      text: "我喜欢吃麦当劳的麦辣鸡翅",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });
    const source = await deps.store.store({
      text: "[用户] 我很喜欢吃麦当劳的麦辣鸡翅。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session-food-pref-rephrase",
      importance: 0.55,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "我很喜欢吃麦当劳的麦辣鸡翅",
      category: "preferences",
      scope: TEST_SCOPE,
      tags: ["food"],
    });

    expect(promoted.disposition).toBe("promoted");
    expect(promoted.id).toBe(durable.id);
    expect(promoted.canonicalKey).toBe("preferences:brand-item:麦当劳:麦辣鸡翅");
    expect(storedEntries).toHaveLength(2);
    expect(storedEntries[0]?.text).toBe("我喜欢吃麦当劳的麦辣鸡翅");
    expect(JSON.parse(storedEntries[0]?.metadata || "{}")).toMatchObject({
      canonicalKey: "preferences:brand-item:麦当劳:麦辣鸡翅",
      preferenceSlot: {
        type: "brand-item",
        brand: "麦当劳",
        item: "麦辣鸡翅",
      },
      provenanceHistoryCount: 1,
      provenanceHistory: [{
        memoryId: source.id,
        scope: "cc:session-food-pref-rephrase",
        category: "events",
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }],
    });
    expect(typeof JSON.parse(storedEntries[0]?.metadata || "{}").provenanceHistory?.[0]?.observedAt).toBe("string");
    expect(conflicts).toHaveLength(0);
  });

  it("collapses same-slot reply-style promotions onto the existing durable owner", async () => {
    const { deps, storedEntries, conflicts } = createDeps();
    const durable = await persistMemory(deps as any, {
      text: "User prefers concise, direct replies.",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });
    const source = await deps.store.store({
      text: "[用户] 用户偏好短句直说。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session-reply-style-slot",
      importance: 0.55,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "User prefers direct, concise replies.",
      category: "preferences",
      scope: TEST_SCOPE,
      tags: ["writing"],
    });

    expect(promoted.disposition).toBe("promoted");
    expect(promoted.id).toBe(durable.id);
    expect(promoted.canonicalKey).toBe("preferences:reply-style:concise:direct");
    expect(JSON.parse(storedEntries[0]?.metadata || "{}")).toMatchObject({
      canonicalKey: "preferences:reply-style:concise:direct",
      preferenceSlot: {
        type: "reply-style",
        traits: ["concise", "direct"],
      },
      provenanceHistoryCount: 1,
      provenanceHistory: [{
        memoryId: source.id,
        scope: "cc:session-reply-style-slot",
        category: "events",
        source: "cc",
      }],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("does not collapse descriptive draft text onto an existing reply-style durable owner", async () => {
    const { deps, storedEntries, conflicts } = createDeps();
    const durable = await persistMemory(deps as any, {
      text: "User prefers concise, direct replies.",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });
    const source = await deps.store.store({
      text: "[用户] 这段文案简洁直接，先别改。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session-reply-style-note",
      importance: 0.55,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "这段文案简洁直接，先别改。",
      category: "preferences",
      scope: TEST_SCOPE,
      tags: ["writing"],
    });

    expect(promoted.disposition).toBe("promoted");
    expect(promoted.id).not.toBe(durable.id);
    expect(promoted.canonicalKey).toBe("preferences:这段文案简洁直接-先别改");
    expect(storedEntries).toHaveLength(3);
    expect(JSON.parse(storedEntries[2]?.metadata || "{}")).toMatchObject({
      canonicalKey: "preferences:这段文案简洁直接-先别改",
      promotedFrom: {
        memoryId: source.id,
        scope: "cc:session-reply-style-note",
        category: "events",
        source: "cc",
      },
    });
    expect(JSON.parse(storedEntries[2]?.metadata || "{}")).not.toHaveProperty("preferenceSlot");
    expect(conflicts).toHaveLength(0);
  });

  it("collapses same-slot tool-choice promotions onto the existing durable owner", async () => {
    const { deps, storedEntries, conflicts } = createDeps();
    const durable = await persistMemory(deps as any, {
      text: "Uses Bun over Node.",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });
    const source = await deps.store.store({
      text: "[用户] 更喜欢用 Bun 而不是 Node。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session-tool-choice-slot",
      importance: 0.55,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "Prefers Bun over Node.",
      category: "preferences",
      scope: TEST_SCOPE,
      tags: ["tooling"],
    });

    expect(promoted.disposition).toBe("promoted");
    expect(promoted.id).toBe(durable.id);
    expect(promoted.canonicalKey).toBe("preferences:tool-choice:bun:over:node");
    expect(JSON.parse(storedEntries[0]?.metadata || "{}")).toMatchObject({
      canonicalKey: "preferences:tool-choice:bun:over:node",
      preferenceSlot: {
        type: "tool-choice",
        preferredTool: "bun",
        avoidedTool: "node",
      },
      provenanceHistoryCount: 1,
      provenanceHistory: [{
        memoryId: source.id,
        scope: "cc:session-tool-choice-slot",
        category: "events",
        source: "cc",
      }],
    });
    expect(conflicts).toHaveLength(0);
  });

  it("does not collapse narrative migration text onto an existing tool-choice durable owner", async () => {
    const { deps, storedEntries, conflicts } = createDeps();
    const durable = await persistMemory(deps as any, {
      text: "Prefers rg over grep.",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });
    const source = await deps.store.store({
      text: "[用户] 文档里写了 uses Bun over Node 的迁移说明。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session-tool-choice-note",
      importance: 0.55,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "文档里写了 uses Bun over Node 的迁移说明。",
      category: "preferences",
      scope: TEST_SCOPE,
      tags: ["tooling"],
    });

    expect(promoted.disposition).toBe("promoted");
    expect(promoted.id).not.toBe(durable.id);
    expect(promoted.canonicalKey).toBe("preferences:文档里写了-uses-bun-over-node-的迁移说明");
    expect(storedEntries).toHaveLength(3);
    expect(JSON.parse(storedEntries[2]?.metadata || "{}")).toMatchObject({
      canonicalKey: "preferences:文档里写了-uses-bun-over-node-的迁移说明",
      promotedFrom: {
        memoryId: source.id,
        scope: "cc:session-tool-choice-note",
        category: "events",
        source: "cc",
      },
    });
    expect(JSON.parse(storedEntries[2]?.metadata || "{}")).not.toHaveProperty("preferenceSlot");
    expect(conflicts).toHaveLength(0);
  });

  it("does not duplicate provenance history when the same exact promotion is repeated", async () => {
    const { deps, storedEntries } = createDeps();
    await persistMemory(deps as any, {
      text: "我喜欢吃麦当劳的麦辣鸡翅",
      category: "preferences",
      scope: TEST_SCOPE,
      source: "manual",
    });
    const source = await deps.store.store({
      text: "[用户] 我喜欢吃麦当劳的麦辣鸡翅。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session-food-pref-exact",
      importance: 0.55,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });

    await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "我喜欢吃麦当劳的麦辣鸡翅",
      category: "preferences",
      scope: TEST_SCOPE,
    });
    await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "我喜欢吃麦当劳的麦辣鸡翅",
      category: "preferences",
      scope: TEST_SCOPE,
    });

    const metadata = JSON.parse(storedEntries[0]?.metadata || "{}");
    expect(metadata.provenanceHistoryCount).toBe(1);
    expect(metadata.provenanceHistory).toHaveLength(1);
    expect(metadata.provenanceHistory[0]?.memoryId).toBe(source.id);
  });

  it("reopens the same conflict record when the same resolved conflict happens again", async () => {
    const { deps, conflicts } = createDeps();
    const source = await deps.store.store({
      text: "[用户] 文章得更口语化，但不能太飘。",
      vector: [1, 2, 3],
      category: "events",
      scope: "cc:session-reopen",
      importance: 0.55,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      }),
    });
    await deps.store.store({
      text: "User prefers concise, direct replies.",
      vector: [4, 5, 6],
      category: "preferences",
      scope: "memory:agent",
      importance: 0.9,
      metadata: JSON.stringify({
        source: "agent",
        canonicalKey: "user-reply-style-reopen",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
      }),
    });

    const first = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "User prefers colloquial writing that stays grounded and non-salesy.",
      category: "preferences",
      scope: TEST_SCOPE,
      canonicalKey: "user.reply.style.reopen",
      tags: ["writing"],
    });

    await deps.conflictStore.replace({
      ...conflicts[0],
      status: "kept-existing",
      updatedAt: "2026-03-16T10:00:00.000Z",
      resolvedAt: "2026-03-16T10:00:00.000Z",
      resolutionNotes: "Previous review kept the existing durable memory.",
    });

    const reopened = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "User prefers colloquial writing that stays grounded and non-salesy.",
      category: "preferences",
      scope: TEST_SCOPE,
      canonicalKey: "user.reply.style.reopen",
      tags: ["writing"],
    });

    expect(reopened.disposition).toBe("conflict");
    expect(reopened.conflictId).toBe(first.conflictId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.status).toBe("open");
    expect(conflicts[0]?.reopenCount).toBe(1);
    expect(typeof conflicts[0]?.lastReopenedAt).toBe("string");
    expect(conflicts[0]?.resolvedAt).toBeUndefined();
    expect(conflicts[0]?.resolutionNotes).toBeUndefined();
  });

  it("blocks inferred cross-category promotions under the same canonicalKey", async () => {
    const { deps, storedEntries, conflicts } = createDeps();
    const durable = await deps.store.store({
      text: "User prefers concise, direct replies.",
      vector: [4, 5, 6],
      category: "preferences",
      scope: "memory:agent",
      importance: 0.9,
      metadata: JSON.stringify({
        source: "agent",
        canonicalKey: "acceptance-writing-tone-category-check",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
      }),
    });
    const source = await deps.store.store({
      text: "[用户] 语气别太端着，口语化点。",
      vector: [1, 2, 3],
      category: "fact",
      scope: "cc:session-category-mismatch",
      importance: 0.55,
      metadata: JSON.stringify({
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
        },
      }),
    });

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      canonicalKey: "acceptance-writing-tone-category-check",
      scope: "memory:acceptance",
      source: "agent",
      tags: ["acceptance-test"],
    });

    expect(promoted.disposition).toBe("conflict");
    expect(promoted.id).toBe(durable.id);
    expect(typeof promoted.conflictId).toBe("string");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      conflictId: promoted.conflictId,
      reason: "canonical_key_conflicts_with_existing_durable",
      existing: {
        memoryId: durable.id,
        category: "preferences",
      },
      incoming: {
        category: "events",
        sourceMemoryId: source.id,
      },
    });
    expect(storedEntries).toHaveLength(2);
  });
});

// Regression (2026-07-10): admission rejections used to drop admission.reason
// entirely — MCP responses showed only "Disposition: rejected" with no way to
// tell which of the four gates fired. rejectionReason must survive to the record.
describe("persistMemory — admission rejection reason passthrough", () => {
  it("surfaces rejectionReason when the noise filter rejects", async () => {
    const { deps } = createDeps();
    const result = await persistMemory(deps as any, {
      text: "hello world, how are you today?",
      category: "events",
      importance: 0.7,
      scope: TEST_SCOPE,
      source: "manual",
    });
    expect(result.disposition).toBe("rejected");
    expect(result.rejectionReason).toBe("noise_detected");
  });

  it("surfaces rejectionReason for too-short text", async () => {
    const { deps } = createDeps();
    const result = await persistMemory(deps as any, {
      text: "短",
      category: "events",
      importance: 0.7,
      scope: TEST_SCOPE,
      source: "manual",
    });
    expect(result.disposition).toBe("rejected");
    expect(result.rejectionReason).toBe("text_too_short");
  });

  it("stores a hippo-prefixed memory instead of rejecting it as a greeting", async () => {
    const { deps } = createDeps();
    const result = await persistMemory(deps as any, {
      text: "hippo-wiki 的索引层已清零并写完 8 个现役工具正文",
      category: "events",
      importance: 0.7,
      scope: TEST_SCOPE,
      source: "manual",
    });
    expect(result.disposition).not.toBe("rejected");
    expect(result.rejectionReason).toBeUndefined();
  });
});

describe("text length contract", () => {
  // persistMemory validates through StoreMemoryInputSchema, whose text field is
  // capped at 4000 chars. Pinned here because a lossy branch sits further down
  // the same function (LC-P5: texts over 8000 get replaced by an LLM summary,
  // or hard-truncated to 8000 when no LLM is available, with no record of the
  // original). This cap is the only thing keeping that branch unreachable —
  // oversized writes are rejected outright rather than silently reduced.
  //
  // If this test fails because the cap moved past 8000, that branch has gone
  // live and originals will start being replaced with nothing to trace them
  // back to. Sort out the large-text branch before updating this test.
  const MAX_TEXT = 4000;

  it("rejects oversized text outright rather than silently reducing it", async () => {
    const { deps, storedEntries } = createDeps();

    await expect(persistMemory(deps as any, {
      text: "x".repeat(MAX_TEXT + 1),
      category: "events",
      scope: TEST_SCOPE,
      source: "manual",
    })).rejects.toThrow(/at most 4000 characters/);

    expect(storedEntries.length).toBe(0);
  });

  it("keeps the lossy large-text branch out of reach", async () => {
    const { deps } = createDeps();

    // 9000 chars would hit the > 8000 summarise/truncate path if it were
    // reachable; the schema stops it first.
    await expect(persistMemory(deps as any, {
      text: "detail worth keeping. ".repeat(410),
      category: "events",
      scope: TEST_SCOPE,
      source: "manual",
    })).rejects.toThrow(/at most 4000 characters/);
  });

  it("accepts text right at the cap", async () => {
    const { deps } = createDeps();
    const text = "a sentence that carries some actual meaning. ".repeat(120).slice(0, MAX_TEXT);
    expect(text.length).toBe(MAX_TEXT);

    // Schema boundary only — whether admission control later judges the content
    // is a separate concern; this asserts the cap itself does not reject.
    await expect(persistMemory(deps as any, {
      text,
      category: "events",
      scope: TEST_SCOPE,
      source: "manual",
    })).resolves.toBeDefined();
  });
});
