import { describe, expect, it } from "bun:test";
import { normalizeEntity, normalizePredicate, KGExtractor, isKGModeEnabled } from "../kg-extractor.js";

function createMockLlm(response: unknown) {
  return {
    lastSystem: null as string | null,
    lastUser: null as string | null,
    async chatJson(_system: string, _user: string) {
      this.lastSystem = _system;
      this.lastUser = _user;
      return response;
    },
    // Stub remaining LLMClient methods
    async generateL0() { return null; },
    async generateL1() { return null; },
    async smartExtract() { return null; },
    async smartExtractBatch() { return []; },
    async dedupDecision() { return null; },
    async dedupBatch() { return []; },
    async mergeTexts() { return null; },
    async preferenceMatch() { return null; },
    async ping() { return false; },
  } as any;
}

function createMockKGStore() {
  return {
    storedTriples: [] as any[],
    async createTriples(triples: any[]) {
      const result = triples.map((t: any, i: number) => ({
        ...t,
        id: `mock-${i}`,
        timestamp: Date.now(),
      }));
      this.storedTriples.push(...result);
      return result;
    },
  } as any;
}

describe("normalizeEntity", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeEntity("  Hello   World  ")).toBe("Hello World");
  });
  it("converts to title case", () => {
    expect(normalizeEntity("alice")).toBe("Alice");
    expect(normalizeEntity("PYTHON")).toBe("Python");
  });
  it("preserves CJK text", () => {
    expect(normalizeEntity("张三")).toBe("张三");
  });
  it("strips quotes", () => {
    expect(normalizeEntity('"Alice"')).toBe("Alice");
  });
  it("returns empty for empty input", () => {
    expect(normalizeEntity("")).toBe("");
  });
});

describe("normalizePredicate", () => {
  it("converts to snake_case", () => {
    expect(normalizePredicate("works with")).toBe("works_with");
    expect(normalizePredicate("Created By")).toBe("created_by");
  });
  it("preserves CJK predicates", () => {
    expect(normalizePredicate("属于")).toBe("属于");
  });
});

describe("isKGModeEnabled", () => {
  it("reads env var", () => {
    const orig = process.env.RECALLNEST_KG_MODE;
    try {
      process.env.RECALLNEST_KG_MODE = "true";
      expect(isKGModeEnabled()).toBe(true);
      delete process.env.RECALLNEST_KG_MODE;
      expect(isKGModeEnabled()).toBe(false);
    } finally {
      if (orig !== undefined) process.env.RECALLNEST_KG_MODE = orig;
      else delete process.env.RECALLNEST_KG_MODE;
    }
  });
});

describe("KGExtractor.extract", () => {
  it("extracts valid triples", async () => {
    const llm = createMockLlm({
      triples: [
        { subject: "Alice", predicate: "uses", object: "Python", confidence: 0.9 },
        { subject: "Alice", predicate: "works_at", object: "Google", confidence: 0.85 },
      ],
    });
    const ext = new KGExtractor({ llmClient: llm, kgStore: createMockKGStore() });
    const triples = await ext.extract("Alice uses Python at Google");
    expect(triples.length).toBe(2);
    expect(triples[0].subject).toBe("Alice");
  });

  it("filters low confidence", async () => {
    const llm = createMockLlm({
      triples: [
        { subject: "Alice", predicate: "uses", object: "Python", confidence: 0.9 },
        { subject: "Alice", predicate: "maybe", object: "Bob", confidence: 0.3 },
      ],
    });
    const ext = new KGExtractor({ llmClient: llm, kgStore: createMockKGStore() });
    const triples = await ext.extract("Alice uses Python and maybe Bob");
    expect(triples.length).toBe(1);
  });

  it("normalizes entities", async () => {
    const llm = createMockLlm({
      triples: [{ subject: "  alice  ", predicate: "WORKS WITH", object: "bob", confidence: 0.9 }],
    });
    const ext = new KGExtractor({ llmClient: llm, kgStore: createMockKGStore() });
    const triples = await ext.extract("alice works with bob");
    expect(triples[0].subject).toBe("Alice");
    expect(triples[0].predicate).toBe("works_with");
    expect(triples[0].object).toBe("Bob");
  });

  it("skips self-referencing triples", async () => {
    const llm = createMockLlm({
      triples: [
        { subject: "Alice", predicate: "is", object: "Alice", confidence: 0.9 },
        { subject: "Bob", predicate: "uses", object: "Go", confidence: 0.9 },
      ],
    });
    const ext = new KGExtractor({ llmClient: llm, kgStore: createMockKGStore() });
    const triples = await ext.extract("Alice is Alice, Bob uses Go");
    expect(triples.length).toBe(1);
    expect(triples[0].subject).toBe("Bob");
  });

  it("deduplicates within batch", async () => {
    const llm = createMockLlm({
      triples: [
        { subject: "Alice", predicate: "uses", object: "Python", confidence: 0.9 },
        { subject: "Alice", predicate: "uses", object: "Python", confidence: 0.85 },
      ],
    });
    const ext = new KGExtractor({ llmClient: llm, kgStore: createMockKGStore() });
    expect((await ext.extract("Alice uses Python a lot")).length).toBe(1);
  });

  it("handles null LLM response", async () => {
    const llm = createMockLlm(null);
    const ext = new KGExtractor({ llmClient: llm, kgStore: createMockKGStore() });
    expect((await ext.extract("Some text here")).length).toBe(0);
  });

  it("skips short text", async () => {
    const llm = createMockLlm({ triples: [] });
    const ext = new KGExtractor({ llmClient: llm, kgStore: createMockKGStore() });
    expect((await ext.extract("hi")).length).toBe(0);
    expect(llm.lastUser).toBeNull(); // LLM not called
  });
});

describe("KGExtractor.extractAndStore", () => {
  it("persists triples to KG store", async () => {
    const llm = createMockLlm({
      triples: [
        { subject: "Alice", predicate: "uses", object: "Python", confidence: 0.9 },
      ],
    });
    const kgStore = createMockKGStore();
    const ext = new KGExtractor({ llmClient: llm, kgStore });
    const count = await ext.extractAndStore("Alice uses Python", "mem-001", "global");
    expect(count).toBe(1);
    expect(kgStore.storedTriples[0].scope).toBe("global");
    expect(kgStore.storedTriples[0].source_memory_id).toBe("mem-001");
  });

  it("caps source_text at 500 chars", async () => {
    const llm = createMockLlm({
      triples: [{ subject: "A", predicate: "uses", object: "B", confidence: 0.9 }],
    });
    const kgStore = createMockKGStore();
    const ext = new KGExtractor({ llmClient: llm, kgStore });
    await ext.extractAndStore("x".repeat(1000), "mem-001", "global");
    expect(kgStore.storedTriples[0].source_text.length).toBe(500);
  });
});
