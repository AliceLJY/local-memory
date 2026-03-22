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
      limitPerSection: 3,
    });

    expect(response.relevantPatterns).toHaveLength(3);
    expect(response.relevantPatterns).toContain(
      "Start fresh windows with resume_context before coding so stable context is restored early.",
    );
    expect(response.relevantPatterns).toContain(
      "If resume_context still leaves gaps, run search_memory with the project name and task nouns before repo exploration drifts.",
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

    expect(response.relevantPatterns).toHaveLength(2);
    expect(response.relevantPatterns[0]).toContain("resume_context");
    expect(response.relevantPatterns[0]).toContain("search_memory");
    expect(response.relevantPatterns[0]).toContain("Recall before repo exploration");
    expect(response.relevantPatterns.join("\n")).toContain("checkpoint_session");
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

  it("supplements continuity workflow coverage with built-in search_memory fallback when retrieval stays sparse", async () => {
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
        if (context.category === "patterns") {
          return [
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

    expect(response.relevantPatterns).toHaveLength(2);
    expect(response.relevantPatterns.join("\n")).toContain("search_memory");
    expect(response.relevantPatterns.join("\n")).toContain("resume_context");
    expect(response.relevantPatterns.join("\n")).not.toContain("Promote recurring continuity workflow");
  });

  it("supplements a single handoff pattern with built-in search_memory guidance when cue coverage is still incomplete", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "patterns") {
          return [
            withMetadata(
              buildResult(
                "pattern-handoff-only",
                "patterns",
                "Workflow pattern: Cross-window continuity handoff",
              ),
              {
                workflowPattern: {
                  title: "Cross-window continuity handoff",
                  trigger: "When opening a fresh terminal window for the same project",
                  tools: ["resume_context", "latest_checkpoint"],
                  steps: ["Call resume_context before planning work in the fresh window."],
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

    expect(response.relevantPatterns.join("\n")).toContain("Cross-window continuity handoff");
    expect(response.relevantPatterns.join("\n")).toContain("search_memory");
    expect(response.relevantPatterns.join("\n")).toContain("resume_context");
  });

  it("supplements a sparse checkpoint-backed project handoff with built-in search_memory guidance", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "patterns") {
          return [
            withMetadata(
              buildResult(
                "pattern-promote-only",
                "patterns",
                "Workflow pattern: Promote recurring continuity workflow",
              ),
              {
                workflowPattern: {
                  title: "Promote recurring continuity workflow",
                  trigger: "When continuity workflows repeat across sessions",
                  tools: ["store_workflow_pattern", "/v1/pattern"],
                  steps: ["Store recurring continuity workflows as durable patterns."],
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
          return {
            checkpointId: "checkpoint-task-pivot",
            sessionId: "task-pivot-session",
            resolvedScope: "project:recallnest",
            summary: "RecallNest 已补上 HTTP auto-recall，下一步把 task-pivot 的主动 recall 变成 smoke 和 eval 的稳定回归信号。",
            task: "RecallNest task-pivot recall regression",
            decisions: ["任务切换时也要先回忆，不能只在 continue 场景触发"],
            openLoops: [],
            nextActions: ["补 task-pivot continuity eval case"],
            entities: ["RecallNest", "auto-recall", "search_memory"],
            files: ["src/context-composer.ts"],
            updatedAt: "2026-03-17T14:40:00.000Z",
          } satisfies SessionCheckpointRecord;
        },
      },
      listPins: () => [],
    }, {
      task: "回到 RecallNest 项目，处理主动 recall regression",
      scope: "project:recallnest",
      includeLatestCheckpoint: true,
      limitPerSection: 3,
    });

    expect(response.relevantPatterns.join("\n")).toContain("search_memory");
    expect(response.relevantPatterns.join("\n")).toContain("resume_context");
  });

  it("supplements a single low-coverage continuity pattern without needing a checkpoint", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "patterns") {
          return [
            withMetadata(
              buildResult(
                "pattern-promote-only-no-checkpoint",
                "patterns",
                "Workflow pattern: Promote recurring continuity workflow",
              ),
              {
                workflowPattern: {
                  title: "Promote recurring continuity workflow",
                  trigger: "When continuity workflows repeat across sessions",
                  tools: ["store_workflow_pattern", "/v1/pattern"],
                  steps: ["Store recurring continuity workflows as durable patterns."],
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
    expect(response.relevantPatterns.join("\n")).toContain("resume_context");
    expect(response.relevantPatterns.join("\n")).toContain("checkpoint");
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

  it("filters transcript-style non-durable pattern fragments for generic RecallNest continues", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-transcript-fragment",
                "patterns",
                "[助手] 对，这次快很多，而且原因很明确。从你这张图看，路径已经变成了：- `resume_context` - 直接回答。不再有这几层绕路：- 本地文件读取 - `search_memory` 二次补查。",
              ),
              "codex:session-fragment",
            ),
          ];
        }
        if (!context.category) {
          return [
            buildResult(
              "pattern-fallback-clean",
              "fact",
              "Workflow pattern: Recall before repo exploration Use when: When a fresh window continues the same project but task details are still sparse Steps: 1. Run search_memory before reading local files. Tools: resume_context, search_memory. Outcome: Fresh windows recover task detail before repo exploration drifts.",
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
      limitPerSection: 2,
    });

    expect(response.relevantPatterns).toHaveLength(1);
    expect(response.relevantPatterns[0]).toContain("Workflow pattern: Recall before repo exploration");
    expect(response.relevantPatterns.join(" ")).not.toContain("这次快很多");
    expect(response.relevantPatterns.join(" ")).not.toContain("直接回答");
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

  it("prioritizes checkpoint summary over checkpoint focus when stable slots are tight", async () => {
    const checkpoint: SessionCheckpointRecord = {
      checkpointId: "checkpoint-task-pivot",
      sessionId: "task-pivot-session",
      resolvedScope: "project:recallnest",
      summary: "RecallNest 已补上 HTTP auto-recall，下一步把 task-pivot 的主动 recall 变成 smoke 和 eval 的稳定回归信号。",
      task: "RecallNest task-pivot recall regression",
      decisions: ["任务切换时也要先回忆，不能只在 continue 场景触发"],
      openLoops: [],
      nextActions: ["补 task-pivot continuity eval case"],
      entities: ["RecallNest", "auto-recall"],
      files: ["src/context-composer.ts"],
      updatedAt: "2026-03-17T14:40:00.000Z",
    };

    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "entities") return [];
        return [
          buildResult(
            "entity-primitives",
            "entities",
            "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
          ),
          buildResult(
            "entity-transport",
            "entities",
            "RecallNest exposes continuity through both HTTP API and MCP.",
          ),
        ];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: {
        async getLatest() {
          return checkpoint;
        },
      },
      listPins: () => [],
    }, {
      task: "回到 RecallNest 项目，处理主动 recall regression",
      scope: "project:recallnest",
      includeLatestCheckpoint: true,
      limitPerSection: 3,
    });

    expect(response.stableContext).toHaveLength(3);
    expect(response.stableContext.some((item) => item.includes("auto-recall"))).toBe(true);
    expect(response.stableContext.some((item) => item.includes("Checkpoint summary:"))).toBe(true);
  });

  it("enriches latest checkpoint summary with missing checkpoint entity hints", async () => {
    const checkpoint: SessionCheckpointRecord = {
      checkpointId: "checkpoint-project-scope",
      sessionId: "eval-project-recallnest-checkpoint",
      resolvedScope: "project:recallnest",
      summary: "RecallNest 项目范围下已完成 continuity baseline setup、doctor baseline 和 headless Claude Code smoke，下一步继续扩 continuity eval case。",
      task: "RecallNest continuity acceptance — project scope handoff",
      decisions: ["继续把 project-scope continuity 做成稳定回归信号"],
      openLoops: [],
      nextActions: ["补更多 scoped project continuity cases"],
      entities: ["RecallNest", "seed:continuity", "doctor", "smoke:claude-continuity"],
      files: ["src/context-composer.ts"],
      updatedAt: "2026-03-17T08:40:00.000Z",
    };

    const response = await composeResumeContext({
      retriever: {
        async retrieve() {
          return [];
        },
      },
      checkpointStore: {
        async getLatest() {
          return checkpoint;
        },
      },
      listPins: () => [],
    }, {
      task: "继续这个项目，不要让我重复前情",
      scope: "project:recallnest",
      includeLatestCheckpoint: true,
      limitPerSection: 3,
    });

    expect(response.latestCheckpoint?.summary).toContain("smoke:claude-continuity");
    expect(response.summary).toContain("smoke:claude-continuity");
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

  it("skips unrelated pins for continuity status prompts when project entity context is already present", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-status",
                "entities",
                "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
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
      listPins: () => [{
        id: "pin-visual-status",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "用户视觉审美偏好",
        summary: "用户常用视觉风格是手绘涂鸦风加高对比撞色；在内容包装和配图生成时，应优先沿用这一审美方向。",
        tags: ["审美偏好", "手绘涂鸦", "高对比撞色", "配图"],
        source: {
          memoryId: "memory-visual-status",
          scope: "cc:visual-pin",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "给刚才写的文章生成配图，风格：手绘涂鸦风+高对比撞色。",
        path: "/tmp/pin-visual-status.json",
      }],
    }, {
      task: "RecallNest 刚才做到哪了",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.stableContext.join(" ")).toContain("RecallNest continuity revolves around three primitives");
    expect(response.stableContext.join(" ")).not.toContain("手绘涂鸦");
  });

  it("suppresses project-scoped smoke-validation preferences for generic shared-memory continues", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "preferences") {
          return [
            withScope(
              buildResult(
                "preference-recallnest-smoke-validation",
                "preferences",
                "在 RecallNest 这条线里，如果需要独立的 Claude Code 验证视角，可以按需直接让 CC 介入做 smoke 或 integration 验收，不必事先再次征求。",
              ),
              "project:recallnest",
            ),
          ];
        }
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-shared-memory",
                "entities",
                "RecallNest exposes continuity through both HTTP API and MCP, so different agents can share one memory layer and the same handoff model.",
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
      task: "把共享记忆这条线接着做",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("share one memory layer");
    expect(stableJoined).not.toContain("Claude Code 验证视角");
    expect(stableJoined).not.toContain("smoke");
    expect(stableJoined).not.toContain("integration 验收");
  });

  it("keeps project-scoped smoke-validation preferences when the task explicitly asks for them", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "preferences") {
          return [
            withScope(
              buildResult(
                "preference-recallnest-smoke-validation-explicit",
                "preferences",
                "在 RecallNest 这条线里，如果需要独立的 Claude Code 验证视角，可以按需直接让 CC 介入做 smoke 或 integration 验收，不必事先再次征求。",
              ),
              "project:recallnest",
            ),
          ];
        }
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-shared-memory-explicit",
                "entities",
                "RecallNest exposes continuity through both HTTP API and MCP, so different agents can share one memory layer and the same handoff model.",
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
      task: "继续做 RecallNest 的 Claude Code smoke integration 验收",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("Claude Code 验证视角");
    expect(stableJoined).toContain("smoke");
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

    // Project-scoped transport patterns should not leak, but the task IS a
    // continuity task ("不要让我重复前情") so built-in continuity guidance is expected.
    const patternJoined = response.relevantPatterns.join("\n");
    expect(patternJoined).not.toContain("RecallNest MCP transport");
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

  it("suppresses same-project doctor and seed task results for generic named RecallNest tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-doctor-generic",
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
                "pattern-recallnest-doctor-generic",
                "patterns",
                "Workflow pattern: RecallNest doctor baseline check Tools: doctor, seed:continuity, eval:continuity Use when: When refreshing RecallNest continuity baseline coverage before release Steps: 1. Run doctor --ci before reseeding continuity material.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-seed-generic",
                "patterns",
                "Workflow pattern: RecallNest seed continuity refresh Tools: seed:continuity, seed:patterns, seed:cases Use when: When continuity seeds or baseline fixtures drift from live durable memory Steps: 1. Reseed continuity material before rerunning eval.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-handoff-doctor-generic",
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
                "case-recallnest-doctor-generic",
                "cases",
                "Case: RecallNest doctor baseline hardening Problem: doctor baseline coverage drifted after continuity helper splits. Solution: tighten doctor checks and reseed continuity material before release.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-seed-generic",
                "cases",
                "Case: RecallNest seed continuity refresh Problem: continuity seeds fell behind the live durable project material after baseline changes. Solution: rerun seed:continuity before eval.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-scope-fallback-doctor-generic",
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
      task: "继续整理 RecallNest 实施清单，不要让我重复前情",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const patternJoined = response.relevantPatterns.join(" ");
    const caseJoined = response.recentCases.join(" ");
    expect(patternJoined).toContain("Cross-window continuity handoff");
    expect(patternJoined).not.toContain("RecallNest doctor baseline check");
    expect(patternJoined).not.toContain("RecallNest seed continuity refresh");
    expect(caseJoined).toContain("RecallNest scope fallback cleanup");
    expect(caseJoined).not.toContain("RecallNest doctor baseline hardening");
    expect(caseJoined).not.toContain("RecallNest seed continuity refresh");
  });

  it("suppresses same-project eval task results for generic checkpoint-led RecallNest continue tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-checkpoint-generic",
                "entities",
                "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
              ),
              "recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-recallnest-eval-generic",
                "patterns",
                "Workflow pattern: Continuity eval regression sweep Tools: eval:continuity, checkpoint_session Use when: When refreshing RecallNest eval fixtures before shipping continuity changes Steps: 1. Re-run eval:continuity with checkpoint fixtures before checking the report.",
              ),
              "recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-handoff-eval-generic",
                "patterns",
                "Workflow pattern: Cross-window continuity handoff Tools: resume_context, latest_checkpoint Use when: When opening a fresh terminal window for the same project Steps: 1. Call resume_context before coding.",
              ),
              "recallnest",
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-recallnest-eval-generic",
                "cases",
                "Case: Continuity eval checkpoint isolation Problem: continuity eval results drifted because they were reading whichever live latest checkpoint happened to exist locally. Solution: build an in-memory checkpoint store from fixture checkpoints before rerunning eval.",
              ),
              "recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-trigger-generic",
                "cases",
                "Case: Three-terminal continuity trigger validation Problem: Claude Code, Codex, and Gemini CLI were configured with MCP but only continue-style prompts triggered recall reliably.",
              ),
              "recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-startup-generic",
                "cases",
                "Case: RecallNest sparse startup context cleanup Problem: resume_context returned noisy transcript fragments instead of a clean project handoff. Solution: filter low-signal transcripts and backfill stable context from checkpoint decisions.",
              ),
              "recallnest",
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
          return {
            checkpointId: "checkpoint-recallnest-generic-eval",
            sessionId: "eval-recallnest-checkpoint",
            resolvedScope: "recallnest",
            summary: "RecallNest Phase 3/4 并行推进中。核心三件套 store_memory、checkpoint_session、resume_context 已上线，当前继续收 resume_context compose。",
            task: "RecallNest continuity layer — 状态交接给下个窗口",
            decisions: ["Phase 3/4 并行推进，continuity layer 是当前核心方向"],
            openLoops: [],
            nextActions: ["继续优化 resume_context compose 质量"],
            entities: ["RecallNest"],
            files: [],
            updatedAt: "2026-03-16T03:30:00.000Z",
          };
        },
      },
      listPins: () => [],
    }, {
      task: "继续 recallnest",
      scope: "recallnest",
      includeLatestCheckpoint: true,
      limitPerSection: 3,
    });

    const patternJoined = response.relevantPatterns.join(" ");
    const caseJoined = response.recentCases.join(" ");
    expect(patternJoined).toContain("Cross-window continuity handoff");
    expect(patternJoined).not.toContain("Continuity eval regression sweep");
    expect(caseJoined).toContain("RecallNest sparse startup context cleanup");
    expect(caseJoined).not.toContain("Continuity eval checkpoint isolation");
    expect(caseJoined).not.toContain("Three-terminal continuity trigger validation");
  });

  it("suppresses same-project workflow observation task results for generic named RecallNest tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-workflow-observation-generic",
                "entities",
                "RecallNest is the shared memory continuity layer across Claude Code, Codex, and Gemini CLI.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [
            withMetadata(
              withScope(
                buildResult(
                  "pattern-recallnest-workflow-observation-generic",
                  "patterns",
                  "continuity、是否被用户纠正、是否重复开 conflict、checkpoint 是否缺失、resume_context 是否被跳过。 如果只选一个最该立刻借的方向，我会选这个：1. 新增 workflow_observe 这一层，append-only。2. 观测对象先只做 workflow_health / workflow_evidence。",
                ),
                "codex:019cfa20",
              ),
              {
                boundary: {
                  layer: "evidence",
                  authority: "transcript-ingest",
                  conflictPolicy: "latest-wins",
                  originalCategory: "patterns",
                },
              },
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-recallnest-workflow-observation-generic",
                "cases",
                "Case: RecallNest workflow observation rollout Problem: workflow_observe and workflow_health were leaking into generic continuity previews. Solution: keep workflow observation surfaces behind explicit task cues.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-scope-fallback-workflow-observation-generic",
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
      task: "继续整理 RecallNest 实施清单，不要让我重复前情",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const patternJoined = response.relevantPatterns.join(" ");
    const caseJoined = response.recentCases.join(" ");
    expect(patternJoined).toContain("resume_context");
    expect(patternJoined).toContain("checkpoint_session");
    expect(patternJoined).not.toContain("workflow_observe");
    expect(patternJoined).not.toContain("workflow_health");
    expect(caseJoined).toContain("RecallNest scope fallback cleanup");
    expect(caseJoined).not.toContain("workflow observation rollout");
  });

  it("suppresses same-project trigger validation task results for generic named RecallNest tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-trigger-generic",
                "entities",
                "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.",
              ),
              "recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-recallnest-handoff-trigger-generic",
                "patterns",
                "Workflow pattern: Cross-window continuity handoff Tools: resume_context, latest_checkpoint Use when: When opening a fresh terminal window for the same project Steps: 1. Call resume_context before coding.",
              ),
              "recallnest",
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-recallnest-trigger-validation-generic",
                "cases",
                "Case: Three-terminal continuity trigger validation Problem: Claude Code, Codex, and Gemini CLI were configured with MCP but only continue-style prompts triggered recall reliably.",
              ),
              "recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-scope-fallback-trigger-generic",
                "cases",
                "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: prefer durable cases and patterns.",
              ),
              "recallnest",
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

    const caseJoined = response.recentCases.join(" ");
    expect(caseJoined).toContain("RecallNest scope fallback cleanup");
    expect(caseJoined).not.toContain("Three-terminal continuity trigger validation");
    expect(caseJoined).not.toContain("continue-style prompts triggered recall reliably");
  });

  it("suppresses same-project pin maintenance task results for generic RecallNest project-context tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-project-context-pins",
                "entities",
                "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-recallnest-project-context-handoff",
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
                "case-recallnest-project-context-startup",
                "cases",
                "Case: RecallNest sparse startup context cleanup Problem: resume_context returned noisy transcript fragments instead of a clean project handoff. Solution: filter low-signal transcripts and backfill stable context from checkpoint decisions.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-project-context-conversational-pins",
                "cases",
                "Case: Scoped recall leaked conversational durable pins Problem: Scoped resume_context could still surface raw `[助手]/[用户]` bridge transcript pins after they had been pinned into durable memory, polluting `project:recallnest` requests with external `telegram-cli-bridge` content.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-project-context-pin-collision",
                "cases",
                "Case: Scoped mixed-project pin collision leaked foreign project summaries Problem: When `resume_context` had an explicit `project:*` scope, pinned summaries from another `project:*` scope could still enter stable context if they matched overlapping task nouns such as `bridge` or `README`.",
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
      task: "一起继续排查 RecallNest 的连续性问题",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const caseJoined = response.recentCases.join(" ");
    expect(caseJoined).toContain("RecallNest sparse startup context cleanup");
    expect(caseJoined).not.toContain("Scoped recall leaked conversational durable pins");
    expect(caseJoined).not.toContain("Scoped mixed-project pin collision leaked foreign project summaries");
    expect(caseJoined).not.toContain("telegram-cli-bridge");
  });

  it("suppresses same-project scoped collision maintenance cases for generic RecallNest tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-generic-scoped-collision",
                "entities",
                "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
              ),
              "project:recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-recallnest-generic-scoped-collision",
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
                "case-recallnest-generic-startup-scoped-collision",
                "cases",
                "Case: RecallNest sparse startup context cleanup Problem: resume_context returned noisy transcript fragments instead of a clean project handoff. Solution: filter low-signal transcripts and backfill stable context from checkpoint decisions.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-generic-entity-collision",
                "cases",
                "Case: Scoped entity recall leaked foreign project entities via shared tool nouns Problem: With an explicit `project:*` scope, scoped entity recall could still include foreign-project entities if they matched shared tool nouns such as `MCP` or `transport`.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-generic-task-result-collision",
                "cases",
                "Case: Scoped task results leaked foreign project patterns and cases Problem: With an explicit `project:*` scope, `relevantPatterns` and `recentCases` could still include foreign-project results when they matched shared tool nouns such as `MCP` or `transport`.",
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

    const caseJoined = response.recentCases.join(" ");
    expect(caseJoined).toContain("RecallNest sparse startup context cleanup");
    expect(caseJoined).not.toContain("Scoped entity recall leaked foreign project entities via shared tool nouns");
    expect(caseJoined).not.toContain("Scoped task results leaked foreign project patterns and cases");
    expect(caseJoined).not.toContain("shared tool nouns");
  });

  it("suppresses workflow promotion patterns for generic named RecallNest tasks and backfills continuity guidance", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-generic-workflow-promotion",
                "entities",
                "RecallNest is the shared memory continuity layer across Claude Code, Codex, and Gemini CLI.",
              ),
              "recallnest",
            ),
          ];
        }

        if (context.category === "patterns") {
          return [
            withMetadata(
              withScope(
                buildResult(
                  "pattern-recallnest-generic-workflow-promotion",
                  "patterns",
                  "Workflow pattern: Promote recurring continuity workflow Tools: store_workflow_pattern, /v1/pattern Use when: When the same startup or handoff workflow repeats across multiple windows Steps: 1. Rewrite the workflow as a reusable pattern.",
                ),
                "recallnest",
              ),
              {
                boundary: {
                  layer: "durable",
                  authority: "structured-memory",
                  conflictPolicy: "append-only",
                  originalCategory: "patterns",
                },
                canonicalKey: "patterns:promote-recurring-continuity-workflow",
              },
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withMetadata(
              withScope(
                buildResult(
                  "case-recallnest-generic-workflow-promotion",
                  "cases",
                  "Case: RecallNest sparse startup context cleanup Problem: resume_context returned noisy transcript fragments instead of a clean project handoff. Solution: filter low-signal transcripts and backfill stable context from checkpoint decisions.",
                ),
                "recallnest",
              ),
              {
                boundary: {
                  layer: "durable",
                  authority: "structured-memory",
                  conflictPolicy: "append-only",
                  originalCategory: "cases",
                },
                canonicalKey: "cases:recallnest-sparse-startup-context-cleanup",
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
      task: "继续整理 RecallNest 实施清单，不要让我重复前情",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const patternJoined = response.relevantPatterns.join(" ");
    expect(patternJoined).not.toContain("Promote recurring continuity workflow");
    expect(patternJoined).not.toContain("store_workflow_pattern");
    expect(patternJoined).toContain("resume_context");
    expect(patternJoined).toContain("search_memory");
    expect(patternJoined).toContain("checkpoint_session");
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

  it("filters bare recallnest continuity seeds from unscoped external bridge tasks while keeping generic handoff guidance", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-seeded-recallnest-handoff",
                "patterns",
                "Workflow pattern: Scoped project continuity recall Tools: resume_context, latest_checkpoint, search_memory Use when: When continuing a named project that already has a shared scope or project key Steps: 1. Call resume_context before repo exploration.",
              ),
              "recallnest",
            ),
          ];
        }

        if (context.category === "cases") {
          return [
            withScope(
              buildResult(
                "case-seeded-recallnest-startup",
                "cases",
                "Case: RecallNest sparse startup context cleanup Problem: resume_context returned noisy transcript fragments and unrelated memories instead of a clean project handoff.",
              ),
              "recallnest",
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
      task: "继续 telegram ai bridge 项目",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.stableContext.join(" ")).toContain("telegram");
    expect(response.relevantPatterns.join(" ")).toContain("resume_context");
    expect(response.relevantPatterns.join(" ")).toContain("search_memory");
    expect(response.relevantPatterns.join(" ")).toContain("checkpoint_session");
    expect(response.relevantPatterns.join(" ")).not.toContain("RecallNest");
    expect(response.recentCases).toEqual([]);
  });

  it("filters foreign durable case memories from generic scopes for unscoped external bridge tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") {
          return [];
        }

        return [
          buildResult(
            "case-memory-agent-recallnest-foreign",
            "cases",
            "Case: RecallNest sparse startup context cleanup Problem: resume_context returned noisy transcript fragments and unrelated memories instead of a clean project handoff.",
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
      task: "继续 telegram ai bridge 项目",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.stableContext.join(" ")).toContain("telegram");
    expect(response.recentCases).toEqual([]);
  });

  it("prefers transport-specific results over generic bare recallnest continuity seeds", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-seeded-recallnest-handoff-transport",
                "patterns",
                "Workflow pattern: Scoped project continuity recall Tools: resume_context, latest_checkpoint, search_memory Use when: When continuing a named project that already has a shared scope or project key Steps: 1. Call resume_context before repo exploration.",
              ),
              "recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-transport-seeded-specific",
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
                "case-seeded-recallnest-validation",
                "cases",
                "Case: Three-terminal continuity trigger validation Problem: Claude Code, Codex, and Gemini CLI were configured with MCP but only continue-style prompts triggered recall reliably.",
              ),
              "recallnest",
            ),
            withScope(
              buildResult(
                "case-recallnest-transport-seeded-specific",
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
      task: "继续 RecallNest continuity MCP transport rollout",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.relevantPatterns.join(" ")).toContain("RecallNest MCP transport rollout");
    expect(response.recentCases.join(" ")).toContain("RecallNest MCP transport regression");
  });

  it("keeps transport-specific patterns ahead of generic continuity diversity fillers", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "patterns") {
          return [
            withScope(
              buildResult(
                "pattern-recallnest-generic-scoped-project",
                "patterns",
                "Workflow pattern: Scoped project continuity recall Tools: resume_context, latest_checkpoint, search_memory Use when: When continuing a named project that already has a shared scope or project key Steps: 1. Call resume_context before repo exploration.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-generic-handoff",
                "patterns",
                "Workflow pattern: Cross-window continuity handoff Tools: resume_context, latest_checkpoint Use when: When opening a fresh terminal window for the same project Steps: 1. Call resume_context before coding.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-generic-search",
                "patterns",
                "Workflow pattern: Recall before repo exploration Tools: resume_context, search_memory Use when: When a fresh window continues the same project but task details are still sparse Steps: 1. Run search_memory before reading local files.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "pattern-recallnest-transport-priority",
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
                "case-recallnest-transport-priority",
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
      task: "继续 RecallNest continuity MCP transport rollout",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.relevantPatterns.join(" ")).toContain("RecallNest MCP transport rollout");
    expect(response.recentCases.join(" ")).toContain("RecallNest MCP transport regression");
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

  it("keeps later entity cues from long unscoped task prompts", async () => {
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
      listPins: () => [],
    }, {
      task: "继续 context composer helper boundary audit ranking scoring selection orchestration stable fallback cleanup regression hardening A2A Claude SDK calling error",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("Telegram AI bridge");
    expect(stableJoined).not.toContain("RecallNest is the shared memory layer");
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

  it("uses an associative Nest fallback query to recover continuity primitives for vague RecallNest tasks", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category !== "entities") {
          return [];
        }

        if (context.query.includes("checkpoint_session")) {
          return [
            buildResult(
              "entity-primitives",
              "entities",
              "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
            ),
          ];
        }

        return [
          buildResult(
            "entity-recallnest",
            "entities",
            "RecallNest is the shared memory layer for Claude Code, Codex, and Gemini CLI.",
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
      task: "之前弄过那个什么 Nest 的记忆系统",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("RecallNest");
    expect(stableJoined).toContain("checkpoint_session");
    expect(calls.filter((call) => call.category === "entities")).toHaveLength(2);
    expect(calls.some((call) => call.category === "entities" && call.query.includes("checkpoint_session"))).toBe(true);
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

  it("uses RecallNest task focus for vague memory-layer continuity prompts instead of unrelated pins", async () => {
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
        id: "pin-visual-memory-layer",
        type: "pinned-memory",
        createdAt: "2026-03-16T04:00:00.000Z",
        updatedAt: "2026-03-16T04:00:00.000Z",
        title: "用户视觉审美偏好",
        summary: "用户常用视觉风格是手绘涂鸦风加高对比撞色；在内容包装和配图生成时，应优先沿用这一审美方向。",
        tags: ["审美偏好", "手绘涂鸦", "高对比撞色", "给刚才写的文章生成配图"],
        source: {
          memoryId: "memory-visual-memory-layer",
          scope: "cc:visual-pin",
          timestamp: Date.parse("2026-03-16T04:00:00.000Z"),
          metadata: {},
        },
        snippet: "给刚才写的文章生成配图，风格：手绘涂鸦风+高对比撞色。",
        path: "/tmp/pin-visual-memory-layer.json",
      }],
    }, {
      task: "把刚才那个 memory layer 接回去",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("Task focus: recallnest");
    expect(stableJoined).not.toContain("手绘涂鸦");
  });

  it("uses RecallNest task focus for vague cross-window memory-system prompts", async () => {
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
      task: "继续那个跨窗口记忆系统",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("Task focus: recallnest");
    expect(stableJoined).not.toContain("Task focus: 窗口");
  });

  it("uses an associative RecallNest fallback query for colloquial cross-window memory shorthand", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category !== "entities") {
          return [];
        }

        if (context.query.includes("checkpoint_session")) {
          return [
            buildResult(
              "entity-cross-window-memory-primitives",
              "entities",
              "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
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
      task: "把那条跨窗口记忆的活接着弄完",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("RecallNest");
    expect(stableJoined).toContain("checkpoint_session");
    expect(calls.filter((call) => call.category === "entities")).toHaveLength(2);
    expect(calls.some((call) =>
      call.category === "entities" &&
      call.query.includes("RecallNest") &&
      call.query.includes("checkpoint_session")
    )).toBe(true);
  });

  it("uses RecallNest task focus for vague multi-window memory shorthand", async () => {
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
      task: "继续弄那个多窗口记忆",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("Task focus: recallnest");
    expect(stableJoined).not.toContain("Task focus: 记忆");
  });

  it("treats recall-pipeline shorthand as a continuity prompt", async () => {
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
      task: "把之前那套 recall 管线先捡起来",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.stableContext).toContain("Task focus: recallnest");
    expect(response.relevantPatterns.join(" ")).toContain("resume_context");
  });

  it("keeps later task focus terms from long sparse prompts", async () => {
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
      task: "继续 context composer helper boundary audit ranking scoring selection orchestration stable fallback cleanup regression hardening recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.stableContext).toContain("Task focus: recallnest");
  });

  it("treats vague memory-layer shorthand as a continuity prompt", async () => {
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
      task: "把记忆层这条线先续上",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    expect(response.stableContext).toContain("Task focus: recallnest");
    expect(response.relevantPatterns.join(" ")).toContain("resume_context");
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

  it("filters non-durable query-analysis case notes from broad fallback results", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        if (context.query.includes("similar solved case previous fix")) {
          return [];
        }
        return [
          withScope(
            buildResult(
              "case-query-note",
              "cases",
              "[助手] fallback query 本身也值得看一眼，`case solution fix root cause workaround cleanup continuity` 这串很可能把 A2A repair case 一起拉进来了。",
            ),
            "codex:query-note",
          ),
          withScope(
            buildResult(
              "case-fallback-cleanup-structured",
              "cases",
              "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: reject noisy transcript fragments and prefer durable continuity material.",
            ),
            "project:recallnest",
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

    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
    expect(response.recentCases.join(" ")).not.toContain("fallback query 本身也值得看一眼");
    expect(response.recentCases.join(" ")).not.toContain("A2A repair case");
  });

  it("suppresses eval-profile maintenance cases for sparse project-scoped continues", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        return [
          withScope(
            buildResult(
              "case-profile-forwarding-gap",
              "cases",
              "Case: Continuity eval profile forwarding gap Problem: A continuity eval case that used profile: writing still failed on sparse writing prompts even after composeResumeContext had the right sparse-style fallback behavior. Solution: forward the eval profile into resume_context requests.",
            ),
            "project:recallnest",
          ),
          withScope(
            buildResult(
              "case-scope-fallback-cleanup",
              "cases",
              "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: prefer durable cases and patterns.",
            ),
            "project:recallnest",
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
      task: "继续这个项目，不要让我重复前情",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
    expect(response.recentCases.join(" ")).not.toContain("profile forwarding gap");
    expect(response.recentCases.join(" ")).not.toContain("sparse writing prompts");
    expect(response.recentCases.join(" ")).not.toContain("profile: writing");
  });

  it("allows eval-profile maintenance cases for explicit eval-profile debugging tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        return [
          withScope(
            buildResult(
              "case-profile-forwarding-gap",
              "cases",
              "Case: Continuity eval profile forwarding gap Problem: A continuity eval case that used profile: writing still failed on sparse writing prompts even after composeResumeContext had the right sparse-style fallback behavior. Solution: forward the eval profile into resume_context requests.",
            ),
            "project:recallnest",
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
      task: "继续排查 continuity eval profile forwarding gap 的 sparse writing prompts 回归",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases.join(" ")).toContain("profile forwarding gap");
    expect(response.recentCases.join(" ")).toContain("profile: writing");
    expect(response.recentCases.join(" ")).toContain("sparse writing prompts");
  });

  it("suppresses eval-profile maintenance cases for adjacent writing-slot engineering tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        return [
          withScope(
            buildResult(
              "case-profile-forwarding-gap",
              "cases",
              "Case: Continuity eval profile forwarding gap Problem: A continuity eval case that used profile: writing still failed on sparse writing prompts even after composeResumeContext had the right sparse-style fallback behavior. Solution: forward the eval profile into resume_context requests.",
            ),
            "project:recallnest",
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
      task: "继续收 RecallNest 写作风格偏好存储",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases).toHaveLength(0);
  });

  it("suppresses eval-runner maintenance cases for sparse scoped project prompts", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        return [
          withScope(
            buildResult(
              "case-eval-runner-shared-components",
              "cases",
              "Case: Eval runner shared components skewed later continuity previews Problem: Continuity eval reports could diverge from single-case replay because shared components let earlier retrieval state bleed into later preview composition. Solution: move continuity eval to per-case fresh components and verify against fresh-window replay.",
            ),
            "project:recallnest",
          ),
          withScope(
            buildResult(
              "case-scope-fallback-cleanup",
              "cases",
              "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: prefer durable cases and patterns.",
            ),
            "project:recallnest",
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

    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
    expect(response.recentCases.join(" ")).not.toContain("shared components skewed later continuity previews");
    expect(response.recentCases.join(" ")).not.toContain("single-case replay");
    expect(response.recentCases.join(" ")).not.toContain("per-case fresh components");
  });

  it("allows eval-runner maintenance cases for explicit eval-runner debugging tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        return [
          withScope(
            buildResult(
              "case-eval-runner-shared-components",
              "cases",
              "Case: Eval runner shared components skewed later continuity previews Problem: Continuity eval reports could diverge from single-case replay because shared components let earlier retrieval state bleed into later preview composition. Solution: move continuity eval to per-case fresh components and verify against fresh-window replay.",
            ),
            "project:recallnest",
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
      task: "继续排查 eval runner isolation 的 single-case replay 差异",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases.join(" ")).toContain("shared components skewed later continuity previews");
    expect(response.recentCases.join(" ")).toContain("single-case replay");
    expect(response.recentCases).toHaveLength(1);
  });

  it("suppresses eval-runner maintenance cases for adjacent component refactor tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        return [
          withScope(
            buildResult(
              "case-eval-runner-shared-components",
              "cases",
              "Case: Eval runner shared components skewed later continuity previews Problem: Continuity eval reports could diverge from single-case replay because shared components let earlier retrieval state bleed into later preview composition. Solution: move continuity eval to per-case fresh components and verify against fresh-window replay.",
            ),
            "project:recallnest",
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
      task: "继续拆 context-composer 组件边界",
      scope: "project:recallnest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases).toHaveLength(0);
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
        if (
          context.query.includes("scope fallback") &&
          context.query.includes("project scope") &&
          context.query.includes("handoff")
        ) {
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
    expect(calls.some((call) =>
      call.category === "cases" &&
      call.query.includes("scope fallback") &&
      call.query.includes("project scope") &&
      call.query.includes("handoff")
    )).toBe(true);
  });

  it("uses a scope-handoff flavored fallback query for generic named RecallNest continue tasks", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category !== "cases") return [];
        if (context.query.includes("similar solved case previous fix")) {
          return [
            withScope(
              buildResult(
                "case-sparse-validation",
                "cases",
                "Case: Three-terminal continuity trigger validation Problem: Claude Code, Codex, and Gemini CLI were configured with MCP but only continue-style prompts triggered recall reliably.",
              ),
              "recallnest",
            ),
          ];
        }
        if (
          context.query.includes("scope fallback") &&
          context.query.includes("project scope") &&
          context.query.includes("handoff")
        ) {
          return [
            withScope(
              buildResult(
                "case-fallback-cleanup",
                "cases",
                "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: prefer durable cases and patterns.",
              ),
              "recallnest",
            ),
          ];
        }
        if (context.query.includes("root cause workaround cleanup")) {
          return [
            withScope(
              buildResult(
                "case-a2a-noise",
                "cases",
                "Case: Borderline transcript dedup swallowed incremental A2A details Problem: Transcript ingest was dropping same-topic A2A upgrade chunks that added new implementation detail.",
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

    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
    expect(response.recentCases.join(" ")).not.toContain("incremental A2A details");
    expect(calls.some((call) =>
      call.category === "cases" &&
      call.query.includes("scope fallback") &&
      call.query.includes("project scope") &&
      call.query.includes("handoff")
    )).toBe(true);
  });

  it("widens the case fallback candidate pool so generic RecallNest continues can still recover cleanup cases", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category !== "cases") return [];
        if (context.query.includes("similar solved case previous fix")) {
          return [
            withScope(
              buildResult(
                "case-direct-note",
                "cases",
                "[助手] 我先看 case fallback 能不能把 RecallNest continuity 的 recentCases 补起来。",
              ),
              "codex:working-note",
            ),
          ];
        }
        if (
          context.query.includes("scope fallback") &&
          context.query.includes("project scope") &&
          context.query.includes("handoff")
        ) {
          const noisyResults = [
            withScope(
              buildResult(
                "case-noisy-meta",
                "cases",
                "Case: Fallback-query meta case leaked into generic RecallNest previews Problem: Generic status prompts surfaced fallback-query cleanup notes instead of cleanup cases. Solution: keep query-analysis notes behind explicit ranking cues.",
              ),
              "project:recallnest",
            ),
            withScope(
              buildResult(
                "case-noisy-pins",
                "cases",
                "Case: Scoped recall leaked conversational durable pins Problem: Scoped resume_context could still surface raw bridge transcript pins after they had been pinned into durable memory.",
              ),
              "project:recallnest",
            ),
          ];
          if (context.limit < 8) return noisyResults;
          return [
            ...noisyResults,
            withScope(
              buildResult(
                "case-fallback-cleanup-wide-pool",
                "cases",
                "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: prefer durable cases and patterns.",
              ),
              "recallnest",
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
      task: "回到 RecallNest 继续做",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
    expect(calls.some((call) =>
      call.category === "cases" &&
      call.query.includes("scope fallback") &&
      call.limit >= 8
    )).toBe(true);
  });

  it("backfills continuity guidance for conversational named RecallNest project continues", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-conversational",
                "entities",
                "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
              ),
              "project:recallnest",
            ),
          ];
        }
        if (
          context.category === "cases" &&
          context.query.includes("scope fallback") &&
          context.query.includes("project scope") &&
          context.query.includes("handoff")
        ) {
          return [
            withScope(
              buildResult(
                "case-fallback-conversational",
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
      task: "接着做 RecallNest 这个项目",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.relevantPatterns.join(" ")).toContain("resume_context");
    expect(response.relevantPatterns.join(" ")).toContain("search_memory");
    expect(response.relevantPatterns.join(" ")).toContain("checkpoint_session");
    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
  });

  it("backfills continuity guidance for named RecallNest continues without project nouns", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-named-no-project-noun",
                "entities",
                "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
              ),
              "project:recallnest",
            ),
          ];
        }
        if (
          context.category === "cases" &&
          context.query.includes("scope fallback") &&
          context.query.includes("project scope") &&
          context.query.includes("handoff")
        ) {
          return [
            withScope(
              buildResult(
                "case-fallback-named-no-project-noun",
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
      task: "回到 RecallNest 继续做",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.relevantPatterns.join(" ")).toContain("resume_context");
    expect(response.relevantPatterns.join(" ")).toContain("search_memory");
    expect(response.relevantPatterns.join(" ")).toContain("checkpoint_session");
    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
  });

  it("suppresses same-project cue-coverage maintenance cases for generic RecallNest continues", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities") {
          return [
            withScope(
              buildResult(
                "entity-recallnest-generic-cue-coverage",
                "entities",
                "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
              ),
              "project:recallnest",
            ),
          ];
        }
        if (context.category !== "cases") return [];
        return [
          withScope(
            buildResult(
              "case-recallnest-cue-coverage",
              "cases",
              "Case: Conversational named RecallNest continue prompts missed continuity guidance Problem: Conversational named RecallNest continue prompts like `接着做 RecallNest 这个项目` recovered entity/case context but missed built-in guidance. Solution: broaden cue coverage and add a regression.",
            ),
            "project:recallnest",
          ),
          withScope(
            buildResult(
              "case-recallnest-scope-fallback-generic-cue-coverage",
              "cases",
              "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: prefer durable cases and patterns.",
            ),
            "project:recallnest",
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
      task: "回到 RecallNest 继续做",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
    expect(response.recentCases.join(" ")).not.toContain("missed continuity guidance");
  });

  it("suppresses fallback-query meta maintenance cases for generic RecallNest status prompts", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        return [
          withScope(
            buildResult(
              "case-fallback-query-meta",
              "cases",
              "Case: Broad case fallback query surfaced query-analysis assistant notes Problem: A broad case fallback query started surfacing query-analysis assistant notes as recentCases. Solution: tighten structured case detection and keep non-durable assistant notes out.",
            ),
            "project:recallnest",
          ),
          withScope(
            buildResult(
              "case-recallnest-scope-fallback-status",
              "cases",
              "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: prefer durable cases and patterns.",
            ),
            "project:recallnest",
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
      task: "RecallNest 刚才做到哪了",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
    expect(response.recentCases.join(" ")).not.toContain("fallback query");
    expect(response.recentCases.join(" ")).not.toContain("query-analysis assistant notes");
  });

  it("suppresses same-project A2A dedup maintenance cases for generic RecallNest project continues", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        return [
          withScope(
            buildResult(
              "case-a2a-noise",
              "cases",
              "Case: Borderline transcript dedup swallowed incremental A2A details Problem: Transcript ingest was dropping same-topic A2A upgrade chunks that added new implementation detail.",
            ),
            "project:recallnest",
          ),
          withScope(
            buildResult(
              "case-fallback-cleanup",
              "cases",
              "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: prefer durable cases and patterns.",
            ),
            "project:recallnest",
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
      scope: "project:recallnest",
      task: "继续 RecallNest 项目",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
    expect(response.recentCases.join(" ")).not.toContain("incremental A2A details");
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
        if (
          context.query.includes("scope fallback") &&
          context.query.includes("project scope") &&
          context.query.includes("handoff")
        ) {
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
    expect(calls.some((call) =>
      call.category === "cases" &&
      call.query.includes("scope fallback") &&
      call.query.includes("project scope") &&
      call.query.includes("handoff")
    )).toBe(true);
  });

  it("suppresses transcript-fragment meta cases so generic RecallNest continues keep cleanup cases", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        return [
          withScope(
            buildResult(
              "case-transcript-fragment-meta",
              "cases",
              "Case: Transcript-style pattern fragment leaked into generic continuity preview Problem: Generic RecallNest continue prompts could surface non-durable transcript fragments in relevantPatterns when the fragment mentioned workflow cues like resume_context and search_memory.",
            ),
            "project:recallnest",
          ),
          withScope(
            buildResult(
              "case-scope-fallback-cleanup",
              "cases",
              "Case: RecallNest scope fallback cleanup Problem: resume_context stayed too narrow on project scope and surfaced ongoing notes instead of stable handoff context. Solution: prefer durable cases and patterns.",
            ),
            "recallnest",
          ),
          withScope(
            buildResult(
              "case-sparse-startup-cleanup",
              "cases",
              "Case: RecallNest sparse startup context cleanup Problem: resume_context was returning noisy transcript fragments and unrelated memories instead of a clean RecallNest continuity handoff. Solution: filter low-signal transcripts and backfill stable context from checkpoint decisions.",
            ),
            "recallnest",
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
      scope: "project:recallnest",
      task: "回到 RecallNest 继续做",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases.join(" ")).toContain("RecallNest scope fallback cleanup");
    expect(response.recentCases.join(" ")).toContain("RecallNest sparse startup context cleanup");
    expect(response.recentCases.join(" ")).not.toContain("Transcript-style pattern fragment leaked");
    expect(response.recentCases.join(" ")).not.toContain("relevantPatterns");
  });

  it("suppresses distillation workflow patterns for generic RecallNest continues", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "patterns") {
          return [
            buildResult(
              "pattern-scoped-continuity-minimal",
              "patterns",
              "Workflow pattern: Scoped project continuity recall Tools: resume_context Use when: When continuing a named project that already has a shared scope or project key Steps: 1. Call resume_context with the project scope when it is known.",
            ),
          ];
        }
        if (
          !context.category &&
          context.query.includes("search_memory") &&
          context.query.includes("checkpoint_session") &&
          context.query.includes("workflow pattern steps")
        ) {
          return [
            buildResult(
              "pattern-distillation-workflow",
              "patterns",
              "Workflow pattern: Bulk Fact Distillation With Checkpointing Tools: bun, scripts/distill-facts.ts, health-check.ts Use when: When running or resuming large fact distillation jobs across many scopes. Steps: 1. Use scripts/distill-facts.ts with smartExtractBatch on qwen-turbo for batch extraction.",
            ),
            buildResult(
              "pattern-cross-window-handoff",
              "patterns",
              "Workflow pattern: Cross-window continuity handoff Tools: resume_context, latest_checkpoint Use when: When opening a fresh terminal window for the same project or after context loss Steps: 1. Call resume_context before coding.",
            ),
            buildResult(
              "pattern-recall-before-repo",
              "patterns",
              "Workflow pattern: Recall before repo exploration Tools: resume_context, search_memory Use when: When a fresh window continues an existing project and startup context still looks sparse Steps: 1. Call resume_context before repo exploration. 2. Run search_memory with the project name and task nouns.",
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
      scope: "project:recallnest",
      task: "继续 RecallNest",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.relevantPatterns.join(" ")).toContain("Scoped project continuity recall");
    expect(response.relevantPatterns.join(" ")).toContain("Cross-window continuity handoff");
    expect(response.relevantPatterns.join(" ")).toContain("Recall before repo exploration");
    expect(response.relevantPatterns.join(" ")).not.toContain("Bulk Fact Distillation With Checkpointing");
    expect(response.relevantPatterns.join(" ")).not.toContain("qwen-turbo");
  });

  it("filters non-canonical durable case distillations from session scopes for vague unscoped tasks", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category !== "cases") return [];
        return [
          withMetadata(
            withScope(
              buildResult(
                "case-distilled-summary",
                "cases",
                "记录了多个技术问题的修复方案，包括环境变量、SSE 事件缓冲、Session ID 解析等",
              ),
              "cc:7acc774e",
            ),
            {
              boundary: {
                layer: "durable",
                authority: "distillation",
                conflictPolicy: "append-only",
                originalCategory: "cases",
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
      task: "之前我记得有个关于",
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.recentCases).toEqual([]);
  });

  it.each([
    "接着上个窗口的写作风格",
    "继续上个窗口的写作偏好",
    "resume writing style from last window",
    "回到上次写作项目 继续调整 tone",
  ])("mixed style+continuity prompt still gets continuity guidance: %s", async (task) => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "patterns") {
          return [
            withMetadata(
              buildResult(
                "pattern-recall",
                "patterns",
                "Workflow pattern: Recall before repo exploration",
              ),
              {
                workflowPattern: {
                  title: "Recall before repo exploration",
                  trigger: "When a fresh window continues an existing project",
                  steps: [
                    "Call resume_context before reading local files.",
                    "Run search_memory with project name and task nouns.",
                  ],
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
      checkpointStore: { async getLatest() { return null; } },
      listPins: () => [],
    }, {
      task,
      includeLatestCheckpoint: false,
      limitPerSection: 3,
    });

    expect(response.relevantPatterns.length).toBeGreaterThan(0);
    expect(response.relevantPatterns.join("\n")).toContain("resume_context");
  });

  it("treats 跨终端记忆/记忆功能 shorthand as associative RecallNest cue", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category === "entities" && context.query.includes("checkpoint_session")) {
          return [
            buildResult(
              "entity-cross-terminal-primitives",
              "entities",
              "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
            ),
          ];
        }
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: { async getLatest() { return null; } },
      listPins: () => [],
    }, {
      task: "继续那个跨终端记忆",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("RecallNest");
    expect(response.relevantPatterns.join(" ")).toContain("resume_context");
  });

  it("treats 记忆功能 with 上次 as continuity prompt", async () => {
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        if (context.category === "entities" && context.query.includes("checkpoint_session")) {
          return [
            buildResult(
              "entity-memory-function-primitives",
              "entities",
              "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
            ),
          ];
        }
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: { async getLatest() { return null; } },
      listPins: () => [],
    }, {
      task: "上次做的那个记忆功能",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("RecallNest");
  });

  it("treats 记忆项目 shorthand as a continuity prompt with RecallNest hints", async () => {
    const calls: RetrievalContext[] = [];
    const retriever = {
      async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
        calls.push(context);
        if (context.category === "entities" && context.query.includes("checkpoint_session")) {
          return [
            buildResult(
              "entity-memory-project-primitives",
              "entities",
              "RecallNest continuity revolves around three primitives: store_memory, checkpoint_session, and resume_context.",
            ),
          ];
        }
        return [];
      },
    };

    const response = await composeResumeContext({
      retriever,
      checkpointStore: { async getLatest() { return null; } },
      listPins: () => [],
    }, {
      task: "那个记忆项目，之前做到哪了",
      includeLatestCheckpoint: false,
      limitPerSection: 2,
    });

    const stableJoined = response.stableContext.join(" ");
    expect(stableJoined).toContain("RecallNest");
    expect(response.relevantPatterns.join(" ")).toContain("resume_context");
  });
});
