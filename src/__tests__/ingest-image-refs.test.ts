import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { groupTurnsIntoChunks, parseCCTranscript } from "../ingest.js";

/**
 * 图片可寻址（2026-08-27）。
 *
 * CC transcript 里用户贴的图此前被 `.filter(c => c.type === "text")` 连同
 * tool_use / tool_result 一起整块丢掉。丢的不只是图本身——只贴图不配字的那一轮
 * 会被长度闸整条删掉，实测占含图轮次的 12.5%（mini 上 400 个会话采样），
 * 丢掉的常是「操作步骤在这里」+ 截图这种正文全在图里的高价值轮次，
 * 最极端的样本是 0 字配 7 张图。
 *
 * 这里守三件事：
 *   1. 图的回溯坐标能一路走到 chunk（存储层据此写 metadata）
 *   2. 救回那 12.5% 的同时没有把长度闸整个拆掉（见反向断言两条）
 *   3. 工具产的图（实测占全部图片的 91%）不许混进来冒充用户贴图
 */

function writeTranscript(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rn-imgref-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return file;
}

function userLine(content: unknown[], uuid = "u-1") {
  return {
    type: "user",
    uuid,
    timestamp: "2026-08-27T10:00:00Z",
    sessionId: "sess-abcd1234",
    message: { role: "user", content },
  };
}

function imageBlock(mediaType = "image/png") {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: "AAAA" } };
}

describe("parseCCTranscript — 用户贴图的回溯坐标", () => {
  it("有配文时正文一字不改，图只记坐标", () => {
    const file = writeTranscript([
      userLine([
        { type: "text", text: "你帮我看一下这个报错，我现在完全进不去了" },
        imageBlock("image/jpeg"),
      ]),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(1);
    // 正文没有被塞进任何标记——往里加标记会稀释 embedding
    expect(turns[0].text).toBe("你帮我看一下这个报错，我现在完全进不去了");
    expect(turns[0].imageRefs).toEqual([
      { uuid: "u-1", mediaType: "image/jpeg", index: 1 },
    ]);
  });

  it("只贴图不配字的一轮不再整条消失（0 字 7 图）", () => {
    const file = writeTranscript([
      userLine(Array.from({ length: 7 }, () => imageBlock())),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("[图片×7]");
    expect(turns[0].imageRefs).toHaveLength(7);
    expect(turns[0].imageRefs?.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("短配文配图也保得住（「操作步骤在这里」7 个字，此前被长度闸删掉）", () => {
    const file = writeTranscript([
      userLine([{ type: "text", text: "操作步骤在这里" }, imageBlock()]),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("操作步骤在这里");
    expect(turns[0].imageRefs).toHaveLength(1);
  });

  it("多张图的 index 与正文里的 [Image #N] 标记同序", () => {
    const file = writeTranscript([
      userLine([
        { type: "text", text: "[Image #1] 和 [Image #2] 这两张对比着看一下差别在哪" },
        imageBlock("image/png"),
        imageBlock("image/jpeg"),
      ]),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns[0].imageRefs).toEqual([
      { uuid: "u-1", mediaType: "image/png", index: 1 },
      { uuid: "u-1", mediaType: "image/jpeg", index: 2 },
    ]);
  });

  // ── 反向断言：证明不是把长度闸整个拆了 ────────────────────────────────

  it("短文本且无图，仍然照旧丢弃", () => {
    const file = writeTranscript([userLine([{ type: "text", text: "好的" }])]);

    expect(parseCCTranscript(file)).toHaveLength(0);
  });

  it("无图的正常轮次不带 imageRefs 字段（不污染无图记忆）", () => {
    const file = writeTranscript([
      userLine([{ type: "text", text: "我们把这个方案再捋一遍，看看哪里还有问题" }]),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(1);
    expect(turns[0].imageRefs).toBeUndefined();
  });

  it("tool_result 里的图不算用户贴图（实测那是 91% 的图片来源）", () => {
    const file = writeTranscript([
      userLine([
        {
          type: "tool_result",
          tool_use_id: "t-1",
          content: [imageBlock(), imageBlock()],
        },
        { type: "text", text: "这个网页截图你看看渲染对不对，颜色好像不太对" },
      ]),
    ]);

    const turns = parseCCTranscript(file);

    expect(turns).toHaveLength(1);
    expect(turns[0].imageRefs).toBeUndefined();
  });
});

describe("groupTurnsIntoChunks — 坐标穿过分块层", () => {
  const refs = [
    { uuid: "u-1", mediaType: "image/png", index: 1 },
    { uuid: "u-1", mediaType: "image/png", index: 2 },
  ];

  it("user 轮的坐标落到与助手回复合并后的 chunk 上", () => {
    const chunks = groupTurnsIntoChunks([
      {
        role: "user",
        text: "[图片×2]",
        timestamp: "2026-08-27T10:00:00Z",
        sessionId: "sess-abcd1234",
        imageRefs: refs,
      },
      {
        role: "assistant",
        text: "这两张截图里的问题出在代理配置上，端口写错了，改回 17890 就能连上。",
        timestamp: "2026-08-27T10:00:05Z",
        sessionId: "sess-abcd1234",
      },
    ]);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].imageRefs).toEqual(refs);
    // 助手这句回复就是「定位这些图」的那段文字——正是保留空正文轮次的意义
    expect(chunks[0].text).toContain("代理配置");
  });

  it("无图的对话不产生 imageRefs 字段", () => {
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
    expect(chunks[0].imageRefs).toBeUndefined();
  });
});
