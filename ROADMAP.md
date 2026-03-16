# RecallNest Roadmap

> Vision: a shared memory layer for Claude Code, Codex, and Gemini CLI that gets more useful over time.

RecallNest is no longer best described as "local transcript search." The real target is stricter:

- one memory layer shared by the three terminals
- stable context that survives across windows
- memory that becomes more reusable, not just larger

This roadmap reflects that direction.

## The Core Problem

Today, most coding agents have weak continuity:

- past context is scattered across tools
- a new window often behaves like a reset
- search is passive, so memory works only when explicitly invoked
- transcript archives are large, but high-value memories are sparse

RecallNest exists to close that gap without giving up local control.

What matters first is this: opening another window should not erase stable context about the user, projects, patterns, and past solutions.

## Status Summary

### Already Done

- Shared local LanceDB index
- MCP server for Claude Code, Gemini CLI, and Codex
- HTTP API for custom agents
- Ingestion from existing transcripts and memory files
- Hybrid retrieval: vector + BM25 + reranking
- 6-category memory classification
- Tier-aware decay and access reinforcement
- Brief and pin assets re-indexed into recall
- Session checkpoints for active work state
- `resume_context` composition for fresh windows
- Continuity eval harness with seed cases and baseline reports
- Setup scripts, diagnostics, and debugging UI
- Explicit evidence -> durable promotion with provenance and `canonicalKey`
- Conflict candidates, review, audit, escalation, merge resolution, and audit export

### Current Gap

RecallNest is already usable as a three-terminal continuity layer, but a few operating gaps remain.

The main gaps are:

- continuity eval still depends on the latest live checkpoint in one case
- conflict review is strong in CLI, but scheduled audit/export is still missing
- high-signal memory extraction and promotion quality can still improve

## Phase 1: Shared Memory Foundation

Status: done

Goal: make all three terminals use the same local memory base.

Delivered:

- one local index shared by Claude Code, Codex, and Gemini CLI
- MCP integration scripts for the three terminals
- HTTP API for agent frameworks
- multi-source ingest pipeline

## Phase 2: Searchable Recall Engine

Status: done

Goal: make the memory base actually retrievable.

Delivered:

- hybrid retrieval
- retrieval profiles
- memory categories
- tiering and decay
- explain, distill, brief, and pin flows

## Phase 3: Cross-Window Continuity Layer

Status: usable in the current stage

Goal: a fresh window should recall stable context without depending on the user to restate it.

Delivered:

- session checkpoints for active work state
- `resume_context` for fresh windows
- context composition that prefers stable background over blindly replaying the last topic
- managed continuity rules installed by setup for Claude Code, Codex, and Gemini CLI

Remaining work:

- isolate eval from live checkpoint drift
- keep measuring instruction-driven startup continuity across the three terminals
- expand checkpoint-aware continuity coverage and keep tracking trendlines

Likely interfaces:

- `resume_context`
- `checkpoint_session`
- startup-oriented MCP and API flows

## Phase 4: High-Signal Memory Capture

Status: usable in the current stage

Goal: store more useful memory and less raw transcript residue.

Delivered:

- `store_memory` for MCP
- dedicated workflow-pattern capture for durable `patterns`
- structured capture endpoints for non-MCP agents
- explicit evidence promotion into durable memory
- boundary guards for `evidence / durable / session`
- conflict handling when new durable candidates disagree with existing canonical owners

Remaining work:

- improve extraction toward durable facts, preferences, entities, cases, and patterns
- better dedup before low-value text reaches the index

Likely interfaces:

- `store_memory` for MCP
- structured capture endpoints for non-MCP agents

## Phase 5: Memory Boundary and Conflict Operations

Status: usable in the current stage

Goal: stop durable memory from drifting silently and make conflicts operable in the terminal.

Delivered:

- `promote_memory` with provenance and `canonicalKey`
- conflict candidates instead of silent overwrite
- terminal conflict review: `list / show / resolve`
- conflict advice, clusters, audit, escalation, and `merge`
- audit export snapshots in markdown or JSON

Remaining work:

- scheduled audit / export for recurring review
- stronger merge and promotion heuristics

Likely interfaces:

- `resolve_conflict`
- `audit_conflicts`
- `escalate_conflicts`
- CLI `recallnest conflicts ...`

## Phase 6: Self-Evolution Engine

Status: planned

Goal: make memory quality improve over time.

Planned work:

- memory consolidation for merge-style categories
- duplicate cleanup for append-style categories
- gap detection from weak or failed searches
- promotion suggestions for memories that should become persistent rules
- better tier maintenance and archival policies

Likely endpoints:

- `POST /v1/consolidate`
- `GET /v1/gaps`
- MCP `consolidate_memory`

## Phase 7: Product Polish

Status: ongoing

Goal: make RecallNest easier to trust, measure, and operate.

Planned work:

- continuity eval isolation from live checkpoints
- broader continuity-focused evals and benchmarks
- stronger docs around achieved vs planned capabilities
- health and quality summaries in CLI
- cleaner setup for long-running background usage

## Principles

- Local-first: all memory stays on your machine
- Three-terminal first: Claude Code, Codex, and Gemini CLI are the immediate focus
- Continuity over transcript hoarding: useful memory matters more than raw volume
- Agent-agnostic at the interface layer: HTTP API and MCP remain the public surface
- Measured evolution: use evals before tuning retrieval or memory policies
