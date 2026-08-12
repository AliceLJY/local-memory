#!/bin/bash
# RecallNest MCP Server startup script
# Handles first-run plugin data setup and bun install automatically
set -e

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
  CONFIG_PATH="${LOCAL_MEMORY_CONFIG:-$CLAUDE_PLUGIN_DATA/config.json}"
  mkdir -p "$(dirname "$CONFIG_PATH")" "$CLAUDE_PLUGIN_DATA/lancedb"

  if [ ! -f "$CONFIG_PATH" ]; then
    bun -e '
      const [configPath, dbPath] = process.argv.slice(1);
      const config = {
        dbPath,
        recallMode: "summary",
        embedding: {
          provider: "jina",
          apiKey: "${JINA_API_KEY}",
          model: "jina-embeddings-v5-text-small",
          baseURL: "https://api.jina.ai/v1",
          dimensions: 1024,
          taskQuery: "retrieval.query",
          taskPassage: "retrieval.passage"
        },
        sources: {
          cc: { path: "auto", glob: "*.jsonl", description: "Claude Code transcripts" },
          codex: { path: "~/.codex/sessions", glob: "*.jsonl", description: "Codex sessions" },
          memory: { path: "auto", glob: "*.md", description: "Claude Code memory files" }
        },
        retrieval: {
          mode: "vector",
          vectorWeight: 0.7,
          bm25Weight: 0.3,
          recencyHalfLifeDays: 30,
          timeDecayHalfLifeDays: 120,
          hardMinScore: 0.3
        }
      };
      await Bun.write(configPath, JSON.stringify(config, null, 2) + "\n");
    ' -- "$CONFIG_PATH" "$CLAUDE_PLUGIN_DATA/lancedb"
  fi
fi

if [ ! -d "$PLUGIN_DIR/node_modules" ]; then
  cd "$PLUGIN_DIR" && bun install --frozen-lockfile --ignore-scripts --silent 2>/dev/null
fi

exec bun run "$PLUGIN_DIR/src/mcp-server.ts"
