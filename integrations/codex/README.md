# Codex Integration

> Codex 接入指南：一键配 MCP + continuity 规则，让 Codex 在新窗口里主动恢复稳定上下文。

## Quick Start

```bash
bash integrations/codex/setup.sh
```

## What It Does

- Adds RecallNest as an MCP server in `~/.codex/config.toml`
- Installs a managed RecallNest block in `~/.codex/AGENTS.md`

## Continuity Rules

The managed block comes from [agents-md-snippet.md](agents-md-snippet.md) and tells Codex to:

- call `resume_context` at the start of fresh windows or continuity-sensitive tasks
- use `search_memory` as a follow-up when a specific prior detail is needed
- save `checkpoint_session` before leaving resumable work
- capture durable facts with `store_memory` and reusable workflows with `store_workflow_pattern`

## Manual Setup

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.recallnest]
command = "bun"
args = ["run", "RECALLNEST_PATH/src/mcp-server.ts"]
```

Replace `RECALLNEST_PATH` with your actual path.

Then copy [agents-md-snippet.md](agents-md-snippet.md) into `~/.codex/AGENTS.md` or your repo-level `AGENTS.md`.

## Shared Index

Same LanceDB index as Claude Code and Gemini CLI — all three share memories.

## Verify

Start Codex and ask: "resume my context for RecallNest continuity work"
