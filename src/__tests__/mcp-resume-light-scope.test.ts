import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";

import * as memoryAssets from "../memory-assets.js";
import { registerCoreTools } from "../mcp-tools-core.js";
import type { RetrievalContext, RetrievalResult } from "../retriever.js";
import type { SessionCheckpointRecord } from "../session-schema.js";

const scopeEnvKeys = [
  "RECALLNEST_DEFAULT_SCOPE",
  "RECALLNEST_SCOPE",
  "RECALLNEST_PROJECT_SCOPE",
  "RECALLNEST_SESSION_ID",
] as const;

const checkpoint: SessionCheckpointRecord = {
  checkpointId: "cp-light-handler",
  sessionId: "session-light",
  resolvedScope: "project:checkpoint",
  summary: "Review the continuity handoff",
  decisions: [],
  openLoops: [],
  nextActions: [],
  entities: [],
  files: [],
  updatedAt: "2026-09-08T00:00:00.000Z",
};

const memory: RetrievalResult = {
  entry: {
    id: "light-stable-memory",
    text: "User prefers concise technical replies.",
    vector: [1, 0, 0],
    category: "preferences",
    scope: "global",
    importance: 0.8,
    timestamp: Date.parse("2026-09-08T00:00:00.000Z"),
    metadata: "{}",
  },
  score: 0.9,
  sources: { fused: { score: 0.9 } },
};

function createResumeHarness() {
  const tools = new Map<string, { schema: z.ZodRawShape; handler: (input: any) => Promise<any> }>();
  const retrievalCalls: RetrievalContext[] = [];
  const checkpointCalls: Array<{ sessionId?: string; scope?: string } | undefined> = [];
  const observations: Array<{ scope: string }> = [];

  registerCoreTools({
    registerTool(name: string, _description: string, schema: z.ZodRawShape, handler: any) {
      tools.set(name, { schema, handler });
    },
    getComponents() {
      return {
        retriever: {
          async retrieve(context: RetrievalContext) {
            retrievalCalls.push(context);
            return [memory];
          },
        },
      };
    },
    config: {},
    checkpointStore: {
      async getLatest(query?: { sessionId?: string; scope?: string }) {
        checkpointCalls.push(query);
        return checkpoint;
      },
    },
    workflowObservationStore: {
      async save(observation: { scope: string }) {
        observations.push(observation);
      },
    },
    toolDescriptions: new Map(),
    toolTiers: {},
    getKGExtractor: () => null,
    getKGStore: () => null,
  } as any);

  return {
    retrievalCalls,
    checkpointCalls,
    observations,
    async resume(input: { scope?: string; sessionId?: string } = {}) {
      const tool = tools.get("resume_context")!;
      return tool.handler(z.object(tool.schema).parse({ ...input, mode: "light" }));
    },
  };
}

describe("resume_context light scope output", () => {
  let savedEnv: Partial<Record<typeof scopeEnvKeys[number], string>>;
  let pins: ReturnType<typeof spyOn>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of scopeEnvKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Keep the real handler and composer; replace only the disk-backed pin reader.
    pins = spyOn(memoryAssets, "listPinAssets").mockReturnValue([]);
  });

  afterEach(() => {
    pins.mockRestore();
    for (const key of scopeEnvKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const originalText = [
    "Last session (session-light): Review the continuity handoff",
    "- User prefers concise technical replies.",
    "",
    "For complete context, call resume_context(mode='full').",
  ].join("\n");

  it("shows the session-derived scope when no explicit scope is supplied", async () => {
    const harness = createResumeHarness();
    const result = await harness.resume({ sessionId: "session-light" });

    expect(result.content).toEqual([{ type: "text", text: `Scope: session:session-light\n${originalText}` }]);
    expect(harness.checkpointCalls).toEqual([{ sessionId: "session-light" }]);
    expect(harness.retrievalCalls.map(call => call.scopeFilter)).toEqual([["session:session-light"], undefined]);
    expect(harness.observations).toHaveLength(1);
    expect(harness.observations[0]?.scope).toBe("session:session-light");
    expect(pins).toHaveBeenCalledTimes(1);
  });

  it("shows explicit scope instead of a different checkpoint scope", async () => {
    const harness = createResumeHarness();
    const result = await harness.resume({ scope: "project:explicit", sessionId: "session-light" });

    expect(result.content).toEqual([{ type: "text", text: `Scope: project:explicit\n${originalText}` }]);
    expect(harness.checkpointCalls).toEqual([{ sessionId: "session-light" }]);
    expect(harness.retrievalCalls.map(call => call.scopeFilter)).toEqual([["project:explicit"], undefined]);
    expect(harness.observations).toHaveLength(1);
    expect(harness.observations[0]?.scope).toBe("project:explicit");
  });

  it("keeps unscoped output unchanged without inventing global scope", async () => {
    const harness = createResumeHarness();
    const result = await harness.resume();

    expect(result.content).toEqual([{
      type: "text",
      text: "- User prefers concise technical replies.\n\nFor complete context, call resume_context(mode='full').",
    }]);
    expect(harness.checkpointCalls).toEqual([]);
    expect(harness.retrievalCalls.map(call => call.scopeFilter)).toEqual([undefined]);
    expect(harness.observations).toHaveLength(1);
    expect(harness.observations[0]?.scope).toBe("global");
  });
});
