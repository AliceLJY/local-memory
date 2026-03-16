# Gemini CLI Integration

> Gemini CLI 接入指南：一键配 MCP + continuity 规则，让 Gemini CLI 在新窗口里主动恢复稳定上下文。

## Quick Start

```bash
bash integrations/gemini-cli/setup.sh
```

## What It Does

- Adds RecallNest as an MCP server in `~/.gemini/settings.json` with `trust: true`
- Installs a managed RecallNest block in `~/.gemini/GEMINI.md`

## Continuity Rules

The managed block comes from [gemini-md-snippet.md](gemini-md-snippet.md) and tells Gemini CLI to:

- call `resume_context` at the start of fresh windows or continuity-sensitive tasks
- use `search_memory` only when it needs a specific follow-up detail
- save `checkpoint_session` before leaving resumable work
- capture durable facts with `store_memory` and reusable workflows with `store_workflow_pattern`

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

Then copy [gemini-md-snippet.md](gemini-md-snippet.md) into `~/.gemini/GEMINI.md` if you are not using `setup.sh`.

## Verify

Start Gemini CLI and ask: "resume my context for RecallNest continuity work"

If `resume_context` or `search_memory` is called, you're set.
