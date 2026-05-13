import { describe, it, expect } from "bun:test";
import { distillSession, type ConversationMessage } from "../session-distiller.js";

/**
 * Regression test for mcp-server.ts:1894 P0 bug (fixed 2026-05-13).
 *
 * The bug: mcp-server.ts passed { messages, scope, preserveRecent, keepRecentTools, persist }
 * as first arg, but distillSession signature is (messages: ConversationMessage[], deps, opts).
 *
 * Result before fix: microcompact internally saw undefined.length, silently skipped all
 * loops, returned empty result. distill_session MCP appeared to work but produced 0 output.
 *
 * Fix: split call into 3 args: messages (array), deps, opts.
 *
 * These tests verify the fix works (microcompact actually clears tools, tokens freed)
 * and document the bug shape (calling with object as first arg returns silent noop, not error).
 */
describe("distillSession parameter shape regression", () => {
  const buildMessages = (): ConversationMessage[] => [
    { role: "user", content: "start task" },
    { role: "assistant", content: "calling tool" },
    { role: "tool", content: "tool result 1 ".repeat(50), tool_name: "Read" },
    { role: "assistant", content: "more work" },
    { role: "tool", content: "tool result 2 ".repeat(50), tool_name: "Read" },
    { role: "assistant", content: "more work" },
    { role: "tool", content: "tool result 3 ".repeat(50), tool_name: "Read" },
    { role: "user", content: "preserved recent" },
  ];

  // Mock llm.chatLong returns empty string → summarize falls through to {text:"",dimensions:{}}
  // → persist block skipped (Object.keys(dimensions).length === 0)
  const mockDeps = {
    llm: { chatLong: async () => "" } as any,
    persistMemory: async () => ({ disposition: "stored" as const, id: "test-id" }),
  };

  it("microcompact actually processes messages when called with correct (array, deps, opts) shape", async () => {
    const messages = buildMessages();
    // preserveRecent=1 → cutoff = 8 - 1 = 7 → scan first 7 messages, find 3 Read tools (idx 2/4/6)
    // keepRecentTools=1 → clear 3-1 = 2 tools (idx 2,4)
    const result = await distillSession(messages, mockDeps, {
      scope: "test:regression-2026-05-13",
      preserveRecent: 1,
      keepRecentTools: 1,
      persist: false,
    });
    expect(result).toBeDefined();
    expect(result.compacted_messages).toBeDefined();
    expect(result.compacted_messages.length).toBe(messages.length);
    expect(result.microcompact.tools_cleared).toBe(2);
    expect(result.microcompact.tokens_freed).toBeGreaterThan(0);
    // Verify the cleared tool messages have been replaced with placeholder
    const clearedMsg = result.compacted_messages[2];
    expect(clearedMsg.role).toBe("tool");
    expect(clearedMsg.content).toContain("[Cleared:");
  });

  it("documents bug shape: object as first arg = silent noop (no error, empty result)", async () => {
    // BUG REPRODUCTION (pre-fix mcp-server.ts:1894 behavior)
    // distillSession expects messages: ConversationMessage[]
    // but received an object — microcompact internally does messages.length / .forEach
    // → on object, .length === undefined → loops skip → empty result returned silently
    const wrongShape = {
      messages: buildMessages(),
      scope: "test:bug-shape",
      preserveRecent: 1,
    };
    const result = await distillSession(
      // @ts-expect-error: intentional wrong shape to verify silent noop characteristic
      wrongShape,
      mockDeps,
      {},
    );
    // The bug signature: silent noop — no exception, but no work either
    expect(result.compacted_messages).toEqual([]);
    expect(result.microcompact.tools_cleared).toBe(0);
    expect(result.microcompact.tokens_freed).toBe(0);
  });
});
