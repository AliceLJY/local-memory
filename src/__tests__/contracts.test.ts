import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetWriteCount } from "../activity-counter.js";
import { resetGcTimestamp } from "../auto-gc.js";
import { runDream } from "../dream-pipeline.js";
import { MemoryStore } from "../store.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "recallnest-contract-"));
  tmpDirs.push(dir);
  return dir;
}

function makeStore(): MemoryStore {
  return new MemoryStore({ dbPath: makeTmpDir(), vectorDim: 3 });
}

function uuidFor(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function activeMetadata(validFrom = Date.now()): string {
  return JSON.stringify({
    evolution: {
      status: "active",
      version: 1,
      accessCount: 0,
      lastAccessedAt: null,
      supersededBy: null,
      consolidatedInto: null,
      contributedToPattern: null,
      sourceMemories: [],
      validFrom,
      validUntil: null,
    },
  });
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("MemoryStore interface contract", () => {
  it("returns stats with totalCount and no legacy total field", async () => {
    const store = makeStore();

    await store.store({
      id: "contract-stats-1",
      text: "contract stats one",
      vector: [1, 0, 0],
      category: "events",
      scope: "project:contracts",
      importance: 0.4,
      metadata: activeMetadata(),
    });
    await store.store({
      id: "contract-stats-2",
      text: "contract stats two",
      vector: [0, 1, 0],
      category: "preferences",
      scope: "project:contracts",
      importance: 0.6,
      metadata: activeMetadata(),
    });

    const stats = await store.stats(["project:contracts"]);

    expect(stats.totalCount).toBe(2);
    expect(stats.scopeCounts["project:contracts"]).toBe(2);
    expect(stats.categoryCounts.events).toBe(1);
    expect(stats.categoryCounts.preferences).toBe(1);
    expect("total" in stats).toBe(false);
  });

  it("uses positional list(scopeFilter, category, limit, offset) arguments", async () => {
    const store = makeStore();

    await store.store({
      id: "contract-list-1",
      text: "contract list one",
      vector: [1, 0, 0],
      category: "events",
      scope: "project:contracts",
      importance: 0.5,
      metadata: activeMetadata(),
    });
    await store.store({
      id: "contract-list-2",
      text: "contract list two",
      vector: [0, 1, 0],
      category: "events",
      scope: "project:contracts",
      importance: 0.5,
      metadata: activeMetadata(),
    });
    await store.store({
      id: "contract-list-3",
      text: "contract list out of scope",
      vector: [0, 0, 1],
      category: "events",
      scope: "project:other",
      importance: 0.5,
      metadata: activeMetadata(),
    });

    const oneEvent = await store.list(["project:contracts"], "events", 1, 1);
    const allEvents = await store.list(["project:contracts"], "events", 10, 0);

    expect(oneEvent).toHaveLength(1);
    expect(oneEvent[0].scope).toBe("project:contracts");
    expect(oneEvent[0].category).toBe("events");
    expect(allEvents.map(e => e.id).sort()).toEqual(["contract-list-1", "contract-list-2"]);
  });
});

describe("Dream pipeline store contract", () => {
  beforeEach(() => {
    resetWriteCount();
    resetGcTimestamp();
  });

  it("runs prune through auto-gc with real stats/list signatures", async () => {
    const store = makeStore();
    const scope = "project:contracts";
    const oldTimestamp = Date.now() - 120 * 86_400_000;

    for (let i = 0; i < 3; i++) {
      await store.store({
        id: uuidFor(i),
        text: `contract dream stale memory ${i}`,
        vector: [1, 0, 0],
        category: "events",
        scope,
        importance: 0.1,
        metadata: activeMetadata(oldTimestamp),
      });
    }

    const result = await runDream({
      store,
      llm: null,
      embedder: { async embedPassage() { return [1, 0, 0]; } },
      scope,
      force: true,
      config: {
        minClusterSize: 3,
        maxEntriesPerRun: 10,
        gc: {
          minMemoryCount: 1,
          minHoursSinceLastGc: 0,
          decayScoreThreshold: 0.99,
          maxArchivePerRun: 10,
          minAgeDays: 0,
        },
      },
    });

    expect(result.ran).toBe(true);
    expect(result.stats.archivedCount).toBeGreaterThan(0);
    expect(result.phases.find(p => p.phase === "prune")?.detail).toContain("entries archived");
  });
});

describe("MCP registry contract", () => {
  it("keeps registered tool count and tier header in sync", () => {
    const source = readFileSync(join(import.meta.dir, "..", "mcp-server.ts"), "utf8");
    const header = source.slice(0, source.indexOf("const TOOL_TIERS"));
    const registeredTools = [...source.matchAll(/^\s*registerTool\(\s*"([^"]+)"/gm)].map(m => m[1]);
    const tiers = new Map(
      [...source.matchAll(/^\s*([A-Za-z0-9_]+):\s*"(core|advanced|governance)"/gm)]
        .map(m => [m[1], m[2]] as const),
    );

    const missingTier = registeredTools.filter(name => !tiers.has(name));
    const coreCount = registeredTools.filter(name => tiers.get(name) === "core").length;
    const defaultCount = registeredTools.filter(name => tiers.get(name) !== "governance").length;
    const fullCount = registeredTools.length;

    const headerCount = (tier: "core" | "advanced" | "full") => {
      const match = header.match(new RegExp(`\\* - ${tier}:.*\\((\\d+) tools\\)`));
      expect(match).not.toBeNull();
      return Number(match![1]);
    };

    expect(registeredTools).toHaveLength(42);
    expect(missingTier).toEqual([]);
    expect(headerCount("core")).toBe(coreCount);
    expect(headerCount("advanced")).toBe(defaultCount);
    expect(headerCount("full")).toBe(fullCount);
  });
});
