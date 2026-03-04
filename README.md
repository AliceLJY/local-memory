# local-memory

Search your AI conversations locally — hybrid vector + keyword retrieval over Claude Code, Codex, and Gemini CLI transcripts.

## Features

- **Multi-source ingest**: Parses and indexes conversations from Claude Code (.jsonl), Codex (.jsonl), Gemini CLI (.json), and Markdown files
- **Hybrid retrieval**: Vector search (cosine similarity) + BM25 keyword search, fused via Reciprocal Rank Fusion (RRF)
- **Incremental updates**: Tracks processed files by path + size — only new or modified files get re-indexed
- **MCP server**: Expose search as a tool for any MCP-compatible AI client
- **CLI**: Search from your terminal in 2-3 seconds across 25,000+ indexed chunks

## Acknowledgments

The retrieval engine (store, retriever, embedder, chunker, noise-filter) is based on [memory-lancedb-pro](https://github.com/win4r/memory-lancedb-pro) by [@win4r](https://github.com/win4r). The original is an OpenClaw plugin for bot memory. This project extracts the core retrieval modules and adds multi-source ingest, incremental tracking, and MCP server integration for local conversation search.

## Setup

**Requirements**: [Bun](https://bun.sh) runtime, [Jina AI](https://jina.ai/) API key (free tier available)

```bash
git clone https://github.com/AliceLJY/local-memory.git
cd local-memory
npm install

cp .env.example .env
# Edit .env — add your Jina API key
```

## Configuration

Edit `config.json`:

| Field | Description |
|-------|-------------|
| `sources.cc.path` | `"auto"` to auto-detect, or path like `~/.claude/projects/-Users-yourname` |
| `sources.codex.path` | Codex sessions directory (default: `~/.codex/sessions`) |
| `sources.memory.path` | `"auto"` to auto-detect, or path to your markdown memory files |
| `embedding` | Jina v5 by default. Supports any OpenAI-compatible embedding API |

## Usage

### CLI

```bash
# Index all conversations
bun run src/cli.ts ingest --source all

# Index specific source
bun run src/cli.ts ingest --source cc
bun run src/cli.ts ingest --source codex
bun run src/cli.ts ingest --source gemini

# Search
bun run src/cli.ts search "docker deployment issue"
bun run src/cli.ts search "writing style" -n 10
bun run src/cli.ts search "API key" --scope cc

# Stats
bun run src/cli.ts stats

# Reset index
bun run src/cli.ts reset --yes
```

### MCP Server

Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "local-memory": {
      "command": "bun",
      "args": ["run", "/path/to/local-memory/src/mcp-server.ts"],
      "env": {
        "JINA_API_KEY": "your_key_here"
      }
    }
  }
}
```

Tools exposed:
- `search_memory` — Search indexed conversations (query, limit, scope filter)
- `memory_stats` — Show index statistics

### Automated Daily Updates

`scripts/incremental-ingest.sh` provides:
- 2-hour timeout protection (auto-kills if stuck)
- Incremental mode (skips already-processed files)
- Log rotation (keeps 7 days)

<details>
<summary>Example macOS LaunchAgent</summary>

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.local-memory.incremental-ingest</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/path/to/local-memory/scripts/incremental-ingest.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>3</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
</dict>
</plist>
```

</details>

## Architecture

```
src/
├── cli.ts          # CLI entry (search, ingest, stats, reset)
├── mcp-server.ts   # MCP server (search_memory, memory_stats)
├── ingest.ts       # Multi-source parsers + batch ingest pipeline
├── tracker.ts      # Incremental update tracking
├── store.ts        # LanceDB storage (vector + FTS)
├── retriever.ts    # Hybrid retrieval (vector + BM25 + RRF + rerank)
├── embedder.ts     # OpenAI-compatible embedding with cache
├── chunker.ts      # Smart document chunking
└── noise-filter.ts # Filter denial patterns and boilerplate
```

## Supported Data Sources

| Source | Format | Default location |
|--------|--------|------------------|
| Claude Code | .jsonl (user/assistant) | `~/.claude/projects/*/` |
| Codex | .jsonl (response_item/event_msg) | `~/.codex/sessions/` |
| Gemini CLI | .json (messages array) | `~/.gemini/tmp/*/chats/` |
| Markdown | .md (split by headings) | Configurable |

## Ecosystem

Part of the [AI小木屋](https://github.com/AliceLJY) toolkit:

| Project | Description |
|---------|-------------|
| [content-alchemy](https://github.com/AliceLJY/content-alchemy) | 5-stage content writing pipeline |
| [content-publisher](https://github.com/AliceLJY/content-publisher) | Image generation, layout formatting, WeChat publishing |
| [openclaw-worker](https://github.com/AliceLJY/openclaw-worker) | Task API + Docker compose for OpenClaw |
| [openclaw-cli-bridge](https://github.com/AliceLJY/openclaw-cli-bridge) | Three-way bridge: /cc /codex /gemini |
| [digital-clone-skill](https://github.com/AliceLJY/digital-clone-skill) | Build digital clones from corpus data |
| [cc-shell](https://github.com/AliceLJY/cc-shell) | Lightweight Claude Code chat UI |
| [telegram-ai-bridge](https://github.com/AliceLJY/telegram-ai-bridge) | Telegram AI bridge (tri-backend: Claude + Codex + Gemini) |
| [telegram-cli-bridge](https://github.com/AliceLJY/telegram-cli-bridge) | Telegram CLI bridge (Gemini CLI path) |

## Credits

- Retrieval engine: [memory-lancedb-pro](https://github.com/win4r/memory-lancedb-pro) by [@win4r](https://github.com/win4r)
- Embedding: [Jina AI](https://jina.ai/) v5
- Storage: [LanceDB](https://lancedb.github.io/lancedb/)

## License

MIT

---

## 中文说明

本地 AI 对话记忆搜索工具。把 Claude Code、Codex、Gemini CLI 的对话记录全量索引到 LanceDB，用向量+关键词混合检索，2-3 秒出结果。

**核心检索引擎**来自秦超老师的 [memory-lancedb-pro](https://github.com/win4r/memory-lancedb-pro)。原项目是 OpenClaw 的 bot 记忆插件，本项目抽出核心模块，加上多源导入管道、增量追踪、MCP server，做成本地对话搜索工具。

### 快速开始

```bash
git clone https://github.com/AliceLJY/local-memory.git
cd local-memory && npm install
cp .env.example .env  # 填入 Jina API key
bun run src/cli.ts ingest --source all  # 索引所有对话
bun run src/cli.ts search "关键词"       # 搜索
```

### MCP 集成

配置到 Claude Code 的 `settings.json`，对话时可直接搜索历史记忆，不用手动跑 CLI。

### 公众号

「我的AI小木屋」— 一个医学出身、文化口工作、AI 野路子的人，用 AI 搞事情的记录。

![WeChat QR](https://raw.githubusercontent.com/AliceLJY/local-memory/main/assets/wechat-qr.jpg)
