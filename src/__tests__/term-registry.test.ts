import { describe, expect, it } from "bun:test";

import {
  buildTaskHintTerms,
  extractTerms,
  looksLikeRecallOnlyTask,
  taskCueCoverage,
} from "../term-registry.js";

describe("term registry", () => {
  it("extracts compact Chinese and latin cue terms", () => {
    expect(extractTerms("继续 RecallNest continuity bridge 适配")).toEqual([
      "继续",
      "recallnest",
      "continuity",
      "bridge",
      "适配",
    ]);
  });

  it("builds task hints for writing prompts across languages", () => {
    expect(buildTaskHintTerms("continue my AI writing project")).toEqual([
      "写作",
      "文章",
      "语气",
      "风格",
      "口语化",
      "不端着",
      "ai",
      "公众号",
    ]);
  });

  it("treats recall-only wording differently from writing actions", () => {
    expect(looksLikeRecallOnlyTask("你还记得我之前的偏好吗")).toBe(true);
    expect(looksLikeRecallOnlyTask("不要让我重复前情，继续写文章")).toBe(false);
  });

  it("tracks workflow cue coverage from pattern text", () => {
    expect(
      taskCueCoverage(
        "patterns",
        "Workflow pattern: Cross-window continuity handoff Tools: resume_context, checkpoint_session, search_memory",
      ),
    ).toEqual(["search_memory", "resume_context", "checkpoint"]);
  });
});
