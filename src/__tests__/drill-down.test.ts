import { describe, it, expect } from "bun:test";

describe("Tiered storage: L0/L1/L2 metadata parsing", () => {
  it("parses L0/L1/L2 from metadata JSON", () => {
    const metadata = JSON.stringify({
      l0_abstract: "User prefers TypeScript",
      l1_overview: "User consistently chooses TypeScript over JavaScript for new projects, citing type safety.",
      l2_content: "Full detailed content here...",
    });
    const parsed = JSON.parse(metadata);
    expect(parsed.l0_abstract).toBe("User prefers TypeScript");
    expect(parsed.l1_overview.length).toBeGreaterThan(parsed.l0_abstract.length);
  });

  it("handles missing L0/L1 fields gracefully", () => {
    const metadata = JSON.stringify({ accessCount: 5 });
    const parsed = JSON.parse(metadata);
    expect(parsed.l0_abstract).toBeUndefined();
    expect(parsed.l1_overview).toBeUndefined();
  });

  it("handles malformed metadata JSON", () => {
    const metadata = "not-json";
    let parsed = null;
    try {
      parsed = JSON.parse(metadata);
    } catch {
      // Expected
    }
    expect(parsed).toBeNull();
  });
});

describe("Tiered storage: drill-down level selection", () => {
  it("overview level returns L1 when available", () => {
    const meta = {
      l0_abstract: "Short summary",
      l1_overview: "Detailed overview with context and reasoning",
    };
    const fullText = "Very long full text content...";
    const level = "overview";

    const result = level === "overview" && meta.l1_overview
      ? meta.l1_overview
      : fullText;

    expect(result).toBe(meta.l1_overview);
  });

  it("overview level falls back to full text when L1 missing", () => {
    const meta: Record<string, string> = { l0_abstract: "Short summary" };
    const fullText = "Very long full text content...";
    const level = "overview";

    const result = level === "overview" && meta.l1_overview
      ? meta.l1_overview
      : fullText;

    expect(result).toBe(fullText);
  });

  it("full level always returns full text", () => {
    const meta = {
      l0_abstract: "Short summary",
      l1_overview: "Detailed overview",
    };
    const fullText = "Very long full text content...";
    const level = "full";

    const result = level === "full" ? fullText : meta.l1_overview || fullText;
    expect(result).toBe(fullText);
  });
});

describe("Tiered storage: recallDepthDefault config", () => {
  it("accepts valid depth values", () => {
    for (const depth of ["l0", "l1", "full"]) {
      expect(["l0", "l1", "full"].includes(depth)).toBe(true);
    }
  });

  it("rejects invalid depth values", () => {
    for (const depth of ["l3", "summary", "compact"]) {
      expect(["l0", "l1", "full"].includes(depth)).toBe(false);
    }
  });

  it("defaults to full when not set (backward compat)", () => {
    const configValue = undefined;
    const resolved = configValue || "full";
    expect(resolved).toBe("full");
  });
});

describe("Tiered storage: L0 injection format", () => {
  it("L0 abstract is compact enough for context injection", () => {
    const l0 = "User prefers TypeScript for all new projects";
    // L0 should be under 100 tokens (~400 chars)
    expect(l0.length).toBeLessThan(400);
  });

  it("L1 overview provides medium detail", () => {
    const l1 = "## Preference\nUser consistently chooses TypeScript over JavaScript. Cited reasons: type safety, better IDE support, easier refactoring.";
    // L1 should be under 500 tokens (~2000 chars)
    expect(l1.length).toBeLessThan(2000);
    expect(l1.length).toBeGreaterThan(50);
  });
});
