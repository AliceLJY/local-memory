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

    expect(response.resolvedScope).toBe("agent:codex");
    expect(response.latestCheckpoint?.sessionId).toBe("session-1");
    expect(response.latestCheckpoint?.resolvedScope).toBe("agent:codex");
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
    expect(response.stableContext).toContain("Pinned: Continuity rule: Pinned reminder: keep stable context visible across fresh windows.");
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

    expect(response.relevantPatterns).toHaveLength(2);
    expect(response.relevantPatterns).toContain(
      "Start fresh windows with resume_context before coding so stable context is restored early.",
    );
    expect(response.relevantPatterns).toContain(
      "Before leaving a window, save checkpoint_session so the next session can recover decisions and next actions.",
    );
  });

  it("keeps structured workflow tools visible in pattern summaries", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "patterns") return [];
        return [
          withMetadata(
            buildResult(
              "pattern-structured",
              "patterns",
              "Workflow pattern: Recall before repo exploration",
            ),
            {
              workflowPattern: {
                title: "Recall before repo exploration",
                trigger: "When a fresh window continues an existing project and startup context still looks sparse",
                steps: [
                  "Call resume_context before reading local files or docs.",
                  "If stable context is still thin, run search_memory with the project name and task nouns.",
                  "Only after recall is established, inspect the repo and continue implementation.",
                ],
                tools: ["resume_context", "search_memory"],
              },
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
      listPins: () => [],
    }, {
      task: "开个新窗口继续做同一个终端项目",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.relevantPatterns).toHaveLength(1);
    expect(response.relevantPatterns[0]).toContain("resume_context");
    expect(response.relevantPatterns[0]).toContain("search_memory");
    expect(response.relevantPatterns[0]).toContain("Recall before repo exploration");
  });

  it("diversifies workflow patterns so strong cue coverage includes search_memory", async () => {
    const pattern = (
      id: string,
      title: string,
      tools: string[],
      steps: string[],
      score: number,
    ): RetrievalResult => withMetadata({
      ...buildResult(id, "patterns", `Workflow pattern: ${title}`),
      score,
      sources: {
        fused: { score },
      },
    }, {
      workflowPattern: {
        title,
        trigger: "When continuing the same project in a fresh terminal window",
        steps,
        tools,
      },
    });

    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "patterns") return [];
        return [
          pattern(
            "pattern-checkpoint",
            "Checkpoint before switching windows",
            ["checkpoint_session"],
            ["Write checkpoint_session before leaving the current window."],
            0.97,
          ),
          pattern(
            "pattern-handoff",
            "Cross-window continuity handoff",
            ["resume_context", "latest_checkpoint"],
            ["Call resume_context before planning work in the fresh window."],
            0.96,
          ),
          pattern(
            "pattern-promote",
            "Promote recurring continuity workflow",
            ["store_workflow_pattern", "/v1/pattern"],
            ["Store recurring continuity workflows as durable patterns."],
            0.95,
          ),
          pattern(
            "pattern-search",
            "Recall before repo exploration",
            ["resume_context", "search_memory"],
            ["Run search_memory with the project name before inspecting local files."],
            0.9,
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
      listPins: () => [],
    }, {
      task: "开个新窗口继续做同一个终端项目",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.relevantPatterns).toHaveLength(3);
    expect(response.relevantPatterns.join("\n")).toContain("search_memory");
    expect(response.relevantPatterns.join("\n")).toContain("Recall before repo exploration");
  });

  it("uses broader workflow fallback when direct continuity patterns miss search_memory coverage", async () => {
    const calls: RetrievalContext[] = [];
    const pattern = (
      id: string,
      title: string,
      tools: string[],
      steps: string[],
    ): RetrievalResult => withMetadata(
      buildResult(id, "patterns", `Workflow pattern: ${title}`),
      {
        workflowPattern: {
          title,
          trigger: "When continuing the same project in a fresh terminal window",
          steps,
          tools,
        },
      },
    );

    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category === "patterns") {
          return [
            pattern(
              "pattern-checkpoint",
              "Checkpoint before switching windows",
              ["checkpoint_session"],
              ["Write checkpoint_session before leaving the current window."],
            ),
            pattern(
              "pattern-handoff",
              "Cross-window continuity handoff",
              ["resume_context", "latest_checkpoint"],
              ["Call resume_context before planning work in the fresh window."],
            ),
            pattern(
              "pattern-promote",
              "Promote recurring continuity workflow",
              ["store_workflow_pattern", "/v1/pattern"],
              ["Store recurring continuity workflows as durable patterns."],
            ),
          ];
        }
        if (!context.category) {
          return [
            withMetadata(
              buildResult(
                "pattern-search",
                "patterns",
                "Workflow pattern: Recall before repo exploration\nUse when: When continuing the same project in a fresh terminal window\nSteps:\n1. Run search_memory with the project name before inspecting local files.\nTools: resume_context, search_memory\nOutcome: Fresh windows recover task detail before repo exploration drifts.",
              ),
              {
                workflowPattern: {
                  title: "Recall before repo exploration",
                  trigger: "When continuing the same project in a fresh terminal window",
                  steps: ["Run search_memory with the project name before inspecting local files."],
                  tools: ["resume_context", "search_memory"],
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
      task: "开个新窗口继续做同一个终端项目",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.relevantPatterns).toHaveLength(3);
    expect(response.relevantPatterns.join("\n")).toContain("search_memory");
    expect(calls.some((call) => !call.category && call.query.includes("search_memory"))).toBe(true);
  });

  it("filters plan-like non-durable pattern notes so workflow fallback can recover durable patterns", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-note",
                "patterns",
                "我先用 resume_context 恢复上下文，再跑 search_memory 看看还有哪些线索。",
              ),
              "cc:working-note",
            ),
          ];
        }
        if (!context.category) {
          return [
            buildResult(
              "pattern-fallback",
              "fact",
              "Workflow pattern: Cross-window continuity handoff Use when: When opening a fresh terminal window for the same project Steps: 1. Call resume_context before coding. 2. Review stable context before reading local files. 3. Save checkpoint_session before leaving the window.",
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

    expect(response.relevantPatterns).toHaveLength(1);
    expect(response.relevantPatterns[0]).toContain("Workflow pattern: Cross-window continuity handoff");
    expect(response.relevantPatterns[0]).toContain("Call resume_context before coding");
    expect(response.relevantPatterns.join(" ")).not.toContain("我先用 resume_context");
    expect(calls.some((call) => !call.category && call.query.includes("checkpoint_session"))).toBe(true);
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

    expect(response.stableContext.join(" ")).toContain(
      "Pinned: 用户视觉审美偏好: 用户常用视觉风格是手绘涂鸦风加高对比撞色；在内容包装和配图生成时，应优先沿用这一审美方向。",
    );
  });

  it("keeps writing-style pins visible for sparse writing prompts", async () => {
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
        id: "pin-writing-style",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "用户写作语气偏好",
        summary: "用户稳定偏好口语化、不端着、可以自嘲但不说教。",
        tags: ["写作", "语气", "风格"],
        source: {
          memoryId: "memory-writing",
          scope: "cc:writing-pin",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "口语化、不端着、可以自嘲",
        path: "/tmp/pin-writing-style.json",
      }],
    }, {
      task: "不要让我重复前情，接着写",
      profile: "writing",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.stableContext).toContain(
      "Pinned: 用户写作语气偏好: 用户稳定偏好口语化、不端着、可以自嘲但不说教。",
    );
  });

  it("keeps Chinese writing pins visible for English writing-project prompts", async () => {
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
        id: "pin-writing-cross-language",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "用户写作语气偏好",
        summary: "用户稳定偏好口语化、不端着、可以自嘲但不说教。",
        tags: ["写作风格", "口语化", "不端着"],
        source: {
          memoryId: "memory-writing-cross-language",
          scope: "cc:writing-pin",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "[助手] 根据你的档案：AI 野路子，不是程序员。公众号「我的AI小木屋」运营者。写作风格：口语化、不端着、可以自嘲但不说教。",
        path: "/tmp/pin-writing-cross-language.json",
      }],
    }, {
      task: "continue my AI writing project",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("写作");
    expect(stableJoined).toContain("AI");
    expect(stableJoined).toContain("公众号");
  });

  it("uses a scope-aware entity fallback query for sparse project prompts", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (
          context.category === "entities" &&
          context.query.includes("recallnest") &&
          context.query.includes("checkpoint_session")
        ) {
          return [
            withMetadata(
              withScope(
                buildResult(
                  "entity-recallnest",
                  "entities",
                  "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.",
                ),
                "memory:project:recallnest",
              ),
              {
                boundary: {
                  layer: "durable",
                  authority: "structured-memory",
                  conflictPolicy: "latest-wins",
                },
                canonicalKey: "entities:recallnest:shared-memory-layer",
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
      task: "继续 RecallNest MCP transport 适配",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(calls.some((call) =>
      call.category === "entities" &&
      call.query.includes("recallnest") &&
      call.query.includes("checkpoint_session")
    )).toBe(true);
    expect(response.stableContext).toContain(
      "Entity: RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.",
    );
    expect(response.stableContext.some((item) => item.startsWith("Task focus:"))).toBe(false);
  });

  it("filters unrelated global entity results from scoped stable recall", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "entities") {
          return [];
        }

        const scopedResult = withScope(
          buildResult(
            "entity-recallnest-scoped",
            "entities",
            "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.",
          ),
          "project:recallnest",
        );

        if (context.scopeFilter?.includes("project:recallnest")) {
          return [scopedResult];
        }

        return [
          scopedResult,
          withScope(
            buildResult(
              "entity-other-project",
              "entities",
              "[project_cmp_status] claude-memory-pro is the current active maintenance target for a different repository.",
            ),
            "project:other",
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
      listPins: () => [],
    }, {
      task: "继续我的项目",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("RecallNest");
    expect(stableJoined).not.toContain("claude-memory-pro");
  });

  it("filters foreign project entities from scoped stable recall when overlap is only shared tool nouns", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "entities") {
          return [];
        }

        return [
          withScope(
            buildResult(
              "entity-recallnest-mcp",
              "entities",
              "RecallNest MCP transport and memory routing stay shared across Claude Code, Codex, and Gemini CLI.",
            ),
            "project:recallnest",
          ),
          withScope(
            buildResult(
              "entity-foreign-mcp",
              "entities",
              "Telegram bridge MCP transport sync handles message relay and adapter wiring.",
            ),
            "project:telegram-bridge",
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
      listPins: () => [],
    }, {
      task: "继续 RecallNest MCP transport 适配",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("RecallNest MCP transport");
    expect(stableJoined).not.toContain("Telegram bridge MCP transport");
  });

  it("filters foreign project patterns and cases from scoped continuity recall when overlap is only shared tool nouns", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-continuity",
                "entities",
                "RecallNest continuity revolves around scoped memory and MCP tooling.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-recallnest-transport",
                "patterns",
                "Workflow pattern: RecallNest MCP transport rollout Tools: resume_context, search_memory Use when: When RecallNest transport wiring changes Steps: 1. Check scoped memory continuity before transport changes.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-foreign-transport",
                "patterns",
                "Workflow pattern: Telegram bridge MCP transport rollout Tools: resume_context, search_memory Use when: When bridge transport wiring changes Steps: 1. Check bridge relay continuity before transport changes.",
              ),
              "project:telegram-bridge",
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-recallnest-transport",
                "cases",
                "Case: RecallNest MCP transport regression Problem: RecallNest transport recall drifted under scoped MCP changes. Solution: tighten scoped recall before transport rollout.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-foreign-transport",
                "cases",
                "Case: Telegram bridge MCP transport regression Problem: bridge relay drifted during MCP transport rollout. Solution: inspect bridge transport sync.",
              ),
              "project:telegram-bridge",
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
      task: "继续 RecallNest continuity MCP transport rollout",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const patternJoined = response.relevantPatterns.join(" ");
    const caseJoined = response.recentCases.join(" ");
    expect(patternJoined).toContain("RecallNest MCP transport rollout");
    expect(patternJoined).not.toContain("Telegram bridge MCP transport rollout");
    expect(caseJoined).toContain("RecallNest MCP transport regression");
    expect(caseJoined).not.toContain("Telegram bridge MCP transport regression");
  });

  it("filters foreign project workflow fallback patterns under scoped continuity recall", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-fallback",
                "entities",
                "RecallNest continuity revolves around scoped memory and MCP tooling.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [];
        }

        if (!context.category) {
          return [
            withScope(
              buildResult(
                "pattern-fallback-recallnest",
                "fact",
                "Workflow pattern: RecallNest MCP transport rollout Tools: resume_context, search_memory Use when: When RecallNest transport wiring changes Steps: 1. Run search_memory before transport rollout.",
              ),
              "memory:project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-fallback-foreign",
                "fact",
                "Workflow pattern: Telegram bridge MCP transport rollout Tools: resume_context, search_memory Use when: When bridge transport wiring changes Steps: 1. Run search_memory before bridge relay rollout.",
              ),
              "memory:project:telegram-bridge",
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
      task: "继续 RecallNest continuity MCP transport rollout",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const patternJoined = response.relevantPatterns.join(" ");
    expect(patternJoined).toContain("RecallNest MCP transport rollout");
    expect(patternJoined).not.toContain("Telegram bridge MCP transport rollout");
  });

  it("filters foreign project cases from scoped continuity recall even when the foreign case mentions RecallNest", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-cases",
                "entities",
                "RecallNest continuity revolves around scoped memory and MCP tooling.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-recallnest-transport-scoped",
                "cases",
                "Case: RecallNest MCP transport regression Problem: RecallNest transport recall drifted under scoped MCP changes. Solution: tighten scoped recall before transport rollout.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-foreign-transport-mentions-recallnest",
                "cases",
                "Case: Telegram bridge MCP transport regression Problem: bridge transport fixes should stay recoverable inside the bridge project without leaking into RecallNest continuity.",
              ),
              "project:telegram-bridge",
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
      task: "继续 RecallNest MCP transport 适配",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const caseJoined = response.recentCases.join(" ");
    expect(caseJoined).toContain("RecallNest MCP transport regression");
    expect(caseJoined).not.toContain("Telegram bridge MCP transport regression");
  });

  it("suppresses project-scoped transport task results for writing-focused tasks with unrelated hints", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-recallnest-transport-writing",
                "patterns",
                "Workflow pattern: RecallNest MCP transport rollout Tools: resume_context, search_memory, eval:continuity Use when: When RecallNest continuity work touches MCP transport wiring under project scope Steps: 1. Call resume_context with project:recallnest before transport changes.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-bridge-transport-writing",
                "cases",
                "Case: Telegram bridge MCP transport regression Problem: bridge transport fixes should stay recoverable inside the bridge project without leaking into RecallNest continuity.",
              ),
              "project:telegram-bridge",
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
      task: "不要让我重复前情，接着写",
      profile: "writing",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.relevantPatterns).toEqual([]);
    expect(response.recentCases).toEqual([]);
  });

  it("suppresses same-project transport and smoke task results for generic scoped prompts", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-generic",
                "entities",
                "RecallNest continuity revolves around scoped memory and startup recovery.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-recallnest-transport-generic",
                "patterns",
                "Workflow pattern: RecallNest MCP transport rollout Tools: resume_context, search_memory, eval:continuity Use when: When RecallNest continuity work touches MCP transport wiring under project scope Steps: 1. Call resume_context with project:recallnest before transport changes.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-smoke-generic",
                "patterns",
                "Workflow pattern: Headless Claude Code continuity smoke Tools: claude, bun run smoke:claude-continuity, resume_context, checkpoint_session Use when: When RecallNest needs a real continuity acceptance check Steps: 1. Run smoke:claude-continuity before shipping continuity changes.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-handoff-generic",
                "patterns",
                "Workflow pattern: Cross-window continuity handoff Tools: resume_context, latest_checkpoint Use when: When opening a fresh terminal window for the same project Steps: 1. Call resume_context before coding.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-recallnest-transport-generic",
                "cases",
                "Case: RecallNest MCP transport regression Problem: Scoped RecallNest continuity work around MCP transport could still drift unless the transport fixes were easy to recover.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-scope-fallback-generic",
                "cases",
                "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: prefer durable cases and patterns.",
              ),
              "project:recallnest",
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
      task: "继续这个项目，不要让我重复前情",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const patternJoined = response.relevantPatterns.join(" ");
    const caseJoined = response.recentCases.join(" ");
    expect(patternJoined).toContain("Cross-window continuity handoff");
    expect(patternJoined).not.toContain("RecallNest MCP transport rollout");
    expect(patternJoined).not.toContain("Headless Claude Code continuity smoke");
    expect(caseJoined).toContain("RecallNest scope fallback cleanup");
    expect(caseJoined).not.toContain("RecallNest MCP transport regression");
  });

  it("suppresses same-project transport and smoke task results for generic named RecallNest tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-named-generic",
                "entities",
                "RecallNest is the shared memory continuity layer across Claude Code, Codex, and Gemini CLI.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-recallnest-transport-named-generic",
                "patterns",
                "Workflow pattern: RecallNest MCP transport rollout Tools: resume_context, search_memory, eval:continuity Use when: When RecallNest continuity work touches MCP transport wiring under project scope Steps: 1. Call resume_context with project:recallnest before transport changes.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-smoke-named-generic",
                "patterns",
                "Workflow pattern: Headless Claude Code continuity smoke Tools: claude, bun run smoke:claude-continuity, resume_context, checkpoint_session Use when: When RecallNest needs a real continuity acceptance check Steps: 1. Run smoke:claude-continuity before shipping continuity changes.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-handoff-named-generic",
                "patterns",
                "Workflow pattern: Cross-window continuity handoff Tools: resume_context, latest_checkpoint Use when: When opening a fresh terminal window for the same project Steps: 1. Call resume_context before coding.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-recallnest-transport-named-generic",
                "cases",
                "Case: RecallNest MCP transport regression Problem: Scoped RecallNest continuity work around MCP transport could still drift unless the transport fixes were easy to recover.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-sparse-startup-named-generic",
                "cases",
                "Case: RecallNest sparse startup context cleanup Problem: resume_context returned noisy transcript fragments and unrelated memories instead of a clean project handoff. Solution: filter low-signal transcripts and backfill stable context from checkpoint decisions.",
              ),
              "project:recallnest",
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
      task: "继续整理 RecallNest 实施清单，不要让我重复前情",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    const patternJoined = response.relevantPatterns.join(" ");
    const caseJoined = response.recentCases.join(" ");
    expect(stableJoined).toContain("RecallNest");
    expect(patternJoined).toContain("Cross-window continuity handoff");
    expect(patternJoined).not.toContain("RecallNest MCP transport rollout");
    expect(patternJoined).not.toContain("Headless Claude Code continuity smoke");
    expect(caseJoined).toContain("RecallNest sparse startup context cleanup");
    expect(caseJoined).not.toContain("RecallNest MCP transport regression");
  });

  it("keeps bridge continuity task results for generic named bridge tasks without leaking RecallNest transport results", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-bridge-named-generic",
                "entities",
                "Telegram bridge keeps relay continuity and adapter wiring stable across fresh windows.",
              ),
              "project:telegram-bridge",
            ),
            withScope(
              buildResult(
                "entity-recallnest-foreign-named-generic",
                "entities",
                "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-bridge-handoff-named-generic",
                "patterns",
                "Workflow pattern: Telegram bridge continuity handoff Tools: resume_context, latest_checkpoint Use when: When continuing bridge work from a fresh window Steps: 1. Recover bridge continuity before editing relay code.",
              ),
              "project:telegram-bridge",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-transport-foreign-named-generic",
                "patterns",
                "Workflow pattern: RecallNest MCP transport rollout Tools: resume_context, search_memory, eval:continuity Use when: When RecallNest continuity work touches MCP transport wiring under project scope Steps: 1. Call resume_context with project:recallnest before transport changes.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-bridge-cleanup-named-generic",
                "cases",
                "Case: Telegram bridge continuity cleanup Problem: bridge handoff notes were too sparse after window switches. Solution: recover bridge context from checkpoint focus and latest relay decisions.",
              ),
              "project:telegram-bridge",
            ),
            withScope(
              buildResult(
                "case-recallnest-transport-foreign-named-generic",
                "cases",
                "Case: RecallNest MCP transport regression Problem: Scoped RecallNest continuity work around MCP transport could still drift unless the transport fixes were easy to recover.",
              ),
              "project:recallnest",
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
      task: "继续看 telegram bridge 项目最近进展，不要让我重复前情",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    const patternJoined = response.relevantPatterns.join(" ");
    const caseJoined = response.recentCases.join(" ");
    expect(stableJoined).toContain("Telegram bridge");
    expect(stableJoined).not.toContain("RecallNest is the shared memory layer");
    expect(patternJoined).toContain("Telegram bridge continuity handoff");
    expect(patternJoined).not.toContain("RecallNest MCP transport rollout");
    expect(caseJoined).toContain("Telegram bridge continuity cleanup");
    expect(caseJoined).not.toContain("RecallNest MCP transport regression");
  });

  it("prefers named non-RecallNest entities over unrelated project entities for unscoped tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "entities") {
          return [];
        }

        return [
          buildResult(
            "entity-recallnest",
            "entities",
            "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.",
          ),
          buildResult(
            "entity-telegram-bridge",
            "entities",
            "Telegram AI bridge handles A2A Claude Agent SDK query debugging and group-chat transport.",
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
        title: "用户写作语气偏好",
        summary: "用户稳定偏好口语化、不端着、可以自嘲但不说教。",
        tags: ["写作", "风格"],
        source: {
          memoryId: "memory-old-pin",
          scope: "memory:agent",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "根据你的档案：GitHub, Claude Code CLI, 本地 Docker。",
        path: "/tmp/pin-writing-style.json",
      }],
    }, {
      task: "A2A code Claude SDK calling error",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("Telegram AI bridge");
    expect(stableJoined).not.toContain("RecallNest is the shared memory layer");
    expect(stableJoined).not.toContain("口语化");
  });

  it("keeps vague associative Nest tasks pointed at RecallNest instead of unrelated entities", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "entities") {
          return [];
        }

        return [
          buildResult(
            "entity-recallnest",
            "entities",
            "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.",
          ),
          buildResult(
            "entity-telegram-bridge",
            "entities",
            "Telegram AI bridge handles A2A Claude Agent SDK query debugging and group-chat transport.",
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
        title: "用户写作语气偏好",
        summary: "用户稳定偏好口语化、不端着、可以自嘲但不说教。",
        tags: ["写作", "风格"],
        source: {
          memoryId: "memory-old-pin",
          scope: "memory:agent",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "根据你的档案：GitHub, Claude Code CLI, 本地 Docker。",
        path: "/tmp/pin-writing-style.json",
      }],
    }, {
      task: "之前弄过那个什么 Nest 的记忆系统",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("RecallNest");
    expect(stableJoined).not.toContain("Telegram AI bridge");
    expect(stableJoined).not.toContain("口语化");
  });

  it("filters conversational transcript pins out of stable context for external bridge tasks", async () => {
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
        id: "pin-bridge-raw",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "[助手] 现在更新 telegram-cli-bridge 自己的 README（已经有旧引用）。",
        summary: "[助手] 现在更新 telegram-cli-bridge 自己的 README（已经有旧引用）。",
        tags: ["telegram", "bridge"],
        source: {
          memoryId: "memory-bridge-raw",
          scope: "cc:bridge-session",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "[助手] 现在更新 telegram-cli-bridge 自己的 README（已经有旧引用）。",
        path: "/tmp/pin-bridge-raw.json",
      }],
    }, {
      task: "继续 telegram ai bridge 项目",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("Task focus:");
    expect(stableJoined).toContain("telegram");
    expect(stableJoined).not.toContain("[助手]");
    expect(stableJoined).not.toContain("README");
  });

  it("filters conversational durable pins out of scoped stable context", async () => {
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
        id: "pin-bridge-durable",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "[助手] 现在更新 telegram-cli-bridge 自己的 README（已经有旧引用）。",
        summary: "[助手] 现在更新 telegram-cli-bridge 自己的 README（已经有旧引用）。",
        tags: ["telegram", "bridge"],
        source: {
          memoryId: "memory-bridge-durable",
          scope: "memory:project:telegram-bridge",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "[助手] 现在更新 telegram-cli-bridge 自己的 README（已经有旧引用）。",
        path: "/tmp/pin-bridge-durable.json",
      }],
    }, {
      task: "继续 RecallNest continuity bridge 适配",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("Task focus: recallnest");
    expect(stableJoined).not.toContain("[助手]");
    expect(stableJoined).not.toContain("README");
    expect(stableJoined).not.toContain("telegram-cli-bridge");
  });

  it("filters foreign project pins from scoped stable context when overlap is only task terms", async () => {
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
        id: "pin-foreign-project",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "Telegram bridge README adaptation plan",
        summary: "Bridge adapter migration notes for telegram-cli-bridge transport and README sync.",
        tags: ["bridge", "readme", "telegram"],
        source: {
          memoryId: "memory-bridge-foreign",
          scope: "memory:project:telegram-bridge",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "adapter migration README sync",
        path: "/tmp/pin-foreign-project.json",
      }],
    }, {
      task: "继续 RecallNest bridge README 适配",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("Task focus: recallnest");
    expect(stableJoined).not.toContain("Telegram bridge README adaptation plan");
    expect(stableJoined).not.toContain("telegram-cli-bridge");
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

  it("filters plan-like non-durable case notes so broader case fallback can recover durable cases", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category !== "cases") return [];
        if (context.query.includes("similar solved case previous fix")) {
          return [
            withScope(
              buildResult(
                "case-note",
                "cases",
                "我先看真实召回密度，确认问题是不是出在 scope 太窄，再决定怎么修复。",
              ),
              "cc:working-note",
            ),
          ];
        }
        if (context.query.includes("root cause workaround cleanup")) {
          return [
            buildResult(
              "case-fallback",
              "cases",
              "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: Reject plan-like transcript snippets and fall back to durable case memories.",
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
    expect(response.recentCases[0]).toContain("Case: RecallNest scope fallback cleanup");
    expect(response.recentCases[0]).toContain("Reject plan-like transcript snippets");
    expect(response.recentCases.join(" ")).not.toContain("我先看真实召回密度");
    expect(calls.some((call) => call.category === "cases" && call.query.includes("root cause workaround cleanup"))).toBe(true);
  });
});
