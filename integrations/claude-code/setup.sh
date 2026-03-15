#!/usr/bin/env bash
# RecallNest — Claude Code MCP setup (idempotent)
# Usage: bash integrations/claude-code/setup.sh

set -euo pipefail

CLAUDE_JSON="$HOME/.claude.json"
RECALLNEST_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MCP_ENTRY="$RECALLNEST_DIR/src/mcp-server.ts"

# Verify mcp-server.ts exists
if [[ ! -f "$MCP_ENTRY" ]]; then
  echo "ERROR: $MCP_ENTRY not found. Run this from the recallnest repo root."
  exit 1
fi

# Create ~/.claude.json if missing
if [[ ! -f "$CLAUDE_JSON" ]]; then
  echo '{}' > "$CLAUDE_JSON"
  echo "Created $CLAUDE_JSON"
fi

# Check if recallnest MCP is already configured
if bun -e "
  const c = JSON.parse(require('fs').readFileSync('$CLAUDE_JSON','utf8'));
  process.exit(c.mcpServers?.recallnest ? 0 : 1);
" 2>/dev/null; then
  echo "RecallNest MCP already configured in $CLAUDE_JSON — skipping."
else
  # Add recallnest to mcpServers using bun for safe JSON manipulation
  bun -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$CLAUDE_JSON','utf8'));
    if (!c.mcpServers) c.mcpServers = {};
    c.mcpServers.recallnest = {
      command: 'bun',
      args: ['run', '$MCP_ENTRY'],
      env: {}
    };
    fs.writeFileSync('$CLAUDE_JSON', JSON.stringify(c, null, 2) + '\n');
  "
  echo "Added RecallNest MCP to $CLAUDE_JSON"
fi

echo ""
echo "Setup complete. Restart Claude Code to activate."
echo ""
echo "Next step: copy the memory rules from"
echo "  $RECALLNEST_DIR/integrations/claude-code/claude-md-snippet.md"
echo "into your CLAUDE.md"
