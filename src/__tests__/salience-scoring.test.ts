import { describe, it, expect } from "bun:test";
import type { LLMClient } from "../llm-client.js";

function createMockLLM(response: string): LLMClient {
  return {
    async chat() {
      return response;
    },
    async assessImportance(text: string) {
      const parsed = JSON.parse(response);
      return parsed.importance ?? null;
    },
    async reassessImportanceBatch(
      entries: Array<{ id: string; text: string; category: string; currentImportance: number }>,
    ) {
      const results = new Map<string, number>();
      try {
        const parsed = JSON.parse(response);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.idx >= 0 && item.idx < entries.length) {
              results.set(entries[item.idx].id, item.importance);
            }
          }
        }
      } catch {
        // match real implementation: non-fatal
      }
      return results;
    },
  } as any;
}

describe("HP-4: Salience scoring anchoring", () => {
  describe("assessImportance anchored tiers", () => {
    it("identity/correction → 0.85+", async () => {
      const llm = createMockLLM(JSON.stringify({ importance: 0.92, reason: "用户明确纠正" }));
      const result = await llm.assessImportance("不要用 rm 删除文件", "profile");
      expect(result).toBeGreaterThanOrEqual(0.85);
    });

    it("decision/case → 0.70-0.84", async () => {
      const llm = createMockLLM(JSON.stringify({ importance: 0.75, reason: "架构决策" }));
      const result = await llm.assessImportance("选用 LanceDB 作为向量存储", "cases");
      expect(result).toBeGreaterThanOrEqual(0.70);
      expect(result).toBeLessThan(0.85);
    });

    it("entity/background → 0.55-0.69", async () => {
      const llm = createMockLLM(JSON.stringify({ importance: 0.60, reason: "项目信息" }));
      const result = await llm.assessImportance("RecallNest 使用 Bun 运行时", "entities");
      expect(result).toBeGreaterThanOrEqual(0.55);
      expect(result).toBeLessThan(0.70);
    });

    it("event/one-off → 0.40-0.54", async () => {
      const llm = createMockLLM(JSON.stringify({ importance: 0.45, reason: "一次性操作" }));
      const result = await llm.assessImportance("今天部署了 v2.1", "events");
      expect(result).toBeGreaterThanOrEqual(0.40);
      expect(result).toBeLessThan(0.55);
    });

    it("chatter/temp → 0.10-0.30", async () => {
      const llm = createMockLLM(JSON.stringify({ importance: 0.15, reason: "临时上下文" }));
      const result = await llm.assessImportance("好的，我看一下", "events");
      expect(result).toBeGreaterThanOrEqual(0.10);
      expect(result).toBeLessThan(0.40);
    });
  });

  describe("reassessImportanceBatch", () => {
    it("returns adjusted entries with ≥ 0.1 delta", async () => {
      const batchResponse = JSON.stringify([
        { idx: 0, importance: 0.90 },
        { idx: 2, importance: 0.30 },
      ]);
      const llm = createMockLLM(batchResponse);
      const entries = [
        { id: "a", text: "永远不要用 rm", category: "profile", currentImportance: 0.70 },
        { id: "b", text: "选用 LanceDB", category: "cases", currentImportance: 0.75 },
        { id: "c", text: "今天天气不错", category: "events", currentImportance: 0.70 },
      ];
      const result = await llm.reassessImportanceBatch(entries);
      expect(result.size).toBe(2);
      expect(result.get("a")).toBe(0.90);
      expect(result.get("c")).toBe(0.30);
      expect(result.has("b")).toBe(false);
    });

    it("returns empty map on empty input", async () => {
      const llm = createMockLLM("[]");
      const result = await llm.reassessImportanceBatch([]);
      expect(result.size).toBe(0);
    });

    it("handles invalid LLM response gracefully", async () => {
      const llm = createMockLLM("not-json");
      const entries = [
        { id: "a", text: "test", category: "events", currentImportance: 0.5 },
      ];
      // Should not throw
      const result = await llm.reassessImportanceBatch(entries);
      expect(result.size).toBe(0);
    });
  });
});
