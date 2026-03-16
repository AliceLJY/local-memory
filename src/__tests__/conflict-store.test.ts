import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { summarizeConflictAdvice } from "../conflict-advisor.js";
import { buildConflictCandidateRecord, resolveConflictCandidate } from "../conflict-engine.js";
import { ConflictCandidateStore } from "../conflict-store.js";

const tempDirs: string[] = [];

function createTempConflictStore(): ConflictCandidateStore {
  const dir = mkdtempSync(join(tmpdir(), "recallnest-conflicts-"));
  tempDirs.push(dir);
  return new ConflictCandidateStore(dir);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createConflictRecord() {
  return buildConflictCandidateRecord({
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
      canonicalKey: "user-reply-style",
    },
    incoming: {
      text: "User prefers colloquial writing that stays grounded and non-salesy.",
      category: "preferences",
      scope: "memory:agent",
      importance: 0.78,
      metadata: JSON.stringify({
        source: "agent",
        canonicalKey: "user-reply-style",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
        promotedFrom: {
          memoryId: "source-1",
          scope: "cc:session-1",
          category: "events",
        },
      }),
      source: "agent",
      sourceMemoryId: "source-1",
      sourceCategory: "events",
    },
  });
}

function createMergeableConflictRecord() {
  return buildConflictCandidateRecord({
    canonicalKey: "user-reply-style",
    category: "preferences",
    fingerprint: "user-reply-style--durable-1--source-1--mergeable",
    reason: "promotion_conflicts_with_existing_durable",
    existing: {
      memoryId: "durable-1",
      text: "User prefers concise grounded technical replies; avoid sales language.",
      category: "preferences",
      scope: "memory:agent",
      importance: 0.84,
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
      canonicalKey: "user-reply-style",
    },
    incoming: {
      text: "User prefers concise grounded technical replies; keep the tone colloquial.",
      category: "preferences",
      scope: "memory:agent",
      importance: 0.78,
      metadata: JSON.stringify({
        source: "agent",
        canonicalKey: "user-reply-style",
        boundary: {
          layer: "durable",
          authority: "structured-memory",
          conflictPolicy: "latest-wins",
          originalCategory: "preferences",
        },
        promotedFrom: {
          memoryId: "source-1",
          scope: "cc:session-1",
          category: "events",
        },
      }),
      source: "agent",
      sourceMemoryId: "source-1",
      sourceCategory: "events",
    },
  });
}

describe("ConflictCandidateStore", () => {
  it("saves, lists, and fetches open conflicts by fingerprint", async () => {
    const store = createTempConflictStore();
    const record = createConflictRecord();
    await store.save(record);

    const fetched = await store.getById(record.conflictId);
    expect(fetched?.conflictId).toBe(record.conflictId);

    const byFingerprint = await store.getOpenByFingerprint(record.fingerprint);
    expect(byFingerprint?.conflictId).toBe(record.conflictId);

    const recent = await store.listRecent({
      status: "open",
      canonicalKey: "user-reply-style",
      limit: 10,
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.conflictId).toBe(record.conflictId);
  });

  it("accepts a unique short conflict ID prefix", async () => {
    const store = createTempConflictStore();
    const record = createConflictRecord();
    await store.save(record);

    const fetched = await store.getById(record.conflictId.slice(0, 8));
    expect(fetched?.conflictId).toBe(record.conflictId);
  });
});

describe("resolveConflictCandidate", () => {
  it("accepts incoming text and updates the existing durable memory", async () => {
    const conflictStore = createTempConflictStore();
    const record = createConflictRecord();
    await conflictStore.save(record);

    const updatedPayloads: any[] = [];
    const existingMemory = {
      id: "durable-1",
      text: "User prefers concise, direct replies.",
      vector: [1, 1, 1],
      category: "preferences",
      scope: "memory:agent",
      importance: 0.84,
      timestamp: 1_700_000_000_001,
      metadata: record.existing.metadata,
    };

    const result = await resolveConflictCandidate({
      store: {
        async getById(id: string) {
          return id === existingMemory.id ? existingMemory : null;
        },
        async update(id: string, updates: any) {
          updatedPayloads.push({ id, updates });
          Object.assign(existingMemory, updates);
          return existingMemory;
        },
      },
      embedder: {
        async embedPassage(text: string) {
          return [text.length, 9, 9];
        },
      },
      conflictStore,
    }, {
      conflictId: record.conflictId,
      resolution: "accept_incoming",
      notes: "Promoted evidence is cleaner than the original durable wording.",
    });

    expect(result.status).toBe("accepted-incoming");
    expect(result.updatedMemoryId).toBe("durable-1");
    expect(updatedPayloads).toHaveLength(1);
    expect(updatedPayloads[0]?.updates.text).toBe(record.incoming.text);
    expect(updatedPayloads[0]?.updates.metadata).toBe(record.incoming.metadata);

    const resolved = await conflictStore.getById(record.conflictId);
    expect(resolved?.status).toBe("accepted-incoming");
    expect(resolved?.resolutionNotes).toContain("cleaner");
  });

  it("can keep the existing durable memory without updating it", async () => {
    const conflictStore = createTempConflictStore();
    const record = createConflictRecord();
    await conflictStore.save(record);

    let updated = false;
    const result = await resolveConflictCandidate({
      store: {
        async getById() {
          return null;
        },
        async update() {
          updated = true;
          return null;
        },
      },
      embedder: {
        async embedPassage() {
          return [0, 0, 0];
        },
      },
      conflictStore,
    }, {
      conflictId: record.conflictId,
      resolution: "keep_existing",
    });

    expect(result.status).toBe("kept-existing");
    expect(updated).toBe(false);

    const resolved = await conflictStore.getById(record.conflictId);
    expect(resolved?.status).toBe("kept-existing");
  });

  it("merges same-category conflicts using the default merge suggestion", async () => {
    const conflictStore = createTempConflictStore();
    const record = createMergeableConflictRecord();
    await conflictStore.save(record);

    const updatedPayloads: any[] = [];
    const existingMemory = {
      id: "durable-1",
      text: record.existing.text,
      vector: [1, 1, 1],
      category: "preferences",
      scope: "memory:agent",
      importance: 0.84,
      timestamp: 1_700_000_000_001,
      metadata: record.existing.metadata,
    };

    const mergeSuggestion = summarizeConflictAdvice(record).mergeSuggestion;
    expect(mergeSuggestion).toBeTruthy();

    const result = await resolveConflictCandidate({
      store: {
        async getById(id: string) {
          return id === existingMemory.id ? existingMemory : null;
        },
        async update(id: string, updates: any) {
          updatedPayloads.push({ id, updates });
          Object.assign(existingMemory, updates);
          return existingMemory;
        },
      },
      embedder: {
        async embedPassage(text: string) {
          return [text.length, 7, 7];
        },
      },
      conflictStore,
    }, {
      conflictId: record.conflictId,
      resolution: "merge",
      notes: "Combine the grounded style and tone guidance.",
    });

    expect(result.status).toBe("merged");
    expect(result.updatedMemoryId).toBe("durable-1");
    expect(updatedPayloads).toHaveLength(1);
    expect(updatedPayloads[0]?.updates.text).toBe(mergeSuggestion);
    expect(updatedPayloads[0]?.updates.importance).toBe(0.84);

    const mergedMetadata = JSON.parse(updatedPayloads[0]?.updates.metadata || "{}");
    expect(mergedMetadata.canonicalKey).toBe("user-reply-style");
    expect(mergedMetadata.promotedFrom?.memoryId).toBe("source-1");
    expect(mergedMetadata.mergedFrom?.conflictId).toBe(record.conflictId);

    const resolved = await conflictStore.getById(record.conflictId);
    expect(resolved?.status).toBe("merged");
    expect(resolved?.resolutionNotes).toContain("grounded style");
  });

  it("rejects merge for cross-category conflicts", async () => {
    const conflictStore = createTempConflictStore();
    const record = buildConflictCandidateRecord({
      canonicalKey: "project-owner",
      category: "events",
      fingerprint: "project-owner--durable-1--source-2--cross-category",
      reason: "canonical_key_conflicts_with_existing_durable",
      existing: {
        memoryId: "durable-1",
        text: "Project owner: RecallNest",
        category: "entities",
        scope: "memory:agent",
        importance: 0.82,
        metadata: recordLikeMetadata("project-owner", "entities"),
        canonicalKey: "project-owner",
      },
      incoming: {
        text: "Project owner observation imported as an event.",
        category: "events",
        scope: "memory:agent",
        importance: 0.74,
        metadata: recordLikeMetadata("project-owner", "events"),
        source: "agent",
        sourceMemoryId: "source-2",
        sourceCategory: "events",
      },
    });
    await conflictStore.save(record);

    await expect(resolveConflictCandidate({
      store: {
        async getById() {
          return {
            id: "durable-1",
            text: "Project owner: RecallNest",
            vector: [1, 1, 1],
            category: "entities",
            scope: "memory:agent",
            importance: 0.82,
            timestamp: 1_700_000_000_002,
            metadata: record.existing.metadata,
          };
        },
        async update() {
          throw new Error("update should not be called");
        },
      },
      embedder: {
        async embedPassage() {
          return [0, 0, 0];
        },
      },
      conflictStore,
    }, {
      conflictId: record.conflictId,
      resolution: "merge",
    })).rejects.toThrow("same-category durable conflicts");
  });
});

function recordLikeMetadata(canonicalKey: string, category: string): string {
  return JSON.stringify({
    source: "agent",
    canonicalKey,
    boundary: {
      layer: "durable",
      authority: "structured-memory",
      conflictPolicy: "latest-wins",
      originalCategory: category,
    },
  });
}
