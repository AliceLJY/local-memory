import { describe, expect, it } from "bun:test";

import { selectStableResults } from "../context-composer-stable-selection.js";
import { selectTaskResults } from "../context-composer-task-selection.js";
import {
  PREFERENCE_SPECIFICITY_GROUPS,
  TASK_RESULT_SPECIFICITY_GROUPS,
} from "../term-registry.js";
import type { RetrievalResult } from "../retriever.js";

// 端清单在检索术语簇里的落地。守两件事：
//   ① 补上的端名真的解除了过滤（行为层）
//   ② **有意的不对称不许被"机械补齐"抹掉**（结构层）——
//      taskTerms 补端名、resultTerms 不补。这条最容易被后来人当成漏改而"顺手统一"，
//      所以用测试钉住，并把理由写在断言旁边。
// 背景同 memory-boundaries.ts:64-70 的 TRANSCRIPT_SOURCES —— 那处是字面 scope 前缀层，
// 按字面补；这里是检索语义层，两侧方向相反，不能照抄。

function stableCandidate(text: string): RetrievalResult {
  return {
    entry: {
      id: `test-${text.slice(0, 8)}`,
      text,
      vector: [],
      category: "preferences",
      scope: "memory:pivot",
      importance: 0.8,
      timestamp: Date.now(),
    },
    score: 1,
    sources: {},
  } as RetrievalResult;
}

function taskCandidate(text: string): RetrievalResult {
  return {
    entry: {
      id: `test-${text.slice(0, 8)}`,
      text,
      vector: [],
      category: "cases",
      scope: "memory:pivot",
      importance: 0.8,
      timestamp: Date.now(),
    },
    score: 1,
    sources: {},
  } as RetrievalResult;
}

// 会被 PREFERENCE_SPECIFICITY_GROUPS 认领的偏好（正文含 "codex" + "独立验证"）
const CODEX_REVIEW_PREF =
  "用户要求互审时由 Codex 做独立验证，交接材料里客观证据自动抽取，判断性材料必须手写填充。";

describe("端清单 · PREFERENCE_SPECIFICITY_GROUPS", () => {
  it("问 kimi / agy / antigravity 时不再把 CC·Codex 的验收偏好滤掉", () => {
    for (const task of [
      "kimi 互审的时候要注意什么",
      "agy 那边是谁在做审查",
      "antigravity 的会话是怎么接进来的",
    ]) {
      expect(
        selectStableResults("preferences", [stableCandidate(CODEX_REVIEW_PREF)], 3, { taskSeed: task }),
      ).toHaveLength(1);
    }
  });

  it("问端拓扑本身（三端 / 四端）时同样解除", () => {
    for (const task of ["四端的触发规则都装好了吗", "三端现在还一致吗"]) {
      expect(
        selectStableResults("preferences", [stableCandidate(CODEX_REVIEW_PREF)], 3, { taskSeed: task }),
      ).toHaveLength(1);
    }
  });

  it("与端无关的任务仍然滤掉 —— 放宽不能变成不过滤", () => {
    for (const task of ["帮我写一篇公众号文章", "百度网盘上传断链怎么排查"]) {
      expect(
        selectStableResults("preferences", [stableCandidate(CODEX_REVIEW_PREF)], 3, { taskSeed: task }),
      ).toHaveLength(0);
    }
  });

  it("resultTerms 有意不含端名 —— 别照着 taskTerms 补齐", () => {
    // resultTerms 是「谁被这组认领」，加裸端名会把"顺带提了一句 kimi"的无关偏好
    // 整条变成可滤对象。已知实例：裸词 "codex" 已因 `.codex/AGENTS.md` 这种
    // 路径片段误认领记忆（shadow 实测 b8731a81）。再加端名 = 把缺陷复制三份。
    for (const term of ["kimi", "antigravity", "agy", "三端", "四端"]) {
      expect(PREFERENCE_SPECIFICITY_GROUPS[0]?.resultTerms).not.toContain(term);
    }
    expect(PREFERENCE_SPECIFICITY_GROUPS[0]?.taskTerms).toEqual(
      expect.arrayContaining(["kimi", "antigravity", "agy", "三端", "四端"]),
    );
  });
});

describe("端清单 · 三端历史事件组（TASK_RESULT_SPECIFICITY_GROUPS）", () => {
  const historyGroup = TASK_RESULT_SPECIFICITY_GROUPS.find((group) =>
    group.resultTerms.includes("three-terminal continuity trigger validation"),
  );

  it("resultTerms 是历史专名，不是端清单 —— 不补任何端名", () => {
    expect(historyGroup).toBeDefined();
    for (const term of ["kimi", "antigravity", "agy"]) {
      expect(historyGroup?.resultTerms).not.toContain(term);
    }
  });

  it("taskTerms 补她真实的问法（三端 / 四端），但同样不补端名", () => {
    // "三端" 不是 "三终端" 的子串，补之前真的匹配不上
    expect(historyGroup?.taskTerms).toEqual(expect.arrayContaining(["三端", "四端"]));
    for (const term of ["kimi", "antigravity", "agy"]) {
      expect(historyGroup?.taskTerms).not.toContain(term);
    }
  });

  it("只提端名、不问触发/接入的任务，不该把这条三端历史放进来", () => {
    const history = taskCandidate(
      "三端连续性触发验证：three-terminal continuity trigger validation 已完成，continue-style prompts triggered recall reliably。",
    );
    expect(selectTaskResults("cases", [history], 3, { taskSeed: "kimi 挂了" })).toHaveLength(0);
    // 对照：真正相关的问法照旧放行
    expect(
      selectTaskResults("cases", [history], 3, { taskSeed: "三端的触发验证结论还成立吗" }).length,
    ).toBeGreaterThan(0);
  });
});
