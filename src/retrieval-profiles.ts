import {
  DEFAULT_CATEGORY_MIN_SCORES,
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalConfig,
} from "./retriever.js";

export type RetrievalProfileName = "default" | "writing" | "debug" | "fact-check";

/**
 * Scale the default per-category thresholds by how loose/tight a profile is overall.
 *
 * Why this exists: a profile used to override `hardMinScore` only, while
 * `Retriever.minScoreFor()` reads `categoryMinScores` first and only falls back to
 * `hardMinScore` for categories not listed. Since the default map lists every
 * category, a profile's looser/tighter intent never reached category admission at
 * all — picking `debug` ("I want episodic detail") still admitted `events` at 0.35
 * and `patterns` at 0.45, exactly as `default` would.
 *
 * IMPORTANT: the returned map must stay complete. A partial map would silently send
 * unlisted categories to `hardMinScore` instead of their default threshold.
 *
 * simplified: proportional scaling only — the *relative* ordering across categories
 * is inherited from DEFAULT_CATEGORY_MIN_SCORES unchanged. Re-designing that ordering
 * per profile (e.g. `debug` favouring episodic categories, `writing` favouring
 * semantic ones) is the better end state but needs canary evidence to pick numbers;
 * do that via `bun run eval:canary` before touching the ratios here.
 */
function scaledCategoryMinScores(profileHardMinScore: number): Record<string, number> {
  const factor = profileHardMinScore / DEFAULT_RETRIEVAL_CONFIG.hardMinScore;
  return Object.fromEntries(
    Object.entries(DEFAULT_CATEGORY_MIN_SCORES).map(([category, minScore]) => [
      category,
      Math.round(minScore * factor * 1000) / 1000,
    ]),
  );
}

// Kept as named constants so each profile's `hardMinScore` and its scaled category
// thresholds cannot drift apart.
const WRITING_HARD_MIN_SCORE = 0.24;
const DEBUG_HARD_MIN_SCORE = 0.34;
const FACT_CHECK_HARD_MIN_SCORE = 0.38;

export interface RetrievalProfileDefinition {
  name: RetrievalProfileName;
  label: string;
  description: string;
  overrides: Partial<RetrievalConfig>;
}

export const RETRIEVAL_PROFILES: Record<RetrievalProfileName, RetrievalProfileDefinition> = {
  default: {
    name: "default",
    label: "General Recall",
    description: "Balanced hybrid retrieval for everyday memory search.",
    overrides: {},
  },
  writing: {
    name: "writing",
    label: "Writing Brief",
    description: "Prefer broader semantic recall and tolerate older but reusable material.",
    overrides: {
      vectorWeight: 0.8,
      bm25Weight: 0.2,
      candidatePoolSize: 28,
      recencyHalfLifeDays: 90,
      recencyWeight: 0.06,
      timeDecayHalfLifeDays: 365,
      hardMinScore: WRITING_HARD_MIN_SCORE,
      categoryMinScores: scaledCategoryMinScores(WRITING_HARD_MIN_SCORE),
      lengthNormAnchor: 800,
    },
  },
  debug: {
    name: "debug",
    label: "Debug Trace",
    description: "Favor recent, exact-match operational details such as errors, commands, and fixes.",
    overrides: {
      vectorWeight: 0.55,
      bm25Weight: 0.45,
      candidatePoolSize: 24,
      recencyHalfLifeDays: 7,
      recencyWeight: 0.15,
      timeDecayHalfLifeDays: 30,
      hardMinScore: DEBUG_HARD_MIN_SCORE,
      categoryMinScores: scaledCategoryMinScores(DEBUG_HARD_MIN_SCORE),
      lengthNormAnchor: 420,
    },
  },
  "fact-check": {
    name: "fact-check",
    label: "Fact Check",
    description: "Favor exact evidence and fresher records; tighten the cutoff to reduce weak matches.",
    overrides: {
      vectorWeight: 0.5,
      bm25Weight: 0.5,
      candidatePoolSize: 26,
      recencyHalfLifeDays: 21,
      recencyWeight: 0.08,
      timeDecayHalfLifeDays: 45,
      hardMinScore: FACT_CHECK_HARD_MIN_SCORE,
      categoryMinScores: scaledCategoryMinScores(FACT_CHECK_HARD_MIN_SCORE),
      lengthNormAnchor: 360,
    },
  },
};

export function normalizeRetrievalProfile(input?: string): RetrievalProfileName {
  const normalized = (input || "default").trim().toLowerCase();
  if (!normalized) return "default";
  if (normalized === "factcheck" || normalized === "fact_check") return "fact-check";
  if (normalized === "general") return "default";
  if (normalized in RETRIEVAL_PROFILES) {
    return normalized as RetrievalProfileName;
  }
  throw new Error(
    `Unknown retrieval profile: ${input}. Available: ${Object.keys(RETRIEVAL_PROFILES).join(", ")}`,
  );
}

export function applyRetrievalProfile(
  baseConfig: RetrievalConfig,
  profileName?: string,
): { profile: RetrievalProfileDefinition; config: RetrievalConfig } {
  const resolvedName = normalizeRetrievalProfile(profileName);
  const profile = RETRIEVAL_PROFILES[resolvedName];
  return {
    profile,
    config: {
      ...baseConfig,
      ...profile.overrides,
    },
  };
}

export function listRetrievalProfiles(): RetrievalProfileDefinition[] {
  return [
    RETRIEVAL_PROFILES.default,
    RETRIEVAL_PROFILES.writing,
    RETRIEVAL_PROFILES.debug,
    RETRIEVAL_PROFILES["fact-check"],
  ];
}
