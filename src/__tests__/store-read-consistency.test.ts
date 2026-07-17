import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readConsistencyInterval as envReadConsistencyInterval } from "../env-config.js";
import { MemoryStore } from "../store.js";

const cleanupPaths: string[] = [];
const savedEnv = process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL;

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
  if (savedEnv === undefined) {
    delete process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL;
  } else {
    process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = savedEnv;
  }
});

function tempDb(): string {
  const dbPath = mkdtempSync(join(tmpdir(), "recallnest-read-consistency-"));
  cleanupPaths.push(dbPath);
  return dbPath;
}

function entry(i: number) {
  return {
    text: `read-consistency memory ${i}`,
    vector: [0.1 * i, 0.2 * i, 0.3 * i],
    category: "fact" as const,
    scope: "project:rci-test",
    importance: 0.5,
  };
}

// A writer always sees its own commits on its own handle; the staleness gap
// only exists ACROSS handles. Two independent MemoryStore instances against
// the same dbPath reproduce the cross-process topology (CLI ingest vs resident
// MCP/API/UI server) in-process: the writer deletes a row after the reader's
// handle has already opened the table.
describe("read consistency across independent connections", () => {
  it("default (env unset) is strong consistency: reader sees the writer's delete", async () => {
    delete process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL;
    const dbPath = tempDb();

    const writer = new MemoryStore({ dbPath, vectorDim: 3 });
    const e1 = await writer.store(entry(1));
    await writer.store(entry(2));

    const reader = new MemoryStore({ dbPath, vectorDim: 3 });
    expect((await reader.list(undefined, undefined, 20, 0)).length).toBe(2);

    await writer.delete(e1.id);

    expect((await reader.list(undefined, undefined, 20, 0)).length).toBe(1);
  });

  it("env 'off' restores the legacy pinned-handle behavior (negative control)", async () => {
    process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = "off";
    const dbPath = tempDb();

    const writer = new MemoryStore({ dbPath, vectorDim: 3 });
    const e1 = await writer.store(entry(1));
    await writer.store(entry(2));

    const reader = new MemoryStore({ dbPath, vectorDim: 3 });
    expect((await reader.list(undefined, undefined, 20, 0)).length).toBe(2);

    await writer.delete(e1.id);

    expect((await reader.list(undefined, undefined, 20, 0)).length).toBe(2);
  });

  it("explicit config wins over env: interval 0 sees the delete despite env 'off'", async () => {
    process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = "off";
    const dbPath = tempDb();

    const writer = new MemoryStore({ dbPath, vectorDim: 3 });
    const e1 = await writer.store(entry(1));
    await writer.store(entry(2));

    const reader = new MemoryStore({ dbPath, vectorDim: 3, readConsistencyInterval: 0 });
    expect((await reader.list(undefined, undefined, 20, 0)).length).toBe(2);

    await writer.delete(e1.id);

    expect((await reader.list(undefined, undefined, 20, 0)).length).toBe(1);
  });

  // Cross-handle visibility behavior is pinned by the three tests above;
  // what remains is the env parsing matrix of the resolver itself.
  it("env resolver: unset/empty → 0, off/none → undefined, numbers pass, junk clamps to 0", () => {
    delete process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL;
    expect(envReadConsistencyInterval()).toBe(0);

    process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = "";
    expect(envReadConsistencyInterval()).toBe(0);

    for (const legacy of ["off", "none"]) {
      process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = legacy;
      expect(envReadConsistencyInterval()).toBeUndefined();
    }

    process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = "7";
    expect(envReadConsistencyInterval()).toBe(7);
    process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = "1.5";
    expect(envReadConsistencyInterval()).toBe(1.5);
    process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = "0";
    expect(envReadConsistencyInterval()).toBe(0);

    for (const junk of ["-3", "abc", "Infinity", "NaN"]) {
      process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL = junk;
      expect(envReadConsistencyInterval()).toBe(0);
    }
  });
});
