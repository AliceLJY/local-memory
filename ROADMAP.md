# RecallNest Roadmap

> **Vision: Memory layer for AI agents that evolves itself.**
> Agent-agnostic. Self-evolving. One-click setup.

RecallNest is moving from a local transcript search tool to a **universal memory layer** that any AI agent can use — regardless of framework, language, or LLM provider.

---

## Positioning

| | claude-memory-pro (by Qin Chao) | RecallNest |
|---|---|---|
| **Focus** | Best-in-class CC memory experience | Universal agent memory layer |
| **Users** | Claude Code users | Any developer building agents |
| **Integration** | CC hooks + MCP | HTTP API + MCP + SDK examples |
| **Depth** | Reflection, self-improvement, CC-native | Self-evolution (consolidation, gap detection) |
| **Breadth** | CC-only | Claude SDK / OpenAI SDK / LangChain / any HTTP client |
| **Relationship** | Complementary, not competitive | Inspired by claude-memory-pro |

---

## Current Status

### Done (Phase 1 + 2)

- [x] HTTP API Server (`/v1/recall`, `/v1/store`, `/v1/search`, `/v1/stats`, `/v1/health`)
- [x] MCP `search_memory` proactive description + `category` filter
- [x] Search results show Category and Tier labels
- [x] `memory_stats` shows category distribution
- [x] Agent integration templates (Claude Code, Gemini CLI, Codex)
- [x] Agent SDK examples (Claude Agent SDK, OpenAI Agents SDK, LangChain)
- [x] Documentation (API reference, self-evolution design, categories, architecture)

---

## Phase 3: Self-Evolution Engine

> Make the memory system maintain and improve itself.

| Feature | Description |
|---------|-------------|
| **Memory Consolidation** | Find duplicate/similar memories within the same category. Merge-strategy categories (profile, preferences, entities, patterns) get merged by LLM. Append-strategy categories (events, cases) get deduplicated. |
| **Gap Detection** | Analyze search queries that returned low/zero results. Cluster by topic. Report: "You searched for X many times but have no relevant memories." |
| **Promotion Suggestions** | Core-tier memories with high access count → suggest writing into agent's persistent config (e.g., CLAUDE.md). |
| **Tier Maintenance** | Promote frequently-accessed peripheral → working. Demote stale working → peripheral. |

Planned endpoints: `POST /v1/consolidate` (dry-run by default), `GET /v1/gaps`.

---

## Phase 4: Polish + Open Source

| Item | Description |
|------|-------------|
| README rewrite | Highlight: universal + self-evolving + one-click setup |
| `lm health` CLI | Overview of category/tier distribution, top memories, gap summary |
| MCP `consolidate_memory` tool | On-demand consolidation via agent |

---

## Principles

- **Agent-agnostic**: HTTP API first, MCP second, framework-specific integrations as templates
- **Local-first**: All data stays on your machine
- **Self-evolving**: The system gets smarter over time, not just bigger
- **Simple to maintain**: Every component is a single file, no complex infrastructure
- **Measured changes**: Eval baselines before tuning retrieval
