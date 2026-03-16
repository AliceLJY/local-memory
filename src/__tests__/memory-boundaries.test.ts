import { describe, expect, it } from "bun:test";

import {
  buildStructuredMemoryBoundary,
  extractBoundaryMetadata,
  extractMemoryProvenance,
  extractPromotedFrom,
  resolveIngestBoundary,
  shouldUseStableMemoryResult,
} from "../memory-boundaries.js";

describe("memory boundaries", () => {
  it("downgrades transcript-derived profile facts into evidence events", () => {
    const resolved = resolveIngestBoundary({
      source: "cc",
      scope: "cc:abc123",
      category: "profile",
    });

    expect(resolved.category).toBe("events");
    expect(resolved.boundary.layer).toBe("evidence");
    expect(resolved.boundary.authority).toBe("transcript-ingest");
    expect(resolved.boundary.downgradedFrom).toBe("profile");
  });

  it("keeps transcript cases searchable but marks them as evidence", () => {
    const resolved = resolveIngestBoundary({
      source: "codex",
      scope: "codex:session1",
      category: "cases",
    });

    expect(resolved.category).toBe("cases");
    expect(resolved.boundary.layer).toBe("evidence");
    expect(resolved.boundary.authority).toBe("transcript-ingest");
    expect(resolved.boundary.originalCategory).toBe("cases");
  });

  it("marks structured memory as durable authority", () => {
    const boundary = buildStructuredMemoryBoundary("preferences");

    expect(boundary).toEqual({
      layer: "durable",
      authority: "structured-memory",
      conflictPolicy: "latest-wins",
      originalCategory: "preferences",
      note: "Structured memory writes are the durable source inside RecallNest.",
    });
  });

  it("rejects transcript/evidence stable recall and keeps durable stable recall", () => {
    expect(shouldUseStableMemoryResult({
      category: "preferences",
      scope: "cc:session",
      metadata: JSON.stringify({
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
        },
      }),
    })).toBe(false);

    expect(shouldUseStableMemoryResult({
      category: "preferences",
      scope: "memory:agent",
      metadata: JSON.stringify({
        boundary: buildStructuredMemoryBoundary("preferences"),
      }),
    })).toBe(true);
  });

  it("parses valid boundary metadata and ignores malformed payloads", () => {
    expect(extractBoundaryMetadata(JSON.stringify({
      boundary: buildStructuredMemoryBoundary("patterns"),
    }))).toEqual(buildStructuredMemoryBoundary("patterns"));

    expect(extractBoundaryMetadata("{not-json")).toBeNull();
    expect(extractBoundaryMetadata(JSON.stringify({
      boundary: { layer: "durable", authority: "oops" },
    }))).toBeNull();
  });

  it("extracts promotedFrom provenance and canonical keys", () => {
    const metadata = JSON.stringify({
      canonicalKey: "user-reply-style",
      boundary: buildStructuredMemoryBoundary("preferences"),
      promotedFrom: {
        memoryId: "12345678-1234-1234-1234-123456789abc",
        scope: "cc:session1",
        category: "events",
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      },
    });

    expect(extractPromotedFrom(metadata)).toEqual({
      memoryId: "12345678-1234-1234-1234-123456789abc",
      scope: "cc:session1",
      category: "events",
      source: "cc",
      boundary: {
        layer: "evidence",
        authority: "transcript-ingest",
        conflictPolicy: "append-only",
        originalCategory: "preferences",
      },
    });

    expect(extractMemoryProvenance({
      scope: "memory:agent",
      metadata,
    })).toEqual({
      boundary: buildStructuredMemoryBoundary("preferences"),
      canonicalKey: "user-reply-style",
      promotedFrom: {
        memoryId: "12345678-1234-1234-1234-123456789abc",
        scope: "cc:session1",
        category: "events",
        source: "cc",
        boundary: {
          layer: "evidence",
          authority: "transcript-ingest",
          conflictPolicy: "append-only",
          originalCategory: "preferences",
        },
      },
    });
  });
});
