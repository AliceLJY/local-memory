import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireOutputLock,
  aggregateDetailedUsage,
  agySessionIdFromPath,
  assertExternalModeAuthorization,
  assertPivotResponseMetadata,
  buildPivotRequestProfile,
  buildPivotLlmConfig,
  buildStratifiedSample,
  coalesceTurns,
  extractAgyUserText,
  extractTurnsFromRecord,
  filteredDejaEnvironment,
  FROZEN_BUNDLE_SCHEMA_VERSION,
  frozenSampleHash,
  geminiJsonTurns,
  harnessFamily,
  inventoryCompletenessReasons,
  isSyntheticSession,
  loadFrozenBundle,
  loadSessionInventory,
  main,
  OMISSION_MARKER,
  parseCliOptions,
  parserKindFor,
  redactedResidue,
  PIPELINE_VERSION,
  PIVOT_MODEL,
  pivotRequestProfileHash,
  PROMPT_VERSION,
  readSessionTurns,
  redactForExternalModel,
  retryDecision,
  resolveBundleSamplePath,
  resolveClaudeSessionPath,
  safeEndpoint,
  selectFrozenEntries,
  selectionIdentityHash,
  sessionFingerprint,
  stableSessionId,
  storedResultMatches,
  validateJudgeResponse,
  verifyCandidateEvidenceAgainstTurns,
  verifyCandidateEvidenceSourceFile,
  writeFrozenBundle,
  type FrozenBundleDescriptor,
  type SessionMeta,
} from "../../scripts/pivot-distill.js";
import { turnContentDigest } from "../pivot-evidence.js";

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
    fingerprint: "a".repeat(64),
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bundleIdentityHashForTest(input: {
  requestProfileHash: string;
  manifestSha256: string;
  sessions: number;
  eligibleSessions: number;
  deferredSessions: number;
}): string {
  return sha256(JSON.stringify({ schemaVersion: FROZEN_BUNDLE_SCHEMA_VERSION, ...input }));
}

function createBundleFixture(): {
  outputDir: string;
  bundleDir: string;
  descriptor: FrozenBundleDescriptor;
} {
  const outputDir = mkdtempSync(join(tmpdir(), "pivot-bundle-"));
  const source = join(outputDir, "source.jsonl");
  writeFileSync(source, "{}\n");
  const sourceStat = statSync(source, { bigint: true });
  const profile = buildPivotRequestProfile("https://example.invalid/compatible-mode/v1?ignored=1#fragment", 600);
  const profileHash = pivotRequestProfileHash(profile);
  const sample = buildStratifiedSample([
    { role: "user", text: "以后必须保留可回查证据" },
    { role: "assistant", text: "已记录这条规则" },
  ], 600);
  const descriptor = writeFrozenBundle(outputDir, [{
    session: session({
      path: source,
      sizeBytes: Number(sourceStat.size),
      mtimeNs: sourceStat.mtimeNs.toString(),
    }),
    sample,
  }], profile, profileHash);
  return { outputDir, bundleDir: join(outputDir, "input-bundle"), descriptor };
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

  it("keeps Claude sidechain turns out of main-session evidence", () => {
    expect(extractTurnsFromRecord({
      type: "assistant",
      isSidechain: true,
      message: { content: [{ type: "text", text: "subagent-only conclusion" }] },
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
    expect(extractTurnsFromRecord({
      type: "assistant",
      message: { role: "assistant", content: "旧 SQLite 转换后的回答" },
    }, "antigravity-jsonl")).toEqual([{
      role: "assistant",
      text: "旧 SQLite 转换后的回答",
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
    const sample = buildStratifiedSample(turns, 400);
    expect(sample.text.length).toBeLessThanOrEqual(400);
    expect(sample.text).toContain("turn-0-");
    expect(sample.text).toContain("turn-4-");
    expect(sample.text).toContain("turn-8-");
    expect(sample.sampledTurns).toBe(5);
    expect(sample.sampledExchanges).toBe(3);
    expect(sample.groundingTurns.map((turn) => turn.ordinal)).toEqual([0, 1, 4, 5, 8]);
  });

  it("redacts a secret before the per-turn cut", () => {
    const sample = buildStratifiedSample([{
      role: "user",
      text: `${"x".repeat(880)} sk-ant-api03-SECRETSECRETSECRET tail`,
    }], 2_000);
    expect(sample.text).toContain("[REDACTED:anthropic");
    expect(sample.text).not.toContain("sk-ant-");
  });

  it("keeps complete exchanges verbatim when the 24K-style cap is not reached", () => {
    const turns = [
      { role: "assistant" as const, text: "开头的 assistant-only 说明" },
      { role: "user" as const, text: "连续用户一" },
      { role: "user" as const, text: "连续用户二" },
      { role: "assistant" as const, text: "回答二之一" },
      { role: "assistant" as const, text: "回答二之二" },
      { role: "user" as const, text: "结尾尚未回答" },
    ];
    const sample = buildStratifiedSample(turns, 2_000);
    expect(sample.originalTurns).toBe(turns.length);
    expect(sample.sampledTurns).toBe(turns.length);
    expect(sample.exchanges).toBe(4);
    expect(sample.sampledExchanges).toBe(4);
    expect(sample.omittedTurns).toBe(0);
    expect(sample.text).toContain("助手：回答二之一\n助手：回答二之二");
    expect(sample.text).toEndWith("用户：结尾尚未回答");
  });

  it("preserves head, centered middle, and tail evidence in long user and assistant turns", () => {
    const user = `USER_HEAD_${"u".repeat(180)}_USER_MIDDLE_${"v".repeat(180)}_USER_TAIL`;
    const assistant = `ASSIST_HEAD_${"a".repeat(180)}_ASSIST_MIDDLE_${"b".repeat(180)}_ASSIST_TAIL`;
    const sample = buildStratifiedSample([
      { role: "user", text: user },
      { role: "assistant", text: assistant },
    ], 340);
    expect(sample.text.length).toBeLessThanOrEqual(340);
    expect(sample.text).toContain("USER_HEAD_");
    expect(sample.text).toContain("USER_MIDDLE_");
    expect(sample.text).toContain("USER_TAIL");
    expect(sample.text).toContain("ASSIST_HEAD_");
    expect(sample.text).toContain("ASSIST_MIDDLE_");
    expect(sample.text).toContain("ASSIST_TAIL");
    expect(sample.text).toContain(OMISSION_MARKER);
    expect(sample.roles.user.truncatedTurns).toBe(1);
    expect(sample.roles.assistant.truncatedTurns).toBe(1);
    expect(sample.coverageRatio).toBeGreaterThan(0);
    expect(sample.coverageRatio).toBeLessThan(1);
  });

  it("handles one-role sessions, multiple long turns, boundary rounding, and deterministic output", () => {
    const turns = Array.from({ length: 6 }, (_, index) => ({
      role: "user" as const,
      text: `USER-${index}-HEAD-${"x".repeat(180)}-MID-${index}-${"y".repeat(180)}-TAIL-${index}`,
    }));
    const first = buildStratifiedSample(turns, 420);
    const second = buildStratifiedSample(turns, 420);
    expect(second).toEqual(first);
    expect(first.text.length).toBeLessThanOrEqual(420);
    expect(first.roles.assistant.turns).toBe(0);
    expect(first.text).toContain("USER-0-HEAD");
    expect(first.text).toContain("TAIL-5");
    expect(first.sampledExchanges).toBeLessThan(turns.length);
  });

  it("rejects a cap too small for even one minimum exchange", () => {
    expect(() => buildStratifiedSample([{ role: "user", text: "x".repeat(200) }], 20))
      .toThrow("too small to preserve the required first/last exchanges");
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
    const sample = buildStratifiedSample([
      { role: "user", text: "这条路以后不要再走" },
      { role: "assistant", text: "已记录原因" },
    ], 500);
    const result = validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定不再采用旧路线，因为它会让同一数据形成两个真相源。",
        anchor: "这条路以后不要再走",
        key: "拒绝双真相源",
        evidence: ["已记录原因"],
      }],
    }), sample, session());
    expect(result.hasPivot).toBeTrue();
    expect(result.candidates[0].canonicalKey).toBe("pivot-decision-拒绝双真相源");
    expect(result.candidates[0].proposedScope).toBe("memory:pivot");
    expect(result.candidates[0].proposedCategory).toBe("events");
    expect(result.candidates[0].evidenceContractVersion).toBe(1);
    expect(result.candidates[0].sourceFingerprint).toBe(session().fingerprint);
    expect(result.candidates[0].anchorCoordinate).toMatchObject({
      sessionId: session().sessionId,
      ordinal: 0,
      role: "user",
    });
    expect(result.candidates[0].anchorCoordinate.contentDigest).toHaveLength(64);
    expect(result.candidates[0].evidenceWindows).toEqual([{
      sessionId: session().sessionId,
      startOrdinal: 1,
      endOrdinal: 1,
      turns: [{
        ordinal: 1,
        role: "assistant",
        contentDigest: expect.any(String),
        evidenceIndexes: [0],
      }],
    }]);
    expect(result.candidates[0].tags).toEqual([
      "src:019fc307",
      "date:2026-08-02",
      "harness:codex",
      "raw:codex",
    ]);
  });

  it("uses deterministic host digests and keeps non-contiguous evidence in separate windows", () => {
    const turns = [
      { role: "user" as const, text: "部署时出现连接失败" },
      { role: "assistant" as const, text: "先修正配置文件" },
      { role: "user" as const, text: "中间讨论了另一个问题" },
      { role: "assistant" as const, text: "这段与解法无关" },
      { role: "assistant" as const, text: "最终验证服务恢复" },
    ];
    const sample = buildStratifiedSample(turns, 1_000);
    const candidate = validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "case",
        text: "部署连接失败的问题通过修正配置，并在最后验证服务恢复后得到解决。",
        anchor: "部署时出现连接失败",
        key: "部署连接修复",
        evidence: ["先修正配置文件", "最终验证服务恢复"],
      }],
    }), sample, session()).candidates[0];

    expect(candidate.evidenceWindows.map((window) => [window.startOrdinal, window.endOrdinal]))
      .toEqual([[1, 1], [4, 4]]);
    expect(candidate.anchorCoordinate.contentDigest).toBe(turnContentDigest({
      sessionId: session().sessionId,
      ordinal: 0,
      role: "user",
      text: turns[0].text,
    }));
    expect(turnContentDigest({
      sessionId: session().sessionId,
      ordinal: 0,
      role: "user",
      text: turns[0].text,
    })).toBe(turnContentDigest({
      sessionId: session().sessionId,
      ordinal: 0,
      role: "user",
      text: turns[0].text,
    }));
    expect(turnContentDigest({
      sessionId: session().sessionId,
      ordinal: 0,
      role: "user",
      text: `${turns[0].text}（已修改）`,
    })).not.toBe(candidate.anchorCoordinate.contentDigest);

    expect(() => verifyCandidateEvidenceAgainstTurns(candidate, session(), turns)).not.toThrow();
    const edited = turns.map((turn) => ({ ...turn }));
    edited[4].text = "最终验证仍未恢复";
    expect(() => verifyCandidateEvidenceAgainstTurns(candidate, session(), edited))
      .toThrow("content digest changed");
  });

  it("fails closed when the same quote maps to multiple turn ordinals", () => {
    const sample = buildStratifiedSample([
      { role: "user", text: "采用这个方案" },
      { role: "assistant", text: "验证已经完成" },
      { role: "user", text: "再核对一次" },
      { role: "assistant", text: "验证已经完成" },
    ], 500);
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定采用已经完成验证的方案，并保留可追溯的验证依据。",
        anchor: "采用这个方案",
        key: "采用已验证方案",
        evidence: ["验证已经完成"],
      }],
    }), sample, session())).toThrow("ambiguous across sampled turn ordinals");
  });

  it("rejects model-supplied coordinate fields instead of trusting them", () => {
    const sample = buildStratifiedSample([
      { role: "user", text: "采用这个方案" },
      { role: "assistant", text: "验证已经完成" },
    ], 500);
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定采用已经完成验证的方案，并保留可追溯的验证依据。",
        anchor: "采用这个方案",
        key: "采用已验证方案",
        evidence: ["验证已经完成"],
        evidenceWindows: [{ startOrdinal: 999, endOrdinal: 999 }],
      }],
    }), sample, session())).toThrow("unsupported properties");
  });

  it("redactedResidue ignores placeholder shapes but catches real residue", () => {
    // A placeholder's own word shape must not re-match the assignment rule.
    expect(redactedResidue("session_id='[REDACTED:sensitive_assignment]'")).toBe(0);
    // Placeholder junction with surviving context must not re-match email/uri.
    expect(redactedResidue("clone https://[REDACTED:uri_credentials]@gitlab.com/user/repo.git")).toBe(0);
    // Genuine residue outside placeholders still counts.
    expect(redactedResidue("[REDACTED:email] and mail me at someone@example.com")).toBeGreaterThan(0);
  });

  it("grounds anchors and evidence that copy the rendered role labels", () => {
    const sample = buildStratifiedSample([
      { role: "user", text: "这条路以后不要再走" },
      { role: "assistant", text: "已记录原因" },
    ], 500);
    const result = validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定不再采用旧路线，因为它会让同一数据形成两个真相源。",
        anchor: "用户：这条路以后不要再走",
        key: "拒绝双真相源",
        evidence: ["助手：已记录原因"],
      }],
    }), sample, session());
    expect(result.hasPivot).toBeTrue();
    expect(result.candidates[0].anchor).toBe("这条路以后不要再走");
    expect(result.candidates[0].evidence).toEqual(["已记录原因"]);
  });

  it("rejects evidence that is only a bare role label", () => {
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定不再采用旧路线，因为它会让同一数据形成两个真相源。",
        anchor: "这条路以后不要再走",
        key: "拒绝双真相源",
        evidence: ["助手："],
      }],
    }), buildStratifiedSample([
      { role: "user", text: "这条路以后不要再走" },
      { role: "assistant", text: "已记录原因" },
    ], 500), session())).toThrow("substantive");
  });

  it("keeps verbatim evidence and drops a paraphrased quote without voiding the candidate", () => {
    const sample = buildStratifiedSample([
      { role: "user", text: "这条路以后不要再走" },
      { role: "assistant", text: "已记录原因" },
    ], 500);
    const result = validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定不再采用旧路线，因为它会让同一数据形成两个真相源。",
        anchor: "这条路以后不要再走",
        key: "拒绝双真相源",
        evidence: ["已记录原因", "助手当时总结说旧路线会造成双真相源问题"],
      }],
    }), sample, session());
    expect(result.candidates[0].evidence).toEqual(["已记录原因"]);
  });

  it("drops a candidate whose stored form degrades below read-back rules", () => {
    // "助手：好" passes raw substantive checks but stores as a single char
    // after label stripping — the stored-form gate must reject it, and with
    // no surviving candidate the response fails as a whole.
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定不再采用旧路线，因为它会让同一数据形成两个真相源。",
        anchor: "这条路以后不要再走",
        key: "拒绝双真相源",
        evidence: ["助手：好"],
      }],
    }), buildStratifiedSample([
      { role: "user", text: "这条路以后不要再走" },
      { role: "assistant", text: "好" },
    ], 500), session())).toThrow("requires at least one valid candidate");
  });

  it("rejects a candidate when no evidence survives grounding", () => {
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定不再采用旧路线，因为它会让同一数据形成两个真相源。",
        anchor: "这条路以后不要再走",
        key: "拒绝双真相源",
        evidence: ["助手当时总结说旧路线会造成双真相源问题"],
      }],
    }), buildStratifiedSample([
      { role: "user", text: "这条路以后不要再走" },
      { role: "assistant", text: "已记录原因" },
    ], 500), session())).toThrow("requires at least one grounded");
  });

  it("rejects a case that drops below two grounded evidence quotes", () => {
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "case",
        text: "记录了一次问题的解决过程，包含问题定位与验证后的修复方案说明。",
        anchor: "这条路以后不要再走",
        key: "示例案例",
        evidence: ["已记录原因", "这句在输入里根本不存在的概括描述"],
      }],
    }), buildStratifiedSample([
      { role: "user", text: "这条路以后不要再走" },
      { role: "assistant", text: "已记录原因" },
    ], 500), session())).toThrow("requires at least two grounded");
  });

  it("keeps valid candidates when a sibling candidate fails validation", () => {
    const sample = buildStratifiedSample([
      { role: "user", text: "这条路以后不要再走" },
      { role: "assistant", text: "已记录原因" },
    ], 500);
    const result = validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [
        {
          kind: "decision",
          text: "Alice 决定不再采用旧路线，因为它会让同一数据形成两个真相源。",
          anchor: "这条路以后不要再走",
          key: "拒绝双真相源",
          evidence: ["已记录原因"],
        },
        {
          kind: "case",
          text: "记录了一次问题的解决过程，包含问题定位与验证后的修复方案说明。",
          anchor: "输入里不存在的锚点句子",
          key: "不合格案例",
          evidence: ["已记录原因", "这句也不存在于输入之中"],
        },
      ],
    }), sample, session());
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].canonicalKey).toBe("pivot-decision-拒绝双真相源");
  });

  it("still fails when no candidate survives validation", () => {
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定不再采用旧路线，因为它会让同一数据形成两个真相源。",
        anchor: "输入里不存在的锚点句子",
        key: "拒绝双真相源",
        evidence: ["已记录原因"],
      }],
    }), buildStratifiedSample([
      { role: "user", text: "这条路以后不要再走" },
      { role: "assistant", text: "已记录原因" },
    ], 500), session())).toThrow("requires at least one valid candidate");
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
    }), buildStratifiedSample([{ role: "user", text: "请保留出处" }], 500), session())).toThrow("not grounded");
    expect(() => validateJudgeResponse(
      JSON.stringify({ hasPivot: true, candidates: [] }),
      buildStratifiedSample([{ role: "user", text: "请保留出处" }], 500),
      session(),
    )).toThrow("requires at least one");
  });

  it("enforces evidence counts by pivot kind and forbids quoting omission markers", () => {
    const base = {
      text: "Alice 明确改变了既有判断，并给出了可以回查的真实原因与结果。",
      anchor: "我改主意了",
      key: "改变判断",
    };
    const sample = buildStratifiedSample([
      { role: "user", text: "我改主意了" },
      { role: "assistant", text: "旧判断失效" },
      { role: "assistant", text: "新方案已经验证" },
    ], 500);
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{ kind: "judgment_shift", ...base, evidence: [] }],
    }), sample, session())).toThrow("at least one");
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{ kind: "case", ...base, evidence: ["旧判断失效"] }],
    }), sample, session())).toThrow("at least two");
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{ kind: "decision", ...base, evidence: Array.from({ length: 17 }, () => "旧判断失效") }],
    }), sample, session())).toThrow("at most 16");
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{ kind: "preference_rule", ...base, anchor: `我改${OMISSION_MARKER}主意了`, evidence: [] }],
    }), buildStratifiedSample([{ role: "user", text: `我改${OMISSION_MARKER}主意了` }], 500), session()))
      .toThrow("omission marker");
  });

  it("requires distinct substantive evidence grounded within individual turns", () => {
    const sample = buildStratifiedSample([
      { role: "user", text: "部署时出现连接失败" },
      { role: "assistant", text: "先修配置文件" },
      { role: "assistant", text: "之后验证服务恢复" },
    ], 500);
    const candidate = {
      kind: "case",
      text: "部署连接失败的问题通过修正配置并验证服务恢复得到了解决。",
      anchor: "部署时出现连接失败",
      key: "部署连接修复",
    };
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{ ...candidate, evidence: ["助手：", "助手："] }],
    }), sample, session())).toThrow(/distinct|substantive/);
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{ ...candidate, evidence: ["连接失败先修配置文件", "之后验证服务恢复"] }],
    }), sample, session())).toThrow("requires at least two grounded");
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
    }), buildStratifiedSample([
      { role: "user", text: "另一句话" },
      { role: "assistant", text: "这句话只由助手说过" },
    ], 500), session())).toThrow("user turn");
  });

  it("rejects sensitive material in a model-proposed canonical key", () => {
    expect(() => validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 明确决定采用这个方案，并说明了此前方案不再继续使用。",
        anchor: "采用这个方案",
        key: `token=${"s".repeat(24)}`,
        evidence: ["采用这个方案"],
      }],
    }), buildStratifiedSample([{ role: "user", text: "采用这个方案" }], 500), session()))
      .toThrow("sensitive material");
  });

  it("round-trips all four validated pivot kinds through strict stored-result checks", () => {
    const fixture = createBundleFixture();
    const loaded = loadFrozenBundle(
      fixture.bundleDir,
      fixture.descriptor.bundleHash,
      fixture.descriptor.requestProfileHash,
    );
    const entry = loaded.entries[0];
    const selectionHash = selectionIdentityHash("transport", [entry]);
    const evidenceByKind = {
      judgment_shift: ["已记录这条规则"],
      decision: ["已记录这条规则"],
      preference_rule: [],
      case: ["以后必须保留可回查证据", "已记录这条规则"],
    } as const;
    for (const kind of ["judgment_shift", "decision", "preference_rule", "case"] as const) {
      const judged = validateJudgeResponse(JSON.stringify({
        hasPivot: true,
        candidates: [{
          kind,
          text: "用户明确要求以后必须保留可回查证据，最终结果需要能够追溯到真实出处。",
          anchor: "以后必须保留可回查证据",
          key: `round-trip-${kind}`,
          evidence: evidenceByKind[kind],
        }],
      }), entry.sample, entry.session);
      const storedResult = {
        schemaVersion: 1,
        mode: "transport",
        selectionHash,
        outboundSampleSha256: entry.sampleSha256,
        promptVersion: PROMPT_VERSION,
        pipelineVersion: PIPELINE_VERSION,
        model: PIVOT_MODEL,
        requestProfileHash: fixture.descriptor.requestProfileHash,
        bundleHash: fixture.descriptor.bundleHash,
        session: entry.session,
        status: "ok",
        hasPivot: true,
        candidates: judged.candidates,
        sample: entry.sample.metrics,
        responseChars: 100,
        attempts: 1,
        responseModel: PIVOT_MODEL,
        finishReason: "stop",
        completedAt: "2026-08-03T00:00:00.000Z",
      };
      expect(storedResultMatches(
        storedResult, entry, "transport", selectionHash, PIVOT_MODEL, fixture.descriptor.bundleHash,
        fixture.descriptor.requestProfileHash, 3,
      )).toBeTrue();
      if (kind === "decision") {
        expect(storedResultMatches(
          { ...storedResult, session: { ...entry.session, date: "2026-08-04" } },
          entry, "transport", selectionHash, PIVOT_MODEL, fixture.descriptor.bundleHash,
          fixture.descriptor.requestProfileHash, 3,
        )).toBeFalse();
        expect(storedResultMatches(
          {
            ...storedResult,
            candidates: [{ ...judged.candidates[0], unexpected: "must-not-pass-through" }],
          },
          entry, "transport", selectionHash, PIVOT_MODEL, fixture.descriptor.bundleHash,
          fixture.descriptor.requestProfileHash, 3,
        )).toBeFalse();
      }
    }
  });
});

describe("pivot-distill request identity and frozen bundle", () => {
  it("builds a credential-free fixed-model request profile whose hash covers every request choice", () => {
    const endpoint = safeEndpoint("https://user:password@example.invalid//compatible-mode/v1/?token=secret#fragment");
    expect(endpoint).toBe("https://example.invalid/compatible-mode/v1");
    expect(endpoint).not.toContain("password");
    expect(endpoint).not.toContain("token=");
    const profile = buildPivotRequestProfile(
      "https://user:password@example.invalid/compatible-mode/v1?token=secret#fragment",
      24_000,
    );
    expect(profile.model).toBe(PIVOT_MODEL);
    expect(profile.enableThinking).toBeFalse();
    expect(profile.responseFormat).toEqual({ type: "json_object" });
    expect(profile.tokenLimit).toEqual({ parameter: "max_tokens", value: 1_800 });
    expect(profile.retryPolicy).toEqual({
      maxSessionAttempts: 3,
      sdkMaxRetries: 0,
      backoffMs: [250, 500],
      maxRetryAfterMs: 5_000,
      retryableHttpStatuses: [408, 409, 429],
      retryableServerErrorRange: "500-599",
    });
    expect(profile.promptHashes.system).toHaveLength(64);
    expect(profile.promptHashes.userTemplate).toHaveLength(64);
    expect(profile.promptHashes.jsonSchema).toHaveLength(64);
    const identity = pivotRequestProfileHash(profile);
    expect(pivotRequestProfileHash({ ...profile, temperature: 0.2 })).not.toBe(identity);
    expect(pivotRequestProfileHash({
      ...profile,
      sampling: { ...profile.sampling, omissionMarker: "different" },
    })).not.toBe(identity);
    expect(pivotRequestProfileHash({
      ...profile,
      retryPolicy: { ...profile.retryPolicy, sdkMaxRetries: 1 },
    })).not.toBe(identity);
    expect(buildPivotLlmConfig({
      apiKey: "test-key",
      model: "qwen-turbo",
      baseURL: "https://user:secret@example.invalid/v1?token=hidden#fragment",
    }, profile, 12_345)).toMatchObject({
      baseURL: "https://example.invalid/compatible-mode/v1",
      model: PIVOT_MODEL,
      maxRetries: 0,
      timeoutMs: 12_345,
    });
  });

  it("keeps retry cost bounded and aggregates usage from every billed attempt", () => {
    const policy = buildPivotRequestProfile("https://example.invalid/v1").retryPolicy;
    expect(retryDecision({ status: 429, headers: { "retry-after": "0.01" } }, 1, policy))
      .toEqual({ retry: true, delayMs: 10 });
    expect(retryDecision({ status: 500 }, 2, policy)).toEqual({ retry: true, delayMs: 500 });
    expect(retryDecision({ status: 401 }, 1, policy)).toEqual({ retry: false, delayMs: 0 });
    expect(retryDecision({ status: 429 }, 3, policy)).toEqual({ retry: false, delayMs: 0 });
    expect(aggregateDetailedUsage([
      { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      { promptTokens: 11, completionTokens: 3, totalTokens: 14, cachedPromptTokens: 4 },
    ])).toEqual({
      promptTokens: 21,
      completionTokens: 5,
      totalTokens: 26,
      cachedPromptTokens: 4,
    });
  });

  it("makes the external stage and exact outbound sample set part of report identity", () => {
    const fixture = createBundleFixture();
    const loaded = loadFrozenBundle(
      fixture.bundleDir, fixture.descriptor.bundleHash, fixture.descriptor.requestProfileHash,
    );
    expect(selectionIdentityHash("transport", loaded.entries))
      .not.toBe(selectionIdentityHash("regression", loaded.entries));
    const changed = structuredClone(loaded.entries);
    changed[0].sampleSha256 = "f".repeat(64);
    expect(selectionIdentityHash("transport", changed))
      .not.toBe(selectionIdentityHash("transport", loaded.entries));
  });

  it("writes 0700/0600 bundles and reloads only exact expected identities", () => {
    const fixture = createBundleFixture();
    expect(statSync(fixture.bundleDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(fixture.bundleDir, "bundle.json")).mode & 0o777).toBe(0o600);
    const loaded = loadFrozenBundle(
      fixture.bundleDir,
      fixture.descriptor.bundleHash,
      fixture.descriptor.requestProfileHash,
    );
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0].status).toBe("eligible");
    expect(loaded.entries[0].sample.schemaVersion).toBe(FROZEN_BUNDLE_SCHEMA_VERSION);
    expect(loaded.entries[0].sample.groundingTurns[0]).toMatchObject({ ordinal: 0, role: "user" });
    expect(loaded.entries[0].sample.groundingTurns[0].contentDigest).toHaveLength(64);
    expect("sourceText" in loaded.entries[0].sample.groundingTurns[0]).toBeFalse();
    expect(frozenSampleHash(loaded.entries[0].sample)).toBe(loaded.entries[0].sampleSha256);
    expect(() => loadFrozenBundle(
      fixture.bundleDir,
      "wrong-bundle",
      fixture.descriptor.requestProfileHash,
    )).toThrow("unexpected bundleHash");
    expect(() => loadFrozenBundle(
      fixture.bundleDir,
      fixture.descriptor.bundleHash,
      "wrong-profile",
    )).toThrow("unexpected requestProfileHash");
  });

  it("rejects legacy frozen bundles instead of reinterpreting them with coordinate semantics", () => {
    const fixture = createBundleFixture();
    const descriptor = JSON.parse(
      readFileSync(join(fixture.bundleDir, "bundle.json"), "utf8"),
    ) as Record<string, unknown>;
    descriptor.schemaVersion = 1;
    writeFileSync(join(fixture.bundleDir, "bundle.json"), `${JSON.stringify(descriptor)}\n`);
    expect(() => loadFrozenBundle(
      fixture.bundleDir,
      fixture.descriptor.bundleHash,
      fixture.descriptor.requestProfileHash,
    )).toThrow("must be re-estimated");
  });

  it("rejects mutated samples, duplicate session keys, and paths outside the bundle root", () => {
    const mutated = createBundleFixture();
    const manifestEntry = JSON.parse(readFileSync(join(mutated.bundleDir, "manifest.jsonl"), "utf8")) as {
      sampleFile: string;
    };
    const samplePath = join(mutated.bundleDir, manifestEntry.sampleFile);
    const sample = JSON.parse(readFileSync(samplePath, "utf8")) as Record<string, unknown>;
    sample.text = `X${String(sample.text).slice(1)}`;
    writeFileSync(samplePath, `${JSON.stringify(sample)}\n`);
    expect(() => loadFrozenBundle(
      mutated.bundleDir,
      mutated.descriptor.bundleHash,
      mutated.descriptor.requestProfileHash,
    )).toThrow("sample grounding projection mismatch");

    const mutatedMetrics = createBundleFixture();
    const metricsEntry = JSON.parse(
      readFileSync(join(mutatedMetrics.bundleDir, "manifest.jsonl"), "utf8"),
    ) as { sampleFile: string };
    const metricsPath = join(mutatedMetrics.bundleDir, metricsEntry.sampleFile);
    const metricsSample = JSON.parse(readFileSync(metricsPath, "utf8")) as {
      metrics: { redactions: number };
    };
    metricsSample.metrics.redactions += 1;
    writeFileSync(metricsPath, `${JSON.stringify(metricsSample)}\n`);
    expect(() => loadFrozenBundle(
      mutatedMetrics.bundleDir,
      mutatedMetrics.descriptor.bundleHash,
      mutatedMetrics.descriptor.requestProfileHash,
    )).toThrow("sample hash mismatch");

    const duplicate = createBundleFixture();
    const originalLine = readFileSync(join(duplicate.bundleDir, "manifest.jsonl"), "utf8").trim();
    const duplicatedManifest = `${originalLine}\n${originalLine}\n`;
    const descriptor = JSON.parse(readFileSync(join(duplicate.bundleDir, "bundle.json"), "utf8")) as FrozenBundleDescriptor;
    descriptor.manifestSha256 = sha256(duplicatedManifest);
    descriptor.sessions = 2;
    descriptor.eligibleSessions = 2;
    descriptor.deferredSessions = 0;
    descriptor.bundleHash = bundleIdentityHashForTest({
      requestProfileHash: descriptor.requestProfileHash,
      manifestSha256: descriptor.manifestSha256,
      sessions: descriptor.sessions,
      eligibleSessions: descriptor.eligibleSessions,
      deferredSessions: descriptor.deferredSessions,
    });
    writeFileSync(join(duplicate.bundleDir, "manifest.jsonl"), duplicatedManifest);
    writeFileSync(join(duplicate.bundleDir, "bundle.json"), `${JSON.stringify(descriptor)}\n`);
    expect(() => loadFrozenBundle(
      duplicate.bundleDir,
      descriptor.bundleHash,
      descriptor.requestProfileHash,
    )).toThrow("duplicate session key");

    expect(() => resolveBundleSamplePath(duplicate.bundleDir, "/tmp/outside.json"))
      .toThrow("must stay relative");
    expect(() => resolveBundleSamplePath(duplicate.bundleDir, "samples/../../outside.json"))
      .toThrow("must stay relative");
  });

  it("rejects a request profile that no longer matches the fixed prompt/body/sampling contract", () => {
    const fixture = createBundleFixture();
    const descriptor = JSON.parse(readFileSync(join(fixture.bundleDir, "bundle.json"), "utf8")) as FrozenBundleDescriptor;
    descriptor.requestProfile.temperature = 0.7;
    writeFileSync(join(fixture.bundleDir, "bundle.json"), `${JSON.stringify(descriptor)}\n`);
    expect(() => loadFrozenBundle(
      fixture.bundleDir,
      fixture.descriptor.bundleHash,
      fixture.descriptor.requestProfileHash,
    )).toThrow("current fixed pivot contract");
  });

  it("rejects duplicate keys before bundle creation and keeps assistant-only sessions deferred", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "pivot-bundle-duplicate-"));
    const profile = buildPivotRequestProfile("https://example.invalid/v1", 500);
    const profileHash = pivotRequestProfileHash(profile);
    const userSample = buildStratifiedSample([{ role: "user", text: "保留证据" }], 500);
    expect(() => writeFrozenBundle(outputDir, [
      { session: session(), sample: userSample },
      { session: session(), sample: userSample },
    ], profile, profileHash)).toThrow("duplicate session key");

    const assistantOnlyDir = mkdtempSync(join(tmpdir(), "pivot-bundle-deferred-"));
    const assistantOnly = buildStratifiedSample([{ role: "assistant", text: "只有助手内容" }], 500);
    const descriptor = writeFrozenBundle(assistantOnlyDir, [{ session: session(), sample: assistantOnly }], profile, profileHash);
    const loaded = loadFrozenBundle(join(assistantOnlyDir, "input-bundle"), descriptor.bundleHash, descriptor.requestProfileHash);
    expect(loaded.entries[0].status).toBe("deferred");
    expect(loaded.entries[0].reason).toBe("no-parseable-user-text");
  });
});

describe("pivot-distill source enumeration and parse integrity", () => {
  it("filters inherited DEJA variables from both inventory subprocesses", () => {
    expect(filteredDejaEnvironment({ DEJA_HOME: "/wrong", DEJA_CONFIG: "/wrong/config", KEEP_ME: "yes" }))
      .toEqual({ KEEP_ME: "yes" });
  });

  it("enumerates four endpoint families plus Claude Desktop and both AGY origins with a fake Deja", () => {
    const root = mkdtempSync(join(tmpdir(), "pivot-inventory-"));
    const sourceRoot = join(root, "sources");
    mkdirSync(sourceRoot, { recursive: true });
    const dejaSessions = ([
      ["claude", "claude.jsonl"],
      ["codex", "codex.jsonl"],
      ["kimi", "kimi.jsonl"],
      ["gemini", "gemini.json"],
    ] as const).map(([harness, name], index) => {
      const path = join(sourceRoot, name);
      writeFileSync(path, harness === "gemini" ? "{\"messages\":[]}" : "{}\n");
      return { id: `deja-${index}-${harness}`, harness, path, project: "test" };
    });
    const codexArchiveRoot = join(root, "codex-archive");
    const claudeDesktopRoot = join(root, "desktop");
    const agyConvertedRoot = join(root, "agy", "brain", "session-one", ".system_generated", "logs");
    const agyArchiveRoot = join(root, "agy-archive");
    for (const directory of [codexArchiveRoot, claudeDesktopRoot, agyConvertedRoot, agyArchiveRoot]) {
      mkdirSync(directory, { recursive: true });
    }
    writeFileSync(join(codexArchiveRoot, "archive.jsonl"), "{}\n");
    writeFileSync(join(claudeDesktopRoot, "desktop.jsonl"), "{}\n");
    writeFileSync(join(agyConvertedRoot, "transcript_full.jsonl"), "{}\n");
    writeFileSync(join(agyArchiveRoot, "legacy.jsonl"), "{}\n");
    const payload = JSON.stringify({ schema_version: 2, sessions: dejaSessions });
    const dejaBin = join(root, "fake-deja.ts");
    writeFileSync(dejaBin, `#!/usr/bin/env bun
if (process.env.DEJA_HOME || process.env.DEJA_CONFIG) process.exit(91);
if (process.argv[2] === "version") console.log("deja 0.16.5");
else console.log(${JSON.stringify(payload)});
`);
    chmodSync(dejaBin, 0o700);
    const options = parseCliOptions([
      "--deja-bin", dejaBin,
      "--codex-archive-root", codexArchiveRoot,
      "--claude-desktop-root", claudeDesktopRoot,
      "--agy-converted-root", join(root, "agy"),
      "--agy-archive-root", agyArchiveRoot,
    ]);
    const previousDejaHome = process.env.DEJA_HOME;
    const previousDejaConfig = process.env.DEJA_CONFIG;
    process.env.DEJA_HOME = "/must-not-reach-child";
    process.env.DEJA_CONFIG = "/must-not-reach-child/config";
    try {
      const loaded = loadSessionInventory(options);
      expect(loaded.missingPaths).toBe(0);
      expect(new Set(loaded.sessions.map((item) => item.harness))).toEqual(new Set(["claude-code", "codex", "kimi", "agy"]));
      expect(loaded.sessions.some((item) => item.origin === "claude-desktop")).toBeTrue();
      expect(loaded.sessions.some((item) => item.origin === "agy-converted")).toBeTrue();
      expect(loaded.sessions.some((item) => item.origin === "agy-archive")).toBeTrue();
      expect(loaded.sessions.some((item) => item.rawHarness === "gemini")).toBeTrue();
      expect(inventoryCompletenessReasons(loaded.sessions, loaded.missingPaths)).toEqual([]);
      expect(inventoryCompletenessReasons(
        loaded.sessions.filter((item) => item.origin !== "claude-desktop"), 0,
      )).toContain("origin=claude-desktop has zero sessions");
      expect(inventoryCompletenessReasons(
        loaded.sessions.filter((item) => item.rawHarness !== "gemini"), 0,
      )).toContain("rawHarness=gemini has zero sessions");
      expect(inventoryCompletenessReasons(loaded.sessions, 1)).toContain("missingPaths=1");
    } finally {
      if (previousDejaHome === undefined) delete process.env.DEJA_HOME;
      else process.env.DEJA_HOME = previousDejaHome;
      if (previousDejaConfig === undefined) delete process.env.DEJA_CONFIG;
      else process.env.DEJA_CONFIG = previousDejaConfig;
    }
  });

  it("treats malformed JSONL as a bundle-blocking parse failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "pivot-malformed-"));
    const path = join(root, "bad.jsonl");
    writeFileSync(path, "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"ok\"}}\nnot-json\n");
    await expect(readSessionTurns(session({ path, parserKind: "codex-rollout" })))
      .rejects.toThrow("Malformed JSONL at line 2");
  });

  it("re-reads the reviewed source before apply and rejects later file drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "pivot-source-recheck-"));
    const path = join(root, "source.jsonl");
    writeFileSync(path, [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "采用这个方案" } }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "验证已经完成" }] },
      }),
    ].join("\n") + "\n");
    const sourceStat = statSync(path, { bigint: true });
    const sourceSession = session({
      path,
      sizeBytes: Number(sourceStat.size),
      mtimeNs: sourceStat.mtimeNs.toString(),
      fingerprint: "b".repeat(64),
    });
    const turns = await readSessionTurns(sourceSession);
    const candidate = validateJudgeResponse(JSON.stringify({
      hasPivot: true,
      candidates: [{
        kind: "decision",
        text: "Alice 决定采用已经完成验证的方案，并保留可追溯的验证依据。",
        anchor: "采用这个方案",
        key: "采用已验证方案",
        evidence: ["验证已经完成"],
      }],
    }), buildStratifiedSample(turns, 500), sourceSession).candidates[0];

    await expect(verifyCandidateEvidenceSourceFile(candidate, sourceSession)).resolves.toBeUndefined();
    writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
    await expect(verifyCandidateEvidenceSourceFile(candidate, sourceSession))
      .rejects.toThrow("source session stat changed");
  });
});

describe("pivot-distill external authorization and exact selection", () => {
  const common = [
    "--input-bundle", "/tmp/frozen",
    "--bundle-hash", "bundle-hash",
    "--request-profile-hash", "profile-hash",
    "--allow-external-llm",
  ];

  it("requires exact transport, separate regression, and dual full authorization", () => {
    expect(() => assertExternalModeAuthorization(parseCliOptions([
      "--mode", "transport", ...common,
    ]))).toThrow("exactly one");
    expect(() => assertExternalModeAuthorization(parseCliOptions([
      "--mode", "transport", ...common, "--session-key", "codex:one",
    ]))).not.toThrow();
    expect(() => assertExternalModeAuthorization(parseCliOptions([
      "--mode", "transport", ...common,
      "--session-key", "codex:one",
      "--output-dir", "/tmp/frozen/results",
    ]))).toThrow("must not be the frozen input bundle");
    expect(() => assertExternalModeAuthorization(parseCliOptions([
      "--mode", "regression", ...common, "--session-key", "codex:one",
    ]))).toThrow("allow-regression-run");
    expect(() => assertExternalModeAuthorization(parseCliOptions([
      "--mode", "regression", ...common, "--session-key", "codex:one", "--allow-regression-run",
    ]))).not.toThrow();
    expect(() => assertExternalModeAuthorization(parseCliOptions([
      "--mode", "full", ...common,
    ]))).toThrow("allow-full-run");
    expect(() => assertExternalModeAuthorization(parseCliOptions([
      "--mode", "full", ...common, "--allow-full-run",
    ]))).not.toThrow();
  });

  it("rejects truncated or wrong-model responses even if their content could parse", () => {
    expect(() => assertPivotResponseMetadata({ finishReason: "length", responseModel: PIVOT_MODEL }))
      .toThrow("finish_reason=length");
    expect(() => assertPivotResponseMetadata({ finishReason: "stop", responseModel: "rolling-alias" }))
      .toThrow("response model mismatch");
    expect(() => assertPivotResponseMetadata({ finishReason: "stop", responseModel: PIVOT_MODEL }))
      .not.toThrow();
  });

  it("refuses transport before any live inventory branch when authorization is missing", async () => {
    await expect(main([
      "--mode", "transport",
      "--deja-bin", "/definitely/not/a/deja/binary",
      "--output-dir", join(tmpdir(), "must-not-be-created-by-unauthorized-transport"),
    ])).rejects.toThrow("--allow-external-llm");
  });

  it("selects one exact frozen key while full selects every eligible sample", () => {
    const fixture = createBundleFixture();
    const loaded = loadFrozenBundle(
      fixture.bundleDir,
      fixture.descriptor.bundleHash,
      fixture.descriptor.requestProfileHash,
    );
    const transport = parseCliOptions([
      "--mode", "transport",
      "--input-bundle", fixture.bundleDir,
      "--bundle-hash", fixture.descriptor.bundleHash,
      "--request-profile-hash", fixture.descriptor.requestProfileHash,
      "--session-key", loaded.entries[0].session.key,
      "--allow-external-llm",
    ]);
    expect(selectFrozenEntries(loaded, transport).map((entry) => entry.session.key))
      .toEqual([loaded.entries[0].session.key]);
    const full = parseCliOptions([
      "--mode", "full",
      "--input-bundle", fixture.bundleDir,
      "--bundle-hash", fixture.descriptor.bundleHash,
      "--request-profile-hash", fixture.descriptor.requestProfileHash,
      "--allow-external-llm",
      "--allow-full-run",
    ]);
    expect(selectFrozenEntries(loaded, full)).toHaveLength(fixture.descriptor.eligibleSessions);
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
    expect(sessionFingerprint({ ...base, requestProfileHash: "profile-v2" })).not.toBe(fingerprint);
  });

  it("excludes synthetic digest sessions without keyword-deciding pivots", () => {
    expect(isSyntheticSession({ path: "/private/tmp/session-digest-a/x.jsonl", project: "x" })).toBeTrue();
    expect(isSyntheticSession({ path: "/sessions/x.jsonl", project: "digest/a" })).toBeTrue();
    expect(isSyntheticSession({ path: "/sessions/x.jsonl", project: "recallnest" })).toBeFalse();
  });

  it("defaults to all non-synthetic sessions and parses frozen execution selectors", () => {
    const defaults = parseCliOptions([]);
    expect(defaults.mode).toBe("inventory");
    expect(defaults.minSize).toBe(1);
    const parsed = parseCliOptions([
      "--mode", "estimate",
      "--min-size", "200000",
      "--limit", "12",
      "--claude-desktop-root", "/tmp/desktop-import",
      "--agy-archive-root", "/tmp/agy-archive",
    ]);
    expect(parsed.mode).toBe("estimate");
    expect(parsed.minSize).toBe(200_000);
    expect(parsed.limit).toBe(12);
    expect(parsed.claudeDesktopRoot).toBe("/tmp/desktop-import");
    expect(parsed.agyArchiveRoot).toBe("/tmp/agy-archive");
    const transport = parseCliOptions([
      "--mode", "transport",
      "--input-bundle", "/tmp/bundle",
      "--bundle-hash", "bundle",
      "--request-profile-hash", "profile",
      "--session-key", "codex:one",
      "--allow-external-llm",
    ]);
    expect(transport.mode).toBe("transport");
    expect(transport.sessionKeys).toEqual(["codex:one"]);
    expect(transport.allowExternalLlm).toBeTrue();
  });

  it("rejects concurrent writers to the same output directory", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "pivot-distill-lock-"));
    chmodSync(outputDir, 0o755);
    const release = acquireOutputLock(outputDir);
    expect(statSync(outputDir).mode & 0o777).toBe(0o700);
    expect(() => acquireOutputLock(outputDir)).toThrow("already in use");
    release();
    const releaseAgain = acquireOutputLock(outputDir);
    releaseAgain();
  });
});
