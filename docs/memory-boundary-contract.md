# Memory Boundary Contract

> RecallNest 先解决“谁能写什么、谁说了算”，再继续堆功能。没有边界的记忆系统，只会把更多垃圾写进库里。

## Why This Exists

The same fact should not be authored by every memory path.

RecallNest now distinguishes between:

- `canonical`: stable facts maintained in curated docs outside the raw memory index
- `durable`: reusable structured memory that RecallNest is allowed to recall across windows
- `session`: current task state captured by `checkpoint_session`
- `evidence`: raw transcripts and unstructured ingest that are useful as hints, but not authority

The core rule is:

**One fact may have multiple mirrors, but only one authority write path.**

---

## The Four Layers

| Layer | What it stores | Authority write path | Can be mirrored into LanceDB? | Conflict policy |
|-------|----------------|----------------------|-------------------------------|-----------------|
| `canonical` | Stable identity, user profile, long-lived project rules | Curated docs such as `USER.md`, `PROJECT.md`, hand-maintained notes | Yes, as read-only mirrors | Manual review / canonical wins |
| `durable` | Reusable `profile`, `preferences`, `entities`, `cases`, `patterns`, `events` | Structured writes such as `store_memory`, `store_case`, `store_workflow_pattern` | Yes | Category-specific: merge or append |
| `session` | Current objective, summary, decisions, open loops, next actions | `checkpoint_session` | No, not as durable memory | Latest checkpoint wins |
| `evidence` | Raw transcripts, loose snippets, import artifacts, candidate facts | `ingest.ts` and other unstructured importers | Already stored in the main index, but treated as low-trust evidence | Never overrides higher layers |

---

## Authority Rules

### 1. Structured memory creates durable authority

These write paths are allowed to author durable memory:

- `store_memory`
- `store_case`
- `store_workflow_pattern`
- `POST /v1/store`
- `POST /v1/case`
- `POST /v1/pattern`
- `POST /v1/capture`

They write metadata with:

- `boundary.layer = "durable"`
- `boundary.authority = "structured-memory"`

### 2. Session state stays in the checkpoint store

`checkpoint_session` is the authority for current task state. It must not be treated as durable memory.

That means:

- session summaries do not go back into the durable memory index automatically
- `resume_context` may read the latest checkpoint
- durable memory and checkpoints are combined at read time, not merged into one store

### 3. Transcript ingest is evidence, not authority

Raw conversations from:

- Claude Code
- Codex
- Gemini CLI

are useful, but they are not allowed to mint authoritative stable facts.

Current enforcement:

- transcript-derived `profile` and `preferences` are downgraded to stored `events`
- transcript-derived records are marked with `boundary.layer = "evidence"`
- `resume_context` does not use transcript/evidence records as stable context
- evidence only becomes durable through explicit structured write or `promote_memory`

### 4. Durable beats evidence at read time

When RecallNest composes startup context:

- `canonical` beats `durable`
- `durable` beats `evidence`
- `session` is composed alongside them, not flattened into durable memory

If durable `cases` or `patterns` exist, they should be preferred over raw transcript fragments.

---

## Category Ownership

| Category | Preferred authority | Evidence mirror allowed? | Notes |
|----------|---------------------|--------------------------|-------|
| `profile` | curated docs or structured `store_memory` | Yes | Raw transcript profile statements are not authoritative |
| `preferences` | curated docs or structured `store_memory` | Yes | Raw preference chatter is especially easy to overfit |
| `entities` | structured memory or curated docs | Yes | Mentions in transcripts are hints, not stable truth |
| `events` | structured memory or ingest | Yes | Safe append-only history bucket |
| `cases` | `store_case` | Yes | Transcript debug stories can exist as evidence, but durable cases should be explicit |
| `patterns` | `store_workflow_pattern` or structured `store_memory` | Yes | Reusable workflows should be promoted deliberately |

---

## Conflict Policy

| Category type | Policy |
|---------------|--------|
| `profile`, `preferences`, `entities`, `patterns` | `latest-wins` within the same authority layer |
| `events`, `cases` | `append-only` |
| cross-layer conflicts | Higher-authority layer wins; lower layer stays as evidence |

Cross-layer conflicts must not silently overwrite higher-authority data.

Current implementation detail:

- if an evidence promotion targets a `latest-wins` durable category and the same `canonicalKey` already exists with different text, RecallNest creates an open conflict candidate instead of silently overwriting the durable record
- narrow exception: if the occupied durable memory and the incoming promotion resolve to the same atomic preference slot (currently brand-item preferences such as `preferences:brand-item:<brand>:<item>`), RecallNest collapses the promotion onto the existing durable owner instead of opening a conflict
- if a durable write reuses an existing `canonicalKey` under a different durable category, RecallNest creates an open conflict candidate instead of silently creating a second durable owner
- conflicts can then be resolved explicitly by keeping the existing durable memory or accepting the incoming promoted text
- if the exact same conflict fingerprint appears again after a previous review, RecallNest reopens the existing conflict record instead of creating a duplicate review item

---

## Canonical Keys

Durable writes can carry a `canonicalKey`.

Use it when different observations should map to the same durable fact or workflow, for example:

- `user-reply-style`
- `project-recallnest-positioning`
- `workflow-cross-window-handoff`

Current behavior:

- exact same `canonicalKey` + same durable text => dedupe
- same `canonicalKey` on merge-type categories => update latest durable record
- same `canonicalKey` on append-type categories => keep append behavior unless the text is identical
- evidence promotion into an occupied merge-type `canonicalKey` => open conflict candidate for manual review, unless the occupied durable owner and incoming promotion are the same atomic preference slot
- reusing a `canonicalKey` across different durable categories => open conflict candidate for manual review

This gives RecallNest an explicit way to say “these two writes refer to the same durable memory”.

---

## Promotion Path

Raw evidence should not silently become durable memory.

Instead, RecallNest now supports an explicit promotion path:

- MCP: `promote_memory`
- HTTP: `POST /v1/promote`

Promotion rules:

- source memory must be evidence or transcript-derived
- target durable memory gets a new durable boundary
- promoted record keeps provenance via `promotedFrom.memoryId`
- optional `text` lets the caller replace raw transcript wording with a clean durable statement
- if the promoted text disagrees with an existing durable record for the same `canonicalKey`, RecallNest stores an open conflict candidate instead of silently overwriting the durable record
- if the promotion would reuse a `canonicalKey` that is already owned by another durable category, RecallNest stores an open conflict candidate instead of creating a second durable owner

Conflict handling entry points:

- MCP: `list_conflicts`, `resolve_conflict`
- HTTP: `GET /v1/conflicts`, `POST /v1/conflicts/resolve`
- CLI: `recallnest conflicts list/show/resolve`

Conflict review helpers:

- list and inspect views expose derived advice (`keep_existing`, `accept_incoming`, `manual_review`) with conservative confidence levels
- when a same-category promotion conflict is close enough to merge, advice may also include a conservative `mergeSuggestion` for human review
- conflict resolution now supports `merge`, which rewrites the existing durable owner with either an explicit `mergedText` or the derived `mergeSuggestion`
- list views can also be grouped by cluster so repeated conflicts on the same `canonicalKey` are reviewed as one review stream instead of many isolated rows
- audit views summarize `stale` / `escalated` clusters first so terminal operators can review the highest-risk conflicts without manually scanning every row
- escalation views can explicitly stamp `stale` / `escalated` conflicts with review metadata so operators know which aging conflicts were already triaged
- CLI audit now supports `--export --format md|json`, so operators can persist a conflict review snapshot for handoff or later triage

---

## Enforcement Points In Code

Current implementation:

- [ingest.ts](../src/ingest.ts): transcript ingest writes evidence metadata and downgrades risky stable categories
- [capture-engine.ts](../src/capture-engine.ts): structured writes stamp durable boundary metadata and create promotion conflict candidates when needed
- [conflict-engine.ts](../src/conflict-engine.ts): builds and resolves explicit conflict candidates
- [conflict-store.ts](../src/conflict-store.ts): persists conflict candidates outside the main LanceDB index
- [context-composer.ts](../src/context-composer.ts): startup continuity ignores evidence-only stable recall
- [memory-boundaries.ts](../src/memory-boundaries.ts): shared boundary resolution and read guards

---

## Practical Consequences

This contract is intentionally conservative:

- transcript recall can still help search and debugging
- structured memory is how facts graduate into durable continuity
- checkpoints carry active work state
- startup continuity should prefer fewer high-trust facts over more noisy fragments

That tradeoff is deliberate. A smaller but cleaner memory layer is more useful than a larger index with no ownership rules.
