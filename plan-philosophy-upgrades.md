# Implementation Plan: Memory Philosophy-Driven RecallNest Upgrades

> Date: 2026-04-11
> Status: Plan complete, Phase 1 ready for implementation
> Source: Memory philosophy research map + Codex code analysis + Explorer codebase audit

---

## Overview

Five upgrade phases derived from memory philosophy research, each mapped to concrete code changes in the RecallNest codebase. Phase 1 (Emotional Valence in Decay) is implementation-ready today -- the building blocks exist but are not wired into production paths. Phases 2-5 build outward from that foundation. All phases are designed to be independently mergeable and testable.

## Dependency Graph

```
Phase 1 (Emotion Decay)  <- standalone, no dependencies
Phase 2 (Ethics Layer)   <- standalone, no dependencies on Phase 1
Phase 3 (Narrative)      <- standalone, enriches Phase 4 if done first
Phase 4 (Constructive)   <- benefits from Phase 3 (narrative siblings), Phase 1 (emotion salience)
Phase 5 (Predictive)     <- benefits from Phase 4 (reconstruction surface)
```

Phases 1, 2, and 3 can run in parallel. Phase 4 benefits from all three. Phase 5 builds on Phase 4.

## Time Estimates

| Phase | Estimated Effort | Complexity |
|-------|-----------------|------------|
| Phase 1 | 3-4 hours | Low -- wiring existing code |
| Phase 2 | 2-3 days | Medium -- new forget engine + lifecycle unification |
| Phase 3 | 2-3 days | Medium -- new metadata layer + write/read points |
| Phase 4 | 3-4 days | High -- LLM pipeline changes + grounding rewrite |
| Phase 5 | 2-3 days | Medium -- new prediction engine + surface layer |
| **Total** | **~12-15 days** | |

---

## Phase 1: Emotional Valence in Decay (TODAY)

### Goal
Wire the existing emotion-adjusted decay functions (`adjustHalfLifeForEmotion`, `computeArousalBoost`) into the production retrieval and evolution scoring paths. Extend `EmotionMetadata` with `salience` and `source` fields. Recalculate emotion on text updates. Backfill emotion on import.

### Current State
- `emotion-detector.ts` -- keyword heuristic, zero LLM cost, fully tested
- `decay-engine.ts:99-119` -- `adjustHalfLifeForEmotion()` and `computeArousalBoost()` exist with tests but are NOT called from production code
- `store.ts:370` -- `detectEmotionIfEnabled()` auto-annotates on `store()`
- `retriever.ts:261` -- `applyEmotionWeight()` retrieval scoring is live
- `retriever.ts:1657` -- `applyTimeDecay()` does NOT use emotion-adjusted half-life
- `memory-evolution.ts:306` -- `computeDecayScore()` has no emotion factor
- Feature flag: `RECALLNEST_EMOTION_SCORING=true`

### Files Changed

| File | Function(s) | Change |
|------|------------|--------|
| `src/memory-schema.ts` | `EmotionMetadata`, `EmotionMetadataSchema` | Add `salience` and `source` fields |
| `src/retriever.ts` | `applyTimeDecay()` (line 1657) | Wire `adjustHalfLifeForEmotion()` into half-life computation |
| `src/memory-evolution.ts` | `computeDecayScore()` (line 306), weight constants | Add emotion salience factor, rebalance weights |
| `src/store.ts` | `update()` (line 863) | Recalculate emotion when text changes |
| `src/store.ts` | `importEntry()` (line 433) | Backfill emotion if absent |
| `src/emotion-detector.ts` | `detectEmotion()` | Compute `salience` from |valence| + arousal |
| Tests | New + updated | Emotion-decay integration, update re-detection, import backfill |

### Steps

#### 1.1 Extend EmotionMetadata schema
**File:** `src/memory-schema.ts` (lines 40-53)

- [ ] Add `salience?: number` field to `EmotionMetadata` interface (0-1 composite of |valence| + arousal)
- [ ] Add `source?: "keyword" | "llm" | "user"` field to `EmotionMetadata` interface
- [ ] Update `EmotionMetadataSchema` Zod object to include `salience: z.number().min(0).max(1).optional()` and `source: z.enum(["keyword", "llm", "user"]).optional()`
- [ ] Verify `parseEmotion()` still works with old data (no salience/source)
- **Why:** Salience is the single composite signal that decay and evolution scoring will consume. Source enables future LLM-based emotion detection without breaking keyword entries.
- **Risk:** Low -- additive optional fields, backward compatible

#### 1.2 Compute salience in detectEmotion
**File:** `src/emotion-detector.ts`, function `detectEmotion()` (line 62)

- [ ] After computing `valence` and `arousal`, compute `salience = clamp((Math.abs(valence) + arousal) / 2, 0, 1)`
- [ ] Add `salience` and `source: "keyword"` to the returned `EmotionMetadata` object
- [ ] Update `detectEmotionIfEnabled()` -- no change needed (passes through)
- **Why:** Decay engine needs a single 0-1 signal, not separate valence/arousal. Formula: average of emotional intensity and arousal, giving equal weight to "how emotional" and "how urgent."
- **Risk:** Low -- pure addition to return value

#### 1.3 Wire emotion into applyTimeDecay
**File:** `src/retriever.ts`, method `applyTimeDecay()` (line 1657)

- [ ] Import `adjustHalfLifeForEmotion` from `decay-engine.ts` and `parseEmotion` from `memory-schema.ts`
- [ ] At line 1670-1672 (after `this.accessTracker.computeEffectiveHalfLife()`), add emotion adjustment: if `isEmotionScoringEnabled()`, parse emotion from `r.entry.metadata`, call `adjustHalfLifeForEmotion(halfLife, emotion)` to get final half-life
- [ ] Guard behind `isEmotionScoringEnabled()` flag check
- [ ] The arousal boost (`computeArousalBoost()`) applies to score before decay

**Current code pattern:**
```typescript
const halfLife = this.accessTracker
  ? this.accessTracker.computeEffectiveHalfLife(baseHalfLife, r.entry.metadata)
  : baseHalfLife;
const tier = resolveTier(r.entry.metadata);
const factor = weibullDecay(ageDays, halfLife, tier);
return { ...r, score: clamp01(r.score * factor, r.score * 0.3) };
```

**Target code:**
```typescript
let halfLife = this.accessTracker
  ? this.accessTracker.computeEffectiveHalfLife(baseHalfLife, r.entry.metadata)
  : baseHalfLife;
// HP-emo: Emotion-adjusted half-life — strong emotion slows forgetting
const emotion = isEmotionScoringEnabled() ? parseEmotion(r.entry.metadata) : null;
if (emotion) {
  halfLife = adjustHalfLifeForEmotion(halfLife, emotion);
}
const tier = resolveTier(r.entry.metadata);
const factor = weibullDecay(ageDays, halfLife, tier);
const arousalFactor = emotion ? computeArousalBoost(emotion) : 1.0;
return { ...r, score: clamp01(r.score * arousalFactor * factor, r.score * 0.3) };
```

- **Why:** This is the primary gap -- emotion detection runs on write, emotion weight runs on retrieval scoring, but the decay curve itself ignores emotion. A frustrating debugging session should decay slower than a neutral log entry.
- **Risk:** Medium -- touches the core scoring pipeline. Parse emotion once per result to avoid double-parse overhead.

#### 1.4 Add emotion factor to computeDecayScore
**File:** `src/memory-evolution.ts`, function `computeDecayScore()` (line 306), constants at lines 292-295

- [ ] Import `parseEmotion`, `isEmotionScoringEnabled` from `memory-schema.ts`
- [ ] Add optional `metadata?: string` parameter to `computeDecayScore()` (backward compatible)
- [ ] When `isEmotionScoringEnabled()` and metadata is provided, extract salience
- [ ] Rebalance weights from `0.2/0.3/0.5` to `0.15/0.25/0.45/0.15`:
  ```typescript
  const EMOTION_WEIGHT = isEmotionScoringEnabled() ? 0.15 : 0;
  const TIME_W = isEmotionScoringEnabled() ? 0.15 : 0.2;
  const FREQ_W = isEmotionScoringEnabled() ? 0.25 : 0.3;
  const IMP_W = isEmotionScoringEnabled() ? 0.45 : 0.5;
  // Final: TIME_W * timeDecay + FREQ_W * frequencyScore + IMP_W * importance + EMOTION_WEIGHT * salience
  ```
- [ ] Update all callers to pass metadata where available:
  - `auto-gc.ts:142` -- pass `entry.metadata`
  - `retriever.ts:1712` (applyEvolutionDecayBlend) -- pass `r.entry.metadata`
- **Why:** The evolution decay score determines GC archival and evolution blend. Without emotion, high-emotion events get same decay as routine logs.
- **Risk:** Medium -- changes GC archival threshold behavior. Emotional memories will resist archival slightly more (desirable).

#### 1.5 Re-detect emotion on text update
**File:** `src/store.ts`, method `update()` (line 863)

- [ ] After building the `updated` entry, if `updates.text` is provided (text changed), re-run emotion detection:
  ```typescript
  if (updates.text) {
    const emotionResult = detectEmotionIfEnabled(updated.text);
    if (emotionResult) {
      const meta = JSON.parse(updated.metadata || "{}");
      meta.emotion = emotionResult;
      updated.metadata = JSON.stringify(meta);
    }
  }
  ```
- [ ] Place this BEFORE the `table!.delete` + `table!.add` at lines 918-920
- **Why:** When text is updated (e.g., supersede-with-edit), stale emotion metadata creates scoring inaccuracy.
- **Risk:** Low -- only fires when text is explicitly changed

#### 1.6 Backfill emotion on importEntry
**File:** `src/store.ts`, method `importEntry()` (line 433)

- [ ] After building `full` entry, check if emotion is already present in metadata. If not, detect and inject:
  ```typescript
  const metaParsed = JSON.parse(full.metadata || "{}");
  if (!metaParsed.emotion) {
    const emotionResult = detectEmotionIfEnabled(full.text);
    if (emotionResult) {
      metaParsed.emotion = emotionResult;
      full.metadata = JSON.stringify(metaParsed);
    }
  }
  ```
- **Why:** Imported entries may pre-date emotion detection. Backfilling ensures all entries have emotion metadata.
- **Risk:** Low -- only adds when absent, never overwrites

#### 1.7 Tests
- [ ] **emotion-decay.test.ts**: Add test that `salience` is present in `detectEmotion()` output and matches expected formula
- [ ] **emotion-decay.test.ts**: Add test that `source` field is `"keyword"` in `detectEmotion()` output
- [ ] **New: emotion-evolution-decay.test.ts**: Test `computeDecayScore` with emotion metadata yields higher score than without
- [ ] **New: emotion-evolution-decay.test.ts**: Test backward compat -- no metadata param still works
- [ ] **New: emotion-evolution-decay.test.ts**: Test weight rebalancing (weights sum to 1.0)
- [ ] **Extend retriever tests**: Two entries, same age/importance/frequency, different emotion -- emotional one scores higher after `applyTimeDecay`
- [ ] **Store tests**: Verify `update()` with text change re-detects emotion
- [ ] **Store tests**: Verify `importEntry()` backfills emotion when absent, preserves when present
- [ ] Run `bun test` -- all 1000+ tests must pass

### Verification
1. `bun test` -- full green, baseline maintained
2. Manual check: store emotional memory, retrieve at simulated t=30d, confirm higher score vs neutral
3. Check `computeDecayScore` output for emotional vs neutral with same evo params

### Risks for Phase 1
- **Double-parse overhead in applyTimeDecay**: Parse emotion once per result, pass to both functions
- **Weight rebalancing changes GC behavior**: Test with existing GC tests
- **Feature flag dependency**: All changes gated by `RECALLNEST_EMOTION_SCORING=true`. Flag off = identical to current

---

## Phase 2: Memory Ethics Layer

### Goal
Add privacy tiers, build a proper forget engine with cascade deletion, unify lifecycle state inconsistency, expose `forget_memory` MCP tool with audit logging.

### Current State
- `cascade-forget.ts:91` reads legacy `meta.state` -- inconsistent with `evolution.status`
- `consolidation-engine.ts:71-77` reads BOTH `isActiveMemory()` and `meta.state`
- `audit-log.ts` exists but lacks "forget" operation type
- `KGStore.deleteBySource()` exists at `kg-store.ts:314` but never called from forget path
- No privacy tier field exists

### Files Changed

| File | Function(s) | Change |
|------|------------|--------|
| `src/memory-schema.ts` | New types | `PrivacyTier` type + Zod schema |
| `src/forget-engine.ts` | **New file** | Full cascade forget with KG cleanup, audit, privacy checks |
| `src/audit-log.ts` | `AuditOperation` type | Add `"forget"` and `"cascade_forget"` operations |
| `src/cascade-forget.ts` | `cascadeForget()` | Migrate `meta.state` to `evolution.status` |
| `src/consolidation-engine.ts` | `isActive()` | Remove legacy `meta.state` double-check |
| `src/capture-engine.ts` | KG extraction gate | Privacy tier check before KG extraction |
| `src/mcp-server.ts` | New tool | `forget_memory` MCP tool |
| `src/store.ts` | `store()`, `StoreMemoryInput` | Accept optional `privacyTier` |
| Tests | New | forget-engine, privacy-tier, lifecycle-state tests |

### Steps

#### 2.1 Add PrivacyTier to schema
- [ ] `PrivacyTier` type: `"ephemeral" | "private" | "durable" | "shared"`
- [ ] `PrivacyTierSchema` Zod enum
- [ ] Optional `privacyTier` in `StoreMemoryInputSchema`

#### 2.2 Unify lifecycle state
- [ ] `cascade-forget.ts:91` -- replace `meta.state` with `isActiveMemory()`
- [ ] `consolidation-engine.ts:70-77` -- simplify to only `isActiveMemory()`
- [ ] Grep for any other `meta.state` reads, migrate them all

#### 2.3 Extend audit operations
- [ ] Add `"forget"` and `"cascade_forget"` to `AuditOperation` union

#### 2.4 Build forget engine (NEW: `src/forget-engine.ts`)
- [ ] `forgetMemory()`: fetch → privacy check → evidence export → KG delete → pin archive → cascade → primary delete → audit
- [ ] `forgetByScope()` for bulk scope-level forget
- [ ] Confirmation gate for `"durable"` entries

#### 2.5 Privacy tier gate in capture
- [ ] Before KG extraction, skip if `privacyTier === "ephemeral" | "private"`

#### 2.6 Register `forget_memory` MCP tool
- [ ] Schema: `{ memoryId: string, confirm: boolean, reason?: string }`
- [ ] Returns deletion summary + evidence paths

#### 2.7 Tests
- [ ] forget-engine: KG cleanup, cascade demotion, audit trail
- [ ] Privacy tier blocks without confirm
- [ ] Evidence export for high-importance memories
- [ ] Consolidation/cascade-forget regression with new `isActiveMemory()`
- [ ] `bun test` full green

### Verification
1. Store memory → extract KG → forget → verify KG triples gone
2. Audit log shows complete forget trail
3. `"ephemeral"` memory produces no KG triples

---

## Phase 3: Autobiographical Narrative Architecture

### Goal
Add orthogonal narrative metadata layer (life-period / general-event / specific-event) on top of existing 6 categories. Enable temporal grouping and narrative retrieval without disrupting category logic.

### Current State
- 6 categories hardcoded across `memory-schema.ts`, `memory-boundaries.ts`, `retriever.ts`, `context-composer.ts` -- **do not modify**
- `event-segmenter.ts:105` has `segmentEvents()`, `temporal-parser.ts:15` has date parsing

### Files Changed

| File | Function(s) | Change |
|------|------------|--------|
| `src/narrative-schema.ts` | **New file** | Narrative metadata types + Zod schemas |
| `src/narrative-tagger.ts` | **New file** | Rule-based narrative period/event assignment |
| `src/capture-engine.ts` | `buildStructuredMetadata()` | Inject narrative metadata |
| `src/ingest.ts` | `buildIngestedEntry()` | Inject narrative metadata |
| `src/retriever.ts` | New method | `expandNarrativeSiblings()` |
| `src/context-composer.ts` | Result rendering | Group by narrative period |
| `src/memory-output.ts` | Rendering | Narrative period labels |
| `src/graph-export.ts` | Graph edges | Narrative relationship edges |

### Steps
- [ ] 3.1 Define `NarrativeMetadata` interface: `lifePeriodId/Label`, `generalEventId/Label`, `specificEventId/Label`, `startAt`, `endAt`, `sequence`
- [ ] 3.2 Build rule-based narrative tagger (scope prefix, temporal clustering, keyword signals)
- [ ] 3.3 Inject narrative at write points (`capture-engine.ts:140`, `ingest.ts:662`)
- [ ] 3.4 `expandNarrativeSiblings()` in retriever: pull entries sharing same `generalEventId`
- [ ] 3.5 Rendering updates: group by `lifePeriodLabel`, narrative edges in graph export
- [ ] 3.6 Tests + `bun test` full green

---

## Phase 4: Constructive Retrieval

### Goal
Replace "top-k then summarize" with multi-source candidate expansion + grounded reconstruction. Return reconstruction as first-class object.

### Current State
- `context-reconstructor.ts:91` exists, `retriever.ts:706` `runReconstruction()` exists
- `mcp-server.ts:888` supports `reconstruct=true`
- But: only top-k summarize, `metadata._reconstruction` is hacky, `computeCoverage()` is lexical

### Steps
- [ ] 4.1 Define `ReconstructionOutput` with sources, confidence, contradictions
- [ ] 4.2 Add candidate expansion: KG neighbors + evolution chains + cluster members + narrative siblings
- [ ] 4.3 Replace lexical coverage with source-map grounding + contradiction detection
- [ ] 4.4 Return reconstruction as first-class object (remove `metadata._reconstruction` hack)
- [ ] 4.5 Update MCP rendering for new output shape
- [ ] 4.6 Pass checkpoint context (openLoops, nextActions) into reconstruction prompt
- [ ] 4.7 Tests + `bun test` full green

---

## Phase 5: Predictive Prospective Memory

### Goal
Evolve `prospective-memory.ts` from explicit reminders to include pattern-predicted suggestions. Surface behavioral insights as ephemeral predicted reminders.

### Current State
- `prospective-memory.ts` -- `setReminder()`, `checkTriggers()`, `fireReminder()` explicit only
- Behavioral signals: checkpoint openLoops, workflow observations, frequency tracker, access tracker, topic tags

### Steps
- [ ] 5.1 Extend `ProspectiveMetadata` with `source`, `confidence`, `evidence`, `lastSuggestedAt`, `acceptedAt`
- [ ] 5.2 Build `prediction-engine.ts`: collect signals, score predictions, threshold at confidence >= 0.6
- [ ] 5.3 `suggestPredictedReminders()`: deduplicate vs existing, store as ephemeral, auto-expire 7d
- [ ] 5.4 Surface in `search_memory` as separate "Suggested Reminders" section
- [ ] 5.5 Acceptance/promotion flow: repeated/accepted → promote to explicit; ignored → demote
- [ ] 5.6 Tests + `bun test` full green

---

## Global Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Feature flag proliferation | Complexity | Phase 1-2 reuse `RECALLNEST_EMOTION_SCORING`. Phase 3-5 add `RECALLNEST_NARRATIVE_MODE` and `RECALLNEST_PREDICTIVE_MEMORY` |
| Metadata JSON bloat | Storage + parse cost | Each phase adds ~100 bytes/entry. Total metadata stays under 2KB |
| Scoring formula instability | Retrieval quality regression | Every weight change gated by feature flag and tested against eval cases |
| LLM cost creep (Phase 4-5) | Token spend | Phase 1-3 zero LLM. Phase 4 reuses existing reconstruction budget. Phase 5 zero LLM (heuristic) |

---

## Success Criteria

- [ ] Phase 1: Emotional memories decay 20-30% slower than neutral memories of same age
- [ ] Phase 1: `computeDecayScore` with emotion gives higher scores for high-salience memories
- [ ] Phase 1: All existing tests pass, emotion-decay tests extended
- [ ] Phase 2: `forget_memory` MCP tool deletes entry + KG triples + cascade demotes + audit logs
- [ ] Phase 2: No more `meta.state` reads anywhere in codebase (all `evolution.status`)
- [ ] Phase 3: Ingested sessions have narrative metadata with period/event IDs
- [ ] Phase 3: Search returns narrative siblings alongside direct matches
- [ ] Phase 4: Reconstruction uses expanded candidate set (KG + evolution + cluster)
- [ ] Phase 4: Reconstruction is first-class return object, not metadata hack
- [ ] Phase 5: Predicted reminders surface from behavioral signals
- [ ] Phase 5: Predictions auto-expire and respect acceptance/rejection
- [ ] All phases: `bun test` passes with baseline maintained or increased
