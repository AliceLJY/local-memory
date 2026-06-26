import { z } from "zod";
import { persistMemory } from "./capture-engine.js";
import { composeLightResumeContext, composeResumeContext } from "./context-composer.js";
import { renderMemories } from "./context-renderer.js";
import { formatSearchResults, formatBriefResults, formatFullResults } from "./memory-output.js";
import { DurableMemoryCategorySchema, StoreMemorySourceSchema, PrivacyTierSchema, isPredictiveMemoryEnabled } from "./memory-schema.js";
import type { PredictionContext } from "./prediction-engine.js";
import { setReminder, checkTriggers, fireReminder, suggestPredictedReminders, formatSuggestedReminders } from "./prospective-memory.js";
import { resolveRecallMode } from "./runtime-config.js";
import { buildRetrievalContext, resolveScopeSelection } from "./scope-policy.js";
import { createScopeSuggester } from "./scope-suggester.js";
import { buildSessionCheckpointResult } from "./session-engine.js";
import { formatCheckpointSaved, formatCheckpointSummary, formatResumeContext } from "./session-output.js";
import { matchesTemporalConstraint, type TemporalConstraint } from "./temporal-parser.js";
import { buildManagedCheckpointObservation, buildManagedResumeObservation } from "./workflow-observation-managed.js";
import { buildWorkflowObservationRecord } from "./workflow-observation-engine.js";
import type { ToolRegistryDeps } from "./mcp-tool-deps.js";

export function registerCoreTools(deps: ToolRegistryDeps): void {
  const { registerTool, getComponents, config, checkpointStore, conflictStore, workflowObservationStore, getKGExtractor, getKGStore } = deps;
  const TOOL_DESCRIPTIONS = deps.toolDescriptions;
  const TOOL_TIERS = deps.toolTiers;
  /** P1-A: 60s 缓存的 scope 建议器,首次 0-hit 搜索时惰性初始化。 */
  let scopeSuggestFn: ((input: string) => Promise<string[]>) | null = null;

  async function saveManagedObservation(observation: Parameters<typeof buildWorkflowObservationRecord>[0]): Promise<void> {
    try {
      const record = buildWorkflowObservationRecord(observation);
      await workflowObservationStore.save(record);
    } catch (error) {
      console.error("[RecallNest MCP] Failed to persist managed workflow observation:", error);
    }
  }

registerTool(
  "store_memory",
  "Store a durable memory when the user shares a stable preference, identity fact, project entity, reusable pattern, or solved case that should survive future windows. Do not use this for transient task state; use it only for memory worth keeping.",
  {
    text: z.string().min(1).max(4000).describe("Memory text to store"),
    category: DurableMemoryCategorySchema.default("events").describe("Durable memory category"),
    importance: z.number().min(0).max(1).default(0.7).describe("Importance score from 0 to 1"),
    scope: z.string().min(1).max(160).describe("Required scope such as project:recallnest or session:abc123"),
    source: StoreMemorySourceSchema.default("manual").describe("How this memory was captured"),
    tags: z.array(z.string().min(1).max(40)).max(8).default([]).describe("Optional tags"),
    canonicalKey: z.string().min(1).max(120).optional().describe("Optional stable key for merge/update semantics"),
    topicTag: z.string().min(1).max(60).optional().describe("Optional topic tag for intra-scope partitioning (e.g. 'auth', 'deploy', 'testing'). Auto-detected if omitted."),
    privacyTier: PrivacyTierSchema.default("durable").describe("Privacy tier: ephemeral (auto-expire, no KG), private (persist, no KG), durable (default), shared (cross-scope)"),
    validUntil: z.union([z.string(), z.number()]).optional().describe("Optional expiration: ISO date string or ms timestamp. Memory will be deprioritized after this time."),
    eventTime: z.union([z.string(), z.number()]).optional().describe("Optional event time: when the event actually happened (ISO date or ms), distinct from storage time."),
    confidence: z.union([
      z.number().min(0).max(1),
      z.object({
        score: z.number().min(0).max(1),
        reliability: z.enum(["direct", "inferred", "hearsay"]).optional(),
      }),
    ]).optional().describe("Optional confidence override: number (0-1) or {score, reliability}. Auto-assigned from source if omitted."),
  },
  async ({ text, category, importance, scope, source, tags, canonicalKey, topicTag, privacyTier, validUntil, eventTime, confidence }) => {
    const { store, embedder } = getComponents();
    const kgExtractor = getKGExtractor();
    const stored = await persistMemory({
      store,
      embedder,
      conflictStore,
      kgExtractor,
    }, {
      text,
      category,
      importance,
      scope,
      source,
      tags,
      canonicalKey,
      topicTag,
      privacyTier,
      // F3: Pass temporal validity params (extracted by persistMemory before Zod parse)
      validUntil,
      eventTime,
      // F1: Pass confidence override (extracted by persistMemory before Zod parse)
      confidence,
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Stored memory ${stored.id.slice(0, 8)}`,
          `Disposition: ${stored.disposition}`,
          `Category: ${stored.category}`,
          `Scope: ${stored.resolvedScope}`,
          `Canonical key: ${stored.canonicalKey}`,
          ...(stored.conflictId ? [`Conflict: ${stored.conflictId.slice(0, 8)}`] : []),
          `Stored at: ${stored.storedAt}`,
        ].join("\n"),
      }],
    };
  }
);

registerTool(
  "set_reminder",
  "Set a prospective memory reminder that auto-triggers during future search_memory calls when the trigger keywords match. Side effect: stores a reminder entry. Use when you need a future nudge tied to a specific context.",
  {
    trigger: z.string().min(1).max(200).describe("Trigger condition — keywords that should activate this reminder"),
    action: z.string().min(1).max(500).describe("What to remind about when the trigger fires"),
    scope: z.string().min(1).max(160).describe("Required scope"),
    expiresInDays: z.number().min(1).max(365).optional().describe("Optional: auto-expire after N days"),
  },
  async ({ trigger, action, scope, expiresInDays }) => {
    const { store, embedder } = getComponents();
    const entry = await setReminder(store, embedder, { trigger, action, scope, expiresInDays });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Reminder set: ${entry.id.slice(0, 8)}`,
          `Trigger: "${trigger}"`,
          `Action: ${action}`,
          `Scope: ${scope}`,
          ...(expiresInDays ? [`Expires in: ${expiresInDays} days`] : []),
        ].join("\n"),
      }],
    };
  }
);

registerTool(
  "checkpoint_session",
  "Store a compact checkpoint of the current work state. Use this when a task spans windows or terminals and you need the next session to recover decisions, open loops, and next actions without polluting durable memory.",
  {
    sessionId: z.string().min(1).max(160).describe("Current session identifier"),
    scope: z.string().min(1).max(160).optional().describe("Optional shared scope; defaults to session:<sessionId>"),
    summary: z.string().min(1).max(600).describe("Compact summary of the current work state"),
    task: z.string().min(1).max(240).optional().describe("Optional task label"),
    decisions: z.array(z.string().min(1).max(200)).max(6).default([]).describe("Key decisions already made"),
    openLoops: z.array(z.string().min(1).max(200)).max(6).default([]).describe("Unresolved questions or pending items"),
    nextActions: z.array(z.string().min(1).max(200)).max(6).default([]).describe("Next actions to take"),
    entities: z.array(z.string().min(1).max(120)).max(8).default([]).describe("Relevant projects, tools, or people"),
    files: z.array(z.string().min(1).max(220)).max(12).default([]).describe("Relevant files or paths"),
    idempotencyKey: z.string().min(1).max(160).optional().describe("Optional stable request key; repeated saves with the same key replace the prior checkpoint"),
    updatedAt: z.string().datetime().optional().describe("Optional override; defaults to now"),
  },
  async ({ sessionId, scope, summary, task, decisions, openLoops, nextActions, entities, files, idempotencyKey, updatedAt }) => {
    const result = buildSessionCheckpointResult({
      sessionId,
      scope,
      summary,
      task,
      decisions,
      openLoops,
      nextActions,
      entities,
      files,
      idempotencyKey,
      ...(updatedAt ? { updatedAt } : {}),
    });
    const storedRecord = await checkpointStore.save(result.record);
    await saveManagedObservation(buildManagedCheckpointObservation({
      ...result,
      record: storedRecord,
    }));
    return {
      content: [{
        type: "text" as const,
        text: formatCheckpointSaved(storedRecord),
      }],
    };
  }
);

registerTool(
  "latest_checkpoint",
  "Fetch the most recent saved checkpoint for a session or shared scope. Read-only. Use when you need to inspect current work state without running a full resume_context.",
  {
    sessionId: z.string().min(1).max(160).optional().describe("Session identifier filter, e.g. 'abc123'"),
    scope: z.string().min(1).max(160).optional().describe("Shared scope filter, e.g. 'project:recallnest'"),
  },
  async ({ sessionId, scope }) => {
    const latest = await checkpointStore.getLatest({ sessionId, scope });
    return {
      content: [{
        type: "text" as const,
        text: formatCheckpointSummary(latest),
      }],
    };
  }
);

registerTool(
  "resume_context",
  "Compose startup context for a fresh window by combining durable memory, patterns, cases, and the latest checkpoint. Read-only. Use when entering a new session and you need to recover prior decisions, open loops, and next actions.",
  {
    task: z.string().min(1).max(500).optional().describe("Optional current task or question to bias recall"),
    scope: z.string().min(1).max(160).optional().describe("Optional shared scope for project or terminal continuity"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to recover the latest checkpoint"),
    limitPerSection: z.number().int().min(1).max(6).default(3).describe("Max items per section"),
    includeLatestCheckpoint: z.boolean().default(true).describe("Whether to include the latest checkpoint summary"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
    mode: z.enum(["full", "light", "summary", "off"]).optional().describe("Override recall mode: 'full' (default), 'light' (<300 tokens), 'summary' (checkpoint only), 'off'"),
  },
  async ({ task, scope, sessionId, limitPerSection, includeLatestCheckpoint, profile: profileName, mode: modeOverride }) => {
    const effectiveMode = resolveRecallMode(config, modeOverride);

    // --- off mode: no recall, guide agent to use search_memory ---
    if (effectiveMode === "off") {
      return {
        content: [{
          type: "text" as const,
          text: "Recall mode is off. Use search_memory to retrieve specific memories on demand.",
        }],
      };
    }

    // --- summary mode: checkpoint only, lightweight ---
    if (effectiveMode === "summary") {
      const scopeSelection = resolveScopeSelection({
        scope,
        sessionId,
        operation: "resume_context",
        allowUnscoped: true,
      });
      const latest = await checkpointStore.getLatest({
        sessionId,
        scope: scopeSelection.resolvedScope,
      });
      const summaryText = formatCheckpointSummary(latest) +
        "\n\nFor detailed recall, use search_memory with specific queries.";
      await saveManagedObservation({
        workflowId: "resume_context",
        outcome: "success",
        summary: `Managed resume_context returned summary-mode checkpoint${latest ? "" : " (none found)"}.`,
        scope: scopeSelection.resolvedScope || scope || "global",
        source: "managed:recallnest",
        signal: "managed-resume-summary",
        task,
        tags: ["managed", "recallnest", "summary-mode"],
      });
      return {
        content: [{
          type: "text" as const,
          text: summaryText,
        }],
      };
    }

    // --- light mode: <300 token ultra-light wake-up ---
    if (effectiveMode === "light") {
      const { retriever: lightRetriever } = getComponents(profileName);
      const lightScope = resolveScopeSelection({
        scope,
        sessionId,
        operation: "resume_context",
        allowUnscoped: true,
      });
      const lightResult = await composeLightResumeContext({
        retriever: lightRetriever,
        checkpointStore,
      }, {
        task,
        scope: lightScope.resolvedScope,
        sessionId,
        limitPerSection: limitPerSection,
        includeLatestCheckpoint,
        profile: profileName,
      });
      await saveManagedObservation({
        workflowId: "resume_context",
        outcome: "success",
        summary: `Managed resume_context returned light-mode context (~${lightResult.text.length} chars).`,
        scope: lightScope.resolvedScope || scope || "global",
        source: "managed:recallnest",
        signal: "managed-resume-light",
        task,
        tags: ["managed", "recallnest", "light-mode"],
      });
      return {
        content: [{
          type: "text" as const,
          text: lightResult.text,
        }],
      };
    }

    // --- full mode: existing compose behavior ---
    const { retriever, profile } = getComponents(profileName);
    const scopeSelection = resolveScopeSelection({
      scope,
      sessionId,
      operation: "resume_context",
      allowUnscoped: true,
    });
    const context = await composeResumeContext({
      retriever,
      checkpointStore,
    }, {
      task,
      scope: scopeSelection.resolvedScope,
      sessionId,
      limitPerSection,
      includeLatestCheckpoint,
      profile: profile.name,
    });
    await saveManagedObservation(buildManagedResumeObservation({
      task,
      scope,
      sessionId,
    }, context));

    return {
      content: [{
        type: "text" as const,
        text: formatResumeContext(context),
      }],
    };
  }
);

registerTool(
  "search_memory",
  "Search indexed memories by hybrid relevance (vector + BM25 + reranking) and return ranked results with optional temporal filtering. The shown score is a fused ranking score (0-100%), NOT pure cosine similarity — read it as relative ranking within this result set, not as match confidence. Read-only, but may fire stored reminders as a side effect. Use proactively at the start of tasks, when debugging, writing, or when the user references past work.",
  {
    query: z.string().describe("Search query — natural language or keywords"),
    limit: z.number().min(1).max(20).default(5).describe("Max results to return"),
    scope: z.string().optional().describe("Optional explicit scope"),
    sessionId: z.string().min(1).max(160).optional().describe("Optional session identifier to infer session:<id> scope"),
    allScopes: z.boolean().default(false).describe("When true, explicitly allow cross-scope search"),
    category: DurableMemoryCategorySchema.optional().describe("Filter by memory category: profile (identity/background), preferences (habits/style), entities (projects/tools/people), events (past happenings), cases (problem-solution pairs), patterns (reusable workflows)"),
    profile: z.enum(["default", "writing", "debug", "fact-check"]).optional().describe("Retrieval profile"),
    render: z.enum(["verbatim", "highlight"]).default("verbatim").optional().describe("Result rendering mode: verbatim (default, original order) or highlight (reorder by contextual relevance to query)"),
    after: z.string().optional().describe("Filter memories stored after this date (ISO format YYYY-MM-DD, or relative like '最近30天', 'last 7 days')"),
    before: z.string().optional().describe("Filter memories stored before this date (ISO format YYYY-MM-DD, or relative)"),
    graph: z.boolean().default(false).optional().describe("Enable KG graph traversal (PPR) for relationship-aware search. Use when query involves entity relationships (e.g. 'what tools does Alice use', 'Bob的朋友')."),
    includeArchived: z.boolean().default(false).optional().describe("When true, also return archived/superseded/consolidated memories (default: only active)"),
    detail_level: z.enum(["brief", "normal", "full"]).default("normal").optional()
      .describe("Result detail level: brief (ID+score+one-liner), normal (default, current behavior), full (include metadata)"),
    topicTag: z.string().min(1).max(60).optional()
      .describe("Filter by topic tag (e.g. 'auth', 'deploy', 'testing'). Only returns memories tagged with this topic."),
    reconstruct: z.boolean().default(false).describe(
      "Return LLM-synthesized reconstruction alongside raw results. Requires RECALLNEST_CONSTRUCTIVE_RETRIEVAL=true."
    ),
    validAt: z.string().optional().describe("Query memories valid at a specific point in time (ISO date, e.g. '2025-06-15'). Returns only memories whose validity window covers this date."),
    includeExpired: z.boolean().default(false).optional().describe("When true, include expired memories in results (demoted 80%). Default: only active/non-expired."),
  },
  async ({ query, limit, scope, sessionId, allScopes, category, profile: profileName, render, after, before, graph, includeArchived, detail_level, topicTag, reconstruct, validAt, includeExpired }) => {
    const { retriever, profile } = getComponents(profileName);
    const { llm } = getComponents();
    const kgStoreInstance = getKGStore();
    // Ensure KG store is attached to non-default profile retrievers for PPR
    if (graph && kgStoreInstance) retriever.setKGStore(kgStoreInstance);
    // Attach LLM client for constructive retrieval if available
    if (reconstruct && llm) retriever.setLLMClient(llm);
    let results = await retriever.retrieve(buildRetrievalContext({
      query,
      limit: (after || before || topicTag) ? limit * 3 : limit,
      category,
      scope,
      sessionId,
      allScopes,
      graph,
      includeArchived,
      topicTag,
      reconstruct,
      // F3: Temporal validity filtering
      validAt: validAt ? new Date(validAt).getTime() : undefined,
      includeExpired: includeExpired ?? undefined,
    }, {
      operation: "search_memory",
    }));

    // Scope 0-hit fallback: 用户给的 scope 太严返回 0 hit 时，自动 allScopes=true 重试一次。
    // 仅在 !allScopes 时触发，避免重复跨 scope 搜。
    // P1-A: fallback 不再静默——输出段会披露"结果来自跨 scope 重试"并附相近 scope 建议,
    // 否则拼错 scope 的调用方拿到跨 scope 结果却以为 scope 过滤生效了。
    let scopeFallbackUsed = false;
    if (results.length === 0 && !allScopes) {
      scopeFallbackUsed = true;
      results = await retriever.retrieve(buildRetrievalContext({
        query,
        limit: (after || before || topicTag) ? limit * 3 : limit,
        category,
        scope: undefined,
        sessionId: undefined,
        allScopes: true,
        graph,
        includeArchived,
        topicTag,
        reconstruct,
        validAt: validAt ? new Date(validAt).getTime() : undefined,
        includeExpired: includeExpired ?? undefined,
      }, {
        operation: "search_memory",
      }));
    }

    // Explicit temporal filtering from after/before params
    if (after || before) {
      const constraint: TemporalConstraint = {
        type: (after && before) ? "range" : (after ? "after" : "before"),
        startMs: after ? new Date(after).getTime() || undefined : undefined,
        endMs: before ? new Date(before).getTime() || undefined : undefined,
        anchor: `${after || ""}..${before || ""}`,
      };
      if (constraint.startMs || constraint.endMs) {
        results = results
          .filter(r => matchesTemporalConstraint(r.entry.timestamp, constraint))
          .slice(0, limit);
      }
    }

    // Apply context-aware rendering when requested
    if (render === "highlight" && results.length > 0) {
      const rendered = renderMemories(
        results.map(r => ({ id: r.entry.id, text: r.entry.text, score: r.score, category: r.entry.category })),
        query,
        "highlight",
      );
      // Reorder results to match rendered order
      const idOrder = new Map(rendered.memories.map((m, i) => [m.id, i]));
      results.sort((a, b) => (idOrder.get(a.entry.id) ?? 999) - (idOrder.get(b.entry.id) ?? 999));
    }

    // Tier 3.4: Check for triggered reminders alongside search results
    const { store, embedder } = getComponents();
    const scopeFilter = scope ? [scope] : undefined;
    const triggered = await checkTriggers(store, embedder, query, scopeFilter);
    let reminderText = "";
    if (triggered.length > 0) {
      const firedActions: string[] = [];
      for (const reminder of triggered) {
        const action = await fireReminder(store, reminder.entryId, scopeFilter);
        if (action) firedActions.push(action);
      }
      if (firedActions.length > 0) {
        reminderText = "\n\n--- Triggered Reminders ---\n" +
          firedActions.map(a => `- ${a}`).join("\n");
      }
    }

    // HP-predictive: Surface predicted reminders alongside search results
    let suggestedText = "";
    if (isPredictiveMemoryEnabled()) {
      try {
        const recentCheckpoints = await checkpointStore.listRecent({ scope, limit: 5 });
        const recentObservations = await workflowObservationStore.listRecent({ scope, limit: 20 });
        const predictionCtx: PredictionContext = {
          checkpoints: recentCheckpoints,
          workflowObservations: recentObservations,
          frequentMemories: [], // Populated by access tracker in future iteration
          uncoveredTopics: results.length === 0 && query ? [query] : [],
        };
        const suggestions = await suggestPredictedReminders(store, embedder, predictionCtx, scope ?? "global");
        suggestedText = formatSuggestedReminders(suggestions);
      } catch {
        // Prediction failure is non-critical — silently skip
      }
    }

    const level = detail_level ?? "normal";
    const sections: string[] = [];

    // Phase 4: Read reconstruction from first-class field (no metadata hack)
    const reconstruction = (results as import("./retriever.js").RetrievalResultSet).reconstruction;
    if (reconstruction?.reconstructed) {
      const sourceIds = reconstruction.sources.map(s => s.id).join(", ");
      const sourceTypes = [...new Set(reconstruction.sources.map(s => s.source.type))].join(", ");
      sections.push(
        `## Reconstructed Context (confidence: ${reconstruction.confidence.toFixed(2)}, coverage: ${reconstruction.coverage.toFixed(2)})\n${reconstruction.reconstructed}\n\nSources (${sourceTypes}): ${sourceIds}`
      );
      // Render contradictions if detected
      if (reconstruction.contradictions.length > 0) {
        const conflictLines = reconstruction.contradictions.map(c =>
          `- \u26a0\ufe0f ${c.description} [${c.memoryIds.join(" vs ")}]`
        );
        sections.push(`### Contradictions Detected\n${conflictLines.join("\n")}`);
      }
    }

    let body: string;
    if (level === "brief") {
      body = formatBriefResults(results, { query });
    } else if (level === "full") {
      body = formatFullResults(results, { query, profile: profile.name });
    } else {
      body = formatSearchResults(results, { query, profile: profile.name });
    }
    sections.push(body);

    // P1-A: 显式 scope 0 命中 → 相近 scope 提示(拼写漂移最常见;只提示不改写)
    if (scope && (scopeFallbackUsed || results.length === 0)) {
      try {
        scopeSuggestFn ??= createScopeSuggester(async () => (await getComponents().store.stats()).scopeCounts);
        const suggestions = (await scopeSuggestFn(scope)).filter(s => s !== scope);
        const notes: string[] = [];
        if (scopeFallbackUsed && results.length > 0) {
          notes.push(`⚠️ scope '${scope}' 命中 0 条,以上结果来自自动跨 scope 重试(allScopes)。`);
        }
        if (suggestions.length > 0) {
          notes.push(`相近 scope: [${suggestions.join(", ")}]`);
        }
        if (notes.length > 0) sections.push(notes.join("\n"));
      } catch { /* suggestion is best-effort, never blocks search output */ }
    }

    return {
      content: [{
        type: "text" as const,
        text: sections.join("\n\n") + reminderText + suggestedText,
      }],
    };
  }
);

registerTool(
  "list_tools",
  "List available RecallNest tools with one-line descriptions, filtered by tier. Read-only. Use when you need to discover advanced or governance tools beyond the core set.",
  {
    tier: z.enum(["core", "advanced", "full"]).default("advanced").optional()
      .describe("Which tier of tools to list. Returns tools at this tier and below."),
  },
  async ({ tier }) => {
    const requestedTier = tier ?? "advanced";
    const tierOrder: Record<string, number> = { core: 0, advanced: 1, governance: 2 };
    const maxOrder = requestedTier === "full" ? 2 : tierOrder[requestedTier] ?? 1;

    const lines: string[] = [`Available tools (tier: ${requestedTier}):`];
    for (const [toolName, toolTier] of Object.entries(TOOL_TIERS)) {
      if ((tierOrder[toolTier] ?? 999) > maxOrder) continue;
      const desc = TOOL_DESCRIPTIONS.get(toolName);
      const oneLiner = desc
        ? desc.split(/[.!]\s/)[0]?.slice(0, 100) ?? desc.slice(0, 100)
        : "(no description)";
      lines.push(`- ${toolName}: ${oneLiner}`);
    }

    return {
      content: [{
        type: "text" as const,
        text: lines.join("\n"),
      }],
    };
  },
);
}
