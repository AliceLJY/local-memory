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
