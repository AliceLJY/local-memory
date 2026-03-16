import { describe, expect, it } from "bun:test";

import { PromoteMemoryInputSchema, StoreMemoryInputSchema } from "../memory-schema.js";
import { ResumeContextRequestSchema, ResumeContextResponseSchema, SessionCheckpointInputSchema } from "../session-schema.js";

describe("StoreMemoryInputSchema", () => {
  it("normalizes whitespace, defaults, and deduplicates tags", () => {
    const parsed = StoreMemoryInputSchema.parse({
      text: "  User prefers   dark mode  ",
      category: "preferences",
      tags: [" ui ", "UI", "frontend"],
      canonicalKey: " user.reply.style ",
    });

    expect(parsed.text).toBe("User prefers dark mode");
    expect(parsed.importance).toBe(0.7);
    expect(parsed.source).toBe("manual");
    expect(parsed.tags).toEqual(["ui", "frontend"]);
    expect(parsed.canonicalKey).toBe("user.reply.style");
  });

  it("rejects unsupported categories", () => {
    expect(() => StoreMemoryInputSchema.parse({
      text: "Persist this",
      category: "decision",
    })).toThrow();
  });
});

describe("PromoteMemoryInputSchema", () => {
  it("applies defaults for evidence promotion", () => {
    const parsed = PromoteMemoryInputSchema.parse({
      memoryId: "12345678-1234-1234-1234-123456789abc",
    });

    expect(parsed.importance).toBe(0.78);
    expect(parsed.source).toBe("agent");
    expect(parsed.tags).toEqual([]);
  });
});

describe("SessionCheckpointInputSchema", () => {
  it("defaults updatedAt and deduplicates list fields", () => {
    const parsed = SessionCheckpointInputSchema.parse({
      sessionId: "session-123",
      summary: "  Working on continuity layer  ",
      decisions: ["Use session checkpoints", "use session checkpoints"],
      nextActions: ["Add MCP store_memory", " Add MCP store_memory "],
    });

    expect(parsed.summary).toBe("Working on continuity layer");
    expect(parsed.decisions).toEqual(["Use session checkpoints"]);
    expect(parsed.nextActions).toEqual(["Add MCP store_memory"]);
    expect(parsed.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("ResumeContext schemas", () => {
  it("applies defaults for request parsing", () => {
    const parsed = ResumeContextRequestSchema.parse({});

    expect(parsed.limitPerSection).toBe(3);
    expect(parsed.includeLatestCheckpoint).toBe(true);
    expect(parsed.profile).toBeUndefined();
  });

  it("preserves optional retrieval profile on request parsing", () => {
    const parsed = ResumeContextRequestSchema.parse({
      profile: "writing",
    });

    expect(parsed.profile).toBe("writing");
  });

  it("accepts a composed response payload", () => {
    const parsed = ResumeContextResponseSchema.parse({
      summary: "Bring forward user identity, recent cases, and the latest checkpoint.",
      stableContext: ["User works across Claude Code, Codex, and Gemini CLI"],
      relevantPatterns: ["Always search memory at task start"],
      recentCases: ["Fixed hybrid retrieval tuning last week"],
      latestCheckpoint: {
        sessionId: "session-123",
        summary: "Implement schema modules first",
        updatedAt: "2026-03-16T01:41:00.000Z",
      },
      generatedAt: "2026-03-16T01:42:00.000Z",
    });

    expect(parsed.latestCheckpoint?.sessionId).toBe("session-123");
    expect(parsed.stableContext).toHaveLength(1);
  });
});
