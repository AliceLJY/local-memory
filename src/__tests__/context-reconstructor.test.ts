import { describe, test, expect } from "bun:test";
import {
  shouldReconstruct,
  extractCitedIds,
  removeSentencesWithId,
  computeCoverage,
} from "../context-reconstructor.js";

describe("reconstruction gate", () => {
  test("false when flag off", () => {
    expect(shouldReconstruct({ flagEnabled: false, callerOptIn: true, resultCount: 5, llmAvailable: true })).toBe(false);
  });
  test("false when no opt-in", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: false, resultCount: 5, llmAvailable: true })).toBe(false);
  });
  test("false when too few results", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: true, resultCount: 2, llmAvailable: true })).toBe(false);
  });
  test("false when LLM down", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: true, resultCount: 5, llmAvailable: false })).toBe(false);
  });
  test("true when all conditions met", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: true, resultCount: 5, llmAvailable: true })).toBe(true);
  });
});

describe("extractCitedIds", () => {
  test("extracts [src:ID] references", () => {
    expect(extractCitedIds("A [src:abc]. B [src:def].")).toEqual(["abc", "def"]);
  });
  test("empty for no citations", () => {
    expect(extractCitedIds("No refs.")).toEqual([]);
  });
  test("deduplicates", () => {
    expect(extractCitedIds("A [src:abc]. B [src:abc].")).toEqual(["abc"]);
  });
});

describe("removeSentencesWithId", () => {
  test("removes sentence with invalid ID", () => {
    const text = "Valid [src:real]. Fake [src:bad]. Also valid [src:ok].";
    const result = removeSentencesWithId(text, "bad");
    expect(result).toContain("[src:real]");
    expect(result).toContain("[src:ok]");
    expect(result).not.toContain("[src:bad]");
  });
  test("unchanged if ID not found", () => {
    const text = "All valid [src:a].";
    expect(removeSentencesWithId(text, "nope")).toBe(text);
  });
});

describe("computeCoverage", () => {
  test("high for identical text", () => {
    expect(computeCoverage("user prefers dark mode and typescript", ["user prefers dark mode and typescript"])).toBeGreaterThan(0.5);
  });
  test("low for unrelated text", () => {
    expect(computeCoverage("quantum physics wave function particles", ["user prefers dark mode"])).toBeLessThan(0.3);
  });
  test("partial for mixed", () => {
    const cov = computeCoverage("User likes TypeScript. Weather is sunny today.", ["User likes TypeScript", "User uses Bun"]);
    expect(cov).toBeGreaterThan(0.3);
    expect(cov).toBeLessThan(0.9);
  });
});
