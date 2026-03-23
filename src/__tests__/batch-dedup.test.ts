import { describe, expect, it } from "bun:test";
import { batchInternalDedup } from "../ingest.js";

describe("batchInternalDedup", () => {
  it("keeps all entries when vectors are dissimilar", () => {
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const importances = [0.8, 0.7, 0.6];
    const kept = batchInternalDedup(vectors, importances);
    expect(kept).toEqual([0, 1, 2]);
  });

  it("drops lower-importance duplicate when vectors are near-identical", () => {
    const vectors = [
      [1, 0, 0],    // importance 0.6
      [1, 0.01, 0], // importance 0.9 — nearly identical to [0]
      [0, 1, 0],    // importance 0.7 — dissimilar
    ];
    const importances = [0.6, 0.9, 0.7];
    const kept = batchInternalDedup(vectors, importances);
    // [1] has higher importance and is near-identical to [0], so [0] gets dropped
    expect(kept).toContain(1);
    expect(kept).toContain(2);
    expect(kept).not.toContain(0);
  });

  it("returns single-item batch unchanged", () => {
    expect(batchInternalDedup([[1, 0, 0]], [0.5])).toEqual([0]);
  });

  it("returns empty for empty input", () => {
    expect(batchInternalDedup([], [])).toEqual([]);
  });

  it("preserves original order in output", () => {
    const vectors = [
      [0, 1, 0],    // idx 0, imp 0.9
      [1, 0, 0],    // idx 1, imp 0.5
      [0, 0, 1],    // idx 2, imp 0.7
    ];
    const importances = [0.9, 0.5, 0.7];
    const kept = batchInternalDedup(vectors, importances);
    // All dissimilar, all kept, in original order
    expect(kept).toEqual([0, 1, 2]);
  });

  it("respects custom threshold", () => {
    const vectors = [
      [1, 0, 0],
      [0.95, 0.31, 0], // cosine ~0.95 with [0]
    ];
    const importances = [0.8, 0.7];

    // Default threshold 0.85 → should dedup
    const strictKept = batchInternalDedup(vectors, importances, 0.85);
    expect(strictKept).toHaveLength(1);

    // Loose threshold 0.99 → should keep both
    const looseKept = batchInternalDedup(vectors, importances, 0.99);
    expect(looseKept).toHaveLength(2);
  });
});
