# MCP Tool Surface Tiering Plan

## Goal
Reduce MCP tool surface from 24 to ~10 for daily agents, moving governance tools to CLI-only.

## Current Tools (24)

### Tier 1: Core (5) — Always Exposed
- `resume_context` — startup continuity
- `search_memory` — proactive recall
- `store_memory` — durable write
- `checkpoint_session` — work handoff
- `latest_checkpoint` — checkpoint read

### Tier 2: Advanced (10) — Exposed by Default
- `store_case` — structured case write
- `store_workflow_pattern` — structured pattern write
- `promote_memory` — evidence → durable
- `explain_memory` — retrieval explain
- `distill_memory` — compact briefing
- `brief_memory` — create brief asset
- `pin_memory` — pin for reuse
- `list_assets` — list assets
- `list_pins` — list pins
- `memory_stats` — db stats

### Tier 3: Governance (9) — CLI Only, Not MCP
- `workflow_observe`
- `workflow_health`
- `workflow_evidence`
- `list_conflicts`
- `resolve_conflict`
- `audit_conflicts`
- `escalate_conflicts`
- `list_dirty_briefs`
- `clean_dirty_briefs`

## Implementation

### Step 1: Add Tier Config
Add to `mcp-server.ts`:

```typescript
// Environment: RECALLNEST_MCP_TIER=core|advanced|full (default: advanced)
const MCP_TIER = process.env.RECALLNEST_MCP_TIER || "advanced";

const TOOL_TIERS: Record<string, "core" | "advanced" | "governance"> = {
  // Core (always)
  resume_context: "core",
  search_memory: "core",
  store_memory: "core",
  checkpoint_session: "core",
  latest_checkpoint: "core",

  // Advanced
  store_case: "advanced",
  store_workflow_pattern: "advanced",
  promote_memory: "advanced",
  explain_memory: "advanced",
  distill_memory: "advanced",
  brief_memory: "advanced",
  pin_memory: "advanced",
  list_assets: "advanced",
  list_pins: "advanced",
  memory_stats: "advanced",
  export_memory: "advanced",

  // Governance (CLI-only)
  workflow_observe: "governance",
  workflow_health: "governance",
  workflow_evidence: "governance",
  list_conflicts: "governance",
  resolve_conflict: "governance",
  audit_conflicts: "governance",
  escalate_conflicts: "governance",
  list_dirty_briefs: "governance",
  clean_dirty_briefs: "governance",
};

function shouldRegisterTool(toolName: string): boolean {
  const tier = TOOL_TIERS[toolName];
  if (!tier) return true; // unknown tools always register
  if (MCP_TIER === "full") return true;
  if (MCP_TIER === "advanced") return tier !== "governance";
  if (MCP_TIER === "core") return tier === "core";
  return true;
}
```

### Step 2: Wrap Tool Registrations
Replace `server.tool()` calls with conditional registration:

```typescript
function registerTool(...) {
  if (!shouldRegisterTool(name)) {
    console.log(`[MCP] Skipping ${name} (tier: ${TOOL_TIERS[name]})`);
    return;
  }
  server.tool(name, description, schema, handler);
}
```

### Step 3: Update CLI for Governance Tools
Ensure governance tools are fully accessible via CLI:
- `recallnest workflow-observe ...` → already exists
- `recallnest conflicts list ...` → already exists
- Add `recallnest dirty-briefs list/clean` if missing

## Testing

1. Default run: `bun src/mcp-server.ts` → should register ~15 tools (core + advanced)
2. Tier=core: `RECALLNEST_MCP_TIER=core bun src/mcp-server.ts` → 5 tools
3. Tier=full: `RECALLNEST_MCP_TIER=full bun src/mcp-server.ts` → 24 tools (backward compatible)
4. Smoke test: MCP import works for all tiers

## Files to Modify

- `src/mcp-server.ts` — add tier config + conditional registration

## Verification

```bash
cd ~/recallnest
RECALLNEST_MCP_TIER=core bun src/mcp-server.ts &
# Check logs for registered tools
```
