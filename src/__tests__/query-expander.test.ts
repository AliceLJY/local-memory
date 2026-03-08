import { describe, it, expect } from "bun:test";
import { expandQuery } from "../query-expander.js";

describe("expandQuery", () => {
  it("expands colloquial Chinese to technical terms", () => {
    const result = expandQuery("bot 突然挂了");
    expect(result).toContain("崩溃");
    expect(result).toContain("crash");
    expect(result).toContain("挂了");
  });

  it("expands fuzzy feeling queries", () => {
    const result = expandQuery("AI 到底有没有感受");
    expect(result).toContain("意识");
    expect(result).toContain("consciousness");
    expect(result).toContain("感受");
  });

  it("preserves original query terms", () => {
    const result = expandQuery("配图风格");
    expect(result).toContain("配图");
    expect(result).toContain("风格");
  });

  it("returns original for already-precise queries", () => {
    const result = expandQuery("JINA_API_KEY");
    expect(result).toBe("JINA_API_KEY");
  });

  it("handles empty/short queries", () => {
    expect(expandQuery("")).toBe("");
    expect(expandQuery("hi")).toBe("hi");
  });
});
