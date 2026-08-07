import { describe, expect, it } from "bun:test";

import { selectStableResults } from "../context-composer-stable-selection.js";
import { ResumeContextResponseSchema } from "../session-schema.js";
import type { RetrievalResult } from "../retriever.js";

// selectStableResults 产出的行必须过得了 stableContext 的 schema 上限。
// 这条曾经断过：formatStableResult 截到 230、schema 上限 220，中间的
// interleaveUnique（context-composer-stable.ts:199-206）不再截一次，
// 于是 221~230 字符的行会让 composeResumeContext 末尾的
// ResumeContextResponseSchema.parse 抛错，**整个 resume_context 调用失败**
// —— 不是降级，是抛异常。实测 14 条真实问法里 1 条命中。
//
// 用长文本喂进去，逼出最长可能的输出，再拿真 schema 验，
// 这样将来任一侧的数字被改动都会在这里红，而不是等生产上抛。

const SCHEMA_MAX = 220;

function longPreference(): RetrievalResult {
  return {
    entry: {
      id: "test-long-pref",
      // 远超上限的正文，确保格式化后会吃满截断长度
      text: `用户确立的一条长期偏好：${"跨端协作时先确认目标仓库与路径再动手，".repeat(30)}`,
      vector: [],
      category: "preferences",
      scope: "memory:pivot",
      importance: 0.9,
      timestamp: Date.now(),
    },
    score: 1,
    sources: {},
  } as RetrievalResult;
}

describe("stableContext 长度契约", () => {
  it("超长偏好格式化后不超过 schema 上限", () => {
    const lines = selectStableResults("preferences", [longPreference()], 3, {
      taskSeed: "跨端协作要注意什么",
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(SCHEMA_MAX);
    }
  });

  it("这些行能通过真实的 ResumeContextResponseSchema", () => {
    const stableContext = selectStableResults("preferences", [longPreference()], 3, {
      taskSeed: "跨端协作要注意什么",
    });
    // 只验长度这一维：其余必填字段给最小合法值，schema 变动时这里也会跟着红
    expect(() =>
      ResumeContextResponseSchema.parse({
        summary: "test",
        generatedAt: new Date().toISOString(),
        stableContext,
        relevantPatterns: [],
        recentCases: [],
      }),
    ).not.toThrow();
  });
});
