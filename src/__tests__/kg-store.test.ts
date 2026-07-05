import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KGStore, tripleId } from "../kg-store.js";

let workDir: string;

function makeTriple(overrides: Record<string, unknown> = {}) {
  return {
    scope: "global",
    subject: "Alice",
    predicate: "uses",
    object: "Python",
    confidence: 0.9,
    source_memory_id: "mem-001",
    source_text: "Alice uses Python",
    ...overrides,
  };
}

describe("tripleId", () => {
  it("produces deterministic IDs", () => {
    const id1 = tripleId("global", "Alice", "uses", "Python");
    const id2 = tripleId("global", "Alice", "uses", "Python");
    expect(id1).toBe(id2);
  });

  it("different triples produce different IDs", () => {
    const id1 = tripleId("global", "Alice", "uses", "Python");
    const id2 = tripleId("global", "Alice", "uses", "JavaScript");
    expect(id1).not.toBe(id2);
  });

  it("scope affects ID", () => {
    const id1 = tripleId("global", "Alice", "uses", "Python");
    const id2 = tripleId("agent:bob", "Alice", "uses", "Python");
    expect(id1).not.toBe(id2);
  });
});

describe("KGStore", () => {
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "kg-store-test-"));
  });
  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  describe("createTriple", () => {
    it("stores a triple", async () => {
      const store = new KGStore({ dbPath: workDir });
      const t = await store.createTriple(makeTriple());
      expect(t.id).toBeTruthy();
      expect(t.subject).toBe("Alice");
      expect(t.predicate).toBe("uses");
      expect(t.object).toBe("Python");
      expect(t.timestamp).toBeGreaterThan(0);
    });

    it("upserts on duplicate", async () => {
      const store = new KGStore({ dbPath: workDir });
      const t1 = await store.createTriple(makeTriple({ confidence: 0.8 }));
      const t2 = await store.createTriple(makeTriple({ confidence: 0.95 }));
      expect(t1.id).toBe(t2.id);
      expect(await store.countTriples()).toBe(1);
    });
  });

  describe("mention counting", () => {
    it("new triple starts at mention_count 1 with its source recorded", async () => {
      const store = new KGStore({ dbPath: workDir });
      const t = await store.createTriple(makeTriple());
      expect(t.mention_count).toBe(1);
      expect(t.first_seen).toBeGreaterThan(0);
      expect(JSON.parse(t.source_memory_ids)).toEqual(["mem-001"]);
    });

    it("same triple from a different source memory increments count", async () => {
      const store = new KGStore({ dbPath: workDir });
      const t1 = await store.createTriple(makeTriple({ source_memory_id: "mem-001" }));
      const t2 = await store.createTriple(makeTriple({ source_memory_id: "mem-002" }));
      expect(t2.id).toBe(t1.id);
      expect(t2.mention_count).toBe(2);
      expect(JSON.parse(t2.source_memory_ids).sort()).toEqual(["mem-001", "mem-002"]);
      expect(t2.first_seen).toBe(t1.first_seen);
      expect(await store.countTriples()).toBe(1);
    });

    it("same triple from the same source memory does NOT increment count", async () => {
      const store = new KGStore({ dbPath: workDir });
      const t1 = await store.createTriple(makeTriple({ confidence: 0.8 }));
      const t2 = await store.createTriple(makeTriple({ confidence: 0.95 }));
      expect(t2.mention_count).toBe(1);
      expect(JSON.parse(t2.source_memory_ids)).toEqual(["mem-001"]);
      // confidence keeps the max seen
      expect(t2.confidence).toBe(0.95);
      const again = await store.createTriple(makeTriple({ confidence: 0.5 }));
      expect(again.confidence).toBe(0.95);
    });

    it("batch with same triple from different sources counts each source once", async () => {
      const store = new KGStore({ dbPath: workDir });
      const triples = await store.createTriples([
        makeTriple({ source_memory_id: "mem-001" }),
        makeTriple({ source_memory_id: "mem-002" }),
        makeTriple({ source_memory_id: "mem-002" }), // duplicate source in batch
      ]);
      expect(triples.length).toBe(1);
      expect(triples[0].mention_count).toBe(2);
      expect(await store.countTriples()).toBe(1);
    });

    it("count survives across batch and single writes", async () => {
      const store = new KGStore({ dbPath: workDir });
      await store.createTriples([makeTriple({ source_memory_id: "mem-001" })]);
      await store.createTriples([makeTriple({ source_memory_id: "mem-002" })]);
      const t = await store.createTriple(makeTriple({ source_memory_id: "mem-003" }));
      expect(t.mention_count).toBe(3);
    });
  });

  describe("createTriples (batch)", () => {
    it("stores multiple triples", async () => {
      const store = new KGStore({ dbPath: workDir });
      const triples = await store.createTriples([
        makeTriple({ subject: "Alice", object: "Python" }),
        makeTriple({ subject: "Alice", object: "JavaScript" }),
        makeTriple({ subject: "Bob", object: "Go" }),
      ]);
      expect(triples.length).toBe(3);
      expect(await store.countTriples()).toBe(3);
    });

    it("deduplicates within batch", async () => {
      const store = new KGStore({ dbPath: workDir });
      const triples = await store.createTriples([
        makeTriple({ subject: "Alice", object: "Python" }),
        makeTriple({ subject: "Alice", object: "Python" }),
      ]);
      expect(triples.length).toBe(1);
    });

    it("handles empty batch", async () => {
      const store = new KGStore({ dbPath: workDir });
      expect(await store.createTriples([])).toEqual([]);
    });
  });

  describe("edge queries", () => {
    it("getOutgoingEdges", async () => {
      const store = new KGStore({ dbPath: workDir });
      await store.createTriples([
        makeTriple({ subject: "Alice", predicate: "uses", object: "Python" }),
        makeTriple({ subject: "Alice", predicate: "knows", object: "Bob" }),
        makeTriple({ subject: "Bob", predicate: "uses", object: "Go" }),
      ]);
      const edges = await store.getOutgoingEdges("Alice");
      expect(edges.length).toBe(2);
      expect(edges.every((e) => e.subject === "Alice")).toBe(true);
    });

    it("getIncomingEdges", async () => {
      const store = new KGStore({ dbPath: workDir });
      await store.createTriples([
        makeTriple({ subject: "Alice", predicate: "knows", object: "Bob" }),
        makeTriple({ subject: "Charlie", predicate: "knows", object: "Bob" }),
        makeTriple({ subject: "Bob", predicate: "uses", object: "Go" }),
      ]);
      const edges = await store.getIncomingEdges("Bob");
      expect(edges.length).toBe(2);
      expect(edges.every((e) => e.object === "Bob")).toBe(true);
    });
  });

  describe("getNeighborhood (BFS)", () => {
    it("returns 1-hop neighborhood", async () => {
      const store = new KGStore({ dbPath: workDir });
      await store.createTriples([
        makeTriple({ subject: "Alice", predicate: "knows", object: "Bob" }),
        makeTriple({ subject: "Alice", predicate: "uses", object: "Python" }),
        makeTriple({ subject: "Bob", predicate: "uses", object: "Go" }),
        makeTriple({ subject: "Charlie", predicate: "uses", object: "Rust" }),
      ]);
      const hood = await store.getNeighborhood(["Alice"], 1);
      const entities = hood.map((n) => n.entity).sort();
      expect(entities).toContain("Alice");
      expect(entities).toContain("Bob");
      expect(entities).toContain("Python");
      expect(entities).not.toContain("Charlie");
    });

    it("returns 2-hop neighborhood", async () => {
      const store = new KGStore({ dbPath: workDir });
      await store.createTriples([
        makeTriple({ subject: "Alice", predicate: "knows", object: "Bob" }),
        makeTriple({ subject: "Bob", predicate: "knows", object: "Charlie" }),
      ]);
      const hood = await store.getNeighborhood(["Alice"], 2);
      const entities = hood.map((n) => n.entity);
      expect(entities).toContain("Charlie");
    });
  });

  describe("scope isolation", () => {
    it("edge queries respect scope filter", async () => {
      const store = new KGStore({ dbPath: workDir });
      await store.createTriples([
        makeTriple({ scope: "agent:alice", subject: "Alice", object: "Python" }),
        makeTriple({ scope: "agent:bob", subject: "Alice", object: "Go" }),
      ]);
      const edges = await store.getOutgoingEdges("Alice", "agent:alice");
      expect(edges.length).toBe(1);
      expect(edges[0].object).toBe("Python");
    });
  });

  describe("deleteBySource", () => {
    it("deletes all triples from a source memory", async () => {
      const store = new KGStore({ dbPath: workDir });
      await store.createTriples([
        makeTriple({ source_memory_id: "mem-001", subject: "Alice", object: "Python" }),
        makeTriple({ source_memory_id: "mem-001", subject: "Alice", object: "Go" }),
        makeTriple({ source_memory_id: "mem-002", subject: "Bob", object: "Rust" }),
      ]);
      await store.deleteBySource("mem-001");
      expect(await store.countTriples()).toBe(1);
    });

    it("multi-source triple survives forgetting one source (count decremented)", async () => {
      const store = new KGStore({ dbPath: workDir });
      await store.createTriple(makeTriple({ source_memory_id: "mem-001" }));
      await store.createTriple(makeTriple({ source_memory_id: "mem-002" }));

      await store.deleteBySource("mem-001");
      // Fact still evidenced by mem-002 — row survives with decremented count
      expect(await store.countTriples()).toBe(1);
      const edges = await store.getOutgoingEdges("Alice");
      expect(edges.length).toBe(1);
      expect(edges[0].mention_count).toBe(1);
      expect(JSON.parse(edges[0].source_memory_ids)).toEqual(["mem-002"]);

      await store.deleteBySource("mem-002");
      // Last evidence gone — row deleted
      expect(await store.countTriples()).toBe(0);
    });
  });

  describe("entity queries", () => {
    it("getAllEntities returns unique entities", async () => {
      const store = new KGStore({ dbPath: workDir });
      await store.createTriples([
        makeTriple({ subject: "Alice", object: "Python" }),
        makeTriple({ subject: "Bob", object: "Python" }),
      ]);
      const entities = await store.getAllEntities();
      expect(entities).toContain("Alice");
      expect(entities).toContain("Bob");
      expect(entities).toContain("Python");
    });

    it("hasEntity checks existence", async () => {
      const store = new KGStore({ dbPath: workDir });
      await store.createTriple(makeTriple());
      expect(await store.hasEntity("Alice")).toBe(true);
      expect(await store.hasEntity("Charlie")).toBe(false);
    });
  });
});
