#!/usr/bin/env bash
# RecallNest — Gemini CLI MCP setup (idempotent)
# Usage: bash integrations/gemini-cli/setup.sh

set -euo pipefail

GEMINI_SETTINGS="$HOME/.gemini/settings.json"
GEMINI_DIR="$HOME/.gemini"
RECALLNEST_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MCP_ENTRY="$RECALLNEST_DIR/src/mcp-server.ts"

if [[ ! -f "$MCP_ENTRY" ]]; then
  echo "ERROR: $MCP_ENTRY not found. Run this from the recallnest repo root."
  exit 1
fi

# Create ~/.gemini/ and settings.json if missing
mkdir -p "$GEMINI_DIR"
if [[ ! -f "$GEMINI_SETTINGS" ]]; then
  echo '{}' > "$GEMINI_SETTINGS"
  echo "Created $GEMINI_SETTINGS"
fi

# Check if already configured
if bun -e "
  const c = JSON.parse(require('fs').readFileSync('$GEMINI_SETTINGS','utf8'));
  process.exit(c.mcpServers?.recallnest ? 0 : 1);
" 2>/dev/null; then
  echo "RecallNest MCP already configured in $GEMINI_SETTINGS — skipping."
else
  bun -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$GEMINI_SETTINGS','utf8'));
    if (!c.mcpServers) c.mcpServers = {};
    c.mcpServers.recallnest = {
      command: 'bun',
      args: ['run', '$MCP_ENTRY'],
      trust: true
    };
    fs.writeFileSync('$GEMINI_SETTINGS', JSON.stringify(c, null, 2) + '\n');
  "
  echo "Added RecallNest MCP to $GEMINI_SETTINGS"
fi

echo ""
echo "Setup complete. Restart Gemini CLI to activate."
