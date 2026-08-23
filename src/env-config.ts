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

export const errorSignatureBoost = (): boolean =>
  process.env.RECALLNEST_ERROR_SIGNATURE_BOOST === "true";

export const usageDecay = (): boolean => process.env.RECALLNEST_USAGE_DECAY === "true";

// --- LA-1: Layer admission (tri-state, defaults to off) ---

/**
 * 资格层准入模式：默认检索是否只召回 durable 层（提炼结论），把 evidence
 * （transcript 碎片）留给 deja / 显式溯源。
 *
 *   off      — 默认，完全不生效（现网行为不变）
 *   observe  — 只计算并记录"会过滤掉什么"，返回结果不变（影子期）
 *   on       — 真正过滤
 */
export const layerAdmission = (): "off" | "observe" | "on" => {
  const v = process.env.RECALLNEST_LAYER_ADMISSION;
  return v === "on" || v === "observe" ? v : "off";
};

/** durable 层命中数低于此值时回退到全量候选池，避免"宁缺毋滥"变成"什么都没有"。 */
export const layerAdmissionMin = (): number => {
  const n = Number(process.env.RECALLNEST_LAYER_ADMISSION_MIN);
  return Number.isFinite(n) && n > 0 ? n : 3;
};

// --- String settings with `||` default (empty string falls through) ---

export const dataDir = (): string => process.env.RECALLNEST_DATA_DIR || "data";

export const mcpTier = (): "core" | "advanced" | "full" =>
  (process.env.RECALLNEST_MCP_TIER || "advanced") as "core" | "advanced" | "full";

// --- LanceDB read consistency (cross-process visibility) ---

/**
 * Read consistency interval (seconds) resolved for lancedb.connect().
 * Without it a long-lived table handle pins its manifest version and never
 * sees writes committed by other processes (CLI ingest vs resident MCP/API/UI
 * servers). Explicit StoreConfig.readConsistencyInterval wins over this env.
 *
 * Unset / empty  → 0 (strong consistency: check for external commits per read)
 * "off" | "none" → undefined (legacy unchecked-handle behavior, escape hatch)
 * number ≥ 0     → bounded staleness window in seconds (invalid values → 0)
 */
export const readConsistencyInterval = (): number | undefined => {
  const raw = process.env.RECALLNEST_READ_CONSISTENCY_INTERVAL;
  if (raw === undefined || raw === "") return 0;
  if (raw === "off" || raw === "none") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * Wall-clock budget (ms) for one `dream --auto` sweep.
 *
 * NOT a pure movement (unlike every accessor above): the original inline read in
 * cli.ts was `Number(process.env.X ?? DEFAULT)`, which had two silent failure
 * modes — `""` slipped past `??` and became **0** (every scope skipped, run is a
 * no-op that still reports ok), and any non-numeric value became **NaN**, making
 * the `Date.now() > deadline` guard permanently false. The second one silently
 * reverts the very incident this budget exists to prevent: the 2026-07-24 sweep
 * ran 4d15h and blocked three days of scheduled runs. Both are corrected here
 * on purpose; do not "restore" the original parsing.
 *
 * Unset / empty / non-finite / <= 0 → caller's fallback.
 */
export const dreamBudgetMs = (fallbackMs: number): number => {
  const raw = process.env.RECALLNEST_DREAM_BUDGET_MS;
  if (raw === undefined || raw.trim() === "") return fallbackMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallbackMs;
};

/**
 * dream 合成（cluster insight / cross-memory pattern）专用模型，覆盖 config.llm.model。
 *
 * 独立于全局模型的理由（2026-08-23）：合成是全库唯一一处「产物质量直接决定库的
 * 可用性」的 LLM 调用 —— 它写进去的东西会被当成记忆检索出来，而 ingest 侧的
 * smartExtract 只是给原文打标签，错了还能回原文。三臂实验里模型贡献了约 1/3 的
 * 改善（同提示词下 32.3% → 45.2%），把这一档单独抬上去，不必让全库调用一起涨价。
 *
 * 未设 / 空串 → 用 config.llm.model（即全局默认），保持老行为。
 */
export const synthesisModel = (): string | undefined => {
  const raw = process.env.RECALLNEST_SYNTHESIS_MODEL;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Per-request timeout (ms) for the embedding client, overriding `embedding.timeoutMs`
 * in config.json.
 *
 * Exists so the timeout can be set per deployment (the resident MCP server, a one-off
 * CLI ingest) without editing the shared config file — the same reason
 * `RECALLNEST_LAYER_ADMISSION` lives here.
 *
 * Unset / empty / non-finite / <= 0 → undefined, i.e. fall through to config.json and
 * ultimately to the SDK default. **Not setting it anywhere keeps the old behavior.**
 */
export const embeddingTimeoutMs = (): number | undefined => {
  const raw = process.env.RECALLNEST_EMBEDDING_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// --- Raw env values (caller validates / clamps / falls back to config) ---

export const recallModeRaw = (): string | undefined => process.env.RECALLNEST_RECALL_MODE;

export const uiPortRaw = (): string | undefined => process.env.RECALLNEST_UI_PORT;

export const apiPortRaw = (): string | undefined => process.env.RECALLNEST_API_PORT;

// --- Gateway (read-only front door; caller validates / clamps) ---

export const gatewayPortRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_PORT;

export const gatewayHostRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_HOST;

export const gatewayTokenRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_TOKEN;

export const gatewayRateMaxRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_RATE_MAX;

export const gatewayFileRootsRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_FILE_ROOTS;

export const gatewayRgRaw = (): string | undefined => process.env.RECALLNEST_GATEWAY_RG;

export const apiUrlRaw = (): string | undefined => process.env.RECALLNEST_API_URL;
