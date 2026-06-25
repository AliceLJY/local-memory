import { describe, expect, it } from "bun:test";

import { scoreCanaryCase, type CanaryEvalCase } from "../eval.js";

function res(id: string, text = "", scope = "cc", metadata = "") {
  return { entry: { id, text, scope, metadata } };
}

describe("scoreCanaryCase", () => {
  it("A 类 top1 命中给满目标分并 pass", () => {
    const c: CanaryEvalCase = { name: "a", query: "q", targets: ["m1"], expectTopK: 3 };
    const r = scoreCanaryCase(c, [res("m1", "hit"), res("m2")]);
    expect(r.top1Hit).toBe(true);
    expect(r.top3Hit).toBe(true);
    expect(r.targetRanks).toEqual([{ id: "m1", rank: 1 }]);
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.passed).toBe(true);
  });

  it("A 类命中但排第 3 给 top3 分", () => {
    const c: CanaryEvalCase = { name: "a", query: "q", targets: ["m3"], expectTopK: 3 };
    const r = scoreCanaryCase(c, [res("a"), res("b"), res("m3")]);
    expect(r.top1Hit).toBe(false);
    expect(r.top3Hit).toBe(true);
    expect(r.targetRanks).toEqual([{ id: "m3", rank: 3 }]);
    expect(r.score).toBeCloseTo(0.7, 5);
    expect(r.passed).toBe(true);
  });

  it("A 类 miss 给 0 并 fail", () => {
    const c: CanaryEvalCase = { name: "a", query: "q", targets: ["zzz"] };
    const r = scoreCanaryCase(c, [res("a"), res("b")]);
    expect(r.targetRanks).toEqual([{ id: "zzz", rank: null }]);
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("B 类新旧序正确 orderOk=true 并 pass", () => {
    const c: CanaryEvalCase = { name: "b", query: "q", expectOrder: ["new", "old"] };
    const r = scoreCanaryCase(c, [res("new"), res("old")]);
    expect(r.orderOk).toBe(true);
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.passed).toBe(true);
  });

  it("B 类新旧序颠倒 orderOk=false 并 fail", () => {
    const c: CanaryEvalCase = { name: "b", query: "q", expectOrder: ["new", "old"] };
    const r = scoreCanaryCase(c, [res("old"), res("new")]);
    expect(r.orderOk).toBe(false);
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("B 类 newer 未召回 orderOk=false", () => {
    const c: CanaryEvalCase = { name: "b", query: "q", expectOrder: ["new", "old"] };
    const r = scoreCanaryCase(c, [res("old"), res("other")]);
    expect(r.orderOk).toBe(false);
  });

  it("C 类干扰项进 TopK 直接判 fail（即便目标命中）", () => {
    const c: CanaryEvalCase = { name: "c", query: "q", targets: ["m1"], hardNegatives: ["bad"], limit: 8 };
    const r = scoreCanaryCase(c, [res("m1"), res("bad")]);
    expect(r.top1Hit).toBe(true);
    expect(r.forbiddenIdMatches).toEqual(["bad"]);
    expect(r.passed).toBe(false);
  });

  it("C 类干扰项在 limit 之外不算违规", () => {
    const c: CanaryEvalCase = { name: "c", query: "q", targets: ["m1"], hardNegatives: ["bad"], limit: 1 };
    const r = scoreCanaryCase(c, [res("m1"), res("bad")]);
    expect(r.forbiddenIdMatches).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it("D 类内容全命中给满分", () => {
    const c: CanaryEvalCase = { name: "d", query: "q", expectContentAny: ["口语化", "剧评腔"] };
    const r = scoreCanaryCase(c, [res("x", "她要口语化，带点剧评腔", "cc")]);
    expect(r.matchedContentAny).toEqual(["口语化", "剧评腔"]);
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.passed).toBe(true);
  });

  it("D 类内容部分命中按比例", () => {
    const c: CanaryEvalCase = { name: "d", query: "q", expectContentAny: ["口语化", "剧评腔"] };
    const r = scoreCanaryCase(c, [res("x", "只提了口语化", "cc")]);
    expect(r.matchedContentAny).toEqual(["口语化"]);
    expect(r.score).toBeCloseTo(0.5, 5);
    expect(r.passed).toBe(false);
  });

  it("文本 forbid 命中判 fail", () => {
    const c: CanaryEvalCase = { name: "f", query: "q", targets: ["m1"], forbid: ["机密"] };
    const r = scoreCanaryCase(c, [res("m1", "这是机密内容")]);
    expect(r.forbiddenMatches).toEqual(["机密"]);
    expect(r.passed).toBe(false);
  });

  it("空召回 score 0", () => {
    const c: CanaryEvalCase = { name: "e", query: "q", targets: ["m1"] };
    const r = scoreCanaryCase(c, []);
    expect(r.hitCount).toBe(0);
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  it("A+B 复合：目标命中且新旧序正确，综合 pass", () => {
    const c: CanaryEvalCase = { name: "ab", query: "q", targets: ["new"], expectOrder: ["new", "old"], expectTopK: 3 };
    const r = scoreCanaryCase(c, [res("new"), res("old")]);
    expect(r.top1Hit).toBe(true);
    expect(r.orderOk).toBe(true);
    expect(r.score).toBeCloseTo(1, 5);
    expect(r.passed).toBe(true);
  });
});
