import { describe, expect, it } from "bun:test";

import type { RetrievalResult } from "../retriever.js";
import { formatBriefResults, formatFullResults } from "../memory-output.js";
import { persistMemoryBatch } from "../capture-engine.js";

// ============================================================================
// Helpers
// ============================================================================

function makeResult(overrides: {
  id?: string;
  text?: string;
  score?: number;
  metadata?: string;
  category?: string;
  importance?: number;
  timestamp?: number;
} = {}): RetrievalResult {
  return {
    entry: {
      id: overrides.id ?? "abcdef12-3456-7890-abcd-ef1234567890",
      text: overrides.text ?? "Default memory text for testing purposes",
      vector: [0.1, 0.2, 0.3],
      category: overrides.category ?? "events",
      scope: "project:test",
      importance: overrides.importance ?? 0.7,
      timestamp: overrides.timestamp ?? 1_700_000_000_000,
      metadata: overrides.metadata,
    },
    score: overrides.score ?? 0.85,
    sources: {
      vector: { score: 0.8, rank: 1 },
      fused: { score: overrides.score ?? 0.85 },
    },
  };
}

function createDeps() {
  const storedEntries: Record<string, unknown>[] = [];
  const conflicts: Record<string, unknown>[] = [];
  let seq = 1;

  return {
    storedEntries,
    conflicts,
    deps: {
      embedder: {
        async embedPassage(_text: string) {
          return [1, 0, 0];
        },
      },
      store: {
        async store(entry: Record<string, unknown>) {
          const stored = {
            ...entry,
            id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
            timestamp: 1_700_000_000_000 + seq,
          };
          seq += 1;
          storedEntries.push(stored);
          return stored;
        },
        async search(_params: Record<string, unknown>) {
          return [];
        },
        async getByScope(_scope: string) {
          return [];
        },
      },
      conflictStore: {
        async save(record: Record<string, unknown>) {
          conflicts.push(record);
          return record;
        },
      },
      kgExtractor: null,
    },
  };
}

// ============================================================================
// MCP-1: list_tools
// ============================================================================

describe("MCP-1: list_tools tier discovery", () => {
  // We test the tier filtering logic directly since we can't easily instantiate the MCP server.
  // The TOOL_TIERS map and tier logic is exercised here.

  const TOOL_TIERS: Record<string, string> = {
    resume_context: "core",
    search_memory: "core",
    store_memory: "core",
    checkpoint_session: "core",
    latest_checkpoint: "core",
    list_tools: "core",
    set_reminder: "core",
    batch_store: "advanced",
    auto_capture: "advanced",
    store_case: "advanced",
    store_workflow_pattern: "advanced",
    promote_memory: "advanced",
    explain_memory: "advanced",
    distill_memory: "advanced",
    brief_memory: "advanced",
    pin_memory: "advanced",
    list_assets: "advanced",
    list_pins: "advanced",
    memory_stats: "advanced",
    memory_drill_down: "advanced",
    export_memory: "advanced",
    store_skill: "advanced",
    retrieve_skill: "advanced",
    scan_skill_promotions: "governance",
    workflow_observe: "governance",
    workflow_health: "governance",
  };

  function listToolsForTier(requestedTier: "core" | "advanced" | "full"): string[] {
    const tierOrder: Record<string, number> = { core: 0, advanced: 1, governance: 2 };
    const maxOrder = requestedTier === "full" ? 2 : tierOrder[requestedTier] ?? 1;
    return Object.entries(TOOL_TIERS)
      .filter(([, toolTier]) => (tierOrder[toolTier] ?? 999) <= maxOrder)
      .map(([name]) => name);
  }

  it("returns only core tier tools when tier=core", () => {
    const tools = listToolsForTier("core");
    expect(tools).toContain("resume_context");
    expect(tools).toContain("search_memory");
    expect(tools).toContain("list_tools");
    expect(tools).not.toContain("auto_capture");
    expect(tools).not.toContain("workflow_observe");
    // Core should have exactly our known core tools
    for (const t of tools) {
      expect(TOOL_TIERS[t]).toBe("core");
    }
  });

  it("returns core + advanced tools when tier=advanced", () => {
    const tools = listToolsForTier("advanced");
    // Should include core
    expect(tools).toContain("resume_context");
    expect(tools).toContain("search_memory");
    expect(tools).toContain("list_tools");
    // Should include advanced
    expect(tools).toContain("auto_capture");
    expect(tools).toContain("batch_store");
    expect(tools).toContain("explain_memory");
    // Should NOT include governance
    expect(tools).not.toContain("workflow_observe");
    expect(tools).not.toContain("scan_skill_promotions");
  });

  it("returns all tools when tier=full", () => {
    const tools = listToolsForTier("full");
    expect(tools).toContain("resume_context");
    expect(tools).toContain("auto_capture");
    expect(tools).toContain("workflow_observe");
    expect(tools).toContain("scan_skill_promotions");
    expect(tools.length).toBe(Object.keys(TOOL_TIERS).length);
  });
});

// ============================================================================
// MCP-2: formatBriefResults and formatFullResults
// ============================================================================

describe("MCP-2: formatBriefResults", () => {
  it("returns no results message for empty array", () => {
    const result = formatBriefResults([], { query: "test" });
    expect(result).toBe("No results found.");
  });

  it("renders correct brief format", () => {
    const results = [
      makeResult({ id: "aabbccdd-1111-2222-3333-444455556666", score: 0.92, text: "User prefers TypeScript for all projects" }),
      makeResult({ id: "11223344-aaaa-bbbb-cccc-ddddeeeeffff", score: 0.78, text: "Project RecallNest uses LanceDB" }),
    ];
    const output = formatBriefResults(results, { query: "typescript" });
    expect(output).toContain("Query: typescript");
    expect(output).toContain("Hits: 2");
    expect(output).toContain("#1 aabbccdd 92%");
    expect(output).toContain("#2 11223344 78%");
    expect(output).toContain("User prefers TypeScript");
  });

  it("uses l0_abstract from metadata when available", () => {
    const meta = JSON.stringify({ l0_abstract: "Short L0 summary for this memory" });
    const results = [
      makeResult({ metadata: meta, text: "Very long original text that should not appear in brief mode because the l0_abstract is available" }),
    ];
    const output = formatBriefResults(results, { query: "test" });
    expect(output).toContain("Short L0 summary");
    expect(output).not.toContain("Very long original text");
  });

  it("each brief result line is at most 120 characters", () => {
    const results = [
      makeResult({ text: "A".repeat(200) }),
      makeResult({ id: "zzzzzzzz-0000-0000-0000-000000000000", text: "Short text" }),
    ];
    const output = formatBriefResults(results, { query: "q" });
    const lines = output.split("\n");
    // Only check result lines (starting with #)
    for (const line of lines) {
      if (line.startsWith("#")) {
        expect(line.length).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe("MCP-2: formatFullResults", () => {
  it("includes metadata details in full mode", () => {
    const meta = JSON.stringify({ evolutionStatus: "stable", accessCount: 5, tags: ["ts", "dev"] });
    const results = [
      makeResult({ metadata: meta, importance: 0.85 }),
    ];
    const output = formatFullResults(results, { query: "test", profile: "default" });
    expect(output).toContain("meta :");
    expect(output).toContain("evolution=stable");
    expect(output).toContain("accessCount=5");
    expect(output).toContain("importance=0.85");
    expect(output).toContain("tags=[ts, dev]");
  });

  it("shows dash for missing metadata fields", () => {
    const results = [makeResult({})];
    const output = formatFullResults(results, { query: "q", profile: "default" });
    expect(output).toContain("evolution=-");
    expect(output).toContain("accessCount=-");
    expect(output).toContain("tags=[-]");
  });
});

// ============================================================================
// MCP-3: batch_store via persistMemoryBatch
// ============================================================================

describe("MCP-3: batch_store", () => {
  it("stores multiple memories and returns all records", async () => {
    const { deps, storedEntries } = createDeps();
    const stored = await persistMemoryBatch(deps as Parameters<typeof persistMemoryBatch>[0], {
      scope: "project:test",
      source: "agent",
      defaultImportance: 0.7,
      memories: [
        { text: "Memory one about TypeScript preferences", category: "preferences" },
        { text: "Memory two about project structure", category: "entities" },
        { text: "Memory three about debugging workflow", category: "patterns" },
      ],
    });

    expect(stored).toHaveLength(3);
    expect(storedEntries).toHaveLength(3);
    expect(stored[0].disposition).toBe("stored");
    expect(stored[1].disposition).toBe("stored");
    expect(stored[2].disposition).toBe("stored");
  });

  it("returns correct disposition counts", async () => {
    const { deps } = createDeps();
    const stored = await persistMemoryBatch(deps as Parameters<typeof persistMemoryBatch>[0], {
      scope: "project:test",
      source: "agent",
      defaultImportance: 0.7,
      memories: [
        { text: "First memory item" },
        { text: "Second memory item" },
      ],
    });

    // Count dispositions the same way the MCP handler does
    const counts = { new: 0, deduped: 0, updated: 0 };
    for (const r of stored) {
      if (r.disposition === "deduped") counts.deduped++;
      else if (r.disposition === "updated") counts.updated++;
      else counts.new++;
    }

    expect(counts.new).toBe(2);
    expect(counts.deduped).toBe(0);
    expect(counts.updated).toBe(0);
    expect(`Stored ${stored.length} memories (${counts.new} new, ${counts.deduped} deduped, ${counts.updated} updated)`)
      .toBe("Stored 2 memories (2 new, 0 deduped, 0 updated)");
  });
});
