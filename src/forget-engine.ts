/**
 * Forget Engine — Ethics-aware memory deletion with full cascade.
 *
 * Philosophy: "The right to forget" — memories can be explicitly removed,
 * but the process must be auditable, reversible (via evidence export),
 * and propagated to all derived artifacts (KG triples, pins, evolution chains).
 *
 * Sequence:
 * 1. Fetch target memory
 * 2. Privacy tier check (durable requires explicit confirm)
 * 3. Evidence export (snapshot before deletion for audit trail)
 * 4. KG triple cleanup (via KGStore.deleteBySource)
 * 5. Pin archive (mark related pins as forgotten)
 * 6. Cascade demote (related memories via cascade-forget.ts)
 * 7. Primary delete (remove from LanceDB)
 * 8. Audit log (record the forget operation)
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { KGStore } from "./kg-store.js";
import type { AuditLogger } from "./audit-log.js";
import { parsePrivacyTier, type PrivacyTier } from "./memory-schema.js";
import { parseEvolution, patchEvolution } from "./memory-evolution.js";
import { cascadeForget, type CascadeForgetConfig, DEFAULT_CASCADE_FORGET_CONFIG } from "./cascade-forget.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForgetRequest {
  /** Memory ID to forget (full UUID or 8+ hex prefix) */
  memoryId: string;
  /** Explicit confirmation — required for "durable" tier memories */
  confirm: boolean;
  /** Reason for forgetting (audit trail) */
  reason?: string;
  /** Scope filter for permission check */
  scopeFilter?: string[];
}

export interface ForgetEvidence {
  /** Snapshot of the memory before deletion */
  entry: MemoryEntry;
  /** Privacy tier at time of deletion */
  privacyTier: PrivacyTier;
  /** Evolution chain snapshot */
  evolution: ReturnType<typeof parseEvolution>;
  /** Timestamp of forget operation */
  forgottenAt: string;
  /** Reason provided */
  reason?: string;
}

export interface ForgetResult {
  /** Whether the memory was successfully forgotten */
  success: boolean;
  /** ID of the forgotten memory */
  memoryId: string;
  /** Evidence snapshot (for audit/undo) */
  evidence?: ForgetEvidence;
  /** Number of KG triples removed */
  kgTriplesRemoved: boolean;
  /** Cascade demote results */
  cascadeResult: { demotedCount: number; demotedIds: string[] };
  /** Error message if failed */
  error?: string;
}

export interface ForgetByIdDeps {
  store: MemoryStore;
  kgStore?: KGStore | null;
  auditLogger?: AuditLogger | null;
  cascadeConfig?: CascadeForgetConfig;
}

// ---------------------------------------------------------------------------
// Core: Forget a single memory
// ---------------------------------------------------------------------------

export async function forgetMemory(
  deps: ForgetByIdDeps,
  request: ForgetRequest,
): Promise<ForgetResult> {
  const { store, kgStore, auditLogger, cascadeConfig } = deps;
  const { memoryId, confirm, reason, scopeFilter } = request;

  // 1. Fetch target
  const entry = await store.get(memoryId, scopeFilter);
  if (!entry) {
    return {
      success: false,
      memoryId,
      kgTriplesRemoved: false,
      cascadeResult: { demotedCount: 0, demotedIds: [] },
      error: `Memory ${memoryId} not found`,
    };
  }

  // 2. Privacy tier check
  const privacyTier = parsePrivacyTier(entry.metadata);
  if (privacyTier === "durable" && !confirm) {
    return {
      success: false,
      memoryId: entry.id,
      kgTriplesRemoved: false,
      cascadeResult: { demotedCount: 0, demotedIds: [] },
      error: `Memory ${entry.id} has privacy tier "durable" — set confirm=true to proceed`,
    };
  }

  // 3. Evidence export (snapshot before deletion)
  const evolution = parseEvolution(entry.metadata, entry.timestamp);
  const evidence: ForgetEvidence = {
    entry: { ...entry },
    privacyTier,
    evolution,
    forgottenAt: new Date().toISOString(),
    reason,
  };

  // 4. KG triple cleanup
  let kgTriplesRemoved = false;
  if (kgStore) {
    try {
      await kgStore.deleteBySource(entry.id);
      kgTriplesRemoved = true;
    } catch {
      // KG cleanup failure should not block forget
    }
  }

  // 5. Cascade demote (related memories get importance reduction)
  let cascadeResult = { demotedCount: 0, demotedIds: [] as string[] };
  try {
    cascadeResult = await cascadeForget(
      store,
      { id: entry.id, vector: entry.vector, scope: entry.scope },
      cascadeConfig ?? DEFAULT_CASCADE_FORGET_CONFIG,
    );
  } catch {
    // Cascade failure should not block primary delete
  }

  // 6. Mark evolution status as "forgotten" before delete (audit breadcrumb)
  try {
    const patchedMetadata = patchEvolution(entry.metadata, {
      status: "archived" as any,
      evolutionNote: `forgotten: ${reason || "user request"}`,
    });
    await store.update(entry.id, { metadata: patchedMetadata }, scopeFilter);
  } catch {
    // Evolution patch failure should not block delete
  }

  // 7. Primary delete
  try {
    await store.delete(entry.id, scopeFilter);
  } catch (err) {
    return {
      success: false,
      memoryId: entry.id,
      evidence,
      kgTriplesRemoved,
      cascadeResult,
      error: `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 8. Audit log
  try {
    auditLogger?.log({
      operation: "forget",
      scope: entry.scope,
      memoryId: entry.id,
      actor: "system",
      details: `tier=${privacyTier} reason=${reason || "none"} cascade=${cascadeResult.demotedCount}`,
    });
    if (cascadeResult.demotedCount > 0) {
      auditLogger?.log({
        operation: "cascade_forget",
        scope: entry.scope,
        memoryId: entry.id,
        actor: "system",
        details: `demoted ${cascadeResult.demotedCount} related memories: ${cascadeResult.demotedIds.map(id => id.slice(0, 8)).join(",")}`,
      });
    }
  } catch {
    // Audit failure should never block operations
  }

  return {
    success: true,
    memoryId: entry.id,
    evidence,
    kgTriplesRemoved,
    cascadeResult,
  };
}

// ---------------------------------------------------------------------------
// Bulk: Forget all memories in a scope
// ---------------------------------------------------------------------------

export interface ForgetByScopeResult {
  forgottenCount: number;
  failedCount: number;
  kgScopeCleared: boolean;
  totalCascadeDemoted: number;
}

export async function forgetByScope(
  deps: ForgetByIdDeps,
  scope: string,
  confirm: boolean,
  reason?: string,
): Promise<ForgetByScopeResult> {
  if (!confirm) {
    return { forgottenCount: 0, failedCount: 0, kgScopeCleared: false, totalCascadeDemoted: 0 };
  }

  const { store, kgStore, auditLogger } = deps;
  let forgottenCount = 0;
  let failedCount = 0;
  let totalCascadeDemoted = 0;

  // Fetch all entries in scope
  const entries = await store.list([scope], undefined, 5000);

  for (const entry of entries) {
    const result = await forgetMemory(deps, {
      memoryId: entry.id,
      confirm: true,
      reason: reason || `scope-level forget: ${scope}`,
      scopeFilter: [scope],
    });

    if (result.success) {
      forgottenCount++;
      totalCascadeDemoted += result.cascadeResult.demotedCount;
    } else {
      failedCount++;
    }
  }

  // Bulk KG scope cleanup
  let kgScopeCleared = false;
  if (kgStore) {
    try {
      await kgStore.deleteByScope(scope);
      kgScopeCleared = true;
    } catch { /* non-blocking */ }
  }

  // Audit the bulk operation
  try {
    auditLogger?.log({
      operation: "forget",
      scope,
      actor: "system",
      details: `scope-forget: ${forgottenCount} deleted, ${failedCount} failed, ${totalCascadeDemoted} cascade-demoted`,
    });
  } catch { /* non-blocking */ }

  return { forgottenCount, failedCount, kgScopeCleared, totalCascadeDemoted };
}
