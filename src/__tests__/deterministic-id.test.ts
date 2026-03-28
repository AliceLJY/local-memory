import { describe, expect, it } from "bun:test";

import { deterministicId } from "../store.js";

describe("deterministicId", () => {
  it("same scope+text always produce the same ID", () => {
    const id1 = deterministicId("project:test", "I prefer TypeScript");
    const id2 = deterministicId("project:test", "I prefer TypeScript");
    expect(id1).toBe(id2);
  });

  it("different text produces different ID", () => {
    const id1 = deterministicId("project:test", "I prefer TypeScript");
    const id2 = deterministicId("project:test", "I prefer JavaScript");
    expect(id1).not.toBe(id2);
  });

  it("different scope produces different ID", () => {
    const id1 = deterministicId("project:alpha", "same text");
    const id2 = deterministicId("project:beta", "same text");
    expect(id1).not.toBe(id2);
  });

  it("returns UUID-shaped string (8-4-4-4-12)", () => {
    const id = deterministicId("project:test", "hello world");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("handles empty scope gracefully", () => {
    const id = deterministicId("", "some text");
    expect(id).toMatch(/^[0-9a-f]{8}-/);
  });

  it("handles CJK text", () => {
    const id1 = deterministicId("project:test", "我喜欢用Bun");
    const id2 = deterministicId("project:test", "我喜欢用Bun");
    expect(id1).toBe(id2);
  });
});
