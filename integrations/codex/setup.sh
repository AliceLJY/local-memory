#!/usr/bin/env bash
# RecallNest — Codex MCP setup (idempotent)
# Usage: bash integrations/codex/setup.sh

set -euo pipefail

CODEX_CONFIG="$HOME/.codex/config.toml"
CODEX_AGENTS="$HOME/.codex/AGENTS.md"
CODEX_DIR="$HOME/.codex"
RECALLNEST_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MCP_ENTRY="$RECALLNEST_DIR/src/mcp-server.ts"
RULES_SNIPPET="$RECALLNEST_DIR/integrations/codex/agents-md-snippet.md"
RULES_HELPER="$RECALLNEST_DIR/integrations/shared/install-managed-block.sh"

if [[ ! -f "$MCP_ENTRY" ]]; then
  echo "ERROR: $MCP_ENTRY not found. Run this from the recallnest repo root."
  exit 1
fi

if [[ ! -f "$RULES_HELPER" ]]; then
  echo "ERROR: $RULES_HELPER not found."
  exit 1
fi

# Create ~/.codex/ if missing
mkdir -p "$CODEX_DIR"

# Create config.toml if missing
if [[ ! -f "$CODEX_CONFIG" ]]; then
  touch "$CODEX_CONFIG"
  echo "Created $CODEX_CONFIG"
fi

# Check if already configured
if grep -q '\[mcp_servers\.recallnest\]' "$CODEX_CONFIG" 2>/dev/null; then
  echo "RecallNest MCP already configured in $CODEX_CONFIG — skipping."
else
  cat >> "$CODEX_CONFIG" <<EOF

[mcp_servers.recallnest]
command = "bun"
args = ["run", "$MCP_ENTRY"]
EOF
  echo "Added RecallNest MCP to $CODEX_CONFIG"
fi

. "$RULES_HELPER"
install_managed_markdown_block "$RULES_SNIPPET" "$CODEX_AGENTS" "recallnest-continuity"
echo "Installed RecallNest continuity rules in $CODEX_AGENTS"

echo ""
echo "Setup complete. Restart Codex to activate."
echo ""
echo "Managed snippet source:"
echo "  $RULES_SNIPPET"
