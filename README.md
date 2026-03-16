# RecallNest

> Shared memory layer for Claude Code, Codex, and Gemini CLI.

RecallNest is a local-first memory system for coding agents. It helps your three terminals share the same memory, carry useful context across windows, and gradually turn raw transcripts into reusable knowledge.

[中文文档](README_CN.md) · [Roadmap](ROADMAP.md)

## The Problem

- Your work history is scattered across Claude Code, Codex, and Gemini CLI.
- Opening a new window often feels like starting from zero, even when stable context should carry over.
- Search-only memory is too passive. If the agent does not look, it forgets.
- Raw transcript search creates a lot of logs, but not enough high-value memory.
- Many memory tools are tied to one client instead of serving your whole terminal workflow.

## What RecallNest Solves Today

- One shared LanceDB-backed memory index for Claude Code, Codex, and Gemini CLI.
- MCP tools plus HTTP API, so CLI tools and custom agents can use the same memory layer.
- One-click integration scripts that install both MCP access and managed continuity rules for Claude Code, Codex, and Gemini CLI.
- Multi-source ingestion from existing conversation history.
- Hybrid retrieval with vector search, BM25, reranking, category labels, and tier-aware decay.
- Structured assets such as pinned memories and briefs, so useful context does not stay trapped in raw chat logs.
- Session checkpoints plus `resume_context`, so a fresh window can recover stable background without relying on raw search results alone.
- Explicit evidence -> durable promotion with `canonicalKey`, so raw transcript evidence does not silently become long-term memory.
- Terminal-first conflict review, audit, escalation, merge resolution, and audit export, so memory disagreements become visible and operable instead of quietly corrupting durable memory.

This already makes RecallNest useful for finding past fixes, recurring workflows, project context, and user-level preferences across terminals.

## What Is Next

- Isolate continuity eval from live checkpoint drift.
  Goal: keep continuity benchmarks stable even after new work checkpoints are stored during day-to-day use.
- Add scheduled conflict audit / export workflows.
  Goal: turn conflict review from an on-demand command into a lightweight recurring operational loop.
- Improve high-signal capture and merge / promotion heuristics.
  Goal: surface more durable working knowledge and reduce manual review over time.

## Current Status

### Done

- [x] HTTP API server: `/v1/recall`, `/v1/store`, `/v1/capture`, `/v1/pattern`, `/v1/case`, `/v1/checkpoint`, `/v1/checkpoint/latest`, `/v1/resume`, `/v1/search`, `/v1/stats`, `/v1/health`
- [x] MCP server with `store_memory`, `store_workflow_pattern`, `store_case`, `checkpoint_session`, `latest_checkpoint`, `resume_context`, `search_memory`, `explain_memory`, `distill_memory`, `brief_memory`, `pin_memory`, `memory_stats`
- [x] One-click integration scripts for Claude Code, Gemini CLI, and Codex, including managed continuity rules
- [x] Shared local index across the three terminals
- [x] Ingestion pipeline for existing transcripts and memory files
- [x] 6-category classification, hybrid retrieval, retrieval profiles, tiering, and decay
- [x] Brief and pin assets that are re-indexed into recall
- [x] Separate session checkpoint store for active work state
- [x] Startup context composition for fresh windows via `resume_context`
- [x] Retrieval and continuity eval runners with seed cases and baseline reports
- [x] Dedicated workflow-pattern capture path for durable `patterns` memories
- [x] Doctor command and lightweight Web UI for debugging
- [x] Explicit evidence -> durable promotion with `canonicalKey`, provenance, and conflict candidates
- [x] Terminal-first conflict review via `recallnest conflicts list/show/resolve`, with advice and cluster views
- [x] Conflict guards for canonical-key collisions, including cross-category durable writes
- [x] Conflict audit / escalation flows plus `merge` resolution for same-category durable conflicts
- [x] Audit export via `recallnest conflicts audit --export --format md|json`

### Known Gaps

- [ ] One continuity eval case still depends on the latest live checkpoint and can drift after unrelated checkpoints are stored
- [ ] Conflict audit / export is usable from CLI, but not yet scheduled as a recurring review flow
- [ ] High-signal memory capture can still surface more durable working knowledge and fewer low-signal transcript fragments

### If Development Resumes

- [ ] Isolate continuity eval from live checkpoint state
- [ ] Add scheduled conflict audit / export
- [ ] Continue improving capture, merge, and promotion heuristics

## Quick Start

```bash
git clone https://github.com/AliceLJY/recallnest.git
cd recallnest
bun install
cp config.json.example config.json
cp .env.example .env
# Edit .env -> add your JINA_API_KEY
```

### Start the API server

```bash
bun run api
# -> RecallNest API running at http://localhost:4318
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

### Index existing conversations

```bash
bun run src/cli.ts ingest --source all
bun run seed:patterns
bun run seed:cases
bun run src/cli.ts doctor
bun run eval:continuity
```

## Integrations

RecallNest works through two interfaces:

- MCP for Claude Code, Gemini CLI, and Codex
- HTTP API for custom agents and SDK-based apps

### CLI tools

```bash
bash integrations/claude-code/setup.sh
bash integrations/gemini-cli/setup.sh
bash integrations/codex/setup.sh
```

### Agent frameworks

Examples live in [`integrations/examples/`](integrations/examples/):

| Framework | Example | Language |
|-----------|---------|----------|
| [Claude Agent SDK](integrations/examples/claude-agent-sdk/) | `memory-agent.ts` | TypeScript |
| [OpenAI Agents SDK](integrations/examples/openai-agents-sdk/) | `memory-agent.py` | Python |
| [LangChain](integrations/examples/langchain/) | `memory-chain.py` | Python |

## API Reference

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
| `/v1/checkpoint/latest` | GET | Fetch the latest checkpoint by session or scope |
| `/v1/resume` | POST | Compose startup context for a fresh window |
| `/v1/search` | POST | Advanced search with full metadata |
| `/v1/stats` | GET | Memory statistics |
| `/v1/health` | GET | Health check |

Full documentation: [`docs/api-reference.md`](docs/api-reference.md)

## MCP Tools

| Tool | Description |
|------|-------------|
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
| `pin_memory` | Promote a memory into a pinned asset |
| `memory_stats` | Show index statistics |

## Memory Categories

| Category | Description | Strategy |
|----------|-------------|----------|
| `profile` | User identity and background | Merge |
| `preferences` | Habits, style, dislikes | Merge |
| `entities` | Projects, tools, people | Merge |
| `events` | Things that happened | Append |
| `cases` | Problem -> solution pairs | Append |
| `patterns` | Reusable workflows | Merge |

Details: [`docs/memory-categories.md`](docs/memory-categories.md)

## Retrieval Profiles

| Profile | Best for | Bias |
|---------|----------|------|
| `default` | Everyday recall | Balanced |
| `writing` | Drafting and idea mining | Broader semantic, older material OK |
| `debug` | Errors, commands, fixes | Keyword-heavy, recency-biased |
| `fact-check` | Evidence lookup | Tighter cutoff, exact-match bias |

## Architecture

See [`docs/architecture.md`](docs/architecture.md).

## Additional Interfaces

### CLI

```bash
bun run src/cli.ts search "your query"
bun run src/cli.ts explain "your query" --profile debug
bun run src/cli.ts distill "topic" --profile writing
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
bun run src/cli.ts stats
```

### Web UI

```bash
bun run src/ui-server.ts
# -> http://localhost:4317
```

The Web UI is for debugging and exploration, not the primary production interface.

## Credit

| Source | Contribution |
|--------|-------------|
| [claude-memory-pro](https://github.com/CortexReach/claude-memory-pro) by [@win4r](https://github.com/win4r) | Retrieval core ideas and implementation base |
| Claude Code | Foundation and early project scaffolding |
| OpenAI Codex | Productization and MCP expansion |

## Acknowledgements

Special thanks to Qin Chao ([@win4r](https://github.com/win4r)) and the [CortexReach](https://github.com/CortexReach) team. RecallNest borrows heavily from the `memory-lancedb-pro` line of thinking on hybrid retrieval, scope-aware recall, and memory as an engineering system, while taking a broader multi-terminal direction.

## License

MIT
