import { describe, expect, it } from "bun:test";

import { runAutoRecall } from "../auto-recall.js";
import type { RetrievalContext, RetrievalResult } from "../retriever.js";
import type { SessionCheckpointRecord } from "../session-schema.js";

function buildResult(id: string, category: "profile" | "preferences" | "entities" | "patterns" | "cases" | "events", text: string, scope = "project:test"): RetrievalResult {
  return {
    entry: {
      id,
      text,
      vector: [],
      category,
      scope,
      importance: 0.8,
      timestamp: Date.parse("2026-03-17T00:00:00.000Z"),
      metadata: "{}",
    },
    score: 0.9,
    sources: {
      fused: { score: 0.9 },
    },
  };
}

describe("runAutoRecall", () => {
  it("reuses an explicit scope for focused recall after composing resume context", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category === "profile") {
          return [buildResult("profile-1", "profile", "Profile: RecallNest maintainer.", "project:alpha")];
        }
        if (!context.category) {
          return [buildResult("event-1", "events", "RecallNest uses Weibull decay.", "project:alpha")];
        }
        return [];
      },
    };

    const response = await runAutoRecall({
      retriever,
      checkpointStore: { async getLatest() { return null; } },
      listPins: () => [],
    }, {
      message: "那个衰减曲线用的什么公式来着",
      scope: "project:alpha",
      limit: 5,
      profile: "default",
      operation: "test:auto-recall",
    });

    expect(response.mode).toBe("resume+search");
    expect(response.resolvedScope).toBe("project:alpha");
    expect(response.results[0]?.entry.id).toBe("event-1");
    const searchCall = calls.find((call) => !call.category);
    expect(searchCall?.scopeFilter).toEqual(["project:alpha"]);
    expect(searchCall?.source).toBe("auto-recall");
  });

  it("uses the checkpoint-resolved scope when the request only carries sessionId", async () => {
    const calls: RetrievalContext[] = [];
    const checkpoint: SessionCheckpointRecord = {
      checkpointId: "checkpoint-1",
      sessionId: "session-123",
      resolvedScope: "project:recallnest",
      summary: "Continue proactive recall work.",
      task: "Implement auto recall route",
      decisions: [],
      openLoops: [],
      nextActions: [],
      entities: [],
      files: [],
      updatedAt: "2026-03-17T10:00:00.000Z",
    };

    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (!context.category) {
          return [buildResult("event-1", "events", "Add a true auto recall route.", "project:recallnest")];
        }
        return [];
      },
    };

    const response = await runAutoRecall({
      retriever,
      checkpointStore: {
        async getLatest(query?: { sessionId?: string }) {
          return query?.sessionId === "session-123" ? checkpoint : null;
        },
      },
      listPins: () => [],
    }, {
      message: "继续做主动 recall",
      sessionId: "session-123",
      operation: "test:auto-recall",
    });

    expect(response.resolvedScope).toBe("project:recallnest");
    expect(response.resume.latestCheckpoint?.resolvedScope).toBe("project:recallnest");
    const searchCall = calls.find((call) => !call.category);
    expect(searchCall?.scopeFilter).toEqual(["project:recallnest"]);
  });

  it("falls back to resume-only mode when no scope can be inferred for focused search", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        return [];
      },
    };

    const response = await runAutoRecall({
      retriever,
      checkpointStore: { async getLatest() { return null; } },
      listPins: () => [],
    }, {
      message: "what do you remember about this",
      operation: "test:auto-recall",
    });

    expect(response.mode).toBe("resume-only");
    expect(response.results).toHaveLength(0);
    expect(response.searchSkippedReason).toContain("No explicit or inferred scope");
    expect(calls.some((call) => !call.category)).toBe(false);
  });
});
