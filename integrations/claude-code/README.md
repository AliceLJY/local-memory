# Claude Code Integration

> Claude Code 接入指南：配 MCP + 加记忆检索规则，让 CC 自动搜索历史记忆。

## Quick Start

```bash
# One-click setup (idempotent, safe to re-run)
bash integrations/claude-code/setup.sh
```

This does two things:

1. **Adds RecallNest MCP server** to `~/.claude.json`
2. Prints the memory retrieval snippet for your `CLAUDE.md`

## What You Get

After setup, Claude Code gains access to these MCP tools:

| Tool | Description |
|------|-------------|
| `search_memory` | Search past conversations by semantic similarity |
| `memory_stats` | Show memory index statistics |
| `brief_memory` | Generate a brief summary of a topic |
| `distill_memory` | Distill and consolidate related memories |
| `pin_memory` | Pin important memories for permanent retention |
| `explain_memory` | Explain what RecallNest knows about a topic |
| `export_memory` | Export memories to markdown |

## Add Memory Rules to CLAUDE.md

Copy the snippet from [claude-md-snippet.md](claude-md-snippet.md) into your project's `CLAUDE.md` or global `~/.claude/CLAUDE.md`.

> 这段规则让 CC 在每次任务开始时主动搜索记忆，不需要你手动提醒。

## Manual Setup

If you prefer to configure manually:

### 1. Add MCP Server

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "recallnest": {
      "command": "bun",
      "args": ["run", "RECALLNEST_PATH/src/mcp-server.ts"],
      "env": {}
    }
  }
}
```

Replace `RECALLNEST_PATH` with your actual RecallNest directory (e.g., `/Users/you/recallnest`).

### 2. Verify

Restart Claude Code, then ask: "search my memory for Docker debugging"

If `search_memory` is called and returns results, you're set.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `search_memory` not found | Restart CC after editing `~/.claude.json` |
| Empty results | Run `bun run ingest` to index your conversations first |
| MCP connection error | Check that `bun` is in your PATH and RecallNest path is correct |
