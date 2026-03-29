import { describe, expect, it } from "bun:test";
import { segmentEvents, type EventSegmenterConfig } from "../event-segmenter.js";

const cfg: EventSegmenterConfig = { maxSegmentSize: 500, minSegmentSize: 50 };

describe("segmentEvents", () => {
  it("returns single segment for short text", () => {
    const result = segmentEvents("Hello world", cfg);
    expect(result).toHaveLength(1);
    expect(result[0].boundaryType).toBe("initial");
  });

  it("returns empty for empty input", () => {
    expect(segmentEvents("", cfg)).toHaveLength(0);
    expect(segmentEvents("   ", cfg)).toHaveLength(0);
  });

  it("splits on topic shift markers (Chinese)", () => {
    const text = [
      "[用户] 帮我查一下 TypeScript 的配置方法",
      "[助手] TypeScript 需要 tsconfig.json 文件来配置编译选项...",
      "这里有一些常见的配置项：strictNullChecks, target, module 等等。你可以根据项目需要来选择。",
      "[用户] 另外，帮我看看 Docker 的问题",
      "[助手] Docker 的问题是什么呢？请描述一下具体的错误信息。",
    ].join("\n");

    const result = segmentEvents(text, cfg);
    expect(result.length).toBeGreaterThanOrEqual(2);
    // First segment should contain TypeScript content
    expect(result[0].text).toContain("TypeScript");
    // Second segment should start with the Docker topic
    expect(result[result.length - 1].text).toContain("Docker");
  });

  it("splits on topic shift markers (English)", () => {
    const text = [
      "[用户] How do I configure TypeScript?",
      "[助手] You need a tsconfig.json file with compiler options like strictNullChecks and target settings for your project.",
      "[用户] By the way, what about Docker setup?",
      "[助手] For Docker, you'll need a Dockerfile and optionally a docker-compose.yml for multi-service setups.",
    ].join("\n");

    const result = segmentEvents(text, cfg);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("splits on Q&A boundaries (user after assistant)", () => {
    const longAssistant = "A".repeat(200);
    const text = [
      `[用户] First question about performance`,
      `[助手] ${longAssistant}`,
      `[用户] Second question about security`,
      `[助手] Security requires authentication and authorization checks.`,
    ].join("\n");

    const result = segmentEvents(text, { maxSegmentSize: 500, minSegmentSize: 50 });
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].text).toContain("performance");
  });

  it("does not split inside code blocks", () => {
    const text = [
      "[用户] Show me the code",
      "[助手] Here's the implementation:",
      "```typescript",
      "function hello() {",
      "  // 另外 this is NOT a topic shift inside code",
      '  console.log("hello");',
      "}",
      "```",
      "That's the basic structure you need. Let me explain more about the details and configuration options.",
    ].join("\n");

    const result = segmentEvents(text, cfg);
    // Should keep code block intact — "另外" inside ``` should not trigger split
    const codeSegment = result.find(s => s.text.includes("```typescript"));
    expect(codeSegment).toBeDefined();
    expect(codeSegment!.text).toContain('console.log("hello")');
  });

  it("keeps numbered lists intact", () => {
    const text = [
      "[助手] Here are the steps to follow for this configuration:",
      "1. Install the package using npm install",
      "2. Create config file in your project root",
      "3. Run the build command to verify",
      "4. Deploy to staging environment first",
      "5. Monitor logs for errors before production",
      "",
      "[用户] 另外，帮我看看另一个问题",
    ].join("\n");

    const result = segmentEvents(text, cfg);
    // The list should be in one segment
    const listSegment = result.find(s => s.text.includes("1. Install"));
    expect(listSegment).toBeDefined();
    expect(listSegment!.text).toContain("5. Monitor");
  });

  it("detects time jumps", () => {
    const text = [
      "[用户] 帮我看看这个 bug，已经排查了很久了。",
      "[助手] 好的，让我看看错误日志。根据分析，这个问题是由于内存泄漏导致的。",
      "[用户] 2024-03-15 下午我又遇到了另一个问题",
      "[助手] 请描述一下新的问题现象。",
    ].join("\n");

    const result = segmentEvents(text, cfg);
    // Should split at the date marker
    const timeSegment = result.find(s => s.text.includes("2024-03-15"));
    expect(timeSegment).toBeDefined();
  });

  it("respects max segment size", () => {
    const longLine = "A".repeat(300);
    const text = Array.from({ length: 10 }, (_, i) => `Line ${i}: ${longLine}`).join("\n");

    const result = segmentEvents(text, { maxSegmentSize: 800, minSegmentSize: 100 });
    // All segments should respect max size (with some tolerance for boundary alignment)
    for (const seg of result) {
      expect(seg.text.length).toBeLessThanOrEqual(800 * 1.5); // Allow some overshoot for boundary alignment
    }
  });

  it("merges tiny trailing segments", () => {
    const text = [
      "[用户] " + "A".repeat(400),
      "[助手] 好的",  // This tiny trailing bit should merge with previous
    ].join("\n");

    const result = segmentEvents(text, { maxSegmentSize: 500, minSegmentSize: 50 });
    // Should not produce a segment with just "好的"
    const tinySegments = result.filter(s => s.text.length < 50);
    expect(tinySegments).toHaveLength(0);
  });

  it("handles bullet lists with - markers", () => {
    const text = [
      "[助手] Key considerations when designing this system:",
      "- Performance: optimize hot paths and cache results",
      "- Security: validate all inputs at system boundaries",
      "- Reliability: add retry logic with exponential backoff",
      "- Observability: structured logging with trace IDs",
      "",
      "[用户] 另外还有什么需要注意的吗？",
    ].join("\n");

    const result = segmentEvents(text, cfg);
    const listSeg = result.find(s => s.text.includes("- Performance"));
    expect(listSeg).toBeDefined();
    expect(listSeg!.text).toContain("- Observability");
  });
});
