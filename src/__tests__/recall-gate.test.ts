import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runAutoRecall } from "../auto-recall.js";
import {
  RECALL_GATE_SHADOW_FILE,
  classifyRecallGate,
  resolveRecallGateMode,
  type RecallGateDecision,
} from "../recall-gate.js";
import type { RetrievalContext, RetrievalResult } from "../retriever.js";

const savedGateEnv = process.env.RECALLNEST_RECALL_GATE;
const savedDataDirEnv = process.env.RECALLNEST_DATA_DIR;
const cleanupPaths: string[] = [];

afterEach(() => {
  if (savedGateEnv === undefined) delete process.env.RECALLNEST_RECALL_GATE;
  else process.env.RECALLNEST_RECALL_GATE = savedGateEnv;
  if (savedDataDirEnv === undefined) delete process.env.RECALLNEST_DATA_DIR;
  else process.env.RECALLNEST_DATA_DIR = savedDataDirEnv;
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) rmSync(target, { recursive: true, force: true });
  }
});

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recallnest-gate-"));
  cleanupPaths.push(dir);
  process.env.RECALLNEST_DATA_DIR = dir;
  return dir;
}

function expectDecision(message: string, decision: RecallGateDecision, ruleId?: string) {
  const verdict = classifyRecallGate(message);
  expect(`${message} → ${verdict.decision}`).toBe(`${message} → ${decision}`);
  if (ruleId) expect(verdict.ruleId).toBe(ruleId);
}

describe("classifyRecallGate — verdict matrix", () => {
  it("force cues win over every short-text rule", () => {
    expectDecision("可以按上次方案做", "full-recall", "force:memory-cue-zh");
    expectDecision("记得我说过什么吗", "full-recall");
    expectDecision("我的偏好是什么", "full-recall");
    expectDecision("do you remember my setup?", "full-recall", "force:memory-cue-en");
    expectDecision("what did we discussed last time", "full-recall");
    // Force cue inside an otherwise long message still labels full-recall.
    const long = `${"背景介绍。".repeat(20)}上次的结论是什么?`;
    expectDecision(long, "full-recall");
  });

  it("whole-message acks skip; acks with real content pass", () => {
    expectDecision("好的", "skip-all", "skip:ack");
    expectDecision("好的吧。", "skip-all");
    expectDecision("嗯嗯", "skip-all");
    expectDecision("OK", "skip-all");
    expectDecision("Thanks!", "skip-all");
    expectDecision("好的 谢谢", "skip-all");
    expectDecision("收到了哈", "skip-all");
    expectDecision("好的,先跑测试再说", "pass");
    expectDecision("可以先做项1", "pass");
  });

  it("continuity nudges are resume-only; nudge + content passes", () => {
    expectDecision("继续", "resume-only", "resume:continuity");
    expectDecision("继续吧", "resume-only");
    expectDecision("接着来", "resume-only");
    expectDecision("下一步", "resume-only");
    expectDecision("开始", "resume-only");
    expectDecision("开始吧", "resume-only");
    expectDecision("continue", "resume-only");
    expectDecision("接着改 auto-recall 的闸", "pass");
    // "继续讨论上次的方案" carries a force cue → full-recall, not resume-only.
    expectDecision("继续讨论上次的方案", "full-recall");
  });

  it("bare CLI invocations skip; CLI words inside prose pass", () => {
    expectDecision("git push", "skip-all", "skip:cli");
    expectDecision("npm test", "skip-all");
    expectDecision("bun test src/__tests__/recall-gate.test.ts", "skip-all");
    expectDecision("git", "skip-all");
    expectDecision("git 为什么失败", "pass");
    expectDecision("why does npm test hang?", "pass");
    expectDecision("测试之前讨论的方案", "full-recall"); // force cue, not cli
  });

  it("slash commands and heartbeats skip", () => {
    expectDecision("/compact", "skip-all", "skip:slash");
    expectDecision("/goal 写个爬虫", "skip-all");
    expectDecision("HEARTBEAT_OK", "skip-all", "skip:heartbeat");
  });

  it("pure emoji skips; bare digits/#/* are NOT emoji", () => {
    expectDecision("👍", "skip-all", "skip:emoji");
    expectDecision("👍👍 🎉", "skip-all");
    expectDecision("🇸🇬", "skip-all");
    expectDecision("42", "pass");
    expectDecision("#1", "pass");
    expectDecision("*", "pass");
  });

  it("greetings skip as whole messages only", () => {
    expectDecision("你好", "skip-all", "skip:greeting");
    expectDecision("早", "skip-all");
    expectDecision("hello", "skip-all");
    expectDecision("在吗", "skip-all");
    expectDecision("你好,帮我查一下部署状态", "pass");
  });

  it("long messages without force cues always pass", () => {
    const long = "这条消息足够长,描述了一个具体的问题背景和期望的处理方式,值得走完整的检索管线来补上下文。".repeat(2);
    expect(long.length).toBeGreaterThan(80);
    expectDecision(long, "pass", "pass:long");
  });

  it("empty input degrades to skip:empty", () => {
    expectDecision("   ", "skip-all", "skip:empty");
  });
});

describe("resolveRecallGateMode", () => {
  it("defaults to observe; parses enforce/off; junk falls back to observe", () => {
    expect(resolveRecallGateMode({})).toBe("observe");
    expect(resolveRecallGateMode({ RECALLNEST_RECALL_GATE: "enforce" })).toBe("enforce");
    expect(resolveRecallGateMode({ RECALLNEST_RECALL_GATE: "OFF" })).toBe("off");
    expect(resolveRecallGateMode({ RECALLNEST_RECALL_GATE: "banana" })).toBe("observe");
  });
});

// --- integration through runAutoRecall ---

function buildResult(id: string, text: string): RetrievalResult {
  return {
    entry: {
      id,
      text,
      vector: [],
      category: "events",
      scope: "project:gate",
      importance: 0.8,
      timestamp: Date.parse("2026-07-01T00:00:00.000Z"),
      metadata: "{}",
    },
    score: 0.9,
    sources: { fused: { score: 0.9 } },
  };
}

function makeDeps() {
  const calls: RetrievalContext[] = [];
  return {
    calls,
    deps: {
      retriever: {
        async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
          calls.push(context);
          if (!context.category) return [buildResult("hit-1", "focused hit")];
          return [];
        },
      },
      checkpointStore: { async getLatest() { return null; } },
      listPins: () => [],
    },
  };
}

describe("runAutoRecall × recall gate", () => {
  it("observe mode leaves behavior unchanged and appends a shadow entry", async () => {
    const dir = tempDataDir();
    const { deps, calls } = makeDeps();

    const response = await runAutoRecall(deps, {
      message: "好的",
      scope: "project:gate",
      operation: "test:gate-observe",
      env: { RECALLNEST_RECALL_GATE: "observe" } as NodeJS.ProcessEnv,
    });

    // Unchanged behavior: full resume+search pipeline still ran.
    expect(response.mode).toBe("resume+search");
    expect(calls.length).toBeGreaterThan(0);
    expect(response.results.length).toBe(1);

    const shadowPath = join(dir, RECALL_GATE_SHADOW_FILE);
    expect(existsSync(shadowPath)).toBe(true);
    const entry = JSON.parse(readFileSync(shadowPath, "utf8").trim().split("\n")[0] ?? "{}");
    expect(entry.decision).toBe("skip-all");
    expect(entry.ruleId).toBe("skip:ack");
    expect(entry.mode).toBe("observe");
    expect(entry.msgLen).toBe(2);
    expect(entry.source).toBe("test:gate-observe");
    expect(JSON.stringify(entry)).not.toContain("好的"); // never log message text
  });

  it("enforce + skip-all short-circuits before any retriever call", async () => {
    tempDataDir();
    const { deps, calls } = makeDeps();

    const response = await runAutoRecall(deps, {
      message: "👍",
      scope: "project:gate",
      operation: "test:gate-enforce-skip",
      env: { RECALLNEST_RECALL_GATE: "enforce" } as NodeJS.ProcessEnv,
    });

    expect(response.mode).toBe("resume-only");
    expect(response.results.length).toBe(0);
    expect(response.searchSkippedReason).toContain("skip-all");
    expect(response.searchSkippedReason).toContain("skip:emoji");
    expect(calls.length).toBe(0); // neither compose nor focused search hit the retriever
  });

  it("enforce + resume-only keeps resume context but skips the focused search", async () => {
    tempDataDir();
    const { deps, calls } = makeDeps();

    const response = await runAutoRecall(deps, {
      message: "继续",
      scope: "project:gate",
      operation: "test:gate-enforce-resume",
      env: { RECALLNEST_RECALL_GATE: "enforce" } as NodeJS.ProcessEnv,
    });

    expect(response.mode).toBe("resume-only");
    expect(response.results.length).toBe(0);
    expect(response.searchSkippedReason).toContain("resume-only");
    // Resume composition ran (retriever called with categories), but no
    // focused search (which would be the category-less call).
    const focusedCalls = calls.filter((c) => !c.category);
    expect(focusedCalls.length).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("enforce mode leaves normal content untouched", async () => {
    tempDataDir();
    const { deps } = makeDeps();

    const response = await runAutoRecall(deps, {
      message: "帮我看看 retriever 的打分逻辑有没有问题",
      scope: "project:gate",
      operation: "test:gate-enforce-pass",
      env: { RECALLNEST_RECALL_GATE: "enforce" } as NodeJS.ProcessEnv,
    });

    expect(response.mode).toBe("resume+search");
    expect(response.results.length).toBe(1);
  });

  it("off mode computes nothing and writes no shadow log", async () => {
    const dir = tempDataDir();
    const { deps } = makeDeps();

    const response = await runAutoRecall(deps, {
      message: "好的",
      scope: "project:gate",
      operation: "test:gate-off",
      env: { RECALLNEST_RECALL_GATE: "off" } as NodeJS.ProcessEnv,
    });

    expect(response.mode).toBe("resume+search");
    expect(existsSync(join(dir, RECALL_GATE_SHADOW_FILE))).toBe(false);
  });
});
