/**
 * Phase 4: Constructive Retrieval — tests for candidate expansion,
 * source-map grounding, contradiction detection, and reconstruction pipeline.
 */
import { describe, test, expect } from "bun:test";
import {
  expandCandidates,
  detectContradictions,
  computeSourceMapCoverage,
  buildPrompt,
  reconstruct,
  extractCitedIds,
  shouldReconstruct,
  type CandidateExpansionDeps,
  type ReconstructionInput,
  type ReconstructionLLMClient,
  type ReconstructionOutput,
} from "../context-reconstructor.js";
import type { RetrievalResult } from "../retriever.js";

// ============================================================================
// Test Helpers
// ============================================================================

function makeResult(id: string, text: string, importance = 0.7, score = 0.8): RetrievalResult {
  return {
    entry: {
      id,
      text,
      importance,
      category: "entities",
      scope: "test",
      timestamp: Date.now(),
      metadata: "{}",
      vector: new Float32Array(0),
    },
    score,
    sources: {},
  };
}

function makeMockLLM(response: string | null): ReconstructionLLMClient {
  return {
    generateReconstruction: async () => response,
  };
}

// ============================================================================
// expandCandidates
// ============================================================================

describe("expandCandidates", () => {
  test("tags direct results and returns source map", async () => {
    const direct = [makeResult("a", "memory A"), makeResult("b", "memory B")];
    const { results, sourceMap } = await expandCandidates(direct, {});
    expect(results).toHaveLength(2);
    expect(sourceMap.get("a")).toEqual({ type: "direct" });
    expect(sourceMap.get("b")).toEqual({ type: "direct" });
  });

  test("expands via KG neighbors", async () => {
    const direct = [makeResult("a", "memory A")];
    const deps: CandidateExpansionDeps = {
      expandViaKG: async () => [makeResult("kg1", "KG neighbor")],
    };
    const { results, sourceMap } = await expandCandidates(direct, deps);
    expect(results).toHaveLength(2);
    expect(sourceMap.get("kg1")).toEqual({ type: "kg_neighbor" });
  });

  test("expands via evolution chains", async () => {
    const direct = [makeResult("a", "memory A")];
    const deps: CandidateExpansionDeps = {
      expandViaEvolution: async () => [makeResult("evo1", "evolution successor")],
    };
    const { results, sourceMap } = await expandCandidates(direct, deps);
    expect(results).toHaveLength(2);
    expect(sourceMap.get("evo1")).toEqual({ type: "evolution_chain" });
  });

  test("expands via clusters", async () => {
    const direct = [makeResult("a", "memory A")];
    const deps: CandidateExpansionDeps = {
      expandViaClusters: async () => [makeResult("cl1", "cluster member")],
    };
    const { results, sourceMap } = await expandCandidates(direct, deps);
    expect(results).toHaveLength(2);
    expect(sourceMap.get("cl1")).toEqual({ type: "cluster_member" });
  });

  test("expands via narrative siblings", async () => {
    const direct = [makeResult("a", "memory A")];
    const deps: CandidateExpansionDeps = {
      expandViaNarrative: async () => [makeResult("ns1", "narrative sibling")],
    };
    const { results, sourceMap } = await expandCandidates(direct, deps);
    expect(results).toHaveLength(2);
    expect(sourceMap.get("ns1")).toEqual({ type: "narrative_sibling" });
  });

  test("deduplicates across expansion sources", async () => {
    const direct = [makeResult("a", "memory A")];
    const deps: CandidateExpansionDeps = {
      expandViaKG: async () => [makeResult("shared", "from KG")],
      expandViaEvolution: async () => [makeResult("shared", "from evo")],
    };
    const { results, sourceMap } = await expandCandidates(direct, deps);
    expect(results).toHaveLength(2);
    // First expansion wins
    expect(sourceMap.get("shared")).toEqual({ type: "kg_neighbor" });
  });

  test("respects EXPANSION_CAP of 20", async () => {
    const direct = Array.from({ length: 15 }, (_, i) => makeResult(`d${i}`, `direct ${i}`));
    const deps: CandidateExpansionDeps = {
      expandViaKG: async () => Array.from({ length: 10 }, (_, i) => makeResult(`kg${i}`, `kg ${i}`)),
    };
    const { results } = await expandCandidates(direct, deps);
    expect(results.length).toBeLessThanOrEqual(20);
  });

  test("handles expansion failures gracefully", async () => {
    const direct = [makeResult("a", "memory A")];
    const deps: CandidateExpansionDeps = {
      expandViaKG: async () => { throw new Error("KG unavailable"); },
      expandViaEvolution: async () => [makeResult("evo1", "evolution ok")],
    };
    const { results } = await expandCandidates(direct, deps);
    expect(results).toHaveLength(2); // direct + evolution (KG failed silently)
  });

  test("no expansion deps returns only direct results", async () => {
    const direct = [makeResult("a", "A"), makeResult("b", "B")];
    const { results, sourceMap } = await expandCandidates(direct, {});
    expect(results).toHaveLength(2);
    expect(sourceMap.size).toBe(2);
  });

  test("parallel expansion sources all contribute", async () => {
    const direct = [makeResult("a", "memory A")];
    const deps: CandidateExpansionDeps = {
      expandViaKG: async () => [makeResult("kg1", "KG")],
      expandViaEvolution: async () => [makeResult("evo1", "evo")],
      expandViaClusters: async () => [makeResult("cl1", "cluster")],
      expandViaNarrative: async () => [makeResult("ns1", "narrative")],
    };
    const { results, sourceMap } = await expandCandidates(direct, deps);
    expect(results).toHaveLength(5);
    expect(sourceMap.get("kg1")?.type).toBe("kg_neighbor");
    expect(sourceMap.get("evo1")?.type).toBe("evolution_chain");
    expect(sourceMap.get("cl1")?.type).toBe("cluster_member");
    expect(sourceMap.get("ns1")?.type).toBe("narrative_sibling");
  });
});

// ============================================================================
// detectContradictions
// ============================================================================

describe("detectContradictions", () => {
  test("detects negation-pattern contradiction", () => {
    const results = [
      makeResult("a", "You should always use TypeScript for projects"),
      makeResult("b", "You should not always use TypeScript for every project"),
    ];
    const contradictions = detectContradictions(results);
    expect(contradictions.length).toBeGreaterThanOrEqual(1);
    expect(contradictions[0].memoryIds).toEqual(["a", "b"]);
  });

  test("no contradictions for compatible memories", () => {
    const results = [
      makeResult("a", "User prefers dark mode"),
      makeResult("b", "User uses Bun runtime"),
    ];
    expect(detectContradictions(results)).toHaveLength(0);
  });

  test("caps at 5 contradictions", () => {
    // Create many contradicting pairs
    const results: RetrievalResult[] = [];
    for (let i = 0; i < 12; i++) {
      const text = i % 2 === 0
        ? `Feature ${Math.floor(i / 2)} must always be enabled for deployment`
        : `Feature ${Math.floor(i / 2)} should never be enabled for deployment`;
      results.push(makeResult(`m${i}`, text));
    }
    const contradictions = detectContradictions(results);
    expect(contradictions.length).toBeLessThanOrEqual(5);
  });

  test("handles empty results", () => {
    expect(detectContradictions([])).toHaveLength(0);
  });

  test("handles single result", () => {
    expect(detectContradictions([makeResult("a", "solo")])).toHaveLength(0);
  });
});

// ============================================================================
// computeSourceMapCoverage
// ============================================================================

describe("computeSourceMapCoverage", () => {
  test("full coverage when all sentences have valid citations", () => {
    const text = "User works on RecallNest [src:a]. They use Bun runtime [src:b].";
    const validIds = new Set(["a", "b"]);
    expect(computeSourceMapCoverage(text, validIds)).toBe(1.0);
  });

  test("partial coverage when some sentences lack citations", () => {
    const text = "User works on RecallNest [src:a]. No citation here. Another fact [src:b].";
    const validIds = new Set(["a", "b"]);
    const coverage = computeSourceMapCoverage(text, validIds);
    expect(coverage).toBeGreaterThan(0.5);
    expect(coverage).toBeLessThan(1.0);
  });

  test("zero coverage when no valid citations", () => {
    const text = "Some text [src:invalid]. More text [src:also_invalid].";
    const validIds = new Set(["real_id"]);
    expect(computeSourceMapCoverage(text, validIds)).toBe(0);
  });

  test("handles empty text", () => {
    expect(computeSourceMapCoverage("", new Set(["a"]))).toBe(0);
  });

  test("filters out short sentences (<=5 chars)", () => {
    const text = "OK. User works on RecallNest [src:a].";
    const coverage = computeSourceMapCoverage(text, new Set(["a"]));
    expect(coverage).toBe(1.0); // "OK." is filtered, only the cited sentence counts
  });
});

// ============================================================================
// buildPrompt (checkpoint context injection)
// ============================================================================

describe("buildPrompt with checkpoint context", () => {
  const baseInput: ReconstructionInput = {
    query: "test query",
    results: [makeResult("a", "memory A"), makeResult("b", "memory B"), makeResult("c", "memory C")],
    mode: "resume",
  };

  test("includes open loops in system prompt", () => {
    const input: ReconstructionInput = {
      ...baseInput,
      checkpointContext: {
        openLoops: ["Fix CI pipeline", "Review PR #42"],
      },
    };
    const { system } = buildPrompt(input);
    expect(system).toContain("Open loops");
    expect(system).toContain("Fix CI pipeline");
    expect(system).toContain("Review PR #42");
  });

  test("includes next actions in system prompt", () => {
    const input: ReconstructionInput = {
      ...baseInput,
      checkpointContext: {
        nextActions: ["Deploy to staging", "Run integration tests"],
      },
    };
    const { system } = buildPrompt(input);
    expect(system).toContain("Next actions");
    expect(system).toContain("Deploy to staging");
  });

  test("includes scope in system prompt", () => {
    const input: ReconstructionInput = {
      ...baseInput,
      checkpointContext: { scope: "project:recallnest" },
    };
    const { system } = buildPrompt(input);
    expect(system).toContain("Active scope: project:recallnest");
  });

  test("no checkpoint context = no checkpoint hint", () => {
    const { system } = buildPrompt(baseInput);
    expect(system).not.toContain("Checkpoint state");
  });

  test("empty checkpoint context = no checkpoint hint", () => {
    const input: ReconstructionInput = {
      ...baseInput,
      checkpointContext: {},
    };
    const { system } = buildPrompt(input);
    expect(system).not.toContain("Checkpoint state");
  });
});

// ============================================================================
// reconstruct (full pipeline)
// ============================================================================

describe("reconstruct pipeline", () => {
  const baseResults = [
    makeResult("m1", "User prefers TypeScript"),
    makeResult("m2", "Project uses Bun runtime"),
    makeResult("m3", "Deploy target is Docker"),
  ];

  test("returns reconstructed text with typed sources", async () => {
    const llm = makeMockLLM(
      "The user prefers TypeScript [src:m1]. The project uses Bun [src:m2]. Deployed via Docker [src:m3]."
    );
    const result = await reconstruct(
      { query: "project setup", results: baseResults, mode: "search" },
      llm,
    );
    expect(result.reconstructed).toBeTruthy();
    expect(result.sources.length).toBeGreaterThanOrEqual(1);
    // Sources have typed structure
    for (const s of result.sources) {
      expect(s).toHaveProperty("id");
      expect(s).toHaveProperty("source");
      expect(s.source).toHaveProperty("type");
      expect(s).toHaveProperty("contribution");
    }
  });

  test("returns contradictions array (even when empty)", async () => {
    const llm = makeMockLLM("Summary [src:m1]. Info [src:m2]. Details [src:m3].");
    const result = await reconstruct(
      { query: "test", results: baseResults, mode: "search" },
      llm,
    );
    expect(result).toHaveProperty("contradictions");
    expect(Array.isArray(result.contradictions)).toBe(true);
  });

  test("returns coverage score", async () => {
    const llm = makeMockLLM("Cited fact [src:m1]. Another fact [src:m2]. Third fact [src:m3].");
    const result = await reconstruct(
      { query: "test", results: baseResults, mode: "search" },
      llm,
    );
    expect(result).toHaveProperty("coverage");
    expect(typeof result.coverage).toBe("number");
  });

  test("fallback on LLM empty response", async () => {
    const llm = makeMockLLM(null);
    const result = await reconstruct(
      { query: "test", results: baseResults, mode: "search" },
      llm,
    );
    expect(result.reconstructed).toBeNull();
    expect(result.fallbackReason).toBe("llm_empty");
    expect(result.sources).toHaveLength(0);
    expect(result.contradictions).toHaveLength(0);
  });

  test("fallback on low grounding coverage", async () => {
    // Response with no valid citations
    const llm = makeMockLLM("Some text without any citations. Another ungrounded sentence.");
    const result = await reconstruct(
      { query: "test", results: baseResults, mode: "search" },
      llm,
    );
    expect(result.reconstructed).toBeNull();
    expect(result.fallbackReason).toBe("low_grounding");
  });

  test("removes sentences with invalid IDs and lowers confidence", async () => {
    const llm = makeMockLLM(
      "Valid fact [src:m1]. Fake source [src:FAKE]. Another valid [src:m2]. Third valid [src:m3]."
    );
    const result = await reconstruct(
      { query: "test", results: baseResults, mode: "search" },
      llm,
    );
    if (result.reconstructed) {
      expect(result.reconstructed).not.toContain("[src:FAKE]");
      expect(result.confidence).toBeLessThan(1.0);
    }
  });

  test("respects 3s timeout", async () => {
    const slowLLM: ReconstructionLLMClient = {
      generateReconstruction: async () => {
        await new Promise(r => setTimeout(r, 4000));
        return "too late [src:m1]";
      },
    };
    const result = await reconstruct(
      { query: "test", results: baseResults, mode: "search" },
      slowLLM,
    );
    expect(result.fallbackReason).toBe("timeout");
  }, 6000);

  test("with expansion deps — expanded candidates used in reconstruction", async () => {
    const expanded = makeResult("exp1", "expanded info");
    const deps: CandidateExpansionDeps = {
      expandViaKG: async () => [expanded],
    };
    const llm = makeMockLLM(
      "Main fact [src:m1]. KG expanded [src:exp1]. More info [src:m2]. Detail [src:m3]."
    );
    const result = await reconstruct(
      { query: "test", results: baseResults, mode: "search" },
      llm,
      deps,
    );
    expect(result.reconstructed).toBeTruthy();
    // Check that expanded source is tracked as kg_neighbor
    const expSource = result.sources.find(s => s.id === "exp1");
    expect(expSource).toBeTruthy();
    expect(expSource!.source.type).toBe("kg_neighbor");
  });

  test("source contributions extracted from cited sentences", async () => {
    const llm = makeMockLLM(
      "The user loves TypeScript and uses it everywhere [src:m1]. Bun is the runtime [src:m2]. Docker deploys [src:m3]."
    );
    const result = await reconstruct(
      { query: "test", results: baseResults, mode: "search" },
      llm,
    );
    if (result.sources.length > 0) {
      const m1Source = result.sources.find(s => s.id === "m1");
      expect(m1Source?.contribution).toBeTruthy();
      expect(m1Source?.contribution).toContain("TypeScript");
    }
  });

  test("checkpoint context passed through to LLM", async () => {
    let capturedSystem = "";
    const spy: ReconstructionLLMClient = {
      generateReconstruction: async (system, _user) => {
        capturedSystem = system;
        return "Fact [src:m1]. Detail [src:m2]. Info [src:m3].";
      },
    };
    await reconstruct(
      {
        query: "test",
        results: baseResults,
        mode: "resume",
        checkpointContext: {
          openLoops: ["Fix bug #99"],
          scope: "project:test",
        },
      },
      spy,
    );
    expect(capturedSystem).toContain("Fix bug #99");
    expect(capturedSystem).toContain("project:test");
  });
});

// ============================================================================
// Integration: ReconstructionOutput shape contract
// ============================================================================

describe("ReconstructionOutput shape", () => {
  test("successful reconstruction has all required fields", async () => {
    const results = [
      makeResult("a", "fact A"),
      makeResult("b", "fact B"),
      makeResult("c", "fact C"),
    ];
    const llm = makeMockLLM("Summary of A [src:a]. Summary of B [src:b]. Summary of C [src:c].");
    const output = await reconstruct(
      { query: "test", results, mode: "search" },
      llm,
    );

    // Shape validation
    expect(output).toHaveProperty("reconstructed");
    expect(output).toHaveProperty("sources");
    expect(output).toHaveProperty("confidence");
    expect(output).toHaveProperty("contradictions");
    expect(output).toHaveProperty("coverage");
    expect(output).toHaveProperty("raw");

    // Type validation
    expect(typeof output.confidence).toBe("number");
    expect(typeof output.coverage).toBe("number");
    expect(Array.isArray(output.sources)).toBe(true);
    expect(Array.isArray(output.contradictions)).toBe(true);
    expect(Array.isArray(output.raw)).toBe(true);
  });

  test("failed reconstruction has all required fields", async () => {
    const results = [
      makeResult("a", "fact A"),
      makeResult("b", "fact B"),
      makeResult("c", "fact C"),
    ];
    const llm = makeMockLLM(null);
    const output = await reconstruct(
      { query: "test", results, mode: "search" },
      llm,
    );

    expect(output.reconstructed).toBeNull();
    expect(output.sources).toHaveLength(0);
    expect(output.contradictions).toHaveLength(0);
    expect(output.coverage).toBe(0);
    expect(output.fallbackReason).toBeTruthy();
  });
});
