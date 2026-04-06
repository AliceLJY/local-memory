import { describe, it, expect } from "bun:test";
import {
  microcompact,
  summarizeSession,
  extractAndPersist,
  distillSession,
  type ConversationMessage,
  type SummaryDimensions,
  type PersistDeps,
  type DistillSessionDeps,
} from "../session-distiller.js";

// ============================================================================
// Helpers
// ============================================================================

function makeToolUseMsg(toolName: string, toolId: string): ConversationMessage {
  return {
    role: "assistant",
    content: [
      { type: "tool_use", name: toolName, id: toolId, input: {} },
    ],
  };
}

function makeToolResultMsg(toolUseId: string, result: string): ConversationMessage {
  return {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: toolUseId, content: result },
    ],
  };
}

function makeTextMsg(role: "user" | "assistant", text: string): ConversationMessage {
  return { role, content: text };
}

// ============================================================================
// Layer 1: Microcompact
// ============================================================================

describe("microcompact", () => {
  it("should clear old compactable tool results and keep recent N", () => {
    const messages: ConversationMessage[] = [
      makeTextMsg("user", "Read the file"),
      makeToolUseMsg("Read", "tool_1"),
      makeToolResultMsg("tool_1", "file content A ".repeat(100)),
      makeToolUseMsg("Bash", "tool_2"),
      makeToolResultMsg("tool_2", "bash output B ".repeat(100)),
      makeToolUseMsg("Grep", "tool_3"),
      makeToolResultMsg("tool_3", "grep result C ".repeat(100)),
      makeToolUseMsg("Read", "tool_4"),
      makeToolResultMsg("tool_4", "file content D ".repeat(100)),
      makeToolUseMsg("Read", "tool_5"),
      makeToolResultMsg("tool_5", "file content E ".repeat(100)),
      makeToolUseMsg("Read", "tool_6"),
      makeToolResultMsg("tool_6", "file content F ".repeat(100)),
    ];

    const result = microcompact(messages, 5);

    // tool_1 is the oldest (6th from end), should be cleared
    const clearedBlock = (result.messages[2].content as Array<{ content?: string }>)[0];
    expect(clearedBlock.content).toBe("[Cleared]");

    // tool_2 through tool_6 are the recent 5, should be preserved
    const keptBlock = (result.messages[4].content as Array<{ content?: string }>)[0];
    expect(keptBlock.content).toContain("bash output B");

    expect(result.toolsCleared).toBe(1);
    expect(result.tokensFred).toBeGreaterThan(0);
  });

  it("should not clear non-compactable tool results", () => {
    const messages: ConversationMessage[] = [
      makeToolUseMsg("search_memory", "tool_1"),
      makeToolResultMsg("tool_1", "some memory result"),
      makeToolUseMsg("Read", "tool_2"),
      makeToolResultMsg("tool_2", "file content"),
    ];

    const result = microcompact(messages, 1);

    // search_memory is not compactable, should be preserved
    const memBlock = (result.messages[1].content as Array<{ content?: string }>)[0];
    expect(memBlock.content).toBe("some memory result");

    // Read tool_2 is the most recent 1, should also be preserved
    const readBlock = (result.messages[3].content as Array<{ content?: string }>)[0];
    expect(readBlock.content).toBe("file content");

    expect(result.toolsCleared).toBe(0);
  });

  it("should handle string content messages without error", () => {
    const messages: ConversationMessage[] = [
      makeTextMsg("user", "hello"),
      makeTextMsg("assistant", "hi there"),
    ];

    const result = microcompact(messages, 5);
    expect(result.messages).toHaveLength(2);
    expect(result.toolsCleared).toBe(0);
    expect(result.tokensFred).toBe(0);
  });

  it("should return deep copies (no mutation of input)", () => {
    const original = "original content";
    const messages: ConversationMessage[] = [
      makeToolUseMsg("Read", "tool_1"),
      makeToolResultMsg("tool_1", original),
      makeToolUseMsg("Read", "tool_2"),
      makeToolResultMsg("tool_2", "recent"),
    ];

    microcompact(messages, 1);

    // Original should not be mutated
    const origBlock = (messages[1].content as Array<{ content?: string }>)[0];
    expect(origBlock.content).toBe(original);
  });

  it("should handle empty messages array", () => {
    const result = microcompact([], 5);
    expect(result.messages).toHaveLength(0);
    expect(result.toolsCleared).toBe(0);
  });

  it("should clear multiple old results when many tools used", () => {
    const messages: ConversationMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(makeToolUseMsg("Bash", `tool_${i}`));
      messages.push(makeToolResultMsg(`tool_${i}`, `output ${i} `.repeat(50)));
    }

    const result = microcompact(messages, 5);
    // 10 tools total, keep recent 5, clear oldest 5
    expect(result.toolsCleared).toBe(5);
  });
});

// ============================================================================
// Layer 3: extractAndPersist
// ============================================================================

describe("extractAndPersist", () => {
  it("should persist non-empty dimensions to correct categories", async () => {
    const stored: Array<{ text: string; category: string; source: string }> = [];
    const mockPersist: PersistDeps["persistMemory"] = async (input) => {
      const i = input as { text: string; category: string; source: string };
      stored.push(i);
      return { disposition: "stored", id: `id_${stored.length}` };
    };

    const dims: SummaryDimensions = {
      userIntent: "用户要求分析 OpenHarness 项目的架构设计",
      keyConcepts: "Agent Harness, Tool Registry",
      filesAndCode: "src/session-distiller.ts 实现了三层蒸馏逻辑",
      errorsAndFixes: "修复了 microcompact 对 string content 的处理错误",
      problemSolving: "先用规则清除旧工具结果，不够再调 LLM 摘要",
      userQuotes: "用户说：实验性的都推到河马仓，实用性的就公开仓也一起推",
      pendingTasks: "无",
      currentWork: "无",
      suggestedNext: "无",
    };

    const result = await extractAndPersist(dims, "project:recallnest", { persistMemory: mockPersist });

    // 5 dimensions mapped, "无" and short content skipped
    expect(result.memoriesStored).toBe(5);
    expect(result.ids).toHaveLength(5);

    // Check categories
    expect(stored[0].category).toBe("events");       // userIntent
    expect(stored[1].category).toBe("cases");         // errorsAndFixes
    expect(stored[2].category).toBe("patterns");      // problemSolving
    expect(stored[3].category).toBe("preferences");   // userQuotes
    expect(stored[4].category).toBe("entities");      // filesAndCode

    // All should have session_distill source
    for (const s of stored) {
      expect(s.source).toBe("session_distill");
    }
  });

  it("should skip dimensions with content '无'", async () => {
    const mockPersist: PersistDeps["persistMemory"] = async () => ({
      disposition: "stored",
      id: "id_1",
    });

    const dims: SummaryDimensions = {
      userIntent: "无",
      keyConcepts: "无",
      filesAndCode: "无",
      errorsAndFixes: "无",
      problemSolving: "无",
      userQuotes: "无",
      pendingTasks: "无",
      currentWork: "无",
      suggestedNext: "无",
    };

    const result = await extractAndPersist(dims, "project:test", { persistMemory: mockPersist });
    expect(result.memoriesStored).toBe(0);
  });

  it("should skip dimensions shorter than MIN_PERSIST_LENGTH", async () => {
    const mockPersist: PersistDeps["persistMemory"] = async () => ({
      disposition: "stored",
      id: "id_1",
    });

    const dims: SummaryDimensions = {
      userIntent: "短",  // too short
      keyConcepts: "",
      filesAndCode: "",
      errorsAndFixes: "这是一个足够长的错误描述，应该被保存到记忆中去",
      problemSolving: "",
      userQuotes: "",
      pendingTasks: "",
      currentWork: "",
      suggestedNext: "",
    };

    const result = await extractAndPersist(dims, "project:test", { persistMemory: mockPersist });
    expect(result.memoriesStored).toBe(1); // Only errorsAndFixes
  });

  it("should handle deduped and conflict dispositions", async () => {
    let callCount = 0;
    const mockPersist: PersistDeps["persistMemory"] = async () => {
      callCount++;
      if (callCount === 1) return { disposition: "deduped", id: "dup_1" };
      if (callCount === 2) return { disposition: "conflict", id: "conflict_1" };
      return { disposition: "stored", id: `id_${callCount}` };
    };

    const dims: SummaryDimensions = {
      userIntent: "用户要求实现 Session Distiller 功能模块",
      keyConcepts: "",
      filesAndCode: "",
      errorsAndFixes: "修复了类型推断错误导致的编译失败问题，具体是 ContentBlock 类型没有正确处理 string 格式",
      problemSolving: "采用三层蒸馏策略：先用规则微压缩清除旧工具结果，不够再调 LLM 做结构化摘要，最后提取知识持久化",
      userQuotes: "",
      pendingTasks: "",
      currentWork: "",
      suggestedNext: "",
    };

    const result = await extractAndPersist(dims, "project:test", { persistMemory: mockPersist });
    expect(result.memoriesDeduped).toBe(1);
    expect(result.memoriesConflicted).toBe(1);
    expect(result.memoriesStored).toBe(1);
  });

  it("should handle persistMemory errors gracefully", async () => {
    const mockPersist: PersistDeps["persistMemory"] = async () => {
      throw new Error("LanceDB write failure");
    };

    const dims: SummaryDimensions = {
      userIntent: "这是一个会导致持久化失败的用户意图描述，用户要求实现 Session Distiller 三层蒸馏功能",
      keyConcepts: "",
      filesAndCode: "",
      errorsAndFixes: "",
      problemSolving: "",
      userQuotes: "",
      pendingTasks: "",
      currentWork: "",
      suggestedNext: "",
    };

    const result = await extractAndPersist(dims, "project:test", { persistMemory: mockPersist });
    expect(result.memoriesRejected).toBe(1);
    expect(result.memoriesStored).toBe(0);
  });
});

// ============================================================================
// Orchestrator: distillSession
// ============================================================================

describe("distillSession", () => {
  it("should run Layer 1 even without LLM", async () => {
    const messages: ConversationMessage[] = [
      makeToolUseMsg("Bash", "tool_1"),
      makeToolResultMsg("tool_1", "long output ".repeat(100)),
      makeToolUseMsg("Bash", "tool_2"),
      makeToolResultMsg("tool_2", "recent output"),
    ];

    const deps: DistillSessionDeps = {
      llm: null,
      persistMemory: async () => ({ disposition: "stored", id: "id_1" }),
    };

    const result = await distillSession(
      { messages, scope: "project:test", keepRecentTools: 1 },
      deps,
    );

    expect(result.microcompact.toolsCleared).toBe(1);
    expect(result.summary).toBeNull();
    expect(result.persisted).toBeNull();
    // compactedMessages should be the microcompacted version
    expect(result.compactedMessages).toHaveLength(4);
  });

  it("should skip persist when persist=false", async () => {
    const deps: DistillSessionDeps = {
      llm: null,
      persistMemory: async () => {
        throw new Error("should not be called");
      },
    };

    const result = await distillSession(
      { messages: [makeTextMsg("user", "hi")], scope: "project:test", persist: false },
      deps,
    );

    expect(result.persisted).toBeNull();
  });

  it("should handle empty messages", async () => {
    const deps: DistillSessionDeps = {
      llm: null,
      persistMemory: async () => ({ disposition: "stored", id: "id_1" }),
    };

    const result = await distillSession(
      { messages: [], scope: "project:test" },
      deps,
    );

    expect(result.microcompact.toolsCleared).toBe(0);
    expect(result.compactedMessages).toHaveLength(0);
  });
});
