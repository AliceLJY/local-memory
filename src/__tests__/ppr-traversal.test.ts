import { describe, expect, it } from "bun:test";
import {
  buildGraph,
  pprTraverse,
  pprFromTriples,
  edgeWeight,
  DEFAULT_PPR_CONFIG,
} from "../ppr-traversal.js";
import type { KGTriple, NeighborhoodResult } from "../kg-store.js";

// ============================================================================
// Helpers
// ============================================================================

function makeTriple(
  subject: string,
  predicate: string,
  object: string,
  confidence = 0.9,
  id?: string,
): KGTriple {
  return {
    id: id ?? `${subject}-${predicate}-${object}`,
    scope: "test",
    subject,
    predicate,
    object,
    confidence,
    source_memory_id: `mem-${subject}-${object}`,
    source_text: `${subject} ${predicate} ${object}`,
    timestamp: Date.now(),
  };
}

function makeNeighborhood(triples: KGTriple[]): NeighborhoodResult[] {
  const entities = new Set<string>();
  for (const t of triples) {
    entities.add(t.subject);
    entities.add(t.object);
  }
  return [...entities].map(entity => ({
    entity,
    triples: triples.filter(t => t.subject === entity || t.object === entity),
    hops: 0,
  }));
}

// ============================================================================
// edgeWeight
// ============================================================================

describe("edgeWeight", () => {
  it("returns known weights for standard predicates", () => {
    expect(edgeWeight("created_by")).toBe(0.95);
    expect(edgeWeight("uses")).toBe(0.90);
    expect(edgeWeight("related_to")).toBe(0.50);
  });

  it("returns default weight for unknown predicates", () => {
    expect(edgeWeight("unknown_predicate")).toBe(0.60);
  });
});

// ============================================================================
// buildGraph
// ============================================================================

describe("buildGraph", () => {
  it("builds undirected graph from neighborhood", () => {
    const triples = [
      makeTriple("Alice", "uses", "Python"),
      makeTriple("Alice", "works_with", "Bob"),
    ];
    const neighborhood = makeNeighborhood(triples);
    const graph = buildGraph(neighborhood);

    expect(graph.nodes.size).toBe(3); // Alice, Python, Bob
    expect(graph.adj.get("Alice")?.length).toBe(2); // -> Python, -> Bob
    expect(graph.adj.get("Python")?.length).toBe(1); // -> Alice
    expect(graph.adj.get("Bob")?.length).toBe(1); // -> Alice
  });

  it("deduplicates triples by id", () => {
    const t = makeTriple("Alice", "uses", "Python", 0.9, "same-id");
    const neighborhood: NeighborhoodResult[] = [
      { entity: "Alice", triples: [t], hops: 0 },
      { entity: "Python", triples: [t], hops: 1 },
    ];
    const graph = buildGraph(neighborhood);

    // Should only have 1 edge per direction despite appearing in 2 neighborhood entries
    expect(graph.adj.get("Alice")?.length).toBe(1);
    expect(graph.adj.get("Python")?.length).toBe(1);
  });

  it("handles empty neighborhood", () => {
    const graph = buildGraph([]);
    expect(graph.nodes.size).toBe(0);
    expect(graph.adj.size).toBe(0);
  });
});

// ============================================================================
// pprTraverse — convergence
// ============================================================================

describe("pprTraverse", () => {
  it("converges on a simple chain A -> B -> C", () => {
    const triples = [
      makeTriple("A", "uses", "B"),
      makeTriple("B", "uses", "C"),
    ];
    const graph = buildGraph(makeNeighborhood(triples));
    const results = pprTraverse(graph, ["A"]);

    // A should have highest score (it's the seed)
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entity).toBe("A");

    // B should score higher than C (closer to seed)
    const bResult = results.find(r => r.entity === "B");
    const cResult = results.find(r => r.entity === "C");
    expect(bResult).toBeDefined();
    expect(cResult).toBeDefined();
    expect(bResult!.score).toBeGreaterThan(cResult!.score);
  });

  it("respects hop limits", () => {
    const triples = [
      makeTriple("A", "uses", "B"),
      makeTriple("B", "uses", "C"),
      makeTriple("C", "uses", "D"),
    ];
    const graph = buildGraph(makeNeighborhood(triples));
    const results = pprTraverse(graph, ["A"], { hopLimit: 1 });

    // With hopLimit=1, only A and B should be reachable
    const entities = results.map(r => r.entity);
    expect(entities).toContain("A");
    expect(entities).toContain("B");
    expect(entities).not.toContain("C");
    expect(entities).not.toContain("D");
  });

  it("handles multiple seed entities", () => {
    const triples = [
      makeTriple("A", "uses", "C"),
      makeTriple("B", "uses", "C"),
    ];
    const graph = buildGraph(makeNeighborhood(triples));
    const results = pprTraverse(graph, ["A", "B"]);

    // C should be reachable from both seeds
    const cResult = results.find(r => r.entity === "C");
    expect(cResult).toBeDefined();
    expect(cResult!.hops).toBe(1);
  });

  it("returns empty for empty graph", () => {
    const graph = buildGraph([]);
    const results = pprTraverse(graph, ["A"]);
    expect(results).toEqual([]);
  });

  it("returns empty when seeds not in graph", () => {
    const triples = [makeTriple("X", "uses", "Y")];
    const graph = buildGraph(makeNeighborhood(triples));
    const results = pprTraverse(graph, ["NotInGraph"]);
    expect(results).toEqual([]);
  });

  it("respects topK limit", () => {
    const triples = [
      makeTriple("A", "uses", "B"),
      makeTriple("A", "uses", "C"),
      makeTriple("A", "uses", "D"),
      makeTriple("A", "uses", "E"),
    ];
    const graph = buildGraph(makeNeighborhood(triples));
    const results = pprTraverse(graph, ["A"], { topK: 2 });
    expect(results.length).toBe(2);
  });

  it("computes shortest paths correctly", () => {
    const triples = [
      makeTriple("A", "uses", "B"),
      makeTriple("B", "uses", "C"),
    ];
    const graph = buildGraph(makeNeighborhood(triples));
    const results = pprTraverse(graph, ["A"]);

    const aResult = results.find(r => r.entity === "A");
    const bResult = results.find(r => r.entity === "B");
    const cResult = results.find(r => r.entity === "C");

    expect(aResult?.hops).toBe(0);
    expect(aResult?.path).toEqual(["A"]);
    expect(bResult?.hops).toBe(1);
    expect(bResult?.path).toEqual(["A", "B"]);
    expect(cResult?.hops).toBe(2);
    expect(cResult?.path).toEqual(["A", "B", "C"]);
  });

  it("edge weights affect scores — stronger predicates yield higher scores", () => {
    // Two separate subgraphs from same seed
    const triples = [
      makeTriple("A", "created_by", "B", 1.0), // weight 0.95
      makeTriple("A", "related_to", "C", 1.0), // weight 0.50
    ];
    const graph = buildGraph(makeNeighborhood(triples));
    const results = pprTraverse(graph, ["A"]);

    const bResult = results.find(r => r.entity === "B");
    const cResult = results.find(r => r.entity === "C");
    expect(bResult).toBeDefined();
    expect(cResult).toBeDefined();
    // B should score higher due to stronger edge weight
    expect(bResult!.score).toBeGreaterThan(cResult!.score);
  });

  it("all scores sum to approximately 1.0 (probability distribution)", () => {
    const triples = [
      makeTriple("A", "uses", "B"),
      makeTriple("B", "uses", "C"),
      makeTriple("C", "uses", "A"), // cycle
    ];
    const graph = buildGraph(makeNeighborhood(triples));
    const results = pprTraverse(graph, ["A"], { maxIterations: 50 });

    const totalScore = results.reduce((sum, r) => sum + r.score, 0);
    // PPR scores approximate a probability distribution
    expect(totalScore).toBeGreaterThan(0.8);
    expect(totalScore).toBeLessThan(1.2);
  });
});

// ============================================================================
// pprFromTriples (convenience)
// ============================================================================

describe("pprFromTriples", () => {
  it("works with raw triples", () => {
    const triples = [
      makeTriple("Alice", "uses", "Python"),
      makeTriple("Alice", "works_at", "Google"),
    ];
    const results = pprFromTriples(triples, ["Alice"]);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entity).toBe("Alice");

    const entities = results.map(r => r.entity);
    expect(entities).toContain("Python");
    expect(entities).toContain("Google");
  });
});
