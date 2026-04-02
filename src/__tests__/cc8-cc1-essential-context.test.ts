/**
 * Tests for CC-8 (Post-Compact Reconstruction) and CC-1 (Injection Hint).
 *
 * CC-8: essentialContext field in ResumeContextResponse — pinned memories,
 *       active patterns, and open loops assembled independently of search relevance.
 * CC-1: injectionHint field — placement suggestion for recalled context.
 */
import { describe, expect, test } from "bun:test";

import {
  EssentialContextSchema,
  ResumeContextResponseSchema,
} from "../session-schema.js";
import { formatResumeContext } from "../session-output.js";
import type { ResumeContextResponse } from "../session-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMinimalResponse(overrides: Partial<ResumeContextResponse> = {}): ResumeContextResponse {
  return ResumeContextResponseSchema.parse({
    summary: "Test resume summary",
    stableContext: [],
    relevantPatterns: [],
    recentCases: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// CC-8: EssentialContext Schema
// ---------------------------------------------------------------------------

describe("CC-8: EssentialContextSchema", () => {
  test("accepts full essential context with all fields", () => {
    const result = EssentialContextSchema.parse({
      pinnedMemories: ["Pin A", "Pin B"],
      activePatterns: ["Pattern X"],
      openLoops: ["Loop 1", "Loop 2"],
    });
    expect(result.pinnedMemories).toEqual(["Pin A", "Pin B"]);
    expect(result.activePatterns).toEqual(["Pattern X"]);
    expect(result.openLoops).toEqual(["Loop 1", "Loop 2"]);
  });

  test("accepts empty object (all fields optional)", () => {
    const result = EssentialContextSchema.parse({});
    expect(result.pinnedMemories).toBeUndefined();
    expect(result.activePatterns).toBeUndefined();
    expect(result.openLoops).toBeUndefined();
  });

  test("enforces max 3 pinned memories", () => {
    expect(() =>
      EssentialContextSchema.parse({
        pinnedMemories: ["a", "b", "c", "d"],
      }),
    ).toThrow();
  });

  test("enforces max 2 active patterns", () => {
    expect(() =>
      EssentialContextSchema.parse({
        activePatterns: ["a", "b", "c"],
      }),
    ).toThrow();
  });

  test("enforces max 3 open loops", () => {
    expect(() =>
      EssentialContextSchema.parse({
        openLoops: ["a", "b", "c", "d"],
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CC-8: essentialContext in ResumeContextResponse
// ---------------------------------------------------------------------------

describe("CC-8: essentialContext in ResumeContextResponse", () => {
  test("response includes essentialContext when pins are present", () => {
    const response = buildMinimalResponse({
      essentialContext: {
        pinnedMemories: ["Important pin"],
      },
    });
    expect(response.essentialContext).toBeDefined();
    expect(response.essentialContext!.pinnedMemories).toEqual(["Important pin"]);
  });

  test("essentialContext is undefined when no pins, patterns, or loops", () => {
    const response = buildMinimalResponse({
      essentialContext: undefined,
    });
    expect(response.essentialContext).toBeUndefined();
  });

  test("essentialContext with only openLoops is valid", () => {
    const response = buildMinimalResponse({
      essentialContext: {
        openLoops: ["Pending PR review", "Deploy staging"],
      },
    });
    expect(response.essentialContext).toBeDefined();
    expect(response.essentialContext!.openLoops).toHaveLength(2);
    expect(response.essentialContext!.pinnedMemories).toBeUndefined();
    expect(response.essentialContext!.activePatterns).toBeUndefined();
  });

  test("essentialContext with only activePatterns is valid", () => {
    const response = buildMinimalResponse({
      essentialContext: {
        activePatterns: ["Always run tests before commit"],
      },
    });
    expect(response.essentialContext!.activePatterns).toEqual(["Always run tests before commit"]);
  });

  test("essentialContext coexists with other response fields", () => {
    const response = buildMinimalResponse({
      stableContext: ["User identity: developer"],
      relevantPatterns: ["pattern 1"],
      recentCases: ["case 1"],
      essentialContext: {
        pinnedMemories: ["Pinned note"],
        activePatterns: ["Workflow pattern"],
        openLoops: ["Open loop item"],
      },
    });
    expect(response.stableContext).toHaveLength(1);
    expect(response.relevantPatterns).toHaveLength(1);
    expect(response.recentCases).toHaveLength(1);
    expect(response.essentialContext!.pinnedMemories).toHaveLength(1);
    expect(response.essentialContext!.activePatterns).toHaveLength(1);
    expect(response.essentialContext!.openLoops).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CC-1: injectionHint in ResumeContextResponse
// ---------------------------------------------------------------------------

describe("CC-1: injectionHint", () => {
  test("defaults to user_attachment when not specified", () => {
    const response = buildMinimalResponse();
    expect(response.injectionHint).toBe("user_attachment");
  });

  test("accepts system_prompt value", () => {
    const response = buildMinimalResponse({
      injectionHint: "system_prompt",
    });
    expect(response.injectionHint).toBe("system_prompt");
  });

  test("accepts user_attachment value", () => {
    const response = buildMinimalResponse({
      injectionHint: "user_attachment",
    });
    expect(response.injectionHint).toBe("user_attachment");
  });

  test("rejects invalid injection hint", () => {
    expect(() =>
      ResumeContextResponseSchema.parse({
        summary: "test",
        stableContext: [],
        relevantPatterns: [],
        recentCases: [],
        injectionHint: "invalid_value",
        generatedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CC-8 + CC-1: formatResumeContext rendering
// ---------------------------------------------------------------------------

describe("formatResumeContext renders CC-8 and CC-1", () => {
  test("renders essentialContext with all three sub-fields", () => {
    const response = buildMinimalResponse({
      essentialContext: {
        pinnedMemories: ["Pin summary A", "Pin summary B"],
        activePatterns: ["Always checkpoint before closing"],
        openLoops: ["PR #42 needs review", "Deploy to staging"],
      },
    });
    const output = formatResumeContext(response);

    expect(output).toContain("Essential context:");
    expect(output).toContain("- Pinned: Pin summary A");
    expect(output).toContain("- Pinned: Pin summary B");
    expect(output).toContain("- Pattern: Always checkpoint before closing");
    expect(output).toContain("- Open loop: PR #42 needs review");
    expect(output).toContain("- Open loop: Deploy to staging");
  });

  test("renders essentialContext with only pinnedMemories", () => {
    const response = buildMinimalResponse({
      essentialContext: {
        pinnedMemories: ["Single pin"],
      },
    });
    const output = formatResumeContext(response);

    expect(output).toContain("Essential context:");
    expect(output).toContain("- Pinned: Single pin");
    expect(output).not.toContain("- Pattern:");
    expect(output).not.toContain("- Open loop:");
  });

  test("does not render essential context section when essentialContext is undefined", () => {
    const response = buildMinimalResponse({
      essentialContext: undefined,
    });
    const output = formatResumeContext(response);

    expect(output).not.toContain("Essential context:");
    expect(output).not.toContain("- Pinned:");
  });

  test("does not render essential context section when essentialContext is empty object", () => {
    const response = buildMinimalResponse({
      essentialContext: {},
    });
    const output = formatResumeContext(response);

    expect(output).not.toContain("Essential context:");
  });

  test("essential context appears after collapsed context and before latest checkpoint", () => {
    const response = buildMinimalResponse({
      collapsedItems: [
        { entryId: "e1", text: "Collapsed item", renderLevel: "L0" },
      ],
      essentialContext: {
        pinnedMemories: ["Pin note"],
      },
      latestCheckpoint: {
        sessionId: "sess-123",
        summary: "Previous session summary",
        updatedAt: new Date().toISOString(),
      },
    });
    const output = formatResumeContext(response);

    const collapsedIdx = output.indexOf("Collapsed context (mixed granularity):");
    const essentialIdx = output.indexOf("Essential context:");
    const checkpointIdx = output.indexOf("Latest checkpoint:");

    expect(collapsedIdx).toBeGreaterThan(-1);
    expect(essentialIdx).toBeGreaterThan(collapsedIdx);
    expect(checkpointIdx).toBeGreaterThan(essentialIdx);
  });

  test("renders injectionHint", () => {
    const response = buildMinimalResponse({
      injectionHint: "user_attachment",
    });
    const output = formatResumeContext(response);

    expect(output).toContain("Injection hint: user_attachment");
    expect(output).toContain("prompt cache hit rate");
  });

  test("renders system_prompt injectionHint", () => {
    const response = buildMinimalResponse({
      injectionHint: "system_prompt",
    });
    const output = formatResumeContext(response);

    expect(output).toContain("Injection hint: system_prompt");
  });

  test("injection hint appears after latest checkpoint section", () => {
    const response = buildMinimalResponse({
      latestCheckpoint: {
        sessionId: "sess-456",
        summary: "Checkpoint summary",
        updatedAt: new Date().toISOString(),
      },
      injectionHint: "user_attachment",
    });
    const output = formatResumeContext(response);

    const checkpointIdx = output.indexOf("Latest checkpoint:");
    const hintIdx = output.indexOf("Injection hint:");

    expect(checkpointIdx).toBeGreaterThan(-1);
    expect(hintIdx).toBeGreaterThan(checkpointIdx);
  });
});
