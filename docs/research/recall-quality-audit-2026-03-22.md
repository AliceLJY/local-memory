# RecallNest Recall Quality Audit — 2026-03-22

## Executive Summary

This audit assessed three dimensions of RecallNest's memory quality: **ingest noise ratio**, **case/pattern recall relevance**, and **checkpoint content quality**. The system has strong retrieval-side relevance mechanisms (multi-stage scoring, reranking, noise filtering) and robust checkpoint sanitization, but suffers from weak ingest-side validation for evidence-layer data and a critical gap in case recall — 5,853 stored cases are effectively invisible due to over-aggressive filtering. The top 5 issues are ranked below with concrete fix suggestions.

---

## Top 5 Highest-Impact Quality Issues

### 1. Case Recall is Effectively Broken (CRITICAL)

**Finding**: 0 out of 5 probes returned any case results, despite 5,853 cases in the store. Vector search finds relevant cases (similarity 0.70–0.74), but the selection pipeline filters them all out.

**Root cause**: `isTaskCandidateUseful` in `src/ranking.ts:168` rejects non-structured cases (`if (category === "cases" && !structured) return false`). Most stored cases are raw transcript chunks in `cc:` scopes, not structured `Case: problem/solution` format. Additionally, `selectTaskResults` in `src/context-composer-task-selection.ts:298-300` filters non-durable candidates when durable ones exist.

**Impact**: The entire case recall subsystem provides zero value. Users who stored debugging solutions, fix recipes, or incident resolutions never see them recalled.

**Fix suggestion**:
- **File**: `src/ranking.ts` — `isTaskCandidateUseful` function (~line 168)
- **Approach**: Relax the structured-only filter for cases with high vector similarity (>0.72). Add a fallback path: if zero structured cases pass, allow top-N unstructured cases with high similarity scores through. This preserves precision for normal recall but prevents the "zero results" cliff.
- **Classification**: Quick win (localized change, testable in isolation)

### 2. Noise Filtering Only at Retrieval, Not Ingest (MODERATE-HIGH)

**Finding**: The noise filter in `src/noise-filter.ts` only runs during `hybridRetrieval()` and `vectorOnlyRetrieval()` — NOT during ingest. Noisy data (bash progress output, screenshot base64, tool-use tags, system messages, permission instructions) is stored permanently in the evidence layer. The noise occupies embedding space, dilutes vector search quality, and wastes MMR diversity budget on filtering out junk.

**Root cause**: The ingest pipeline in `src/ingest.ts` only validates on text length (> 8 chars). No content quality check, no protocol filtering, no diagnostic artifact detection. 59.2% of all 39,580 entries are category "fact" — many are low-signal transcript snippets. 84.5% are from ephemeral `cc:*` session scopes.

**Impact**: The store is bloated with low-value entries. Retrieval-side filtering is a band-aid — the noisy entries still consume storage, slow vector search, and can occasionally leak through retrieval filters into recall results.

**Fix suggestion**:
- **File**: `src/ingest.ts` — add pre-storage filtering after chunking
- **File**: `src/noise-filter.ts` — extract shared noise patterns into reusable functions
- **Approach**: Apply the existing noise filter patterns at ingest time as a hard gate. Add additional ingest-specific patterns: reject chunks under 30 chars matching boilerplate, base64-heavy content, bash progress output, and tool-use protocol tags. Score chunk information density and skip purely routine/acknowledgment content.
- **Classification**: Deeper refactor (needs heuristic set + testing against real transcripts to avoid false negatives)

### 3. Checkpoint Scope Normalization Gap (MODERATE)

**Finding**: Three different scope strings exist for the same project: `project:recallnest` (114 checkpoints), `recallnest` (24), and `project:RecallNest` (4). A `resume_context` call with one variant misses checkpoints stored under another.

**Root cause**: No scope normalization at checkpoint save time. The 24 `recallnest` checkpoints are from March 16–17 before conventions solidified. The 4 `project:RecallNest` checkpoints have a case mismatch.

**Impact**: `getLatest()` by scope can return a stale checkpoint instead of the truly latest one if the most recent was stored under a non-canonical scope string. This directly affects continuity recovery quality.

**Fix suggestion**:
- **File**: `src/session-engine.ts` — checkpoint save path
- **Approach**: Add a `normalizeScope()` function that lowercases and ensures `project:` prefix. Apply it both at save time and at query time. For historical data, run a one-time migration script to normalize existing checkpoint scopes.
- **Classification**: Quick win (small utility function + migration script)

### 4. Empty/Fallback Checkpoints Displace Useful Recovery Data (MODERATE)

**Finding**: ~44% of checkpoints (69 of 156) have sanitization artifacts. Of these, ~10% (16) have only fallback summary text ("Checkpoint captured current task state without repo-state details.") plus empty structured fields. These provide zero recovery value but can be returned by `getLatest()`, displacing useful checkpoints.

**Additional concern**: No checkpoint expiry mechanism exists. All 156 checkpoints persist indefinitely (156 files in ~6 days = ~9,500/year projected). No age-based pruning, no size limits, no archive mechanism. File-system based storage means O(n) scan on every retrieval.

**Root cause**: The checkpoint API accepts and stores checkpoints even when all meaningful fields are empty or sanitized away.

**Impact**: If a fallback-only checkpoint is the most recent for a scope, `resume_context` returns useless continuity data. Combined with no expiry, checkpoint directory will grow unbounded.

**Fix suggestion**:
- **File**: `src/session-engine.ts` — `checkpoint_session` handler
- **Approach**: (a) Add a quality gate before saving: if summary would be fallback AND decisions/openLoops/nextActions are all empty, either reject with a warning or mark as `quality: "minimal"` so `getLatest()` can prefer higher-quality alternatives. (b) Add checkpoint age check in `resume_context` — warn if > 24h old. (c) Implement expiry: archive checkpoints older than 30 days.
- **Classification**: Quick win for quality gate; medium effort for expiry

### 5. Importance Defaults Too Permissive + Weak Tier Inference (MODERATE)

**Finding**: Most ingested transcript memories get default importance 0.7 — no distinction between high-value technical insights and casual chat. Tier assignment is purely category-based (`profile`/`patterns` -> "working", everything else -> "peripheral") with no semantic quality analysis.

**Root cause**: No importance scoring at ingest time. The decay engine (`src/decay-engine.ts`) uses a 3-tier system (core/working/peripheral) with different Weibull decay curves, but tier promotion requires 3+ accesses or importance >= 0.5 (peripheral -> working) or 10+ accesses or importance >= 0.8 (working -> core). Since everything starts at 0.7 importance, most evidence-layer memories sit at "peripheral" tier forever.

**Impact**: Low-value transcript entries compete fairly with high-value durable memories in retrieval scoring. The importance weight formula `0.7 + 0.3 * importance` gives a 0.7-importance entry 91% the score of a 1.0-importance entry — barely distinguishable.

**Fix suggestion**:
- **File**: `src/ingest.ts` — post-parse stage; `src/decay-engine.ts` — tier logic
- **Approach**: Use LLM (already integrated via `smartExtractBatch` in ingest.ts:328) to assign importance during ingestion. For non-LLM path, use heuristics: code-heavy content -> importance 0.8, error resolution -> 0.85, boilerplate -> 0.3. Widen the importance multiplier range (e.g., `0.5 + 0.5 * importance`) to make it more discriminating.
- **Classification**: Deeper refactor (needs scoring model + tuning)

---

## Additional Findings

### What's Working Well

| Area | Rating | Evidence |
|---|---|---|
| Tool output filtering | Excellent | 98.7% clean — `parseCCTranscript` type filter is effective |
| Hybrid retrieval pipeline | Excellent | 8-stage scoring with RRF fusion, Weibull decay, MMR diversity |
| Checkpoint schema design | Good | Strict Zod validation, appropriate field limits, well-structured |
| Repo-state sanitizer (post-deploy) | Excellent | Zero leaks since March 18 deployment |
| Checkpoint summary quality | Good | 75% of checkpoints have rich, actionable content |
| Durable memory dedup | Good | Two-stage vector + LLM semantic dedup with canonical key matching |
| Cross-encoder reranking | Good | Jina/Pinecone/Voyage reranking available for semantic re-ranking |
| Retrieval profiles | Good | 4 task-tuned profiles (default, writing, debug, fact-check) with appropriate tuning |
| Cue coverage diversity | Good | Greedy set-cover algorithm prevents duplicate pattern recall |
| Entity capture | Good | Specific, useful entities (file paths, tool names, PR refs). 8-entity limit sufficient |

### Pattern vs Case Recall Asymmetry

Patterns recall well because they tend to be durable and structured (967 eligible entries, 2.5% of store). Cases fail because the same filtering criteria are applied but cases in the store are overwhelmingly unstructured transcript chunks. This is a design asymmetry — the system was built for curated patterns but cases accumulated organically.

### Dedup Gap When LLM Unavailable

Evidence-layer transcript ingest skips LLM semantic dedup if no embedder is available (`src/ingest.ts:817-821`) — it queues for later processing but still ingests the raw chunk with only vector dedup. When LLM is unavailable, borderline-similar chunks (similarity 0.68-0.80) are stored as separate entries, leading to near-duplicate pollution.

### Checkpoint Coverage Details

- 156 checkpoints across 94 sessions (March 16-22)
- March 21 has only 3 checkpoints vs 28-46 on other days — potential gap
- `resume_context` correctly uses checkpoint as first line of recovery with entity supplementation
- 220-char headline truncation loses detail from rich summaries, but full checkpoint is available in response body
- **No checkpoint-to-durable promotion pipeline**: High-quality checkpoint decisions never automatically become durable memories
- **Limited coverage in resume_context**: Only 3-5 lines from checkpoint extracted (<5% of max checkpoint content)

### Distillation Opportunity

23,441 "fact" entries could be periodically distilled into fewer, higher-quality durable memories. This would improve the signal-to-noise ratio of the entire store and make vector search more effective. The existing `distill_memory` tool could be leveraged for this.

---

## Quick Wins vs Deeper Refactors

### Quick Wins (1-2 days each)

1. **Relax case recall filter** — Allow high-similarity unstructured cases when zero structured cases match (`src/ranking.ts`)
2. **Scope normalization** — `normalizeScope()` at save + query time (`src/session-engine.ts`)
3. **Empty checkpoint gate** — Reject or flag checkpoints with all-fallback content (`src/session-engine.ts`)
4. **Historical data cleanup** — Re-sanitize 9 pre-guard checkpoint files (one-time script)
5. **Checkpoint staleness warning** — Warn in `resume_context` when checkpoint is >24h old (`src/context-composer.ts`)

### Deeper Refactors (1-2 weeks each)

1. **Ingest-time noise filtering** — Apply noise patterns + content quality scoring at ingest (`src/ingest.ts` + `src/noise-filter.ts`)
2. **Importance scoring at ingest** — LLM or heuristic-based importance assignment during ingestion (`src/ingest.ts`)
3. **Case promotion pipeline** — Auto-promote high-quality `cc:` cases to `memory:` scope based on structure detection and retrieval frequency
4. **Fact distillation pipeline** — Periodic batch job to consolidate 23,441 low-value fact entries into curated durable memories
5. **Checkpoint expiry and indexing** — Archive old checkpoints + migrate from filesystem scan to indexed storage
6. **Checkpoint-to-durable promotion** — Auto-promote high-quality decisions/nextActions to `events` or `cases` memory category

---

## Methodology

- **Architecture review**: Full codebase analysis of 89 source files (~19,500 LOC TypeScript) across all subsystems — ingestion, retrieval, checkpoint, conflict, workflow observation.
- **Ingest noise analysis**: Traced the parser pipeline through `src/ingest.ts`, analyzed noise filter patterns in `src/noise-filter.ts`, reviewed dedup thresholds and LLM fallback behavior. Parsed 10 real CC transcripts, classified 792 text blocks for noise type.
- **Case/pattern recall analysis**: Ran 5 `composeResumeContext` probes with different task prompts against `project:recallnest` scope. Traced the selection pipeline through `src/ranking.ts` and `src/context-composer-task-selection.ts`. Compared vector search results vs final pipeline output.
- **Checkpoint audit**: Schema analysis of `src/session-schema.ts` + `src/session-engine.ts`, then quality review of all 156 checkpoint files from March 16-22. Field-level emptiness analysis, scrubbing effectiveness verification, scope distribution analysis.
- **Retrieval pipeline audit**: Full trace through `src/retriever.ts` 8-stage scoring pipeline, `src/decay-engine.ts` Weibull decay, `src/embedder.ts` multi-provider embedding, and `src/retrieval-profiles.ts` task-tuned profiles.

---

*Report generated 2026-03-22 by recallnest-quality-8ad2b7 team (coordinator + 3 research agents)*
*Supersedes earlier draft by recallnest-quality-69722c team*
