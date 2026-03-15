# RecallNest

> Memory layer for AI agents that evolves itself.

Give any AI agent persistent memory that survives across sessions, consolidates over time, and gets smarter the more you use it. Works with any framework — Claude Agent SDK, OpenAI Agents SDK, LangChain, or plain HTTP.

> 给任何 AI agent 加上会自我进化的持久记忆。跨框架、跨语言、一键接入。

## Why RecallNest

| Feature | RecallNest | Typical solutions |
|---------|:---------:|:-----------------:|
| Works with any agent framework | ✅ HTTP API + MCP | ❌ Single-tool only |
| Self-evolution (consolidation + gap detection) | ✅ | ❌ |
| 6-category classification | ✅ | ❌ |
| Weibull decay + 3-tier lifecycle | ✅ | ❌ |
| Hybrid retrieval (vector + BM25 + reranking) | ✅ | Partial |
| One-click integration scripts | ✅ | ❌ |

## Quick Start

```bash
git clone https://github.com/AliceLJY/recallnest.git
cd recallnest
bun install
cp config.json.example config.json
cp .env.example .env
# Edit .env → add your JINA_API_KEY
```

### Start the API server

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

### Index existing conversations

```bash
bun run src/cli.ts ingest --source all
bun run src/cli.ts doctor   # verify setup
```

## Integrations

RecallNest works through two interfaces: **HTTP API** (any language) and **MCP** (Claude Code, Gemini CLI, Codex).

### CLI Tools (one-click setup)

```bash
# Claude Code
bash integrations/claude-code/setup.sh

# Gemini CLI
bash integrations/gemini-cli/setup.sh

# Codex
bash integrations/codex/setup.sh
```

### Agent Frameworks

Drop-in examples for popular agent SDKs — see [`integrations/examples/`](integrations/examples/):

| Framework | Example | Language |
|-----------|---------|----------|
| [Claude Agent SDK](integrations/examples/claude-agent-sdk/) | `memory-agent.ts` | TypeScript |
| [OpenAI Agents SDK](integrations/examples/openai-agents-sdk/) | `memory-agent.py` | Python |
| [LangChain](integrations/examples/langchain/) | `memory-chain.py` | Python |

Each example shows how to add `recall_memory` and `store_memory` tools to your agent in ~30 lines.

## API Reference

Base URL: `http://localhost:4318`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/recall` | POST | Quick semantic search |
| `/v1/store` | POST | Store a new memory |
| `/v1/search` | POST | Advanced search with full metadata |
| `/v1/stats` | GET | Memory statistics |
| `/v1/health` | GET | Health check |

Full documentation: [`docs/api-reference.md`](docs/api-reference.md)

## MCP Tools

When connected via MCP, agents get these tools:

| Tool | Description |
|------|-------------|
| `search_memory` | Proactive recall — agents are encouraged to use this at the start of every task |
| `explain_memory` | Show why memories matched |
| `distill_memory` | Compact briefing from results |
| `brief_memory` | Create structured brief + re-index |
| `pin_memory` | Promote a memory to pinned asset |
| `memory_stats` | Index statistics with category breakdown |

## Memory Categories

RecallNest classifies memories into 6 categories during ingestion:

| Category | Description | Strategy |
|----------|-------------|----------|
| `profile` | User identity and background | Merge |
| `preferences` | Habits, style, dislikes | Merge |
| `entities` | Projects, tools, people | Merge |
| `events` | Things that happened | Append |
| `cases` | Problem → solution pairs | Append |
| `patterns` | Reusable workflows | Merge |

Details: [`docs/memory-categories.md`](docs/memory-categories.md)

## Retrieval Profiles

| Profile | Best for | Bias |
|---------|----------|------|
| `default` | Everyday recall | Balanced |
| `writing` | Drafting, idea mining | Broader semantic, older material OK |
| `debug` | Errors, commands, fixes | Keyword-heavy, recency-biased |
| `fact-check` | Evidence lookup | Tighter cutoff, exact-match bias |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  AI Agents                       │
├──────────┬──────────┬──────────┬────────────────┤
│ Claude   │ OpenAI   │ LangChain│ Any HTTP       │
│ Agent SDK│ Agents   │          │ client         │
└────┬─────┴────┬─────┴────┬─────┴──────┬─────────┘
     │          │          │            │
     ▼          ▼          ▼            ▼
┌─────────────────────────────────────────────────┐
│             RecallNest Access Layer              │
├─────────────────┬───────────────────────────────┤
│  HTTP API :4318 │   MCP Server (stdio)          │
└────────┬────────┴────────────┬──────────────────┘
         │                     │
         ▼                     ▼
┌─────────────────────────────────────────────────┐
│             RecallNest Core Engine               │
│  Hybrid Retrieval · 6-Category Classification   │
│  Weibull Decay · 3-Tier Lifecycle               │
│  Smart Extraction · Self-Evolution (planned)    │
└─────────────────────┬───────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────┐
│       LanceDB + Jina Embeddings v5              │
└─────────────────────────────────────────────────┘
```

Details: [`docs/architecture.md`](docs/architecture.md)

## Additional Interfaces

### CLI

```bash
bun run src/cli.ts search "your query"
bun run src/cli.ts explain "your query" --profile debug
bun run src/cli.ts distill "topic" --profile writing
bun run src/cli.ts stats
```

### Web UI (debug tool)

A lightweight web interface is available for debugging and exploring memories:

```bash
bun run src/ui-server.ts
# → http://localhost:4317
```

> The web UI is a development/debugging tool, not the primary interface. For production agent integration, use the HTTP API or MCP.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full evolution plan.

**Coming next:**
- Memory consolidation (auto-merge duplicates)
- Gap detection (find topics with weak coverage)
- Promotion suggestions (surface high-value memories)

## Credit

| Source | Contribution |
|--------|-------------|
| [claude-memory-pro](https://github.com/CortexReach/claude-memory-pro) by [@win4r](https://github.com/win4r) | Retrieval core ideas and implementation base |
| Claude Code | Foundation and early project scaffolding |
| OpenAI Codex | Productization and MCP expansion |

## Acknowledgements

Special thanks to 秦超老师 ([@win4r](https://github.com/win4r)) and the [CortexReach](https://github.com/CortexReach) team. RecallNest's retrieval design — hybrid search, reranking, scope-aware recall, and memory-as-engineering-system — comes directly from the `memory-lancedb-pro` line of thinking. RecallNest takes a different direction (universal agent memory layer) but shares the same foundation.

## License

MIT
