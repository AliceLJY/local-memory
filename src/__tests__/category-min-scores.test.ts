import { describe, expect, it } from "bun:test";

import { DEFAULT_CATEGORY_MIN_SCORES, DEFAULT_RETRIEVAL_CONFIG } from "../retriever.js";
import { RETRIEVAL_PROFILES, applyRetrievalProfile } from "../retrieval-profiles.js";

const ALL_CATEGORIES = ["profile", "preferences", "entities", "events", "cases", "patterns"];

describe("DEFAULT_CATEGORY_MIN_SCORES", () => {
  it("has entries for all 6 durable categories", () => {
    const expected = ["profile", "preferences", "entities", "events", "cases", "patterns"];
    for (const cat of expected) {
      expect(DEFAULT_CATEGORY_MIN_SCORES[cat]).toBeNumber();
    }
  });

  it("profile and preferences have lower thresholds than global hardMinScore", () => {
    expect(DEFAULT_CATEGORY_MIN_SCORES.profile).toBeLessThan(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
    expect(DEFAULT_CATEGORY_MIN_SCORES.preferences).toBeLessThan(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
  });

  it("cases and patterns have higher thresholds than global hardMinScore", () => {
    expect(DEFAULT_CATEGORY_MIN_SCORES.cases).toBeGreaterThan(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
    expect(DEFAULT_CATEGORY_MIN_SCORES.patterns).toBeGreaterThan(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
  });

  it("events threshold equals global hardMinScore", () => {
    expect(DEFAULT_CATEGORY_MIN_SCORES.events).toBe(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
  });

  it("all thresholds are in valid range (0, 1)", () => {
    for (const [, threshold] of Object.entries(DEFAULT_CATEGORY_MIN_SCORES)) {
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThan(1);
    }
  });
});

describe("retrieval profiles carry scaled category thresholds", () => {
  const scopedProfiles = ["writing", "debug", "fact-check"] as const;

  it("default profile does not override category thresholds", () => {
    expect(RETRIEVAL_PROFILES.default.overrides.categoryMinScores).toBeUndefined();
    const { config } = applyRetrievalProfile(DEFAULT_RETRIEVAL_CONFIG, "default");
    expect(config.categoryMinScores).toEqual(DEFAULT_RETRIEVAL_CONFIG.categoryMinScores);
  });

  // A partial map is the trap here: Retriever.minScoreFor() falls back to
  // hardMinScore — not to DEFAULT_CATEGORY_MIN_SCORES — for unlisted categories.
  it("every scoped profile supplies a COMPLETE category map", () => {
    for (const name of scopedProfiles) {
      const map = RETRIEVAL_PROFILES[name].overrides.categoryMinScores;
      expect(map).toBeDefined();
      expect(Object.keys(map!).sort()).toEqual([...ALL_CATEGORIES].sort());
    }
  });

  it("thresholds track each profile's overall looseness", () => {
    for (const name of scopedProfiles) {
      const { overrides } = RETRIEVAL_PROFILES[name];
      const looser = overrides.hardMinScore! < DEFAULT_RETRIEVAL_CONFIG.hardMinScore;
      for (const category of ALL_CATEGORIES) {
        const scaled = overrides.categoryMinScores![category];
        const base = DEFAULT_CATEGORY_MIN_SCORES[category];
        if (looser) {
          expect(scaled).toBeLessThan(base);
        } else {
          expect(scaled).toBeGreaterThan(base);
        }
      }
    }
  });

  it("preserves the relative ordering of the default map", () => {
    const defaultOrder = [...ALL_CATEGORIES].sort(
      (a, b) => DEFAULT_CATEGORY_MIN_SCORES[a] - DEFAULT_CATEGORY_MIN_SCORES[b],
    );
    for (const name of scopedProfiles) {
      const map = RETRIEVAL_PROFILES[name].overrides.categoryMinScores!;
      const scaledOrder = [...ALL_CATEGORIES].sort((a, b) => map[a] - map[b]);
      expect(scaledOrder).toEqual(defaultOrder);
    }
  });

  it("keeps every scaled threshold in valid range (0, 1)", () => {
    for (const name of scopedProfiles) {
      const map = RETRIEVAL_PROFILES[name].overrides.categoryMinScores!;
      for (const threshold of Object.values(map)) {
        expect(threshold).toBeGreaterThan(0);
        expect(threshold).toBeLessThan(1);
      }
    }
  });

  it("applyRetrievalProfile propagates the map into the resolved config", () => {
    const { config } = applyRetrievalProfile(DEFAULT_RETRIEVAL_CONFIG, "debug");
    expect(config.categoryMinScores).toEqual(
      RETRIEVAL_PROFILES.debug.overrides.categoryMinScores,
    );
  });

  it("loosening and tightening both reach category admission", () => {
    // debug (0.34) and writing (0.24) are looser than the 0.35 default …
    const debug = applyRetrievalProfile(DEFAULT_RETRIEVAL_CONFIG, "debug").config;
    const writing = applyRetrievalProfile(DEFAULT_RETRIEVAL_CONFIG, "writing").config;
    expect(debug.categoryMinScores!.patterns).toBeLessThan(DEFAULT_CATEGORY_MIN_SCORES.patterns);
    expect(writing.categoryMinScores!.events).toBeLessThan(DEFAULT_CATEGORY_MIN_SCORES.events);
    // … and writing, being loosest, must admit more than debug.
    expect(writing.categoryMinScores!.patterns).toBeLessThan(debug.categoryMinScores!.patterns);

    // fact-check (0.38) is the only tighter profile.
    const factCheck = applyRetrievalProfile(DEFAULT_RETRIEVAL_CONFIG, "fact-check").config;
    expect(factCheck.categoryMinScores!.patterns).toBeGreaterThan(
      DEFAULT_CATEGORY_MIN_SCORES.patterns,
    );
  });
});
