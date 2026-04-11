/**
 * F1: Memory Confidence Meta-tags — tests for structured confidence,
 * source-based assignment, retrieval integration, and backward compat.
 */

import { describe, expect, test } from "bun:test";
import {
  assignDefaultConfidence,
  getConfidence,
  getConfidenceMetadata,
  CONFIDENCE_DEFAULT,
  type ConfidenceMetadata,
} from "../confidence-tracker.js";
import type { MemoryEntry } from "../store.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeEntry(metadataObj: Record<string, unknown>): MemoryEntry {
  return {
    id: "test-001",
    text: "test",
    vector: [],
    category: "events",
    scope: "test",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: JSON.stringify(metadataObj),
  };
}

// ---------------------------------------------------------------------------
// assignDefaultConfidence
// ---------------------------------------------------------------------------

describe("F1: assignDefaultConfidence", () => {
  test("manual source → direct reliability, score 0.9", () => {
    const c = assignDefaultConfidence("manual");
    expect(c.score).toBe(0.9);
    expect(c.reliability).toBe("direct");
  });

  test("agent source → inferred reliability, score 0.7", () => {
    const c = assignDefaultConfidence("agent");
    expect(c.score).toBe(0.7);
    expect(c.reliability).toBe("inferred");
  });

  test("conversation_import source → hearsay, score 0.5", () => {
    const c = assignDefaultConfidence("conversation_import");
    expect(c.score).toBe(0.5);
    expect(c.reliability).toBe("hearsay");
  });

  test("session_distill source → inferred, score 0.6", () => {
    const c = assignDefaultConfidence("session_distill");
    expect(c.score).toBe(0.6);
    expect(c.reliability).toBe("inferred");
  });

  test("explicit override takes precedence", () => {
    const c = assignDefaultConfidence("agent", { score: 0.95, reliability: "direct" });
    expect(c.score).toBe(0.95);
    expect(c.reliability).toBe("direct");
  });

  test("explicit score only, reliability defaults to inferred", () => {
    const c = assignDefaultConfidence("manual", { score: 0.3 });
    expect(c.score).toBe(0.3);
    expect(c.reliability).toBe("inferred");
  });
});

// ---------------------------------------------------------------------------
// getConfidence — backward compat
// ---------------------------------------------------------------------------

describe("F1: getConfidence backward compatibility", () => {
  test("reads flat number confidence (legacy format)", () => {
    const entry = makeEntry({ confidence: 0.42 });
    expect(getConfidence(entry)).toBe(0.42);
  });

  test("reads structured confidence object", () => {
    const entry = makeEntry({ confidence: { score: 0.88, reliability: "direct" } });
    expect(getConfidence(entry)).toBe(0.88);
  });

  test("returns default when confidence missing", () => {
    const entry = makeEntry({});
    expect(getConfidence(entry)).toBe(CONFIDENCE_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// getConfidenceMetadata
// ---------------------------------------------------------------------------

describe("F1: getConfidenceMetadata", () => {
  test("extracts structured ConfidenceMetadata", () => {
    const entry = makeEntry({
      confidence: { score: 0.75, reliability: "hearsay", verifiedAt: 1000, verifiedBy: "user" },
    });
    const meta = getConfidenceMetadata(entry);
    expect(meta).not.toBeNull();
    expect(meta!.score).toBe(0.75);
    expect(meta!.reliability).toBe("hearsay");
    expect(meta!.verifiedAt).toBe(1000);
    expect(meta!.verifiedBy).toBe("user");
  });

  test("wraps legacy flat number into ConfidenceMetadata", () => {
    const entry = makeEntry({ confidence: 0.55 });
    const meta = getConfidenceMetadata(entry);
    expect(meta).not.toBeNull();
    expect(meta!.score).toBe(0.55);
    expect(meta!.reliability).toBe("inferred");
  });

  test("returns null when confidence missing", () => {
    const entry = makeEntry({});
    expect(getConfidenceMetadata(entry)).toBeNull();
  });
});
