import { describe, it, expect } from "bun:test";
import { compressToolOutput } from "../tool-output-compressor.js";

describe("compressToolOutput", () => {
  // ========================================================================
  // Base64 replacement
  // ========================================================================

  it("replaces large base64 blocks with size placeholder", () => {
    const base64 = "A".repeat(2000);
    const text = `Here is a screenshot:\n${base64}\nEnd of screenshot.`;
    const result = compressToolOutput(text);
    expect(result).toContain("[image:");
    expect(result).toContain("base64");
    expect(result).not.toContain("AAAA");
  });

  it("preserves short base64-like strings", () => {
    const text = "The hash is abc123==";
    expect(compressToolOutput(text)).toBe(text);
  });

  // ========================================================================
  // Git output compression
  // ========================================================================

  it("compresses git push boilerplate", () => {
    const text = `$ git push origin main
Enumerating objects: 5, done.
Counting objects: 100% (5/5), done.
Delta compression using up to 8 threads
Compressing objects: 100% (3/3), done.
Writing objects: 100% (3/3), 450 bytes | 450.00 KiB/s, done.
Total 3 (delta 2), reused 0 (delta 0)
remote: Resolving deltas: 100% (2/2), completed with 2 local objects.
To github.com:user/repo.git
   abc1234..def5678  main -> main

Next I'll check the status.`;

    const result = compressToolOutput(text);
    expect(result).toContain("[git: ok");
    expect(result).toContain("main");
    expect(result).not.toContain("Enumerating objects");
    expect(result).toContain("Next I'll check the status");
  });

  it("preserves git push failures", () => {
    const text = `$ git push
Enumerating objects: 5, done.
error: failed to push some refs to 'origin'
hint: Updates were rejected because the tip of your branch is behind -> main`;

    const result = compressToolOutput(text);
    expect(result).toContain("error");
    expect(result).toContain("rejected");
  });

  // ========================================================================
  // Test output compression
  // ========================================================================

  it("compresses passing test summary", () => {
    const text = `$ bun test
running 15 tests
test a ... ok
test b ... ok
test c ... ok
test result: ok. 15 passed; 0 failed; 0 ignored

All tests passed.`;

    const result = compressToolOutput(text);
    expect(result.length).toBeLessThanOrEqual(text.length);
    expect(result).toContain("All tests passed");
  });

  it("preserves failing test output", () => {
    const text = `$ npm test
Tests: 2 failed, 8 passed
FAIL src/main.test.ts
  ✕ should handle edge case`;

    const result = compressToolOutput(text);
    expect(result).toContain("failed");
    expect(result).toContain("FAIL");
  });

  // ========================================================================
  // Safety: user/AI content untouched
  // ========================================================================

  it("never modifies plain conversation text", () => {
    const text = "User: How do I fix this git push error?\n\nAssistant: You need to pull first.";
    expect(compressToolOutput(text)).toBe(text);
  });

  it("preserves AI reasoning about tool results", () => {
    const text = "The test result shows 15 passed, which means our fix works.";
    expect(compressToolOutput(text)).toBe(text);
  });

  // ========================================================================
  // Edge cases
  // ========================================================================

  it("handles empty input", () => {
    expect(compressToolOutput("")).toBe("");
  });

  it("handles short input", () => {
    expect(compressToolOutput("hi")).toBe("hi");
  });

  it("handles text without tool outputs", () => {
    const text = "This is a normal conversation.\nNo tool outputs here.";
    expect(compressToolOutput(text)).toBe(text);
  });

  // ========================================================================
  // Large output truncation
  // ========================================================================

  it("truncates large unmatched tool output", () => {
    // Use content with spaces/special chars to avoid base64 regex match
    const largeOutput = Array.from({ length: 150 }, (_, i) => `line ${i}: some detailed output here`).join("\n");
    const text = `$ some-command\n${largeOutput}\n\nNext step.`;
    const result = compressToolOutput(text);
    expect(result).toContain("[...");
    expect(result).toContain("chars truncated");
    expect(result.length).toBeLessThan(text.length);
  });

  // ========================================================================
  // 回归：工具输出块位于字符串结尾（原 \z 锚点 bug）
  // 旧实现 lookahead 末项是 \z（JS 无此锚点 → 当字面字符 z）：
  //   - 块结尾无字面 z 时整块漏匹配 → 末尾大输出逃过截断
  //   - 块含字面 z 时惰性匹配在第一个 z 处误截断
  // 修复为 (?![\s\S])（字符串绝对结尾）后两种都应正确处理。
  // ========================================================================

  it("truncates a large tool output block that ends the string (no trailing marker)", () => {
    // 末尾块、无字母 z、后面没有下一个命令/空行大写/## → 旧 \z 实现整块漏匹配
    const largeOutput = Array.from({ length: 150 }, (_, i) => `line ${i}: detailed output here`).join("\n");
    const text = `$ some-command\n${largeOutput}`;
    const result = compressToolOutput(text);
    expect(result).toContain("chars truncated");
    expect(result.length).toBeLessThan(text.length);
  });

  it("does not cut a trailing tool output block at a literal 'z'", () => {
    // 末尾大块含字母 z → 旧 \z 实现在第一个 z 处截断匹配，导致块太短逃过截断
    const largeOutput = Array.from({ length: 150 }, (_, i) => `line ${i}: zebra output zone`).join("\n");
    const text = `$ some-command\n${largeOutput}`;
    const result = compressToolOutput(text);
    expect(result).toContain("chars truncated");
    // 截断尾部应保留块真正的结尾，而不是停在某个 z 之前
    expect(result).toContain("zone");
  });
});
