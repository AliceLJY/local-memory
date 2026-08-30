import { describe, expect, it } from "bun:test";

import {
  PIVOT_APPLY_CAPTURE,
  PIVOT_APPLY_EVIDENCE_CAPTURE,
  PIVOT_APPLY_SOURCE,
  PIVOT_SCOPE,
  PivotCandidateInputSchema,
  PivotEvidenceCandidateInputSchema,
  persistPivotBatch,
  persistPivotCandidate,
} from "../pivot-apply.js";
import { evidenceIdentityPayload } from "../pivot-evidence.js";

const REPORT_ID = "00b609834309b7b44d1e36fc7c93169e083abb66487073bfd64d8c5bafc337fa";

function candHash(seed: string): string {
  // Deterministic 64-hex filler for tests — content-addressing is the runner's job.
  return seed.repeat(64).slice(0, 64);
}

function makeCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "preference_rule",
    text: "用户确立了外部项目学习的标准化工作流：分析链接后必须记录到 learnings 并同步更新借鉴审计目录。",
    anchor: "你要记住了，以后都是，甩链接，学习，记录。",
    canonicalKey: "pivot-preference-rule-learning-audit-workflow",
    evidence: ["你要记住了，以后都是，甩链接，学习，记录，如果借鉴了就要记到审计这里。"],
    proposedScope: PIVOT_SCOPE,
    proposedCategory: "preferences",
    tags: ["src:bb8af0b7", "date:2026-04-12", "harness:claude-code", "raw:claude"],
    sessionId: "bb8af0b7-cc58-4bb2-8e35-9744537e5854",
    reportId: REPORT_ID,
    candidateHash: candHash("a"),
    batchId: "test-batch-1",
    importance: 0.7,
    ...overrides,
  };
}

function evidenceProvenance(): Record<string, unknown> {
  return {
    evidenceContractVersion: 1,
    sourceFingerprint: candHash("f"),
    anchorCoordinate: {
      sessionId: "bb8af0b7-cc58-4bb2-8e35-9744537e5854",
      ordinal: 0,
      role: "user",
      contentDigest: candHash("1"),
    },
    evidenceWindows: [{
      sessionId: "bb8af0b7-cc58-4bb2-8e35-9744537e5854",
      startOrdinal: 1,
      endOrdinal: 1,
      turns: [{
        ordinal: 1,
        role: "assistant",
        contentDigest: candHash("2"),
        evidenceIndexes: [0],
      }],
    }],
  };
}

function createDeps() {
  const storedEntries: Array<Record<string, unknown>> = [];
  const auditLines: Array<Record<string, unknown>> = [];
  let seq = 1;

  const store = {
    async store(entry: Record<string, unknown>) {
      const stored = {
        ...entry,
        id: `00000000-0000-0000-0000-${String(seq).padStart(12, "0")}`,
        timestamp: 1_700_000_000_000 + seq,
      };
      seq += 1;
      storedEntries.push(stored);
      return stored;
    },
    async list(_scopeFilter?: string[], category?: string, limit = 20, offset = 0) {
      return storedEntries
        .filter((entry) => !category || entry.category === category)
        .slice(offset, offset + limit);
    },
    async update(id: string, updates: Record<string, unknown>) {
      const index = storedEntries.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      storedEntries[index] = { ...storedEntries[index], ...updates };
      return storedEntries[index];
    },
    async upsert(entry: Record<string, unknown>) {
      const index = storedEntries.findIndex((item) => item.id === entry.id);
      if (index >= 0) storedEntries[index] = { ...entry };
      else storedEntries.push({ ...entry });
      return entry;
    },
    async get(id: string) {
      return storedEntries.find((entry) => entry.id === id) ?? null;
    },
  };

  return {
    storedEntries,
    auditLines,
    deps: {
      store,
      embedder: {
        async embedPassage(text: string) {
          return [text.length, 1, 0];
        },
      },
      auditLogger: {
        log(line: Record<string, unknown>) {
          auditLines.push(line);
        },
      },
    },
  };
}

describe("PivotCandidateInputSchema", () => {
  it("accepts a corpus-shaped candidate", () => {
    expect(() => PivotCandidateInputSchema.parse(makeCandidate())).not.toThrow();
  });

  it("rejects kind/category mismatch (corpus mapping violated)", () => {
    expect(() =>
      PivotCandidateInputSchema.parse(makeCandidate({ kind: "case", proposedCategory: "events" })),
    ).toThrow();
  });

  it("rejects a wrong scope, missing identity keys, and malformed hashes", () => {
    expect(() => PivotCandidateInputSchema.parse(makeCandidate({ proposedScope: "memory:other" }))).toThrow();
    const missing = makeCandidate();
    delete missing.candidateHash;
    expect(() => PivotCandidateInputSchema.parse(missing)).toThrow();
    expect(() => PivotCandidateInputSchema.parse(makeCandidate({ reportId: "not-hex" }))).toThrow();
  });

  it("requires a complete, canonical evidence-coordinate contract for v2 apply", () => {
    expect(evidenceIdentityPayload(makeCandidate())).toEqual({});
    expect(evidenceIdentityPayload(makeCandidate(evidenceProvenance()))).toEqual(evidenceProvenance());
    expect(() => PivotEvidenceCandidateInputSchema.parse(makeCandidate(evidenceProvenance()))).not.toThrow();
    expect(() => PivotEvidenceCandidateInputSchema.parse(makeCandidate())).toThrow("requires contract version 1");
    expect(() => PivotCandidateInputSchema.parse(makeCandidate({
      ...evidenceProvenance(),
      evidenceWindows: [],
    }))).toThrow("has no source coordinate");
    expect(() => PivotCandidateInputSchema.parse(makeCandidate({
      ...evidenceProvenance(),
      sourceFingerprint: undefined,
    }))).toThrow("must be complete");
  });
});

describe("persistPivotCandidate", () => {
  it("stores a clean candidate with session_distill identity and full pivot metadata", async () => {
    const { deps, storedEntries, auditLines } = createDeps();
    const outcome = await persistPivotCandidate(deps as never, makeCandidate(evidenceProvenance()));

    expect(outcome.disposition).toBe("stored");
    expect(outcome.memoryId).not.toBeNull();
    expect(outcome.verified).toBe(true);

    expect(storedEntries.length).toBe(1);
    const meta = JSON.parse(String(storedEntries[0].metadata)) as Record<string, unknown>;
    expect(meta.source).toBe(PIVOT_APPLY_SOURCE);
    expect(meta.capture).toBe(PIVOT_APPLY_EVIDENCE_CAPTURE);
    expect(meta.anchor).toBe("你要记住了，以后都是，甩链接，学习，记录。");
    expect((meta.confidence as Record<string, unknown>).score).toBe(0.6);
    expect((meta.confidence as Record<string, unknown>).reliability).toBe("inferred");
    const pivotApply = meta.pivotApply as Record<string, unknown>;
    expect(pivotApply.kind).toBe("preference_rule");
    expect(pivotApply.reportId).toBe(REPORT_ID);
    expect(pivotApply.candidateHash).toBe(candHash("a"));
    expect(pivotApply.batchId).toBe("test-batch-1");
    expect(pivotApply.sessionId).toBe("bb8af0b7-cc58-4bb2-8e35-9744537e5854");
    expect(pivotApply.evidence).toEqual([
      "你要记住了，以后都是，甩链接，学习，记录，如果借鉴了就要记到审计这里。",
    ]);
    expect(pivotApply.evidenceContractVersion).toBe(1);
    expect(pivotApply.sourceFingerprint).toBe(candHash("f"));
    expect(pivotApply.anchorCoordinate).toEqual(evidenceProvenance().anchorCoordinate);
    expect(pivotApply.evidenceWindows).toEqual(evidenceProvenance().evidenceWindows);
    const tags = meta.tags as string[];
    expect(tags).toContain("pivot-apply");
    expect(tags).toContain("batch:test-batch-1");
    expect((meta.evolution as Record<string, unknown>).status).toBe("active");
    expect((meta.boundary as Record<string, unknown>).layer).toBe("durable");

    expect(auditLines.some((line) => line.operation === "store")).toBe(true);
  });

  it("runs without any LLM in deps (the channel must be LLM-free)", async () => {
    const { deps } = createDeps();
    // deps deliberately has no llm / kgExtractor / rateLimiter keys at all.
    const outcome = await persistPivotCandidate(deps as never, makeCandidate());
    expect(outcome.disposition).toBe("stored");
  });

  it("keeps the fixed historical apply contract available only as v1 metadata", async () => {
    const { deps, storedEntries } = createDeps();
    await persistPivotCandidate(deps as never, makeCandidate());
    const meta = JSON.parse(String(storedEntries[0].metadata)) as Record<string, unknown>;
    expect(meta.capture).toBe(PIVOT_APPLY_CAPTURE);
    const pivotApply = meta.pivotApply as Record<string, unknown>;
    expect(pivotApply.evidenceContractVersion).toBeUndefined();
  });

  it("dedupes an identical re-apply (same key, same normalized text) without writing twice", async () => {
    const { deps, storedEntries } = createDeps();
    const first = await persistPivotCandidate(deps as never, makeCandidate());
    const second = await persistPivotCandidate(deps as never, makeCandidate({ candidateHash: candHash("b") }));

    expect(first.disposition).toBe("stored");
    expect(second.disposition).toBe("deduped");
    expect(second.memoryId).toBe(first.memoryId);
    expect(storedEntries.length).toBe(1);
  });

  it("supersedes on same-key different-text for preferences (latest-wins revision)", async () => {
    const { deps, storedEntries } = createDeps();
    const first = await persistPivotCandidate(deps as never, makeCandidate());
    const second = await persistPivotCandidate(
      deps as never,
      makeCandidate({
        candidateHash: candHash("c"),
        text: "修订版：外部项目学习工作流新增 hippo-wiki 归档要求，三写缺一不可。",
      }),
    );

    expect(first.disposition).toBe("stored");
    expect(second.disposition).toBe("updated");
    // latest-wins updates the canonical row in place: same id stays live with V2
    // text, while V1 is copied out into a separate superseded history row.
    expect(second.memoryId).toBe(first.memoryId);
    const canonicalRow = storedEntries.find((entry) => entry.id === first.memoryId);
    expect(String(canonicalRow?.text)).toContain("修订版");
    const historyRow = storedEntries.find((entry) => {
      if (entry.id === first.memoryId) return false;
      try {
        const meta = JSON.parse(String(entry.metadata)) as Record<string, unknown>;
        return (meta.evolution as Record<string, unknown> | undefined)?.status === "superseded";
      } catch {
        return false;
      }
    });
    expect(historyRow).toBeDefined();
  });

  it("appends (stores) on same-key different-text for cases — append-only category", async () => {
    const { deps, storedEntries } = createDeps();
    const base = {
      kind: "case",
      proposedCategory: "cases",
      canonicalKey: "cases-append-only-probe",
    };
    const first = await persistPivotCandidate(
      deps as never,
      makeCandidate({ ...base, candidateHash: candHash("d"), text: "Case: 第一次踩坑的完整记录，包含问题与解法细节。" }),
    );
    const second = await persistPivotCandidate(
      deps as never,
      makeCandidate({ ...base, candidateHash: candHash("e"), text: "Case: 第二次同主题踩坑，但情境不同，应作为新行追加保存。" }),
    );

    expect(first.disposition).toBe("stored");
    expect(second.disposition).toBe("stored");
    expect(storedEntries.filter((e) => e.category === "cases").length).toBe(2);
  });

  it("reports conflict (and writes nothing) when the key collides across categories", async () => {
    const conflictRecords: Array<Record<string, unknown>> = [];
    const { deps, storedEntries } = createDeps();
    const depsWithConflict = {
      ...deps,
      conflictStore: {
        async save(record: Record<string, unknown>) {
          conflictRecords.push(record);
          return record;
        },
        async getOpenByFingerprint() {
          return null;
        },
        async getLatestByFingerprint() {
          return null;
        },
        async replace(record: Record<string, unknown>) {
          conflictRecords.push(record);
          return record;
        },
      },
    };
    const first = await persistPivotCandidate(
      depsWithConflict as never,
      makeCandidate({ canonicalKey: "pivot-cross-category-probe" }),
    );
    const crossCategory = await persistPivotCandidate(
      depsWithConflict as never,
      makeCandidate({
        kind: "decision",
        proposedCategory: "events",
        canonicalKey: "pivot-cross-category-probe",
        candidateHash: candHash("f"),
        text: "决策：同一个 canonicalKey 被另一类目引用，应触发 conflict 而非写入。",
      }),
    );

    expect(first.disposition).toBe("stored");
    expect(crossCategory.disposition).toBe("conflict");
    expect(crossCategory.conflictId).toBeDefined();
    expect(storedEntries.length).toBe(1);
  });

  it("retries transient 429 embedding errors and succeeds", async () => {
    const { deps } = createDeps();
    let calls = 0;
    const flakyDeps = {
      ...deps,
      embedder: {
        async embedPassage(text: string) {
          calls++;
          if (calls === 1) throw new Error("Request failed with status 429: rate limit exceeded");
          return [text.length, 1, 0];
        },
      },
    };
    const outcome = await persistPivotCandidate(flakyDeps as never, makeCandidate());
    expect(outcome.disposition).toBe("stored");
    expect(calls).toBe(2);
  });

  it("fails closed when the embedder returns an empty vector (store never validates shape)", async () => {
    const { deps, storedEntries } = createDeps();
    const emptyDeps = {
      ...deps,
      embedder: {
        async embedPassage() {
          return [] as number[];
        },
      },
    };
    await expect(persistPivotCandidate(emptyDeps as never, makeCandidate())).rejects.toThrow(/empty vector/);
    expect(storedEntries.length).toBe(0);
  });

  it("rejects noise via rule-based admission with a null memoryId and an audit line", async () => {
    const { deps, storedEntries, auditLines } = createDeps();
    const outcome = await persistPivotCandidate(
      deps as never,
      makeCandidate({ text: "好的好的，收到收到。", candidateHash: candHash("9") }),
    );

    expect(outcome.disposition).toBe("rejected");
    expect(outcome.memoryId).toBeNull();
    expect(outcome.rejectionReason).toBeDefined();
    expect(storedEntries.length).toBe(0);
    expect(auditLines.some((line) => line.operation === "reject")).toBe(true);
  });
});

describe("persistPivotBatch", () => {
  it("writes a clean batch fully and reports written = total", async () => {
    const { deps } = createDeps();
    const batch = [
      makeCandidate({ candidateHash: candHash("1"), canonicalKey: "pivot-batch-key-1" }),
      makeCandidate({
        candidateHash: candHash("2"),
        canonicalKey: "pivot-batch-key-2",
        text: "第二条独立候选：批内不同 key 不同文本，应正常写入。",
      }),
    ];
    const report = await persistPivotBatch(deps as never, "test-batch-1", batch);

    expect(report.halted).toBe(false);
    expect(report.total).toBe(2);
    expect(report.written).toBe(2);
    expect(report.outcomes.every((o) => o.disposition === "stored")).toBe(true);
  });

  it("halts fail-closed on the first unexpected disposition and keeps prior outcomes", async () => {
    const { deps, storedEntries } = createDeps();
    const batch = [
      makeCandidate({ candidateHash: candHash("1"), canonicalKey: "pivot-batch-key-1" }),
      // Same key + same text as row 1 → deduped → unexpected → halt.
      makeCandidate({ candidateHash: candHash("2"), canonicalKey: "pivot-batch-key-1" }),
      makeCandidate({ candidateHash: candHash("3"), canonicalKey: "pivot-batch-key-3" }),
    ];
    const report = await persistPivotBatch(deps as never, "test-batch-1", batch);

    expect(report.halted).toBe(true);
    expect(report.haltReason).toContain("deduped");
    expect(report.outcomes.length).toBe(2);
    expect(report.written).toBe(1);
    // Third candidate must never have been attempted.
    expect(storedEntries.length).toBe(1);
  });

  it("halts before writing when a candidate claims a different batchId", async () => {
    const { deps, storedEntries } = createDeps();
    const report = await persistPivotBatch(deps as never, "test-batch-1", [
      makeCandidate({ batchId: "other-batch" }),
    ]);

    expect(report.halted).toBe(true);
    expect(report.haltReason).toContain("other-batch");
    expect(report.outcomes.length).toBe(0);
    expect(storedEntries.length).toBe(0);
  });

  it("halts when post-write verification fails (store.get returns null)", async () => {
    const { deps } = createDeps();
    const brokenDeps = {
      ...deps,
      store: {
        ...deps.store,
        async get() {
          return null;
        },
      },
    };
    const report = await persistPivotBatch(brokenDeps as never, "test-batch-1", [makeCandidate()]);

    expect(report.halted).toBe(true);
    expect(report.haltReason).toContain("verification failed");
  });
});
