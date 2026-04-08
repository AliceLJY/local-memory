#!/usr/bin/env bash
# RecallNest — setup all three terminals at once (idempotent)
# Usage: bash integrations/setup-all.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "RecallNest — setting up all terminals"
echo "======================================"
echo ""

echo "--- Claude Code ---"
bash "$SCRIPT_DIR/claude-code/setup.sh"
echo ""

echo "--- Codex ---"
bash "$SCRIPT_DIR/codex/setup.sh"
echo ""

echo "--- Gemini CLI ---"
bash "$SCRIPT_DIR/gemini-cli/setup.sh"
echo ""

echo "======================================"
echo "All terminals configured."
echo ""
echo "Next steps:"
echo "  1. Restart each terminal"
echo "  2. Run: bun run seed:continuity"
echo "  3. Run: bun run src/cli.ts doctor"
