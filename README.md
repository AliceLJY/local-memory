# RecallNest

> MCP-native memory workbench for AI conversations.
> Foundation built with Claude Code. Productization and UI expansion completed with OpenAI Codex.

RecallNest turns Claude Code, Codex, and markdown notes into a local-first recall layer you can search, explain, distill, pin, and export.

![RecallNest workbench](./assets/recallnest-workbench.png)

## Why RecallNest

| Problem | Why existing transcript search is not enough | RecallNest answer |
|------|------|------|
| Too many chats | Raw archives are searchable but not reusable | Turn transcripts into recallable memory assets |
| Agent memory is opaque | You do not know why a hit surfaced | Show score, source, scope, retrieval path, and evidence |
| Good context disappears | One useful hit is lost in the next session | Pin and brief write useful context back into recall |
| CLI-only demos do not spread | People do not see the value fast enough | Pair MCP-native tools with a local workbench UI |
| Retrieval tuning is guesswork | "Feels better" is not a reliable benchmark | Track eval baselines and failure cases over time |

## At A Glance

| Problem | RecallNest answer |
|------|------|
| Too many transcripts, no recall | Hybrid vector + BM25 retrieval |
| Hits are opaque | Explain mode with source, file, path, and score trace |
| Raw chunks are not reusable | Distill mode turns hits into a briefing |
| Good memories disappear again | Pin turns them into reusable assets |
| Distilled context is still ephemeral | Brief mode writes structured memory briefs back into recall |
| Assets stay isolated | Pinned assets are re-indexed into `asset:*` recall scope |
| CLI is hard to demo | Local web workbench at `http://localhost:4317` |

## Product Shape

| Layer | What it does |
|------|------|
| Ingest | Parse Claude Code, Codex, Markdown (Gemini CLI: coming soon) |
| Store | LanceDB vector store + FTS |
| Retrieve | Hybrid search + rerank + time-aware scoring |
| Explain | Show why a memory matched |
| Distill | Produce briefings and evidence bundles |
| Assetize | Pin reusable memory into long-lived assets |
| Structure | Save distilled result sets as `memory-brief` assets |
| Recall Again | Feed pinned assets back into retrieval |
| Interface | CLI + MCP + local web UI |

## Modes

| Mode | Best for | Retrieval bias |
|------|----------|----------------|
| `default` | everyday recall | balanced |
| `writing` | drafting, idea mining | broader semantic recall |
| `debug` | errors, commands, fixes | stronger keyword + recency |
| `fact-check` | evidence lookup | tighter exact-match cutoff |

## Interfaces

| Interface | Commands / tools |
|------|------|
| CLI | `search`, `explain`, `distill`, `brief`, `pin`, `pins`, `assets`, `export`, `profiles` |
| MCP | `search_memory`, `explain_memory`, `distill_memory`, `brief_memory`, `pin_memory`, `list_assets`, `list_pins`, `export_memory`, `memory_stats` |
| UI | query console, source-grouped cards, one-click pin, `Assets / Exports` views, stats, structured asset panel |

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| [Bun](https://bun.sh) | >= 1.0 | `bun --version` |
| [Jina API key](https://jina.ai/embeddings/) | free tier works | sign up and copy key |

> Node.js >= 20 also works (`npx tsx src/cli.ts ...`) but Bun is recommended for speed.

## Quick Start

**Step 1: Clone and install**

```bash
git clone https://github.com/AliceLJY/recallnest.git
cd recallnest
bun install        # or: npm install
```

**Step 2: Configure**

```bash
cp config.json.example config.json
cp .env.example .env
```

Edit `.env` and paste your Jina API key:

```
JINA_API_KEY=jina_xxxxxxxxxxxx
```

**Step 3: Verify setup**

```bash
bun run src/cli.ts doctor
```

Expected output — all green checks:

```
  RecallNest Doctor

  ✅ Bun runtime: v1.x.x
  ✅ Config file: /path/to/config.json
  ✅ JINA_API_KEY: set (jina_xxx...)
  ✅ Config parse: valid JSON
  ✅ Data directory: ~/.recallnest/data/lancedb
  ✅ CC transcripts: auto-detected: ~/.claude/projects
  ✅ Embedding API: jina-embeddings-v5-text-small (1024d)
```

**Step 4: Index your conversations**

```bash
bun run src/cli.ts ingest --source all
```

**Step 5: Search**

```bash
bun run src/cli.ts search "your query here"
```

Or open the local workbench:

```bash
bun run src/ui-server.ts
# visit http://localhost:4317
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `bun: command not found` | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |
| `JINA_API_KEY not set` | Copy your key from https://jina.ai/embeddings/ into `.env` |
| Jina 401 / Embedding API fail | Check if key is valid — run `lm doctor` to diagnose |
| CC transcripts not found | Set `sources.cc.path` in config.json to your `~/.claude/projects/-Users-yourname` path |
| Port 4317 in use | `RECALLNEST_UI_PORT=4321 bun run src/ui-server.ts` |

## Common Flows

### 1. Search and explain

```bash
bun run src/cli.ts search "telegram bridge" --profile debug
bun run src/cli.ts explain "telegram bridge" --profile debug
```

### 2. Distill and export

```bash
bun run src/cli.ts distill "OpenClaw 记忆系统" --profile writing
bun run src/cli.ts brief "OpenClaw 记忆系统" --profile writing
bun run src/cli.ts export "OpenClaw 记忆系统" --profile writing --format md
```

### 3. Pin and recall again

```bash
bun run src/cli.ts pin a2597723 --query "telegram bridge"
bun run src/cli.ts search "telegram bridge" --scope asset --profile debug
```

### 4. Inspect structured assets

```bash
bun run src/cli.ts assets
```

## UI Workbench

Run:

```bash
bun run src/ui-server.ts
```

If port `4317` is already occupied:

```bash
RECALLNEST_UI_PORT=4321 bun run src/ui-server.ts
```

Open:

```text
http://localhost:4317
```

Current UI surfaces:

| Surface | Capability |
|------|------|
| Query Console | search / explain / distill / export |
| Result Surface | structured cards with memory ID, score, scope, retrieval path |
| View Switch | `Search / Assets / Exports` |
| Recall Actions | click-to-pin, create brief, or paste short ID |
| Trace Output | raw explain/distill trace |
| Stats Panel | index stats |
| Assets Panel | recent structured assets |

## Configuration

Edit `config.json`.

| Field | Description |
|------|-------------|
| `dbPath` | LanceDB storage path |
| `sources.cc.path` | `auto` or an explicit Claude Code transcript directory |
| `sources.codex.path` | Codex sessions directory |
| `sources.gemini.path` | Gemini CLI session directory (coming soon — encrypted protobuf, not yet supported) |
| `sources.memory.path` | Markdown memory directory |
| `embedding` | OpenAI-compatible embedding config |
| `retrieval` | Base retrieval defaults before mode overrides |

Config lookup order:

| Priority | Path |
|------|------|
| 1 | `LOCAL_MEMORY_CONFIG` env var |
| 2 | project `config.json` |
| 3 | `~/.config/recallnest/config.json` |
| 4 | `~/.config/local-memory/config.json` |

## Branding

| Item | Value |
|------|------|
| Public name | `RecallNest` |
| CLI | `recallnest` |
| MCP server name | `recallnest` |
| GitHub repo | `AliceLJY/recallnest` |
| Local directory | any path works |

## Roadmap

The next build phase is tracked in [ROADMAP.md](./ROADMAP.md).
Retrieval quality changes should be tracked with [EVAL.md](./EVAL.md).
Common operator actions live in [OPERATIONS.md](./OPERATIONS.md).
Observed misses and weak hits should be logged in [FAILURES.md](./FAILURES.md).
The short demo flow for screenshots and social posts lives in [DEMO.md](./DEMO.md).

Current focus:

| Track | Goal |
|------|------|
| Retrieval Quality | Improve hit quality with evals, failure review, and asset hygiene |
| MCP + UI Product | Keep RecallNest easy to operate through agents and the workbench |
| Writing Workflow | Turn recall into reusable briefs and article inputs |

## Eval

When retrieval changes, do not rely on intuition alone.

Run:

```bash
bun run src/eval.ts --output eval/reports/latest.md
```

Starter cases live in:

```text
eval/cases.json
```

Operator memo:

```text
EVAL.md
```

## Architecture

| File | Role |
|------|------|
| `src/cli.ts` | CLI entry |
| `src/mcp-server.ts` | MCP tools |
| `src/ui-server.ts` | local web UI server |
| `src/ingest.ts` | multi-source transcript parsing |
| `src/store.ts` | LanceDB storage and FTS |
| `src/retriever.ts` | hybrid retrieval pipeline |
| `src/retrieval-profiles.ts` | task-oriented retrieval profiles |
| `src/memory-output.ts` | search/explain/distill rendering |
| `src/memory-assets.ts` | pin/export asset storage |
| `src/asset-sync.ts` | pinned asset re-indexing |

## Credit

| Source | Contribution |
|------|------|
| Claude Code | Foundation and early project scaffolding |
| OpenAI Codex | Productization, branding pass, MCP/UI expansion |
| [memory-lancedb-pro](https://github.com/win4r/memory-lancedb-pro) by [@win4r](https://github.com/win4r) | Retrieval core ideas and implementation base for `store`, `retriever`, `embedder`, `chunker`, and `noise-filter` |

RecallNest extracts that retrieval core and rebuilds it into a local-first memory workbench.

## Acknowledgements

Special thanks to 秦超老师 ([`@win4r`](https://github.com/win4r)). The retrieval design direction behind RecallNest comes directly from the `memory-lancedb-pro` line of thinking: hybrid retrieval, reranking, scope-aware recall, and building memory as an engineering system instead of a simple vector demo.

## License

MIT
