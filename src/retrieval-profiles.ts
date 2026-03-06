import type { RetrievalConfig } from "./retriever.js";

export type RetrievalProfileName = "default" | "writing" | "debug" | "fact-check";

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
      hardMinScore: 0.24,
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
      hardMinScore: 0.34,
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
      hardMinScore: 0.38,
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
