/**
 * P4 反模式出口：被跨来源判据拒掉的簇不再只剩一个计数。
 *
 * 背景：`judgeDistinctSources` 判 `rejected` 时（条数够、但全来自同一次经历），
 * `scanForPromotions` 只做 `rejectedSingleSource++` 然后 `continue` —— 于是
 * 「同一个坑踩了三次」这个信号变成一个数字后消失。原代码注释自己写着
 * "走 failure-burst 反模式那条路"，但那条路一直不存在。
 *
 * schema 借自 MemTensor/memmy-agent 的 `negative-experience-pipeline.ts`
 * （其 `NegativeExperienceSource` 枚举里字面就有 `tool_failure_burst`）。
 * **只借它列的证据字段，不借需要判断的字段** —— 见下面 "does not fabricate" 一测。
 */
import { describe, expect, it } from "bun:test";

import { formatPromotionResult, scanForPromotions } from "../skill-promotion.js";
import type { MemoryEntry, MemorySearchResult } from "../store.js";

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

describe("anti-pattern outlet (P4)", () => {
  it("emits an anti-pattern candidate for a cluster rejected as one repeated experience", async () => {
    const entries = [1, 2, 3].map(() => makeCase("src:aaaa1111"));
    const result = await scanForPromotions(createMockStore(entries), "memory:pivot");

    expect(result.rejectedSingleSource).toBe(1);
    expect(result.antiPatterns).toHaveLength(1);

    const ap = result.antiPatterns[0];
    expect(ap.source).toBe("single_source_burst");
    expect(ap.occurrences).toBe(3);
    expect(ap.distinctSources).toBe(1);
    expect(ap.sourceEntries).toHaveLength(3);
    expect(ap.trigger).toContain("Docker");
    expect(ap.evidenceStrength).toBeGreaterThan(0);
    expect(ap.evidenceStrength).toBeLessThanOrEqual(1);
  });

  it("still refuses to promote it — the existing gate is unchanged", async () => {
    const entries = [1, 2, 3].map(() => makeCase("src:aaaa1111"));
    const result = await scanForPromotions(createMockStore(entries), "memory:pivot");
    expect(result.candidates).toHaveLength(0);
  });

  it("does not fabricate the two fields that need judgement", async () => {
    // memmy 的 schema 有 preference / verification，但那两格要的是判断不是统计。
    // 扫描器只出证据；编出来的「该怎么做」比没有更糟（Anti-Fabrication）。
    const entries = [1, 2, 3].map(() => makeCase("src:aaaa1111"));
    const result = await scanForPromotions(createMockStore(entries), "memory:pivot");
    const ap = result.antiPatterns[0];
    expect(ap).not.toHaveProperty("preference");
    expect(ap).not.toHaveProperty("verification");
    expect(ap.needsJudgement).toEqual(["preference", "verification"]);
  });

  it("stays silent when the cluster merely abstained (no source pointer)", async () => {
    // abstained ≠ 反模式：不知道来源，不能指控它是「同一个坑踩三次」。
    const entries = [1, 2, 3].map(() => makeCase(null));
    const result = await scanForPromotions(createMockStore(entries), "memory:pivot");
    expect(result.abstainedUnknownSource).toBe(1);
    expect(result.antiPatterns).toHaveLength(0);
  });

  it("emits nothing when there is a genuine cross-source pattern", async () => {
    const entries = [makeCase("src:aaaa1111"), makeCase("src:bbbb2222"), makeCase("src:cccc3333")];
    const result = await scanForPromotions(createMockStore(entries), "memory:pivot");
    expect(result.antiPatterns).toHaveLength(0);
    expect(result.candidates.length).toBeGreaterThan(0);
  });
});

describe("anti-pattern is visible to the consumer", () => {
  it("shows up in the formatted output, not just the result object", async () => {
    // 消费者(MCP 工具的调用方)看到的是这段文本。只进 result 对象等于还是没人看见。
    const entries = [1, 2, 3].map(() => makeCase("src:aaaa1111"));
    const text = formatPromotionResult(await scanForPromotions(createMockStore(entries), "memory:pivot"));
    expect(text).toContain("anti-pattern(s)");
    expect(text).toContain("Docker");
    expect(text).toContain("重复 3 次");
    expect(text).toContain("待补判断");
  });

  it("says nothing about anti-patterns when there are none", async () => {
    const entries = [makeCase("src:aaaa1111"), makeCase("src:bbbb2222"), makeCase("src:cccc3333")];
    const text = formatPromotionResult(await scanForPromotions(createMockStore(entries), "memory:pivot"));
    expect(text).not.toContain("anti-pattern(s)");
  });
});
