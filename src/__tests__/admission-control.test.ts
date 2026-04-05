import { describe, expect, it } from "bun:test";

import {
  checkAdmission,
  resolveAdmissionConfig,
  ScopeRateLimiter,
} from "../admission-control.js";

// ---------------------------------------------------------------------------
// resolveAdmissionConfig
// ---------------------------------------------------------------------------

describe("resolveAdmissionConfig", () => {
  it("returns defaults when no overrides", () => {
    const cfg = resolveAdmissionConfig();
    expect(cfg.minTextLength).toBe(10);
    expect(cfg.noiseFilterEnabled).toBe(true);
    expect(cfg.minImportance).toBe(0.2);
    expect(cfg.maxWritesPerScope).toBe(50);
    expect(cfg.rateLimitWindowMs).toBe(60_000);
  });

  it("merges partial overrides", () => {
    const cfg = resolveAdmissionConfig({ minImportance: 0.5 });
    expect(cfg.minImportance).toBe(0.5);
    expect(cfg.minTextLength).toBe(10); // unchanged
  });
});

// ---------------------------------------------------------------------------
// checkAdmission — text length
// ---------------------------------------------------------------------------

describe("checkAdmission — text length", () => {
  it("rejects text shorter than minTextLength", () => {
    const result = checkAdmission("short", 0.8, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("text_too_short");
  });

  it("rejects empty text", () => {
    const result = checkAdmission("", 0.8, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("text_too_short");
  });

  it("rejects whitespace-only text", () => {
    const result = checkAdmission("         ", 0.8, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("text_too_short");
  });

  it("accepts text at exactly minTextLength", () => {
    const result = checkAdmission("abcdefghij", 0.8, "project:test");
    expect(result.verdict).toBe("accepted");
  });

  it("respects custom minTextLength", () => {
    const result = checkAdmission("hello world", 0.8, "project:test", undefined, { minTextLength: 20 });
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("text_too_short");
  });
});

// ---------------------------------------------------------------------------
// checkAdmission — noise filter
// ---------------------------------------------------------------------------

describe("checkAdmission — noise filter", () => {
  it("rejects denial patterns", () => {
    const result = checkAdmission("I don't have any information about that topic", 0.8, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("noise_detected");
  });

  it("rejects boilerplate greetings", () => {
    const result = checkAdmission("hello there!", 0.8, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("noise_detected");
  });

  it("can be disabled via config", () => {
    const result = checkAdmission(
      "I don't have any information about that topic",
      0.8,
      "project:test",
      undefined,
      { noiseFilterEnabled: false },
    );
    expect(result.verdict).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// checkAdmission — importance floor
// ---------------------------------------------------------------------------

describe("checkAdmission — importance floor", () => {
  it("rejects importance below default threshold (0.2)", () => {
    const result = checkAdmission("This is a valid memory text", 0.1, "project:test");
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("importance_too_low");
  });

  it("accepts importance at exactly the threshold", () => {
    const result = checkAdmission("This is a valid memory text", 0.2, "project:test");
    expect(result.verdict).toBe("accepted");
  });

  it("accepts importance above threshold", () => {
    const result = checkAdmission("This is a valid memory text", 0.8, "project:test");
    expect(result.verdict).toBe("accepted");
  });

  it("respects custom minImportance", () => {
    const result = checkAdmission("This is a valid memory text", 0.4, "project:test", undefined, { minImportance: 0.5 });
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("importance_too_low");
  });
});

// ---------------------------------------------------------------------------
// ScopeRateLimiter
// ---------------------------------------------------------------------------

describe("ScopeRateLimiter", () => {
  it("allows writes within limit", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = resolveAdmissionConfig({ maxWritesPerScope: 3 });
    expect(limiter.check("s1", cfg)).toBe(true);
    expect(limiter.check("s1", cfg)).toBe(true);
    expect(limiter.check("s1", cfg)).toBe(true);
  });

  it("blocks writes exceeding limit", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = resolveAdmissionConfig({ maxWritesPerScope: 2 });
    expect(limiter.check("s1", cfg)).toBe(true);
    expect(limiter.check("s1", cfg)).toBe(true);
    expect(limiter.check("s1", cfg)).toBe(false); // 3rd blocked
  });

  it("tracks scopes independently", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = resolveAdmissionConfig({ maxWritesPerScope: 1 });
    expect(limiter.check("s1", cfg)).toBe(true);
    expect(limiter.check("s2", cfg)).toBe(true);
    expect(limiter.check("s1", cfg)).toBe(false); // s1 exhausted
    expect(limiter.check("s2", cfg)).toBe(false); // s2 exhausted
  });

  it("reports correct size", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = resolveAdmissionConfig();
    limiter.check("a", cfg);
    limiter.check("b", cfg);
    expect(limiter.size).toBe(2);
  });

  it("clears all state", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = resolveAdmissionConfig();
    limiter.check("a", cfg);
    limiter.clear();
    expect(limiter.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkAdmission — rate limiting
// ---------------------------------------------------------------------------

describe("checkAdmission — rate limiting", () => {
  it("rejects when rate limit exceeded", () => {
    const limiter = new ScopeRateLimiter();
    const cfg = { maxWritesPerScope: 2 } as const;
    // First two pass
    checkAdmission("valid memory text here", 0.8, "project:test", limiter, cfg);
    checkAdmission("another valid memory text", 0.8, "project:test", limiter, cfg);
    // Third is rate limited
    const result = checkAdmission("yet another valid text", 0.8, "project:test", limiter, cfg);
    expect(result.verdict).toBe("rejected");
    expect(result.reason).toBe("rate_limited");
  });

  it("skips rate limiting when no limiter provided", () => {
    const result = checkAdmission("valid memory text here", 0.8, "project:test");
    expect(result.verdict).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// checkAdmission — happy path
// ---------------------------------------------------------------------------

describe("checkAdmission — happy path", () => {
  it("accepts valid memory with all checks passing", () => {
    const result = checkAdmission(
      "User prefers dark mode in all applications",
      0.8,
      "project:test",
    );
    expect(result.verdict).toBe("accepted");
    expect(result.reason).toBeUndefined();
  });
});
