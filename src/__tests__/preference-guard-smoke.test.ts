import { describe, expect, it } from "bun:test";

import { promoteMemory } from "../capture-engine.js";
import { formatExplainResults, formatSearchResults } from "../memory-output.js";
import type { RetrievalResult } from "../retriever.js";

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

function buildEvidenceEntry(
  deps: ReturnType<typeof createDeps>["deps"],
  text: string,
  scope: string,
) {
  return deps.store.store({
    text,
    vector: [1, 2, 3],
    category: "events",
    scope,
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
}

function toResult(entry: any, score = 0.91): RetrievalResult {
  return {
    entry,
    score,
    sources: {
      vector: { score: 0.9, rank: 1 },
      bm25: { score: 0.8, rank: 2 },
      fused: { score },
    },
  };
}

describe("preference guard smoke", () => {
  it("renders slot provenance end-to-end for a promoted reply-style preference", async () => {
    const { deps, storedEntries, conflicts } = createDeps();
    const source = await buildEvidenceEntry(
      deps,
      "[用户] 用户偏好短句直说。",
      "cc:session-reply-style-smoke",
    );

    const promoted = await promoteMemory(deps as any, {
      memoryId: source.id,
      text: "User prefers concise, direct replies.",
      category: "preferences",
      scope: TEST_SCOPE,
      tags: ["writing"],
    });

    const entry = storedEntries.find((item) => item.id === promoted.id);
    expect(entry).toBeDefined();

    const searchOutput = formatSearchResults([toResult(entry)], {
      query: "reply style",
      profile: "default",
    });
    const explainOutput = formatExplainResults([toResult(entry)], {
      query: "reply style",
      profile: "default",
    });

    expect(searchOutput).toContain("key:preferences:reply-style:concise:direct");
    expect(searchOutput).toContain("slot:reply-style:concise:direct");
    expect(searchOutput).toContain(`promoted:${source.id.slice(0, 8)}<-evidence/transcript-ingest`);
    expect(explainOutput).toContain("slot:reply-style:concise:direct");
    expect(explainOutput).toContain(`promoted:${source.id.slice(0, 8)}<-evidence/transcript-ingest`);
    expect(conflicts).toHaveLength(0);
  });

  it("keeps descriptive draft and migration notes on plain preferences keys end-to-end", async () => {
    const { deps, storedEntries, conflicts } = createDeps();
    const draftSource = await buildEvidenceEntry(
      deps,
      "[用户] 这段文案简洁直接，先别改。",
      "cc:session-draft-note-smoke",
    );
    const migrationSource = await buildEvidenceEntry(
      deps,
      "[用户] 文档里写了 uses Bun over Node 的迁移说明。",
      "cc:session-migration-note-smoke",
    );

    const promotedDraft = await promoteMemory(deps as any, {
      memoryId: draftSource.id,
      text: "这段文案简洁直接，先别改。",
      category: "preferences",
      scope: TEST_SCOPE,
      tags: ["writing"],
    });
    const promotedMigration = await promoteMemory(deps as any, {
      memoryId: migrationSource.id,
      text: "文档里写了 uses Bun over Node 的迁移说明。",
      category: "preferences",
      scope: TEST_SCOPE,
      tags: ["tooling"],
    });

    const results = [
      storedEntries.find((item) => item.id === promotedDraft.id),
      storedEntries.find((item) => item.id === promotedMigration.id),
    ].filter(Boolean).map((entry) => toResult(entry));

    const searchOutput = formatSearchResults(results, {
      query: "preferences",
      profile: "default",
    });
    const explainOutput = formatExplainResults(results, {
      query: "preferences",
      profile: "default",
    });

    expect(searchOutput).toContain("key:preferences:这段文案简洁直接-先别改");
    expect(searchOutput).toContain("key:preferences:文档里写了-uses-bun-over-node-的迁移说明");
    expect(searchOutput).not.toContain("slot:reply-style:");
    expect(searchOutput).not.toContain("slot:tool-choice:");
    expect(explainOutput).toContain("key:preferences:这段文案简洁直接-先别改");
    expect(explainOutput).toContain("key:preferences:文档里写了-uses-bun-over-node-的迁移说明");
    expect(explainOutput).not.toContain("slot:reply-style:");
    expect(explainOutput).not.toContain("slot:tool-choice:");
    expect(conflicts).toHaveLength(0);
  });
});
