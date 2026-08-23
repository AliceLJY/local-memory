import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyUtilityToMeta,
  computeMemoryUtility,
  formatMemoryUtility,
  JOIN_WEIGHT,
  linkMemoryToObservations,
  OUTCOME_REWARD,
  readUtility,
  summarizeMemoryOutcomes,
  UTILITY_FIELD,
} from "../memory-utility.js";
import { buildWorkflowObservationRecord } from "../workflow-observation-engine.js";
import { WorkflowObservationStore } from "../workflow-observation-store.js";
import {
  PROCESS_READER_ID,
  RECALLED_IDS_CAP,
  recallLedgerSize,
  recentRecallHits,
  recordRecallHits,
  resetRecallLedger,
} from "../recall-ledger.js";
import { AccessTracker } from "../access-tracker.js";
import { isDecayExempt, resolveTier } from "../decay-engine.js";

const MEM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const MEM_B = "bbbbbbbb-0000-4000-8000-000000000002";

function obs(overrides: Record<string, unknown>) {
  return buildWorkflowObservationRecord({
    workflowId: "resume_context",
    summary: "test observation",
    ...overrides,
  });
}

describe("recall ledger (P0 join key)", () => {
  beforeEach(() => resetRecallLedger());

  it("records hits and returns them newest-first within the window", () => {
    const t0 = 1_000_000;
    recordRecallHits([MEM_A], t0);
    recordRecallHits([MEM_B], t0 + 1000);
    expect(recentRecallHits(60_000, 10, t0 + 2000)).toEqual([MEM_B, MEM_A]);
  });

  it("drops hits older than the window", () => {
    const t0 = 1_000_000;
    recordRecallHits([MEM_A], t0);
    recordRecallHits([MEM_B], t0 + 60 * 60_000);
    expect(recentRecallHits(30 * 60_000, 10, t0 + 60 * 60_000)).toEqual([MEM_B]);
  });

  it("caps the returned list", () => {
    const ids = Array.from({ length: RECALLED_IDS_CAP + 20 }, (_, i) => `id-${i}`);
    recordRecallHits(ids, 5_000);
    expect(recentRecallHits(60_000, RECALLED_IDS_CAP, 5_000).length).toBe(RECALLED_IDS_CAP);
  });

  it("gives every AccessTracker the same process-level reader id", () => {
    // 回归防线：readerId 曾是 per-instance 随机的，而 components 按 profile 缓存 —— 同一个
    // 会话开两个 profile 就伪造出两个 reader，join 直接失效。
    const fakeStore = {} as never;
    expect(new AccessTracker(fakeStore).readerId).toBe(PROCESS_READER_ID);
    expect(new AccessTracker(fakeStore).readerId).toBe(new AccessTracker(fakeStore).readerId);
    expect(new AccessTracker(fakeStore, undefined, "r-explicit").readerId).toBe("r-explicit");
  });

  it("records into the ledger before the novelty/cooldown gate", () => {
    // 高相似度 + 严格 novelty 闸：强化会被挡下，但 agent 确实看到了这条 —— 账本必须记。
    const fakeStore = {} as never;
    const tracker = new AccessTracker(fakeStore, {
      flushIntervalMs: 5000,
      reinforcementFactor: 0.5,
      maxMultiplier: 3,
      accessFreshnessHalfLifeDays: 30,
      noveltyThreshold: 0.9,
      cooldownMs: 0,
    });
    tracker.recordAccess([MEM_A], [0.99]);
    expect(tracker.pendingCount).toBe(0);
    expect(recentRecallHits()).toContain(MEM_A);
    tracker.destroy();
  });
});

describe("memory ↔ observation join", () => {
  it("joins exactly when the observation names the memory", () => {
    const links = linkMemoryToObservations(MEM_A, "{}", [
      obs({ recalledIds: [MEM_A, MEM_B], outcome: "success" }),
      obs({ recalledIds: [MEM_B], outcome: "failure" }),
    ]);
    expect(links.length).toBe(1);
    expect(links[0].join).toBe("exact");
  });

  it("falls back to session join through readerId ∩ metadata.readerIds", () => {
    const meta = JSON.stringify({ readerIds: ["r-1234abcd"] });
    const links = linkMemoryToObservations(MEM_A, meta, [
      obs({ readerId: "r-1234abcd", outcome: "corrected" }),
      obs({ readerId: "r-otherxx", outcome: "failure" }),
    ]);
    expect(links.length).toBe(1);
    expect(links[0].join).toBe("session");
    expect(links[0].outcome).toBe("corrected");
  });

  it("prefers exact over session for the same observation", () => {
    const meta = JSON.stringify({ readerIds: ["r-1234abcd"] });
    const links = linkMemoryToObservations(MEM_A, meta, [
      obs({ readerId: "r-1234abcd", recalledIds: [MEM_A], outcome: "success" }),
    ]);
    expect(links.length).toBe(1);
    expect(links[0].join).toBe("exact");
  });

  it("returns nothing when neither key is present (the pre-P0 state)", () => {
    expect(linkMemoryToObservations(MEM_A, "{}", [obs({ outcome: "success" })])).toEqual([]);
  });
});

describe("utility computation", () => {
  const now = Date.parse("2026-08-23T00:00:00.000Z");
  const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();

  it("answers 「这条 memory 参与过的任务成功率是多少」", () => {
    const summary = summarizeMemoryOutcomes(MEM_A, [
      { observationId: "o1", workflowId: "w", outcome: "success", recordedAt: at(1), join: "exact", summary: "" },
      { observationId: "o2", workflowId: "w", outcome: "success", recordedAt: at(2), join: "exact", summary: "" },
      { observationId: "o3", workflowId: "w", outcome: "failure", recordedAt: at(3), join: "exact", summary: "" },
    ], now);
    expect(summary.total).toBe(3);
    expect(summary.successRate).toBeCloseTo(2 / 3, 5);
    expect(summary.exactSuccessRate).toBeCloseTo(2 / 3, 5);
  });

  it("goes negative when the tasks mostly failed — importance could never hold this", () => {
    const summary = summarizeMemoryOutcomes(MEM_A, [
      { observationId: "o1", workflowId: "w", outcome: "failure", recordedAt: at(0), join: "exact", summary: "" },
      { observationId: "o2", workflowId: "w", outcome: "failure", recordedAt: at(1), join: "exact", summary: "" },
      { observationId: "o3", workflowId: "w", outcome: "missed", recordedAt: at(2), join: "exact", summary: "" },
    ], now);
    expect(summary.utility).not.toBeNull();
    expect(summary.utility!).toBeLessThan(0);
  });

  it("weights session joins below exact ones", () => {
    const exact = summarizeMemoryOutcomes(MEM_A, [
      { observationId: "o1", workflowId: "w", outcome: "success", recordedAt: at(0), join: "exact", summary: "" },
    ], now);
    const session = summarizeMemoryOutcomes(MEM_A, [
      { observationId: "o1", workflowId: "w", outcome: "success", recordedAt: at(0), join: "session", summary: "" },
    ], now);
    expect(exact.effectiveSamples).toBeCloseTo(JOIN_WEIGHT.exact, 5);
    expect(session.effectiveSamples).toBeCloseTo(JOIN_WEIGHT.session, 5);
    // 同一个 outcome，加权平均的值一样，可信度不同 —— 差别落在 effectiveSamples 上。
    expect(exact.utility).toBeCloseTo(OUTCOME_REWARD.success, 5);
  });

  it("decays old outcomes by the 30-day half-life", () => {
    const fresh = summarizeMemoryOutcomes(MEM_A, [
      { observationId: "o1", workflowId: "w", outcome: "success", recordedAt: at(0), join: "exact", summary: "" },
    ], now);
    const old = summarizeMemoryOutcomes(MEM_A, [
      { observationId: "o1", workflowId: "w", outcome: "success", recordedAt: at(30), join: "exact", summary: "" },
    ], now);
    expect(old.effectiveSamples).toBeCloseTo(fresh.effectiveSamples * 0.5, 3);
  });

  it("ignores session-join noise once exact samples exist", () => {
    // 2026-08-23 落地当天的实测：同一会话跑多个任务时，readerId join 会把无关任务的
    // 成败摊到每条被读过的记忆上——那次 5 条记忆的会话级成功率全是 44%（常数，零信息），
    // 精确成功率却是 100%/33%/0%。所以有精确样本时不掺会话级。
    const links = [
      { observationId: "e1", workflowId: "w", outcome: "success" as const, recordedAt: at(0), join: "exact" as const, summary: "" },
      { observationId: "e2", workflowId: "w", outcome: "success" as const, recordedAt: at(0), join: "exact" as const, summary: "" },
      { observationId: "s1", workflowId: "w", outcome: "failure" as const, recordedAt: at(0), join: "session" as const, summary: "" },
      { observationId: "s2", workflowId: "w", outcome: "failure" as const, recordedAt: at(0), join: "session" as const, summary: "" },
    ];
    const preferred = summarizeMemoryOutcomes(MEM_A, links, now);
    expect(preferred.utilityBasis).toBe("exact");
    expect(preferred.utility).toBeCloseTo(OUTCOME_REWARD.success, 5);

    const mixed = summarizeMemoryOutcomes(MEM_A, links, now, { preferExact: false });
    expect(mixed.utility!).toBeLessThan(preferred.utility!);
  });

  it("falls back to session join when nothing named this memory", () => {
    const links = Array.from({ length: 4 }, (_, i) => ({
      observationId: `s${i}`, workflowId: "w", outcome: "success" as const,
      recordedAt: at(0), join: "session" as const, summary: "",
    }));
    const summary = summarizeMemoryOutcomes(MEM_A, links, now);
    expect(summary.utilityBasis).toBe("session");
    expect(summary.utility).toBeCloseTo(OUTCOME_REWARD.success, 5);
  });

  it("returns null (not 0) when there is no evidence", () => {
    const summary = summarizeMemoryOutcomes(MEM_A, [], now);
    expect(summary.utility).toBeNull();
    expect(summary.successRate).toBeNull();
    expect(summary.utilityBasis).toBe("none");
  });
});

describe("utility metadata write-back", () => {
  it("writes utility without touching importance-derived behaviour", () => {
    const summary = summarizeMemoryOutcomes(MEM_A, [
      { observationId: "o1", workflowId: "w", outcome: "failure", recordedAt: new Date().toISOString(), join: "exact", summary: "" },
    ]);
    const before = { tier: "peripheral", accessCount: 2 };
    const after = applyUtilityToMeta(before, summary);
    expect(after[UTILITY_FIELD]).toBeLessThan(0);
    // 硬约束：utility 不进 tier、不进 decay 豁免。
    expect(resolveTier(JSON.stringify(after), 0.7)).toBe(resolveTier(JSON.stringify(before), 0.7));
    expect(isDecayExempt(JSON.stringify(after), 0.7, "cases"))
      .toBe(isDecayExempt(JSON.stringify(before), 0.7, "cases"));
    expect((after as Record<string, unknown>).importance).toBeUndefined();
  });

  it("clears utility instead of writing 0 when the evidence is gone", () => {
    const meta = { utility: -0.5, utilitySamples: 1, utilityUpdatedAt: 1 };
    const cleared = applyUtilityToMeta(meta, summarizeMemoryOutcomes(MEM_A, []));
    expect(UTILITY_FIELD in cleared).toBe(false);
    expect(readUtility(JSON.stringify(cleared))).toBeNull();
  });
});

describe("end-to-end through the observation store", () => {
  it("round-trips join keys and answers the success-rate query", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-utility-obs-"));
    const store = new WorkflowObservationStore(dir);
    await store.save(obs({ recalledIds: [MEM_A], outcome: "success", readerId: "r-sess0001" }));
    await store.save(obs({ recalledIds: [MEM_A], outcome: "failure", readerId: "r-sess0001", workflowId: "checkpoint_session" }));
    await store.save(obs({ recalledIds: [MEM_B], outcome: "success", readerId: "r-sess0001" }));

    const records = await store.listRecent({ limit: 100 });
    const summary = computeMemoryUtility({ id: MEM_A, metadata: "{}" }, records);
    expect(summary.total).toBe(2);
    expect(summary.successRate).toBeCloseTo(0.5, 5);
    expect(formatMemoryUtility(summary, { showLinks: 2 })).toContain("成功率");
  });

  it("still parses observations written before the join-key fields existed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recallnest-utility-legacy-"));
    const store = new WorkflowObservationStore(dir);
    const legacy = obs({ outcome: "success" });
    expect((legacy as Record<string, unknown>).recalledIds).toBeUndefined();
    await store.save(legacy);
    expect((await store.listRecent({ limit: 10 })).length).toBe(1);
  });
});
