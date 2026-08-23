import { describe, it, expect } from "bun:test";
import { createRetriever } from "../retriever.js";
import { UTILITY_FIELD } from "../memory-utility.js";

function run(utilityWeight: number, utilities: Array<number | null>): number[] {
  const retriever = createRetriever({} as any, {} as any, { utilityWeight });
  const results = utilities.map((u, i) => ({
    entry: {
      id: `u-${i}`,
      text: "utility test",
      vector: [],
      category: "cases",
      scope: "test:utility",
      importance: 0.7,
      timestamp: Date.now(),
      metadata: JSON.stringify(u === null ? { tier: "peripheral" } : { [UTILITY_FIELD]: u }),
    },
    score: 0.5,
    sources: {},
  }));
  const out = (retriever as any).applyUtilityWeight(results) as Array<{ entry: { id: string }; score: number }>;
  // 按原顺序取回分数（该 stage 会重排）
  return utilities.map((_, i) => out.find(r => r.entry.id === `u-${i}`)!.score);
}

describe("applyUtilityWeight", () => {
  it("is a no-op at the default weight of 0", () => {
    expect(run(0, [0.8, -0.8, null])).toEqual([0.5, 0.5, 0.5]);
  });

  it("lifts positive utility and sinks negative utility", () => {
    const [positive, negative, absent] = run(0.2, [0.8, -0.8, null]);
    expect(positive).toBeGreaterThan(0.5);
    expect(negative).toBeLessThan(0.5);
    // 没有 utility 的条目原样放行 —— 「没数据」不该被当成差评（bonus-only 冷启动）。
    expect(absent).toBe(0.5);
  });

  it("keeps scores inside [0,1] even at weight 1 with the most negative utility", () => {
    const [score] = run(1, [-0.8]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("ignores broken metadata instead of throwing", () => {
    const retriever = createRetriever({} as any, {} as any, { utilityWeight: 0.3 });
    const results = [{
      entry: {
        id: "broken", text: "x", vector: [], category: "cases", scope: "s",
        importance: 0.5, timestamp: Date.now(), metadata: "{not json",
      },
      score: 0.42,
      sources: {},
    }];
    expect((retriever as any).applyUtilityWeight(results)[0].score).toBe(0.42);
  });
});
