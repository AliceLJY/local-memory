/**
 * Prospective Memory — Tier 3.4
 *
 * "Remind me about Y next time X comes up"
 *
 * Stores reminders as pattern memories with special `prospective` metadata.
 * During retrieval, pending triggers are checked against the query.
 * When a trigger fires, the reminder is injected into context.
 *
 * Data model: stored as category="patterns" with metadata.prospective = {
 *   trigger, action, status, createdAt, firedAt?, expiresAt?
 * }
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { Embedder } from "./embedder.js";
import { logInfo } from "./stderr-log.js";
import type { ScoredPrediction, PredictionContext } from "./prediction-engine.js";
import { collectSignals, scorePredictions } from "./prediction-engine.js";
import { isPredictiveMemoryEnabled } from "./memory-schema.js";

// ============================================================================
// Types
// ============================================================================

export interface ProspectiveMetadata {
  trigger: string;
  action: string;
  status: "pending" | "fired" | "expired";
  createdAt: string;
  firedAt?: string;
  expiresAt?: string;
  /** HP-predictive: "explicit" = user-created, "predicted" = heuristic-generated */
  source?: "explicit" | "predicted";
  /** HP-predictive: confidence score 0-1 for predicted reminders */
  confidence?: number;
  /** HP-predictive: evidence strings explaining why this was predicted */
  evidence?: string[];
  /** HP-predictive: last time this prediction was surfaced to the user */
  lastSuggestedAt?: string;
  /** HP-predictive: when the user accepted/acted on this predicted reminder */
  acceptedAt?: string;
}

export interface Reminder {
  entryId: string;
  trigger: string;
  action: string;
}

export interface SetReminderParams {
  trigger: string;
  action: string;
  scope: string;
  expiresInDays?: number;
}

export interface SuggestedReminder {
  entryId: string;
  trigger: string;
  action: string;
  confidence: number;
  evidence: string[];
}

/** Default expiry for predicted reminders: 7 days */
const PREDICTED_REMINDER_EXPIRY_DAYS = 7;

/** Confidence penalty per ignored suggestion cycle */
const IGNORE_CONFIDENCE_PENALTY = 0.15;

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Create a new reminder (prospective memory).
 * Stored as a pattern entry with prospective metadata.
 */
export async function setReminder(
  store: MemoryStore,
  embedder: Embedder,
  params: SetReminderParams,
): Promise<MemoryEntry> {
  const text = `[Reminder] When "${params.trigger}" comes up: ${params.action}`;
  const vector = await embedder.embedPassage(text);

  const prospective: ProspectiveMetadata = {
    trigger: params.trigger,
    action: params.action,
    status: "pending",
    source: "explicit",
    createdAt: new Date().toISOString(),
    ...(params.expiresInDays
      ? { expiresAt: new Date(Date.now() + params.expiresInDays * 86_400_000).toISOString() }
      : {}),
  };

  return store.store({
    text,
    vector,
    category: "patterns",
    scope: params.scope,
    importance: 0.75,
    metadata: JSON.stringify({
      prospective,
      tier: "working",
      boundary: { layer: "durable", authority: "user" },
    }),
  });
}

/**
 * Check pending reminders against a query text.
 * Returns reminders whose trigger matches the query (simple keyword check).
 *
 * @param store       Memory store
 * @param embedder    Embedder for vector search
 * @param query       The user's query/message
 * @param scopeFilter Scopes to check
 * @returns Array of matching reminders (may be empty)
 */
export async function checkTriggers(
  store: MemoryStore,
  embedder: Embedder,
  query: string,
  scopeFilter?: string[],
): Promise<Reminder[]> {
  // Vector search for similar prospective memories
  const queryVector = await embedder.embedPassage(query);
  const candidates = await store.vectorSearch(queryVector, 10, 0.3, scopeFilter);

  const now = new Date().toISOString();
  const reminders: Reminder[] = [];

  for (const candidate of candidates) {
    const meta = parseMetadata(candidate.entry.metadata);
    const prospective = meta.prospective as ProspectiveMetadata | undefined;

    if (!prospective || prospective.status !== "pending") continue;

    // Check expiration
    if (prospective.expiresAt && prospective.expiresAt < now) {
      // Mark as expired
      prospective.status = "expired";
      meta.prospective = prospective;
      await store.update(candidate.entry.id, { metadata: JSON.stringify(meta) }, scopeFilter);
      continue;
    }

    // Check if trigger matches query (case-insensitive keyword match)
    if (triggerMatches(prospective.trigger, query)) {
      reminders.push({
        entryId: candidate.entry.id,
        trigger: prospective.trigger,
        action: prospective.action,
      });
    }
  }

  return reminders;
}

/**
 * Fire a reminder — mark it as fired and return the action text.
 */
export async function fireReminder(
  store: MemoryStore,
  entryId: string,
  scopeFilter?: string[],
): Promise<string | null> {
  const entry = await store.getById(entryId);
  if (!entry) return null;

  const meta = parseMetadata(entry.metadata);
  const prospective = meta.prospective as ProspectiveMetadata | undefined;
  if (!prospective || prospective.status !== "pending") return null;

  prospective.status = "fired";
  prospective.firedAt = new Date().toISOString();
  meta.prospective = prospective;

  await store.update(entryId, { metadata: JSON.stringify(meta) }, scopeFilter);

  logInfo(`[INFO] Reminder fired: "${prospective.trigger}" → ${prospective.action}`);

  return prospective.action;
}

/**
 * Format fired reminders for injection into context.
 */
export function formatReminders(reminders: Reminder[]): string[] {
  return reminders.map(r =>
    `[Reminder] Triggered by "${r.trigger}": ${r.action}`
  );
}

// ============================================================================
// HP-predictive: Predicted Reminders
// ============================================================================

/**
 * Generate predicted reminders from behavioral signals.
 * Deduplicates against existing pending reminders via vector similarity.
 * Stores new predictions as ephemeral entries with 7-day expiry.
 *
 * @returns Array of suggested reminders to surface to the user
 */
export async function suggestPredictedReminders(
  store: MemoryStore,
  embedder: Embedder,
  predictionContext: PredictionContext,
  scope: string,
): Promise<SuggestedReminder[]> {
  if (!isPredictiveMemoryEnabled()) return [];

  // 1. Collect and score signals
  const signals = collectSignals(predictionContext);
  const predictions = scorePredictions(signals);

  if (predictions.length === 0) return [];

  const suggested: SuggestedReminder[] = [];
  const now = predictionContext.now ?? new Date();

  for (const prediction of predictions) {
    // 2. Deduplicate: vector search for similar existing reminders
    const isDuplicate = await isDuplicateReminder(store, embedder, prediction, [scope]);
    if (isDuplicate) continue;

    // 3. Store as predicted + ephemeral reminder with 7-day expiry
    const text = `[Predicted Reminder] ${prediction.action}`;
    const vector = await embedder.embedPassage(text);

    const prospective: ProspectiveMetadata = {
      trigger: prediction.trigger,
      action: prediction.action,
      status: "pending",
      source: "predicted",
      confidence: prediction.confidence,
      evidence: prediction.evidence,
      lastSuggestedAt: now.toISOString(),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PREDICTED_REMINDER_EXPIRY_DAYS * 86_400_000).toISOString(),
    };

    const entry = await store.store({
      text,
      vector,
      category: "patterns",
      scope,
      importance: 0.5, // Lower than explicit reminders (0.75)
      metadata: JSON.stringify({
        prospective,
        tier: "working",
        privacyTier: "ephemeral",
        boundary: { layer: "ephemeral", authority: "system" },
      }),
    });

    suggested.push({
      entryId: entry.id,
      trigger: prediction.trigger,
      action: prediction.action,
      confidence: prediction.confidence,
      evidence: prediction.evidence,
    });

    logInfo(`[INFO] Predicted reminder stored: "${prediction.trigger}" (confidence: ${prediction.confidence})`);
  }

  return suggested;
}

/**
 * Accept a predicted reminder — upgrade it to explicit, persist as durable.
 */
export async function acceptPredictedReminder(
  store: MemoryStore,
  entryId: string,
  scopeFilter?: string[],
): Promise<boolean> {
  const entry = await store.getById(entryId);
  if (!entry) return false;

  const meta = parseMetadata(entry.metadata);
  const prospective = meta.prospective as ProspectiveMetadata | undefined;
  if (!prospective || prospective.source !== "predicted" || prospective.status !== "pending") return false;

  // Upgrade: predicted → explicit, ephemeral → durable
  prospective.source = "explicit";
  prospective.acceptedAt = new Date().toISOString();
  meta.prospective = prospective;
  meta.privacyTier = "durable";
  if (meta.boundary && typeof meta.boundary === "object") {
    (meta.boundary as Record<string, string>).layer = "durable";
    (meta.boundary as Record<string, string>).authority = "user";
  }

  await store.update(entryId, {
    metadata: JSON.stringify(meta),
    importance: 0.75, // Upgrade to explicit-level importance
  }, scopeFilter);

  logInfo(`[INFO] Predicted reminder accepted and promoted: ${entryId}`);
  return true;
}

/**
 * Demote a predicted reminder — reduce confidence.
 * If confidence drops below threshold after penalty, mark as expired.
 */
export async function demotePredictedReminder(
  store: MemoryStore,
  entryId: string,
  scopeFilter?: string[],
): Promise<boolean> {
  const entry = await store.getById(entryId);
  if (!entry) return false;

  const meta = parseMetadata(entry.metadata);
  const prospective = meta.prospective as ProspectiveMetadata | undefined;
  if (!prospective || prospective.source !== "predicted" || prospective.status !== "pending") return false;

  const newConfidence = Math.max(0, (prospective.confidence ?? 0) - IGNORE_CONFIDENCE_PENALTY);

  if (newConfidence < 0.6) {
    // Below threshold — expire it
    prospective.status = "expired";
    prospective.confidence = newConfidence;
    meta.prospective = prospective;
    await store.update(entryId, { metadata: JSON.stringify(meta) }, scopeFilter);
    logInfo(`[INFO] Predicted reminder demoted below threshold and expired: ${entryId}`);
  } else {
    // Still above threshold — just lower confidence
    prospective.confidence = newConfidence;
    prospective.lastSuggestedAt = new Date().toISOString();
    meta.prospective = prospective;
    await store.update(entryId, { metadata: JSON.stringify(meta) }, scopeFilter);
    logInfo(`[INFO] Predicted reminder demoted: ${entryId} (new confidence: ${newConfidence})`);
  }

  return true;
}

/**
 * Format suggested reminders for output in search_memory results.
 */
export function formatSuggestedReminders(suggestions: SuggestedReminder[]): string {
  if (suggestions.length === 0) return "";

  const lines = suggestions.map(s => {
    const confidenceLabel = s.confidence >= 0.8 ? "high" : s.confidence >= 0.7 ? "medium" : "low";
    return `- [${confidenceLabel}] ${s.action}\n  Evidence: ${s.evidence.join("; ")}`;
  });

  return "\n\n--- Suggested Reminders ---\n" + lines.join("\n");
}

/**
 * Check if a prediction duplicates an existing pending reminder.
 * Uses vector similarity — threshold 0.75 = likely duplicate.
 */
async function isDuplicateReminder(
  store: MemoryStore,
  embedder: Embedder,
  prediction: ScoredPrediction,
  scopeFilter: string[],
): Promise<boolean> {
  const searchText = `${prediction.trigger} ${prediction.action}`;
  const vector = await embedder.embedPassage(searchText);
  const candidates = await store.vectorSearch(vector, 5, 0.75, scopeFilter);

  for (const candidate of candidates) {
    const meta = parseMetadata(candidate.entry.metadata);
    const prospective = meta.prospective as ProspectiveMetadata | undefined;
    if (prospective && prospective.status === "pending") {
      return true; // Found an existing pending reminder that's similar enough
    }
  }

  return false;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if a trigger string matches a query.
 * Uses case-insensitive keyword matching with word boundary awareness.
 */
function triggerMatches(trigger: string, query: string): boolean {
  const triggerLower = trigger.toLowerCase();
  const queryLower = query.toLowerCase();

  // Split trigger into keywords
  const keywords = triggerLower.split(/\s+/).filter(w => w.length >= 2);

  if (keywords.length === 0) return false;

  // All keywords must appear in query
  return keywords.every(kw => queryLower.includes(kw));
}

function parseMetadata(raw?: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
