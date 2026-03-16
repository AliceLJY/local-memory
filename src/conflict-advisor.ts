import type { ConflictCandidateRecord, ConflictReason } from "./conflict-schema.js";
import { summarizeConflictLifecycle, type ConflictAttention, CONFLICT_ATTENTION_LEVELS } from "./conflict-lifecycle.js";
import { normalizeCanonicalKey } from "./memory-boundaries.js";

export const CONFLICT_SUGGESTED_RESOLUTIONS = [
  "keep_existing",
  "accept_incoming",
  "manual_review",
] as const;

export const CONFLICT_ADVICE_CONFIDENCES = [
  "low",
  "medium",
  "high",
] as const;

export type ConflictSuggestedResolution = (typeof CONFLICT_SUGGESTED_RESOLUTIONS)[number];
export type ConflictAdviceConfidence = (typeof CONFLICT_ADVICE_CONFIDENCES)[number];

export interface ConflictAdviceSummary {
  suggestedResolution: ConflictSuggestedResolution;
  confidence: ConflictAdviceConfidence;
  similarity: number;
  clusterKey: string;
  clusterLabel: string;
  mergeSuggestion?: string;
  reasons: string[];
}

export interface ConflictClusterSummary {
  clusterKey: string;
  clusterLabel: string;
  canonicalKey: string;
  category: string;
  reason: ConflictReason;
  totalCount: number;
  openCount: number;
  latestUpdatedAt: string;
  latestConflictId: string;
  attention: ConflictAttention;
  attentionCounts: Record<ConflictAttention, number>;
  suggestedResolution: ConflictSuggestedResolution;
  confidence: ConflictAdviceConfidence;
}

export interface ConflictAuditSummary {
  totalConflicts: number;
  totalClusters: number;
  openConflicts: number;
  openClusters: number;
  attentionCounts: Record<ConflictAttention, number>;
  priorityClusters: ConflictClusterSummary[];
  suggestedActions: string[];
}

function compactConflictText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function buildCharacterNgrams(text: string): Set<string> {
  if (text.length <= 3) {
    return new Set(text ? [text] : []);
  }

  const grams = new Set<string>();
  for (let i = 0; i <= text.length - 3; i += 1) {
    grams.add(text.slice(i, i + 3));
  }
  return grams;
}

function calculateTextSimilarity(existingText: string, incomingText: string): number {
  if (!existingText || !incomingText) return 0;
  if (existingText === incomingText) return 1;

  const existing = buildCharacterNgrams(existingText);
  const incoming = buildCharacterNgrams(incomingText);
  if (existing.size === 0 || incoming.size === 0) return 0;

  let intersection = 0;
  for (const gram of existing) {
    if (incoming.has(gram)) {
      intersection += 1;
    }
  }

  const union = new Set([...existing, ...incoming]).size;
  return union === 0 ? 0 : intersection / union;
}

function roundSimilarity(value: number): number {
  return Math.round(value * 100) / 100;
}

function stripTrailingClausePunctuation(text: string): string {
  return text.trim().replace(/[。！？!?；;，,]+$/gu, "").trim();
}

function splitConflictClauses(text: string): string[] {
  const primary = text
    .split(/[。！？!?；;\n]+/u)
    .map(stripTrailingClausePunctuation)
    .filter(Boolean);
  if (primary.length > 1) return primary;

  return text
    .split(/[，,]+/u)
    .map(stripTrailingClausePunctuation)
    .filter(Boolean);
}

function buildMergedClauseList(existingText: string, incomingText: string): string[] {
  const merged: Array<{ raw: string; normalized: string }> = [];

  const pushClause = (clause: string) => {
    const raw = stripTrailingClausePunctuation(clause);
    const normalized = compactConflictText(raw);
    if (!normalized) return;

    const overlappingIndex = merged.findIndex((item) =>
      item.normalized === normalized
      || item.normalized.includes(normalized)
      || normalized.includes(item.normalized),
    );

    if (overlappingIndex >= 0) {
      const existing = merged[overlappingIndex];
      if (existing && raw.length > existing.raw.length) {
        merged[overlappingIndex] = { raw, normalized };
      }
      return;
    }

    merged.push({ raw, normalized });
  };

  for (const clause of splitConflictClauses(existingText)) {
    pushClause(clause);
  }
  for (const clause of splitConflictClauses(incomingText)) {
    pushClause(clause);
  }

  return merged.map((item) => item.raw);
}

function hasChinese(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

function joinMergedClauses(clauses: string[], preferChinese: boolean): string | undefined {
  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return clauses[0];

  if (preferChinese) {
    return `${clauses.join("；")}。`;
  }

  return `${clauses.join(". ")}.`;
}

function buildMergeSuggestion(
  record: ConflictCandidateRecord,
  similarity: number,
  suggestedResolution: ConflictSuggestedResolution,
): string | undefined {
  if (record.reason !== "promotion_conflicts_with_existing_durable") return undefined;
  if (record.existing.category !== record.incoming.category) return undefined;
  if (suggestedResolution !== "manual_review") return undefined;
  if (similarity < 0.35 || similarity >= 0.98) return undefined;

  const clauses = buildMergedClauseList(record.existing.text, record.incoming.text);
  const merged = joinMergedClauses(
    clauses,
    hasChinese(record.existing.text) || hasChinese(record.incoming.text),
  );
  if (!merged) return undefined;

  const mergedCompact = compactConflictText(merged);
  const existingCompact = compactConflictText(record.existing.text);
  const incomingCompact = compactConflictText(record.incoming.text);
  if (!mergedCompact || mergedCompact === existingCompact || mergedCompact === incomingCompact) {
    return undefined;
  }

  const maxSourceLength = Math.max(record.existing.text.length, record.incoming.text.length);
  if (merged.length > maxSourceLength + 180) {
    return undefined;
  }

  return merged;
}

export function buildConflictClusterKey(record: ConflictCandidateRecord): string {
  const canonicalKey = normalizeCanonicalKey(record.canonicalKey) || "na";
  return [
    canonicalKey,
    record.reason,
    record.category,
  ].join("::").slice(0, 240);
}

function pickClusterAttention(
  attentionCounts: Record<ConflictAttention, number>,
  openCount: number,
): ConflictAttention {
  if (openCount <= 0) return "resolved";
  if (attentionCounts.escalated > 0) return "escalated";
  if (attentionCounts.stale > 0) return "stale";
  if (attentionCounts.aging > 0) return "aging";
  return "fresh";
}

function attentionRank(attention: ConflictAttention): number {
  switch (attention) {
    case "escalated":
      return 5;
    case "stale":
      return 4;
    case "aging":
      return 3;
    case "fresh":
      return 2;
    case "resolved":
    default:
      return 1;
  }
}

export function summarizeConflictAdvice(record: ConflictCandidateRecord): ConflictAdviceSummary {
  const lifecycle = summarizeConflictLifecycle(record);
  const existingCompact = compactConflictText(record.existing.text);
  const incomingCompact = compactConflictText(record.incoming.text);
  const similarity = roundSimilarity(calculateTextSimilarity(existingCompact, incomingCompact));
  const clusterKey = buildConflictClusterKey(record);
  const clusterLabel = `${record.category} / ${record.canonicalKey}`;
  const reasons: string[] = [];

  let suggestedResolution: ConflictSuggestedResolution = "manual_review";
  let confidence: ConflictAdviceConfidence = "low";

  if (existingCompact && incomingCompact && existingCompact === incomingCompact) {
    suggestedResolution = "keep_existing";
    confidence = "high";
    reasons.push("Incoming text is equivalent to the existing durable memory.");
  } else if (
    record.reason === "canonical_key_conflicts_with_existing_durable" &&
    record.existing.category !== record.incoming.category
  ) {
    suggestedResolution = "keep_existing";
    confidence = lifecycle.reopenCount > 0 ? "high" : "medium";
    reasons.push("The canonical key is already owned by another durable category.");
  } else if (
    record.reason === "promotion_conflicts_with_existing_durable" &&
    record.existing.category === record.incoming.category &&
    similarity >= 0.72
  ) {
    if (incomingCompact.length + 2 < existingCompact.length) {
      suggestedResolution = "accept_incoming";
      confidence = "medium";
      reasons.push("Incoming text looks like a tighter rewrite of the same durable memory.");
    } else if (existingCompact.length + 2 < incomingCompact.length) {
      suggestedResolution = "keep_existing";
      confidence = "medium";
      reasons.push("Existing durable text already looks like the tighter rewrite.");
    } else {
      suggestedResolution = "manual_review";
      confidence = "low";
      reasons.push("Both texts are very similar, but neither is clearly the better durable phrasing.");
    }
  } else if (similarity < 0.35) {
    suggestedResolution = "manual_review";
    confidence = lifecycle.needsAttention ? "high" : "medium";
    reasons.push("Existing and incoming texts diverge materially and need human review.");
  } else {
    reasons.push("Conflict needs an operator decision before updating the durable owner.");
  }

  const mergeSuggestion = buildMergeSuggestion(record, similarity, suggestedResolution);
  if (mergeSuggestion) {
    reasons.push("A merged durable wording suggestion is available for manual review.");
  }

  if (lifecycle.attention === "stale" || lifecycle.attention === "escalated") {
    reasons.push(`Conflict is ${lifecycle.attention} and should be reviewed soon.`);
  } else if (lifecycle.reopenCount > 0) {
    reasons.push("This conflict has reopened before; verify the prior decision still holds.");
  }

  return {
    suggestedResolution,
    confidence,
    similarity,
    clusterKey,
    clusterLabel,
    ...(mergeSuggestion ? { mergeSuggestion } : {}),
    reasons,
  };
}

export function clusterConflicts(records: ConflictCandidateRecord[]): ConflictClusterSummary[] {
  const grouped = new Map<string, {
    latest: ConflictCandidateRecord;
    totalCount: number;
    openCount: number;
    attentionCounts: Record<ConflictAttention, number>;
  }>();

  for (const record of records) {
    const key = buildConflictClusterKey(record);
    const existing = grouped.get(key);
    const lifecycle = summarizeConflictLifecycle(record);
    if (!existing) {
      grouped.set(key, {
        latest: record,
        totalCount: 1,
        openCount: record.status === "open" ? 1 : 0,
        attentionCounts: Object.fromEntries(
          CONFLICT_ATTENTION_LEVELS.map((attention) => [attention, attention === lifecycle.attention ? 1 : 0]),
        ) as Record<ConflictAttention, number>,
      });
      continue;
    }

    existing.totalCount += 1;
    if (record.status === "open") {
      existing.openCount += 1;
    }
    existing.attentionCounts[lifecycle.attention] += 1;
    if (Date.parse(record.updatedAt) >= Date.parse(existing.latest.updatedAt)) {
      existing.latest = record;
    }
  }

  return [...grouped.entries()]
    .map(([clusterKey, group]) => {
      const advice = summarizeConflictAdvice(group.latest);
      return {
        clusterKey,
        clusterLabel: advice.clusterLabel,
        canonicalKey: group.latest.canonicalKey,
        category: group.latest.category,
        reason: group.latest.reason,
        totalCount: group.totalCount,
        openCount: group.openCount,
        latestUpdatedAt: group.latest.updatedAt,
        latestConflictId: group.latest.conflictId,
        attention: pickClusterAttention(group.attentionCounts, group.openCount),
        attentionCounts: group.attentionCounts,
        suggestedResolution: advice.suggestedResolution,
        confidence: advice.confidence,
      };
    })
    .sort((a, b) => {
      const attentionDiff = attentionRank(b.attention) - attentionRank(a.attention);
      if (attentionDiff !== 0) return attentionDiff;
      if (b.openCount !== a.openCount) return b.openCount - a.openCount;
      const timeDiff = Date.parse(b.latestUpdatedAt) - Date.parse(a.latestUpdatedAt);
      if (timeDiff !== 0) return timeDiff;
      return a.clusterKey.localeCompare(b.clusterKey);
    });
}

export function buildConflictAuditSummary(
  records: ConflictCandidateRecord[],
  top = 5,
): ConflictAuditSummary {
  const clusters = clusterConflicts(records);
  const attentionCounts = Object.fromEntries(
    CONFLICT_ATTENTION_LEVELS.map((attention) => [attention, 0]),
  ) as Record<ConflictAttention, number>;

  for (const record of records) {
    const lifecycle = summarizeConflictLifecycle(record);
    attentionCounts[lifecycle.attention] += 1;
  }

  const openClusters = clusters.filter((cluster) => cluster.openCount > 0);
  const priorityClusters = openClusters
    .slice()
    .sort((a, b) => {
      const attentionDiff = attentionRank(b.attention) - attentionRank(a.attention);
      if (attentionDiff !== 0) return attentionDiff;
      if (b.openCount !== a.openCount) return b.openCount - a.openCount;
      const timeDiff = Date.parse(b.latestUpdatedAt) - Date.parse(a.latestUpdatedAt);
      if (timeDiff !== 0) return timeDiff;
      return a.clusterKey.localeCompare(b.clusterKey);
    })
    .slice(0, Math.max(1, top));

  const suggestedActions: string[] = [];
  const escalatedClusters = openClusters.filter((cluster) => cluster.attention === "escalated");
  const staleClusters = openClusters.filter((cluster) => cluster.attention === "stale");
  const highConfidenceKeeps = openClusters.filter(
    (cluster) => cluster.confidence === "high" && cluster.suggestedResolution === "keep_existing",
  );
  const highConfidenceAccepts = openClusters.filter(
    (cluster) => cluster.confidence === "high" && cluster.suggestedResolution === "accept_incoming",
  );

  if (openClusters.length === 0) {
    suggestedActions.push("No open conflicts need review.");
  } else {
    if (escalatedClusters.length > 0) {
      suggestedActions.push(`Resolve ${escalatedClusters.length} escalated cluster(s) first.`);
    }
    if (staleClusters.length > 0) {
      suggestedActions.push(`Review ${staleClusters.length} stale cluster(s) before they keep reopening.`);
    }
    if (highConfidenceKeeps.length > 0) {
      suggestedActions.push(`${highConfidenceKeeps.length} open cluster(s) look safe to keep_existing.`);
    }
    if (highConfidenceAccepts.length > 0) {
      suggestedActions.push(`${highConfidenceAccepts.length} open cluster(s) look safe to accept_incoming.`);
    }
    if (suggestedActions.length === 0) {
      suggestedActions.push("Open conflicts remain, but they still need manual review.");
    }
  }

  return {
    totalConflicts: records.length,
    totalClusters: clusters.length,
    openConflicts: records.filter((record) => record.status === "open").length,
    openClusters: openClusters.length,
    attentionCounts,
    priorityClusters,
    suggestedActions,
  };
}
