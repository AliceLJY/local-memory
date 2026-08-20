/**
 * 每个会话来源的 scope 前缀必须在 memory-boundaries 的清单里登记。
 *
 * 这条约束是承重的，不是整洁问题：TRANSCRIPT_SCOPE_PREFIXES 决定了会话碎片
 * 会不会被降权到 evidence 层。漏登记一个前缀，那个端的 shell 输出就会被当成
 * 「用户说过的话」提炼成 durable 结论——kimi 与 antigravity 就这么漏过
 * （2026-07 进栈，直到 2026-08-01 才发现库里一直被当结论对待）。
 *
 * 所以加新 ingest 源时，这个测试会在你只改了 config.json / cli.ts 却忘了
 * 登记前缀的时候变红。
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTranscriptIngestSource, isTranscriptScope } from "../memory-boundaries.js";

const config = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "config.json"), "utf8"),
) as { sources: Record<string, { path: string; glob: string; description?: string }> };

// config 源名 → 它写进库的 scope 前缀。
// desktop 沿用 cc 前缀是历史行为（Claude Desktop 导出的就是 CC 格式对话）。
const SOURCE_SCOPE_PREFIX: Record<string, string | null> = {
  cc: "cc",
  codex: "codex",
  gemini: "gemini",
  kimi: "kimi",
  desktop: "cc",
  minis: "minis",
  memory: null, // markdown 记忆文件，不是会话记录，不走 transcript 降权
};

describe("ingest 源的 scope 前缀登记", () => {
  it("config.json 里每个源都在本测试的映射表里有交代", () => {
    for (const name of Object.keys(config.sources)) {
      expect(
        Object.prototype.hasOwnProperty.call(SOURCE_SCOPE_PREFIX, name),
      ).toBe(true);
    }
  });

  it("每个会话类来源的 scope 都被判定为 transcript 证据（会被降权）", () => {
    for (const [name, prefix] of Object.entries(SOURCE_SCOPE_PREFIX)) {
      if (prefix === null) continue;
      // 断言里带上源名，红的时候直接看得出是哪个源漏登记
      expect(`${name}:${isTranscriptScope(`${prefix}:abcd1234`)}`).toBe(`${name}:true`);
    }
  });

  it("minis 源已接线：config 有条目且前缀被降权识别", () => {
    expect(config.sources.minis).toBeDefined();
    expect(config.sources.minis.glob).toBe("*.jsonl");
    expect(isTranscriptScope("minis:9f3e7a21")).toBe(true);
  });

  it("同一个前缀也必须在 source 清单里登记（两道闸，漏一道就静默失真）", () => {
    // isTranscriptScope 看 scope、isTranscriptSource 看条目的 source 字段。
    // 只登记前者时降权仍然生效，错误不会报出来，只会让「按来源过滤」查不准。
    for (const [name, prefix] of Object.entries(SOURCE_SCOPE_PREFIX)) {
      if (prefix === null) continue;
      expect(`${name}:${isTranscriptIngestSource(prefix)}`).toBe(`${name}:true`);
    }
  });

  it("一条反向断言：没登记过的前缀不会被误判成 transcript", () => {
    expect(isTranscriptScope("project:recallnest")).toBe(false);
    expect(isTranscriptScope("memory:pivot")).toBe(false);
  });
});
