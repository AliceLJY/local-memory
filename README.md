<div align="center">

# RecallNest

**Shared Memory Layer for Claude Code, Codex, and Gemini CLI**

*One memory. Three terminals. Context that survives across windows.*

A local-first memory system backed by LanceDB that turns scattered conversation history into reusable knowledge — shared across your coding agents, recalled automatically.

[![GitHub](https://img.shields.io/github/stars/AliceLJY/recallnest?style=social)](https://github.com/AliceLJY/recallnest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)
[![LanceDB](https://img.shields.io/badge/LanceDB-Vector+FTS-orange)](https://lancedb.com)
[![MCP](https://img.shields.io/badge/MCP-25_tools-blue)](https://modelcontextprotocol.io)

**English** | [简体中文](README_CN.md) | [Roadmap](ROADMAP.md)

</div>

---

## Why RecallNest?

Most coding agents forget everything when you open a new window. Worse — your history is scattered across three different terminals with no shared memory.

### Without RecallNest — every window starts from zero:

> **You (Claude Code):** "The Docker config lives at `/opt/app/config.json`, use port 4318."
>
> *(switch to Codex)*
>
> **You:** "The config is at... wait, let me find it again." 😤
>
> *(next day, new Claude Code window)*
>
> **You:** "We already fixed this exact bug last week! The solution was..."
>
> **Agent:** "I don't have context about previous sessions." 🤷

### With RecallNest — context carries over:

> **You (Claude Code):** "The Docker config lives at `/opt/app/config.json`, use port 4318."
>
> *(switch to Codex — same memory layer)*
>
> **Agent:** *(auto-recalls project entities)* "Using config at `/opt/app/config.json`, port 4318." ✅
>
> *(next day, new window)*
>
> **Agent:** *(resume_context fires)* "Continuing from yesterday — the Docker port conflict was resolved by..." ✅

That's the difference: **one memory shared across terminals**, with context that survives window boundaries.

### What you get

| | Capability |
|---|---|
| **Shared Index** | One LanceDB store for Claude Code, Codex, and Gemini CLI |
| **Dual Interface** | MCP (stdio) for CLI tools + HTTP API for custom agents |
| **One-Click Setup** | Integration scripts install MCP access and continuity rules |
| **Hybrid Retrieval** | Vector + BM25 + reranking + Weibull decay + tier promotion |
| **Session Continuity** | `checkpoint_session` + `resume_context` for cross-window recovery |
| **Workflow Observation** | Dedicated append-only workflow health records, outside regular memory |
| **Structured Assets** | Pins, briefs, and distilled summaries — not just raw logs |
| **Smart Promotion** | Evidence → durable memory with conflict guards and merge resolution |
| **6 Categories** | profile, preferences, entities, events, cases, patterns |
| **4 Retrieval Profiles** | default, writing, debug, fact-check — tuned for different tasks |
| **Multi-Source Ingest** | Import existing transcripts from all three terminals |

---

## Quick Start

```bash
git clone https://github.com/AliceLJY/recallnest.git
cd recallnest
bun install
cp config.json.example config.json
cp .env.example .env
# Edit .env → add your JINA_API_KEY
```

### Start the server

```bash
bun run api
# → RecallNest API running at http://localhost:4318
```

### Try it

```bash
# Store a memory
curl -X POST http://localhost:4318/v1/store \
  -H "Content-Type: application/json" \
  -d '{"text": "User prefers dark mode", "category": "preferences"}'

# Recall memories
curl -X POST http://localhost:4318/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "user preferences"}'

# Check stats
curl http://localhost:4318/v1/stats
```

### Connect your terminals

```bash
bash integrations/claude-code/setup.sh
bash integrations/gemini-cli/setup.sh
bash integrations/codex/setup.sh
```

Each script installs MCP access and managed continuity rules, so `resume_context` fires automatically in fresh windows.

### Index existing conversations

```bash
bun run src/cli.ts ingest --source all
bun run seed:continuity
bun run src/cli.ts doctor
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Client Layer                          │
├──────────┬──────────┬──────────┬──────────────────────────┤
│ Claude   │ Gemini   │ Codex    │ Custom Agents / curl     │
│ Code     │ CLI      │          │                          │
└────┬─────┴────┬─────┴────┬─────┴──────┬──────────────────┘
     │          │          │            │
     └──── MCP (stdio) ───┘     HTTP API (port 4318)
                │                       │
                ▼                       ▼
┌──────────────────────────────────────────────────────────┐
│                   Integration Layer                       │
│  ┌─────────────────────┐  ┌────────────────────────────┐ │
│  │  MCP Server         │  │  HTTP API Server           │ │
│  │  25 tools           │  │  19 endpoints              │ │
│  └─────────┬───────────┘  └──────────┬─────────────────┘ │
└────────────┼─────────────────────────┼───────────────────┘
             └──────────┬──────────────┘
                        ▼
┌──────────────────────────────────────────────────────────┐
│                     Core Engine                           │
│                                                           │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────┐ │
│  │ Retriever  │  │ Classifier │  │ Context Composer     │ │
│  │ (vector +  │  │ (6 cats)   │  │ (resume_context)     │ │
│  │ BM25 + RRF)│  │            │  │                      │ │
│  └────────────┘  └────────────┘  └──────────────────────┘ │
│  ┌────────────┐  ┌────────────┐  ┌─────────────────────┐ │
│  │ Decay      │  │ Conflict   │  │ Capture Engine       │ │
│  │ Engine     │  │ Engine     │  │ (evidence → durable) │ │
│  │ (Weibull)  │  │ (audit +   │  │                      │ │
│  │            │  │  merge)    │  │                      │ │
│  └────────────┘  └────────────┘  └──────────────────────┘ │
└──────────────────────────┬───────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────┐
│                    Storage Layer                          │
│  ┌─────────────────────┐  ┌────────────────────────────┐ │
│  │ LanceDB             │  │ Jina Embeddings v5         │ │
│  │ (vector + columnar) │  │ (1024-dim, task-aware)     │ │
│  └─────────────────────┘  └────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

> Full architecture deep-dive: [`docs/architecture.md`](docs/architecture.md)

---

## Integrations

RecallNest serves two interfaces:

- **MCP** — for Claude Code, Gemini CLI, and Codex (native tool access)
- **HTTP API** — for custom agents, SDK-based apps, and any HTTP client

### Agent framework examples

Examples live in [`integrations/examples/`](integrations/examples/):

| Framework | Example | Language |
|-----------|---------|----------|
| [Claude Agent SDK](integrations/examples/claude-agent-sdk/) | `memory-agent.ts` | TypeScript |
| [OpenAI Agents SDK](integrations/examples/openai-agents-sdk/) | `memory-agent.py` | Python |
| [LangChain](integrations/examples/langchain/) | `memory-chain.py` | Python |

---

## Core Features

### Hybrid Retrieval

```
Query → Embedding ──┐
                    ├── Hybrid Fusion → Rerank → Weibull Decay → Filter → Top-K
Query → BM25 FTS ──┘
```

- **Vector search** — semantic similarity via LanceDB ANN
- **BM25 full-text search** — exact keyword matching via LanceDB FTS
- **Hybrid fusion** — vector + BM25 combined scoring
- **Reranking** — Jina cross-encoder reranking
- **Decay + tiering** — Weibull freshness model with Core / Working / Peripheral tiers

### Session Continuity

The killer feature for multi-window workflows:

- **`checkpoint_session`** — snapshot current work state (decisions, open loops, next actions)
- **Repo-state guard** — saved checkpoints strip `git status` / modified-file text so volatile repo state does not contaminate later handoffs
- **`resume_context`** — compose startup context from checkpoints + durable memory + pins
- **Managed rules** — integration scripts install continuity rules so `resume_context` fires automatically

### Workflow Observation

RecallNest now keeps workflow observations in a dedicated append-only store instead of stuffing them into the regular memory index:

- **`workflow_observe`** — record whether `resume_context`, `checkpoint_session`, or another workflow primitive succeeded, failed, was corrected, or was missed
- **`workflow_health`** — aggregate 7d / 30d health for one workflow or show a degraded-workflow dashboard
- **`workflow_evidence`** — package recent issue observations, top signals, and suggested next actions for debugging

These records live under `data/workflow-observations`, not in the 6 memory categories, and they are never composed into `resume_context` as stable recall.
Managed MCP / HTTP continuity calls now append observations automatically for `resume_context` and `checkpoint_session`, while repo-state sanitization is recorded as a `corrected` checkpoint observation instead of polluting durable memory.

### Memory Promotion & Conflict Resolution

Raw transcripts don't silently become long-term memory:

- **Evidence → durable** — explicit `promote_memory` with `canonicalKey` and provenance
- **Conflict guards** — canonical-key collisions surface as conflict candidates
- **Resolution** — keep existing, accept new, or merge — with advice and cluster views
- **Audit + escalation** — `conflicts audit --export` for operational review

### Retrieval Profiles

| Profile | Best for | Bias |
|---------|----------|------|
| `default` | Everyday recall | Balanced |
| `writing` | Drafting and idea mining | Broader semantic, older material OK |
| `debug` | Errors, commands, fixes | Keyword-heavy, recency-biased |
| `fact-check` | Evidence lookup | Tighter cutoff, exact-match bias |

### Memory Categories

| Category | Description | Strategy |
|----------|-------------|----------|
| `profile` | User identity and background | Merge |
| `preferences` | Habits, style, dislikes | Merge |
| `entities` | Projects, tools, people | Merge |
| `events` | Things that happened | Append |
| `cases` | Problem → solution pairs | Append |
| `patterns` | Reusable workflows | Merge |

Details: [`docs/memory-categories.md`](docs/memory-categories.md)

---

<details>
<summary><strong>MCP Tools (25 tools)</strong></summary>

| Tool | Description |
|------|-------------|
| `workflow_observe` | Store an append-only workflow observation outside regular memory |
| `workflow_health` | Inspect workflow observation health or show a degraded-workflow dashboard |
| `workflow_evidence` | Build an evidence pack for a workflow primitive |
| `store_memory` | Store a durable memory for future windows |
| `store_workflow_pattern` | Store a reusable workflow as durable `patterns` memory |
| `store_case` | Store a reusable problem-solution pair as durable `cases` memory |
| `promote_memory` | Explicitly promote evidence into durable memory |
| `list_conflicts` | List or inspect promotion conflict candidates |
| `audit_conflicts` | Summarize stale/escalated conflict priorities |
| `escalate_conflicts` | Preview or apply conflict escalation metadata |
| `resolve_conflict` | Resolve a stored conflict candidate (keep / accept / merge) |
| `checkpoint_session` | Store the current active work state outside durable memory |
| `latest_checkpoint` | Inspect the latest saved checkpoint by session or scope |
| `resume_context` | Compose startup context for a fresh window |
| `search_memory` | Proactive recall at task start |
| `explain_memory` | Explain why memories matched |
| `distill_memory` | Distill results into a compact briefing |
| `brief_memory` | Create a structured brief and re-index it |
| `pin_memory` | Promote a scoped memory into a pinned asset |
| `export_memory` | Export a distilled memory briefing to disk |
| `list_pins` | List pinned memories |
| `list_assets` | List all structured assets |
| `list_dirty_briefs` | Preview outdated brief assets created before the cleanup rules |
| `clean_dirty_briefs` | Archive dirty brief assets and remove their indexed rows |
| `memory_stats` | Show index statistics |

</details>

<details>
<summary><strong>HTTP API (19 endpoints)</strong></summary>

Base URL: `http://localhost:4318`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/recall` | POST | Quick semantic search |
| `/v1/store` | POST | Store a new memory |
| `/v1/capture` | POST | Store multiple structured memories |
| `/v1/pattern` | POST | Store a structured workflow pattern |
| `/v1/case` | POST | Store a structured problem-solution case |
| `/v1/promote` | POST | Promote evidence into durable memory |
| `/v1/conflicts` | GET | List or inspect promotion conflict candidates |
| `/v1/conflicts/audit` | GET | Summarize stale/escalated conflict priorities |
| `/v1/conflicts/escalate` | POST | Preview or apply conflict escalation metadata |
| `/v1/conflicts/resolve` | POST | Resolve a stored conflict candidate (keep / accept / merge) |
| `/v1/checkpoint` | POST | Store the current work checkpoint |
| `/v1/workflow-observe` | POST | Store a workflow observation outside durable memory |
| `/v1/checkpoint/latest` | GET | Fetch the latest checkpoint by session or scope |
| `/v1/workflow-health` | GET | Inspect workflow health or return a degraded-workflow dashboard |
| `/v1/workflow-evidence` | GET | Build a workflow evidence pack from recent issue observations |
| `/v1/resume` | POST | Compose startup context for a fresh window |
| `/v1/search` | POST | Advanced search with full metadata |
| `/v1/stats` | GET | Memory statistics |
| `/v1/health` | GET | Health check |

Full documentation: [`docs/api-reference.md`](docs/api-reference.md)

</details>

<details>
<summary><strong>CLI Commands</strong></summary>

```bash
# Search & explore
bun run src/cli.ts search "your query"
bun run src/cli.ts explain "your query" --profile debug
bun run src/cli.ts distill "topic" --profile writing
bun run src/cli.ts stats

# Workflow observation
bun run src/cli.ts workflow-observe resume_context "Fresh window skipped continuity recovery." --outcome missed --scope project:recallnest
bun run src/cli.ts workflow-health resume_context --scope project:recallnest
bun run src/cli.ts workflow-evidence checkpoint_session --scope project:recallnest

# Conflict management
bun run src/cli.ts conflicts list
bun run src/cli.ts conflicts list --attention resolved
bun run src/cli.ts conflicts list --group-by cluster --attention resolved
bun run src/cli.ts conflicts audit
bun run src/cli.ts conflicts audit --export --format md
bun run src/cli.ts conflicts escalate --attention stale
bun run src/cli.ts conflicts show af70545a
bun run src/cli.ts conflicts resolve af70545a --keep-existing
bun run src/cli.ts conflicts resolve af70545a --merge
bun run src/cli.ts conflicts resolve --all --keep-existing --status open

# Ingestion & diagnostics
bun run src/cli.ts ingest --source all
bun run src/cli.ts doctor
```

</details>

<details>
<summary><strong>Web UI (debugging)</strong></summary>

```bash
bun run src/ui-server.ts
# → http://localhost:4317
```

The Web UI is for debugging and exploration, not the primary production interface.

</details>

---

## Relationship to memory-lancedb-pro

RecallNest started as a fork of [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) and shares its core ideas around hybrid retrieval, decay modeling, and memory-as-engineering-system. The key difference:

- **memory-lancedb-pro** is an OpenClaw plugin — it adds long-term memory to a single OpenClaw agent.
- **RecallNest** is a standalone memory layer — it serves Claude Code, Codex, and Gemini CLI simultaneously through MCP + HTTP API, with session continuity, structured assets, and conflict management built in.

## Credit

| Source | Contribution |
|--------|-------------|
| [claude-memory-pro](https://github.com/CortexReach/claude-memory-pro) by [@win4r](https://github.com/win4r) | Retrieval core ideas and implementation base |
| Claude Code | Foundation and early project scaffolding |
| OpenAI Codex | Productization and MCP expansion |

Special thanks to Qin Chao ([@win4r](https://github.com/win4r)) and the [CortexReach](https://github.com/CortexReach) team for the foundational work.

## Star History

<a href="https://star-history.com/#AliceLJY/recallnest&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=AliceLJY/recallnest&type=Date&theme=dark&transparent=true" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=AliceLJY/recallnest&type=Date&transparent=true" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=AliceLJY/recallnest&type=Date&transparent=true" />
  </picture>
</a>

## License

MIT
