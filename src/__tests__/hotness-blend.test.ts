import { describe, it, expect } from "bun:test";
import { computeHotnessScore, parseAccessMetadata } from "../access-tracker.js";

describe("computeHotnessScore", () => {
  it("returns 0 for zero accesses", () => {
    expect(computeHotnessScore(0, Date.now())).toBe(0);
  });

  it("returns positive score for accessed memories", () => {
    const score = computeHotnessScore(5, Date.now());
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("higher access count yields higher score", () => {
    const now = Date.now();
    const low = computeHotnessScore(1, now);
    const mid = computeHotnessScore(5, now);
    const high = computeHotnessScore(50, now);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("recent access yields higher score than old access", () => {
    const now = Date.now();
    const recent = computeHotnessScore(5, now);
    const weekAgo = computeHotnessScore(5, now - 7 * 86_400_000);
    const monthAgo = computeHotnessScore(5, now - 30 * 86_400_000);
    expect(recent).toBeGreaterThan(weekAgo);
    expect(weekAgo).toBeGreaterThan(monthAgo);
  });

  it("decays to near-zero for very old accesses", () => {
    const score = computeHotnessScore(5, Date.now() - 365 * 86_400_000);
    expect(score).toBeLessThan(0.01);
  });

  it("caps at 1.0 even with extreme access counts", () => {
    const score = computeHotnessScore(10_000, Date.now());
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("respects custom decay rate", () => {
    const now = Date.now();
    const fast = computeHotnessScore(5, now - 7 * 86_400_000, 0.5);
    const slow = computeHotnessScore(5, now - 7 * 86_400_000, 0.01);
    expect(slow).toBeGreaterThan(fast);
  });
});

describe("parseAccessMetadata", () => {
  it("parses valid metadata", () => {
    const meta = JSON.stringify({ accessCount: 5, lastAccessedAt: 1234567890 });
    const result = parseAccessMetadata(meta);
    expect(result.accessCount).toBe(5);
    expect(result.lastAccessedAt).toBe(1234567890);
  });

  it("returns defaults for missing fields", () => {
    const result = parseAccessMetadata("{}");
    expect(result.accessCount).toBe(0);
    expect(result.lastAccessedAt).toBe(0);
  });

  it("handles undefined input", () => {
    const result = parseAccessMetadata(undefined);
    expect(result.accessCount).toBe(0);
    expect(result.lastAccessedAt).toBe(0);
  });

  it("handles malformed JSON", () => {
    const result = parseAccessMetadata("not-json");
    expect(result.accessCount).toBe(0);
    expect(result.lastAccessedAt).toBe(0);
  });
});
