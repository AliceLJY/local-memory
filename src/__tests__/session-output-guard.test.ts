import { describe, expect, it } from "bun:test";

import { RECALL_STALENESS_GUARD, formatCheckpointSummary, formatResumeContext } from "../session-output.js";
import { ResumeContextResponseSchema, SessionCheckpointRecordSchema } from "../session-schema.js";

// 2026-09-08：回忆载荷自带「过期」声明（借鉴 ECC session-start.js 的 HISTORICAL REFERENCE ONLY 护栏）。
// 断言的是「护栏在任何回忆内容之前」——读者先看到它，再看到可能过期的 next action / 命令。

describe("回忆载荷自带过期护栏", () => {
  it("latest checkpoint 输出的第二行是护栏，且排在会被误当活指令的 next action 之前", () => {
    const record = SessionCheckpointRecordSchema.parse({
      checkpointId: "cc531131deadbeef",
      sessionId: "s-1",
      resolvedScope: "project:x",
      summary: "sum",
      nextActions: ["/deploy --prod"],
    });
    const out = formatCheckpointSummary(record);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Latest checkpoint");
    expect(lines[1]).toBe(RECALL_STALENESS_GUARD);
    expect(out.indexOf(RECALL_STALENESS_GUARD)).toBeLessThan(out.indexOf("/deploy --prod"));
  });

  it("resume_context 输出的第二行是护栏", () => {
    const response = ResumeContextResponseSchema.parse({
      generatedAt: new Date().toISOString(),
      summary: "sum",
      stableContext: ["Alice prefers bun"],
      relevantPatterns: [],
      recentCases: [],
      latestCheckpoint: {
        sessionId: "s-1",
        summary: "prior window summary",
        updatedAt: new Date().toISOString(),
      },
    });
    const out = formatResumeContext(response);
    const lines = out.split("\n");
    expect(lines[0]).toBe("Resume context");
    expect(lines[1]).toBe(RECALL_STALENESS_GUARD);
    expect(out.indexOf(RECALL_STALENESS_GUARD)).toBeLessThan(out.indexOf("Alice prefers bun"));
    expect(out.indexOf(RECALL_STALENESS_GUARD)).toBeLessThan(out.indexOf("prior window summary"));
  });

  it("护栏本身不含会被当成命令的东西（只是一句话）", () => {
    expect(RECALL_STALENESS_GUARD.includes("\n")).toBe(false);
    expect(RECALL_STALENESS_GUARD.startsWith("/")).toBe(false);
    expect(RECALL_STALENESS_GUARD.length).toBeLessThan(260);
  });
});
