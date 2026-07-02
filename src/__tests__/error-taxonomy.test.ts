import { describe, expect, it } from "bun:test";

import { classifyError, toErrorResult, runToolSafely } from "../error-taxonomy.js";

// P-error-taxonomy: 借鉴 RepoPrompt CE 的 error taxonomy。
// 每种失败标 {reasonCode, retryable, responsibility}，让 agent 判断重试/改参/上报。

describe("classifyError", () => {
  it("classifies transport errors as retryable / transport", () => {
    for (const m of ["ECONNRESET", "socket hang up", "fetch failed", "request timed out", "ETIMEDOUT"]) {
      const c = classifyError(new Error(m));
      expect(c.reasonCode).toBe("transport_error");
      expect(c.retryable).toBe(true);
      expect(c.responsibility).toBe("transport");
    }
  });

  it("classifies rate-limit / overload as retryable / peer", () => {
    for (const m of ["429 Too Many Requests", "rate limit exceeded", "529 overloaded", "quota exceeded"]) {
      const c = classifyError(new Error(m));
      expect(c.reasonCode).toBe("upstream_overloaded");
      expect(c.retryable).toBe(true);
      expect(c.responsibility).toBe("peer");
    }
  });

  it("classifies auth failures as non-retryable / host", () => {
    const c = classifyError(new Error("401 Unauthorized: invalid api key"));
    expect(c.reasonCode).toBe("upstream_auth");
    expect(c.retryable).toBe(false);
    expect(c.responsibility).toBe("host");
  });

  it("classifies missing-scope as non-retryable / peer", () => {
    const c = classifyError(new Error("search_memory requires a scope. Pass scope explicitly, provide sessionId..."));
    expect(c.reasonCode).toBe("scope_required");
    expect(c.retryable).toBe(false);
    expect(c.responsibility).toBe("peer");
  });

  it("classifies validation errors as invalid_input / peer", () => {
    const c = classifyError(new Error("validation failed: expected string received number"));
    expect(c.reasonCode).toBe("invalid_input");
    expect(c.responsibility).toBe("peer");
  });

  it("classifies store errors as app", () => {
    const c = classifyError(new Error("LanceDB table not found"));
    expect(c.reasonCode).toBe("store_error");
    expect(c.responsibility).toBe("app");
  });

  it("classifies config/env-missing as non-retryable / host (P2-1/P2-3)", () => {
    const c = classifyError(new Error("Environment variable OPENAI_API_KEY not set"));
    expect(c.reasonCode).toBe("config_missing");
    expect(c.retryable).toBe(false);
    expect(c.responsibility).toBe("host");
  });

  it("classifies bad memory references as invalid_memory_ref / peer — caller-side (P2-3)", () => {
    for (const m of [
      "Invalid memory ID format: bad",
      'Ambiguous prefix "12345678" matches 2+ memories. Use a longer prefix or full ID.',
      "Memory 12345678 is outside accessible scopes",
    ]) {
      const c = classifyError(new Error(m));
      expect(c.reasonCode).toBe("invalid_memory_ref");
      expect(c.responsibility).toBe("peer");
    }
  });

  it("falls back to internal_error / app / non-retryable for unknown errors", () => {
    const c = classifyError(new Error("something totally unexpected happened"));
    expect(c.reasonCode).toBe("internal_error");
    expect(c.retryable).toBe(false);
    expect(c.responsibility).toBe("app");
  });

  it("handles non-Error throwables", () => {
    const c = classifyError("plain string failure");
    expect(c.reasonCode).toBe("internal_error");
    expect(c.responsibility).toBe("app");
  });
});

describe("toErrorResult", () => {
  it("produces an isError result with a machine-readable classification block", () => {
    const r = toErrorResult("search_memory", new Error("ECONNRESET"));
    expect(r.isError).toBe(true);
    expect(r.content[0].type).toBe("text");
    const text = r.content[0].text;
    expect(text).toContain('Tool "search_memory" failed');
    expect(text).toContain("reason_code: transport_error");
    expect(text).toContain("retryable: true");
    expect(text).toContain("responsibility: transport");
    expect(text).toContain("detail: ECONNRESET");
  });

  it("preserves the original detail for unknown errors", () => {
    const r = toErrorResult("forget_memory", new Error("boom"));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("reason_code: internal_error");
    expect(r.content[0].text).toContain("detail: boom");
  });
});

describe("runToolSafely", () => {
  it("returns handler result on success (pass-through)", async () => {
    const ok = { content: [{ type: "text", text: "ok" }] };
    const r = await runToolSafely("search_memory", async () => ok);
    expect(r).toEqual(ok);
  });

  it("catches handler throw and returns a classified isError result", async () => {
    const r = await runToolSafely("search_memory", async () => { throw new Error("ECONNRESET"); }) as { isError: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("reason_code: transport_error");
  });

  it("catches lazy-init failure and classifies it (P2-1 regression lock)", async () => {
    // 模拟 ensureComponents 抛错（缺 env var）——必须被分类返回 isError，而非裸抛绕过。
    const r = await runToolSafely("store_memory", async () => {
      throw new Error("Environment variable JINA_API_KEY not set");
    }) as { isError: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("reason_code: config_missing");
    expect(r.content[0].text).toContain("responsibility: host");
  });
});
