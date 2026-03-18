import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore, classifyLegacyScope } from "../store.js";

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function createStore(): MemoryStore {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-scope-audit-"));
  cleanupPaths.push(dbPath);
  return new MemoryStore({
    dbPath,
    vectorDim: 3,
  });
}

describe("classifyLegacyScope", () => {
  it("flags missing, empty, and global scope values", () => {
    expect(classifyLegacyScope(undefined)).toBe("missing");
    expect(classifyLegacyScope(null)).toBe("missing");
    expect(classifyLegacyScope("")).toBe("empty");
    expect(classifyLegacyScope("   ")).toBe("empty");
    expect(classifyLegacyScope("global")).toBe("global");
    expect(classifyLegacyScope(" global ")).toBe("global");
    expect(classifyLegacyScope("project:recallnest")).toBeUndefined();
  });
});

describe("MemoryStore.auditLegacyScopes", () => {
  it("reports global and empty scope rows without mixing in valid scoped data", async () => {
    const store = createStore();

    await store.store({
      text: "Scoped memory should not appear in the audit.",
      vector: [1, 0, 0],
      category: "entities",
      scope: "project:recallnest",
      importance: 0.8,
      metadata: "{}",
    });
    await store.store({
      text: "Historical row that used the global fallback.",
      vector: [0, 1, 0],
      category: "events",
      scope: "global",
      importance: 0.5,
      metadata: "{}",
    });
    await store.store({
      text: "Historical row that was written without a real scope.",
      vector: [0, 0, 1],
      category: "events",
      scope: "   ",
      importance: 0.4,
      metadata: "{}",
    });

    const audit = await store.auditLegacyScopes(10);

    expect(audit.totalCount).toBe(2);
    expect(audit.counts).toEqual({
      missing: 0,
      empty: 1,
      global: 1,
    });
    expect(audit.samples).toHaveLength(2);
    expect(audit.samples.map((sample) => sample.kind).sort()).toEqual(["empty", "global"]);
    expect(audit.samples.every((sample) => sample.scope !== "project:recallnest")).toBe(true);
  });
});
