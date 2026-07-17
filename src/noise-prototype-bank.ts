/**
 * NoisePrototypeBank — shadow experiment (mlp #907/#914 borrow, cut down per
 * Codex review 2026-07-17).
 *
 * Hypothesis under test: can embedding similarity catch noise *variants* that
 * the regex noise-filter misses? This bank NEVER rejects anything. It only:
 *
 *   - learns: when admission rejects with reason "noise_detected" (and only
 *     that reason — "importance_too_low" is a heuristic self-judgment, not a
 *     noise label, and learning from it would snowball one misjudgment into a
 *     whole semantic neighborhood), the text becomes a *pending candidate*;
 *     after MIN_SEEN independent rejections it is embedded and stored as a
 *     prototype (cap 32, TTL 90d).
 *   - matches: for texts admission ACCEPTED, the write-path embedding that was
 *     computed anyway is compared against prototypes; a cosine hit ≥0.93 emits
 *     a "suggest_reject" shadow-log line. No extra embedding on this side.
 *
 * Exit condition (per review): after real samples accumulate, offline-evaluate
 * incremental precision/recall from the shadow log; no measurable lift → shut
 * the experiment down (RECALLNEST_NOISE_PROTOTYPE=off) and delete the bank.
 *
 * Permanent protections: content carrying explicit memory verbs, corrections,
 * decisions, identity, or preference cues is never learned from and never
 * flagged, regardless of similarity.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./env-config.js";

export type NoisePrototypeMode = "shadow" | "off";

/**
 * RECALLNEST_NOISE_PROTOTYPE: unset/invalid → "shadow" (log-only), "off"
 * disables. Under NODE_ENV=test an unset flag resolves to "off" so the
 * hundreds of persistMemory tests don't seed the developer's real bank with
 * mock vectors — tests opting in set the env or inject an instance.
 */
export function resolveNoisePrototypeMode(env: NodeJS.ProcessEnv = process.env): NoisePrototypeMode {
  const raw = (env.RECALLNEST_NOISE_PROTOTYPE || "").trim().toLowerCase();
  if (raw === "off") return "off";
  if (raw === "shadow") return "shadow";
  return env.NODE_ENV === "test" ? "off" : "shadow";
}

export interface NoisePrototype {
  id: string;
  textHash: string;
  /** First 60 chars, kept for human evaluation of the experiment. */
  textPreview: string;
  vector: number[];
  norm: number;
  sourceReason: "noise_detected";
  /** Independent rejections observed before this became a prototype. */
  seenCount: number;
  /** Shadow suggest_reject hits attributed to this prototype. */
  hitCount: number;
  learnedAt: string;
  lastHitAt?: string;
}

interface PendingCandidate {
  count: number;
  firstSeenAt: string;
  preview: string;
}

interface BankFile {
  version: 1;
  prototypes: NoisePrototype[];
  pending: Record<string, PendingCandidate>;
}

export interface NoisePrototypeBankConfig {
  /** Cosine similarity threshold for a shadow hit (Codex: start 0.92–0.95, not mlp's 0.82). */
  threshold: number;
  /** Hard cap on learned prototypes. */
  maxPrototypes: number;
  /** Independent rejections required before a candidate is embedded. */
  minSeenCount: number;
  /** Prototype expiry in days. */
  ttlDays: number;
  /** Pending-candidate expiry in days. */
  pendingTtlDays: number;
  /** Bank persistence path. */
  filePath: string;
  /** Shadow log path (JSONL). */
  shadowLogPath: string;
}

const DEFAULTS: Omit<NoisePrototypeBankConfig, "filePath" | "shadowLogPath"> = {
  threshold: 0.93,
  maxPrototypes: 32,
  minSeenCount: 2,
  ttlDays: 90,
  pendingTtlDays: 7,
};

export type NoisePrototypeEvent =
  | "learned"
  | "candidate_seen"
  | "suggest_reject"
  | "skipped_protected"
  | "skipped_full"
  | "skipped_duplicate"
  | "no_match";

// --- permanent protection rules ---

const PROTECTED_CUES_ZH = [
  "记住",
  "记一下",
  "记下来",
  "别忘了",
  "帮我记",
  "存一下",
  "我决定",
  "定了",
  "拍板",
  "纠正",
  "不对",
  "错了",
  "我是",
  "我叫",
  "我的名字",
  "我喜欢",
  "我不喜欢",
  "我偏好",
  "偏好",
  "我的生日",
  "我的电话",
  "我的地址",
];

const PROTECTED_CUES_EN = [
  /(?<![\w-])remember this(?![\w-])/,
  /(?<![\w-])note this(?![\w-])/,
  /(?<![\w-])my name(?![\w-])/,
  /(?<![\w-])i am(?![\w-])/,
  /(?<![\w-])i'm(?![\w-])/,
  /(?<![\w-])i prefer(?![\w-])/,
  /(?<![\w-])my preferences?(?![\w-])/,
  /(?<![\w-])i decided(?![\w-])/,
  /(?<![\w-])correction(?![\w-])/,
];

/** Identity/preference/decision/correction content is permanently protected. */
export function isProtectedContent(text: string): boolean {
  for (const cue of PROTECTED_CUES_ZH) {
    if (text.includes(cue)) return true;
  }
  const lower = text.toLowerCase();
  for (const cue of PROTECTED_CUES_EN) {
    if (cue.test(lower)) return true;
  }
  return false;
}

function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s。，,.!！?？~〜…、;；:：'"'"()（）\-_]/gu, "")
    .trim();
}

function hashText(text: string): string {
  return createHash("sha256").update(normalizeForHash(text)).digest("hex").slice(0, 16);
}

function l2norm(vector: number[]): number {
  let sum = 0;
  for (const v of vector) sum += v * v;
  return Math.sqrt(sum);
}

function cosine(a: number[], normA: number, b: number[], normB: number): number {
  if (normA === 0 || normB === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot / (normA * normB);
}

export interface ShadowMatch {
  matched: boolean;
  prototypeId?: string;
  similarity?: number;
  protected?: boolean;
}

export class NoisePrototypeBank {
  private readonly config: NoisePrototypeBankConfig;
  private state: BankFile | null = null;

  constructor(config: Partial<NoisePrototypeBankConfig> & Pick<NoisePrototypeBankConfig, "filePath" | "shadowLogPath">) {
    this.config = { ...DEFAULTS, ...config };
  }

  /**
   * Learning side. Call when admission rejected with reason "noise_detected".
   * Embeds at most once per unique normalized text, and only after the
   * candidate has been independently rejected minSeenCount times.
   * Best-effort: any failure is swallowed — the experiment must never break
   * the write path it observes.
   */
  async learnFromRejection(
    text: string,
    embedPassage: (text: string) => Promise<number[]>,
  ): Promise<NoisePrototypeEvent> {
    try {
      if (isProtectedContent(text)) {
        this.logShadow({ event: "skipped_protected", side: "learn", msgLen: text.length });
        return "skipped_protected";
      }
      const state = this.load();
      const hash = hashText(text);
      if (state.prototypes.some((p) => p.textHash === hash)) {
        return "skipped_duplicate";
      }
      const pending = state.pending[hash] ?? {
        count: 0,
        firstSeenAt: new Date().toISOString(),
        preview: text.slice(0, 60),
      };
      pending.count += 1;
      state.pending[hash] = pending;

      if (pending.count < this.config.minSeenCount) {
        this.save();
        this.logShadow({ event: "candidate_seen", side: "learn", msgLen: text.length, seenCount: pending.count });
        return "candidate_seen";
      }
      if (state.prototypes.length >= this.config.maxPrototypes) {
        this.save();
        this.logShadow({ event: "skipped_full", side: "learn", msgLen: text.length });
        return "skipped_full";
      }

      const vector = await embedPassage(text);
      const prototype: NoisePrototype = {
        id: `proto-${hash.slice(0, 8)}`,
        textHash: hash,
        textPreview: pending.preview,
        vector,
        norm: l2norm(vector),
        sourceReason: "noise_detected",
        seenCount: pending.count,
        hitCount: 0,
        learnedAt: new Date().toISOString(),
      };
      state.prototypes.push(prototype);
      delete state.pending[hash];
      this.save();
      this.logShadow({ event: "learned", side: "learn", msgLen: text.length, prototypeId: prototype.id, seenCount: prototype.seenCount });
      return "learned";
    } catch {
      return "no_match";
    }
  }

  /**
   * Matching side. Call with the write-path embedding that was computed
   * anyway for an ACCEPTED text — this side never spends an extra embedding.
   * Only ever logs; the caller must not reject based on the result while the
   * experiment is in shadow.
   */
  matchShadow(text: string, vector: number[], memoryId?: string): ShadowMatch {
    try {
      const state = this.load();
      if (state.prototypes.length === 0) return { matched: false };
      if (isProtectedContent(text)) {
        return { matched: false, protected: true };
      }
      const norm = l2norm(vector);
      let best: { prototype: NoisePrototype; similarity: number } | undefined;
      for (const prototype of state.prototypes) {
        const similarity = cosine(vector, norm, prototype.vector, prototype.norm);
        if (!best || similarity > best.similarity) best = { prototype, similarity };
      }
      if (!best || best.similarity < this.config.threshold) {
        return { matched: false };
      }
      best.prototype.hitCount += 1;
      best.prototype.lastHitAt = new Date().toISOString();
      this.save();
      this.logShadow({
        event: "suggest_reject",
        side: "match",
        msgLen: text.length,
        prototypeId: best.prototype.id,
        similarity: Number(best.similarity.toFixed(4)),
        memoryId,
      });
      return { matched: true, prototypeId: best.prototype.id, similarity: best.similarity };
    } catch {
      return { matched: false };
    }
  }

  /** Correction API — single-prototype removal (a false positive must be surgically removable). */
  removePrototype(id: string): boolean {
    const state = this.load();
    const before = state.prototypes.length;
    state.prototypes = state.prototypes.filter((p) => p.id !== id);
    const removed = state.prototypes.length < before;
    if (removed) this.save();
    return removed;
  }

  /** Correction API — full reset. */
  clear(): void {
    this.state = { version: 1, prototypes: [], pending: {} };
    this.save();
  }

  list(): NoisePrototype[] {
    return [...this.load().prototypes];
  }

  pendingCount(): number {
    return Object.keys(this.load().pending).length;
  }

  // --- persistence ---

  private load(): BankFile {
    if (this.state) return this.state;
    let parsed: BankFile | null = null;
    try {
      if (existsSync(this.config.filePath)) {
        parsed = JSON.parse(readFileSync(this.config.filePath, "utf8")) as BankFile;
      }
    } catch {
      parsed = null;
    }
    const state: BankFile = parsed && parsed.version === 1
      ? parsed
      : { version: 1, prototypes: [], pending: {} };

    // TTL sweep on load.
    const now = Date.now();
    const protoCutoff = now - this.config.ttlDays * 86_400_000;
    state.prototypes = state.prototypes.filter((p) => Date.parse(p.learnedAt) >= protoCutoff);
    for (const [hash, candidate] of Object.entries(state.pending)) {
      if (Date.parse(candidate.firstSeenAt) < now - this.config.pendingTtlDays * 86_400_000) {
        delete state.pending[hash];
      }
    }
    this.state = state;
    return state;
  }

  private save(): void {
    try {
      const dir = dirname(this.config.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.config.filePath, JSON.stringify(this.load(), null, 2), "utf8");
    } catch {
      // Persistence is best-effort; in-memory state still serves this process.
    }
  }

  private logShadow(entry: Record<string, unknown>): void {
    try {
      const dir = dirname(this.config.shadowLogPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(
        this.config.shadowLogPath,
        `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
        "utf8",
      );
    } catch {
      // Shadow logging is best-effort by design.
    }
  }
}

// --- shared instance (env-governed, injectable via PersistMemoryDeps) ---

export const NOISE_PROTOTYPE_BANK_FILE = "noise-prototype-bank.json";
export const NOISE_PROTOTYPE_SHADOW_FILE = "noise-prototype-shadow.jsonl";

let sharedBank: NoisePrototypeBank | null | undefined;

/**
 * Resolve the process-wide bank: explicit deps win (null disables, instance
 * overrides); otherwise lazily construct from env (shadow default, off → null).
 */
export function resolveNoisePrototypeBank(
  explicit: NoisePrototypeBank | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NoisePrototypeBank | null {
  if (explicit !== undefined) return explicit;
  if (sharedBank === undefined) {
    sharedBank = resolveNoisePrototypeMode(env) === "off"
      ? null
      : new NoisePrototypeBank({
          filePath: join(dataDir(), NOISE_PROTOTYPE_BANK_FILE),
          shadowLogPath: join(dataDir(), NOISE_PROTOTYPE_SHADOW_FILE),
        });
  }
  return sharedBank;
}

/** Test hook: drop the memoized shared bank so env changes take effect. */
export function resetSharedNoisePrototypeBank(): void {
  sharedBank = undefined;
}
