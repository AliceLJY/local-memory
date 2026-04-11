/**
 * Tests for HP-predictive Phase 5: Predictive Prospective Memory
 *
 * Validates:
 * 1. suggestPredictedReminders() generates and stores predicted reminders
 * 2. Deduplication via vector similarity
 * 3. Predicted reminders stored with ephemeral privacy tier + 7-day expiry
 * 4. acceptPredictedReminder() upgrades predicted → explicit + durable
 * 5. demotePredictedReminder() reduces confidence, expires below threshold
 * 6. formatSuggestedReminders() output format
 * 7. Feature flag gating
 * 8. setReminder() marks source as "explicit"
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  setReminder,
  suggestPredictedReminders,
  acceptPredictedReminder,
  demotePredictedReminder,
  formatSuggestedReminders,
  type SuggestedReminder,
  type ProspectiveMetadata,
} from "../prospective-memory.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";
import type { PredictionContext } from "../prediction-engine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStore() {
  const data = new Map<string, MemoryEntry>();
  let idCounter = 0;

  return {
    data,
    async store(entry: Omit<MemoryEntry, "id" | "timestamp">) {
      const id = `predicted-${++idCounter}`;
      const full: MemoryEntry = {
        ...entry,
        id,
        timestamp: Date.now(),
      } as MemoryEntry;
      data.set(id, full);
      return full;
    },
    async vectorSearch(
      _vector: number[],
      _limit: number,
      _minScore: number,
      _scopeFilter?: string[],
    ): Promise<MemorySearchResult[]> {
      // By default, return no duplicates (empty = no existing similar reminders)
      return [];
    },
    async getById(id: string) {
      return data.get(id) ?? null;
    },
    async update(id: string, upd: { metadata?: string; text?: string; importance?: number }, _scope?: string[]) {
      const entry = data.get(id);
      if (!entry) return null;
      if (upd.metadata) entry.metadata = upd.metadata;
      if (upd.text) entry.text = upd.text;
      if (upd.importance !== undefined) entry.importance = upd.importance;
      return entry;
    },
  };
}

function createMockEmbedder() {
  return {
    async embedPassage(_text: string) {
      return [0.1, 0.2, 0.3];
    },
    async embedBatchPassage(texts: string[]) {
      return texts.map(() => [0.1, 0.2, 0.3]);
    },
  };
}

function makePredictionContext(overrides?: Partial<PredictionContext>): PredictionContext {
  const now = new Date("2026-04-11T12:00:00Z");
  return {
    checkpoints: [{
      checkpointId: "cp-1",
      sessionId: "test-session",
      resolvedScope: "test",
      scope: "test",
      summary: "test",
      task: "test",
      decisions: [],
      openLoops: ["Fix CI pipeline", "Review PR #42"],
      nextActions: [],
      entities: [],
      files: [],
      updatedAt: new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString(), // 48h ago
    }],
    workflowObservations: [],
    frequentMemories: [],
    uncoveredTopics: [],
    now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Feature flag helpers
// ---------------------------------------------------------------------------

let originalEnv: string | undefined;

function enablePredictiveMemory() {
  originalEnv = process.env.RECALLNEST_PREDICTIVE_MEMORY;
  process.env.RECALLNEST_PREDICTIVE_MEMORY = "true";
}

function disablePredictiveMemory() {
  if (originalEnv === undefined) {
    delete process.env.RECALLNEST_PREDICTIVE_MEMORY;
  } else {
    process.env.RECALLNEST_PREDICTIVE_MEMORY = originalEnv;
  }
}

// ---------------------------------------------------------------------------
// suggestPredictedReminders
// ---------------------------------------------------------------------------

describe("suggestPredictedReminders", () => {
  beforeEach(enablePredictiveMemory);
  afterEach(disablePredictiveMemory);

  it("generates predicted reminders from stale open loops", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();
    const ctx = makePredictionContext();

    const suggestions = await suggestPredictedReminders(store as any, embedder as any, ctx, "test");

    expect(suggestions.length).toBeGreaterThan(0);
    const fixCi = suggestions.find(s => s.trigger === "Fix CI pipeline");
    expect(fixCi).toBeTruthy();
    expect(fixCi!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(fixCi!.evidence.length).toBeGreaterThan(0);
  });

  it("stores predicted reminders with correct metadata", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();
    const ctx = makePredictionContext();

    const suggestions = await suggestPredictedReminders(store as any, embedder as any, ctx, "test");

    expect(suggestions.length).toBeGreaterThan(0);
    const entry = store.data.get(suggestions[0].entryId)!;
    expect(entry).toBeTruthy();

    const meta = JSON.parse(entry.metadata);
    expect(meta.prospective.source).toBe("predicted");
    expect(meta.prospective.status).toBe("pending");
    expect(meta.prospective.confidence).toBeGreaterThanOrEqual(0.6);
    expect(meta.prospective.evidence).toBeInstanceOf(Array);
    expect(meta.prospective.lastSuggestedAt).toBeTruthy();
    expect(meta.prospective.expiresAt).toBeTruthy();
    expect(meta.privacyTier).toBe("ephemeral");
    expect(meta.boundary.layer).toBe("ephemeral");
    expect(meta.boundary.authority).toBe("system");
  });

  it("sets lower importance (0.5) for predicted vs explicit (0.75)", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();
    const ctx = makePredictionContext();

    const suggestions = await suggestPredictedReminders(store as any, embedder as any, ctx, "test");
    const entry = store.data.get(suggestions[0].entryId)!;
    expect(entry.importance).toBe(0.5);
  });

  it("sets 7-day expiry on predicted reminders", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();
    const now = new Date("2026-04-11T12:00:00Z");
    const ctx = makePredictionContext({ now });

    const suggestions = await suggestPredictedReminders(store as any, embedder as any, ctx, "test");
    const entry = store.data.get(suggestions[0].entryId)!;
    const meta = JSON.parse(entry.metadata);
    const expiresAt = new Date(meta.prospective.expiresAt);
    const expectedExpiry = new Date(now.getTime() + 7 * 86_400_000);

    // Within 1 minute tolerance
    expect(Math.abs(expiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(60_000);
  });

  it("returns empty when feature flag is off", async () => {
    disablePredictiveMemory();
    const store = createMockStore();
    const embedder = createMockEmbedder();
    const ctx = makePredictionContext();

    const suggestions = await suggestPredictedReminders(store as any, embedder as any, ctx, "test");
    expect(suggestions).toEqual([]);
  });

  it("deduplicates against existing pending reminders", async () => {
    const store = createMockStore();
    // Override vectorSearch to return an existing pending reminder
    store.vectorSearch = async () => {
      const entry: MemoryEntry = {
        id: "existing-1",
        text: "[Reminder] Fix CI pipeline",
        vector: [0.1, 0.2, 0.3],
        category: "patterns",
        scope: "test",
        importance: 0.75,
        timestamp: Date.now(),
        metadata: JSON.stringify({
          prospective: { trigger: "Fix CI", action: "Fix it", status: "pending", source: "explicit", createdAt: new Date().toISOString() },
        }),
      };
      return [{ entry, score: 0.9 }];
    };
    const embedder = createMockEmbedder();
    const ctx = makePredictionContext();

    const suggestions = await suggestPredictedReminders(store as any, embedder as any, ctx, "test");
    // All predictions should be filtered as duplicates since vectorSearch returns matches
    expect(suggestions.length).toBe(0);
  });

  it("returns empty for empty prediction context", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();
    const ctx: PredictionContext = {
      checkpoints: [],
      workflowObservations: [],
      frequentMemories: [],
      uncoveredTopics: [],
    };

    const suggestions = await suggestPredictedReminders(store as any, embedder as any, ctx, "test");
    expect(suggestions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// acceptPredictedReminder
// ---------------------------------------------------------------------------

describe("acceptPredictedReminder", () => {
  beforeEach(enablePredictiveMemory);
  afterEach(disablePredictiveMemory);

  it("upgrades predicted reminder to explicit + durable", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();
    const ctx = makePredictionContext();

    const suggestions = await suggestPredictedReminders(store as any, embedder as any, ctx, "test");
    expect(suggestions.length).toBeGreaterThan(0);

    const entryId = suggestions[0].entryId;
    const result = await acceptPredictedReminder(store as any, entryId);
    expect(result).toBe(true);

    const entry = store.data.get(entryId)!;
    const meta = JSON.parse(entry.metadata);
    expect(meta.prospective.source).toBe("explicit");
    expect(meta.prospective.acceptedAt).toBeTruthy();
    expect(meta.privacyTier).toBe("durable");
    expect(meta.boundary.layer).toBe("durable");
    expect(meta.boundary.authority).toBe("user");
    expect(entry.importance).toBe(0.75);
  });

  it("returns false for non-existent entry", async () => {
    const store = createMockStore();
    const result = await acceptPredictedReminder(store as any, "nonexistent");
    expect(result).toBe(false);
  });

  it("returns false for explicit reminder", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    const entry = await setReminder(store as any, embedder as any, {
      trigger: "test",
      action: "test action",
      scope: "test",
    });

    const result = await acceptPredictedReminder(store as any, entry.id);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// demotePredictedReminder
// ---------------------------------------------------------------------------

describe("demotePredictedReminder", () => {
  beforeEach(enablePredictiveMemory);
  afterEach(disablePredictiveMemory);

  it("reduces confidence by penalty", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();
    const ctx = makePredictionContext();

    const suggestions = await suggestPredictedReminders(store as any, embedder as any, ctx, "test");
    expect(suggestions.length).toBeGreaterThan(0);

    const entryId = suggestions[0].entryId;
    const originalConfidence = suggestions[0].confidence;

    const result = await demotePredictedReminder(store as any, entryId);
    expect(result).toBe(true);

    const entry = store.data.get(entryId)!;
    const meta = JSON.parse(entry.metadata);
    const newConfidence = meta.prospective.confidence;
    expect(newConfidence).toBeLessThan(originalConfidence);
  });

  it("expires reminder when confidence drops below threshold", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();
    const ctx = makePredictionContext();

    const suggestions = await suggestPredictedReminders(store as any, embedder as any, ctx, "test");
    expect(suggestions.length).toBeGreaterThan(0);

    const entryId = suggestions[0].entryId;

    // Manually set confidence just above threshold so one demote pushes below
    const entry = store.data.get(entryId)!;
    const meta = JSON.parse(entry.metadata);
    meta.prospective.confidence = 0.65;
    entry.metadata = JSON.stringify(meta);

    const result = await demotePredictedReminder(store as any, entryId);
    expect(result).toBe(true);

    const updated = JSON.parse(store.data.get(entryId)!.metadata);
    expect(updated.prospective.status).toBe("expired");
    expect(updated.prospective.confidence).toBeLessThan(0.6);
  });

  it("returns false for non-existent entry", async () => {
    const store = createMockStore();
    const result = await demotePredictedReminder(store as any, "nonexistent");
    expect(result).toBe(false);
  });

  it("returns false for explicit reminder", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    const entry = await setReminder(store as any, embedder as any, {
      trigger: "test",
      action: "test action",
      scope: "test",
    });

    const result = await demotePredictedReminder(store as any, entry.id);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatSuggestedReminders
// ---------------------------------------------------------------------------

describe("formatSuggestedReminders", () => {
  it("formats suggestions with confidence labels", () => {
    const suggestions: SuggestedReminder[] = [
      { entryId: "r1", trigger: "CI", action: "Fix CI pipeline", confidence: 0.85, evidence: ["48h old open loop"] },
      { entryId: "r2", trigger: "deploy", action: "Check deploy config", confidence: 0.72, evidence: ["workflow issue"] },
      { entryId: "r3", trigger: "docs", action: "Update docs", confidence: 0.62, evidence: ["uncovered topic"] },
    ];

    const text = formatSuggestedReminders(suggestions);

    expect(text).toContain("--- Suggested Reminders ---");
    expect(text).toContain("[high]");
    expect(text).toContain("[medium]");
    expect(text).toContain("[low]");
    expect(text).toContain("Fix CI pipeline");
    expect(text).toContain("48h old open loop");
  });

  it("returns empty string for no suggestions", () => {
    expect(formatSuggestedReminders([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// setReminder source field
// ---------------------------------------------------------------------------

describe("setReminder source field", () => {
  it("marks explicit reminders with source: explicit", async () => {
    const store = createMockStore();
    const embedder = createMockEmbedder();

    const entry = await setReminder(store as any, embedder as any, {
      trigger: "test",
      action: "test action",
      scope: "test",
    });

    const meta = JSON.parse(entry.metadata);
    expect(meta.prospective.source).toBe("explicit");
  });
});
