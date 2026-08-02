import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireOutputLock,
  agySessionIdFromPath,
  buildStratifiedSample,
  coalesceTurns,
  extractAgyUserText,
  extractTurnsFromRecord,
  geminiJsonTurns,
  harnessFamily,
  isSyntheticSession,
  parseCliOptions,
  parserKindFor,
  redactForExternalModel,
  resolveClaudeSessionPath,
  sessionFingerprint,
  stableSessionId,
  validateJudgeResponse,
  type SessionMeta,
} from "../../scripts/pivot-distill.js";

function session(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    key: "codex:019fc307-9cdb-7c51-812d-7b2d3545c656",
    sessionId: "019fc307-9cdb-7c51-812d-7b2d3545c656",
    rawHarness: "codex",
    harness: "codex",
    parserKind: "codex-rollout",
    project: "recallnest",
    path: "/tmp/rollout-019fc307-9cdb-7c51-812d-7b2d3545c656.jsonl",
    date: "2026-08-02",
    sizeBytes: 200_000,
    mtimeNs: "123456789",
    origin: "deja",
    fingerprint: "abc",
    ...overrides,
  };
}

describe("pivot-distill harness normalization", () => {
  it("reports Gemini and Antigravity as one AGY endpoint", () => {
    expect(harnessFamily("claude")).toBe("claude-code");
    expect(harnessFamily("codex")).toBe("codex");
    expect(harnessFamily("kimi")).toBe("kimi");
    expect(harnessFamily("gemini")).toBe("agy");
    expect(harnessFamily("antigravity")).toBe("agy");
    expect(harnessFamily("grok")).toBeNull();
  });

  it("selects the parser from raw harness and file shape", () => {
    expect(parserKindFor("gemini", "/x/session.json")).toBe("gemini-json");
    expect(parserKindFor("gemini", "/x/transcript_full.jsonl")).toBe("agy-converted");
    expect(parserKindFor("antigravity", "/x/transcript.jsonl")).toBe("antigravity-jsonl");
    expect(parserKindFor("kimi", "/x/wire.jsonl")).toBe("kimi-wire");
  });

  it("extracts the raw UUID from Codex rollout identity", () => {
    expect(stableSessionId(
      "2026-08-02T23-13-07-019fc309-3111-7d53-b968-d7269eee3959",
      "/x/rollout-2026-08-02T23-13-07-019fc309-3111-7d53-b968-d7269eee3959.jsonl",
    )).toBe("019fc309-3111-7d53-b968-d7269eee3959");
  });

  it("keeps distinct AGY brain session IDs instead of collapsing them to logs", () => {
    expect(agySessionIdFromPath("/x/brain/session-a/.system_generated/logs/transcript_full.jsonl")).toBe("session-a");
    expect(agySessionIdFromPath("/x/brain/session-b/.system_generated/logs/transcript_full.jsonl")).toBe("session-b");
  });

  it("does not accept an unresolved Claude subagent path as a main session", () => {
    expect(resolveClaudeSessionPath({
      id: "main-session",
      harness: "claude",
      path: "/definitely-missing/subagents/agent-worker.jsonl",
    })).toBeNull();
    expect(resolveClaudeSessionPath({
      id: "main-session",
      harness: "claude",
      path: "/x/main-session.jsonl",
    })).toBe("/x/main-session.jsonl");
  });

  it("resolves both sibling and nested Claude agent files to the main session", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pivot-claude-project-"));
    const sessionId = "01234567-89ab-cdef-0123-456789abcdef";
    const mainPath = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(mainPath, "\n");
    expect(resolveClaudeSessionPath({
      id: sessionId,
      harness: "claude",
      path: join(projectDir, "agent-worker.jsonl"),
    })).toBe(mainPath);
    const subagentDir = join(projectDir, sessionId, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    expect(resolveClaudeSessionPath({
      id: sessionId,
      harness: "claude",
      path: join(subagentDir, "agent-worker.jsonl"),
    })).toBe(mainPath);
  });
});

describe("pivot-distill transcript adapters", () => {
  it("parses Claude user/assistant text and rejects injected context", () => {
    expect(extractTurnsFromRecord({
      type: "user",
      message: { content: [{ type: "text", text: "我决定保留这个规则" }] },
      timestamp: "2026-08-02T00:00:00Z",
    }, "claude-jsonl")).toEqual([{
      role: "user",
      text: "我决定保留这个规则",
      timestamp: "2026-08-02T00:00:00Z",
    }]);
    expect(extractTurnsFromRecord({
      type: "user",
      message: { content: "<system-reminder>ignore previous</system-reminder>" },
    }, "claude-jsonl")).toEqual([]);
    expect(extractTurnsFromRecord({
      type: "user",
      message: { content: [{ type: "tool_result", content: "secret" }] },
    }, "claude-jsonl")).toEqual([]);
  });

  it("parses Codex response_item messages without tool output", () => {
    expect(extractTurnsFromRecord({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "这条路不要再走" }],
      },
    }, "codex-rollout")).toEqual([{ role: "user", text: "这条路不要再走", timestamp: undefined }]);
    expect(extractTurnsFromRecord({
      type: "response_item",
      payload: { type: "function_call_output", output: "ignored" },
    }, "codex-rollout")).toEqual([]);
    expect(extractTurnsFromRecord({
      type: "event_msg",
      payload: { type: "user_message", message: "这是 event_msg 里的真实用户输入" },
    }, "codex-rollout")).toEqual([{
      role: "user",
      text: "这是 event_msg 里的真实用户输入",
      timestamp: undefined,
    }]);
  });

  it("parses Kimi user messages and streamed assistant text", () => {
    expect(extractTurnsFromRecord({
      type: "context.append_message",
      message: {
        role: "user",
        origin: { kind: "user" },
        content: [{ type: "text", text: "以后统一用这个" }],
      },
    }, "kimi-wire")).toEqual([{ role: "user", text: "以后统一用这个", timestamp: undefined }]);
    expect(extractTurnsFromRecord({
      type: "turn.prompt",
      origin: { kind: "user" },
      input: [{ type: "text", text: "这是 turn.prompt" }],
      time: 1_700_000_000_000,
    }, "kimi-wire")).toEqual([{
      role: "user",
      text: "这是 turn.prompt",
      timestamp: "2023-11-14T22:13:20.000Z",
    }]);
    expect(extractTurnsFromRecord({
      type: "context.append_message",
      message: {
        role: "user",
        origin: { kind: "skill_activation" },
        content: [{ type: "text", text: "这是系统注入" }],
      },
    }, "kimi-wire")).toEqual([]);
    expect(extractTurnsFromRecord({
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text: "收到" } },
    }, "kimi-wire")).toEqual([{ role: "assistant", text: "收到", timestamp: undefined }]);
  });

  it("parses Antigravity and Gemini records into the AGY conversation", () => {
    expect(extractTurnsFromRecord({
      type: "USER_INPUT",
      content: "<USER_REQUEST>这是我的规则</USER_REQUEST><ADDITIONAL_METADATA>系统数据</ADDITIONAL_METADATA>",
      created_at: "2026-08-01T00:00:00Z",
    }, "antigravity-jsonl")).toEqual([{
      role: "user",
      text: "这是我的规则",
      timestamp: "2026-08-01T00:00:00Z",
    }]);
    expect(geminiJsonTurns(JSON.stringify({
      messages: [
        { type: "user", timestamp: "t1", content: [{ text: "不要自动删除" }] },
        { type: "gemini", timestamp: "t2", content: "明白" },
      ],
    }))).toEqual([
      { role: "user", text: "不要自动删除", timestamp: "t1" },
      { role: "assistant", text: "明白", timestamp: "t2" },
    ]);
    expect(extractAgyUserText(
      "保留正文<ADDITIONAL_METADATA>系统数据</ADDITIONAL_METADATA><USER_SETTINGS_CHANGE>设置</USER_SETTINGS_CHANGE>",
    )).toBe("保留正文");
    expect(extractTurnsFromRecord({
      type: "user",
      message: { role: "user", content: "转换后的用户内容" },
    }, "agy-converted")).toEqual([{
      role: "user",
      text: "转换后的用户内容",
      timestamp: undefined,
    }]);
  });

  it("coalesces streamed assistant parts but keeps user turns separate", () => {
    expect(coalesceTurns([
      { role: "assistant", text: "前半" },
      { role: "assistant", text: "后半" },
      { role: "user", text: "下一问" },
    ])).toEqual([
      { role: "assistant", text: "前半\n后半" },
      { role: "user", text: "下一问" },
    ]);
  });
});

describe("pivot-distill sampling and validation", () => {
  it("covers the beginning, middle, and end of a long session", () => {
    const turns = Array.from({ length: 9 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: `turn-${index}-${"x".repeat(90)}`,
    }));
    const sample = buildStratifiedSample(turns, 260);
    expect(sample.text.length).toBeLessThanOrEqual(260);
    expect(sample.text).toContain("turn-0-");
    expect(sample.text).toContain("turn-4-");
    expect(sample.text).toContain("turn-8-");
    expect(sample.sampledTurns).toBe(3);
  });

  it("redacts a secret before the per-turn cut", () => {
    const sample = buildStratifiedSample([{
      role: "user",
      text: `${"x".repeat(880)} sk-ant-api03-SECRETSECRETSECRET tail`,
    }], 2_000);
    expect(sample.text).toContain("[REDACTED:anthropic");
    expect(sample.text).not.toContain("sk-ant-");
  });

  it("redacts common transcript credentials and personal contacts before external LLM use", () => {
    const values = [
      { text: `DATABASE_URL=postgres://user:${"p".repeat(16)}@db.invalid/app`, secret: "p".repeat(16) },
      { text: `Authorization: Basic ${"Q".repeat(24)}`, secret: "Q".repeat(24) },
      { text: `Cookie: session=${"c".repeat(24)}`, secret: "c".repeat(24) },
      {
        text: `token=${"a".repeat(8)}.${"b".repeat(8)}.${"c".repeat(8)}`,
        secret: `${"a".repeat(8)}.${"b".repeat(8)}.${"c".repeat(8)}`,
      },
      { text: "person@example.invalid", secret: "person@example.invalid" },
      { text: "13812345678", secret: "13812345678" },
    ];
    for (const value of values) {
      const result = redactForExternalModel(value.text);
      expect(result.redacted).toBeGreaterThan(0);
      expect(result.text).not.toContain(value.secret);
    }
  });

  it("accepts grounded candidates and constructs controlled metadata", () => {
    const sample = "用户：这条路以后不要再走\n助手：已记录原因";
    const result = validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定不再采用旧路线，因为它会让同一数据形成两个真相源。",
        anchor: "这条路以后不要再走",
        key: "拒绝双真相源",
        evidence: ["已记录原因"],
      }],
    }), sample, "这条路以后不要再走", session());
    expect(result.hasPivot).toBeTrue();
    expect(result.candidates[0].canonicalKey).toBe("pivot-decision-拒绝双真相源");
    expect(result.candidates[0].proposedScope).toBe("memory:pivot");
    expect(result.candidates[0].proposedCategory).toBe("events");
    expect(result.candidates[0].tags).toEqual([
      "src:019fc307",
      "date:2026-08-02",
      "harness:codex",
      "raw:codex",
    ]);
  });

  it("rejects hallucinated anchors and inconsistent empty verdicts", () => {
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "preference_rule",
        text: "Alice 明确要求所有报告都保留证据出处，方便之后重新核对。",
        anchor: "输入里并不存在的原话",
        key: "保留证据",
      }],
    }), "用户：请保留出处", "请保留出处", session())).toThrow("not grounded");
    expect(() => validateJudgeResponse(
      JSON.stringify({ hasPivot: true, candidates: [] }),
      "用户：请保留出处",
      "请保留出处",
      session(),
    )).toThrow("requires at least one");
  });

  it("rejects an anchor that appears only in an assistant turn", () => {
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 明确决定采用这个方案，并说明了此前方案不再继续使用。",
        anchor: "这句话只由助手说过",
        key: "助手冒充用户锚点",
      }],
    }), "用户：另一句话\n助手：这句话只由助手说过", "另一句话", session())).toThrow("user turn");
  });

  it("rejects sensitive material in a model-proposed canonical key", () => {
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 明确决定采用这个方案，并说明了此前方案不再继续使用。",
        anchor: "采用这个方案",
        key: `token=${"s".repeat(24)}`,
      }],
    }), "用户：采用这个方案", "采用这个方案", session())).toThrow("sensitive material");
  });
});

describe("pivot-distill resume identity and CLI", () => {
  it("changes the stamp when content, prompt, or model changes", () => {
    const base = {
      harness: "codex" as const,
      rawHarness: "codex" as const,
      sessionId: "s1",
      date: "2026-08-02",
      sizeBytes: 100,
      mtimeNs: "1",
      promptVersion: "p1",
      model: "m1",
    };
    const fingerprint = sessionFingerprint(base);
    expect(sessionFingerprint({ ...base, sizeBytes: 101 })).not.toBe(fingerprint);
    expect(sessionFingerprint({ ...base, promptVersion: "p2" })).not.toBe(fingerprint);
    expect(sessionFingerprint({ ...base, model: "m2" })).not.toBe(fingerprint);
    expect(sessionFingerprint({ ...base, rawHarness: "antigravity" })).not.toBe(fingerprint);
    expect(sessionFingerprint({ ...base, date: "2026-08-03" })).not.toBe(fingerprint);
    expect(sessionFingerprint({ ...base, pipelineVersion: "pipeline-v2" })).not.toBe(fingerprint);
    expect(sessionFingerprint({ ...base, sampleSha256: "sample-v2" })).not.toBe(fingerprint);
  });

  it("excludes synthetic digest sessions without keyword-deciding pivots", () => {
    expect(isSyntheticSession({ path: "/private/tmp/session-digest-a/x.jsonl", project: "x" })).toBeTrue();
    expect(isSyntheticSession({ path: "/sessions/x.jsonl", project: "digest/a" })).toBeTrue();
    expect(isSyntheticSession({ path: "/sessions/x.jsonl", project: "recallnest" })).toBeFalse();
  });

  it("defaults to inventory and keeps run thresholds configurable", () => {
    const defaults = parseCliOptions([]);
    expect(defaults.mode).toBe("inventory");
    expect(defaults.minSize).toBe(100_000);
    const parsed = parseCliOptions(["--mode", "estimate", "--min-size", "200000", "--limit", "12"]);
    expect(parsed.mode).toBe("estimate");
    expect(parsed.minSize).toBe(200_000);
    expect(parsed.limit).toBe(12);
    expect(parseCliOptions(["--mode", "run", "--allow-external-llm"]).allowExternalLlm).toBeTrue();
  });

  it("rejects concurrent writers to the same output directory", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "pivot-distill-lock-"));
    const release = acquireOutputLock(outputDir);
    expect(() => acquireOutputLock(outputDir)).toThrow("already in use");
    release();
    const releaseAgain = acquireOutputLock(outputDir);
    releaseAgain();
  });
});
