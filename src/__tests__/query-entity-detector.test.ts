import { describe, expect, it } from "bun:test";
import { detectEntitiesSync, detectEntities } from "../query-entity-detector.js";

// ============================================================================
// Sync detection (no KG validation)
// ============================================================================

describe("detectEntitiesSync", () => {
  describe("English entity extraction", () => {
    it("extracts capitalized names", () => {
      const result = detectEntitiesSync("What does Alice use?");
      expect(result.entities).toContain("Alice");
    });

    it("extracts multi-word capitalized names", () => {
      const result = detectEntitiesSync("Tell me about Claude Code");
      expect(result.entities).toContain("Claude Code");
    });

    it("extracts CamelCase identifiers (normalized to title case)", () => {
      const result = detectEntitiesSync("How does RecallNest work?");
      // normalizeEntity applies title case: RecallNest -> Recallnest
      expect(result.entities).toContain("Recallnest");
    });

    it("extracts quoted strings (normalized to title case)", () => {
      const result = detectEntitiesSync('Search for "LanceDB" docs');
      expect(result.entities).toContain("Lancedb");
    });

    it("extracts backtick-quoted strings (normalized to title case)", () => {
      const result = detectEntitiesSync("What is `OpenAI` embedding?");
      expect(result.entities).toContain("Openai");
    });

    it("skips stop words even when capitalized", () => {
      const result = detectEntitiesSync("The quick brown fox");
      // "The" should be filtered as stop word
      expect(result.entities).not.toContain("The");
    });

    it("deduplicates entities (case-insensitive)", () => {
      const result = detectEntitiesSync('Alice uses "alice" tool');
      // Should have only one Alice entry
      const aliceCount = result.entities.filter(e => e.toLowerCase() === "alice").length;
      expect(aliceCount).toBe(1);
    });

    it("returns empty for queries without entities", () => {
      const result = detectEntitiesSync("what happened yesterday?");
      expect(result.entities.length).toBe(0);
    });
  });

  describe("multi-hop detection — English", () => {
    it("detects possessive friend pattern", () => {
      const result = detectEntitiesSync("Alice's friends");
      expect(result.isMultiHop).toBe(true);
      expect(result.hopPredicate).toBe("friend_of");
    });

    it("detects 'friend of' pattern", () => {
      const result = detectEntitiesSync("friends of Bob");
      expect(result.isMultiHop).toBe(true);
      expect(result.hopPredicate).toBe("friend_of");
    });

    it("detects 'what does X use' pattern", () => {
      const result = detectEntitiesSync("what does Alice use?");
      expect(result.isMultiHop).toBe(true);
      expect(result.hopPredicate).toBe("uses");
    });

    it("detects 'who created' pattern", () => {
      const result = detectEntitiesSync("who created RecallNest?");
      expect(result.isMultiHop).toBe(true);
      expect(result.hopPredicate).toBe("created_by");
    });

    it("detects 'who manages' pattern", () => {
      const result = detectEntitiesSync("who manages the team?");
      expect(result.isMultiHop).toBe(true);
      expect(result.hopPredicate).toBe("manages");
    });

    it("detects 'X depends on' pattern", () => {
      const result = detectEntitiesSync("what depends on LanceDB?");
      expect(result.isMultiHop).toBe(true);
      expect(result.hopPredicate).toBe("depends_on");
    });

    it("returns isMultiHop=false for simple queries", () => {
      const result = detectEntitiesSync("Tell me about Python");
      expect(result.isMultiHop).toBe(false);
      expect(result.hopPredicate).toBeUndefined();
    });
  });

  describe("multi-hop detection — Chinese", () => {
    it("detects 的朋友 pattern", () => {
      const result = detectEntitiesSync("Alice的朋友有谁？");
      expect(result.isMultiHop).toBe(true);
      expect(result.hopPredicate).toBe("friend_of");
    });

    it("detects 谁和X一起 pattern", () => {
      const result = detectEntitiesSync("谁和Bob一起工作？");
      expect(result.isMultiHop).toBe(true);
      expect(result.hopPredicate).toBe("works_with");
    });

    it("detects 谁创建了 pattern", () => {
      const result = detectEntitiesSync("谁创建了RecallNest？");
      expect(result.isMultiHop).toBe(true);
      expect(result.hopPredicate).toBe("created_by");
    });

    it("detects 依赖什么 pattern", () => {
      const result = detectEntitiesSync("RecallNest依赖什么？");
      expect(result.isMultiHop).toBe(true);
      expect(result.hopPredicate).toBe("depends_on");
    });
  });
});

// ============================================================================
// Async detection with KG validation
// ============================================================================

describe("detectEntities (async with mock KG)", () => {
  function createMockKGStore(knownEntities: string[]) {
    return {
      async getAllEntities() {
        return knownEntities;
      },
    } as any;
  }

  it("validates entities against KG", async () => {
    const kgStore = createMockKGStore(["Alice", "Python", "LanceDB"]);
    const result = await detectEntities("Alice uses Python and React", kgStore);

    // Alice and Python are in KG, React is not
    expect(result.entities).toContain("Alice");
    expect(result.entities).toContain("Python");
    expect(result.entities).not.toContain("React");
  });

  it("falls back to heuristic when KG validates nothing", async () => {
    const kgStore = createMockKGStore([]); // empty KG
    const result = await detectEntities("Alice uses Python", kgStore);

    // Should fall back to heuristic candidates
    expect(result.entities).toContain("Alice");
    expect(result.entities).toContain("Python");
  });

  it("preserves KG canonical casing", async () => {
    const kgStore = createMockKGStore(["alice"]); // lowercase in KG
    const result = await detectEntities("Tell me about Alice", kgStore);

    // Should use KG's casing
    expect(result.entities).toContain("alice");
  });

  it("works without KG store", async () => {
    const result = await detectEntities("Alice uses Python");
    expect(result.entities).toContain("Alice");
    expect(result.entities).toContain("Python");
  });
});
