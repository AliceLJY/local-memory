import { describe, it, expect } from "bun:test";
import { isDecayExempt } from "../decay-engine.js";

describe("HP-7: Decay exemption rules", () => {
  describe("Rule 1: core tier + importance ≥ 0.95", () => {
    it("exempts explicit core with high importance", () => {
      const meta = JSON.stringify({ tier: "core", importance: 0.95 });
      expect(isDecayExempt(meta, 0.95)).toBe(true);
    });

    it("exempts inferred core (importance ≥ 0.95)", () => {
      const meta = JSON.stringify({ importance: 0.96 });
      expect(isDecayExempt(meta, 0.96)).toBe(true);
    });

    it("does NOT exempt core with importance < 0.95", () => {
      const meta = JSON.stringify({ tier: "core", importance: 0.90 });
      expect(isDecayExempt(meta, 0.90)).toBe(false);
    });

    it("does NOT exempt working tier even with high importance", () => {
      const meta = JSON.stringify({ tier: "working", importance: 0.96 });
      expect(isDecayExempt(meta, 0.96)).toBe(false);
    });
  });

  describe("Rule 2: recently accessed (within 7 days)", () => {
    it("exempts memory accessed 1 day ago", () => {
      const meta = JSON.stringify({
        lastAccessedAt: Date.now() - 1 * 86_400_000,
      });
      expect(isDecayExempt(meta, 0.50)).toBe(true);
    });

    it("does NOT exempt memory accessed 8 days ago", () => {
      const meta = JSON.stringify({
        lastAccessedAt: Date.now() - 8 * 86_400_000,
      });
      expect(isDecayExempt(meta, 0.50)).toBe(false);
    });

    it("does NOT exempt when lastAccessedAt is 0", () => {
      const meta = JSON.stringify({ lastAccessedAt: 0 });
      expect(isDecayExempt(meta, 0.50)).toBe(false);
    });
  });

  describe("Rule 3: pinned tag", () => {
    it("exempts memory with pinned tag", () => {
      const meta = JSON.stringify({ tags: ["workflow", "pinned"] });
      expect(isDecayExempt(meta, 0.40)).toBe(true);
    });

    it("does NOT exempt without pinned tag", () => {
      const meta = JSON.stringify({ tags: ["workflow", "pattern"] });
      expect(isDecayExempt(meta, 0.40)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("returns false for undefined metadata", () => {
      expect(isDecayExempt(undefined, 0.95)).toBe(false);
    });

    it("returns false for empty metadata", () => {
      expect(isDecayExempt("{}", 0.50)).toBe(false);
    });

    it("returns false for corrupt metadata", () => {
      expect(isDecayExempt("not-json", 0.95)).toBe(false);
    });

    it("multiple rules: first match wins", () => {
      // Core + pinned + recent — all three rules match
      const meta = JSON.stringify({
        tier: "core",
        importance: 0.98,
        lastAccessedAt: Date.now() - 3600000,
        tags: ["pinned"],
      });
      expect(isDecayExempt(meta, 0.98)).toBe(true);
    });
  });
});
