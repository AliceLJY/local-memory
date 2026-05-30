import { describe, expect, it } from "bun:test";

import { groupTurnsIntoChunks } from "../ingest.js";
import { isNoise } from "../noise-filter.js";

// P1 defence-in-depth: groupTurnsIntoChunks pre-filters whole turns via
// filterNoiseTurns BEFORE chunking, but long turns then get split — and the
// split fragments were never re-checked. A long turn whose tail is orphaned
// context-JSON therefore leaks severed JSON field-lines as standalone chunks.
// This guards that no chunk survives as noise, without over-deleting real talk.

function userTurn(text: string) {
  return { role: "user" as const, text, timestamp: "2026-05-21T00:00:00Z", sessionId: "s1" };
}
function assistantTurn(text: string) {
  return { role: "assistant" as const, text, timestamp: "2026-05-21T00:00:01Z", sessionId: "s1" };
}

describe("groupTurnsIntoChunks — post-split noise filtering (P1)", () => {
  it("drops severed context-JSON fragments produced by splitting a long turn", () => {
    // Real-content opener (passes turn-level filterNoiseTurns), then a long tail
    // of orphaned JSON field-lines that chunking peels into standalone chunks.
    const opener = "我们今天把记忆系统这周的进展过一遍，重点是噪声治理和召回质量的提升。".repeat(8);
    const jsonTail = Array.from(
      { length: 60 },
      (_, i) => `"time": "2026-05-21T15:${String(i).padStart(2, "0")}:03.796Z",`,
    ).join("\n");
    const chunks = groupTurnsIntoChunks([userTurn(`${opener}\n${jsonTail}`)]);

    expect(chunks.length).toBeGreaterThan(0); // real content survives
    // No chunk may survive as a recognizable noise fragment.
    expect(chunks.every((c) => !isNoise(c.text))).toBe(true);
  });

  it("keeps a normal long Q&A conversation intact (no over-deletion)", () => {
    const longQuestion = "你帮我想想这个方案怎么落地，我担心几个点没考虑周全，得一起捋一捋。".repeat(20);
    const longAnswer = "可以分三步走，先做最小验证看效果，再逐步扩展覆盖面，最后补回归测试兜底。".repeat(20);
    const chunks = groupTurnsIntoChunks([userTurn(longQuestion), assistantTurn(longAnswer)]);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => !isNoise(c.text))).toBe(true); // real talk not deleted
    expect(chunks.some((c) => c.text.includes("最小验证"))).toBe(true); // content retained
  });
});
