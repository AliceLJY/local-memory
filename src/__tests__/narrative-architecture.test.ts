/**
 * Phase 3: Autobiographical Narrative Architecture tests.
 *
 * Validates:
 * 1. NarrativeMetadata schema — Zod parsing + backward compat
 * 2. narrative-tagger — rule-based tagging with keyword detection
 * 3. parseNarrative — safe extraction from metadata JSON
 * 4. Feature flag gating — all features no-op when flag is off
 * 5. Graph export — narrative edges between siblings
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { tagNarrative, tagNarrativeIfEnabled } from "../narrative-tagger.js";
import {
  parseNarrative,
  isNarrativeModeEnabled,
  NarrativeMetadataSchema,
  type NarrativeMetadata,
} from "../narrative-schema.js";

// ---------------------------------------------------------------------------
// 1. NarrativeMetadata Schema
// ---------------------------------------------------------------------------

describe("NarrativeMetadataSchema", () => {
  test("accepts valid narrative metadata", () => {
    const valid: NarrativeMetadata = {
      lifePeriodId: "lp:project:2026-Q2",
      lifePeriodLabel: "project (2026-Q2)",
      generalEventId: "ge:session-abc",
      generalEventLabel: "debugging @ project (2026-04-11)",
      specificEventId: "se:project:1712835600000:abc123",
      specificEventLabel: "Fixed the auth bug after 3 hours",
      startAt: 1712835600000,
      endAt: null,
      sequence: 0,
    };
    const parsed = NarrativeMetadataSchema.parse(valid);
    expect(parsed.lifePeriodId).toBe("lp:project:2026-Q2");
    expect(parsed.endAt).toBeNull();
    expect(parsed.sequence).toBe(0);
  });

  test("rejects empty lifePeriodId", () => {
    expect(() =>
      NarrativeMetadataSchema.parse({
        lifePeriodId: "",
        lifePeriodLabel: "x",
        generalEventId: "ge:x",
        generalEventLabel: "x",
        specificEventId: "se:x",
        specificEventLabel: "x",
        startAt: 0,
        endAt: null,
        sequence: 0,
      }),
    ).toThrow();
  });

  test("rejects negative sequence", () => {
    expect(() =>
      NarrativeMetadataSchema.parse({
        lifePeriodId: "lp:x:2026-Q1",
        lifePeriodLabel: "x",
        generalEventId: "ge:x",
        generalEventLabel: "x",
        specificEventId: "se:x",
        specificEventLabel: "x",
        startAt: 0,
        endAt: null,
        sequence: -1,
      }),
    ).toThrow();
  });

  test("accepts endAt as a number", () => {
    const parsed = NarrativeMetadataSchema.parse({
      lifePeriodId: "lp:x:2026-Q1",
      lifePeriodLabel: "x",
      generalEventId: "ge:x",
      generalEventLabel: "x",
      specificEventId: "se:x",
      specificEventLabel: "x",
      startAt: 1000,
      endAt: 2000,
      sequence: 1,
    });
    expect(parsed.endAt).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// 2. parseNarrative — safe extraction
// ---------------------------------------------------------------------------

describe("parseNarrative", () => {
  test("returns null for undefined metadata", () => {
    expect(parseNarrative(undefined)).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseNarrative("")).toBeNull();
  });

  test("returns null for metadata without narrative key", () => {
    expect(parseNarrative(JSON.stringify({ source: "agent" }))).toBeNull();
  });

  test("returns null for malformed JSON", () => {
    expect(parseNarrative("{broken json")).toBeNull();
  });

  test("extracts valid narrative from metadata", () => {
    const metadata = JSON.stringify({
      source: "agent",
      narrative: {
        lifePeriodId: "lp:memory:2026-Q2",
        lifePeriodLabel: "memory (2026-Q2)",
        generalEventId: "ge:session-123",
        generalEventLabel: "development @ memory (2026-04-11)",
        specificEventId: "se:memory:1712835600000:xyz",
        specificEventLabel: "Implemented narrative tagger",
        startAt: 1712835600000,
        endAt: null,
        sequence: 0,
      },
    });
    const result = parseNarrative(metadata);
    expect(result).not.toBeNull();
    expect(result!.lifePeriodId).toBe("lp:memory:2026-Q2");
    expect(result!.generalEventId).toBe("ge:session-123");
    expect(result!.sequence).toBe(0);
  });

  test("returns null for narrative with missing lifePeriodId", () => {
    const metadata = JSON.stringify({
      narrative: { generalEventId: "ge:x" },
    });
    expect(parseNarrative(metadata)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. tagNarrative — rule-based tagger
// ---------------------------------------------------------------------------

describe("tagNarrative", () => {
  const origFlag = process.env.RECALLNEST_NARRATIVE_MODE;

  afterAll(() => {
    if (origFlag !== undefined) {
      process.env.RECALLNEST_NARRATIVE_MODE = origFlag;
    } else {
      delete process.env.RECALLNEST_NARRATIVE_MODE;
    }
  });

  test("returns null when feature flag is off", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "false";
    const result = tagNarrative({
      scope: "project:test",
      text: "some memory",
      timestamp: Date.now(),
    });
    expect(result).toBeNull();
  });

  test("returns narrative metadata when flag is on", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const ts = new Date("2026-04-11T10:00:00Z").getTime();
    const result = tagNarrative({
      scope: "project:recallnest",
      text: "Implemented the narrative tagger feature",
      timestamp: ts,
    });

    expect(result).not.toBeNull();
    expect(result!.lifePeriodId).toBe("lp:project:2026-Q2");
    expect(result!.lifePeriodLabel).toBe("project (2026-Q2)");
    expect(result!.startAt).toBe(ts);
    expect(result!.endAt).toBeNull();
    expect(result!.sequence).toBe(0);
  });

  test("uses sessionId for generalEventId when provided", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const result = tagNarrative({
      scope: "project:test",
      text: "test memory",
      timestamp: Date.now(),
      sessionId: "sess-abc-123",
    });
    expect(result!.generalEventId).toBe("ge:sess-abc-123");
  });

  test("uses date-based generalEventId when no sessionId", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const ts = new Date("2026-04-11T10:00:00Z").getTime();
    const result = tagNarrative({
      scope: "project:test",
      text: "test memory",
      timestamp: ts,
    });
    expect(result!.generalEventId).toContain("2026-04-11");
    expect(result!.generalEventId).toContain("ge:");
  });

  test("respects sequence parameter", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const result = tagNarrative({
      scope: "project:test",
      text: "third event",
      timestamp: Date.now(),
      sequence: 3,
    });
    expect(result!.sequence).toBe(3);
  });

  test("detects debugging event type from keywords", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const result = tagNarrative({
      scope: "project:app",
      text: "Debug the authentication crash in production",
      timestamp: new Date("2026-04-11T10:00:00Z").getTime(),
    });
    expect(result!.generalEventLabel).toContain("debugging");
  });

  test("detects deployment event type from keywords", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const result = tagNarrative({
      scope: "project:app",
      text: "Deploy the new release to production",
      timestamp: new Date("2026-04-11T10:00:00Z").getTime(),
    });
    expect(result!.generalEventLabel).toContain("deployment");
  });

  test("detects learning event type from keywords", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const result = tagNarrative({
      scope: "project:app",
      text: "Research new approaches for memory systems",
      timestamp: new Date("2026-04-11T10:00:00Z").getTime(),
    });
    expect(result!.generalEventLabel).toContain("learning");
  });

  test("detects Chinese keywords", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const result = tagNarrative({
      scope: "project:app",
      text: "调试认证模块的崩溃问题",
      timestamp: new Date("2026-04-11T10:00:00Z").getTime(),
    });
    expect(result!.generalEventLabel).toContain("debugging");
  });

  test("falls back to 'activity' when no keywords match", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const result = tagNarrative({
      scope: "project:app",
      text: "Meeting about quarterly goals",
      timestamp: new Date("2026-04-11T10:00:00Z").getTime(),
    });
    expect(result!.generalEventLabel).toContain("activity");
  });

  test("truncates long text in specificEventLabel", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const longText = "A".repeat(100);
    const result = tagNarrative({
      scope: "project:app",
      text: longText,
      timestamp: Date.now(),
    });
    expect(result!.specificEventLabel.length).toBeLessThanOrEqual(60);
    expect(result!.specificEventLabel).toContain("\u2026"); // ellipsis
  });

  test("quarterly boundary — Q1 vs Q2", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const q1 = tagNarrative({
      scope: "project:app",
      text: "Q1 work",
      timestamp: new Date("2026-03-15T10:00:00Z").getTime(),
    });
    const q2 = tagNarrative({
      scope: "project:app",
      text: "Q2 work",
      timestamp: new Date("2026-04-15T10:00:00Z").getTime(),
    });
    expect(q1!.lifePeriodId).toContain("2026-Q1");
    expect(q2!.lifePeriodId).toContain("2026-Q2");
    expect(q1!.lifePeriodId).not.toBe(q2!.lifePeriodId);
  });

  test("same scope+day → same generalEventId (without sessionId)", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const ts1 = new Date("2026-04-11T08:00:00Z").getTime();
    const ts2 = new Date("2026-04-11T16:00:00Z").getTime();
    const r1 = tagNarrative({ scope: "project:app", text: "morning work", timestamp: ts1 });
    const r2 = tagNarrative({ scope: "project:app", text: "evening work", timestamp: ts2 });
    expect(r1!.generalEventId).toBe(r2!.generalEventId);
  });

  test("different days → different generalEventId", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const day1 = new Date("2026-04-11T10:00:00Z").getTime();
    const day2 = new Date("2026-04-12T10:00:00Z").getTime();
    const r1 = tagNarrative({ scope: "project:app", text: "day1", timestamp: day1 });
    const r2 = tagNarrative({ scope: "project:app", text: "day2", timestamp: day2 });
    expect(r1!.generalEventId).not.toBe(r2!.generalEventId);
  });

  test("different text → different specificEventId", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const ts = Date.now();
    const r1 = tagNarrative({ scope: "project:app", text: "event A happened", timestamp: ts });
    const r2 = tagNarrative({ scope: "project:app", text: "event B happened", timestamp: ts });
    expect(r1!.specificEventId).not.toBe(r2!.specificEventId);
  });
});

// ---------------------------------------------------------------------------
// 4. tagNarrativeIfEnabled — convenience wrapper
// ---------------------------------------------------------------------------

describe("tagNarrativeIfEnabled", () => {
  const origFlag = process.env.RECALLNEST_NARRATIVE_MODE;

  afterAll(() => {
    if (origFlag !== undefined) {
      process.env.RECALLNEST_NARRATIVE_MODE = origFlag;
    } else {
      delete process.env.RECALLNEST_NARRATIVE_MODE;
    }
  });

  test("returns null when flag is off", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "false";
    expect(tagNarrativeIfEnabled({ scope: "x", text: "y", timestamp: 0 })).toBeNull();
  });

  test("returns metadata when flag is on", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const result = tagNarrativeIfEnabled({
      scope: "project:test",
      text: "test",
      timestamp: Date.now(),
    });
    expect(result).not.toBeNull();
    expect(result!.lifePeriodId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. isNarrativeModeEnabled
// ---------------------------------------------------------------------------

describe("isNarrativeModeEnabled", () => {
  const origFlag = process.env.RECALLNEST_NARRATIVE_MODE;

  afterAll(() => {
    if (origFlag !== undefined) {
      process.env.RECALLNEST_NARRATIVE_MODE = origFlag;
    } else {
      delete process.env.RECALLNEST_NARRATIVE_MODE;
    }
  });

  test("returns false when env is not set", () => {
    delete process.env.RECALLNEST_NARRATIVE_MODE;
    expect(isNarrativeModeEnabled()).toBe(false);
  });

  test("returns false when env is 'false'", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "false";
    expect(isNarrativeModeEnabled()).toBe(false);
  });

  test("returns true when env is 'true'", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    expect(isNarrativeModeEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Narrative metadata round-trip (tag → JSON → parse)
// ---------------------------------------------------------------------------

describe("narrative round-trip", () => {
  const origFlag = process.env.RECALLNEST_NARRATIVE_MODE;

  afterAll(() => {
    if (origFlag !== undefined) {
      process.env.RECALLNEST_NARRATIVE_MODE = origFlag;
    } else {
      delete process.env.RECALLNEST_NARRATIVE_MODE;
    }
  });

  test("tag → embed in metadata JSON → parseNarrative → same values", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "true";
    const tagged = tagNarrative({
      scope: "project:recallnest",
      text: "Fixed the scoring bug in retriever",
      timestamp: new Date("2026-04-11T10:00:00Z").getTime(),
      sessionId: "sess-xyz",
      sequence: 2,
    });

    expect(tagged).not.toBeNull();

    // Simulate embedding in metadata JSON (as done in capture-engine/ingest)
    const metadata = JSON.stringify({
      source: "agent",
      tags: ["fix"],
      narrative: tagged,
    });

    // Parse back out
    const parsed = parseNarrative(metadata);
    expect(parsed).not.toBeNull();
    expect(parsed!.lifePeriodId).toBe(tagged!.lifePeriodId);
    expect(parsed!.generalEventId).toBe(tagged!.generalEventId);
    expect(parsed!.specificEventId).toBe(tagged!.specificEventId);
    expect(parsed!.sequence).toBe(2);
    expect(parsed!.startAt).toBe(tagged!.startAt);
  });
});

// ---------------------------------------------------------------------------
// 7. Backward compatibility — existing metadata without narrative
// ---------------------------------------------------------------------------

describe("backward compatibility", () => {
  test("parseNarrative on pre-narrative metadata returns null", () => {
    const oldMeta = JSON.stringify({
      source: "agent",
      tags: ["test"],
      emotion: { valence: 0.5, arousal: 0.3, label: "positive" },
      evolution: { status: "active", version: 1 },
    });
    expect(parseNarrative(oldMeta)).toBeNull();
  });

  test("feature flag off means zero narrative overhead", () => {
    process.env.RECALLNEST_NARRATIVE_MODE = "false";
    const result = tagNarrative({
      scope: "project:test",
      text: "this should produce nothing",
      timestamp: Date.now(),
    });
    expect(result).toBeNull();
  });
});
