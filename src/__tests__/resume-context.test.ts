import { describe, expect, it } from "bun:test";

import { composeResumeContext } from "../context-composer.js";
import type { RetrievalContext, RetrievalResult } from "../retriever.js";
import type { SessionCheckpointRecord } from "../session-schema.js";

function buildResult(id: string, category: "profile" | "preferences" | "entities" | "patterns" | "cases" | "fact", text: string): RetrievalResult {
  return {
    entry: {
      id,
      text,
      vector: [],
      category,
      scope: "memory:agent",
      importance: 0.8,
      timestamp: Date.parse("2026-03-16T00:00:00.000Z"),
      metadata: "{}",
    },
    score: 0.9,
    sources: {
      fused: { score: 0.9 },
    },
  };
}

function withScope(result: RetrievalResult, scope: string): RetrievalResult {
  return {
    ...result,
    entry: {
      ...result.entry,
      scope,
    },
  };
}

function withMetadata(result: RetrievalResult, metadata: Record<string, unknown>): RetrievalResult {
  return {
    ...result,
    entry: {
      ...result.entry,
      metadata: JSON.stringify(metadata),
    },
  };
}

describe("composeResumeContext", () => {
  it("uses the latest checkpoint to recover task bias and shared scope", async () => {
    const calls: RetrievalContext[] = [];
    const checkpoint: SessionCheckpointRecord = {
      checkpointId: "checkpoint-001",
      sessionId: "session-1",
      resolvedScope: "agent:codex",
      summary: "Implement startup continuity for fresh windows",
      task: "Implement resume_context",
      decisions: ["Keep checkpoints outside LanceDB"],
      openLoops: ["Need startup composition"],
      nextActions: ["Wire API and MCP endpoints"],
      entities: ["RecallNest", "Codex"],
      files: ["src/context-composer.ts"],
      updatedAt: "2026-03-16T05:00:00.000Z",
    };

    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        switch (context.category) {
          case "profile":
            return [buildResult("profile-1", "profile", "User builds local-first memory systems.")];
          case "preferences":
            return [buildResult("pref-1", "preferences", "User prefers concise technical replies.")];
          case "entities":
            return [buildResult("entity-1", "entities", "RecallNest is shared across Claude Code, Codex, and Gemini CLI.")];
          case "patterns":
            return [buildResult("pattern-1", "patterns", "At task start, run search_memory before coding.")];
          case "cases":
            return [buildResult("case-1", "cases", "Keep session state in a checkpoint store instead of the durable index.")];
          default:
            return [];
        }
      },
    };

    const checkpointStore = {
      async getLatest(query?: { sessionId?: string; scope?: string }) {
        if (query?.sessionId === "session-1" || query?.scope === "agent:codex") {
          return checkpoint;
        }
        return null;
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore,
      listPins: () => [],
    }, {
      sessionId: "session-1",
      limitPerSection: 3,
    });

    expect(response.latestCheckpoint?.sessionId).toBe("session-1");
    expect(response.stableContext).toContain("Profile: User builds local-first memory systems.");
    expect(response.relevantPatterns).toEqual(["At task start, run search_memory before coding."]);
    expect(response.recentCases).toEqual(["Keep session state in a checkpoint store instead of the durable index."]);
    expect(response.summary).toContain("Latest checkpoint from session-1");

    const patternCall = calls.find((call) => call.category === "patterns");
    expect(patternCall?.scopeFilter).toEqual(["agent:codex"]);
    expect(patternCall?.query).toContain("Implement resume_context");
    expect(patternCall?.source).toBe("auto-recall");
  });

  it("fills sparse stable context with pinned memory and skips checkpoint lookup when disabled", async () => {
    let checkpointLookups = 0;
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "patterns") {
          return [buildResult("pattern-2", "patterns", "Use resume_context before starting a new terminal task.")];
        }
        return [];
      },
    };

    const checkpointStore = {
      async getLatest() {
        checkpointLookups += 1;
        return null;
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore,
      listPins: () => [{
        id: "pin-1",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "Continuity rule",
        summary: "Pinned reminder: keep stable context visible across fresh windows.",
        tags: ["continuity", "resume_context"],
        source: {
          memoryId: "memory-1",
          scope: "agent:codex",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "keep stable context visible across fresh windows",
        path: "/tmp/pin-1.json",
      }],
    }, {
      task: "cross window continuity",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(checkpointLookups).toBe(0);
    expect(response.latestCheckpoint).toBeUndefined();
    expect(response.stableContext).toContain("Pinned: Pinned reminder: keep stable context visible across fresh windows.");
    expect(response.relevantPatterns).toEqual(["Use resume_context before starting a new terminal task."]);
  });

  it("ignores evidence-only stable recall from transcripts", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "profile") {
          return [
            withMetadata(
              withScope(buildResult("profile-evidence", "profile", "User is a product builder who likes local tools."), "cc:session"),
              {
                boundary: {
                  layer: "evidence",
                  authority: "transcript-ingest",
                  conflictPolicy: "append-only",
                },
              },
            ),
          ];
        }

        if (context.category === "preferences") {
          return [
            withMetadata(
              buildResult("pref-durable", "preferences", "User prefers concise technical replies."),
              {
                boundary: {
                  layer: "durable",
                  authority: "structured-memory",
                  conflictPolicy: "latest-wins",
                },
              },
            ),
          ];
        }

        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return null;
        },
      },
      listPins: () => [],
    }, {
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.stableContext).toContain("Preference: User prefers concise technical replies.");
    expect(response.stableContext.some((item) => item.includes("product builder"))).toBe(false);
  });

  it("prefers durable style preferences over older pins for style-focused writing tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "preferences") return [];
        return [
          withMetadata(
            buildResult(
              "pref-writing-tone",
              "preferences",
              "用户不接受浮夸/亢奋/营销腔，正确语气是口语化、不端着、可自嘲，但不鸡血不吆喝。",
            ),
            {
              boundary: {
                layer: "durable",
                authority: "structured-memory",
                conflictPolicy: "latest-wins",
              },
              canonicalKey: "pref-writing-tone-no-hype",
            },
          ),
        ];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return null;
        },
      },
      listPins: () => [{
        id: "pin-writing-style",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "旧写作风格包",
        summary: "80%严肃分析 + 20%口语调剂，banned_fillers 规则已生效。",
        tags: ["写作", "风格"],
        source: {
          memoryId: "memory-old-pin",
          scope: "cc:old-pin",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "banned_fillers 规则已生效",
        path: "/tmp/pin-writing-style.json",
      }],
    }, {
      task: "继续公众号「我的AI小木屋」文章写作，回忆写作风格偏好",
      profile: "writing",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.stableContext).toContain(
      "Preference: 用户不接受浮夸/亢奋/营销腔，正确语气是口语化、不端着、可自嘲，但不鸡血不吆喝。",
    );
    expect(response.responseMode).toBe("recall-only");
    expect(response.responseGuidance).toContain("answer from the recalled stable context");
    expect(response.stableContext.some((item) => item.includes("80%严肃分析"))).toBe(false);
    expect(response.stableContext.some((item) => item.startsWith("Pinned:"))).toBe(false);
    expect(response.stableContext.some((item) => item.startsWith("Task focus:"))).toBe(false);
  });

  it("uses a narrow style fallback query before falling back to task focus", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);

        if (context.category !== "preferences") return [];
        if (context.query.includes("user preferences writing tone voice style habits")) {
          return [];
        }
        if (context.query.includes("写作风格") && context.query.includes("避免表达")) {
          return [
            withMetadata(
              buildResult(
                "pref-writing-fallback",
                "preferences",
                "用户不喜欢AI味过重的文案语气，偏好口语化、不端着、可自嘲但不浮夸。",
              ),
              {
                boundary: {
                  layer: "durable",
                  authority: "structured-memory",
                  conflictPolicy: "latest-wins",
                },
                canonicalKey: "pref-writing-tone-no-hype",
              },
            ),
          ];
        }
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return null;
        },
      },
      listPins: () => [],
    }, {
      task: "回忆写作风格偏好：语气注意事项、要避免的表达、默认风格",
      profile: "writing",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(calls.some((call) =>
      call.category === "preferences" &&
      call.query.includes("user preferences writing tone voice style habits")
    )).toBe(true);
    expect(calls.some((call) =>
      call.category === "preferences" &&
      call.query.includes("写作风格") &&
      call.query.includes("避免表达")
    )).toBe(true);
    expect(response.stableContext).toContain(
      "Preference: 用户不喜欢AI味过重的文案语气，偏好口语化、不端着、可自嘲但不浮夸。",
    );
    expect(response.responseMode).toBe("recall-only");
    expect(response.stableContext.some((item) => item.startsWith("Task focus:"))).toBe(false);
  });

  it("falls back to broad workflow recall when direct pattern retrieval is empty", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category === "patterns") return [];
        if (!context.category) {
          return [
            buildResult(
              "fact-1",
              "fact",
              "[助手] autoRecall 和 sessionStrategy 是两个独立配置项，开新窗口前先确认自动召回是否开启。",
            ),
          ];
        }
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return null;
        },
      },
      listPins: () => [],
    }, {
      task: "开个新窗口继续做同一个终端项目",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.relevantPatterns).toEqual([
      "autoRecall 和 sessionStrategy 是两个独立配置项，开新窗口前先确认自动召回是否开启。",
    ]);
    expect(calls.some((call) => !call.category && call.query.includes("resume_context"))).toBe(true);
  });

  it("adds built-in continuity patterns when no workflow memories are available", async () => {
    const retriever = {
      async retrieve(): Promise<RetrievalResult[]> {
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return null;
        },
      },
      listPins: () => [],
    }, {
      task: "open a fresh window to continue the same terminal project",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.relevantPatterns).toEqual([
      "Start fresh windows with resume_context before coding so stable context is restored early.",
      "Before leaving a window, save checkpoint_session so the next session can recover decisions and next actions.",
    ]);
  });

  it("filters low-signal stable recall and backfills with checkpoint context", async () => {
    const checkpoint: SessionCheckpointRecord = {
      checkpointId: "checkpoint-002",
      sessionId: "recallnest-session",
      resolvedScope: "recallnest",
      summary: "Phase 3 continuity work is active and resume_context compose quality is the current bottleneck.",
      task: "RecallNest continuity layer 开发状态梳理",
      decisions: ["resume_context compose 质量是最高优先级短板"],
      openLoops: ["Need broader continuity eval coverage"],
      nextActions: ["改进 compose 质量：增加 pattern/case 召回率，优化 stable context 筛选"],
      entities: ["recallnest (~/recallnest/)"],
      files: ["src/context-composer.ts"],
      updatedAt: "2026-03-16T08:00:00.000Z",
    };

    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult("entity-noise-1", "entities", "[助手] 再看看 RecallNest 现有的 setup 脚本和项目结构。"),
              "cc:session",
            ),
            withScope(
              buildResult("entity-noise-2", "entities", "[助手] recallnest 在 GitHub 上有但本地没 clone。"),
              "cc:session",
            ),
          ];
        }
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return checkpoint;
        },
      },
      listPins: () => [{
        id: "pin-visual",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "Visual style",
        summary: "Pinned reminder: 用户常用视觉风格是手绘涂鸦风加高对比撞色。",
        tags: ["visual-style"],
        source: {
          memoryId: "memory-visual",
          scope: "memory:agent",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "手绘涂鸦风加高对比撞色",
        path: "/tmp/pin-visual.json",
      }],
    }, {
      scope: "recallnest",
      task: "RecallNest项目当前状态、最近进展、下一步计划",
      limitPerSection: 3,
    });

    expect(response.stableContext).toContain("Checkpoint focus: RecallNest continuity layer 开发状态梳理");
    expect(response.stableContext).toContain("Checkpoint decision: resume_context compose 质量是最高优先级短板");
    expect(response.stableContext.some((item) => item.includes("手绘涂鸦"))).toBe(false);
    expect(response.stableContext.some((item) => item.includes("本地没 clone"))).toBe(false);
    expect(response.stableContext.some((item) => item.includes("再看看"))).toBe(false);
    expect(response.summary).toContain("Stable context:");
  });

  it("uses task hints to keep relevant writing or visual pins in sparse contexts", async () => {
    const retriever = {
      async retrieve(): Promise<RetrievalResult[]> {
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return null;
        },
      },
      listPins: () => [{
        id: "pin-visual",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "用户视觉审美偏好",
        summary: "用户常用视觉风格是手绘涂鸦风加高对比撞色；在内容包装和配图生成时，应优先沿用这一审美方向。",
        tags: ["审美偏好", "手绘涂鸦", "高对比撞色", "配图"],
        source: {
          memoryId: "memory-visual",
          scope: "cc:397f4d4d",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "给刚才写的文章生成配图，风格：手绘涂鸦风+高对比撞色。",
        path: "/tmp/pin-visual.json",
      }],
    }, {
      task: "给文章做封面和配图",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.stableContext).toContain(
      "Pinned: 用户常用视觉风格是手绘涂鸦风加高对比撞色；在内容包装和配图生成时，应优先沿用这一审美方向。",
    );
  });

  it("adds a task focus fallback when stable recall is otherwise empty", async () => {
    const retriever = {
      async retrieve(): Promise<RetrievalResult[]> {
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return null;
        },
      },
      listPins: () => [],
    }, {
      task: "一起继续排查 RecallNest 的连续性问题",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.stableContext).toContain("Task focus: recallnest");
  });

  it("filters noisy non-durable cases and keeps durable case memories", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-noise",
                "cases",
                "[用户] 笑不活了，怎么https://github.com/AliceLJY/recallnest/issues 我的还在，解决了帮我关闭啊。。。 [助手] 三个 open issues，让我看看内容。",
              ),
              "cc:14c6e6d9",
            ),
            withScope(
              buildResult(
                "case-durable",
                "cases",
                "RecallNest continuity case: resume_context returned sparse startup context, so we filtered noisy transcript fragments and backfilled stable context from checkpoint focus, summary, and decisions.",
              ),
              "memory:agent",
            ),
          ];
        }
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return null;
        },
      },
      listPins: () => [],
    }, {
      task: "一起继续排查 RecallNest 的连续性问题",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases).toEqual([
      "RecallNest continuity case: resume_context returned sparse startup context, so we filtered noisy transcript fragments and backfilled stable context from checkpoint focus, summary, and decisions.",
    ]);
  });

  it("falls back to a broader case query when direct case recall is empty or noisy", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category !== "cases") return [];
        if (context.query.includes("similar solved case previous fix")) {
          return [
            withScope(
              buildResult(
                "case-noise",
                "cases",
                "[用户] 笑不活了，怎么https://github.com/AliceLJY/recallnest/issues 我的还在，解决了帮我关闭啊。。。",
              ),
              "cc:14c6e6d9",
            ),
          ];
        }
        if (context.query.includes("root cause workaround cleanup")) {
          return [
            withScope(
              buildResult(
                "case-durable",
                "cases",
                "Case: RecallNest sparse startup context cleanup Problem: resume_context returned noisy transcript fragments and unrelated memories instead of a clean project handoff. Solution: Filter low-signal transcripts and backfill stable context from checkpoint decisions.",
              ),
              "memory:agent",
            ),
          ];
        }
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return null;
        },
      },
      listPins: () => [],
    }, {
      task: "一起继续排查 RecallNest 的连续性问题",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.recentCases).toHaveLength(1);
    expect(response.recentCases[0]).toContain("Case: RecallNest sparse startup context cleanup");
    expect(response.recentCases[0]).toContain("resume_context returned noisy transcript fragments");
    expect(calls.some((call) => call.category === "cases" && call.query.includes("root cause workaround cleanup"))).toBe(true);
  });
});
