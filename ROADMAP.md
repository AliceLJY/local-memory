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
- MCP server for Claude Code, Gemini CLI, and Codex (40 tools in 3 tiers)
- HTTP API for custom agents (21 endpoints)
- Ingestion from existing transcripts and memory files
- Hybrid retrieval: vector + BM25 + reranking + 4 retrieval profiles
- 6-channel retrieval: vector + BM25 + L0/L1/L2 multi-vector + KG graph (PPR)
- 6-category memory classification with topic tags (15 auto-detected topics)
- Tier-aware decay (Weibull) and access reinforcement
- Brief and pin assets re-indexed into recall
- Session checkpoints for active work state
- `resume_context` composition for fresh windows (full/light/summary modes)
- Continuity eval harness with seed cases and baseline reports
- Setup scripts, diagnostics, and debugging UI
- Explicit evidence -> durable promotion with provenance and `canonicalKey`
- Conflict candidates, review, audit, escalation, merge resolution, and audit export
- Session Distiller: 3-layer conversation compression to durable memory
- Conversation import from Claude Code, Claude.ai, ChatGPT, Slack, and plaintext
- Skill Memory: store, retrieve, and auto-promote executable skills
- Admission Control: write-time gating with noise filter, importance floor, dedup, and rate limiting
- Memory Lint: contradiction, duplicate, stale, and orphan detection with health score
- Knowledge Graph: interactive D3.js visualization with cross-scope semantic bridges
- Memory Dashboard: Web UI with stats, category distribution, growth trends, and health
- SKILL.md: Memory Partner Protocol for LLM onboarding
- Offline consolidation (`dream`): clustering, merging, pruning
- Batch operations (`batch_store`): up to 20 memories per call with dedup
- Data quality health checks (`data_checkup`)

### Current Gap

RecallNest is a mature three-terminal continuity layer. The remaining gaps are operational, not architectural:

- continuity eval still depends on the latest live checkpoint in one case
- scheduled conflict audit/export for recurring review is still missing
- cross-scope semantic bridge threshold may need per-user tuning

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

- ✅ hybrid retrieval (vector + BM25 + RRF)
- ✅ 6-channel retrieval: vector + BM25 + L0/L1/L2 multi-vector + KG graph (PPR)
- ✅ 4 retrieval profiles (default, writing, debug, fact-check)
- ✅ 6 memory categories with topic tags
- ✅ Weibull decay + tiering (core / working / peripheral)
- ✅ explain, distill, brief, and pin flows
- ✅ Recall Governor: auto-recall governance with budget control and session dedup

## Phase 3: Cross-Window Continuity Layer

Status: ~~usable~~ **done**

Goal: a fresh window should recall stable context without depending on the user to restate it.

Delivered:

- ✅ session checkpoints for active work state
- ✅ `resume_context` for fresh windows (full/light/summary modes)
- ✅ ultra-light wake-up: `resume_context(mode='light')` returns <300 tokens for low-budget terminals
- ✅ context composition that prefers stable background over blindly replaying the last topic
- ✅ managed continuity rules installed by setup for Claude Code, Codex, and Gemini CLI
- ✅ repo-state guard: `checkpoint_session` scrubs volatile git status before handoff
- ✅ session distiller: 3-layer conversation compression to durable memory

Remaining work:

- ⬜ isolate eval from live checkpoint drift
- ⬜ keep measuring instruction-driven startup continuity across the three terminals

## Phase 4: High-Signal Memory Capture

Status: ~~usable~~ **done**

Goal: store more useful memory and less raw transcript residue.

Delivered:

- ✅ `store_memory` for MCP
- ✅ dedicated workflow-pattern capture for durable `patterns`
- ✅ structured capture endpoints for non-MCP agents
- ✅ explicit evidence promotion into durable memory
- ✅ boundary guards for `evidence / durable / session`
- ✅ conflict handling when new durable candidates disagree with existing canonical owners
- ✅ admission control: noise filter, importance floor, dedup, rate limiting
- ✅ conversation import from Claude Code, ChatGPT, Slack, plaintext
- ✅ batch store: up to 20 memories per call with dedup
- ✅ auto capture: zero-LLM heuristic extraction from text
- ✅ skill memory: store, retrieve, auto-promote executable skills from recurring patterns
- ✅ topic tags: 15 auto-detected topics per scope, filterable in `search_memory`

## Phase 5: Memory Boundary and Conflict Operations

Status: ~~usable~~ **done**

Goal: stop durable memory from drifting silently and make conflicts operable in the terminal.

Delivered:

- ✅ `promote_memory` with provenance and `canonicalKey`
- ✅ conflict candidates instead of silent overwrite
- ✅ terminal conflict review: `list / show / resolve`
- ✅ conflict advice, clusters, audit, escalation, and `merge`
- ✅ audit export snapshots in markdown or JSON
- ✅ workflow observation: append-only health records outside regular memory
- ✅ workflow health dashboard and evidence pack generation

Remaining work:

- ⬜ scheduled audit / export for recurring review
- ⬜ stronger merge and promotion heuristics

## Phase 6: Self-Evolution Engine

Status: ~~planned~~ **done**

Goal: make memory quality improve over time.

Delivered:

- ✅ memory consolidation for merge-style categories (`consolidate_memories`, dry-run by default)
- ✅ duplicate detection and cleanup (`memory_lint` duplicate check, cosine >= 0.92)
- ✅ stale memory detection (90+ days, low access count)
- ✅ contradiction detection with category-aware filtering (skip append-only categories)
- ✅ orphan detection (missing scope, broken consolidation links)
- ✅ health score formula: 100 - weighted penalties, clamped 0-100
- ✅ promotion suggestions for memories that should become skills (`scan_skill_promotions`)
- ✅ offline consolidation via `dream` (clustering, merging, pruning)
- ✅ admission control: write-time noise filter, importance floor, dedup, rate limiting

Interfaces:

- `memory_lint` (MCP + CLI + HTTP)
- `consolidate_memories` (MCP)
- `dream` (MCP)
- `scan_skill_promotions` (MCP)
- `data_checkup` (MCP)
- `GET /v1/lint` (HTTP)

## Phase 7: Product Polish

Status: ~~ongoing~~ **mostly done**

Goal: make RecallNest easier to trust, measure, and operate.

Delivered:

- ✅ health and quality summaries in CLI (`lint` command with health score 0-100)
- ✅ Memory Dashboard: Web UI homepage with stat cards, category bars, lint summary, growth trends
- ✅ Knowledge Graph export: interactive HTML visualization with D3.js force-directed layout
- ✅ Cross-scope semantic bridges: auto-discover hidden cross-domain knowledge connections
- ✅ SKILL.md: Memory Partner Protocol for LLM onboarding (session protocol, anti-patterns, tool decision tree)
- ✅ stronger docs: updated README/README_CN with screenshots, v2.0 highlights, 40 tools, 21 endpoints
- ✅ Session Distiller: 3-layer conversation compression (microcompact -> LLM summary -> knowledge extraction)
- ✅ Conversation Import: Claude Code, Claude.ai, ChatGPT, Slack, plaintext — auto-detected

Remaining work:

- ⬜ continuity eval isolation from live checkpoints
- ⬜ broader continuity-focused evals and benchmarks
- ⬜ cleaner setup for long-running background usage

## Principles

- Local-first: all memory stays on your machine
- Three-terminal first: Claude Code, Codex, and Gemini CLI are the immediate focus
- Continuity over transcript hoarding: useful memory matters more than raw volume
- Agent-agnostic at the interface layer: HTTP API and MCP remain the public surface
- Measured evolution: use evals before tuning retrieval or memory policies
