import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSessionCheckpointRecord, buildSessionCheckpointResult, normalizeCheckpointScope, resolveCheckpointScope, type CheckpointQuality } from "../session-engine.js";
import { formatCheckpointRecallSummary, formatCheckpointSaved, formatCheckpointSummary, formatResumeContext } from "../session-output.js";
import { SessionCheckpointStore } from "../session-store.js";

describe("session checkpoint engine", () => {
  it("defaults checkpoint scope to session:<sessionId>", () => {
    const record = buildSessionCheckpointRecord({
      sessionId: "session-abc",
      summary: "Implement checkpoint storage",
    });

    expect(resolveCheckpointScope(record)).toBe("session:session-abc");
    expect(record.resolvedScope).toBe("session:session-abc");
  });
});

describe("SessionCheckpointStore", () => {
  it("saves and retrieves latest checkpoints by scope and session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-checkpoints-"));
    try {
      const store = new SessionCheckpointStore(dir);

      const first = await store.save(buildSessionCheckpointRecord({
        sessionId: "session-1",
        scope: "agent:codex",
        summary: "First checkpoint",
        nextActions: ["Implement checkpoint_session"],
        updatedAt: "2026-03-16T03:00:00.000Z",
      }));

      const second = await store.save(buildSessionCheckpointRecord({
        sessionId: "session-2",
        scope: "agent:codex",
        summary: "Second checkpoint",
        updatedAt: "2026-03-16T03:05:00.000Z",
      }));

      const latestByScope = await store.getLatest({ scope: "agent:codex" });
      const latestBySession = await store.getLatest({ sessionId: "session-1" });

      expect(latestByScope?.checkpointId).toBe(second.checkpointId);
      expect(latestBySession?.checkpointId).toBe(first.checkpointId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("session checkpoint output", () => {
  it("formats saved and summary views", () => {
    const record = buildSessionCheckpointRecord({
      sessionId: "session-xyz",
      summary: "Current task is implementing session checkpoints",
      decisions: ["Keep checkpoints out of LanceDB"],
      openLoops: ["Need resume_context next"],
      nextActions: ["Add latest checkpoint API"],
    });

    expect(formatCheckpointSaved(record)).toContain("Keep checkpoints out of LanceDB");
    expect(formatCheckpointSummary(record)).toContain("Latest checkpoint");
    expect(formatCheckpointSummary(null)).toBe("No checkpoint found.");
  });

  it("enriches recall checkpoint summaries with missing entity hints only once", () => {
    const record = buildSessionCheckpointRecord({
      sessionId: "session-entity-hints",
      summary: "Raised continuity coverage for RecallNest startup recovery.",
      entities: ["RecallNest", "smoke:claude-continuity", "resume_context"],
    });

    expect(formatCheckpointRecallSummary(record)).toBe(
      "Raised continuity coverage for RecallNest startup recovery. Entities: smoke:claude-continuity, resume_context",
    );
  });

  it("includes recall-only guidance in formatted resume context output", () => {
    const output = formatResumeContext({
      summary: "Stable context: Preference: 用户不喜欢 AI 味太重的文案语气。",
      resolvedScope: "project:writing",
      stableContext: ["Preference: 用户不喜欢 AI 味太重的文案语气。"],
      relevantPatterns: [],
      recentCases: [],
      latestCheckpoint: {
        sessionId: "session-writing",
        resolvedScope: "project:writing",
        summary: "Continue writing-style preference recovery.",
        updatedAt: "2026-03-16T04:30:00.000Z",
      },
      responseMode: "recall-only",
      responseGuidance: "Recall-only mode: answer from the recalled stable context item only.",
      generatedAt: "2026-03-16T04:40:00.000Z",
    });

    expect(output).toContain("Scope: project:writing");
    expect(output).toContain("Response mode: recall-only");
    expect(output).toContain("Guidance: Recall-only mode");
    expect(output).toContain("Stable context:");
  });

  it("sanitizes repo-state text out of checkpoint content", () => {
    const result = buildSessionCheckpointResult({
      sessionId: "session-repo-state",
      summary: "Only resumed context in this window. git status shows many modified files.",
      task: "Handle git status follow-up",
      decisions: ["Keep repo-state out of checkpoints."],
      openLoops: ["git status shows many uncommitted changes that still need review"],
      nextActions: ["Process modified files after checking git status locally"],
    });
    const { record } = result;

    expect(record.summary).toBe("Checkpoint captured current task state without repo-state details.");
    expect(record.task).toBeUndefined();
    expect(record.decisions).toEqual(["Keep repo-state out of checkpoints."]);
    expect(record.openLoops).toEqual(["Current repo state still needs local verification if it matters for the next task."]);
    expect(record.nextActions).toEqual(["Verify current repo state locally if it matters for the next task."]);
    expect(result.sanitization.changed).toBe(true);
    expect(result.sanitization.changedFields).toEqual(["summary", "task", "openLoops", "nextActions"]);
  });

  it("does not mark sanitization when checkpoint content is already clean", () => {
    const result = buildSessionCheckpointResult({
      sessionId: "session-clean",
      summary: "Continue wiring workflow observations into managed continuity.",
      task: "Hook managed continuity observations",
      decisions: ["Keep observations out of durable memory."],
      openLoops: ["Need to update the managed snippets."],
      nextActions: ["Add MCP and HTTP auto-observation coverage."],
    });

    expect(result.sanitization.changed).toBe(false);
    expect(result.sanitization.changedFields).toEqual([]);
  });
});

describe("checkpoint scope normalization", () => {
  it("normalizes bare project names to project: prefix", () => {
    expect(normalizeCheckpointScope("recallnest")).toBe("project:recallnest");
    expect(normalizeCheckpointScope("RecallNest")).toBe("project:recallnest");
    expect(normalizeCheckpointScope("telegram-bridge")).toBe("project:telegram-bridge");
  });

  it("preserves existing prefixes but lowercases", () => {
    expect(normalizeCheckpointScope("project:RecallNest")).toBe("project:recallnest");
    expect(normalizeCheckpointScope("session:abc")).toBe("session:abc");
    expect(normalizeCheckpointScope("eval:continuity")).toBe("eval:continuity");
  });

  it("applies normalization at save time via resolveCheckpointScope", () => {
    expect(resolveCheckpointScope({ sessionId: "s1", scope: "RecallNest" })).toBe("project:recallnest");
    expect(resolveCheckpointScope({ sessionId: "s1", scope: "project:RecallNest" })).toBe("project:recallnest");
    expect(resolveCheckpointScope({ sessionId: "s1" })).toBe("session:s1");
  });

  it("matches checkpoints across scope variants in getLatest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-scope-norm-"));
    try {
      const store = new SessionCheckpointStore(dir);

      // Save with bare "recallnest" — will be normalized to "project:recallnest"
      await store.save(buildSessionCheckpointRecord({
        sessionId: "s-bare",
        scope: "recallnest",
        summary: "Bare scope checkpoint",
      }));

      // Save with "project:RecallNest" — will be normalized to "project:recallnest"
      const later = buildSessionCheckpointRecord({
        sessionId: "s-cased",
        scope: "project:RecallNest",
        summary: "Cased scope checkpoint",
      });
      // Manually set a later timestamp
      (later as any).updatedAt = new Date(Date.now() + 1000).toISOString().replace(/\.\d+Z$/, ".000Z");
      await store.save(later);

      // Query with canonical "project:recallnest" should find both, return latest
      const latest = await store.getLatest({ scope: "project:recallnest" });
      expect(latest).not.toBeNull();
      expect(latest!.summary).toBe("Cased scope checkpoint");

      // Query with bare "recallnest" should also work
      const latestBare = await store.getLatest({ scope: "recallnest" });
      expect(latestBare).not.toBeNull();
      expect(latestBare!.summary).toBe("Cased scope checkpoint");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkpoint quality gate", () => {
  it("classifies checkpoints with fallback summary and empty fields as minimal", () => {
    const result = buildSessionCheckpointResult({
      sessionId: "s-empty",
      scope: "project:recallnest",
      summary: "git status shows 5 modified files and 3 untracked files",
    });
    // Summary was sanitized to fallback, no decisions/openLoops/nextActions
    expect(result.quality).toBe("minimal");
    expect(result.sanitization.changed).toBe(true);
  });

  it("classifies checkpoints with real content as rich", () => {
    const result = buildSessionCheckpointResult({
      sessionId: "s-rich",
      scope: "project:recallnest",
      summary: "Completed scope normalization and checkpoint quality gate.",
      decisions: ["Normalize scope at save and query time"],
    });
    expect(result.quality).toBe("rich");
  });

  it("classifies checkpoints with fallback summary but structured fields as rich", () => {
    const result = buildSessionCheckpointResult({
      sessionId: "s-mixed",
      scope: "project:recallnest",
      summary: "git status shows dirty worktree",
      decisions: ["Keep using bun for builds"],
    });
    // Summary sanitized to fallback but decisions non-empty → still rich
    expect(result.quality).toBe("rich");
  });

  it("prefers rich checkpoints over minimal ones in getLatest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-quality-gate-"));
    try {
      const store = new SessionCheckpointStore(dir);

      // Save a rich checkpoint first (older)
      await store.save(buildSessionCheckpointRecord({
        sessionId: "s-rich",
        scope: "project:recallnest",
        summary: "Good checkpoint with real content.",
        decisions: ["Keep checkpoints clean"],
        updatedAt: "2026-03-22T01:00:00.000Z",
      }));

      // Save a minimal checkpoint later (newer) — all-sanitized fallback
      await store.save(buildSessionCheckpointRecord({
        sessionId: "s-minimal",
        scope: "project:recallnest",
        summary: "Checkpoint captured current task state without repo-state details.",
        updatedAt: "2026-03-22T02:00:00.000Z",
      }));

      const latest = await store.getLatest({ scope: "project:recallnest" });
      expect(latest).not.toBeNull();
      // Should return the rich one even though it's older
      expect(latest!.summary).toBe("Good checkpoint with real content.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
