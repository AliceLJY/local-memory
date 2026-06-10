import { describe, expect, it } from "bun:test";

import { scanForPromotions, formatPromotionResult, type PromotionScanResult } from "../skill-promotion.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";

// ---------------------------------------------------------------------------
// Mock Helpers
// ---------------------------------------------------------------------------

let idSeq = 0;

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  idSeq += 1;
  return {
    id: `entry-${String(idSeq).padStart(4, "0")}`,
    text: `Case about deploying to production #${idSeq}`,
    vector: [1, 0, 0],
    category: "cases",
    scope: "project:test",
    importance: 0.7,
    timestamp: 1_700_000_000_000 + idSeq,
    metadata: JSON.stringify({
      evolution: {
        status: "active",
        version: 1,
        accessCount: 0,
        lastAccessedAt: null,
        supersededBy: null,
        consolidatedInto: null,
        sourceMemories: [],
        validFrom: Date.now(),
        validUntil: null,
      },
    }),
    ...overrides,
  };
}

/** Create a vector that is similar to the base [1,0,0] with controlled similarity. */
function similarVector(sim: number): number[] {
  // For cosine similarity, we want cos(theta) = sim
  // Use 2D vector [sim, sqrt(1-sim^2), 0] dot [1, 0, 0] = sim
  const complement = Math.sqrt(1 - sim * sim);
  return [sim, complement, 0];
}

/**
 * Mock 复刻生产 MemoryStore 的真实语义——这是 Bug B 的直接教训:旧 mock 的
 * list 返回带向量的行,而生产 list/listPage 恒返回 vector:[],导致聚类在生产
 * 全部跳过、测试却全绿。任何与生产行为不一致的 mock 简化都可能掩盖同类 bug:
 * - listPage 永远返回 vector: [](轻列语义)
 * - 向量只能通过 getVectors 回填
 * - vectorSearch 的 score = 1/(1+cosineDistance) = 1/(2-cosSim),不是 cosine
 */
function createMockStore(entries: MemoryEntry[]) {
  const calls = { listPage: 0 };
  return {
    calls,
    async listPage(opts: {
      scopeFilter?: string[];
      category?: string;
      limit?: number;
      offset?: number;
      includeVector?: boolean;
    } = {}): Promise<MemoryEntry[]> {
      calls.listPage++;
      const { category, limit = 1000, offset = 0 } = opts;
      const filtered = category ? entries.filter(e => e.category === category) : entries;
      return filtered.slice(offset, offset + limit).map(e => ({ ...e, vector: [] }));
    },
    async getVectors(ids: string[]): Promise<Map<string, number[]>> {
      const m = new Map<string, number[]>();
      for (const id of ids) {
        const e = entries.find(x => x.id === id);
        if (e && e.vector && e.vector.length > 0) m.set(id, e.vector);
      }
      return m;
    },
    async vectorSearch(
      vector: number[],
      limit = 5,
      minScore = 0.3,
      _scopeFilter?: string[],
    ): Promise<MemorySearchResult[]> {
      const scored = entries
        .filter(e => e.vector?.length > 0)
        .map(e => {
          let dot = 0, normA = 0, normB = 0;
          for (let i = 0; i < vector.length; i++) {
            dot += vector[i] * (e.vector[i] ?? 0);
            normA += vector[i] * vector[i];
            normB += (e.vector[i] ?? 0) * (e.vector[i] ?? 0);
          }
          const cos = (normA > 0 && normB > 0)
            ? dot / (Math.sqrt(normA) * Math.sqrt(normB))
            : 0;
          return { entry: e, score: 1 / (2 - cos) };
        })
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(limit, 20));
      return scored;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanForPromotions", () => {
  it("returns 0 candidates for empty scope", async () => {
    const store = createMockStore([]);
    const result = await scanForPromotions(store, "project:empty");

    expect(result.candidates).toHaveLength(0);
    expect(result.scannedCases).toBe(0);
    expect(result.scannedPatterns).toBe(0);
  });

  it("returns 0 candidates when fewer than minCaseOccurrences similar cases", async () => {
    // Two cases with the same vector — below default threshold of 3
    const entries = [
      makeEntry({ vector: [1, 0, 0] }),
      makeEntry({ vector: [0.99, 0.14, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test");

    expect(result.candidates).toHaveLength(0);
    expect(result.scannedCases).toBe(2);
  });

  it("produces case_to_pattern candidate when 3+ similar cases exist", async () => {
    const entries = [
      makeEntry({ text: "Deploy error: missing env var", vector: [1, 0, 0] }),
      makeEntry({ text: "Deploy failure: env variable not set", vector: similarVector(0.95) }),
      makeEntry({ text: "Deploy issue: environment config missing", vector: similarVector(0.90) }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", {
      minCaseOccurrences: 3,
      caseSimilarityThreshold: 0.75,
    });

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    const caseCandidate = result.candidates.find(c => c.type === "case_to_pattern");
    expect(caseCandidate).toBeDefined();
    expect(caseCandidate!.sourceEntries.length).toBeGreaterThanOrEqual(3);
    expect(caseCandidate!.suggestedName).toBeTruthy();
    expect(caseCandidate!.suggestedDescription).toContain("cases");
  });

  it("does not produce candidates from dissimilar cases", async () => {
    // 3 cases with very different vectors
    const entries = [
      makeEntry({ text: "Case A", vector: [1, 0, 0] }),
      makeEntry({ text: "Case B", vector: [0, 1, 0] }),
      makeEntry({ text: "Case C", vector: [0, 0, 1] }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", {
      minCaseOccurrences: 3,
      caseSimilarityThreshold: 0.75,
    });

    expect(result.candidates).toHaveLength(0);
  });

  it("computes confidence using Bayesian smoothing", async () => {
    // 4 similar cases: confidence = 4 / (4 + 2) = 0.667
    const entries = [
      makeEntry({ text: "Deploy error A", vector: [1, 0, 0] }),
      makeEntry({ text: "Deploy error B", vector: similarVector(0.95) }),
      makeEntry({ text: "Deploy error C", vector: similarVector(0.92) }),
      makeEntry({ text: "Deploy error D", vector: similarVector(0.88) }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", {
      minCaseOccurrences: 3,
      caseSimilarityThreshold: 0.75,
    });

    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    const c = result.candidates[0];
    // cluster of 4: confidence = 4/(4+2) = 0.6667
    expect(c.confidence).toBeCloseTo(4 / 6, 2);
  });

  it("produces pattern_to_skill when pattern has steps and related cases", async () => {
    const patternVec: number[] = [0.9, 0.43, 0]; // cos sim with [1,0,0] ~ 0.9
    const entries = [
      makeEntry({
        category: "patterns",
        text: "Production Deploy Pattern\n\nSteps:\n1. Check environment\n2. Run preflight\n3. Deploy containers",
        vector: patternVec,
      }),
      makeEntry({ text: "Deploy case: ran preflight then deployed", vector: [1, 0, 0] }),
      makeEntry({ text: "Deploy fix: environment check before push", vector: similarVector(0.88) }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", {
      caseSimilarityThreshold: 0.75,
    });

    const skillCandidate = result.candidates.find(c => c.type === "pattern_to_skill");
    expect(skillCandidate).toBeDefined();
    expect(skillCandidate!.suggestedImplementation).toContain("Check environment");
    expect(skillCandidate!.sourceEntries.length).toBeGreaterThanOrEqual(3); // pattern + 2 cases
  });

  it("does not produce pattern_to_skill when pattern lacks structured steps", async () => {
    const patternVec: number[] = [0.9, 0.43, 0];
    const entries = [
      makeEntry({
        category: "patterns",
        text: "Just a general note about deploying without structured steps",
        vector: patternVec,
      }),
      makeEntry({ text: "Deploy case one", vector: [1, 0, 0] }),
      makeEntry({ text: "Deploy case two", vector: similarVector(0.88) }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", {
      caseSimilarityThreshold: 0.75,
    });

    const skillCandidate = result.candidates.find(c => c.type === "pattern_to_skill");
    expect(skillCandidate).toBeUndefined();
  });

  it("respects maxCandidates limit", async () => {
    // Create two distinct clusters of 3, but set maxCandidates=1
    const entries = [
      // Cluster 1
      makeEntry({ text: "Deploy A", vector: [1, 0, 0] }),
      makeEntry({ text: "Deploy B", vector: similarVector(0.95) }),
      makeEntry({ text: "Deploy C", vector: similarVector(0.90) }),
      // Cluster 2
      makeEntry({ text: "Auth fix A", vector: [0, 1, 0] }),
      makeEntry({ text: "Auth fix B", vector: [0.1, 0.99, 0] }),
      makeEntry({ text: "Auth fix C", vector: [0.15, 0.98, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", {
      minCaseOccurrences: 3,
      caseSimilarityThreshold: 0.75,
      maxCandidates: 1,
    });

    expect(result.candidates).toHaveLength(1);
  });

  it("filters out archived entries", async () => {
    const archivedMeta = JSON.stringify({
      evolution: {
        status: "archived",
        version: 1,
        accessCount: 0,
        lastAccessedAt: null,
        supersededBy: null,
        consolidatedInto: null,
        sourceMemories: [],
        validFrom: Date.now(),
        validUntil: null,
      },
    });
    const entries = [
      makeEntry({ text: "Active case", vector: [1, 0, 0] }),
      makeEntry({ text: "Archived case", vector: similarVector(0.95), metadata: archivedMeta }),
      makeEntry({ text: "Another archived", vector: similarVector(0.90), metadata: archivedMeta }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", {
      minCaseOccurrences: 3,
    });

    // Only 1 active case, so no candidates
    expect(result.candidates).toHaveLength(0);
    expect(result.scannedCases).toBe(1);
  });

  it("skips entries whose vectors are missing from the store, with disclosure", async () => {
    // getVectors has nothing for these ids (vector: [] in the source data)
    const entries = [
      makeEntry({ text: "No vector case A", vector: [] }),
      makeEntry({ text: "No vector case B", vector: [] }),
      makeEntry({ text: "No vector case C", vector: [] }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test");

    expect(result.candidates).toHaveLength(0);
    expect(result.vectorlessSkipped).toBe(3);
  });

  it("Bug B regression: clusters vectorless list rows via getVectors backfill", async () => {
    // listPage 永远返回 vector:[](生产语义)——候选必须依赖 getVectors 回填产生。
    // 修复前:聚类直接读 list 行的 vector → 全部 continue → 产出恒为零。
    const entries = [
      makeEntry({ text: "Deploy error: missing env var", vector: [1, 0, 0] }),
      makeEntry({ text: "Deploy failure: env variable not set", vector: similarVector(0.95) }),
      makeEntry({ text: "Deploy issue: environment config missing", vector: similarVector(0.9) }),
    ];
    const store = createMockStore(entries);

    // 防御:确认 mock 的 listPage 确实是 vectorless(防 mock 又静默回到带向量)
    const rows = await store.listPage({ category: "cases" });
    expect(rows.every(r => r.vector.length === 0)).toBe(true);

    const result = await scanForPromotions(store, "project:test", {
      minCaseOccurrences: 3,
      caseSimilarityThreshold: 0.75,
    });
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    expect(result.vectorlessSkipped).toBe(0);
  });

  it("paginates the full corpus instead of a single fixed-limit page", async () => {
    // 7 cases with pageSize 2 → at least 4 listPage calls for the cases category
    const entries = Array.from({ length: 7 }, (_, i) =>
      makeEntry({ text: `Deploy error variant ${i}`, vector: similarVector(0.95 - i * 0.01) }),
    );
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", {
      minCaseOccurrences: 3,
      caseSimilarityThreshold: 0.75,
      pageSize: 2,
    });

    expect(store.calls.listPage).toBeGreaterThanOrEqual(4);
    expect(result.scannedCases).toBe(7);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it("does not starve the patterns budget when cases hit maxScanEntries", async () => {
    // 首次生产 dry-run 实测回归:共享预算下 20000 cases 拉满 → patterns scanned=0。
    const entries = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeEntry({ text: `Deploy case ${i}`, vector: similarVector(0.95 - i * 0.01) }),
      ),
      makeEntry({
        category: "patterns",
        text: "Deploy Pattern\n\nSteps:\n1. Preflight\n2. Ship",
        vector: [1, 0, 0],
      }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", { maxScanEntries: 5 });

    expect(result.scannedCases).toBe(5);
    expect(result.scannedPatterns).toBe(1);
  });

  it("clusters within topicTag buckets and discloses bucket-cap truncation", async () => {
    const tagged = (tag: string, text: string, vec: number[]) =>
      makeEntry({
        text,
        vector: vec,
        metadata: JSON.stringify({ topicTag: tag, evolution: { status: "active" } }),
      });
    const entries = [
      tagged("deploy", "Deploy err 1", [1, 0, 0]),
      tagged("deploy", "Deploy err 2", similarVector(0.95)),
      tagged("deploy", "Deploy err 3", similarVector(0.92)),
      tagged("deploy", "Deploy err 4", similarVector(0.9)),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", {
      minCaseOccurrences: 3,
      caseSimilarityThreshold: 0.75,
      maxBucketSize: 3,
    });

    // 4 cases in one bucket, cap 3 → 1 truncated (most recent 3 kept, still clusters)
    expect(result.truncatedCases).toBe(1);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
    const text = formatPromotionResult(result);
    expect(text).toContain("truncated by bucket cap");
  });

  it("candidates are sorted by confidence descending", async () => {
    // Cluster 1: 5 similar cases -> confidence 5/7
    // Cluster 2: 3 similar cases -> confidence 3/5
    const entries = [
      // Large cluster
      makeEntry({ text: "Deploy err 1", vector: [1, 0, 0] }),
      makeEntry({ text: "Deploy err 2", vector: similarVector(0.95) }),
      makeEntry({ text: "Deploy err 3", vector: similarVector(0.93) }),
      makeEntry({ text: "Deploy err 4", vector: similarVector(0.91) }),
      makeEntry({ text: "Deploy err 5", vector: similarVector(0.89) }),
      // Small cluster (orthogonal direction)
      makeEntry({ text: "Auth bug 1", vector: [0, 1, 0] }),
      makeEntry({ text: "Auth bug 2", vector: [0.1, 0.99, 0] }),
      makeEntry({ text: "Auth bug 3", vector: [0.15, 0.98, 0] }),
    ];
    const store = createMockStore(entries);
    const result = await scanForPromotions(store, "project:test", {
      minCaseOccurrences: 3,
      caseSimilarityThreshold: 0.75,
    });

    if (result.candidates.length >= 2) {
      expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(result.candidates[1].confidence);
    }
  });
});

describe("formatPromotionResult", () => {
  it("formats empty results", () => {
    const result: PromotionScanResult = {
      candidates: [],
      scannedCases: 5,
      scannedPatterns: 2,
      truncatedCases: 0,
      vectorlessSkipped: 0,
    };
    const text = formatPromotionResult(result);
    expect(text).toContain("5 cases");
    expect(text).toContain("2 patterns");
    expect(text).toContain("No promotion candidates found");
  });

  it("formats candidates with type and confidence", () => {
    const result: PromotionScanResult = {
      candidates: [{
        type: "case_to_pattern",
        sourceEntries: [{ id: "a", text: "test", score: 0.9 }],
        suggestedName: "Test Pattern",
        suggestedDescription: "A test",
        confidence: 0.6,
      }],
      scannedCases: 3,
      scannedPatterns: 1,
      truncatedCases: 0,
      vectorlessSkipped: 0,
    };
    const text = formatPromotionResult(result);
    expect(text).toContain("case_to_pattern");
    expect(text).toContain("Test Pattern");
    expect(text).toContain("60.0%");
  });

  it("includes implementation in pattern_to_skill output", () => {
    const result: PromotionScanResult = {
      candidates: [{
        type: "pattern_to_skill",
        sourceEntries: [{ id: "a", text: "test", score: 1.0 }],
        suggestedName: "Deploy Skill",
        suggestedDescription: "Deploy automation",
        suggestedImplementation: "1. Check env\n2. Deploy",
        confidence: 0.5,
      }],
      scannedCases: 2,
      scannedPatterns: 1,
      truncatedCases: 0,
      vectorlessSkipped: 0,
    };
    const text = formatPromotionResult(result);
    expect(text).toContain("1. Check env");
    expect(text).toContain("Implementation:");
  });
});
