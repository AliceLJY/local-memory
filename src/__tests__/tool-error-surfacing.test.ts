import { describe, expect, it } from "bun:test";

import { registerAdvancedTools } from "../mcp-tools-advanced.js";
import { registerGovernanceTools } from "../mcp-tools-governance.js";
import { runToolSafely } from "../error-taxonomy.js";

/**
 * P1-7 第二阶段回归：验证「主操作错误」与「C 类逻辑失败」经 registerTool 的
 * runToolSafely 包装后带 isError + reason_code，而不是被 handler 自吞成「看起来成功」的文本。
 *
 * 手法：用注入式 registerTool 捕获真实 handler，并复刻生产 registerTool 的 runToolSafely
 * 包装，使测试看到与生产一致的 isError 行为（无需起 MCP server）。
 */

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}
type CapturedHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function captureTools(
  register: (deps: any) => void,
  getComponents: () => unknown,
): Map<string, CapturedHandler> {
  const handlers = new Map<string, CapturedHandler>();
  const deps = {
    registerTool: (
      name: string,
      _desc: string,
      _schema: unknown,
      handler: (...a: unknown[]) => unknown,
    ) => {
      // 复刻 mcp-server.ts registerTool 的兜底：把 handler 交给 runToolSafely。
      handlers.set(name, (args) => runToolSafely(name, async () => handler(args)) as Promise<ToolResult>);
    },
    getComponents,
    conflictStore: {},
    workflowObservationStore: {},
    getKGExtractor: () => null,
    getKGStore: () => null,
  };
  register(deps as any);
  return handlers;
}

describe("memory_drill_down error surfacing (P1-7)", () => {
  it("surfaces a store error as isError with store_error reason (no swallow)", async () => {
    const handlers = captureTools(registerAdvancedTools, () => ({
      store: {
        getById: async () => {
          throw new Error("lancedb table read failed");
        },
      },
    }));
    const drill = handlers.get("memory_drill_down");
    expect(drill).toBeDefined();
    const r = await drill!({ id: "abcd1234", level: "full" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("store_error");
  });

  it("still returns plain not-found text (read-only, no isError)", async () => {
    const handlers = captureTools(registerAdvancedTools, () => ({
      store: { getById: async () => null },
    }));
    const r = await handlers.get("memory_drill_down")!({ id: "abcd1234", level: "full" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("No memory found");
  });
});

describe("forget_memory error surfacing (P1-7 C 类)", () => {
  it("throws logic failure into the taxonomy layer (isError) not fake-success text", async () => {
    const handlers = captureTools(registerAdvancedTools, () => ({
      // store.get → null ⇒ forgetMemory 早返回 success:false（不触碰 kg/audit）
      store: { get: async () => null },
    }));
    const r = await handlers.get("forget_memory")!({ memoryId: "abcd1234", confirm: false });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("not found");
  });
});

describe("manage_alias error surfacing (P1-7 C 类)", () => {
  it("throws invalid_input on missing add params (not returned as success text)", async () => {
    const handlers = captureTools(registerGovernanceTools, () => ({}));
    const r = await handlers.get("manage_alias")!({ action: "add" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("invalid_input");
  });

  it("throws invalid_input on missing remove trigger", async () => {
    const handlers = captureTools(registerGovernanceTools, () => ({}));
    const r = await handlers.get("manage_alias")!({ action: "remove" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("invalid_input");
  });
});
