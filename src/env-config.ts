/**
 * Centralized RECALLNEST_* environment variable accessors (P3-C config 收口).
 *
 * Single source of truth for every fixed `RECALLNEST_*` env flag read across `src/`:
 * the env NAME, its default, and its parsing all live here. Consumers call these
 * accessors instead of reading `process.env` directly.
 *
 * This is a PURE-MOVEMENT refactor — each accessor preserves the exact original
 * parsing. Do not "improve" them; the following invariants are load-bearing:
 *
 * - Boolean flags use strict `=== "true"` — no trim, no case-folding, no truthy
 *   coercion. `"True"` / `" true "` / `"1"` must NOT enable a flag.
 * - String defaults use `||`, NOT `??` — an empty string falls through to the
 *   default (matches the original inline reads).
 * - Raw-value accessors (recall mode, ports) return the UNPARSED env value so the
 *   caller keeps its existing validation / clamping / config-fallback logic. In
 *   particular `recallModeRaw()` must not default to "summary" here, or it would
 *   bypass the `config.recallMode` fallback in resolveRecallMode().
 * - `mcpTier()` keeps only the type assertion with NO runtime validation — an
 *   illegal non-empty value is preserved as-is (downstream shouldRegisterTool()
 *   relies on this), so do not coerce unknown values back to the default.
 *
 * Accessors are FUNCTIONS (lazy): they read `process.env` at call time. Never
 * freeze them into module-load constants — 100+ tests toggle `process.env` at
 * runtime. Consumers must substitute in place and never relocate a read across
 * the `loadDotEnv()` boundary or into a different evaluation phase: five reads are
 * intentionally module-init-time eager (mcp-server tier, api/ui ports,
 * activity-counter / distill-lock data dir) and must stay eager.
 *
 * Intentionally NOT centralized here:
 * - scope-policy.ts's RECALLNEST_DEFAULT_SCOPE / _SCOPE / _PROJECT_SCOPE /
 *   _SESSION_ID — an injectable `options.env || process.env` policy entry that is
 *   already consolidated in that module with caller-injection semantics.
 * - store.ts's `RECALLNEST_NS` — a local hash-namespace constant, not an env var.
 * - config-template `${VAR}` expansion in runtime-config / embedder / llm-client.
 */

// --- Boolean feature flags (strict === "true") ---

export const multiVector = (): boolean => process.env.RECALLNEST_MULTI_VECTOR === "true";

export const emotionScoring = (): boolean => process.env.RECALLNEST_EMOTION_SCORING === "true";

export const predictiveMemory = (): boolean => process.env.RECALLNEST_PREDICTIVE_MEMORY === "true";

export const synthesize = (): boolean => process.env.RECALLNEST_SYNTHESIZE === "true";

export const llmConsolidation = (): boolean => process.env.RECALLNEST_LLM_CONSOLIDATION === "true";

export const constructiveRetrieval = (): boolean =>
  process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL === "true";

export const narrativeMode = (): boolean => process.env.RECALLNEST_NARRATIVE_MODE === "true";

export const kgMode = (): boolean => process.env.RECALLNEST_KG_MODE === "true";

export const coreSummary = (): boolean => process.env.RECALLNEST_CORE_SUMMARY === "true";

// --- String settings with `||` default (empty string falls through) ---

export const dataDir = (): string => process.env.RECALLNEST_DATA_DIR || "data";

export const mcpTier = (): "core" | "advanced" | "full" =>
  (process.env.RECALLNEST_MCP_TIER || "advanced") as "core" | "advanced" | "full";

// --- Raw env values (caller validates / clamps / falls back to config) ---

export const recallModeRaw = (): string | undefined => process.env.RECALLNEST_RECALL_MODE;

export const uiPortRaw = (): string | undefined => process.env.RECALLNEST_UI_PORT;

export const apiPortRaw = (): string | undefined => process.env.RECALLNEST_API_PORT;
