import { describe, expect, it } from "bun:test";

import {
  microcompact,
  summarizeSession,
  extractAndPersist,
  distillSession,
  type ConversationMessage,
  type SummaryResult,
} from "../session-distiller.js";

// ============================================================================
// Helpers
// ============================================================================

function msg(role: ConversationMessage["role"], content: string, tool_name?: string): ConversationMessage {
  return { role, content, tool_name };
}

function toolMsg(name: string, content: string): ConversationMessage {
  return { role: "tool", content, tool_name: name };
}

function createMockLLM(response: string | null = null) {
  return {
    chatLong: async (_system: string, _user: string, _maxTokens?: number) => response,
    breaker: { canAttempt: () => true, recordSuccess: () => {}, recordFailure: () => {}, getState: () => "closed" as const, getFailureCount: () => 0 },
  } as ReturnType<typeof createMockLLM> & { chatLong: (s: string, u: string, m?: number) => Promise<string | null> };
}

function createMockDeps() {
  const stored: Array<Record<string, unknown>> = [];
  let seq = 1;

  return {
    stored,
    deps: {
      store: {
        async store(entry: Record<string, unknown>) {
          const record = {
            ...entry,
            id: `distill-${String(seq).padStart(8, "0")}`,
            timestamp: 1_700_000_000_000 + seq,
          };
          seq++;
          stored.push(record);
          return record;
        },
        async list() { return stored; },
        async update(id: string, updates: Record<string, unknown>) {
          const idx = stored.findIndex((e) => e.id === id);
          if (idx < 0) return null;
          stored[idx] = { ...stored[idx], ...updates };
          return stored[idx];
        },
        async getById(id: string) {
          return stored.find((e) => e.id === id) || null;
        },
        async get(id: string) {
          return stored.find((e) => e.id === id) || null;
        },
        async vectorSearch() { return []; },
      },
      embedder: {
        async embedPassage(_text: string) { return [0.1, 0.2, 0.3]; },
      },
      conflictStore: {
        async save(record: Record<string, unknown>) { return record; },
        async replace(record: Record<string, unknown>) { return record; },
        async getOpenByFingerprint() { return null; },
        async getLatestByFingerprint() { return null; },
      },
    },
  };
}

// ============================================================================
// Layer 1: microcompact
// ============================================================================

describe("microcompact", () => {
  it("returns empty for empty input", () => {
    const { messages, result } = microcompact([]);
    expect(messages).toEqual([]);
    expect(result.tokens_freed).toBe(0);
    expect(result.tools_cleared).toBe(0);
  });

  it("preserves all messages when count <= preserveRecent", () => {
    const input = [
      msg("user", "hello"),
      msg("assistant", "hi there"),
      msg("user", "bye"),
    ];
    const { messages, result } = microcompact(input, { preserveRecent: 6 });
    expect(messages).toHaveLength(3);
    expect(result.tools_cleared).toBe(0);
    expect(messages[0].content).toBe("hello");
  });

  it("clears old tool outputs beyond the preserve window", () => {
    const longContent = "x".repeat(400);
    const input = [
      msg("user", "start"),
      toolMsg("Read", longContent),
      toolMsg("Bash", longContent),
      toolMsg("Grep", longContent),
      msg("assistant", "found it"),
      msg("user", "ok"),
      msg("assistant", "done"),
      msg("user", "next"),
      msg("assistant", "working"),
      msg("user", "final"),
      msg("assistant", "complete"),
    ];
    // preserveRecent=4 means last 4 messages are safe (indices 7-10)
    // keepRecentTools=1 means only 1 most recent tool result is kept
    const { messages, result } = microcompact(input, {
      preserveRecent: 4,
      keepRecentTools: 1,
    });

    expect(messages).toHaveLength(11);
    // First two tool messages should be cleared, third kept (most recent)
    expect(messages[1].content).toContain("[Cleared: Read");
    expect(messages[2].content).toContain("[Cleared: Bash");
    expect(messages[3].content).toBe(longContent); // Grep kept as most recent tool
    expect(result.tools_cleared).toBe(2);
    expect(result.tokens_freed).toBeGreaterThan(0);
  });

  it("does not clear non-clearable tool names", () => {
    const input = [
      msg("user", "start"),
      toolMsg("custom_tool", "result here"),
      msg("assistant", "got it"),
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      msg("assistant", "d"),
      msg("user", "e"),
      msg("assistant", "f"),
    ];
    const { messages, result } = microcompact(input, { preserveRecent: 2 });
    expect(result.tools_cleared).toBe(0);
    expect(messages[1].content).toBe("result here");
  });

  it("estimates token count as content.length / 4", () => {
    const content = "a".repeat(100); // 100 chars = 25 tokens
    const input = [
      toolMsg("Read", content),
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      msg("assistant", "d"),
      msg("user", "e"),
      msg("assistant", "f"),
    ];
    const { messages, result } = microcompact(input, { preserveRecent: 6, keepRecentTools: 0 });
    expect(result.tokens_freed).toBe(25);
    expect(result.tools_cleared).toBe(1);
    expect(messages[0].content).toContain("~25 tokens");
  });

  it("keeps all clearable tools when keepRecentTools >= tool count", () => {
    const input = [
      toolMsg("Read", "file content"),
      toolMsg("Bash", "command output"),
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      msg("assistant", "d"),
      msg("user", "e"),
      msg("assistant", "f"),
      msg("user", "g"),
    ];
    const { result } = microcompact(input, { preserveRecent: 2, keepRecentTools: 5 });
    expect(result.tools_cleared).toBe(0);
  });

  it("preserves tool_name and other fields on cleared messages", () => {
    const input = [
      { role: "tool" as const, content: "long output", tool_name: "Read", timestamp: "2024-01-01" },
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      msg("assistant", "d"),
      msg("user", "e"),
      msg("assistant", "f"),
    ];
    const { messages } = microcompact(input, { preserveRecent: 6, keepRecentTools: 0 });
    expect(messages[0].tool_name).toBe("Read");
    expect(messages[0].timestamp).toBe("2024-01-01");
    expect(messages[0].content).toContain("[Cleared: Read");
  });

  it("handles all clearable tool names", () => {
    const clearableTools = [
      "read_file", "bash", "grep", "glob", "web_search", "web_fetch",
      "edit_file", "write_file", "Read", "Write", "Edit", "Bash",
      "Grep", "Glob", "WebSearch", "WebFetch",
    ];
    const filler: ConversationMessage[] = [];
    for (let i = 0; i < 20; i++) {
      filler.push(msg("user", `msg ${i}`));
    }
    const input = [
      ...clearableTools.map((t) => toolMsg(t, "output")),
      ...filler,
    ];
    const { result } = microcompact(input, { preserveRecent: 10, keepRecentTools: 0 });
    expect(result.tools_cleared).toBe(clearableTools.length);
  });

  it("uses default values when opts not provided", () => {
    const input: ConversationMessage[] = [];
    for (let i = 0; i < 10; i++) {
      input.push(toolMsg("Read", "content"));
      input.push(msg("user", `q${i}`));
    }
    // Default: preserveRecent=6, keepRecentTools=5
    const { result } = microcompact(input);
    // Last 6 messages are preserved, so tools in first 14 are candidates
    // 7 tools are in the clearable zone, keepRecentTools=5 means 2 cleared
    expect(result.tools_cleared).toBe(2);
  });
});

// ============================================================================
// Layer 2: summarizeSession
// ============================================================================

describe("summarizeSession", () => {
  it("returns empty result when LLM returns null", async () => {
    const mockLLM = createMockLLM(null);
    const result = await summarizeSession(
      [msg("user", "hello")],
      mockLLM as unknown as import("../llm-client.js").LLMClient,
    );
    expect(result.text).toBe("");
    expect(Object.keys(result.dimensions)).toHaveLength(0);
  });

  it("parses structured summary from LLM response", async () => {
    const response = `<analysis>Thinking about the session...</analysis>
<summary>
## 1. User intent and requests
Wanted to build a feature

## 2. Key technical concepts
TypeScript, MCP protocol

## 3. Files and code segments involved
src/main.ts, src/utils.ts

## 4. Errors and fix records
N/A

## 5. Problem solving process
Iterative approach with testing

## 6. User original quotes preserved
"Make it simple and clean"

## 7. Unfinished tasks
Unit tests pending

## 8. Current work state
Implementation 80% complete

## 9. Suggested next steps
Write tests, review code
</summary>`;
    const mockLLM = createMockLLM(response);
    const result = await summarizeSession(
      [msg("user", "build feature"), msg("assistant", "ok")],
      mockLLM as unknown as import("../llm-client.js").LLMClient,
    );

    expect(result.text).toContain("User intent");
    expect(result.dimensions.user_intent).toContain("build a feature");
    expect(result.dimensions.technical_concepts).toContain("TypeScript");
    expect(result.dimensions.files_and_code).toContain("src/main.ts");
    expect(result.dimensions.errors_and_fixes).toBeUndefined(); // N/A is excluded
    expect(result.dimensions.problem_solving).toContain("Iterative");
    expect(result.dimensions.user_quotes).toContain("simple and clean");
    expect(result.dimensions.unfinished_tasks).toContain("Unit tests");
    expect(result.dimensions.current_state).toContain("80%");
    expect(result.dimensions.next_steps).toContain("Write tests");
  });

  it("handles response without XML tags gracefully", async () => {
    const response = `## 1. User intent and requests
Debug a crash

## 2. Key technical concepts
Memory management`;
    const mockLLM = createMockLLM(response);
    const result = await summarizeSession(
      [msg("user", "help")],
      mockLLM as unknown as import("../llm-client.js").LLMClient,
    );
    expect(result.text).toContain("User intent");
  });

  it("truncates long messages to avoid token overflow", async () => {
    let capturedUser = "";
    const mockLLM = {
      chatLong: async (_system: string, user: string) => {
        capturedUser = user;
        return "<analysis>ok</analysis><summary>short</summary>";
      },
    };
    const longMsg = msg("user", "x".repeat(10000));
    await summarizeSession(
      [longMsg],
      mockLLM as unknown as import("../llm-client.js").LLMClient,
    );
    // Each message content is capped at 500 chars, and total at 8000
    expect(capturedUser.length).toBeLessThanOrEqual(8000);
  });
});

// ============================================================================
// Layer 3: extractAndPersist
// ============================================================================

describe("extractAndPersist", () => {
  it("persists memories for relevant dimensions", async () => {
    const { stored, deps } = createMockDeps();
    const summary: SummaryResult = {
      text: "full summary text",
      dimensions: {
        user_intent: "User wanted to implement a session distiller feature",
        files_and_code: "src/session-distiller.ts, src/mcp-server.ts",
        errors_and_fixes: "Fixed import error in llm-client.ts by adding chatLong method",
        problem_solving: "Iterative approach: read code first, then implement layer by layer",
        user_quotes: "User said: prefer clean code over clever code",
      },
    };

    const result = await extractAndPersist(summary, deps as Parameters<typeof extractAndPersist>[1], "project:test");
    expect(result.memories_stored).toBe(5);
    expect(result.ids).toHaveLength(5);

    // Verify categories
    const categories = stored.map((s) => s.category);
    expect(categories).toContain("events");
    expect(categories).toContain("entities");
    expect(categories).toContain("cases");
    expect(categories).toContain("patterns");
    expect(categories).toContain("preferences");

    // Verify session_distill tag is in metadata
    for (const entry of stored) {
      const metadata = typeof entry.metadata === "string" ? entry.metadata : JSON.stringify(entry.metadata);
      expect(metadata).toContain("session_distill");
    }
  });

  it("skips dimensions with too-short content", async () => {
    const { deps } = createMockDeps();
    const summary: SummaryResult = {
      text: "summary",
      dimensions: {
        user_intent: "short",  // < 10 chars
        errors_and_fixes: "Found and fixed a critical bug in the parser module",
      },
    };

    const result = await extractAndPersist(summary, deps as Parameters<typeof extractAndPersist>[1], "project:test");
    expect(result.memories_stored).toBe(1);
    expect(result.ids).toHaveLength(1);
  });

  it("skips dimensions not in DIMENSION_TO_MEMORY mapping", async () => {
    const { deps } = createMockDeps();
    const summary: SummaryResult = {
      text: "summary",
      dimensions: {
        technical_concepts: "TypeScript and Bun runtime details",
        current_state: "Implementation complete, testing phase",
        next_steps: "Deploy to production",
      },
    };

    const result = await extractAndPersist(summary, deps as Parameters<typeof extractAndPersist>[1], "project:test");
    expect(result.memories_stored).toBe(0);
  });

  it("returns empty result for empty dimensions", async () => {
    const { deps } = createMockDeps();
    const summary: SummaryResult = { text: "", dimensions: {} };

    const result = await extractAndPersist(summary, deps as Parameters<typeof extractAndPersist>[1], "project:test");
    expect(result.memories_stored).toBe(0);
    expect(result.memories_deduped).toBe(0);
    expect(result.memories_conflicted).toBe(0);
    expect(result.ids).toHaveLength(0);
  });

  it("tracks disposition correctly for multiple dimensions", async () => {
    const { deps } = createMockDeps();
    const summary: SummaryResult = {
      text: "summary",
      dimensions: {
        user_intent: "User wanted to build a distiller for sessions",
        errors_and_fixes: "Fixed a critical error in the LLM client module",
      },
    };

    const result = await extractAndPersist(summary, deps as Parameters<typeof extractAndPersist>[1], "project:test");
    // Both should store successfully (no dedup in mock since vectorSearch returns [])
    expect(result.memories_stored).toBe(2);
    expect(result.ids).toHaveLength(2);
    expect(result.memories_deduped).toBe(0);
    expect(result.memories_conflicted).toBe(0);
  });
});

// ============================================================================
// Full Pipeline: distillSession
// ============================================================================

describe("distillSession", () => {
  it("runs all three layers end-to-end", async () => {
    const { deps } = createMockDeps();
    const llmResponse = `<analysis>Processing</analysis>
<summary>
## 1. User intent and requests
Implement session distiller

## 2. Key technical concepts
N/A

## 3. Files and code segments involved
src/session-distiller.ts

## 4. Errors and fix records
N/A

## 5. Problem solving process
Step by step implementation

## 6. User original quotes preserved
N/A

## 7. Unfinished tasks
N/A

## 8. Current work state
N/A

## 9. Suggested next steps
N/A
</summary>`;

    const mockLLM = createMockLLM(llmResponse);
    const input: ConversationMessage[] = [
      msg("user", "implement distiller"),
      toolMsg("Read", "long file content ".repeat(100)),
      toolMsg("Bash", "test output ".repeat(100)),
      msg("assistant", "done reading"),
      msg("user", "proceed"),
      msg("assistant", "implementing"),
      msg("user", "looks good"),
      msg("assistant", "finished"),
      msg("user", "test it"),
      msg("assistant", "all pass"),
    ];

    const result = await distillSession(
      input,
      { ...deps, llm: mockLLM } as Parameters<typeof distillSession>[1],
      { scope: "project:test", preserveRecent: 4, keepRecentTools: 0 },
    );

    // Layer 1
    expect(result.microcompact.tools_cleared).toBe(2);
    expect(result.microcompact.tokens_freed).toBeGreaterThan(0);

    // Layer 2
    expect(result.summary.dimensions.user_intent).toContain("session distiller");

    // Layer 3
    expect(result.persisted.memories_stored).toBeGreaterThan(0);

    // Compacted messages
    expect(result.compacted_messages).toHaveLength(10);
    expect(result.compacted_messages[1].content).toContain("[Cleared:");
  });

  it("skips Layer 3 when persist=false", async () => {
    const { deps } = createMockDeps();
    const mockLLM = createMockLLM(
      "<analysis>ok</analysis><summary>## 1. User intent and requests\nBuild something cool</summary>",
    );

    const input = [
      msg("user", "hello"),
      msg("assistant", "hi"),
      msg("user", "build it"),
      msg("assistant", "ok"),
      msg("user", "done?"),
      msg("assistant", "yes"),
      msg("user", "great"),
      msg("assistant", "cheers"),
    ];

    const result = await distillSession(
      input,
      { ...deps, llm: mockLLM } as Parameters<typeof distillSession>[1],
      { persist: false, preserveRecent: 2 },
    );

    expect(result.persisted.memories_stored).toBe(0);
    expect(result.persisted.ids).toHaveLength(0);
  });

  it("handles empty conversation gracefully", async () => {
    const { deps } = createMockDeps();
    const mockLLM = createMockLLM(null);

    const result = await distillSession(
      [],
      { ...deps, llm: mockLLM } as Parameters<typeof distillSession>[1],
    );

    expect(result.microcompact.tools_cleared).toBe(0);
    expect(result.summary.text).toBe("");
    expect(result.persisted.memories_stored).toBe(0);
    expect(result.compacted_messages).toHaveLength(0);
  });

  it("uses default scope when not provided", async () => {
    const { deps, stored } = createMockDeps();
    const mockLLM = createMockLLM(
      "<analysis>ok</analysis><summary>## 1. User intent and requests\nBuild a feature for the application</summary>",
    );

    const input = [
      msg("user", "hello"),
      msg("assistant", "hi"),
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      msg("assistant", "d"),
      msg("user", "e"),
      msg("assistant", "f"),
    ];

    await distillSession(
      input,
      { ...deps, llm: mockLLM } as Parameters<typeof distillSession>[1],
    );

    // Should use "default" scope
    if (stored.length > 0) {
      expect(stored[0].scope).toBe("default");
    }
  });

  it("only summarizes old messages (before preserve window)", async () => {
    let capturedUser = "";
    const mockLLM = {
      chatLong: async (_system: string, user: string) => {
        capturedUser = user;
        return "<analysis>ok</analysis><summary>## 1. User intent and requests\nSomething from the old messages only</summary>";
      },
    };

    const { deps } = createMockDeps();
    const input = [
      msg("user", "old message 1"),
      msg("assistant", "old response 1"),
      msg("user", "recent 1"),
      msg("assistant", "recent 2"),
      msg("user", "recent 3"),
      msg("assistant", "recent 4"),
    ];

    await distillSession(
      input,
      { ...deps, llm: mockLLM } as Parameters<typeof distillSession>[1],
      { preserveRecent: 4 },
    );

    expect(capturedUser).toContain("old message 1");
    expect(capturedUser).not.toContain("recent 1");
  });

  it("skips Layer 2/3 when all messages are in preserve window", async () => {
    const { deps } = createMockDeps();
    const mockLLM = createMockLLM("should not be called");

    const input = [
      msg("user", "hello"),
      msg("assistant", "hi"),
    ];

    const result = await distillSession(
      input,
      { ...deps, llm: mockLLM } as Parameters<typeof distillSession>[1],
      { preserveRecent: 6 },
    );

    expect(result.summary.text).toBe("");
    expect(result.persisted.memories_stored).toBe(0);
  });
});
