import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  groupTurnsIntoChunks,
  parseCCTranscript,
  parseCodexSession,
  parseKimiSession,
} from "../ingest.js";

/**
 * session 级图片标记（2026-08-27）。
 *
 * 用户亲手贴的图此前被各端 parser 连同工具产物一起丢掉，且只贴图不配字的那一轮
 * 会被长度闸整条删掉（实测占含图轮次的 12.5%，最极端是 0 字配 7 张图）。
 *
 * 修法不是把图编码进库，而是打一个 **session 级**的标：这个 session 里用户贴过
 * 几张图。粒度取 session 而非轮次是有意的——图所在的那一轮常常根本没进库，
 * 只有盖到同 session 的其他轮次上才可能被搜到。
 *
 * 全量扫描实测（mini 上 9619 个 jsonl）：claude 316 个 session / 1152 张，
 * codex 375 个 / 477 张，kimi 0 张。所以三端 parser 都要认，且各自的格式不同：
 * claude 是 image、codex 是 input_image、kimi 是 image_url。
 *
 * 反向断言守的是「没把闸门整个拆掉」和「工具产的图不许冒充用户贴图」——
 * 后者是大头，实测被排除的工具图有 5812 张，是用户贴图的三倍多。
 */

function writeLines(lines: object[], dir?: string, name = "session.jsonl"): string {
  const d = dir ?? mkdtempSync(join(tmpdir(), "rn-sessimg-"));
  const file = join(d, name);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return file;
}

// ── CC (Anthropic 格式) ──────────────────────────────────────────────

function ccUser(content: unknown[], uuid = "u-1") {
  return {
    type: "user",
    uuid,
    timestamp: "2026-08-27T10:00:00Z",
    sessionId: "sess-abcd1234",
    message: { role: "user", content },
  };
}
const ccImage = (mediaType = "image/png") => ({
  type: "image",
  source: { type: "base64", media_type: mediaType, data: "AAAA" },
});

describe("parseCCTranscript — session 级图片标记", () => {
  it("有配文时正文一字不改，标记记的是 session 总数", () => {
    const file = writeLines([
      ccUser([{ type: "text", text: "你帮我看一下这个报错，我现在完全进不去了" }, ccImage()]),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("你帮我看一下这个报错，我现在完全进不去了");
    expect(turns[0].sessionImages).toBe(1);
  });

  it("只贴图不配字的一轮不再整条消失（0 字 7 图）", () => {
    const file = writeLines([ccUser(Array.from({ length: 7 }, () => ccImage()))]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("[图片×7]");
    expect(turns[0].sessionImages).toBe(7);
  });

  it("短配文配图也保得住（「操作步骤在这里」7 个字，此前被长度闸删掉）", () => {
    const file = writeLines([ccUser([{ type: "text", text: "操作步骤在这里" }, ccImage()])]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("操作步骤在这里");
    expect(turns[0].sessionImages).toBe(1);
  });

  // 这条是 session 粒度的核心：标记盖到不含图的轮次上，才救得回「图那轮没进库」
  it("标记盖满全 session，包括本身没有图的轮次", () => {
    const file = writeLines([
      ccUser([{ type: "text", text: "我们先把这个报错的来龙去脉理一遍再动手" }]),
      ccUser([{ type: "text", text: "你看这张截图里的配置是不是写错了" }, ccImage()]),
      ccUser([{ type: "text", text: "那按你说的改完之后要重新跑一遍测试吗" }]),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(3);
    // 三轮里只有第二轮有图，但三轮都带标——这正是要的效果
    expect(turns.map((t) => t.sessionImages)).toEqual([1, 1, 1]);
  });

  // ── 反向断言 ──

  it("短文本且无图，仍然照旧丢弃", () => {
    const file = writeLines([ccUser([{ type: "text", text: "好的" }])]);

    expect(parseCCTranscript(file)).toHaveLength(0);
  });

  it("整个 session 无图时不带 sessionImages 字段", () => {
    const file = writeLines([
      ccUser([{ type: "text", text: "我们把这个方案再捋一遍，看看哪里还有问题" }]),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(1);
    expect(turns[0].sessionImages).toBeUndefined();
  });

  it("tool_result 里的图归入 AI 产图，不混进用户贴图", () => {
    const file = writeLines([
      ccUser([
        { type: "tool_result", tool_use_id: "t-1", content: [ccImage(), ccImage()] },
        { type: "text", text: "这个网页截图你看看渲染对不对，颜色好像不太对" },
      ]),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(1);
    expect(turns[0].sessionImages).toBeUndefined();
    // 不是丢掉，是记到另一格——agent 回溯「那个页面当时什么样」要靠它
    expect(turns[0].sessionToolImages).toBe(2);
  });

  it("两类图同时存在时各记各的，不互相污染", () => {
    const file = writeLines([
      ccUser([
        { type: "text", text: "你先看我贴的这张配置图，再去把页面截个图对比一下" },
        ccImage(),
      ]),
      ccUser([
        { type: "tool_result", tool_use_id: "t-2", content: [ccImage(), ccImage(), ccImage()] },
        { type: "text", text: "截好了你对比看看两边的差异在哪里" },
      ]),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns.map((t) => t.sessionImages)).toEqual([1, 1]);
    expect(turns.map((t) => t.sessionToolImages)).toEqual([3, 3]);
  });
});

// ── Codex (OpenAI 格式) ─────────────────────────────────────────────

describe("parseCodexSession — input_image 也要认", () => {
  it("用户消息里的 input_image 计入", () => {
    const file = writeLines([
      { type: "session_meta", payload: { id: "sess-codex-0001" } },
      {
        type: "response_item",
        timestamp: "2026-08-27T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "你看一下这张图里的报错是什么原因造成的" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
          ],
        },
      },
    ]);

    const turns = parseCodexSession(file);

    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].sessionImages).toBe(1);
  });

  // Codex 自己生的图 / 读的图放在 payload.output，不是 payload.content
  it("function_call_output 里的 input_image 归入 AI 产图（生图或读图）", () => {
    const file = writeLines([
      { type: "session_meta", payload: { id: "sess-codex-0002" } },
      {
        type: "response_item",
        timestamp: "2026-08-27T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "帮我画一张示意图说明这个流程" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-27T10:00:10Z",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: "data:image/png;base64,BBBB" }],
        },
      },
    ]);

    const turns = parseCodexSession(file);

    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].sessionImages).toBeUndefined();
    expect(turns[0].sessionToolImages).toBe(1);
  });

  // 这条守的是「补集」而不是「枚举」。image_generation_call 是代码里从未列举过的
  // 形态（Codex 生图——写公众号让它配封面就走这条），枚举式实现会把它整个漏掉：
  // 既不在 payload.content 也不在 payload.output，两边都不算。补集必须接住它。
  it("从未枚举过的生图形态也落进 AI 产图（补集不漏）", () => {
    const file = writeLines([
      { type: "session_meta", payload: { id: "sess-codex-0003" } },
      {
        type: "response_item",
        timestamp: "2026-08-28T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "帮我给这篇公众号文章配一张封面图" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-28T10:00:30Z",
        payload: {
          type: "image_generation_call",
          id: "ig_019f",
          status: "completed",
          result: "data:image/png;base64,AAAA",
        },
      },
    ]);

    const turns = parseCodexSession(file);

    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].sessionImages).toBeUndefined();
    expect(turns[0].sessionToolImages).toBe(1);
  });
});

// ── Kimi ────────────────────────────────────────────────────────────

describe("parseKimiSession — image_url 也要认", () => {
  // sessionId 从路径倒数第 4 段取，所以要搭出 <sid>/agents/main/wire.jsonl
  function kimiFile(lines: object[]): string {
    const root = mkdtempSync(join(tmpdir(), "rn-kimi-"));
    const dir = join(root, "session_kimi0001", "agents", "main");
    mkdirSync(dir, { recursive: true });
    return writeLines(lines, dir, "wire.jsonl");
  }

  it("用户 prompt 里的 image_url 计入", () => {
    const file = kimiFile([
      {
        type: "turn.prompt",
        origin: { kind: "user" },
        time: 1787679755910,
        input: [
          { type: "text", text: "这张图里的配置项你帮我核对一下对不对" },
          { type: "image_url", imageUrl: { url: "https://example.invalid/a.png" } },
        ],
      },
    ]);

    const turns = parseKimiSession(file);

    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].sessionImages).toBe(1);
  });

  // kimi 全量实测 109 张图全在 tool.result 里，一张用户贴图都没有
  it("tool.result 里的 image_url 归入 AI 产图", () => {
    const file = kimiFile([
      {
        type: "turn.prompt",
        origin: { kind: "user" },
        time: 1787679755910,
        input: [{ type: "text", text: "帮我把那个页面截个图看看渲染成什么样了" }],
      },
      {
        type: "context.append_loop_event",
        time: 1787679756910,
        event: {
          type: "tool.result",
          result: {
            output: [
              { type: "text", text: "screenshot saved" },
              { type: "image_url", imageUrl: { url: "https://example.invalid/shot.png" } },
            ],
          },
        },
      },
    ]);

    const turns = parseKimiSession(file);

    expect(turns.length).toBeGreaterThan(0);
    expect(turns[0].sessionImages).toBeUndefined();
    expect(turns[0].sessionToolImages).toBe(1);
  });
});

// ── 分块层 ──────────────────────────────────────────────────────────

describe("groupTurnsIntoChunks — 标记穿过分块层", () => {
  it("session 标记落到合并后的 chunk 上", () => {
    const chunks = groupTurnsIntoChunks([
      {
        role: "user",
        text: "[图片×2]",
        timestamp: "2026-08-27T10:00:00Z",
        sessionId: "sess-abcd1234",
        sessionImages: 2,
        sessionToolImages: 5,
      },
      {
        role: "assistant",
        text: "这两张截图里的问题出在代理配置上，端口写错了，改回 17890 就能连上。",
        timestamp: "2026-08-27T10:00:05Z",
        sessionId: "sess-abcd1234",
      },
    ]);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].sessionImages).toBe(2);
    expect(chunks[0].sessionToolImages).toBe(5);
    // 助手这句回复就是「定位这些图」的那段文字——正是保留空正文轮次的意义
    expect(chunks[0].text).toContain("代理配置");
  });

  it("无图的对话不产生 sessionImages 字段", () => {
    const chunks = groupTurnsIntoChunks([
      {
        role: "user",
        text: "这个方案你觉得靠谱吗，我有点担心存量重建的成本",
        timestamp: "2026-08-27T10:00:00Z",
        sessionId: "sess-abcd1234",
      },
      {
        role: "assistant",
        text: "成本主要压在存量重建这一块，其他几项都还好，可以分批做。",
        timestamp: "2026-08-27T10:00:05Z",
        sessionId: "sess-abcd1234",
      },
    ]);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].sessionImages).toBeUndefined();
  });
});
