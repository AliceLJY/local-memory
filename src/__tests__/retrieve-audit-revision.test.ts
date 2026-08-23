/**
 * Retrieve-audit revision/provenance coverage.
 *
 * `3fc1875` connected the retrieve audit (setAuditLogger had zero callers, so the
 * `?.` call was a permanent no-op). What it records is `query="…" hits=N` — enough to
 * prove a retrieval happened, not enough to answer the question an audit log is for:
 * when an agent acted on recalled memory, *which revision did it read*?
 *
 * That gap is not cosmetic. `archiveBeliefVersion` rewrites a belief in place: the
 * canonical id stays, `evolution.version` goes up, and the old text survives as a
 * separate `superseded` row. So "memory abc1234 was retrieved" is ambiguous across every
 * belief change, and a stale answer is indistinguishable from a current one after the
 * fact.
 *
 * These tests pin the extra fields on the existing audit row. They deliberately do not
 * introduce a second audit path — the assertions run against the same `AuditLogger`
 * interface the store/update/delete operations already use.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUDIT_RETRIEVED_CAP, createAuditLogger, type AuditEntry } from "../audit-log.js";
import { createRetriever } from "../retriever.js";

function recordingLogger(): { entries: AuditEntry[]; logger: any } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    logger: {
      log(entry: Omit<AuditEntry, "timestamp">) {
        entries.push({ timestamp: new Date().toISOString(), ...entry });
      },
      getRecent: () => entries,
      exportAll: () => entries,
      count: () => entries.length,
    },
  };
}

interface FakeRow {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
  score?: number;
}

function buildRetriever(rows: FakeRow[]) {
  const results = rows.map((row) => ({
    entry: {
      id: row.id,
      text: row.text,
      vector: [1, 0, 0],
      category: "cases",
      scope: "memory",
      importance: 0.8,
      timestamp: Date.parse("2026-08-01T00:00:00.000Z"),
      ...(row.metadata ? { metadata: JSON.stringify(row.metadata) } : {}),
    },
    score: row.score ?? 0.9,
  }));

  return createRetriever(
    {
      hasFtsSupport: false,
      async vectorSearch() {
        return results;
      },
    } as any,
    {
      async embedQuery() {
        return [1, 0, 0];
      },
      async embedPassage() {
        return [1, 0, 0];
      },
    } as any,
    {
      mode: "vector",
      rerank: "none",
      filterNoise: false,
      hardMinScore: 0,
      minScore: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
    },
  );
}

describe("retrieve audit records revision and provenance", () => {
  it("records the served revision, lifecycle status, and boundary of each hit", async () => {
    const { entries, logger } = recordingLogger();
    const retriever = buildRetriever([
      {
        id: "aaaaaaaa-1111-2222-3333-444444444444",
        text: "Alice uses Bun, not npm",
        metadata: {
          evolution: { status: "active", version: 3 },
          boundary: {
            layer: "durable",
            authority: "structured-memory",
            conflictPolicy: "latest-wins",
          },
        },
      },
    ]);
    retriever.setAuditLogger(logger);

    await retriever.retrieve({ query: "which runtime does recallnest use", scopeFilter: ["memory"], limit: 5 });

    const row = entries.find((e) => e.operation === "retrieve");
    expect(row).toBeDefined();
    expect(row?.retrieved).toEqual([
      { id: "aaaaaaaa", rev: 3, st: "active", ly: "durable", au: "structured-memory" },
    ]);
    // The pre-existing details string is untouched — this extends the row, not replaces it.
    expect(row?.details).toContain('query="which runtime does recallnest use"');
    expect(row?.details).toContain("hits=1");
  });

  it("distinguishes a superseded revision from the live one", async () => {
    const { entries, logger } = recordingLogger();
    // Both rows are reachable by design: belief history is archive-first, so a query can
    // legitimately surface the old text. Without `rev`/`st` the audit row cannot tell
    // afterwards whether the agent read the current belief or the retired one.
    const retriever = buildRetriever([
      {
        id: "cccccccc-0000-0000-0000-000000000000",
        text: "Deploys go through the mini",
        metadata: {
          evolution: { status: "active", version: 2 },
          boundary: { layer: "durable", authority: "structured-memory", conflictPolicy: "latest-wins" },
        },
      },
      {
        id: "hhhhhhhh-0000-0000-0000-000000000000",
        text: "Deploys go through the MacBook",
        metadata: {
          evolution: { status: "superseded", version: 1, supersededBy: "cccccccc-0000-0000-0000-000000000000" },
          boundary: { layer: "durable", authority: "structured-memory", conflictPolicy: "latest-wins" },
        },
        score: 0.85,
      },
    ]);
    retriever.setAuditLogger(logger);

    await retriever.retrieve({
      query: "where do deploys run",
      scopeFilter: ["memory"],
      limit: 5,
      // Superseded rows are excluded by default; this is the path that can serve one.
      includeArchived: true,
    });

    const row = entries.find((e) => e.operation === "retrieve");
    const served = row?.retrieved ?? [];
    const byId = new Map(served.map((r) => [r.id, r]));

    expect(byId.get("cccccccc")).toMatchObject({ rev: 2, st: "active" });
    expect(byId.get("hhhhhhhh")).toMatchObject({ rev: 1, st: "superseded" });
  });

  it("defaults a memory with no evolution block to revision 1 / active", async () => {
    const { entries, logger } = recordingLogger();
    // Pre-versioning rows exist in the live database; they must not break the audit row.
    const retriever = buildRetriever([
      { id: "eeeeeeee-0000-0000-0000-000000000000", text: "legacy entry with no metadata" },
    ]);
    retriever.setAuditLogger(logger);

    await retriever.retrieve({ query: "legacy", scopeFilter: ["memory"], limit: 5 });

    const row = entries.find((e) => e.operation === "retrieve");
    expect(row?.retrieved).toEqual([{ id: "eeeeeeee", rev: 1, st: "active" }]);
    // No boundary metadata means no layer/authority claim — absent, not guessed.
    expect(row?.retrieved?.[0]).not.toHaveProperty("ly");
    expect(row?.retrieved?.[0]).not.toHaveProperty("au");
  });

  it("caps the list and says so, rather than silently reporting a short one", async () => {
    const { entries, logger } = recordingLogger();
    const overCap = AUDIT_RETRIEVED_CAP + 4;
    const retriever = buildRetriever(
      Array.from({ length: overCap }, (_, i) => ({
        id: `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`,
        text: `candidate ${i}`,
        metadata: { evolution: { status: "active", version: 1 } },
        score: 0.9 - i * 0.001,
      })),
    );
    retriever.setAuditLogger(logger);

    await retriever.retrieve({ query: "many candidate rows for one query", scopeFilter: ["memory"], limit: overCap });

    const row = entries.find((e) => e.operation === "retrieve");
    expect(row?.retrieved).toHaveLength(AUDIT_RETRIEVED_CAP);
    // audit.jsonl has no rotation, so the list is bounded — but truncation must be legible.
    expect(row?.retrievedTotal).toBe(overCap);
    expect(row?.details).toContain(`hits=${overCap}`);
  });

  it("round-trips the new fields through the real file logger", async () => {
    // The unit tests above assert against an in-memory logger. This one proves the fields
    // survive the actual JSONL path — serialization, append, and parse-back — so a shape
    // that only works in tests cannot pass. Uses a temp dir, never the production log.
    const dir = mkdtempSync(join(tmpdir(), "recallnest-audit-"));
    const logPath = join(dir, "audit.jsonl");

    try {
      const retriever = buildRetriever([
        {
          id: "ffffffff-0000-0000-0000-000000000000",
          text: "Release verification runs on the mini",
          metadata: {
            evolution: { status: "active", version: 5 },
            boundary: { layer: "evidence", authority: "distillation", conflictPolicy: "append-only" },
          },
        },
      ]);
      retriever.setAuditLogger(createAuditLogger(logPath));

      await retriever.retrieve({
        query: "where does release verification run",
        scopeFilter: ["memory"],
        limit: 5,
      });

      const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
      const row = lines.map((l) => JSON.parse(l) as AuditEntry).find((e) => e.operation === "retrieve");

      expect(row?.retrieved).toEqual([
        { id: "ffffffff", rev: 5, st: "active", ly: "evidence", au: "distillation" },
      ]);
      expect(typeof row?.timestamp).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits both fields when nothing was served", async () => {
    const { entries, logger } = recordingLogger();
    const retriever = buildRetriever([]);
    retriever.setAuditLogger(logger);

    await retriever.retrieve({ query: "a question with no stored answer", scopeFilter: ["memory"], limit: 5 });

    const row = entries.find((e) => e.operation === "retrieve");
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("retrieved");
    // retrievedTotal exists to flag truncation; with an empty list there is none to flag.
    expect(row).not.toHaveProperty("retrievedTotal");
  });
});
