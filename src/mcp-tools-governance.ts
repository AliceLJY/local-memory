import { z } from "zod";
import { ALIAS_RULES, expandQueryWithAliases, explainAliasExpansion } from "./aliases.js";
import { buildConflictAuditSummary, clusterConflicts } from "./conflict-advisor.js";
import { resolveConflictCandidate } from "./conflict-engine.js";
import { escalateConflicts } from "./conflict-escalation.js";
import { CONFLICT_ATTENTION_LEVELS, summarizeConflictLifecycle } from "./conflict-lifecycle.js";
import { formatConflictAudit, formatConflictClusters, formatConflictEscalation, formatConflictList, formatConflictRecord, formatConflictResolution } from "./conflict-output.js";
import { ConflictStatusSchema } from "./conflict-schema.js";
import { ConsolidationEngine, formatConsolidationResult } from "./consolidation-engine.js";
import { archiveDirtyBriefAsset, listDirtyBriefAssets } from "./memory-assets.js";
import { scanMemoryPromotions, buildPromoteScanDeps, formatPromoteScanResult } from "./memory-promotion.js";
import { aliasMapFilePath, expandQuery, explainUserAliases, listUserAliases, removeUserAlias, upsertUserAlias } from "./query-expander.js";
import { recordSkillOutcome } from "./skill-engine.js";
import { scanForPromotions, formatPromotionResult } from "./skill-promotion.js";
import { buildWorkflowEvidence, buildWorkflowObservationRecord, inspectWorkflowDashboard, inspectWorkflowHealth } from "./workflow-observation-engine.js";
import { formatWorkflowEvidencePack, formatWorkflowHealthDashboard, formatWorkflowHealthReport, formatWorkflowObservationSaved } from "./workflow-observation-output.js";
import { WorkflowObservationOutcomeSchema } from "./workflow-observation-schema.js";
import type { ToolRegistryDeps } from "./mcp-tool-deps.js";
import { withLock } from "./distill-lock.js";

export function registerGovernanceTools(deps: ToolRegistryDeps): void {
  const { registerTool, getComponents, conflictStore, workflowObservationStore, getKGExtractor } = deps;

registerTool(
  "workflow_observe",
  "Store an append-only workflow observation for self-evolution. Use this to record whether a continuity primitive or reusable workflow succeeded, failed, was corrected by the user, or was missed entirely. Optionally pass `skillId` to also bump that skill's successCount/failureCount — the canonical way to close the skill feedback loop.",
  {
    workflowId: z.string().min(1).max(120).describe("Workflow primitive id, such as resume_context or checkpoint_session"),
    outcome: WorkflowObservationOutcomeSchema.default("success").describe("success | failure | corrected | missed"),
    summary: z.string().min(1).max(400).describe("Short description of what happened"),
    scope: z.string().min(1).max(160).optional().describe("Optional scope such as project:recallnest"),
    source: z.string().min(1).max(40).default("agent").describe("Source label such as agent, smoke, eval, or manual"),
    signal: z.string().min(1).max(120).optional().describe("Optional failure/correction signal tag"),
    task: z.string().min(1).max(240).optional().describe("Optional related task"),
    tags: z.array(z.string().min(1).max(40)).max(8).default([]).describe("Optional tags"),
    tools: z.array(z.string().min(1).max(60)).max(6).default([]).describe("Optional tools involved"),
    skillId: z.string().min(1).max(128).optional().describe("Optional skill id to bump. When present and outcome is success, the skill's successCount increments; otherwise failureCount increments. Missing/corrupt skills are skipped silently (does not block observation write)."),
    idempotencyKey: z.string().min(1).max(160).optional().describe("Optional stable request key; repeated saves with the same key replace the prior observation"),
  },
  async ({ workflowId, outcome, summary, scope, source, signal, task, tags, tools, skillId, idempotencyKey }) => {
    const record = buildWorkflowObservationRecord({
      workflowId,
      outcome,
      summary,
      scope,
      source,
      signal,
      task,
      tags,
      tools,
      skillId,
      idempotencyKey,
    });
    const stored = await workflowObservationStore.save(record);

    let skillOutcomeNote = "";
    if (skillId) {
      try {
        const { store } = getComponents();
        const result = await recordSkillOutcome(store, skillId, outcome);
        if (result.updated) {
          skillOutcomeNote = `\nSkill ${skillId.slice(0, 8)} → success=${result.successCount} failure=${result.failureCount}`;
        } else {
          console.warn(`[workflow_observe] skillId=${skillId} update skipped: ${result.reason}`);
          skillOutcomeNote = `\nSkill ${skillId.slice(0, 8)} → not updated (${result.reason})`;
        }
      } catch (err) {
        console.warn(`[workflow_observe] recordSkillOutcome threw for skillId=${skillId}:`, err);
        skillOutcomeNote = `\nSkill ${skillId.slice(0, 8)} → update errored, observation still saved`;
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: formatWorkflowObservationSaved(stored) + skillOutcomeNote,
      }],
    };
  },
);

registerTool(
  "workflow_health",
  "Inspect workflow observation health: 7d/30d report for one workflow or dashboard of degraded workflows. Read-only. Use when checking if continuity primitives are succeeding or degrading.",
  {
    workflowId: z.string().min(1).max(120).optional().describe("Optional workflow primitive id"),
    scope: z.string().min(1).max(160).optional().describe("Optional scope filter"),
    limit: z.number().int().min(1).max(30).default(10).describe("Dashboard result limit when workflowId is omitted"),
  },
  async ({ workflowId, scope, limit }) => {
    const text = workflowId
      ? formatWorkflowHealthReport(await inspectWorkflowHealth(workflowObservationStore, { workflowId, scope }))
      : formatWorkflowHealthDashboard(await inspectWorkflowDashboard(workflowObservationStore, { scope, limit }), scope);
    return {
      content: [{
        type: "text" as const,
        text,
      }],
    };
  },
);

registerTool(
  "workflow_evidence",
  "Generate an evidence pack for a workflow primitive with recent issues, top signals, and suggested actions. Read-only. Use when investigating why a workflow is degraded and you need concrete failure examples.",
  {
    workflowId: z.string().min(1).max(120).describe("Workflow primitive id, e.g. 'resume_context'"),
    scope: z.string().min(1).max(160).optional().describe("Scope filter, e.g. 'project:recallnest'"),
    limit: z.number().int().min(1).max(20).default(5).describe("Max recent issue observations to include"),
  },
  async ({ workflowId, scope, limit }) => {
    const pack = await buildWorkflowEvidence(workflowObservationStore, {
      workflowId,
      scope,
      limit,
    });
    return {
      content: [{
        type: "text" as const,
        text: formatWorkflowEvidencePack(pack),
      }],
    };
  },
);

registerTool(
  "list_conflicts",
  "List or inspect conflict candidates where promoted evidence disagrees with existing durable memory. Read-only. Use when reviewing pending conflicts before resolution.",
  {
    conflictId: z.string().min(1).max(128).optional().describe("Conflict ID to inspect a single record, e.g. 'c1d2e3f4'"),
    status: ConflictStatusSchema.optional().describe("Optional status filter"),
    attention: z.enum(CONFLICT_ATTENTION_LEVELS).optional().describe("Optional lifecycle filter: fresh / aging / stale / escalated / resolved"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional canonical key filter"),
    groupBy: z.enum(["record", "cluster"]).default("record").describe("Whether to list individual conflicts or grouped clusters"),
    limit: z.number().int().min(1).max(50).default(20).describe("Max conflicts to list"),
  },
  async ({ conflictId, status, attention, canonicalKey, groupBy, limit }) => {
    if (conflictId) {
      const record = await conflictStore.getById(conflictId);
      return {
        content: [{
          type: "text" as const,
          text: record ? formatConflictRecord(record) : `Conflict not found: ${conflictId}`,
        }],
      };
    }

    const records = (await conflictStore.listRecent({ status, canonicalKey, limit: Math.max(limit * 2, limit) }))
      .filter((record) => !attention || summarizeConflictLifecycle(record).attention === attention)
      .slice(0, limit);
    return {
      content: [{
        type: "text" as const,
        text: groupBy === "cluster"
          ? formatConflictClusters(clusterConflicts(records))
          : formatConflictList(records),
      }],
    };
  }
);

registerTool(
  "resolve_conflict",
  "Resolve a conflict candidate by keeping existing, accepting incoming, or merging texts. Side effect: updates conflict status and may modify durable memory. Use when list_conflicts shows open conflicts that need a decision.",
  {
    conflictId: z.string().min(1).max(128).describe("Conflict ID to resolve"),
    resolution: z.enum(["accept_incoming", "keep_existing", "merge"]).describe("How to resolve the conflict"),
    mergedText: z.string().min(1).max(2000).optional().describe("Optional merged text override when resolution is merge"),
    notes: z.string().min(1).max(320).optional().describe("Optional operator notes"),
  },
  async ({ conflictId, resolution, mergedText, notes }) => {
    const { store, embedder } = getComponents();
    const result = await resolveConflictCandidate({
      store,
      embedder,
      conflictStore,
    }, {
      conflictId,
      resolution,
      ...(mergedText ? { mergedText } : {}),
      notes,
    });

    return {
      content: [{
        type: "text" as const,
        text: formatConflictResolution(result),
      }],
    };
  }
);

registerTool(
  "audit_conflicts",
  "Generate a conflict audit summary showing priority clusters by staleness and escalation level. Read-only. Use when triaging which conflict clusters to resolve first.",
  {
    status: ConflictStatusSchema.optional().describe("Optional status filter"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional canonical key filter"),
    limit: z.number().int().min(1).max(500).default(100).describe("How many conflict records to scan"),
    top: z.number().int().min(1).max(20).default(5).describe("How many priority clusters to show"),
  },
  async ({ status, canonicalKey, limit, top }) => {
    const records = await conflictStore.listRecent({
      status,
      canonicalKey,
      limit,
    });
    const summary = buildConflictAuditSummary(records, top);
    return {
      content: [{
        type: "text" as const,
        text: formatConflictAudit(summary),
      }],
    };
  }
);

registerTool(
  "escalate_conflicts",
  "Preview or apply conflict aging policy to mark stale conflicts for operator review. Side effect: when apply=true, persists escalation metadata. Use when conflicts have aged past their attention threshold.",
  {
    attention: z.enum(["stale", "escalated"]).default("stale").describe("Only consider stale or escalated conflicts"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional canonical key filter"),
    limit: z.number().int().min(1).max(500).default(100).describe("How many open conflicts to scan"),
    top: z.number().int().min(1).max(20).default(10).describe("How many eligible conflicts to include"),
    apply: z.boolean().default(false).describe("When false, preview only. When true, persist escalation metadata."),
    notes: z.string().min(1).max(320).optional().describe("Optional operator note when applying escalation"),
  },
  async ({ attention, canonicalKey, limit, top, apply, notes }) => {
    const result = await escalateConflicts({
      conflictStore,
    }, {
      attention,
      canonicalKey,
      limit,
      top,
      apply,
      notes,
    });
    return {
      content: [{
        type: "text" as const,
        text: formatConflictEscalation(result),
      }],
    };
  }
);

registerTool(
  "list_dirty_briefs",
  "List memory briefs generated before current cleanup rules that may need re-indexing. Read-only. Use when auditing brief quality or before running clean_dirty_briefs.",
  {},
  async () => {
    const rows = listDirtyBriefAssets();
    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No dirty briefs found." }] };
    }
    const lines = [
      "Brief ID  Title  Scope  Reasons",
      "--------  -----  -----  ----------------------------------------",
      ...rows.map(row => `${row.id.slice(0, 8)}  ${row.title}  [${row.scope}]  ${row.reasons.join("; ")}`),
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

registerTool(
  "clean_dirty_briefs",
  "Archive dirty briefs and remove their indexed asset entries. Side effect: when apply=true, moves briefs to archive and deletes index rows. Use when list_dirty_briefs shows stale briefs that need cleanup.",
  {
    apply: z.boolean().default(false).describe("When false, preview only (no writes). When true, archive briefs and delete indexed rows."),
  },
  async ({ apply }) => {
    const { store } = getComponents();
    const rows = listDirtyBriefAssets();
    if (rows.length === 0) {
      return { content: [{ type: "text" as const, text: "No dirty briefs found." }] };
    }

    if (!apply) {
      const preview = rows.map(row => `${row.id.slice(0, 8)}  ${row.title}  [${row.scope}]  ${row.reasons.join("; ")}`).join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `Dirty briefs detected: ${rows.length}\n\n${preview}\n\nCall clean_dirty_briefs with apply=true to archive them.`,
        }],
      };
    }

    let archived = 0;
    let deleted = 0;
    for (const row of rows) {
      try {
        archiveDirtyBriefAsset(row);
        archived += 1;
      } catch (err) {
        console.error("[recallnest] Failed to archive dirty brief:", err instanceof Error ? err.message : String(err));
      }
      try {
        deleted += await store.bulkDelete([row.scope]);
      } catch (err) {
        console.error("[recallnest] Failed to delete dirty brief index rows:", err instanceof Error ? err.message : String(err));
      }
    }

    return {
      content: [{
        type: "text" as const,
        text: `Dirty briefs: ${rows.length}\nArchived: ${archived}\nIndex rows deleted: ${deleted}`,
      }],
    };
  }
);

registerTool(
  "consolidate_memories",
  "Run semantic consolidation: cluster similar memories, merge near-duplicates, and detect contradictions. Side effect: when apply=true, archives merged entries. Use when a scope has grown large and needs deduplication.",
  {
    scope: z.string().min(1).max(160).describe("Scope to consolidate (e.g. project:recallnest)"),
    clusterThreshold: z.number().min(0.5).max(1.0).default(0.82).describe("Min similarity to form a cluster (default 0.82)"),
    mergeThreshold: z.number().min(0.5).max(1.0).default(0.92).describe("Min similarity to merge/archive (default 0.92)"),
    maxEntries: z.number().min(10).max(2000).default(500).describe("Max entries to scan (default 500)"),
    apply: z.boolean().default(false).describe("When false, preview only (scan + report without archiving). When true, actually merge/archive."),
  },
  async ({ scope, clusterThreshold, mergeThreshold, maxEntries, apply }) => {
    const { store } = getComponents();

    if (!apply) {
      // Dry-run: use a read-only wrapper that blocks writes
      const readOnlyStore = {
        list: store.list.bind(store),
        getById: store.getById.bind(store),
        vectorSearch: store.vectorSearch.bind(store),
        update: async () => null, // no-op in dry-run
      };
      const engine = new ConsolidationEngine(readOnlyStore, { clusterThreshold, mergeThreshold, maxEntriesPerRun: maxEntries });
      const result = await engine.run(scope);
      return {
        content: [{
          type: "text" as const,
          text: `[DRY-RUN] ${formatConsolidationResult(result)}\n\nRe-run with apply=true to execute merges.`,
        }],
      };
    }

    // P0-1: serialize applied consolidation per scope across the 11 mcp-server processes.
    // Skip (not queue) if another process is already consolidating this scope — the
    // store-write lock already prevents write corruption; this just avoids redundant work.
    const outcome = await withLock(
      `consolidate-${scope}`,
      async () => {
        const engine = new ConsolidationEngine(store, { clusterThreshold, mergeThreshold, maxEntriesPerRun: maxEntries });
        return engine.run(scope);
      },
      { onBusy: "skip", expireMs: 600_000 },
    );
    if (!outcome.ran) {
      return {
        content: [{
          type: "text" as const,
          text: `⏭️ consolidate_memories skipped: another process is consolidating scope "${scope}".`,
        }],
      };
    }
    return {
      content: [{
        type: "text" as const,
        text: formatConsolidationResult(outcome.result),
      }],
    };
  }
);

registerTool(
  "scan_skill_promotions",
  "Scan cases and patterns in a scope for potential promotion to reusable skills. Read-only. Use when you want to discover recurring procedures that deserve formalization as skills.",
  {
    scope: z.string().min(1).max(160).describe("Project scope to scan for promotion candidates"),
    minOccurrences: z.number().min(2).max(20).default(3).describe("Minimum similar cases to trigger a promotion suggestion"),
  },
  async ({ scope, minOccurrences }) => {
    const { store } = getComponents();
    const result = await scanForPromotions(store, scope, {
      minCaseOccurrences: minOccurrences,
    });

    return {
      content: [{
        type: "text" as const,
        text: formatPromotionResult(result),
      }],
    };
  },
);

registerTool(
  "manage_alias",
  "Manage user-level query alias rules (data/alias-map.json). Matching aliases append canonical tokens to the query in the BM25 channel only ('我的桥' → '+telegram-ai-bridge') — they deliberately do NOT alter the vector embedding, so casual aliases cannot cause semantic drift. Actions: add/remove/list, plus explain to debug which rules (builtin full-channel + user BM25-only) fire for a query. Use when a colloquial entity name fails to recall its canonical project/tool.",
  {
    action: z.enum(["add", "remove", "list", "explain"]).describe("add: upsert a rule; remove: delete by trigger; list: all rules (builtin + user); explain: show which rules match a query"),
    trigger: z.string().min(1).max(60).optional().describe("Alias literal to match in queries, case-insensitive inclusion (required for add/remove)"),
    expansions: z.array(z.string().min(1).max(60)).max(8).optional().describe("Canonical tokens to append (required for add, max 8)"),
    query: z.string().min(1).max(500).optional().describe("Query to explain (required for explain)"),
  },
  async ({ action, trigger, expansions, query }) => {
    const text = (() => {
      switch (action) {
        case "add": {
          if (!trigger || !expansions?.length) throw new Error("invalid input: manage_alias add 需要 trigger 与 expansions");
          const result = upsertUserAlias(trigger, expansions);
          return result.ok
            ? `${result.action}: "${result.entry.trigger}" → [${result.entry.expansions.join(", ")}](写入 ${aliasMapFilePath()},BM25 通道立即生效)`
            : `拒绝: ${result.reason}`;
        }
        case "remove": {
          if (!trigger) throw new Error("invalid input: manage_alias remove 需要 trigger");
          return removeUserAlias(trigger)
            ? `removed: "${trigger}"`
            : `未找到 trigger "${trigger}"(只能删用户规则;builtin 规则在 src/aliases.ts)`;
        }
        case "list": {
          const user = listUserAliases();
          return [
            `Builtin rules (${ALIAS_RULES.length}, read-only, full-channel vector+BM25):`,
            ...ALIAS_RULES.map(r => `  /${r.pattern.source}/ → ${r.expansion}${r.comment ? ` (${r.comment})` : ""}`),
            ``,
            `User rules (${user.length}, BM25-only, ${aliasMapFilePath()}):`,
            ...(user.length ? user.map(r => `  "${r.trigger}" → [${r.expansions.join(", ")}]`) : ["  (none)"]),
          ].join("\n");
        }
        case "explain": {
          if (!query) throw new Error("invalid input: manage_alias explain 需要 query");
          const builtinMatched = explainAliasExpansion(query);
          const userMatched = explainUserAliases(query);
          return [
            `Query: ${query}`,
            `Full-channel expanded (builtin): ${expandQueryWithAliases(query) === query ? "(unchanged)" : expandQueryWithAliases(query)}`,
            `BM25-channel expanded (builtin synonyms + user aliases): ${expandQuery(query) === query ? "(unchanged)" : expandQuery(query)}`,
            `Matched builtin rules (${builtinMatched.length}):`,
            ...builtinMatched.map(m => `  /${m.pattern}/ → ${m.expansion}`),
            `Matched user aliases (${userMatched.length}):`,
            ...userMatched.map(m => `  "${m.trigger}" → [${m.expansions.join(", ")}]`),
          ].join("\n");
        }
      }
    })();

    return { content: [{ type: "text" as const, text }] };
  },
);

registerTool(
  "promote_scan",
  "Scan transcript-downgraded evidence (profile/preferences sunk to events) and auto-promote recurring high-importance facts back to durable memory. Default dry-run (no writes); when dryRun=false it creates durable entries (dedup is idempotent). Use to backfill sparse durable profile/preferences from accumulated transcript evidence.",
  {
    scope: z.string().min(1).max(160).describe("Scope to scan, e.g. cc:project:recallnest"),
    dryRun: z.boolean().default(true).describe("When true (default), only report candidates without writing"),
    minOccurrences: z.number().int().min(2).max(20).default(3).describe("Min cluster members before promoting"),
    minImportance: z.number().min(0).max(1).default(0.6).describe("Min average cluster importance to promote"),
  },
  async ({ scope, dryRun, minOccurrences, minImportance }) => {
    const { store, embedder } = getComponents();
    const kgExtractor = getKGExtractor();
    const deps = buildPromoteScanDeps({ store, embedder, conflictStore, kgExtractor });
    const result = await scanMemoryPromotions(deps, scope, { dryRun, minOccurrences, minImportance });

    return {
      content: [{
        type: "text" as const,
        text: formatPromoteScanResult(result),
      }],
    };
  },
);
}
