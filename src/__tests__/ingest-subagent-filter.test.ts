import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isCodexSubagentSessionFile, parseCCTranscript, parseCodexSession } from "../ingest.js";

// 2026-09-08：子 agent 会话冒充用户发言的两道闸。
// Codex 子 agent 是独立 rollout 文件（首行 session_meta.parent_thread_id），整文件跳过；
// CC 侧链行（isSidechain:true）在 parser 内跳过——今天 CC 把侧链分文件存，本闸是防内联的防御。

function writeJsonl(dir: string, name: string, rows: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const codexMeta = (extra: Record<string, unknown>) => ({
  timestamp: "2026-09-08T00:00:00.000Z",
  type: "session_meta",
  payload: { id: "01a07d12-4606-7be1-9fb0-d3b82c26981a", cwd: "/tmp/x", originator: "Codex Desktop", ...extra },
});

const codexUser = (text: string) => ({
  timestamp: "2026-09-08T00:00:01.000Z",
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
});

describe("isCodexSubagentSessionFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-subagent-"));

  it("首行 session_meta 带 parent_thread_id 的子 agent rollout 判为子 agent 文件", () => {
    const p = writeJsonl(dir, "child.jsonl", [
      codexMeta({ parent_thread_id: "01a07d10-ce13-76a3-88fc-a8698930094b", agent_nickname: "Heisenberg", agent_role: "worker", multi_agent_version: "v2" }),
      codexUser("这是主 agent 派给子 agent 的任务信封，不是人说的话，长度要够十个字符以上"),
    ]);
    expect(isCodexSubagentSessionFile(p)).toBe(true);
    // 主 agent 侧仍能解析出这些 turn——说明跳过必须发生在文件级，parser 自己认不出
    expect(parseCodexSession(p).length).toBeGreaterThan(0);
  });

  it("主会话（无 parent_thread_id / 为 null）不是子 agent 文件", () => {
    const p1 = writeJsonl(dir, "main.jsonl", [codexMeta({}), codexUser("Alice 真的说了这句话，长度够十个字符")]);
    const p2 = writeJsonl(dir, "main-null.jsonl", [codexMeta({ parent_thread_id: null }), codexUser("Alice 又说了一句，长度够十个字符")]);
    expect(isCodexSubagentSessionFile(p1)).toBe(false);
    expect(isCodexSubagentSessionFile(p2)).toBe(false);
  });

  it("首行不是 session_meta、或文件为空/坏行时一律按主会话处理（fail-open，不误删）", () => {
    const p1 = writeJsonl(dir, "no-meta.jsonl", [codexUser("没有 session_meta 的文件，长度够十个字符")]);
    const p2 = join(dir, "empty.jsonl");
    writeFileSync(p2, "");
    const p3 = join(dir, "broken.jsonl");
    writeFileSync(p3, "{not json\n");
    expect(isCodexSubagentSessionFile(p1)).toBe(false);
    expect(isCodexSubagentSessionFile(p2)).toBe(false);
    expect(isCodexSubagentSessionFile(p3)).toBe(false);
    expect(isCodexSubagentSessionFile(join(dir, "missing.jsonl"))).toBe(false);
  });
});

describe("parseCCTranscript 跳过 isSidechain 行", () => {
  const dir = mkdtempSync(join(tmpdir(), "rn-sidechain-"));
  const ccUser = (text: string, extra: Record<string, unknown> = {}) => ({
    type: "user",
    userType: "external",
    sessionId: "367452c0-b395-5b80-a478-adeb949d3401",
    timestamp: "2026-09-08T00:00:00.000Z",
    message: { role: "user", content: text },
    ...extra,
  });

  it("isSidechain:true 的 user 行不产出 turn，普通 user 行照常", () => {
    const p = writeJsonl(dir, "session.jsonl", [
      ccUser("Alice 本人说的话，长度足够十个字符以上", { isSidechain: false }),
      ccUser("主 agent 写给子 agent 的任务信封，不该被当成 Alice 说的", { isSidechain: true, agentId: "a131f382262abb06a" }),
    ]);
    const turns = parseCCTranscript(p);
    const texts = turns.map((t) => t.text);
    expect(texts.some((t) => t.includes("Alice 本人说的话"))).toBe(true);
    expect(texts.some((t) => t.includes("任务信封"))).toBe(false);
  });
});
