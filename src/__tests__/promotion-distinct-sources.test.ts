import { describe, expect, it } from "bun:test";

import {
  countDistinctSources,
  extractSourceKey,
  judgeDistinctSources,
  scanForPromotions,
  UNKNOWN_SOURCE_PREFIX,
} from "../skill-promotion.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";

// ---------------------------------------------------------------------------
// Mock（与 skill-promotion.test.ts 同款生产语义：listPage 恒无向量，靠 getVectors 回填）
// ---------------------------------------------------------------------------

let seq = 0;
function makeCase(srcTag: string | null, sim = 1.0, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  seq += 1;
  const complement = Math.sqrt(1 - sim * sim);
  return {
    id: `c-${String(seq).padStart(4, "0")}`,
    text: `Docker 部署时缺系统库导致构建失败 #${seq}`,
    vector: [sim, complement, 0],
    category: "cases",
    scope: "memory:pivot",
    importance: 0.7,
    timestamp: Date.UTC(2026, 7, 20) + seq * 1000,
    metadata: JSON.stringify({
      ...(srcTag ? { tags: [srcTag, "pinned"] } : {}),
      evolution: {
        status: "active", version: 1, accessCount: 0, lastAccessedAt: null,
        supersededBy: null, consolidatedInto: null, sourceMemories: [],
        validFrom: Date.now(), validUntil: null,
      },
    }),
    ...overrides,
  };
}

function createMockStore(entries: MemoryEntry[]) {
  return {
    async listPage(opts: { category?: string; limit?: number; offset?: number } = {}): Promise<MemoryEntry[]> {
      const { category, limit = 1000, offset = 0 } = opts;
      const filtered = category ? entries.filter(e => e.category === category) : entries;
      return filtered.slice(offset, offset + limit).map(e => ({ ...e, vector: [] }));
    },
    async getVectors(ids: string[]): Promise<Map<string, number[]>> {
      const m = new Map<string, number[]>();
      for (const id of ids) {
        const e = entries.find(x => x.id === id);
        if (e?.vector?.length) m.set(id, e.vector);
      }
      return m;
    },
    async vectorSearch(): Promise<MemorySearchResult[]> { return []; },
  };
}

// ---------------------------------------------------------------------------
// 来源识别
// ---------------------------------------------------------------------------

describe("source identity", () => {
  it("prefers evidenceMemories over the src: tag", () => {
    const key = extractSourceKey({
      metadata: JSON.stringify({ evidenceMemories: ["m2", "m1"], tags: ["src:aaaa1111"] }),
      scope: "memory:pivot",
      timestamp: Date.now(),
    });
    // 同一批源不管顺序都是同一个来源
    expect(key).toBe("ev:m1|m2");
  });

  it("falls back to the src: tag that §5.3 requires on pivot writes", () => {
    const key = extractSourceKey({
      metadata: JSON.stringify({ tags: ["pinned", "src:cac4f155", "2026-08-23"] }),
      scope: "memory:pivot",
      timestamp: Date.now(),
    });
    expect(key).toBe("src:cac4f155");
  });

  it("marks the day-bucket fallback as unknown so callers can abstain", () => {
    const key = extractSourceKey({ metadata: "{}", scope: "project:x", timestamp: Date.UTC(2026, 7, 23) });
    expect(key.startsWith(UNKNOWN_SOURCE_PREFIX)).toBe(true);
    expect(key).toBe("day:project:x:2026-08-23");
  });

  it("counts three records from one session as one source", () => {
    const members = [1, 2, 3].map(() => makeCase("src:aaaa1111"));
    expect(countDistinctSources(members)).toBe(1);
  });
});

describe("judgeDistinctSources", () => {
  it("rejects a cluster that is one experience repeated", () => {
    const verdict = judgeDistinctSources([1, 2, 3].map(() => makeCase("src:aaaa1111")), 2);
    expect(verdict.status).toBe("rejected");
  });

  it("accepts a cluster spanning two different sessions", () => {
    const verdict = judgeDistinctSources(
      [makeCase("src:aaaa1111"), makeCase("src:aaaa1111"), makeCase("src:bbbb2222")],
      2,
    );
    expect(verdict).toEqual({ status: "ok", distinctSources: 2 });
  });

  it("abstains — never rejects — when no record carries a real source pointer", () => {
    // 全库 cases 只有 1.2% 带 src:，一律硬判会把「同一天解决的三个不同问题」误伤掉。
    expect(judgeDistinctSources([1, 2, 3].map(() => makeCase(null)), 2)).toEqual({ status: "abstained" });
  });

  it("is disabled at minDistinctSources=1 (the pre-P2 behaviour)", () => {
    const verdict = judgeDistinctSources([1, 2, 3].map(() => makeCase("src:aaaa1111")), 1);
    expect(verdict.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 改前 / 改后对照 —— 「同一个坑踩三次」的具体例子
// ---------------------------------------------------------------------------

describe("promotion scan: same pothole three times vs two real tasks", () => {
  it("promotes it under the old rule and rejects it under the new one", async () => {
    const samePothole = [1, 2, 3].map(() => makeCase("src:aaaa1111", 1.0));
    const store = createMockStore(samePothole);

    const before = await scanForPromotions(store as never, "memory:pivot", { minDistinctSources: 1 });
    expect(before.candidates.filter(c => c.type === "case_to_pattern").length).toBe(1);
    expect(before.rejectedSingleSource).toBe(0);

    const after = await scanForPromotions(store as never, "memory:pivot", { minDistinctSources: 2 });
    expect(after.candidates.filter(c => c.type === "case_to_pattern").length).toBe(0);
    expect(after.rejectedSingleSource).toBe(1);
  });

  it("keeps promoting a cluster that really spans different tasks", async () => {
    // 审计原话：两个完全不同的任务（Alpine 装 lxml vs Docker 部署 Django）撞上同类子问题
    // （容器缺系统库），才诱导出一条可迁移的规律。
    const crossTask = [
      makeCase("src:aaaa1111", 1.0),
      makeCase("src:bbbb2222", 1.0),
      makeCase("src:cccc3333", 1.0),
    ];
    const store = createMockStore(crossTask);

    const result = await scanForPromotions(store as never, "memory:pivot", { minDistinctSources: 2 });
    const candidate = result.candidates.find(c => c.type === "case_to_pattern");
    expect(candidate).toBeDefined();
    expect(candidate!.distinctSources).toBe(3);
    expect(result.rejectedSingleSource).toBe(0);
  });

  it("abstains (and says so) when the scope has no source pointers at all", async () => {
    const store = createMockStore([1, 2, 3].map(() => makeCase(null, 1.0)));
    const result = await scanForPromotions(store as never, "project:legacy", { minDistinctSources: 2 });
    expect(result.candidates.filter(c => c.type === "case_to_pattern").length).toBe(1);
    expect(result.abstainedUnknownSource).toBe(1);
    expect(result.rejectedSingleSource).toBe(0);
  });
});
