# Antigravity CLI (agy) Integration

> agy 接入指南：一键配 MCP + continuity 规则，让 agy 在新窗口里主动恢复稳定上下文。

> **Note on naming.** Google retired the standalone `gemini` CLI for personal
> accounts on 2026-06-18; the [Antigravity CLI](https://antigravity.google)
> (`agy`) is its successor. This integration targets `agy`. If you are on a
> Code Assist Standard/Enterprise plan and still run the legacy CLI, point the
> same MCP entry at whatever config file your build reads.

## Quick Start

```bash
bash integrations/agy/setup.sh
```

## What It Does

- Adds RecallNest as an MCP server in `~/.gemini/config/mcp_config.json`
- Installs a managed RecallNest block in `~/.gemini/config/GEMINI.md`

## Continuity Rules

The managed block comes from [agy-md-snippet.md](agy-md-snippet.md) and tells agy to:

- call `resume_context` at the start of fresh windows or continuity-sensitive tasks
- run lightweight `search_memory` on task pivots inside the same project before repo exploration drifts
- reuse known `scope` / `sessionId` and the resolved scope returned by `resume_context` in follow-up recall calls
- treat recalled or startup-hook repo state as unverified until this window explicitly checks the repo
- save `checkpoint_session` before leaving resumable work
- do not inspect repo state just to enrich a close-window checkpoint unless the user explicitly asked for repo state
- do not write unverified repo-state claims into `checkpoint_session`
- capture durable facts with `store_memory` and reusable workflows with `store_workflow_pattern`

## Shared Index

agy shares the same LanceDB index as Claude Code, Codex and Kimi. Memories ingested from any source are searchable by all of them.

## Manual Setup

Add to `~/.gemini/config/mcp_config.json`:

```json
{
  "mcpServers": {
    "recallnest": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "RECALLNEST_PATH/src/mcp-server.ts"]
    }
  }
}
```

Replace `RECALLNEST_PATH` with your actual path.

Then copy [agy-md-snippet.md](agy-md-snippet.md) into `~/.gemini/config/GEMINI.md` if you are not using `setup.sh`.

## Tool Permissions

agy gates tool calls separately from MCP registration. In non-interactive mode
(`agy -p`) it cannot prompt, so permission-requiring tools are auto-denied and
the agent silently returns nothing. If RecallNest tools appear registered but
never fire, set `toolPermission` in `~/.gemini/antigravity-cli/settings.json`,
or pass `--dangerously-skip-permissions` for a single run.

## Verify

```bash
agy -p "resume my context for RecallNest continuity work" --print-timeout 180s </dev/null
```

If `resume_context` or `search_memory` is called, you're set.
