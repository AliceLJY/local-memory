import { describe, it, expect } from "bun:test";
import {
  parseEvolution,
  patchEvolution,
  defaultEvolution,
  buildPendingReviewMetadata,
  isPendingReview,
  resolvePendingReview,
  isActiveMemory,
} from "../memory-evolution.js";

describe("HP-6: Pending review (delayed judgment)", () => {
  describe("buildPendingReviewMetadata", () => {
    it("marks entry as pending_review", () => {
      const meta = patchEvolution("{}", defaultEvolution());
      const result = buildPendingReviewMetadata(meta);
      const evo = parseEvolution(result);
      expect(evo.status).toBe("pending_review");
    });

    it("preserves other evolution fields", () => {
      const meta = patchEvolution("{}", { ...defaultEvolution(), accessCount: 5 });
      const result = buildPendingReviewMetadata(meta);
      const evo = parseEvolution(result);
      expect(evo.status).toBe("pending_review");
      expect(evo.accessCount).toBe(5);
    });
  });

  describe("isPendingReview", () => {
    it("returns true for pending_review status", () => {
      const meta = buildPendingReviewMetadata(patchEvolution("{}", defaultEvolution()));
      expect(isPendingReview(meta)).toBe(true);
    });

    it("returns false for active status", () => {
      const meta = patchEvolution("{}", defaultEvolution());
      expect(isPendingReview(meta)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isPendingReview(undefined)).toBe(false);
    });
  });

  describe("resolvePendingReview", () => {
    it("transitions pending_review → active", () => {
      const meta = buildPendingReviewMetadata(patchEvolution("{}", defaultEvolution()));
      expect(parseEvolution(meta).status).toBe("pending_review");

      const resolved = resolvePendingReview(meta);
      expect(parseEvolution(resolved).status).toBe("active");
    });
  });

  describe("isActiveMemory includes pending_review", () => {
    it("active → true", () => {
      const meta = patchEvolution("{}", defaultEvolution());
      expect(isActiveMemory(meta)).toBe(true);
    });

    it("pending_review → true (participates in search)", () => {
      const meta = buildPendingReviewMetadata(patchEvolution("{}", defaultEvolution()));
      expect(isActiveMemory(meta)).toBe(true);
    });

    it("superseded → false", () => {
      const meta = patchEvolution("{}", { ...defaultEvolution(), status: "superseded" });
      expect(isActiveMemory(meta)).toBe(false);
    });

    it("archived → false", () => {
      const meta = patchEvolution("{}", { ...defaultEvolution(), status: "archived" });
      expect(isActiveMemory(meta)).toBe(false);
    });
  });
});
