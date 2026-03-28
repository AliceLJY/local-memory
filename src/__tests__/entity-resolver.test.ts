import { describe, expect, it } from "bun:test";

import { EntityResolver, BUILTIN_ALIASES, defaultResolver, resolveQueryEntities } from "../entity-resolver.js";

describe("EntityResolver", () => {
  it("resolves known aliases", () => {
    expect(defaultResolver.resolve("ts")).toBe("typescript");
    expect(defaultResolver.resolve("TS")).toBe("typescript");
    expect(defaultResolver.resolve("k8s")).toBe("kubernetes");
    expect(defaultResolver.resolve("pg")).toBe("postgresql");
  });

  it("returns term as-is for unknown aliases", () => {
    expect(defaultResolver.resolve("unknownThing")).toBe("unknownThing");
    expect(defaultResolver.resolve("")).toBe("");
  });

  it("supports user aliases that override builtins", () => {
    const resolver = new EntityResolver(BUILTIN_ALIASES, { "ts": "my-custom-ts" });
    expect(resolver.resolve("ts")).toBe("my-custom-ts");
  });

  it("resolveText replaces aliases in context", () => {
    const text = "I'm using TS with k8s and pg for the backend";
    const resolved = defaultResolver.resolveText(text);
    expect(resolved).toContain("typescript");
    expect(resolved).toContain("kubernetes");
    expect(resolved).toContain("postgresql");
  });

  it("resolveText handles longer aliases first", () => {
    const text = "Using docker-compose for local dev";
    const resolved = defaultResolver.resolveText(text);
    expect(resolved).toContain("docker compose");
  });

  it("hasAlias returns true for known aliases", () => {
    expect(defaultResolver.hasAlias("ts")).toBe(true);
    expect(defaultResolver.hasAlias("unknown")).toBe(false);
  });

  it("size returns the number of aliases", () => {
    expect(defaultResolver.size).toBeGreaterThan(40);
  });
});

describe("resolveQueryEntities", () => {
  it("normalizes entities in a search query", () => {
    const result = resolveQueryEntities("search for ts config in k8s");
    expect(result).toContain("typescript");
    expect(result).toContain("kubernetes");
  });

  it("passes through queries with no aliases", () => {
    const result = resolveQueryEntities("how to deploy a web app");
    expect(result).toBe("how to deploy a web app");
  });
});
