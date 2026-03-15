# RecallNest Integrations

> 集成总览：RecallNest 支持任何 AI agent 接入，以下是开箱即用的集成方案。

RecallNest provides two integration paths:

## MCP Server (for CLI tools)

Best for AI coding assistants that support Model Context Protocol natively.

| Tool | Setup | What it does |
|------|-------|-------------|
| [Claude Code](claude-code/) | `setup.sh` adds MCP to `~/.claude.json` | Memory search via `search_memory` tool |
| [Gemini CLI](gemini-cli/) | `setup.sh` adds MCP to `~/.gemini/settings.json` | Same MCP tools, shared index |
| [Codex](codex/) | `setup.sh` adds MCP to `~/.codex/config.toml` | Same MCP tools, shared index |

All three share the same LanceDB index — memories ingested by one are searchable by all.

## HTTP API (for agent frameworks)

Best for custom agents built with any SDK or language. Start the API server:

```bash
cd ~/recallnest && bun run api
# Server runs on http://localhost:4318
```

Then call it from your agent:

| Framework | Example | Language |
|-----------|---------|----------|
| [Claude Agent SDK](examples/claude-agent-sdk/) | `memory-agent.ts` | TypeScript |
| [OpenAI Agents SDK](examples/openai-agents-sdk/) | `memory-agent.py` | Python |
| [LangChain](examples/langchain/) | `memory-chain.py` | Python |

> 任何能发 HTTP 请求的语言都能接入，以上只是参考示例。

## Architecture

```
Your Agent (any framework, any language)
    │
    ├──► MCP Server (stdio)     ← CLI tools use this
    │       │
    └──► HTTP API (port 4318)   ← Agent frameworks use this
            │
            ▼
    RecallNest Core Engine
    (Hybrid Retrieval + 6-Category + Weibull Decay)
            │
            ▼
    LanceDB + Jina Embeddings
```

## API Reference

See [docs/api-reference.md](../docs/api-reference.md) for full HTTP API documentation.
