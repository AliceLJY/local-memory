import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";

import { scoreRetrievalCase, type RetrievalEvalCase } from "../eval.js";

// 对齐 eval/cases.json 的真实形状：20 个 case 全部只声明 expectAny +
// expectScopePrefixes，没有一个声明 expectAll 或 forbid。
function makeCase(overrides: Partial<RetrievalEvalCase> = {}): RetrievalEvalCase {
  return {
    name: "case",
    query: "q",
    expectAny: ["alpha", "beta", "gamma", "delta"],
    expectScopePrefixes: ["project:"],
    ...overrides,
  };
}

function hits(texts: string[], scope = "project:test") {
  return texts.map((text) => ({ entry: { text, scope } }));
}

describe("scoreRetrievalCase", () => {
  it("case 没声明的期望不再白送权重", () => {
    // 这条守的就是那个漏洞：expectAll 在所有真实 case 里都没声明，
    // 白送它的 0.3 意味着 expectAny 命中 1 个再加 scope 前缀命中，
    // 就正好压在 0.7 及格线上——检索质量其实很差。
    const weak = scoreRetrievalCase(makeCase(), hits(["alpha only"]));

    expect(weak.matchedAny).toEqual(["alpha"]);
    expect(weak.matchedScopes).toEqual(["project:"]);
    // (0.4×1/4 + 0.2×1/1) / 0.6 × 0.9 + 0.1 = 0.55
    expect(weak.score).toBeCloseTo(0.55, 5);
    expect(weak.passed).toBe(false);
  });

  it("同样形状下 expectAny 要命中一半才刚好摸到及格线", () => {
    const report = scoreRetrievalCase(makeCase(), hits(["alpha beta"]));

    expect(report.matchedAny).toEqual(["alpha", "beta"]);
    // (0.4×2/4 + 0.2) / 0.6 × 0.9 + 0.1 = 0.7
    expect(report.score).toBeCloseTo(0.7, 5);
    expect(report.passed).toBe(true);
  });

  it("声明的期望全部命中给满分", () => {
    const report = scoreRetrievalCase(makeCase(), hits(["alpha beta gamma delta"]));

    expect(report.score).toBeCloseTo(1.0, 5);
    expect(report.passed).toBe(true);
  });

  it("多声明一个维度不会稀释满分——归一化是重分配不是膨胀", () => {
    const withAll = scoreRetrievalCase(
      makeCase({ expectAll: ["alpha", "beta"] }),
      hits(["alpha beta gamma delta"]),
    );

    expect(withAll.score).toBeCloseTo(1.0, 5);
    expect(withAll.passed).toBe(true);
  });

  it("声明了 expectAll 却全 miss 会把分数拉到及格线上", () => {
    const report = scoreRetrievalCase(
      makeCase({ expectAll: ["epsilon", "zeta"] }),
      hits(["alpha beta gamma delta"]),
    );

    expect(report.matchedAll).toEqual([]);
    // 声明总权重 0.9 里挣到 0.4 + 0 + 0.2，归一化后加非空奖励正好 0.7——
    // 这是"仍能通过"的最弱一档：其余全中、只丢掉整个 expectAll。
    expect(report.score).toBeCloseTo((0.6 / 0.9) * 0.9 + 0.1, 5);
    expect(report.passed).toBe(true);
  });

  it("再滑掉一个维度就掉到线下", () => {
    const report = scoreRetrievalCase(
      makeCase({ expectAll: ["epsilon", "zeta"] }),
      hits(["alpha beta gamma"]), // expectAny 4 中 3，expectAll 全 miss
    );

    expect(report.score).toBeLessThan(0.7);
    expect(report.passed).toBe(false);
  });

  it("只声明一个维度时该维度独占全部权重", () => {
    const single = makeCase({ expectScopePrefixes: undefined });

    const full = scoreRetrievalCase(single, hits(["alpha beta gamma delta"]));
    expect(full.score).toBeCloseTo(1.0, 5);

    const half = scoreRetrievalCase(single, hits(["alpha beta"]));
    // 4 个词命中 2 个 → 拿走整个信封的一半，再加非空奖励
    expect(half.score).toBeCloseTo(0.5 * 0.9 + 0.1, 5);
    expect(half.passed).toBe(false);
  });

  it("expectAll 按命中比例计分，不是全有或全无", () => {
    const report = scoreRetrievalCase(
      makeCase({ expectAny: ["alpha"], expectScopePrefixes: undefined, expectAll: ["beta", "epsilon"] }),
      hits(["alpha beta"]),
    );

    expect(report.matchedAll).toEqual(["beta"]);
    // (0.4×1 + 0.3×1/2) / 0.7 × 0.9 + 0.1
    expect(report.score).toBeCloseTo((0.55 / 0.7) * 0.9 + 0.1, 5);
  });

  it("scope 前缀也按命中比例计分", () => {
    const report = scoreRetrievalCase(
      makeCase({ expectAny: undefined, expectScopePrefixes: ["project:", "hippo:"] }),
      hits(["随便什么内容"]),
    );

    expect(report.matchedScopes).toEqual(["project:"]);
    // 2 个前缀命中 1 个 → 0.5 × 0.9 + 0.1
    expect(report.score).toBeCloseTo(0.55, 5);
    expect(report.passed).toBe(false);
  });

  it("命中 forbid 既扣分又直接判 fail", () => {
    const report = scoreRetrievalCase(
      makeCase({ forbid: ["secret"] }),
      hits(["alpha beta gamma delta secret"]),
    );

    expect(report.forbiddenMatches).toEqual(["secret"]);
    expect(report.score).toBeCloseTo(0.7, 5);
    // 分数够线，但命中禁词一律判不通过
    expect(report.passed).toBe(false);
  });

  it("空召回拿不到非空奖励，得 0 分", () => {
    const report = scoreRetrievalCase(makeCase(), []);

    expect(report.hitCount).toBe(0);
    expect(report.score).toBe(0);
    expect(report.passed).toBe(false);
  });

  it("一个期望都没声明的畸形 case 拿不到及格分", () => {
    const report = scoreRetrievalCase({ name: "empty", query: "q" }, hits(["anything at all"]));

    // 只剩非空奖励 0.1；改之前这里是三个维度全额白送 = 满分 1.0
    expect(report.score).toBeCloseTo(0.1, 5);
    expect(report.passed).toBe(false);
  });

  it("生产 case 集：完全不相关的召回不得有任何一个 case 过线", () => {
    // 守住评分器不再退回白送状态——不依赖 case 集当前的写法，
    // 以后无论 eval/cases.json 怎么增删，零匹配都必须是零通过。
    const cases = JSON.parse(
      readFileSync(new URL("../../eval/cases.json", import.meta.url), "utf-8"),
    ) as RetrievalEvalCase[];
    expect(cases.length).toBeGreaterThan(0);

    const irrelevant = [{ entry: { text: "完全无关的内容", scope: "unrelated/scope" } }];
    const leaked = cases
      .map((c) => scoreRetrievalCase(c, irrelevant))
      .filter((r) => r.passed)
      .map((r) => r.name);
    expect(leaked).toEqual([]);
  });
});
