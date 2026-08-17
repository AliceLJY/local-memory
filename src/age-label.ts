/**
 * Relative age labels for rendered output.
 *
 * Why: a model asked to do date arithmetic on `2026-08-03` will sometimes get it
 * wrong, and "how long ago" is exactly what decides whether a memory is still
 * worth raising. So every rendered date carries a whole-day age next to it and
 * nobody downstream has to subtract. (Borrowed from HKUDS/DeepTutor
 * `memory/recall.py` — "days_ago rather than an ISO timestamp", 2026-08-17.)
 *
 * A future stamp (clock skew on an imported record) reads as today, not as a
 * negative age. Unusable stamps render as "-" instead of a fabricated number.
 */

const DAY_MS = 86_400_000;

export const AGE_UNKNOWN = "-";

export function formatAgeLabel(timestampMs: number | null | undefined, now: number = Date.now()): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return AGE_UNKNOWN;
  const days = Math.floor((now - timestampMs) / DAY_MS);
  return `${Math.max(0, days)}d`;
}

export function formatIsoAgeLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return AGE_UNKNOWN;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return AGE_UNKNOWN;
  return formatAgeLabel(parsed, now);
}
