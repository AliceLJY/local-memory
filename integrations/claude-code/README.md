# Claude Code Integration

> Claude Code 接入指南：配 MCP + 安装 continuity 规则，让 CC 在新窗口里主动恢复稳定上下文。

## Quick Start

```bash
# One-click setup (idempotent, safe to re-run)
bash integrations/claude-code/setup.sh
```

This does two things:

1. **Adds RecallNest MCP server** to `~/.claude.json`
2. **Installs a managed RecallNest block** in `~/.claude/CLAUDE.md`

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
| `checkpoint_session` | Save the current active work state before switching windows |
| `latest_checkpoint` | Inspect the latest saved checkpoint by session or scope |
| `resume_context` | Compose startup context for a fresh window |
| `store_memory` | Store durable cross-window knowledge |
| `store_workflow_pattern` | Store reusable workflows as durable patterns |

## Continuity Rules

The setup script installs [claude-md-snippet.md](claude-md-snippet.md) into your global `~/.claude/CLAUDE.md` inside a managed block.

Re-run `setup.sh` after upgrading RecallNest if you want the managed block refreshed.

The installed rules tell Claude Code to:

- call `resume_context` at the start of fresh windows or continuity-sensitive tasks
- use `search_memory` only as a follow-up when a specific detail is needed
- save `checkpoint_session` before leaving resumable work
- promote durable facts with `store_memory` and reusable workflows with `store_workflow_pattern`

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

### 2. Add Rules

Copy [claude-md-snippet.md](claude-md-snippet.md) into `~/.claude/CLAUDE.md` or your project `CLAUDE.md`.

### 3. Verify

Restart Claude Code, then ask: "resume my context for RecallNest continuity work"

If `resume_context` or `search_memory` is called and returns results, you're set.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `search_memory` or `resume_context` not found | Restart CC after editing `~/.claude.json` |
| Empty results | Run `bun run ingest` to index your conversations first |
| Fresh windows still feel stateless | Check that `~/.claude/CLAUDE.md` contains the `recallnest-continuity` managed block |
| MCP connection error | Check that `bun` is in your PATH and RecallNest path is correct |
