import { describe, expect, it } from "bun:test";

import type { PinAsset } from "../memory-assets.js";
import { selectPinnedContext } from "../context-composer-pins.js";

function buildPinnedAsset(overrides: Partial<PinAsset> = {}): PinAsset & { path: string } {
  return {
    id: overrides.id || "pin-1",
    type: "pinned-memory",
    createdAt: overrides.createdAt || "2026-03-20T00:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-03-20T00:00:00.000Z",
    title: overrides.title || "Pinned continuity note",
    summary: overrides.summary || "Pinned continuity reminder",
    tags: overrides.tags || [],
    source: overrides.source || {
      memoryId: "memory-1",
      scope: "memory:project:recallnest",
      timestamp: Date.parse("2026-03-20T00:00:00.000Z"),
      metadata: {},
    },
    retrieval: overrides.retrieval,
    snippet: overrides.snippet || "",
    path: "/tmp/pin-1.json",
  };
}

describe("context composer pins", () => {
  it("keeps later task-specific cues from long maintenance prompts", () => {
    const taskSeed =
      "继续 RecallNest continuity helper boundary audit ranking scoring selection orchestration context composer stable query fallback profile forwarding gap runner isolation";

    const pinnedContext = selectPinnedContext([
      buildPinnedAsset({
        title: "Eval runner isolation note",
        summary: "Fresh-window replay still needs explicit runner isolation to avoid shared component skew.",
        tags: ["recallnest", "runner", "isolation"],
        snippet: "Runner isolation is the key safeguard when continuity previews diverge across fresh-window replay.",
      }),
    ], {
      taskSeed,
      limit: 1,
    });

    expect(pinnedContext).toHaveLength(1);
    expect(pinnedContext[0]).toContain("Pinned: Eval runner isolation note: Fresh-window replay still needs explicit runner isolation to avoid shared component skew.");
  });

  it("ignores conversational continuation filler for vague memory-layer prompts", () => {
    const pinnedContext = selectPinnedContext([
      buildPinnedAsset({
        id: "pin-visual",
        title: "用户视觉审美偏好",
        summary: "用户常用视觉风格是手绘涂鸦风加高对比撞色；在内容包装和配图生成时，应优先沿用这一审美方向。",
        tags: ["审美偏好", "手绘涂鸦", "高对比撞色", "给刚才写的文章生成配图"],
        snippet: "给刚才写的文章生成配图，风格：手绘涂鸦风+高对比撞色。",
      }),
    ], {
      taskSeed: "把刚才那个 memory layer 接回去",
      limit: 1,
    });

    expect(pinnedContext).toEqual([]);
  });
});
