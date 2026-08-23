/**
 * Verbatim self-recall: can a memory be found using words copied out of its own body?
 *
 * ## Where this came from
 *
 * On 2026-08-13 a window tried to correct a stored case (`4cb4853e`) and could not reach
 * it. `explain_memory` was called twice, eleven recall slots in total, with queries taken
 * verbatim from that case's own text. The target came back zero times. Ranking first in
 * the same result sets were two short, frequently-read `session_distill` entries.
 *
 * The correction was abandoned rather than guessed at — writing without the canonical key
 * would have produced a second, parallel memory instead of a revision. So the failure was
 * recorded as an anecdote and nothing more. This file is that anecdote turned into
 * something that can be run.
 *
 * ## What the reproduction shows
 *
 * The fixture below is the shape that failed: one long, older, never-read `cases` entry
 * competing against a dozen short, recent, frequently-read ones, with the long entry
 * holding by far the best raw content score because the query is lifted from its text.
 *
 * Measured against the production `DEFAULT_RETRIEVAL_CONFIG`:
 *
 *   raw vector score    target 0.920   distractors 0.565–0.620
 *   after the chain     target 0.469   distractors 0.47–0.71, target ranked 13 of 13
 *
 * The important detail — and it corrects the looser "the threshold cuts candidates down
 * to single digits" reading this was first filed under — is that **nothing filters the
 * target out**. Stage counts show `hard_min_score`, `layer_admission` and `noise_filter`
 * each dropping zero rows; 0.469 clears `hardMinScore` 0.35 comfortably. The entry is
 * admitted and then ranked last, so at any realistic `limit` it is simply never seen.
 *
 * The demotion is cumulative rather than attributable to one stage: importance weight,
 * length normalisation, time decay and the hotness/frequency boosts each move a long,
 * old, unread entry down and a short, fresh, popular one up. An ablation confirmed no
 * single one of them is decisive — restoring any one factor on its own still leaves the
 * target outside the top 5.
 *
 * ## Why these tests assert the failure instead of the fix
 *
 * Repairing the ranking chain is a design-level change that is deliberately out of scope
 * here: it needs a shadow run and a per-row account of what drops out, and the candidate
 * pool widening people reach for first was already measured and rejected
 * (`rejected-recall-widen-candidate-pool`, 2026-08-22). So this is a characterisation
 * test. It pins the current behaviour precisely enough that any change to the chain has
 * to come past it, and it states the property that ought to hold.
 *
 * **If a test in the second block starts failing, that is very likely good news.** It
 * means self-recall improved. Re-read the numbers, then move the assertion into the first
 * block as a real invariant.
 */

import { describe, expect, it } from "bun:test";

import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../retriever.js";
import { TraceCollector } from "../retrieval-trace.js";

const DAY_MS = 86_400_000;

/** One paragraph of the kind of long case entry that failed — repeated to realistic length. */
const CASE_PARAGRAPH =
  "冷启动抑制已证伪：hotness 改成 bonus-only 之后，阈值风险队列从 52.25% 降到 33.12%。" +
  "互审拦下三处过度断言，shadow 报告的口径与生产分类器不一致。";

const TARGET_TEXT = CASE_PARAGRAPH.repeat(10);
const TARGET_ID = "4cb4853e-0000-0000-0000-000000000000";

/** Lifted word-for-word out of TARGET_TEXT — this is what "its own phrasing" means. */
const VERBATIM_QUERY = "冷启动抑制已证伪 阈值风险队列 互审拦下三处过度断言 shadow 报告";

const DISTRACTOR_COUNT = 12;

function buildFixture() {
  const now = Date.now();

  // The target: long, two months old, never read. Best possible content match.
  const target = {
    id: TARGET_ID,
    text: TARGET_TEXT,
    vector: [1, 0, 0],
    category: "cases",
    scope: "memory",
    importance: 0.75,
    timestamp: now - 60 * DAY_MS,
    metadata: JSON.stringify({
      evolution: {
        status: "active",
        version: 1,
        accessCount: 0,
        lastAccessedAt: null,
        validFrom: now - 60 * DAY_MS,
        validUntil: null,
      },
      boundary: { layer: "durable", authority: "structured-memory", conflictPolicy: "latest-wins" },
    }),
  };

  // The distractors: short, fresh, heavily read. Weak content match on this query.
  const distractors = Array.from({ length: DISTRACTOR_COUNT }, (_, i) => ({
    id: `dddddddd-${String(i).padStart(4, "0")}-0000-0000-000000000000`,
    text: `会话提炼片段 ${i}：确认了一个与检索质量相关的方向。`,
    vector: [1, 0, 0],
    category: "events",
    scope: "memory",
    importance: 0.9,
    timestamp: now - 2 * DAY_MS,
    metadata: JSON.stringify({
      evolution: {
        status: "active",
        version: 1,
        accessCount: 40,
        lastAccessedAt: now - DAY_MS,
        validFrom: now - 2 * DAY_MS,
        validUntil: null,
      },
      boundary: { layer: "durable", authority: "structured-memory", conflictPolicy: "latest-wins" },
    }),
  }));

  return [
    { entry: target, score: 0.92 },
    ...distractors.map((entry, i) => ({ entry, score: 0.62 - i * 0.005 })),
  ];
}

function buildRetriever(candidates: ReturnType<typeof buildFixture>) {
  return createRetriever(
    {
      hasFtsSupport: false,
      async vectorSearch() {
        return candidates;
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
    // Production defaults, minus the reranker (it needs a vendor key and a network call).
    { ...DEFAULT_RETRIEVAL_CONFIG, rerank: "none" as const },
  );
}

async function retrieveWithTrace(limit: number) {
  const candidates = buildFixture();
  const retriever = buildRetriever(candidates);
  const trace = new TraceCollector();
  const results = await retriever.retrieve({
    query: VERBATIM_QUERY,
    scopeFilter: ["memory"],
    limit,
    trace,
  });
  return { results, stages: trace.finalize(VERBATIM_QUERY, "vector").stages };
}

// ---------------------------------------------------------------------------
// Invariants — these must keep holding.
// ---------------------------------------------------------------------------

describe("verbatim self-recall: what the fixture guarantees", () => {
  it("gives the target the strictly best raw content score", () => {
    // Guards the premise. If the fixture ever stops modelling "the query matches this one
    // best", the tests below would be measuring something else entirely.
    const candidates = buildFixture();
    const target = candidates.find((c) => c.entry.id === TARGET_ID);
    const best = Math.max(...candidates.filter((c) => c.entry.id !== TARGET_ID).map((c) => c.score));

    expect(target?.score).toBe(0.92);
    expect(target!.score).toBeGreaterThan(best);
  });

  it("admits the target through every gate — it is not filtered out", async () => {
    const { stages } = await retrieveWithTrace(DISTRACTOR_COUNT + 1);

    // This is the part that must never regress into an actual filter. Losing a
    // verbatim-matching memory to a ranking is bad; dropping it at a threshold would be
    // worse, and would need a different fix.
    for (const name of ["hard_min_score", "noise_filter"]) {
      const stage = stages.find((s) => s.name === name);
      expect(stage, `stage ${name} missing from trace`).toBeDefined();
      expect(stage?.droppedCount, `stage ${name} dropped rows`).toBe(0);
    }

    // `layer_admission` is env-gated: applyLayerAdmission returns before touching the
    // trace when RECALLNEST_LAYER_ADMISSION is off, which is the default. Asserting it
    // unconditionally would only be asserting the developer's local .env — so check it
    // when it ran, and rely on the whole-result assertion below when it did not.
    const admission = stages.find((s) => s.name === "layer_admission");
    if (admission) expect(admission.droppedCount, "layer admission dropped rows").toBe(0);
  });

  it("returns every candidate — nothing is removed on the way through", async () => {
    // The environment-independent form of the claim above: whatever stages ran, the
    // result set still holds all of them, so no gate removed the target.
    const { results } = await retrieveWithTrace(DISTRACTOR_COUNT + 1);

    expect(results).toHaveLength(DISTRACTOR_COUNT + 1);
    expect(results.some((r) => r.entry.id === TARGET_ID)).toBe(true);
  });

  it("keeps the target's final score above the hard minimum", async () => {
    const { results } = await retrieveWithTrace(DISTRACTOR_COUNT + 1);
    const target = results.find((r) => r.entry.id === TARGET_ID);

    expect(target).toBeDefined();
    expect(target!.score).toBeGreaterThan(DEFAULT_RETRIEVAL_CONFIG.hardMinScore);
  });
});

// ---------------------------------------------------------------------------
// The defect — currently reproduced. A failure here probably means it got better.
// ---------------------------------------------------------------------------

describe("verbatim self-recall: the reported failure, reproduced", () => {
  it("does not return the target in a default-sized result window", async () => {
    // The original report in one line: eleven recall slots across two calls, queries taken
    // from the entry's own text, target never returned.
    const { results } = await retrieveWithTrace(5);

    expect(results.some((r) => r.entry.id === TARGET_ID)).toBe(false);
  });

  it("still does not return it when the window is doubled", async () => {
    // Widening the window is the obvious first reflex, so it is worth recording that it
    // does not work here either — the entry is last, not marginal.
    const { results } = await retrieveWithTrace(10);

    expect(results.some((r) => r.entry.id === TARGET_ID)).toBe(false);
  });

  it("ranks the best content match last once every candidate is returned", async () => {
    const { results } = await retrieveWithTrace(DISTRACTOR_COUNT + 1);
    const rank = results.findIndex((r) => r.entry.id === TARGET_ID);

    expect(results).toHaveLength(DISTRACTOR_COUNT + 1);
    // Went in first by a wide margin, comes out last: a complete inversion of the
    // content signal by the weighting stages that follow it.
    expect(rank).toBe(DISTRACTOR_COUNT);
  });

  it("shows the inversion is cumulative, not caused by one stage", async () => {
    // Ablation summary: restoring any single disadvantage on its own — importance,
    // recency, length, access count — still leaves the target out of the top 5. Recorded
    // here so nobody re-runs the search for a single culprit.
    const candidates = buildFixture();
    const now = Date.now();

    const variants: Array<[string, () => typeof candidates]> = [
      ["importance raised to match", () =>
        candidates.map((c) => c.entry.id === TARGET_ID
          ? { ...c, entry: { ...c.entry, importance: 0.9 } }
          : c)],
      ["age reduced to match", () =>
        candidates.map((c) => c.entry.id === TARGET_ID
          ? { ...c, entry: { ...c.entry, timestamp: now - 2 * DAY_MS } }
          : c)],
      ["text shortened", () =>
        candidates.map((c) => c.entry.id === TARGET_ID
          ? { ...c, entry: { ...c.entry, text: CASE_PARAGRAPH } }
          : c)],
    ];

    for (const [label, build] of variants) {
      const results = await buildRetriever(build()).retrieve({
        query: VERBATIM_QUERY,
        scopeFilter: ["memory"],
        limit: 5,
      });
      expect(
        results.some((r) => r.entry.id === TARGET_ID),
        `${label}: target unexpectedly recalled — the ablation result changed`,
      ).toBe(false);
    }
  });
});
