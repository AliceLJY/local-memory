# Pipeline Audit: RecallNest vs UltraMemory

> Auditor: CC (Claude Code Opus 4.6)
> Date: 2026-03-28
> Reference: trihippo/UltraMemory v1.1.0-beta.10 (private)
> Target: AliceLJY/recallnest (~/recallnest)
> Method: Three-Lens Pipeline Audit (pipeline-borrower skill)

---

## Lens 1: User Lens (Daily Experience)

| Pain Point | Stage | Severity |
|---|---|---|
| No real-time capture from live conversations — must run `ingest` manually | CAPTURE | High |
| Same memory stored twice gets different UUIDs — canonical key helps but ID-level dedup missing | STORE | Medium |
| Recall results not reordered by task context — same ranking for "fix a bug" vs "write an article" | RETRIEVE | Medium |
| No one-click memory cleanup — conflict resolution is manual, no automated clustering | DECAY | Medium |
| "TS" and "TypeScript" treated as different entities in search | RETRIEVE | Low |

## Lens 2: Developer Lens (Pipeline Gaps)

### Stage 1: CAPTURE

**Gap: No heuristic pre-capture for live conversations**

- **Our code:** `capture-engine.ts:87-105` — Only accepts explicit `CaptureMemoryInput` from tool calls
- **Their solution:** `packages/core/src/auto-capture.ts:1-60` — `shouldCapture(text)` rejects greetings/noise/short text; `extractHeuristic(text)` extracts preference/identity/decision/correction signals with zero LLM calls
- **Portable?** Yes — pure regex/heuristic, no dependencies
- **Proposed fix:**
  - Create `src/capture-heuristic.ts` with `shouldCapture()` + `extractHeuristic()`
  - Hook into MCP `store_memory` tool as optional pre-filter
  - Add new MCP tool `auto_capture` for live conversation analysis
  - Estimated: ~120 LOC
  - **Priority: High** — biggest user pain point, lowest effort

### Stage 4: STORE

**Gap: Random UUIDs allow duplicate entries with different IDs**

- **Our code:** `store.ts:327` — `randomUUID()` for every new memory
- **Their solution:** `packages/core/src/utils/deterministic-id.ts:1-20` — UUID v5 from `scope + text` → same content always gets same ID
- **Portable?** Yes — single function, `uuid` package already available
- **Proposed fix:**
  - Add `deterministicId(scope, text)` to `store.ts`
  - Use for durable memories when canonical key exists; keep random UUID for evidence/ephemeral
  - Estimated: ~25 LOC
  - **Priority: High** — prevents data pollution, trivial to implement

### Stage 5: RETRIEVE

**Gap 5a: Single vector search — no multi-granularity retrieval**

- **Our code:** `store.ts:44` — Single `vector` column; `retriever.ts:350` — searches only one vector
- **Their solution:** `packages/core/src/store.ts:297-309` — 3 vector columns (vector, vector_l0, vector_l1, vector_l2) with auto-migration; `packages/core/src/retriever.ts:143-147` — weighted blend (vector:0.35, bm25:0.30, l0:0.15, l1:0.10, l2:0.10)
- **Portable?** Medium — requires LanceDB schema migration + embedding pipeline change
- **Proposed fix:**
  - Add `vector_l0`, `vector_l1`, `vector_l2` columns to LanceDB schema
  - Generate L0 (1-sentence abstract), L1 (bullet), L2 (full) at embed time
  - Blend scores in retriever with configurable weights
  - Estimated: ~200 LOC (store migration + retriever weights + embedder pipeline)
  - **Priority: Medium** — high value but high effort, RecallNest's metadata already stores l0/l1/l2 text but not as separate vectors
  - **Dependency:** Needs embedding cost analysis (3x API calls per memory)

**Gap 5b: No per-category score thresholds**

- **Our code:** `retriever.ts:59,109-121` — Single global `hardMinScore` (0.35)
- **Their solution:** `packages/core/src/retriever.ts:97-108` — `categoryScoreThresholds` map with per-category overrides
- **Portable?** Yes — optional config, backward-compatible
- **Proposed fix:**
  - Add `categoryMinScores?: Record<string, number>` to `RetrievalConfig`
  - In scoring pipeline, check category-specific threshold before global
  - Default: preferences=0.25, entities=0.30, events=0.35, cases=0.40, patterns=0.45, profile=0.25
  - Estimated: ~30 LOC
  - **Priority: Medium** — improves recall precision per category

**Gap 5c: No entity resolution in search**

- **Our code:** `query-expander.ts` — hardcoded synonym dict (~20 groups), no entity normalization
- **Their solution:** `packages/core/src/entity-resolver.ts:1-62` — `EntityResolver` class with builtin + user aliases, resolves TS→typescript, React.js→react, DB aliases
- **Portable?** Yes — pure mapping logic
- **Proposed fix:**
  - Create `src/entity-resolver.ts` with tech entity mappings
  - Hook into `query-expander.ts` before synonym expansion
  - Also normalize entities at capture time (before canonical key generation)
  - Estimated: ~80 LOC
  - **Priority: Low** — nice-to-have, query-expander partially covers this

### Stage 6: INJECT

**Gap: No contextual reordering of recall results**

- **Our code:** `context-composer.ts:41-100` — scope-based prioritization only; `retriever.ts:346` — returns results in score order
- **Their solution:** `packages/core/src/context-renderer.ts:1-98` — `renderMemories()` reorders by 60% vector score + 40% term overlap, with task context awareness
- **Portable?** Yes — pure function, no dependencies
- **Proposed fix:**
  - Create `src/context-renderer.ts` with `renderMemories()`
  - Hook into `context-composer.ts` after retrieval, before budget cutting
  - Also hook into `search_memory` tool result formatting
  - Estimated: ~100 LOC
  - **Priority: Medium** — improves relevance of injected context

### Stage 7: DECAY

**Gap: No automated semantic consolidation**

- **Our code:** `memory-health-rebalance.ts:145-197` — tier rebalancing only; `conflict-engine.ts` — passive conflict detection on write
- **Their solution:** `packages/core/src/consolidation-engine.ts:1-388` — `ConsolidationEngine.run(scope)` scans all entries, clusters by vector similarity (>0.82), merges near-duplicates (>0.92), detects contradictions, adds relation links
- **Portable?** Medium — needs store's vectorSearch API; RecallNest already has it
- **Proposed fix:**
  - Create `src/consolidation-engine.ts` adapting UltraMemory's approach
  - Reuse RecallNest's `store.vectorSearch()` and `cosineSimilarity()`
  - Add MCP tool `consolidate_memories` (scope, threshold params)
  - Integrate with existing `conflict-engine.ts` for conflict creation
  - Estimated: ~250 LOC
  - **Priority: Medium** — automates manual cleanup; high value at scale

## Lens 3: Evidence Table

| Feature | RecallNest | UltraMemory | Status |
|---|---|---|---|
| Hybrid retrieval (vector + BM25 + RRF) | `retriever.ts:350` | `retriever.ts:250` | **both have** |
| Cross-encoder reranking | `retriever.ts:400+` (Jina/Voyage/Pinecone/vLLM) | `retriever.ts:500+` (Jina) | **our advantage** (more providers) |
| Weibull decay + tier system | `decay-engine.ts:145-159` (β per tier) | `decay-engine.ts:111` (retention presets) | **our advantage** (more sophisticated) |
| Conflict detection + lifecycle | `conflict-engine.ts` + `conflict-store.ts` + `conflict-lifecycle.ts` | `conflict-detector.ts` (detect only, no lifecycle) | **our advantage** |
| Canonical key dedup | `memory-boundaries.ts:125-148` | None | **our advantage** |
| Workflow observation | `workflow-observation-engine.ts` (7 files) | None | **our advantage** |
| Checkpoint sanitization | `session-engine.ts` (strips repo state) | None | **our advantage** |
| Retrieval profiles (4 presets) | `retrieval-profiles.ts` (writing/debug/fact-check/default) | None (single config) | **our advantage** |
| Provenance chain (20 levels) | `memory-boundaries.ts` (provenanceHistory) | None | **our advantage** |
| MCP tool tier control | `mcp-server.ts` (core/advanced/full) | None (all exposed) | **our advantage** |
| Multi-vector L0/L1/L2 embedding | Metadata storage only (`mcp-server.ts:1083`) | Full pipeline (`store.ts:297`, `retriever.ts:143`) | **their advantage** |
| Auto-capture heuristic | None | `auto-capture.ts:1-60` (zero LLM) | **their advantage** |
| Semantic consolidation | Rebalancing only (`memory-health-rebalance.ts`) | Full engine (`consolidation-engine.ts:1-388`) | **their advantage** |
| Context renderer | Scope-based only (`context-composer.ts`) | Intent-based (`context-renderer.ts:1-98`) | **their advantage** |
| Deterministic IDs | Random UUID (`store.ts:327`) | UUID v5 (`deterministic-id.ts`) | **their advantage** |
| Entity resolver | None | `entity-resolver.ts:1-62` | **their advantage** |
| Per-category score thresholds | Profile-based only (`retrieval-profiles.ts`) | Category-based (`retriever.ts:97-108`) | **their advantage** |

**Score: RecallNest 10 advantages, UltraMemory 7 advantages.** RecallNest's strengths are in governance/lifecycle; UltraMemory's are in retrieval precision.

---

## Phase 4: Implementation Plan

### Phase 1 (No deps, can start immediately)

| # | Gap | File | LOC | Priority |
|---|---|---|---|---|
| 1 | Auto-capture heuristic | new `capture-heuristic.ts` | ~120 | **High** |
| 2 | Deterministic IDs | `store.ts:327` | ~25 | **High** |
| 3 | Per-category score thresholds | `retriever.ts:59` | ~30 | Medium |

### Phase 2 (Depends on Phase 1)

| # | Gap | File | LOC | Priority |
|---|---|---|---|---|
| 4 | Entity resolver | new `entity-resolver.ts` → hooks into capture + query | ~80 | Low |
| 5 | Context renderer | new `context-renderer.ts` → hooks into composer | ~100 | Medium |

### Phase 3 (Depends on vectorSearch stability)

| # | Gap | File | LOC | Priority |
|---|---|---|---|---|
| 6 | Consolidation engine | new `consolidation-engine.ts` + MCP tool | ~250 | Medium |
| 7 | Multi-vector L0/L1/L2 | `store.ts` + `retriever.ts` + `embedder.ts` | ~200 | Medium |

### Total estimated: ~805 LOC across 7 proposals

**Recommended order:** 1 → 2 → 3 → 5 → 6 → 4 → 7

Rationale: Start with biggest pain point (auto-capture) and easiest win (deterministic IDs). Multi-vector last because it's highest effort and needs embedding cost analysis (3x API calls).

---

*Pipeline audit complete. Methodology: Three-Lens (User/Developer/Evidence).*
*Key lesson applied: Be Team B (pipeline gaps), not Team A (feature envy).*
