#!/usr/bin/env bash
# RecallNest — Antigravity CLI (agy) MCP setup (idempotent)
# Usage: bash integrations/agy/setup.sh
#
# Google retired the standalone Gemini CLI for personal accounts on 2026-06-18.
# Its successor is the Antigravity CLI (`agy`), which reads MCP servers from
# ~/.gemini/config/mcp_config.json — not the old ~/.gemini/settings.json.

set -euo pipefail

AGY_CONFIG_DIR="$HOME/.gemini/config"
AGY_MCP_CONFIG="$AGY_CONFIG_DIR/mcp_config.json"
AGY_MD="$AGY_CONFIG_DIR/GEMINI.md"
RECALLNEST_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MCP_ENTRY="$RECALLNEST_DIR/src/mcp-server.ts"
RULES_SNIPPET="$RECALLNEST_DIR/integrations/agy/agy-md-snippet.md"
RULES_HELPER="$RECALLNEST_DIR/integrations/shared/install-managed-block.sh"

if [[ ! -f "$MCP_ENTRY" ]]; then
  echo "ERROR: $MCP_ENTRY not found. Run this from the recallnest repo root."
  exit 1
fi

if [[ ! -f "$RULES_HELPER" ]]; then
  echo "ERROR: $RULES_HELPER not found."
  exit 1
fi

if ! command -v agy >/dev/null 2>&1; then
  echo "WARNING: 'agy' not found on PATH. Install the Antigravity CLI first:"
  echo "  https://antigravity.google"
  echo "Continuing anyway — the config will be written for when agy is installed."
  echo ""
fi

mkdir -p "$AGY_CONFIG_DIR"
if [[ ! -f "$AGY_MCP_CONFIG" ]]; then
  echo '{"mcpServers":{}}' > "$AGY_MCP_CONFIG"
  echo "Created $AGY_MCP_CONFIG"
fi

# Check if already configured
if bun -e "
  const c = JSON.parse(require('fs').readFileSync('$AGY_MCP_CONFIG','utf8'));
  process.exit(c.mcpServers?.recallnest ? 0 : 1);
" 2>/dev/null; then
  echo "RecallNest MCP already configured in $AGY_MCP_CONFIG — skipping."
else
  bun -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$AGY_MCP_CONFIG','utf8'));
    if (!c.mcpServers) c.mcpServers = {};
    c.mcpServers.recallnest = {
      type: 'stdio',
      command: 'bun',
      args: ['run', '$MCP_ENTRY']
    };
    fs.writeFileSync('$AGY_MCP_CONFIG', JSON.stringify(c, null, 2) + '\n');
  "
  echo "Added RecallNest MCP to $AGY_MCP_CONFIG"
fi

. "$RULES_HELPER"
install_managed_markdown_block "$RULES_SNIPPET" "$AGY_MD" "recallnest-continuity"
echo "Installed RecallNest continuity rules in $AGY_MD"

echo ""
echo "Setup complete. Restart agy to activate, then verify with:"
echo "  agy -p 'List your available MCP tools' --print-timeout 180s </dev/null"
echo ""
echo "Continuity baseline seed:"
echo "  (cd \"$RECALLNEST_DIR\" && bun run seed:continuity)"
echo ""
echo "Managed snippet source:"
echo "  $RULES_SNIPPET"
