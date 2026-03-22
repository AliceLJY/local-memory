import { describe, expect, it } from "bun:test";

import {
  buildTaskHintTerms,
  extractTerms,
  looksLikeContinuityTask,
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

  it("can keep later terms when a wider extraction window is requested", () => {
    expect(
      extractTerms(
        "继续 RecallNest continuity helper boundary audit ranking scoring selection orchestration context composer stable query fallback profile forwarding gap runner isolation",
        24,
      ),
    ).toEqual(expect.arrayContaining([
      "profile",
      "forwarding",
      "runner",
      "isolation",
    ]));
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

  it("treats named RecallNest and memory-layer continues as continuity tasks", () => {
    expect(looksLikeContinuityTask("回到 RecallNest 继续做")).toBe(true);
    expect(looksLikeContinuityTask("接着弄 RecallNest 那个 memory layer")).toBe(true);
    expect(looksLikeContinuityTask("把记忆层这条线先续上")).toBe(true);
    expect(looksLikeContinuityTask("把之前那套 recall 管线先捡起来")).toBe(true);
    expect(looksLikeContinuityTask("回到 A2A 继续做")).toBe(false);
  });

  it("builds RecallNest continuity hints for memory-layer shorthand", () => {
    expect(buildTaskHintTerms("把刚才那个 memory layer 接回去")).toEqual(expect.arrayContaining([
      "recallnest",
      "checkpoint_session",
      "resume_context",
      "store_memory",
    ]));
  });

  it("builds RecallNest continuity hints for colloquial memory shorthand", () => {
    expect(buildTaskHintTerms("把那条跨窗口记忆的活接着弄完")).toEqual(expect.arrayContaining([
      "recallnest",
      "checkpoint_session",
      "resume_context",
    ]));
    expect(buildTaskHintTerms("把之前那套 recall 管线先捡起来")).toEqual(expect.arrayContaining([
      "recallnest",
      "checkpoint_session",
      "resume_context",
    ]));
  });

  it("treats 记忆项目 as continuity task and builds RecallNest hints", () => {
    expect(looksLikeContinuityTask("那个记忆项目，之前做到哪了")).toBe(true);
    expect(looksLikeContinuityTask("继续记忆项目")).toBe(true);
    expect(buildTaskHintTerms("那个记忆项目，之前做到哪了")).toEqual(expect.arrayContaining([
      "recallnest",
      "resume_context",
    ]));
    expect(buildTaskHintTerms("continue the memory project")).toEqual(expect.arrayContaining([
      "recallnest",
    ]));
  });

  it("treats 跨终端记忆/记忆功能/记忆服务 shorthand as continuity cue", () => {
    // "还搞吗" is a status question, not a continuation verb — correct to return false
    expect(looksLikeContinuityTask("那个跨终端记忆还搞吗")).toBe(false);
    expect(looksLikeContinuityTask("继续那个跨终端记忆")).toBe(true);
    expect(looksLikeContinuityTask("上次做的那个记忆功能")).toBe(true);
    expect(looksLikeContinuityTask("之前那个 MCP 记忆服务")).toBe(true);
    expect(buildTaskHintTerms("那个跨终端记忆还搞吗")).toEqual(expect.arrayContaining([
      "recallnest",
    ]));
    expect(buildTaskHintTerms("上次做的记忆功能")).toEqual(expect.arrayContaining([
      "recallnest",
    ]));
  });
});
