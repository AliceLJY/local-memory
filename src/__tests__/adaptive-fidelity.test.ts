import { describe, expect, it } from "bun:test";

import { formatCollapsedResults } from "../memory-output.js";
import type { RetrievalResult } from "../retriever.js";

// P-fidelity (点4): adaptive 档 search-native 实现（CC+Codex 共识 C：不复用 resume 的
// collapseResults）。借鉴 RepoPrompt CE「保真度阶梯」内核——按相关性分配保真度 + token 预算，
// 但渲染 query-aware（search 结果是"为什么命中"，必须显示匹配证据）。

function makeResult(id: string, text: string, score: number, metadata = "{}"): RetrievalResult {
  return {
    entry: {
      id,
      text,
      vector: [],
      category: "events",
      scope: "test",
      importance: 0.5,
      timestamp: Date.parse("2026-06-29T00:00:00.000Z"),
      metadata,
    },
    score,
    sources: {},
  };
}

const ctx = { query: "QUERYMATCH", profile: "default" as never };

describe("formatCollapsedResults (adaptive, search-native)", () => {
  it("returns 'No results found' for empty input", () => {
    expect(formatCollapsedResults([], ctx)).toBe("No results found.");
  });

  it("renders high-relevance (score ≥ 0.85) as FULL text", () => {
    const out = formatCollapsedResults([makeResult("aaaaaaaa", "full detailed QUERYMATCH content here", 0.95)], ctx);
    expect(out).toContain("[FULL] aaaaaaaa");
    expect(out).toContain("full detailed QUERYMATCH content here");
  });

  it("renders lower-relevance as SNIP and keeps the matching evidence even when it's late in the text (P2-3)", () => {
    const text = "Intro sentence. " + "filler ".repeat(20) + "the QUERYMATCH evidence is right here.";
    const out = formatCollapsedResults([makeResult("bbbbbbbb", text, 0.60)], ctx);
    expect(out).toContain("[SNIP] bbbbbbbb");
    // 关键：query-aware snippet 必须保留匹配证据，而不是只截开头（这正是复用 collapse 时的 P2-3）
    expect(out).toContain("QUERYMATCH");
  });

  it("does NOT drop low-score hits — adaptive is display, not a filter (P2-1)", () => {
    const out = formatCollapsedResults([makeResult("cccccccc", "valid low-score QUERYMATCH hit", 0.30)], ctx);
    expect(out).toContain("[SNIP] cccccccc");
    expect(out).not.toContain("No results");
  });

  it("preserves caller order (e.g. highlight reorder), not raw score order (P2-2)", () => {
    // 模拟 render:highlight — contextual 最相关但 raw score 较低的排在前。
    const out = formatCollapsedResults([
      makeResult("term0000", "term-relevant QUERYMATCH but lower score", 0.55),
      makeResult("high0000", "higher score but less contextual", 0.95),
    ], ctx);
    const idxTerm = out.indexOf("term0000");
    const idxHigh = out.indexOf("high0000");
    expect(idxTerm).toBeGreaterThan(-1);
    expect(idxHigh).toBeGreaterThan(-1);
    expect(idxTerm).toBeLessThan(idxHigh); // term0000 仍在前
  });

  it("includes locator info (id / score / category)", () => {
    const out = formatCollapsedResults([makeResult("dddddddd", "QUERYMATCH content", 0.90)], ctx);
    expect(out).toContain("dddddddd");
    expect(out).toContain("90%");
    expect(out).toContain("events"); // category label
  });

  it("keeps the match visible for a short acronym query (adaptiveSnippet window, P2)", () => {
    // pickBestSnippet 对短缩写 query 会退回开头；adaptiveSnippet 用 raw query 定位 + 窗口。
    const text = "Some long intro line without the keyword. ".repeat(5) + "Finally the CI pipeline broke here.";
    const out = formatCollapsedResults([makeResult("ffffffff", text, 0.50)], { query: "CI", profile: "default" as never });
    expect(out).toContain("[SNIP] ffffffff");
    expect(out.toLowerCase()).toContain("ci pipeline"); // 匹配证据可见，而非只截开头
  });

  it("windows around a match that is late in a long single line (P2)", () => {
    // 超长无句读的 log 行：整句截断会丢后段匹配；adaptiveSnippet 取匹配词周围窗口。
    const text = "prefix ".repeat(50) + "ZEBRAWORD is the late match here" + " suffix".repeat(50);
    const out = formatCollapsedResults([makeResult("11111111", text, 0.50)], { query: "ZEBRAWORD", profile: "default" as never });
    expect(out).toContain("ZEBRAWORD"); // 后段匹配仍在窗口内
  });

  it("does not false-match an acronym inside an unrelated earlier word (word boundary, P2)", () => {
    // "specific" 含子串 "ci"；裸 substring 会 window 到它、漏掉真的 CI。word boundary 跳过。
    const text = "This is a specific introduction. " + "filler ".repeat(10) + "Then the CI build failed.";
    const out = formatCollapsedResults([makeResult("22222222", text, 0.50)], { query: "CI", profile: "default" as never });
    expect(out).toContain("CI build"); // window 到真 CI，不是 specific 里的 ci
  });

  it("matches CJK fallback queries via substring (ASCII word boundary doesn't apply, P2-1)", () => {
    // 中文单字 query：JS \b 只认 ASCII，必须走 substring，否则退回开头丢匹配（Alice 的记忆大量中文）。
    const text = "开头一些无关的内容。" + "填充内容 ".repeat(10) + "这里才提到猫的关键证据。";
    const out = formatCollapsedResults([makeResult("33333333", text, 0.50)], { query: "猫", profile: "default" as never });
    expect(out).toContain("猫"); // 中文匹配证据可见
  });
});
