import { describe, expect, it } from "bun:test";

import {
  boundedLevenshtein,
  createScopeSuggester,
  formatScopeSuggestion,
  normalizeScope,
  suggestScopes,
} from "../scope-suggester.js";

describe("normalizeScope", () => {
  it("lowercases and strips separators", () => {
    expect(normalizeScope("CC-Foo")).toBe("ccfoo");
    expect(normalizeScope("cc_foo bar")).toBe("ccfoobar");
  });
});

describe("boundedLevenshtein", () => {
  it("computes small distances and early-exits beyond max", () => {
    expect(boundedLevenshtein("recallnest", "recallnest", 2)).toBe(0);
    expect(boundedLevenshtein("recallnst", "recallnest", 2)).toBe(1);
    expect(boundedLevenshtein("recalnst", "recallnest", 2)).toBe(2);
    expect(boundedLevenshtein("abc", "xyzuvw", 2)).toBe(3); // max+1
  });
});

describe("suggestScopes", () => {
  const known = ["recallnest", "recallnest:self", "cc", "cc:55bcbfb3", "project:test"];

  it("matches typos within edit distance 2", () => {
    expect(suggestScopes("recallnst", known)).toContain("recallnest");
  });

  it("matches case differences via normalization", () => {
    expect(suggestScopes("RecallNest", known)[0]).toBe("recallnest");
  });

  it("matches separator convention drift", () => {
    expect(suggestScopes("recall-nest", known)[0]).toBe("recallnest");
    expect(suggestScopes("recall_nest", known)[0]).toBe("recallnest");
  });

  it("matches by prefix in both directions", () => {
    expect(suggestScopes("recall", known)).toContain("recallnest");
  });

  it("returns empty for unrelated input", () => {
    expect(suggestScopes("totally-unrelated-thing", known)).toEqual([]);
    expect(suggestScopes("", known)).toEqual([]);
  });

  it("caps suggestions at maxSuggestions", () => {
    const many = ["aa1", "aa2", "aa3", "aa4", "aa5"];
    expect(suggestScopes("aa", many, 3)).toHaveLength(3);
  });
});

describe("createScopeSuggester", () => {
  it("derives prefix families and caches scope counts", async () => {
    let calls = 0;
    const suggest = createScopeSuggester(async () => {
      calls++;
      return { "cc:55bcbfb3": 100, "cc:65314581": 50, "codex:019cc122": 30 };
    });

    // 拼错的 prefix 应命中 prefix 家族(cc),不需要整串 session scope 相似
    const r1 = await suggest("ccc");
    expect(r1).toContain("cc");

    await suggest("codx");
    expect(calls).toBe(1); // 60s TTL 内复用缓存
  });
});

describe("formatScopeSuggestion", () => {
  it("renders hint or empty string", () => {
    expect(formatScopeSuggestion("recallnst", ["recallnest"])).toContain("recallnest");
    expect(formatScopeSuggestion("x", [])).toBe("");
  });
});
