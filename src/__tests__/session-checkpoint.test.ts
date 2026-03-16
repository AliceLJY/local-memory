import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSessionCheckpointRecord, resolveCheckpointScope } from "../session-engine.js";
import { formatCheckpointSaved, formatCheckpointSummary, formatResumeContext } from "../session-output.js";
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

  it("includes recall-only guidance in formatted resume context output", () => {
    const output = formatResumeContext({
      summary: "Stable context: Preference: 用户不喜欢 AI 味太重的文案语气。",
      stableContext: ["Preference: 用户不喜欢 AI 味太重的文案语气。"],
      relevantPatterns: [],
      recentCases: [],
      responseMode: "recall-only",
      responseGuidance: "Recall-only mode: answer from the recalled stable context item only.",
      generatedAt: "2026-03-16T04:40:00.000Z",
    });

    expect(output).toContain("Response mode: recall-only");
    expect(output).toContain("Guidance: Recall-only mode");
    expect(output).toContain("Stable context:");
  });
});
