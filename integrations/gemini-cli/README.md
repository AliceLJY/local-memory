# Gemini CLI Integration

> Gemini CLI 接入指南：一键配 MCP，让 Gemini 也能搜索 RecallNest 记忆。

## Quick Start

```bash
bash integrations/gemini-cli/setup.sh
```

## What It Does

Adds RecallNest as an MCP server in `~/.gemini/settings.json` with `trust: true` (required for Gemini CLI to use MCP tools without confirmation prompts).

## Shared Index

Gemini CLI shares the same LanceDB index as Claude Code and Codex. Memories ingested from any source are searchable by all three.

## Manual Setup

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "recallnest": {
      "command": "bun",
      "args": ["run", "RECALLNEST_PATH/src/mcp-server.ts"],
      "trust": true
    }
  }
}
```

Replace `RECALLNEST_PATH` with your actual path.

## Verify

Start Gemini CLI and ask: "search memory for recent debugging sessions"

If `search_memory` is called, you're set.
