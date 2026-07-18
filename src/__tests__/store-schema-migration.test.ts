import { describe, expect, it, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import * as lancedb from "@lancedb/lancedb";

import { MemoryStore } from "../store.js";

const DIM = 4;

/**
 * Regression: the pre-2026-04-09 table schema has 8 columns (no language /
 * fts_text). The old migration check sampled a row to detect missing columns,
 * so a 0-row legacy table never migrated and EVERY write then failed with
 * "Found field not in schema: language". Production hit exactly this: a table
 * created one day before the columns existed, empty for 3 months.
 */

async function createLegacyTable(dbPath: string, withRow: boolean) {
  const db = await lancedb.connect(dbPath);
  const seed = [
    {
      id: "__seed__",
      text: withRow ? "legacy row" : "",
      vector: new Array(DIM).fill(0),
      category: "other",
      scope: "s",
      importance: 0.5,
      timestamp: 1,
      metadata: "{}",
    },
  ];
  const t = await db.createTable("memories", seed);
  if (!withRow) await t.delete('id = "__seed__"');
  return t;
}

describe("MemoryStore schema migration (empty legacy table)", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("migrates an EMPTY legacy table so writes succeed", async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-mig-empty-"));
    await createLegacyTable(dir, false);

    const store = new MemoryStore({ dbPath: dir, vectorDim: DIM });
    const entry = await store.store({
      text: "first write after migration",
      vector: new Array(DIM).fill(0.1),
      category: "other",
      scope: "s",
      importance: 0.5,
    });
    expect(entry.id).toBeTruthy();

    const db = await lancedb.connect(dir);
    const t = await db.openTable("memories");
    const fields = (await t.schema()).fields.map((f) => f.name);
    expect(fields).toContain("language");
    expect(fields).toContain("fts_text");
  });

  it("migrates a NON-EMPTY legacy table and backfills defaults", async () => {
    dir = await mkdtemp(join(tmpdir(), "rn-mig-full-"));
    await createLegacyTable(dir, true);

    const store = new MemoryStore({ dbPath: dir, vectorDim: DIM });
    await store.store({
      text: "second row",
      vector: new Array(DIM).fill(0.2),
      category: "other",
      scope: "s",
      importance: 0.5,
    });

    const db = await lancedb.connect(dir);
    const t = await db.openTable("memories");
    const rows = await t.query().toArray();
    expect(rows).toHaveLength(2);
    const legacy = rows.find((r) => r.id === "__seed__") as any;
    expect(legacy.language).toBe("en");
    expect(legacy.fts_text).toBe("legacy row");
  });
});
