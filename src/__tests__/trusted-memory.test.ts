import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createAuditLogger } from "../audit-log.js";
import type { AuditEntry } from "../audit-log.js";
import {
  DEFAULT_RETENTION_POLICY,
  loadRetentionPolicy,
  saveRetentionPolicy,
  shouldArchiveByPolicy,
} from "../retention-policy.js";
import type { RetentionPolicy } from "../retention-policy.js";
import { scanForPII } from "../pii-detector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `recallnest-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// F-1: Audit Log
// ---------------------------------------------------------------------------

describe("F-1: audit log", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("log writes an entry and count returns 1", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({ operation: "store", actor: "manual", scope: "test" });

    expect(logger.count()).toBe(1);
  });

  it("log writes multiple entries", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({ operation: "store", actor: "manual" });
    logger.log({ operation: "retrieve", actor: "agent" });
    logger.log({ operation: "delete", actor: "system" });

    expect(logger.count()).toBe(3);
  });

  it("getRecent returns newest first", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({ operation: "store", actor: "manual", details: "first" });
    logger.log({ operation: "update", actor: "agent", details: "second" });
    logger.log({ operation: "delete", actor: "system", details: "third" });

    const recent = logger.getRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].details).toBe("third");
    expect(recent[1].details).toBe("second");
  });

  it("getRecent defaults to 20", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    for (let i = 0; i < 25; i++) {
      logger.log({ operation: "store", actor: "manual", details: `entry-${i}` });
    }

    const recent = logger.getRecent();
    expect(recent).toHaveLength(20);
    expect(recent[0].details).toBe("entry-24");
  });

  it("exportAll returns all entries in order", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({ operation: "store", actor: "manual", details: "a" });
    logger.log({ operation: "update", actor: "agent", details: "b" });

    const all = logger.exportAll();
    expect(all).toHaveLength(2);
    expect(all[0].details).toBe("a");
    expect(all[1].details).toBe("b");
  });

  it("entries have ISO timestamps", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({ operation: "store", actor: "manual" });

    const entries = logger.exportAll();
    expect(entries[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("entries preserve scope and memoryId", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    logger.log({
      operation: "store",
      actor: "api",
      scope: "project:x",
      memoryId: "mem-123",
    });

    const entries = logger.exportAll();
    expect(entries[0].scope).toBe("project:x");
    expect(entries[0].memoryId).toBe("mem-123");
  });

  it("truncates details to 200 chars", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    const longDetails = "x".repeat(300);
    logger.log({ operation: "store", actor: "manual", details: longDetails });

    const entries = logger.exportAll();
    expect(entries[0].details!.length).toBe(200);
  });

  it("returns empty arrays / 0 count when file does not exist", () => {
    const logPath = join(tmpDir, "nonexistent.jsonl");
    const logger = createAuditLogger(logPath);

    expect(logger.getRecent()).toEqual([]);
    expect(logger.exportAll()).toEqual([]);
    expect(logger.count()).toBe(0);
  });

  it("silently handles write to read-only path", () => {
    // Use a path that cannot be written to (deep nested under /dev/null)
    const logger = createAuditLogger("/dev/null/impossible/audit.jsonl");

    // Should not throw
    expect(() => {
      logger.log({ operation: "store", actor: "manual" });
    }).not.toThrow();
  });

  it("creates parent directory if missing", () => {
    const nestedPath = join(tmpDir, "sub", "deep", "audit.jsonl");
    const logger = createAuditLogger(nestedPath);

    logger.log({ operation: "store", actor: "manual" });

    expect(existsSync(nestedPath)).toBe(true);
    expect(logger.count()).toBe(1);
  });

  it("skips malformed lines gracefully", () => {
    const logPath = join(tmpDir, "audit.jsonl");
    // Write some valid and invalid lines
    writeFileSync(
      logPath,
      '{"timestamp":"2026-01-01T00:00:00Z","operation":"store","actor":"manual"}\nBAD LINE\n{"timestamp":"2026-01-02T00:00:00Z","operation":"update","actor":"agent"}\n',
    );

    const logger = createAuditLogger(logPath);
    expect(logger.count()).toBe(2);
    expect(logger.exportAll()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F-2: Retention Policy
// ---------------------------------------------------------------------------

describe("F-2: retention policy", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it("DEFAULT_RETENTION_POLICY has safe defaults", () => {
    expect(DEFAULT_RETENTION_POLICY.autoArchiveAfterDays).toBe(0);
    expect(DEFAULT_RETENTION_POLICY.maxMemories).toBe(0);
    expect(DEFAULT_RETENTION_POLICY.allowHardDelete).toBe(false);
  });

  it("loadRetentionPolicy returns defaults for unconfigured scope", () => {
    const policy = loadRetentionPolicy("unknown-scope", tmpDir);
    expect(policy).toEqual(DEFAULT_RETENTION_POLICY);
  });

  it("save and load round-trips correctly", () => {
    const custom: Partial<RetentionPolicy> = {
      autoArchiveAfterDays: 30,
      maxMemories: 100,
    };

    saveRetentionPolicy("my-scope", custom, tmpDir);
    const loaded = loadRetentionPolicy("my-scope", tmpDir);

    expect(loaded.autoArchiveAfterDays).toBe(30);
    expect(loaded.maxMemories).toBe(100);
    expect(loaded.allowHardDelete).toBe(false); // default preserved
  });

  it("partial save merges with defaults", () => {
    saveRetentionPolicy("scope-a", { allowHardDelete: true }, tmpDir);
    const loaded = loadRetentionPolicy("scope-a", tmpDir);

    expect(loaded.allowHardDelete).toBe(true);
    expect(loaded.autoArchiveAfterDays).toBe(0);
    expect(loaded.maxMemories).toBe(0);
  });

  it("different scopes have independent policies", () => {
    saveRetentionPolicy("scope-x", { maxMemories: 50 }, tmpDir);
    saveRetentionPolicy("scope-y", { maxMemories: 200 }, tmpDir);

    expect(loadRetentionPolicy("scope-x", tmpDir).maxMemories).toBe(50);
    expect(loadRetentionPolicy("scope-y", tmpDir).maxMemories).toBe(200);
  });

  it("shouldArchiveByPolicy: default policy never archives", () => {
    const result = shouldArchiveByPolicy(DEFAULT_RETENTION_POLICY, 365, 9999);
    expect(result.archive).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("shouldArchiveByPolicy: archives when age exceeds limit", () => {
    const policy: RetentionPolicy = {
      autoArchiveAfterDays: 30,
      maxMemories: 0,
      allowHardDelete: false,
    };

    const result = shouldArchiveByPolicy(policy, 31, 10);
    expect(result.archive).toBe(true);
    expect(result.reason).toContain("31d");
    expect(result.reason).toContain("30d");
  });

  it("shouldArchiveByPolicy: does not archive when age is within limit", () => {
    const policy: RetentionPolicy = {
      autoArchiveAfterDays: 30,
      maxMemories: 0,
      allowHardDelete: false,
    };

    expect(shouldArchiveByPolicy(policy, 29, 10).archive).toBe(false);
    expect(shouldArchiveByPolicy(policy, 30, 10).archive).toBe(false);
  });

  it("shouldArchiveByPolicy: archives when count exceeds limit", () => {
    const policy: RetentionPolicy = {
      autoArchiveAfterDays: 0,
      maxMemories: 100,
      allowHardDelete: false,
    };

    const result = shouldArchiveByPolicy(policy, 5, 101);
    expect(result.archive).toBe(true);
    expect(result.reason).toContain("101");
    expect(result.reason).toContain("100");
  });

  it("shouldArchiveByPolicy: does not archive when count is within limit", () => {
    const policy: RetentionPolicy = {
      autoArchiveAfterDays: 0,
      maxMemories: 100,
      allowHardDelete: false,
    };

    expect(shouldArchiveByPolicy(policy, 5, 99).archive).toBe(false);
    expect(shouldArchiveByPolicy(policy, 5, 100).archive).toBe(false);
  });

  it("allowHardDelete defaults to false", () => {
    saveRetentionPolicy("scope-del", {}, tmpDir);
    const loaded = loadRetentionPolicy("scope-del", tmpDir);
    expect(loaded.allowHardDelete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F-3: PII Detector
// ---------------------------------------------------------------------------

describe("F-3: PII detector", () => {
  it("returns clean result for text without PII", () => {
    const result = scanForPII("This is a normal sentence about programming.");
    expect(result.hasPII).toBe(false);
    expect(result.detections).toHaveLength(0);
    expect(result.summary).toBe("No PII detected");
  });

  it("returns clean result for pure Chinese text without PII", () => {
    const result = scanForPII("今天天气不错，我们去公园散步吧。");
    expect(result.hasPII).toBe(false);
    expect(result.detections).toHaveLength(0);
  });

  it("detects API keys (high severity)", () => {
    const result = scanForPII("My key is sk-1234567890abcdefghijklmnop");
    expect(result.hasPII).toBe(true);
    const apiKey = result.detections.find((d) => d.type === "api_key");
    expect(apiKey).toBeDefined();
    expect(apiKey!.severity).toBe("high");
  });

  it("detects token patterns (high severity)", () => {
    const result = scanForPII("token=abcdefghij1234567890abcdefghij");
    expect(result.hasPII).toBe(true);
    const detection = result.detections.find((d) => d.type === "api_key");
    expect(detection).toBeDefined();
    expect(detection!.severity).toBe("high");
  });

  it("detects passwords (high severity)", () => {
    const result = scanForPII('password="MyS3cretP@ss!"');
    expect(result.hasPII).toBe(true);
    const pwd = result.detections.find((d) => d.type === "password");
    expect(pwd).toBeDefined();
    expect(pwd!.severity).toBe("high");
  });

  it("detects Chinese ID numbers (high severity)", () => {
    const result = scanForPII("身份证号: 110101199003077891");
    expect(result.hasPII).toBe(true);
    const id = result.detections.find((d) => d.type === "id_number");
    expect(id).toBeDefined();
    expect(id!.severity).toBe("high");
  });

  it("detects email addresses (low severity)", () => {
    const result = scanForPII("Contact me at alice@example.com");
    expect(result.hasPII).toBe(true);
    const email = result.detections.find((d) => d.type === "email");
    expect(email).toBeDefined();
    expect(email!.severity).toBe("low");
  });

  it("detects phone numbers (medium severity)", () => {
    const result = scanForPII("我的手机号是 13812345678");
    expect(result.hasPII).toBe(true);
    const phone = result.detections.find((d) => d.type === "phone");
    expect(phone).toBeDefined();
    expect(phone!.severity).toBe("medium");
  });

  it("detects credit card numbers (high severity)", () => {
    const result = scanForPII("Card: 4111-1111-1111-1111");
    expect(result.hasPII).toBe(true);
    const cc = result.detections.find((d) => d.type === "credit_card");
    expect(cc).toBeDefined();
    expect(cc!.severity).toBe("high");
  });

  it("detects credit card without separators", () => {
    const result = scanForPII("Card: 4111111111111111");
    expect(result.hasPII).toBe(true);
    const cc = result.detections.find((d) => d.type === "credit_card");
    expect(cc).toBeDefined();
  });

  it("detects multiple PII types in mixed text", () => {
    const text =
      "User alice@test.com has password=SuperSecret123 and phone 13900001234. " +
      "API key: sk-abcdefghijklmnopqrstuvwxyz";
    const result = scanForPII(text);

    expect(result.hasPII).toBe(true);
    const types = new Set(result.detections.map((d) => d.type));
    expect(types.has("email")).toBe(true);
    expect(types.has("password")).toBe(true);
    expect(types.has("phone")).toBe(true);
    expect(types.has("api_key")).toBe(true);
    expect(result.detections.length).toBeGreaterThanOrEqual(4);
  });

  it("masks sensitive matches (preserves head/tail, masks middle)", () => {
    const result = scanForPII("token=abcdefghijklmnopqrstuvwxyz1234");
    expect(result.hasPII).toBe(true);
    const detection = result.detections[0];
    // Masked value should contain ***
    expect(detection.match).toContain("***");
    // Should not contain the full original value
    expect(detection.match.length).toBeLessThan(
      "token=abcdefghijklmnopqrstuvwxyz1234".length,
    );
  });

  it("mask preserves first 4 and last 4 chars for long values", () => {
    // Email is a good test case: alice@example.com (17 chars, > 8)
    const result = scanForPII("email: alice@example.com");
    const email = result.detections.find((d) => d.type === "email");
    expect(email).toBeDefined();
    // "alice@example.com" -> "alic***e.com"
    expect(email!.match.startsWith("alic")).toBe(true);
    expect(email!.match.endsWith(".com")).toBe(true);
    expect(email!.match).toContain("***");
  });

  it("provides accurate summary counts", () => {
    const text =
      "password=MySecret123 alice@test.com 13812345678";
    const result = scanForPII(text);

    // Should mention total count and severity breakdown
    expect(result.summary).toContain("Found");
    expect(result.summary).toMatch(/\d+ high/);
    expect(result.summary).toMatch(/\d+ medium/);
    expect(result.summary).toMatch(/\d+ low/);
  });

  it("records position (char offset) of matches", () => {
    const text = "prefix alice@example.com suffix";
    const result = scanForPII(text);
    const email = result.detections.find((d) => d.type === "email");
    expect(email).toBeDefined();
    expect(email!.position).toBe(text.indexOf("alice@example.com"));
  });

  it("handles empty string", () => {
    const result = scanForPII("");
    expect(result.hasPII).toBe(false);
    expect(result.detections).toHaveLength(0);
  });

  it("can be called multiple times (regex state reset)", () => {
    // Ensures global regex lastIndex is properly reset between calls
    const text = "sk-abcdefghijklmnopqrstuvwxyz";
    const r1 = scanForPII(text);
    const r2 = scanForPII(text);
    expect(r1.detections.length).toBe(r2.detections.length);
    expect(r1.hasPII).toBe(r2.hasPII);
  });
});

// ---------------------------------------------------------------------------
// F-2 Integration: Retention Policy + Auto-GC
// ---------------------------------------------------------------------------

import {
  maybeRunGc,
  resetGcTimestamp,
  DEFAULT_AUTO_GC_CONFIG,
} from "../auto-gc.js";
import { isActiveMemory } from "../memory-evolution.js";

describe("F-2 integration: retention policy + auto-gc", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    resetGcTimestamp();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  /** Build a minimal mock store for auto-gc tests. */
  function makeGcStore(entries: Array<{
    id: string;
    importance: number;
    timestamp: number;
    metadata: string;
    scope: string;
  }>) {
    const data = new Map(entries.map(e => [e.id, {
      ...e,
      text: "test",
      vector: [1, 0, 0],
      category: "events" as const,
    }]));
    const updates: Array<{ id: string; metadata: string }> = [];
    return {
      store: {
        stats: async () => ({ totalCount: data.size, scopeCounts: {}, categoryCounts: {} }),
        list: async () => Array.from(data.values()),
        listPage: async (opts: { limit?: number; offset?: number } = {}) => {
          const { limit = 1000, offset = 0 } = opts;
          return Array.from(data.values()).slice(offset, offset + limit);
        },
        update: async (id: string, patch: { metadata: string }) => {
          updates.push({ id, metadata: patch.metadata });
          const entry = data.get(id);
          if (!entry) return null;
          entry.metadata = patch.metadata;
          return entry;
        },
      },
      updates,
    };
  }

  it("archives memories exceeding autoArchiveAfterDays", async () => {
    const now = Date.now();
    const scope = "project:retention-age";
    // Save a retention policy: autoArchiveAfterDays = 30
    saveRetentionPolicy(scope, { autoArchiveAfterDays: 30 }, tmpDir);

    const activeMeta = JSON.stringify({
      evolution: { status: "active", version: 1 },
    });

    // One memory aged 45 days (above autoArchiveAfterDays=30)
    // Set importance high enough and decay score high enough that decay alone won't archive
    const { store, updates } = makeGcStore([
      {
        id: "aged-mem",
        importance: 0.5,
        timestamp: now - 45 * 86_400_000,
        metadata: activeMeta,
        scope,
      },
    ]);

    const result = await maybeRunGc(
      store as ReturnType<typeof makeGcStore>["store"] & import("../store.js").MemoryStore,
      {
        ...DEFAULT_AUTO_GC_CONFIG,
        minMemoryCount: 1,
        minHoursSinceLastGc: 0,
        // Set a very low decay threshold so decay alone wouldn't trigger
        decayScoreThreshold: 0.001,
        minAgeDays: 60, // Higher than 45 → decay check skipped
      },
      tmpDir,
    );

    expect(result.triggered).toBe(true);
    expect(result.archivedCount).toBe(1);
    expect(updates.length).toBe(1);
    // Verify the archived metadata marks it as archived
    expect(isActiveMemory(updates[0].metadata)).toBe(false);
  });

  it("archives memories when scope exceeds maxMemories", async () => {
    const now = Date.now();
    const scope = "project:retention-count";
    // maxMemories = 5 → with 6 active memories, oldest should be archived
    saveRetentionPolicy(scope, { maxMemories: 5 }, tmpDir);

    const activeMeta = JSON.stringify({
      evolution: { status: "active", version: 1 },
    });

    // Create 6 memories, all recent (within minAgeDays so decay won't fire)
    const entries = Array.from({ length: 6 }, (_, i) => ({
      id: `mem-${i}`,
      importance: 0.5,
      timestamp: now - (i + 1) * 86_400_000, // 1-6 days old
      metadata: activeMeta,
      scope,
    }));

    const { store, updates } = makeGcStore(entries);

    const result = await maybeRunGc(
      store as ReturnType<typeof makeGcStore>["store"] & import("../store.js").MemoryStore,
      {
        ...DEFAULT_AUTO_GC_CONFIG,
        minMemoryCount: 1,
        minHoursSinceLastGc: 0,
        decayScoreThreshold: 0.001, // Very low so decay alone won't trigger
        minAgeDays: 365, // Very high so decay check is skipped
      },
      tmpDir,
    );

    expect(result.triggered).toBe(true);
    // At least one should be archived since activeCount (6) > maxMemories (5)
    expect(result.archivedCount).toBeGreaterThanOrEqual(1);
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it("does not affect existing behavior when no retention config exists", async () => {
    const now = Date.now();
    const scope = "project:no-retention";
    // No saveRetentionPolicy call → default policy (0/0/false) → no policy archival

    const activeMeta = JSON.stringify({
      evolution: { status: "active", version: 1 },
    });

    // Memory aged 10 days, within default minAgeDays (30) → decay skip
    // No retention policy → policy skip
    const { store, updates } = makeGcStore([
      {
        id: "young-mem",
        importance: 0.5,
        timestamp: now - 10 * 86_400_000,
        metadata: activeMeta,
        scope,
      },
    ]);

    const result = await maybeRunGc(
      store as ReturnType<typeof makeGcStore>["store"] & import("../store.js").MemoryStore,
      {
        ...DEFAULT_AUTO_GC_CONFIG,
        minMemoryCount: 1,
        minHoursSinceLastGc: 0,
        minAgeDays: 30,
      },
      tmpDir, // Points to empty retention dir
    );

    expect(result.triggered).toBe(true);
    expect(result.archivedCount).toBe(0);
    expect(updates.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-3 Integration: PII Detection + persistMemory
// ---------------------------------------------------------------------------

import { persistMemory } from "../capture-engine.js";

describe("F-3 integration: PII detection + persistMemory", () => {
  /** Build minimal deps for persistMemory. */
  function createPiiTestDeps() {
    const storedEntries: Array<Record<string, unknown>> = [];
    let seq = 1;
    return {
      storedEntries,
      deps: {
        embedder: {
          async embedPassage(_text: string) {
            return [1, 0, 0];
          },
        },
        store: {
          async store(entry: Record<string, unknown>) {
            const stored = {
              ...entry,
              id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
              timestamp: 1_700_000_000_000 + seq,
            };
            seq += 1;
            storedEntries.push(stored);
            return stored;
          },
          async list(
            _scopeFilter?: string[],
            _category?: string,
            limit = 20,
            offset = 0,
          ) {
            return storedEntries.slice(offset, offset + limit);
          },
          async update(id: string, updates: Record<string, unknown>) {
            const index = storedEntries.findIndex((e) => e.id === id);
            if (index < 0) return null;
            storedEntries[index] = { ...storedEntries[index], ...updates };
            return storedEntries[index];
          },
          async getById(id: string) {
            return storedEntries.find((e) => e.id === id) ?? null;
          },
          async get(id: string) {
            return storedEntries.find((e) => e.id === id) ?? null;
          },
        },
      },
    };
  }

  it("adds piiWarning to metadata when text contains API key", async () => {
    const { deps, storedEntries } = createPiiTestDeps();
    const result = await persistMemory(deps as Parameters<typeof persistMemory>[0], {
      text: "My API key is sk-abcdefghijklmnopqrstuvwxyz",
      category: "events",
      importance: 0.7,
      scope: "project:pii-test",
      source: "manual",
      tags: [],
    });

    expect(result.id).toBeDefined();
    // Check the stored entry's metadata contains piiWarning
    const stored = storedEntries[0];
    const meta = JSON.parse(stored.metadata as string);
    expect(meta.piiWarning).toBeDefined();
    expect(meta.piiWarning.severity).toBe("high");
    expect(meta.piiWarning.detections).toBeGreaterThanOrEqual(1);
    expect(meta.piiWarning.summary).toContain("Found");
  });

  it("does not add piiWarning to metadata for normal text", async () => {
    const { deps, storedEntries } = createPiiTestDeps();
    const result = await persistMemory(deps as Parameters<typeof persistMemory>[0], {
      text: "User prefers dark mode in all applications",
      category: "preferences",
      importance: 0.7,
      scope: "project:pii-test",
      source: "manual",
      tags: [],
    });

    expect(result.id).toBeDefined();
    const stored = storedEntries[0];
    const meta = JSON.parse(stored.metadata as string);
    expect(meta.piiWarning).toBeUndefined();
  });

  it("PII detection does not block write (text with PII is still stored)", async () => {
    const { deps, storedEntries } = createPiiTestDeps();
    const sensitiveText =
      "password=SuperSecret123 and token=abcdefghijklmnopqrstuvwxyz1234";
    const result = await persistMemory(deps as Parameters<typeof persistMemory>[0], {
      text: sensitiveText,
      category: "events",
      importance: 0.7,
      scope: "project:pii-test",
      source: "manual",
      tags: [],
    });

    // Memory was stored despite PII
    expect(result.id).toBeDefined();
    expect(result.disposition).toBe("stored");
    expect(storedEntries.length).toBe(1);
    // The stored text is the original text (not redacted)
    expect(storedEntries[0].text).toBe(sensitiveText);
  });
});

// ---------------------------------------------------------------------------
// F-1 integration: audit logger in persistMemory & maybeRunGc
// ---------------------------------------------------------------------------

describe("F-1 integration: audit logger", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = join(tmpdir(), `f1-audit-${randomUUID()}`); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

  it("persistMemory records store audit entry", async () => {
    const { persistMemory } = await import("../capture-engine.js");
    const { createAuditLogger } = await import("../audit-log.js");
    const logPath = join(tmpDir, "audit.jsonl");
    const logger = createAuditLogger(logPath);

    const deps = {
      embedder: { async embedPassage() { return [1, 0, 0]; } },
      store: {
        async store(entry: Record<string, unknown>) { return { ...entry, id: entry.id ?? "test-1", timestamp: Date.now() }; },
        async list() { return []; },
        async update() { return null; },
        async getById() { return null; },
      },
      auditLogger: logger,
    };

    await persistMemory(deps as Parameters<typeof persistMemory>[0], {
      text: "User prefers dark mode",
      category: "preferences",
      scope: "project:test",
      source: "manual",
      importance: 0.7,
      tags: [],
    });

    const entries = logger.exportAll();
    const storeEntry = entries.find(e => e.operation === "store");
    expect(storeEntry).toBeDefined();
    expect(storeEntry!.actor).toBe("manual");
    expect(storeEntry!.scope).toBe("project:test");
  });

  it("maybeRunGc records archive audit entry", async () => {
    const { maybeRunGc, resetGcTimestamp } = await import("../auto-gc.js");
    const { createAuditLogger } = await import("../audit-log.js");
    resetGcTimestamp();

    const logPath = join(tmpDir, "audit-gc.jsonl");
    const logger = createAuditLogger(logPath);
    const now = Date.now();
    const oldTs = now - 120 * 86_400_000;
    const activeMeta = JSON.stringify({ evolution: { status: "active", version: 1, accessCount: 0, lastAccessedAt: null, validFrom: oldTs, validUntil: null } });

    const rows = [{ id: "gc-1", text: "old", importance: 0.1, timestamp: oldTs, metadata: activeMeta, category: "events", scope: "project:test" }];
    const store = {
      async stats() { return { totalCount: 100, scopeCounts: {}, categoryCounts: {} }; },
      async list() { return rows; },
      async listPage(opts: { limit?: number; offset?: number } = {}) {
        const { limit = 1000, offset = 0 } = opts;
        return rows.slice(offset, offset + limit);
      },
      async update(id: string, upd: Record<string, unknown>) { return { id, ...upd }; },
    };

    const result = await maybeRunGc(
      store as Parameters<typeof maybeRunGc>[0],
      { minMemoryCount: 1, minHoursSinceLastGc: 0, decayScoreThreshold: 0.99, maxArchivePerRun: 10, minAgeDays: 30 },
      undefined, // retentionConfigDir
      logger,    // auditLogger (4th param)
    );

    expect(result.archivedCount).toBe(1);
    const archiveEntry = logger.exportAll().find(e => e.operation === "archive");
    expect(archiveEntry).toBeDefined();
    expect(archiveEntry!.memoryId).toBe("gc-1");
    expect(archiveEntry!.actor).toBe("system");
  });
});
