#!/bin/bash
# RecallNest MCP Server startup script
# Handles first-run bun install automatically
set -e

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$PLUGIN_DIR/node_modules" ]; then
  cd "$PLUGIN_DIR" && bun install --frozen-lockfile --silent 2>/dev/null
fi

exec bun run "$PLUGIN_DIR/src/mcp-server.ts"
