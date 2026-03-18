import { describe, expect, it } from "bun:test";

import { matchesScopeFilter, resolveScopeSelection, resolveSessionScope } from "../scope-policy.js";

describe("scope-policy", () => {
  it("prefers explicit scope over inferred values", () => {
    const resolved = resolveScopeSelection({
      scope: "project:recallnest",
      sessionId: "session-123",
      operation: "test:search",
      env: {
        RECALLNEST_DEFAULT_SCOPE: "project:other",
      } as NodeJS.ProcessEnv,
    });

    expect(resolved.resolvedScope).toBe("project:recallnest");
    expect(resolved.scopeFilter).toEqual(["project:recallnest"]);
    expect(resolved.inferredFrom).toBe("scope");
  });

  it("falls back to session scope when explicit scope is absent", () => {
    expect(resolveSessionScope("session-123")).toBe("session:session-123");

    const resolved = resolveScopeSelection({
      sessionId: "session-123",
      operation: "test:search",
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.resolvedScope).toBe("session:session-123");
    expect(resolved.scopeFilter).toEqual(["session:session-123"]);
    expect(resolved.inferredFrom).toBe("sessionId");
  });

  it("uses environment defaults when request scope is omitted", () => {
    const resolved = resolveScopeSelection({
      operation: "test:search",
      env: {
        RECALLNEST_DEFAULT_SCOPE: "project:recallnest",
      } as NodeJS.ProcessEnv,
    });

    expect(resolved.resolvedScope).toBe("project:recallnest");
    expect(resolved.scopeFilter).toEqual(["project:recallnest"]);
    expect(resolved.inferredFrom).toBe("RECALLNEST_DEFAULT_SCOPE");
  });

  it("requires explicit opt-in before allowing cross-scope reads", () => {
    expect(() => resolveScopeSelection({
      operation: "test:search",
      env: {} as NodeJS.ProcessEnv,
    })).toThrow("requires a scope");

    const allScopes = resolveScopeSelection({
      operation: "test:search",
      allScopes: true,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(allScopes.allScopes).toBe(true);
    expect(allScopes.scopeFilter).toBeUndefined();
  });

  it("matches both exact and prefix scope filters", () => {
    expect(matchesScopeFilter("project:recallnest", ["project:recallnest"])).toBe(true);
    expect(matchesScopeFilter("cc:session-123", ["cc"])).toBe(true);
    expect(matchesScopeFilter("project:other", ["project:recallnest"])).toBe(false);
  });
});
