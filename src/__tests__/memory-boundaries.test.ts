import { describe, expect, it } from "bun:test";

import {
  buildStructuredMemoryBoundary,
  buildDefaultCanonicalKey,
  extractBoundaryMetadata,
  extractMemoryProvenance,
  extractPromotedFrom,
  extractProvenanceHistory,
  extractProvenanceHistoryCount,
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

  // 端清单回归：memory-boundaries.ts 的 TRANSCRIPT_SOURCES / TRANSCRIPT_SCOPE_PREFIXES
  // 历史上漏过两次（kimi 2026-07-19 进栈、antigravity 07-29 进栈，都到 08-01 才发现）。
  // 根因不是"忘了改"，是**没有断言**——纯判断步骤没有测试撑着就会被跳过。
  // ⚠️ 接入新端时：先在下面的清单里加一行让测试变红，再去改常量把它变绿。
  it.each([
    ["cc", "cc:abc123"],
    ["codex", "codex:abc123"],
    ["gemini", "gemini:abc123"],
    ["kimi", "kimi:abc123"],
    ["antigravity", "antigravity:abc123"],
    ["minis", "minis:abc123"],
  ])("downgrades transcript profile facts for end %s", (source, scope) => {
    const resolved = resolveIngestBoundary({ source, scope, category: "profile" });

    expect(resolved.boundary.layer).toBe("evidence");
    expect(resolved.boundary.authority).toBe("transcript-ingest");
    expect(resolved.category).toBe("events");
  });

  // 反向断言：确认上面那组不是同义反复（如果任何 source 都被降权，那组测试就永远绿、
  // 等于没测）。一个不在清单里的来源必须**不**被当成 transcript。
  it("does not downgrade sources outside the transcript end list", () => {
    const resolved = resolveIngestBoundary({
      source: "manual",
      scope: "memory:pivot",
      category: "profile",
    });

    expect(resolved.boundary.layer).not.toBe("evidence");
    expect(resolved.category).toBe("profile");
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

  it("builds slot-aware canonical keys for atomic brand-item preferences", () => {
    expect(buildDefaultCanonicalKey({
      category: "preferences",
      text: "我喜欢吃麦当劳的麦辣鸡翅",
    })).toBe("preferences:brand-item:麦当劳:麦辣鸡翅");

    expect(buildDefaultCanonicalKey({
      category: "preferences",
      text: "User prefers concise, direct replies.",
    })).toBe("preferences:reply-style:concise:direct");

    expect(buildDefaultCanonicalKey({
      category: "preferences",
      text: "Uses Bun over Node.",
    })).toBe("preferences:tool-choice:bun:over:node");

    expect(buildDefaultCanonicalKey({
      category: "preferences",
      text: "我喜欢吃麦当劳的麦旋风、板烧鸡腿堡和麦辣鸡翅",
    })).toBe("preferences:我喜欢吃麦当劳的麦旋风-板烧鸡腿堡和麦辣鸡翅");
  });

  it("builds distinct canonical keys for different implicit-usage preferences (#6 regression)", () => {
    // 修复前 implicit-usage slot 无专属分支，落到 tool-choice 三元支、preferredTool/avoidedTool
    // 均 undefined → 全部坍缩成 'preferences:implicit-usage:over'，不同隐式偏好在 latest-wins
    // 下互相覆盖丢数据。现在用 slot.subject 区分。
    const figma = buildDefaultCanonicalKey({ category: "preferences", text: "I use Figma for design" });
    const python = buildDefaultCanonicalKey({ category: "preferences", text: "I use Python for scripting" });
    const sony = buildDefaultCanonicalKey({ category: "preferences", text: "我有一台索尼相机" });

    expect(figma).toBe("preferences:implicit-usage:figma");
    expect(python).toBe("preferences:implicit-usage:python");
    expect(new Set([figma, python, sony]).size).toBe(3);
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

    expect(extractProvenanceHistory(metadata)).toEqual([{
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
    }]);
    expect(extractProvenanceHistoryCount(metadata)).toBe(1);

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
      provenanceHistory: [{
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
      }],
      provenanceHistoryCount: 1,
    });
  });

  it("prefers explicit provenance history over fallback promotedFrom metadata", () => {
    const metadata = JSON.stringify({
      canonicalKey: "preferences:brand-item:麦当劳:麦辣鸡翅",
      boundary: buildStructuredMemoryBoundary("preferences"),
      promotedFrom: {
        memoryId: "12345678-1234-1234-1234-123456789abc",
        scope: "cc:session1",
        category: "events",
        source: "cc",
      },
      provenanceHistory: [
        {
          memoryId: "aaaaaaaa-1234-1234-1234-123456789abc",
          scope: "cc:session-food-1",
          category: "events",
          source: "cc",
          observedAt: "2026-03-17T04:00:00.000Z",
        },
        {
          memoryId: "bbbbbbbb-1234-1234-1234-123456789abc",
          scope: "cc:session-food-2",
          category: "events",
          source: "codex",
          observedAt: "2026-03-17T05:00:00.000Z",
        },
      ],
      provenanceHistoryCount: 2,
    });

    expect(extractProvenanceHistory(metadata)).toEqual([
      {
        memoryId: "aaaaaaaa-1234-1234-1234-123456789abc",
        scope: "cc:session-food-1",
        category: "events",
        source: "cc",
        observedAt: "2026-03-17T04:00:00.000Z",
        boundary: null,
      },
      {
        memoryId: "bbbbbbbb-1234-1234-1234-123456789abc",
        scope: "cc:session-food-2",
        category: "events",
        source: "codex",
        observedAt: "2026-03-17T05:00:00.000Z",
        boundary: null,
      },
    ]);
    expect(extractProvenanceHistoryCount(metadata)).toBe(2);
  });
});
