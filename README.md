# RecallNest

> MCP-native memory workbench for AI conversations.
> Foundation built with Claude Code. Productization and UI expansion completed with OpenAI Codex.

RecallNest turns Claude Code, Codex, Gemini, and markdown notes into a local-first recall layer you can search, explain, distill, pin, and export.

## At A Glance

| Problem | RecallNest answer |
|------|------|
| Too many transcripts, no recall | Hybrid vector + BM25 retrieval |
| Hits are opaque | Explain mode with source, file, path, and score trace |
| Raw chunks are not reusable | Distill mode turns hits into a briefing |
| Good memories disappear again | Pin turns them into reusable assets |
| Assets stay isolated | Pinned assets are re-indexed into `asset:*` recall scope |
| CLI is hard to demo | Local web workbench at `http://localhost:4317` |

## Product Shape

| Layer | What it does |
|------|------|
| Ingest | Parse Claude Code, Codex, Gemini CLI, Markdown |
| Store | LanceDB vector store + FTS |
| Retrieve | Hybrid search + rerank + time-aware scoring |
| Explain | Show why a memory matched |
| Distill | Produce briefings and evidence bundles |
| Assetize | Pin reusable memory into long-lived assets |
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
| CLI | `search`, `explain`, `distill`, `pin`, `pins`, `export`, `profiles` |
| MCP | `search_memory`, `explain_memory`, `distill_memory`, `pin_memory`, `list_pins`, `export_memory`, `memory_stats` |
| UI | query console, source-grouped cards, one-click pin, pins/exports views, stats, pinned assets |

## Quick Start

```bash
git clone https://github.com/AliceLJY/recallnest.git
cd recallnest
npm install
cp .env.example .env

# index your memory
bun run src/cli.ts ingest --source all

# open the local workbench
bun run src/ui-server.ts
# then visit http://localhost:4317
```

## Common Flows

### 1. Search and explain

```bash
bun run src/cli.ts search "telegram bridge" --profile debug
bun run src/cli.ts explain "telegram bridge" --profile debug
```

### 2. Distill and export

```bash
bun run src/cli.ts distill "OpenClaw 记忆系统" --profile writing
bun run src/cli.ts export "OpenClaw 记忆系统" --profile writing --format md
```

### 3. Pin and recall again

```bash
bun run src/cli.ts pin a2597723 --query "telegram bridge"
bun run src/cli.ts search "telegram bridge" --scope asset --profile debug
```

## UI Workbench

Run:

```bash
bun run src/ui-server.ts
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
| View Switch | `Search / Pins / Exports` |
| Recall Actions | click-to-pin or paste short ID |
| Trace Output | raw explain/distill trace |
| Stats Panel | index stats |
| Pins Panel | recent pinned assets |

## Configuration

Edit `config.json`.

| Field | Description |
|------|-------------|
| `dbPath` | LanceDB storage path |
| `sources.cc.path` | `auto` or an explicit Claude Code transcript directory |
| `sources.codex.path` | Codex sessions directory |
| `sources.gemini.path` | Gemini CLI session directory |
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
