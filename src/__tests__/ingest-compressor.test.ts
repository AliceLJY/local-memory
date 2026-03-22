import { describe, it, expect } from "bun:test";
import {
  processJsonlLine,
  compressTranscript,
  summarizeToolResult,
  DEFAULT_COMPRESSOR_CONFIG,
  type CompressorConfig,
} from "../ingest-compressor.js";

// ============================================================================
// Helper: build JSONL lines
// ============================================================================

function userLine(content: any, type = "user") {
  return JSON.stringify({ type, message: { content }, timestamp: "2026-03-22T10:00:00Z" });
}

function assistantLine(content: any) {
  return JSON.stringify({ type: "assistant", message: { content }, timestamp: "2026-03-22T10:00:00Z" });
}

function progressLine(data = "building...") {
  return JSON.stringify({ type: "bash_progress", data });
}

function toolResultBlock(text: string, toolUseId = "tu_123") {
  return { type: "tool_result", tool_use_id: toolUseId, content: text };
}

function textBlock(text: string) {
  return { type: "text", text };
}

// ============================================================================
// Rule 1: Skip streaming entries
// ============================================================================

describe("skip streaming entries", () => {
  it("skips bash_progress lines", () => {
    expect(processJsonlLine(progressLine())).toBeNull();
  });

  it("skips bash_status lines", () => {
    const line = JSON.stringify({ type: "bash_status", status: "running" });
    expect(processJsonlLine(line)).toBeNull();
  });

  it("skips tool_streaming lines", () => {
    const line = JSON.stringify({ type: "tool_streaming", data: "partial" });
    expect(processJsonlLine(line)).toBeNull();
  });

  it("keeps user messages", () => {
    const line = userLine("hello world, this is my question");
    expect(processJsonlLine(line)).toBe(line);
  });

  it("keeps assistant messages", () => {
    const line = assistantLine([textBlock("here is my response")]);
    expect(processJsonlLine(line)).toBe(line);
  });

  it("respects disabled config", () => {
    const config: CompressorConfig = { ...DEFAULT_COMPRESSOR_CONFIG, skipStreamingEntries: false };
    const line = progressLine();
    expect(processJsonlLine(line, config)).toBe(line);
  });
});

// ============================================================================
// Rule 2: Base64 replacement
// ============================================================================

describe("base64 replacement", () => {
  it("replaces base64 screenshot in tool_result", () => {
    const base64 = "A".repeat(500) + "==";
    const line = userLine([toolResultBlock(base64)]);
    const result = processJsonlLine(line);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.message.content[0].content).toContain("replaced by compressor");
    expect(parsed.message.content[0].content).not.toContain("AAAA");
  });

  it("replaces data:image/ prefixed content", () => {
    const base64 = "data:image/png;base64," + "A".repeat(500);
    const line = userLine([toolResultBlock(base64)]);
    const result = processJsonlLine(line);
    const parsed = JSON.parse(result!);
    expect(parsed.message.content[0].content).toContain("replaced by compressor");
  });

  it("does not replace short base64-like strings", () => {
    const short = "abc123==";
    const line = userLine([toolResultBlock(short)]);
    expect(processJsonlLine(line)).toBe(line);
  });
});

// ============================================================================
// Rule 3: Tool result summarization
// ============================================================================

describe("summarizeToolResult", () => {
  it("summarizes git push success", () => {
    const output = "Enumerating objects: 5, done.\nCounting objects: 100%\nTotal 3\nremote: -> main\n";
    const result = summarizeToolResult("git push", output);
    expect(result).toContain("ok");
  });

  it("preserves git push failure", () => {
    const output = "error: failed to push some refs to 'origin'\nhint: Updates were rejected";
    const result = summarizeToolResult("git push", output, 1);
    expect(result).toContain("error");
    expect(result).toContain("rejected");
  });

  it("summarizes passing tests", () => {
    const output = "running 15 tests\ntest a ... ok\ntest b ... ok\ntest result: ok. 15 passed; 0 failed\n";
    const result = summarizeToolResult("cargo test", output);
    expect(result).toContain("test");
    expect(result!.length).toBeLessThan(output.length);
  });

  it("preserves failing test details", () => {
    const output = "test a ... FAILED\nassert_eq failed\nat src/main.rs:42\ntest result: 1 failed\n";
    const result = summarizeToolResult("cargo test", output, 1);
    expect(result).toContain("FAILED");
    expect(result).toContain("assert");
  });

  it("summarizes grep results", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts:10:match${i}`);
    const result = summarizeToolResult("grep pattern .", lines.join("\n"));
    expect(result).toContain("20 matches");
    expect(result).toContain("+15 more");
  });

  it("summarizes directory listing", () => {
    const output = "file1.ts\nfile2.ts\nfile3.ts\ndir/\n";
    const result = summarizeToolResult("ls -la .", output);
    expect(result).toContain("4 items");
  });

  it("returns null for unknown commands", () => {
    expect(summarizeToolResult("htop", "cpu output")).toBeNull();
  });

  it("handles rtk-prefixed commands", () => {
    const result = summarizeToolResult("rtk git push", "Total 3\nremote: -> main\n");
    expect(result).toContain("ok");
  });
});

// ============================================================================
// Rule 4: Large output truncation
// ============================================================================

describe("large output truncation", () => {
  it("truncates tool_result over threshold", () => {
    // Use non-base64 content to test truncation (not base64 replacement)
    const largeOutput = "line: some code output here\n".repeat(300);
    const line = userLine([toolResultBlock(largeOutput)]);
    const result = processJsonlLine(line);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    const content = parsed.message.content[0].content;
    expect(content.length).toBeLessThan(largeOutput.length);
    expect(content).toContain("truncated");
  });

  it("does not truncate small outputs", () => {
    const smallOutput = "ok done";
    const line = userLine([toolResultBlock(smallOutput)]);
    expect(processJsonlLine(line)).toBe(line);
  });
});

// ============================================================================
// Safety: never modify user/AI content
// ============================================================================

describe("safety boundaries", () => {
  it("never modifies user text content", () => {
    const line = userLine([textBlock("my important question about git push results")]);
    expect(processJsonlLine(line)).toBe(line);
  });

  it("never modifies assistant text content", () => {
    const longText = "detailed analysis ".repeat(500);
    const line = assistantLine([textBlock(longText)]);
    expect(processJsonlLine(line)).toBe(line);
  });

  it("preserves user text blocks alongside tool_results", () => {
    const content = [
      textBlock("here is my question"),
      toolResultBlock("A".repeat(500) + "=="), // base64 → compressed
    ];
    const line = userLine(content);
    const result = processJsonlLine(line);
    const parsed = JSON.parse(result!);
    // Text block preserved
    expect(parsed.message.content[0].text).toBe("here is my question");
    // tool_result compressed
    expect(parsed.message.content[1].content).toContain("replaced by compressor");
  });

  it("handles malformed JSON gracefully", () => {
    expect(processJsonlLine("not valid json {{{")).toBe("not valid json {{{");
  });

  it("handles empty lines", () => {
    expect(processJsonlLine("")).toBeNull();
    expect(processJsonlLine("   ")).toBeNull();
  });
});

// ============================================================================
// Full transcript compression
// ============================================================================

describe("compressTranscript", () => {
  it("processes multi-line JSONL", () => {
    const lines = [
      progressLine("step 1"),
      progressLine("step 2"),
      userLine([textBlock("what happened?")]),
      assistantLine([textBlock("here is the answer")]),
      progressLine("step 3"),
    ].join("\n");

    const { content, stats } = compressTranscript(lines);
    expect(stats.skippedStreaming).toBe(3);
    expect(stats.totalLines).toBe(5);
    expect(content).toContain("what happened?");
    expect(content).toContain("here is the answer");
    expect(content).not.toContain("bash_progress");
  });

  it("reports compression stats", () => {
    const lines = [
      progressLine("a".repeat(1000)),
      progressLine("b".repeat(1000)),
      userLine([textBlock("short question")]),
    ].join("\n");

    const { stats } = compressTranscript(lines);
    expect(stats.bytesOut).toBeLessThan(stats.bytesIn);
    expect(stats.skippedStreaming).toBe(2);
  });

  it("passes through when disabled", () => {
    const lines = progressLine() + "\n" + userLine([textBlock("hi")]);
    const config: CompressorConfig = { ...DEFAULT_COMPRESSOR_CONFIG, enabled: false };
    const { content, stats } = compressTranscript(lines, config);
    expect(content).toBe(lines);
    expect(stats.bytesOut).toBe(stats.bytesIn);
  });

  it("handles git push boilerplate via content inference", () => {
    const gitOutput = "Enumerating objects: 5, done.\nCounting objects: 100% (5/5), done.\nDelta compression using up to 8 threads\nCompressing objects: 100% (3/3), done.\nWriting objects: 100% (3/3), 450 bytes | 450.00 KiB/s, done.\nTotal 3 (delta 2), reused 0 (delta 0)\nremote: Resolving deltas: 100% (2/2), completed with 2 local objects.\nTo github.com:user/repo.git\n   abc1234..def5678  main -> main\n";
    const line = userLine([toolResultBlock(gitOutput)]);
    const { content } = compressTranscript(line);
    // Should be compressed since it matches git push boilerplate pattern
    expect(content.length).toBeLessThan(line.length);
  });
});
