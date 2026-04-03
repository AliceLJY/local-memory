import { describe, it, expect } from "bun:test";
import { isTemporalOrActionContent } from "../ingest.js";

describe("Dedup guard: isTemporalOrActionContent", () => {
  describe("date-stamped events (must NOT be deduped)", () => {
    it("ISO date", () => expect(isTemporalOrActionContent("2026-03-25 部署了新版本")).toBe(true));
    it("今天", () => expect(isTemporalOrActionContent("今天跑了 benchmark")).toBe(true));
    it("昨天", () => expect(isTemporalOrActionContent("昨天讨论了架构")).toBe(true));
    it("上次", () => expect(isTemporalOrActionContent("上次的方案不行")).toBe(true));
    it("刚才", () => expect(isTemporalOrActionContent("刚才改了配置")).toBe(true));
  });

  describe("file operations (must NOT be deduped)", () => {
    it("file path", () => expect(isTemporalOrActionContent("修改了 /Users/xxx/src/foo.ts")).toBe(true));
    it("home path", () => expect(isTemporalOrActionContent("保存到 ~/recallnest/data/")).toBe(true));
    it("md file", () => expect(isTemporalOrActionContent("更新了 README.md")).toBe(true));
    it("mv command", () => expect(isTemporalOrActionContent("mv old.json new.json")).toBe(true));
    it("归档", () => expect(isTemporalOrActionContent("把旧文件归档了")).toBe(true));
  });

  describe("memory instructions (must NOT be deduped)", () => {
    it("记住", () => expect(isTemporalOrActionContent("记住不要用 rm")).toBe(true));
    it("remember", () => expect(isTemporalOrActionContent("remember to check tests")).toBe(true));
    it("别忘了", () => expect(isTemporalOrActionContent("别忘了跑测试")).toBe(true));
    it("务必", () => expect(isTemporalOrActionContent("务必先备份")).toBe(true));
  });

  describe("feedback/corrections (must NOT be deduped)", () => {
    it("不要再", () => expect(isTemporalOrActionContent("不要再用这个方法")).toBe(true));
    it("stop doing", () => expect(isTemporalOrActionContent("stop doing that")).toBe(true));
    it("don't", () => expect(isTemporalOrActionContent("don't mock the database")).toBe(true));
  });

  describe("generic content (CAN be deduped normally)", () => {
    it("plain description", () => expect(isTemporalOrActionContent("RecallNest 是一个记忆服务")).toBe(false));
    it("technical fact", () => expect(isTemporalOrActionContent("LanceDB 支持向量搜索")).toBe(false));
    it("preference without instruction marker", () => expect(isTemporalOrActionContent("我喜欢用 dark mode")).toBe(false));
  });
});
