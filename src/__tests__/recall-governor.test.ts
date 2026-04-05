import { describe, expect, it } from "bun:test";

import {
  GovernorSession,
  governResults,
  resolveGovernorConfig,
  truncateQuery,
} from "../recall-governor.js";
import type { RetrievalResult } from "../retriever.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(
  id: string,
  text: string,
  score: number,
  metadata = "{}",
): RetrievalResult {
  return {
    entry: {
      id,
      text,
      vector: [],
      category: "events",
      scope: "project:test",
      importance: 0.8,
      timestamp: Date.now(),
      metadata,
    },
    score,
    sources: { fused: { score } },
  };
}

// ---------------------------------------------------------------------------
// truncateQuery
// ---------------------------------------------------------------------------

describe("truncateQuery", () => {
  it("returns query unchanged when within limit", () => {
    expect(truncateQuery("short", 1000)).toBe("short");
  });

  it("truncates query exceeding maxQueryChars", () => {
    const long = "a".repeat(2000);
    const result = truncateQuery(long, 500);
    expect(result.length).toBe(500);
  });

  it("handles exact boundary", () => {
    const exact = "x".repeat(100);
    expect(truncateQuery(exact, 100)).toBe(exact);
  });
});

// ---------------------------------------------------------------------------
// resolveGovernorConfig
// ---------------------------------------------------------------------------

describe("resolveGovernorConfig", () => {
  it("returns defaults when no overrides", () => {
    const cfg = resolveGovernorConfig();
    expect(cfg.maxQueryChars).toBe(1000);
    expect(cfg.charBudget).toBe(8000);
    expect(cfg.maxItems).toBe(10);
  });

  it("merges partial overrides", () => {
    const cfg = resolveGovernorConfig({ charBudget: 4000 });
    expect(cfg.charBudget).toBe(4000);
    expect(cfg.maxItems).toBe(10); // unchanged
  });
});

// ---------------------------------------------------------------------------
// GovernorSession
// ---------------------------------------------------------------------------

describe("GovernorSession", () => {
  it("tracks injected IDs", () => {
    const session = new GovernorSession();
    expect(session.wasInjected("a")).toBe(false);
    session.markInjected("a");
    expect(session.wasInjected("a")).toBe(true);
    expect(session.size).toBe(1);
  });

  it("markAll registers all result IDs", () => {
    const session = new GovernorSession();
    const results = [makeResult("x", "hi", 0.9), makeResult("y", "hello", 0.8)];
    session.markAll(results);
    expect(session.wasInjected("x")).toBe(true);
    expect(session.wasInjected("y")).toBe(true);
    expect(session.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// governResults — evolution state filter
// ---------------------------------------------------------------------------

describe("governResults — evolution filter", () => {
  it("keeps active memories", () => {
    const results = [makeResult("a1", "active memory", 0.9, '{"evolution":{"status":"active"}}')];
    const governed = governResults(results);
    expect(governed).toHaveLength(1);
  });

  it("keeps pending_review memories", () => {
    const results = [makeResult("p1", "pending review", 0.9, '{"evolution":{"status":"pending_review"}}')];
    const governed = governResults(results);
    expect(governed).toHaveLength(1);
  });

  it("drops archived memories", () => {
    const results = [makeResult("ar1", "archived", 0.9, '{"evolution":{"status":"archived"}}')];
    const governed = governResults(results);
    expect(governed).toHaveLength(0);
  });

  it("drops superseded memories", () => {
    const results = [makeResult("s1", "superseded", 0.9, '{"evolution":{"status":"superseded"}}')];
    const governed = governResults(results);
    expect(governed).toHaveLength(0);
  });

  it("keeps memories with no evolution (defaults to active)", () => {
    const results = [makeResult("n1", "no status", 0.9, "{}")];
    const governed = governResults(results);
    expect(governed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// governResults — budget control
// ---------------------------------------------------------------------------

describe("governResults — budget control", () => {
  it("respects maxItems limit", () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult(`b${i}`, "x".repeat(10), 0.9 - i * 0.01),
    );
    const governed = governResults(results, undefined, { maxItems: 3 });
    expect(governed).toHaveLength(3);
  });

  it("respects charBudget limit", () => {
    const results = [
      makeResult("c1", "a".repeat(3000), 0.95),
      makeResult("c2", "b".repeat(3000), 0.90),
      makeResult("c3", "c".repeat(3000), 0.85),
    ];
    const governed = governResults(results, undefined, { charBudget: 5000 });
    // First item (3000) fits, second (6000 total) would exceed 5000 → stops after first
    expect(governed).toHaveLength(1);
  });

  it("always allows at least one result even if it exceeds budget", () => {
    const results = [makeResult("big", "x".repeat(10000), 0.95)];
    const governed = governResults(results, undefined, { charBudget: 100 });
    expect(governed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// governResults — session dedup
// ---------------------------------------------------------------------------

describe("governResults — session dedup", () => {
  it("drops already-injected IDs", () => {
    const session = new GovernorSession();
    session.markInjected("dup1");

    const results = [
      makeResult("dup1", "already seen", 0.95),
      makeResult("new1", "fresh memory", 0.90),
    ];
    const governed = governResults(results, session);
    expect(governed).toHaveLength(1);
    expect(governed[0].entry.id).toBe("new1");
  });

  it("marks newly governed results in the session", () => {
    const session = new GovernorSession();
    const results = [makeResult("x1", "hello", 0.9)];
    governResults(results, session);
    expect(session.wasInjected("x1")).toBe(true);
  });

  it("skips dedup when no session provided", () => {
    const results = [makeResult("a", "text", 0.9), makeResult("a", "text", 0.8)];
    // Without session, same ID can appear (though unusual from retriever)
    const governed = governResults(results);
    expect(governed).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// governResults — empty input
// ---------------------------------------------------------------------------

describe("governResults — edge cases", () => {
  it("returns empty array for empty input", () => {
    expect(governResults([])).toHaveLength(0);
  });

  it("composes all layers correctly", () => {
    const session = new GovernorSession();
    session.markInjected("already");

    const results = [
      makeResult("already", "seen before", 0.99),                                     // dedup
      makeResult("archived", "old", 0.95, '{"evolution":{"status":"archived"}}'),        // evolution
      makeResult("keep1", "a".repeat(4000), 0.90),                                    // kept
      makeResult("keep2", "b".repeat(4000), 0.85),                                    // kept
      makeResult("over-budget", "c".repeat(4000), 0.80),                              // budget
    ];
    const governed = governResults(results, session, { charBudget: 8000 });
    // archived dropped by evolution, already dropped by dedup,
    // keep1 (4000) + keep2 (8000) = at budget, over-budget dropped
    expect(governed.map((r) => r.entry.id)).toEqual(["keep1", "keep2"]);
    expect(session.wasInjected("keep1")).toBe(true);
    expect(session.wasInjected("keep2")).toBe(true);
  });
});
