# Codex Integration

> Codex 接入指南：一键配 MCP，让 Codex 也能搜索 RecallNest 记忆。

## Quick Start

```bash
bash integrations/codex/setup.sh
```

## What It Does

Adds RecallNest as an MCP server in `~/.codex/config.toml`.

## Manual Setup

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.recallnest]
command = "bun"
args = ["run", "RECALLNEST_PATH/src/mcp-server.ts"]
```

Replace `RECALLNEST_PATH` with your actual path.

## Shared Index

Same LanceDB index as Claude Code and Gemini CLI — all three share memories.

## Verify

Start Codex and ask: "search memory for project setup decisions"
