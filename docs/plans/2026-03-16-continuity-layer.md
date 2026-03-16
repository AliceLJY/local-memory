# Continuity Layer Plan

> Phase 1 design for turning RecallNest from searchable history into a continuity layer.

## Goal

RecallNest already provides shared memory across Claude Code, Codex, and Gemini CLI. The next step is not "more search." The next step is continuity:

- stable context should survive across windows
- active work state should not be mixed into long-term memory
- startup context should be composed deliberately, not copied from raw search results

## The Three Layers

### 1. Durable Memory

Purpose:

- long-lived context worth keeping across sessions and terminals

Categories:

- `profile`
- `preferences`
- `entities`
- `events`
- `cases`
- `patterns`

Characteristics:

- stored in the main memory index
- survives across windows
- retrieved through the normal retrieval stack

Primary write interface:

- `store_memory`

### 2. Session Checkpoint

Purpose:

- preserve current work state without polluting long-term memory

Typical contents:

- current task summary
- decisions made in the session
- open loops
- next actions
- active entities
- relevant files

Characteristics:

- scoped to the current session or work thread
- short-lived compared with durable memory
- should be stored separately from the main durable memory table

Primary write interface:

- `checkpoint_session`

### 3. Resume Context

Purpose:

- provide a fresh window with the minimum context needed to work effectively

Sources:

- stable durable memories
- pinned assets
- recent cases and patterns
- latest session checkpoint

Characteristics:

- composed output, not raw search results
- optimized for prompt injection or startup display
- should bias toward stable background, not "resume the last conversation verbatim"

Primary read interface:

- `resume_context`

## Interface Boundaries

### `store_memory`

Use when:

- a fact, preference, entity, case, or reusable pattern should survive long term

Do not use when:

- the content is only about the current unfinished work state

Schema:

- code source: [`memory-schema.ts`]($HOME/recallnest/src/memory-schema.ts)

Key fields:

- `text`
- `category`
- `importance`
- `scope`
- `source`
- `tags`

### `checkpoint_session`

Use when:

- a session needs a compact representation of current progress

Do not use when:

- the information is already a durable user/project fact

Schema:

- code source: [`session-schema.ts`]($HOME/recallnest/src/session-schema.ts)

Key fields:

- `sessionId`
- `summary`
- `decisions`
- `openLoops`
- `nextActions`
- `entities`
- `files`

### `resume_context`

Use when:

- a new window or task start needs continuity

The response should answer:

- who is this user
- what stable preferences matter
- what project entities are relevant
- what reusable patterns or recent cases matter
- what is the latest active checkpoint

Schema:

- code source: [`session-schema.ts`]($HOME/recallnest/src/session-schema.ts)

Key fields:

- `summary`
- `stableContext`
- `relevantPatterns`
- `recentCases`
- `latestCheckpoint`

## Storage Direction

### Durable memory

- stays in the main `memories` index
- uses existing retrieval, decay, and tiering

### Session checkpoints

- should move to a dedicated store or table
- should not be mixed with durable memory rows by default

## Why This Split Matters

Without this split, RecallNest tends to accumulate two incompatible things in one place:

- stable memory that should be reused for months
- transient working notes that are only useful during the current task

That creates noisy recall and weak startup continuity.

## Implementation Order

1. Define schema and contracts
2. Add structured durable memory writes
3. Add session checkpoint persistence
4. Add resume context composition
5. Add continuity-focused evaluation

## Done in Phase 1

- Added durable memory schemas in [`memory-schema.ts`]($HOME/recallnest/src/memory-schema.ts)
- Added checkpoint and resume schemas in [`session-schema.ts`]($HOME/recallnest/src/session-schema.ts)
- Wired existing category validation to the new durable memory schema in [`api-server.ts`]($HOME/recallnest/src/api-server.ts) and [`mcp-server.ts`]($HOME/recallnest/src/mcp-server.ts)
