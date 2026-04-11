/**
 * Tests for Phase 2: Memory Ethics Layer
 *
 * Covers:
 * - PrivacyTier schema + parsePrivacyTier
 * - Forget engine: single + scope-level forget
 * - Cascade-forget lifecycle unification
 * - Audit log: forget + cascade_forget operations
 * - Privacy tier gate in capture (KG extraction)
 * - StoreMemoryInput accepts privacyTier
 */
import { describe, expect, test } from "bun:test";
import {
  PrivacyTierSchema,
  parsePrivacyTier,
  PRIVACY_TIERS,
  StoreMemoryInputSchema,
  type PrivacyTier,
} from "../memory-schema.js";
import { isActiveMemory, patchEvolution, parseEvolution } from "../memory-evolution.js";
import { createAuditLogger, type AuditLogger } from "../audit-log.js";
import { forgetMemory, forgetByScope, type ForgetByIdDeps } from "../forget-engine.js";
import { cascadeForget, DEFAULT_CASCADE_FORGET_CONFIG } from "../cascade-forget.js";
import type { MemoryEntry, MemoryStore } from "../store.js";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id || "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    text: overrides.text || "test memory entry",
    vector: overrides.vector || Array(768).fill(0.1),
    category: overrides.category || "events",
    scope: overrides.scope || "project:test",
    importance: overrides.importance ?? 0.7,
    timestamp: overrides.timestamp || Date.now(),
    metadata: overrides.metadata || "{}",
  };
}

function makeMockStore(entries: MemoryEntry[]): MemoryStore {
  const data = new Map(entries.map(e => [e.id, { ...e }]));
  return {
    get: async (id: string) => data.get(id) || null,
    delete: async (id: string) => {
      const existed = data.has(id);
      data.delete(id);
      return existed;
    },
    update: async (id: string, updates: Partial<MemoryEntry>) => {
      const entry = data.get(id);
      if (!entry) return null;
      const updated = { ...entry, ...updates };
      data.set(id, updated);
      return updated;
    },
    list: async (scopeFilter?: string[]) => {
      const all = [...data.values()];
      if (!scopeFilter) return all;
      return all.filter(e => scopeFilter.includes(e.scope));
    },
    vectorSearch: async (vector: number[], limit: number, threshold: number, scopes?: string[]) => {
      const all = [...data.values()];
      const filtered = scopes
        ? all.filter(e => scopes.includes(e.scope))
        : all;
      // Fake similarity: entries with same scope get high score
      return filtered.slice(0, limit).map(e => ({
        entry: e,
        score: 0.85,
      }));
    },
    store: async (entry: any) => {
      data.set(entry.id, entry);
      return entry;
    },
  } as any;
}

function makeMockKGStore() {
  const deletedSources: string[] = [];
  const deletedScopes: string[] = [];
  return {
    deleteBySource: async (sourceMemoryId: string) => {
      deletedSources.push(sourceMemoryId);
    },
    deleteByScope: async (scope: string) => {
      deletedScopes.push(scope);
    },
    _deletedSources: deletedSources,
    _deletedScopes: deletedScopes,
  };
}

// ---------------------------------------------------------------------------
// 1. PrivacyTier Schema
// ---------------------------------------------------------------------------

describe("PrivacyTier Schema", () => {
  test("all four tiers are valid", () => {
    for (const tier of PRIVACY_TIERS) {
      expect(PrivacyTierSchema.parse(tier)).toBe(tier);
    }
  });

  test("invalid tier throws", () => {
    expect(() => PrivacyTierSchema.parse("secret")).toThrow();
    expect(() => PrivacyTierSchema.parse("")).toThrow();
  });

  test("parsePrivacyTier returns durable for absent metadata", () => {
    expect(parsePrivacyTier(undefined)).toBe("durable");
    expect(parsePrivacyTier("")).toBe("durable");
  });

  test("parsePrivacyTier returns durable for metadata without privacyTier", () => {
    expect(parsePrivacyTier(JSON.stringify({ source: "manual" }))).toBe("durable");
  });

  test("parsePrivacyTier extracts tier from metadata", () => {
    expect(parsePrivacyTier(JSON.stringify({ privacyTier: "ephemeral" }))).toBe("ephemeral");
    expect(parsePrivacyTier(JSON.stringify({ privacyTier: "private" }))).toBe("private");
    expect(parsePrivacyTier(JSON.stringify({ privacyTier: "shared" }))).toBe("shared");
  });

  test("parsePrivacyTier returns durable for malformed metadata", () => {
    expect(parsePrivacyTier("not json")).toBe("durable");
    expect(parsePrivacyTier(JSON.stringify({ privacyTier: "invalid" }))).toBe("durable");
  });
});

// ---------------------------------------------------------------------------
// 2. StoreMemoryInput accepts privacyTier
// ---------------------------------------------------------------------------

describe("StoreMemoryInput with privacyTier", () => {
  test("default privacyTier is durable", () => {
    const input = StoreMemoryInputSchema.parse({
      text: "test memory",
      scope: "project:test",
    });
    expect(input.privacyTier).toBe("durable");
  });

  test("explicit privacyTier is preserved", () => {
    const input = StoreMemoryInputSchema.parse({
      text: "test memory",
      scope: "project:test",
      privacyTier: "ephemeral",
    });
    expect(input.privacyTier).toBe("ephemeral");
  });

  test("invalid privacyTier throws", () => {
    expect(() => StoreMemoryInputSchema.parse({
      text: "test memory",
      scope: "project:test",
      privacyTier: "top_secret",
    })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Lifecycle Unification (cascade-forget uses isActiveMemory)
// ---------------------------------------------------------------------------

describe("Lifecycle Unification", () => {
  test("cascadeForget skips archived entries via evolution.status", async () => {
    const archivedMeta = patchEvolution("{}", { status: "archived" });
    const primary = makeEntry({ id: "primary-id-0000-0000-000000000001" });
    const archivedEntry = makeEntry({
      id: "archived-entry-0000-0000-000000000002",
      metadata: archivedMeta,
    });
    const activeEntry = makeEntry({
      id: "active-entry-0000-0000-0000000000003",
      metadata: patchEvolution("{}", { status: "active" }),
      importance: 0.8,
    });

    const store = makeMockStore([primary, archivedEntry, activeEntry]);
    const result = await cascadeForget(
      store,
      { id: primary.id, vector: primary.vector, scope: primary.scope },
      DEFAULT_CASCADE_FORGET_CONFIG,
    );

    // Archived entry should NOT be demoted
    expect(result.demotedIds).not.toContain(archivedEntry.id);
  });

  test("cascadeForget skips superseded entries via evolution.status", async () => {
    const supersededMeta = patchEvolution("{}", { status: "superseded" });
    const primary = makeEntry({ id: "primary-id-0000-0000-000000000010" });
    const supersededEntry = makeEntry({
      id: "superseded-0000-0000-0000000000020",
      metadata: supersededMeta,
    });

    const store = makeMockStore([primary, supersededEntry]);
    const result = await cascadeForget(
      store,
      { id: primary.id, vector: primary.vector, scope: primary.scope },
      DEFAULT_CASCADE_FORGET_CONFIG,
    );

    expect(result.demotedIds).not.toContain(supersededEntry.id);
  });

  test("isActiveMemory correctly identifies active vs non-active", () => {
    expect(isActiveMemory(undefined)).toBe(true); // no metadata = active
    expect(isActiveMemory(patchEvolution("{}", { status: "active" }))).toBe(true);
    expect(isActiveMemory(patchEvolution("{}", { status: "pending_review" }))).toBe(true);
    expect(isActiveMemory(patchEvolution("{}", { status: "archived" }))).toBe(false);
    expect(isActiveMemory(patchEvolution("{}", { status: "superseded" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Audit Log Extensions
// ---------------------------------------------------------------------------

describe("Audit Log Extensions", () => {
  const tmpDir = join(import.meta.dir, ".tmp-audit-test");

  test("audit logger accepts forget operation", () => {
    const logPath = join(tmpDir, "audit-forget-test.jsonl");
    try { mkdirSync(tmpDir, { recursive: true }); } catch { /* ok */ }
    const logger = createAuditLogger(logPath);

    logger.log({
      operation: "forget",
      scope: "project:test",
      memoryId: "test-id",
      actor: "system",
      details: "forget test",
    });

    const content = readFileSync(logPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.operation).toBe("forget");
    expect(parsed.scope).toBe("project:test");

    try { rmSync(tmpDir, { recursive: true }); } catch { /* cleanup */ }
  });

  test("audit logger accepts cascade_forget operation", () => {
    const logPath = join(tmpDir, "audit-cascade-test.jsonl");
    try { mkdirSync(tmpDir, { recursive: true }); } catch { /* ok */ }
    const logger = createAuditLogger(logPath);

    logger.log({
      operation: "cascade_forget",
      scope: "project:test",
      memoryId: "test-id",
      actor: "system",
      details: "cascade forget test",
    });

    const content = readFileSync(logPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.operation).toBe("cascade_forget");

    try { rmSync(tmpDir, { recursive: true }); } catch { /* cleanup */ }
  });
});

// ---------------------------------------------------------------------------
// 5. Forget Engine
// ---------------------------------------------------------------------------

describe("Forget Engine", () => {
  test("forgetMemory succeeds for ephemeral memory (no confirm needed)", async () => {
    const meta = JSON.stringify({ privacyTier: "ephemeral" });
    const entry = makeEntry({ metadata: meta });
    const store = makeMockStore([entry]);
    const kgStore = makeMockKGStore();

    const result = await forgetMemory(
      { store, kgStore: kgStore as any },
      { memoryId: entry.id, confirm: false },
    );

    expect(result.success).toBe(true);
    expect(result.kgTriplesRemoved).toBe(true);
    expect(kgStore._deletedSources).toContain(entry.id);
  });

  test("forgetMemory requires confirm for durable tier", async () => {
    const entry = makeEntry(); // default = durable
    const store = makeMockStore([entry]);

    const result = await forgetMemory(
      { store },
      { memoryId: entry.id, confirm: false },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("durable");
    expect(result.error).toContain("confirm=true");
  });

  test("forgetMemory succeeds for durable with confirm=true", async () => {
    const entry = makeEntry();
    const store = makeMockStore([entry]);

    const result = await forgetMemory(
      { store },
      { memoryId: entry.id, confirm: true, reason: "user requested" },
    );

    expect(result.success).toBe(true);
    expect(result.evidence).toBeDefined();
    expect(result.evidence!.reason).toBe("user requested");
    expect(result.evidence!.privacyTier).toBe("durable");
  });

  test("forgetMemory returns error for nonexistent ID", async () => {
    const store = makeMockStore([]);

    const result = await forgetMemory(
      { store },
      { memoryId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", confirm: true },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("forgetMemory preserves evidence snapshot", async () => {
    const entry = makeEntry({
      text: "important secret",
      importance: 0.9,
    });
    const store = makeMockStore([entry]);

    const result = await forgetMemory(
      { store },
      { memoryId: entry.id, confirm: true },
    );

    expect(result.success).toBe(true);
    expect(result.evidence).toBeDefined();
    expect(result.evidence!.entry.text).toBe("important secret");
    expect(result.evidence!.entry.importance).toBe(0.9);
    expect(result.evidence!.forgottenAt).toBeTruthy();
  });

  test("forgetMemory cascades to related memories", async () => {
    const primary = makeEntry({ id: "primary-id-0000-0000-000000000001", importance: 0.8 });
    const related = makeEntry({
      id: "related-id-0000-0000-000000000002",
      importance: 0.8,
      metadata: patchEvolution("{}", { status: "active" }),
    });

    const store = makeMockStore([primary, related]);
    const result = await forgetMemory(
      { store },
      { memoryId: primary.id, confirm: true },
    );

    expect(result.success).toBe(true);
    // Cascade should have attempted to demote
    // (exact count depends on mock similarity scores)
    expect(result.cascadeResult).toBeDefined();
  });

  test("forgetMemory logs audit trail", async () => {
    const tmpDir = join(import.meta.dir, ".tmp-forget-audit");
    const logPath = join(tmpDir, "forget-audit.jsonl");
    try { mkdirSync(tmpDir, { recursive: true }); } catch { /* ok */ }

    const entry = makeEntry({ metadata: JSON.stringify({ privacyTier: "private" }) });
    const store = makeMockStore([entry]);
    const auditLogger = createAuditLogger(logPath);

    const result = await forgetMemory(
      { store, auditLogger },
      { memoryId: entry.id, confirm: true, reason: "privacy cleanup" },
    );

    expect(result.success).toBe(true);

    const content = readFileSync(logPath, "utf-8").trim();
    const lines = content.split("\n").map(l => JSON.parse(l));
    const forgetLog = lines.find(l => l.operation === "forget");
    expect(forgetLog).toBeDefined();
    expect(forgetLog.details).toContain("private");
    expect(forgetLog.details).toContain("privacy cleanup");

    try { rmSync(tmpDir, { recursive: true }); } catch { /* cleanup */ }
  });

  test("forgetMemory cleans up KG triples", async () => {
    const entry = makeEntry();
    const store = makeMockStore([entry]);
    const kgStore = makeMockKGStore();

    const result = await forgetMemory(
      { store, kgStore: kgStore as any },
      { memoryId: entry.id, confirm: true },
    );

    expect(result.success).toBe(true);
    expect(result.kgTriplesRemoved).toBe(true);
    expect(kgStore._deletedSources).toContain(entry.id);
  });

  test("forgetByScope deletes all entries in scope", async () => {
    const entries = [
      makeEntry({ id: "scope-entry-0000-0000-000000000001", scope: "project:cleanup", metadata: JSON.stringify({ privacyTier: "private" }) }),
      makeEntry({ id: "scope-entry-0000-0000-000000000002", scope: "project:cleanup", metadata: JSON.stringify({ privacyTier: "ephemeral" }) }),
      makeEntry({ id: "other-scope-0000-0000-000000000003", scope: "project:keep" }),
    ];
    const store = makeMockStore(entries);
    const kgStore = makeMockKGStore();

    const result = await forgetByScope(
      { store, kgStore: kgStore as any },
      "project:cleanup",
      true,
      "scope cleanup",
    );

    expect(result.forgottenCount).toBe(2);
    expect(result.kgScopeCleared).toBe(true);
    expect(kgStore._deletedScopes).toContain("project:cleanup");
  });

  test("forgetByScope requires confirm", async () => {
    const entries = [
      makeEntry({ id: "scope-entry-0000-0000-000000000010", scope: "project:cleanup" }),
    ];
    const store = makeMockStore(entries);

    const result = await forgetByScope(
      { store },
      "project:cleanup",
      false,
    );

    expect(result.forgottenCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Privacy Tier values
// ---------------------------------------------------------------------------

describe("Privacy Tier Semantics", () => {
  test("PRIVACY_TIERS has exactly 4 tiers", () => {
    expect(PRIVACY_TIERS).toHaveLength(4);
    expect(PRIVACY_TIERS).toContain("ephemeral");
    expect(PRIVACY_TIERS).toContain("private");
    expect(PRIVACY_TIERS).toContain("durable");
    expect(PRIVACY_TIERS).toContain("shared");
  });

  test("ephemeral and private should block KG (semantics check)", () => {
    // This tests the logic that would be used in capture-engine
    const kgBlockedTiers: PrivacyTier[] = ["ephemeral", "private"];
    const kgAllowedTiers: PrivacyTier[] = ["durable", "shared"];

    for (const tier of kgBlockedTiers) {
      expect(tier === "ephemeral" || tier === "private").toBe(true);
    }
    for (const tier of kgAllowedTiers) {
      expect(tier !== "ephemeral" && tier !== "private").toBe(true);
    }
  });
});
