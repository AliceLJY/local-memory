import { describe, it, expect } from "bun:test";
import { generateAnchor } from "../anchor-generator.js";

describe("generateAnchor", () => {
  it("returns undefined for short text (≤80 chars)", () => {
    expect(generateAnchor("轮巡仓库每日检查")).toBeUndefined();
    expect(generateAnchor("Short text that fits in 80 chars easily")).toBeUndefined();
  });

  it("extracts first sentence from long text", () => {
    const text = "每天轮巡4个win4r仓库，检查Issue和PR。" +
      "包括 ClawTeam-OpenClaw、openclaw-a2a-gateway、memory-lancedb-pro、UltraMemory。" +
      "Issue 用中文回复，PR 用英文 review。不要重复回复已处理的。";
    const anchor = generateAnchor(text);
    expect(anchor).toBeDefined();
    expect(anchor!.length).toBeLessThanOrEqual(80);
    expect(anchor).toBe("每天轮巡4个win4r仓库，检查Issue和PR");
  });

  it("uses workflow pattern title from metadata", () => {
    const text = "A very long workflow pattern description that spans multiple lines and paragraphs explaining the full procedure";
    const metadata = {
      workflowPattern: {
        title: "Daily repo patrol",
        trigger: "Every morning",
      },
    };
    const anchor = generateAnchor(text, metadata);
    expect(anchor).toBe("Daily repo patrol");
  });

  it("uses case memory title from metadata", () => {
    const text = "A very long case description that spans multiple lines and paragraphs explaining the full case and its resolution";
    const metadata = {
      caseMemory: {
        title: "Fix dedup over-kill in ingest",
        problem: "72% of chunks were being dropped",
      },
    };
    const anchor = generateAnchor(text, metadata);
    expect(anchor).toBe("Fix dedup over-kill in ingest");
  });

  it("truncates long first sentences at CJK char boundary", () => {
    const text = "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的第一句话，" +
      "超过了八十个字符的限制需要被截断到合适的长度。" +
      "第二句话在这里提供更多上下文信息用于测试截断功能是否正常工作。";
    const anchor = generateAnchor(text);
    expect(anchor).toBeDefined();
    expect(anchor!.length).toBeLessThanOrEqual(80);
  });

  it("truncates long English sentences at word boundary", () => {
    const text = "This is a very long first sentence that definitely exceeds the eighty character limit by quite a significant margin. Second sentence here.";
    const anchor = generateAnchor(text);
    expect(anchor).toBeDefined();
    expect(anchor!.length).toBeLessThanOrEqual(80);
    // Should not end mid-word
    expect(anchor!).not.toMatch(/\s$/);
  });

  it("handles text with only newline separators", () => {
    const text = "First line of important information that is a reasonable sentence\nSecond line with more details and context that expands on the first point";
    const anchor = generateAnchor(text);
    expect(anchor).toBe("First line of important information that is a reasonable sentence");
  });
});
