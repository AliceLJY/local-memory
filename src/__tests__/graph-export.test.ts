import { describe, expect, it } from "bun:test";
import { buildMemoryGraph, renderGraphHTML, formatGraphExportResult } from "../graph-export.js";
import type { MemoryEntry, MemoryStore } from "../store.js";
import type { MemoryGraph } from "../graph-export.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    text: "test memory",
    vector: [1, 0, 0, 0, 0],
    category: "events",
    scope: "project:test",
    importance: 0.7,
    timestamp: Date.now(),
    metadata: JSON.stringify({
      evolution: {
        status: "active",
        version: 1,
        accessCount: 3,
        lastAccessedAt: null,
        supersededBy: null,
        supersedes: null,
        evolutionNote: null,
        consolidatedInto: null,
        contributedToPattern: null,
        sourceMemories: [],
        validFrom: Date.now(),
        validUntil: null,
      },
    }),
    ...overrides,
  };
}

function createMockStore(entries: MemoryEntry[]): Pick<MemoryStore, "list"> {
  return {
    async list() { return entries; },
  } as Pick<MemoryStore, "list">;
}

// ---------------------------------------------------------------------------
// buildMemoryGraph
// ---------------------------------------------------------------------------

describe("buildMemoryGraph", () => {
  it("returns nodes for active entries", async () => {
    const entries = [
      makeEntry({ id: "a1", text: "User prefers dark mode", category: "preferences" }),
      makeEntry({ id: "a2", text: "Project uses Bun runtime", category: "entities" }),
    ];
    const store = createMockStore(entries);
    const graph = await buildMemoryGraph(store);

    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0].category).toBe("preferences");
    expect(graph.nodes[1].category).toBe("entities");
  });

  it("limits nodes to maxNodes", async () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      makeEntry({ id: `n${i}`, importance: 1 - i * 0.01 })
    );
    const store = createMockStore(entries);
    const graph = await buildMemoryGraph(store, { maxNodes: 10 });

    expect(graph.nodes).toHaveLength(10);
    // Should have the highest-importance nodes
    expect(graph.nodes[0].importance).toBe(1);
    expect(graph.nodes[9].importance).toBe(0.91);
  });

  it("skips non-active entries", async () => {
    const activeEntry = makeEntry({ id: "active1", text: "I am active" });
    const supersededEntry = makeEntry({
      id: "sup1",
      text: "I am superseded",
      metadata: JSON.stringify({
        evolution: {
          status: "superseded",
          version: 1,
          accessCount: 0,
          lastAccessedAt: null,
          supersededBy: "active1",
          supersedes: null,
          evolutionNote: null,
          consolidatedInto: null,
          contributedToPattern: null,
          sourceMemories: [],
          validFrom: Date.now(),
          validUntil: Date.now(),
        },
      }),
    });
    const store = createMockStore([activeEntry, supersededEntry]);
    const graph = await buildMemoryGraph(store);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].id).toBe("active1");
  });

  it("builds supersede edges from evolution metadata", async () => {
    const oldEntry = makeEntry({
      id: "old1",
      text: "Old version",
      metadata: JSON.stringify({
        evolution: {
          status: "active",
          version: 1,
          accessCount: 0,
          lastAccessedAt: null,
          supersededBy: "new1",
          supersedes: null,
          evolutionNote: null,
          consolidatedInto: null,
          contributedToPattern: null,
          sourceMemories: [],
          validFrom: Date.now(),
          validUntil: null,
        },
      }),
    });
    const newEntry = makeEntry({
      id: "new1",
      text: "New version",
      metadata: JSON.stringify({
        evolution: {
          status: "active",
          version: 2,
          accessCount: 0,
          lastAccessedAt: null,
          supersededBy: null,
          supersedes: "old1",
          evolutionNote: "Updated info",
          consolidatedInto: null,
          contributedToPattern: null,
          sourceMemories: [],
          validFrom: Date.now(),
          validUntil: null,
        },
      }),
    });
    const store = createMockStore([oldEntry, newEntry]);
    const graph = await buildMemoryGraph(store);

    const supersedeEdges = graph.edges.filter(e => e.type === "supersede");
    expect(supersedeEdges.length).toBeGreaterThanOrEqual(1);
    // old1 -> new1 edge
    const edge = supersedeEdges.find(e => e.source === "old1" && e.target === "new1");
    expect(edge).toBeDefined();
  });

  it("builds cluster edges from metadata", async () => {
    const canonical = makeEntry({
      id: "canon1",
      text: "Canonical entry",
      metadata: JSON.stringify({
        evolution: { status: "active", version: 1, accessCount: 0, lastAccessedAt: null, supersededBy: null, supersedes: null, evolutionNote: null, consolidatedInto: null, contributedToPattern: null, sourceMemories: [], validFrom: Date.now(), validUntil: null },
        cluster_members: ["member1"],
      }),
    });
    const member = makeEntry({
      id: "member1",
      text: "Cluster member",
      metadata: JSON.stringify({
        evolution: { status: "active", version: 1, accessCount: 0, lastAccessedAt: null, supersededBy: null, supersedes: null, evolutionNote: null, consolidatedInto: null, contributedToPattern: null, sourceMemories: [], validFrom: Date.now(), validUntil: null },
        clustered_with: "canon1",
      }),
    });
    const store = createMockStore([canonical, member]);
    const graph = await buildMemoryGraph(store);

    const clusterEdges = graph.edges.filter(e => e.type === "cluster");
    expect(clusterEdges.length).toBeGreaterThanOrEqual(1);
  });

  it("filters edges to existing nodes only", async () => {
    // Entry references a supersededBy ID that is not in the node set
    const entry = makeEntry({
      id: "e1",
      text: "Entry with missing reference",
      metadata: JSON.stringify({
        evolution: {
          status: "active",
          version: 1,
          accessCount: 0,
          lastAccessedAt: null,
          supersededBy: "nonexistent-id",
          supersedes: null,
          evolutionNote: null,
          consolidatedInto: null,
          contributedToPattern: null,
          sourceMemories: [],
          validFrom: Date.now(),
          validUntil: null,
        },
      }),
    });
    const store = createMockStore([entry]);
    const graph = await buildMemoryGraph(store);

    expect(graph.nodes).toHaveLength(1);
    // No edges should reference nonexistent-id
    const badEdges = graph.edges.filter(
      e => e.source === "nonexistent-id" || e.target === "nonexistent-id"
    );
    expect(badEdges).toHaveLength(0);
  });

  it("builds scope edges for small scope groups", async () => {
    const entries = [
      makeEntry({ id: "s1", scope: "project:alpha" }),
      makeEntry({ id: "s2", scope: "project:alpha" }),
      makeEntry({ id: "s3", scope: "project:alpha" }),
      makeEntry({ id: "s4", scope: "project:beta" }),
    ];
    const store = createMockStore(entries);
    const graph = await buildMemoryGraph(store);

    const scopeEdges = graph.edges.filter(e => e.type === "scope");
    // alpha has 3 entries → chain of 2 scope edges
    expect(scopeEdges.length).toBe(2);
  });

  it("skips scope edges when scope has more than 20 entries", async () => {
    const entries = Array.from({ length: 25 }, (_, i) =>
      makeEntry({ id: `big${i}`, scope: "project:big" })
    );
    const store = createMockStore(entries);
    const graph = await buildMemoryGraph(store);

    const scopeEdges = graph.edges.filter(e => e.type === "scope");
    expect(scopeEdges).toHaveLength(0);
  });

  it("truncates long text to 80 chars", async () => {
    const longText = "A".repeat(200);
    const store = createMockStore([makeEntry({ id: "long1", text: longText })]);
    const graph = await buildMemoryGraph(store);

    expect(graph.nodes[0].label.length).toBe(80);
    expect(graph.nodes[0].label.endsWith("\u2026")).toBe(true);
  });

  it("extracts accessCount from evolution", async () => {
    const entry = makeEntry({
      id: "ac1",
      metadata: JSON.stringify({
        evolution: {
          status: "active",
          version: 1,
          accessCount: 42,
          lastAccessedAt: null,
          supersededBy: null,
          supersedes: null,
          evolutionNote: null,
          consolidatedInto: null,
          contributedToPattern: null,
          sourceMemories: [],
          validFrom: Date.now(),
          validUntil: null,
        },
      }),
    });
    const store = createMockStore([entry]);
    const graph = await buildMemoryGraph(store);

    expect(graph.nodes[0].accessCount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// renderGraphHTML
// ---------------------------------------------------------------------------

describe("renderGraphHTML", () => {
  const sampleGraph: MemoryGraph = {
    nodes: [
      { id: "n1", label: "Test node", category: "profile", scope: "test", importance: 0.8, timestamp: Date.now(), accessCount: 5 },
    ],
    edges: [],
  };

  it("output contains DOCTYPE html", () => {
    const html = renderGraphHTML(sampleGraph);
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("output contains d3.js CDN link", () => {
    const html = renderGraphHTML(sampleGraph);
    expect(html).toContain("https://d3js.org/d3.v7.min.js");
  });

  it("output contains GRAPH_DATA", () => {
    const html = renderGraphHTML(sampleGraph);
    expect(html).toContain("GRAPH_DATA");
    expect(html).toContain('"id":"n1"');
  });

  it("output contains category colors", () => {
    const html = renderGraphHTML(sampleGraph);
    expect(html).toContain("#f59e0b"); // profile gold
    expect(html).toContain("#3b82f6"); // preferences blue
    expect(html).toContain("#10b981"); // entities green
    expect(html).toContain("#ef4444"); // cases red
    expect(html).toContain("#8b5cf6"); // patterns purple
  });

  it("output contains title and legend", () => {
    const html = renderGraphHTML(sampleGraph);
    expect(html).toContain("RecallNest Knowledge Graph");
    expect(html).toContain("legend");
  });

  it("output contains dark background styling", () => {
    const html = renderGraphHTML(sampleGraph);
    expect(html).toContain("#0d1117");
  });
});

// ---------------------------------------------------------------------------
// formatGraphExportResult
// ---------------------------------------------------------------------------

describe("formatGraphExportResult", () => {
  it("includes node and edge counts", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "n1", label: "A", category: "profile", scope: "s", importance: 0.5, timestamp: 0, accessCount: 0 },
        { id: "n2", label: "B", category: "entities", scope: "s", importance: 0.5, timestamp: 0, accessCount: 0 },
      ],
      edges: [
        { source: "n1", target: "n2", type: "scope" },
      ],
    };
    const result = formatGraphExportResult("/tmp/test.html", graph);
    expect(result).toContain("Nodes: 2");
    expect(result).toContain("Edges: 1");
  });

  it("includes file path", () => {
    const graph: MemoryGraph = { nodes: [], edges: [] };
    const result = formatGraphExportResult("/my/path/graph.html", graph);
    expect(result).toContain("/my/path/graph.html");
  });

  it("includes category breakdown", () => {
    const graph: MemoryGraph = {
      nodes: [
        { id: "n1", label: "A", category: "profile", scope: "s", importance: 0.5, timestamp: 0, accessCount: 0 },
        { id: "n2", label: "B", category: "profile", scope: "s", importance: 0.5, timestamp: 0, accessCount: 0 },
        { id: "n3", label: "C", category: "events", scope: "s", importance: 0.5, timestamp: 0, accessCount: 0 },
      ],
      edges: [],
    };
    const result = formatGraphExportResult("/tmp/test.html", graph);
    expect(result).toContain("profile(2)");
    expect(result).toContain("events(1)");
  });

  it("handles empty graph", () => {
    const graph: MemoryGraph = { nodes: [], edges: [] };
    const result = formatGraphExportResult("/tmp/empty.html", graph);
    expect(result).toContain("Nodes: 0");
    expect(result).toContain("Edges: 0");
    expect(result).toContain("none");
  });
});
