# Constructive Retrieval + Emotional Valence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add simulation-theory-inspired context reconstruction and emotional valence scoring to RecallNest's retrieval and decay pipelines.

**Architecture:** Two independent features behind feature flags. Emotion valence adds a metadata field + heuristic detector + decay/retrieval scoring stages. Constructive retrieval adds a post-pipeline LLM reconstruction layer with triple-fallback grounding. Both degrade gracefully to current behavior when disabled.

**Tech Stack:** Bun, TypeScript strict, LanceDB, Jina v5 embeddings, OpenAI-compatible LLM API, Zod validation.

**Spec:** `docs/superpowers/specs/2026-04-11-constructive-retrieval-emotion-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/emotion-detector.ts` | **CREATE** | Heuristic + LLM emotion detection |
| `src/context-reconstructor.ts` | **CREATE** | Reconstruction engine + grounding validator |
| `src/memory-schema.ts` | MODIFY | Add EmotionMetadata type |
| `src/decay-engine.ts` | MODIFY | Add emotion-adjusted half-life |
| `src/retriever.ts` | MODIFY | Add emotion scoring stage + reconstruction gate |
| `src/store.ts` | MODIFY | Call emotion detector at store time |
| `src/context-composer.ts` | MODIFY | Call reconstructor in resume flow |
| `src/mcp-server.ts` | MODIFY | Add `reconstruct` param to search_memory |
| `src/llm-client.ts` | MODIFY | Extend smartExtract prompt for emotion |
| `src/__tests__/emotion-detector.test.ts` | **CREATE** | Tests for emotion detection |
| `src/__tests__/emotion-decay.test.ts` | **CREATE** | Tests for emotion-adjusted decay |
| `src/__tests__/emotion-retrieval.test.ts` | **CREATE** | Tests for emotion scoring stage |
| `src/__tests__/context-reconstructor.test.ts` | **CREATE** | Tests for reconstruction + grounding |

---

## Phase 1: Emotional Valence (Tasks 1-6)

### Task 1: EmotionMetadata Type + Feature Flag

**Files:**
- Modify: `src/memory-schema.ts` (add type after line 37)

- [ ] **Step 1: Add EmotionMetadata type to memory-schema.ts**

Open `src/memory-schema.ts`. After the existing type exports (line 37), add:

```typescript
// --- Emotional Valence (Philosophy of Memory: Affective Memory) ---
export interface EmotionMetadata {
  /** Negative (-1) to Positive (+1) */
  valence: number;
  /** Calm (0) to Excited (1) */
  arousal: number;
  /** Human-readable label */
  label?: string;
}

export const EmotionMetadataSchema = z.object({
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(0).max(1),
  label: z.string().max(30).optional(),
});

/** Parse emotion from metadata JSON string, returns null if absent */
export function parseEmotion(metadata: string | undefined): EmotionMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.emotion && typeof parsed.emotion.valence === "number") {
      return EmotionMetadataSchema.parse(parsed.emotion);
    }
  } catch { /* malformed metadata - safe to ignore */ }
  return null;
}

/** Default neutral emotion for memories without emotion data */
export const NEUTRAL_EMOTION: EmotionMetadata = { valence: 0, arousal: 0, label: "neutral" };
```

- [ ] **Step 2: Add feature flag function**

Add to the bottom of `src/memory-schema.ts`, following the pattern in `src/multi-vector.ts:24-26`:

```typescript
export function isEmotionScoringEnabled(): boolean {
  return process.env.RECALLNEST_EMOTION_SCORING === "true";
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd $HOME/Projects/recallnest && bun run build 2>&1 | head -20`
Expected: No errors related to emotion types.

- [ ] **Step 4: Commit**

```bash
cd $HOME/Projects/recallnest
git add src/memory-schema.ts
git commit -m "feat: add EmotionMetadata type and feature flag for emotion scoring"
```

---

### Task 2: Emotion Detector Module

**Files:**
- Create: `src/emotion-detector.ts`
- Create: `src/__tests__/emotion-detector.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/emotion-detector.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { detectEmotion } from "../emotion-detector.js";

describe("emotion-detector: heuristic", () => {
  test("detects strong negative text", () => {
    const result = detectEmotion("This bug is driving me crazy, everything is broken and wrong");
    expect(result.valence).toBeLessThan(-0.3);
    expect(result.label).toBe("negative");
  });

  test("detects strong positive text", () => {
    const result = detectEmotion("Finally solved it! Works perfectly, great progress today");
    expect(result.valence).toBeGreaterThan(0.3);
    expect(result.label).toBe("positive");
  });

  test("detects neutral text", () => {
    const result = detectEmotion("The user prefers dark mode and uses VS Code");
    expect(Math.abs(result.valence)).toBeLessThan(0.3);
    expect(result.label).toBe("neutral");
  });

  test("detects high arousal", () => {
    const result = detectEmotion("URGENT! Critical production issue, fix immediately!");
    expect(result.arousal).toBeGreaterThan(0.3);
  });

  test("detects low arousal for calm text", () => {
    const result = detectEmotion("The default configuration uses port 3000");
    expect(result.arousal).toBeLessThan(0.3);
  });

  test("handles mixed signals with net positive", () => {
    const result = detectEmotion("Had a frustrating bug but finally solved it perfectly");
    expect(result.valence).toBeGreaterThan(0);
  });

  test("handles Chinese text", () => {
    const result = detectEmotion("Too painful, keeps failing");
    expect(result.valence).toBeLessThan(-0.3);
  });

  test("handles empty text gracefully", () => {
    const result = detectEmotion("");
    expect(result.valence).toBe(0);
    expect(result.arousal).toBe(0);
    expect(result.label).toBe("neutral");
  });

  test("clamps valence to [-1, 1]", () => {
    const result = detectEmotion("broken error wrong bug failure hate broken error wrong");
    expect(result.valence).toBeGreaterThanOrEqual(-1);
    expect(result.valence).toBeLessThanOrEqual(1);
  });

  test("clamps arousal to [0, 1]", () => {
    const result = detectEmotion("URGENT! CRITICAL! IMMEDIATELY! ASAP!");
    expect(result.arousal).toBeGreaterThanOrEqual(0);
    expect(result.arousal).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd $HOME/Projects/recallnest && bun test src/__tests__/emotion-detector.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement emotion-detector.ts**

Create `src/emotion-detector.ts`:

```typescript
import type { EmotionMetadata } from "./memory-schema.js";
import { isEmotionScoringEnabled } from "./memory-schema.js";

// --- Signal Dictionaries ---

const NEGATIVE_SIGNALS: string[] = [
  "fail", "failed", "failure", "broken", "bug", "error", "wrong", "crash",
  "frustrat", "hate", "terrible", "awful", "annoying", "pain", "stuck",
  "problem", "issue", "mess", "ugly", "worst",
];

const POSITIVE_SIGNALS: string[] = [
  "solved", "fixed", "works", "perfect", "great", "love", "excellent",
  "success", "breakthrough", "finally", "awesome", "beautiful", "clean",
  "elegant", "smooth", "done", "shipped",
];

const HIGH_AROUSAL_SIGNALS: string[] = [
  "!", "!!", "urgent", "critical", "immediately", "ASAP", "emergency",
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Detect emotional valence and arousal from text using keyword heuristics.
 * Zero LLM cost. Returns neutral emotion for empty text.
 */
export function detectEmotion(text: string): EmotionMetadata {
  if (!text || text.length === 0) {
    return { valence: 0, arousal: 0, label: "neutral" };
  }

  const lower = text.toLowerCase();

  const negCount = NEGATIVE_SIGNALS.filter(s => lower.includes(s.toLowerCase())).length;
  const posCount = POSITIVE_SIGNALS.filter(s => lower.includes(s.toLowerCase())).length;
  const arousalCount = HIGH_AROUSAL_SIGNALS.filter(s => text.includes(s)).length;

  const valence = clamp((posCount - negCount) * 0.25, -1, 1);
  const arousal = clamp(arousalCount * 0.25, 0, 1);
  const label = valence > 0.3 ? "positive" : valence < -0.3 ? "negative" : "neutral";

  return { valence, arousal, label };
}

/**
 * Conditionally detect emotion. Returns null when feature flag is off.
 */
export function detectEmotionIfEnabled(text: string): EmotionMetadata | null {
  if (!isEmotionScoringEnabled()) return null;
  return detectEmotion(text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd $HOME/Projects/recallnest && bun test src/__tests__/emotion-detector.test.ts`
Expected: All 10 tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `cd $HOME/Projects/recallnest && bun test`
Expected: All existing tests pass + 10 new.

- [ ] **Step 6: Commit**

```bash
cd $HOME/Projects/recallnest
git add src/emotion-detector.ts src/__tests__/emotion-detector.test.ts
git commit -m "feat: add heuristic emotion detector"
```

---

### Task 3: Emotion-Adjusted Decay

**Files:**
- Modify: `src/decay-engine.ts` (after line 87)
- Create: `src/__tests__/emotion-decay.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/emotion-decay.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { weibullDecay, adjustHalfLifeForEmotion, computeArousalBoost } from "../decay-engine.js";

describe("emotion-adjusted decay", () => {
  test("returns base half-life when no emotion", () => {
    expect(adjustHalfLifeForEmotion(60, undefined)).toBe(60);
    expect(adjustHalfLifeForEmotion(60, null)).toBe(60);
  });

  test("strong negative emotion extends half-life ~27%", () => {
    const adjusted = adjustHalfLifeForEmotion(60, { valence: -0.9, arousal: 0.5, label: "frustration" });
    expect(adjusted).toBeCloseTo(60 * 1.27, 0);
  });

  test("strong positive emotion extends half-life ~24%", () => {
    const adjusted = adjustHalfLifeForEmotion(60, { valence: 0.8, arousal: 0.3, label: "excitement" });
    expect(adjusted).toBeCloseTo(60 * 1.24, 0);
  });

  test("neutral emotion has negligible effect", () => {
    const adjusted = adjustHalfLifeForEmotion(60, { valence: 0.05, arousal: 0.1, label: "neutral" });
    expect(adjusted).toBeCloseTo(60, 0);
  });

  test("emotional memory decays slower at 30 days", () => {
    const baseHL = 60;
    const emotionalHL = adjustHalfLifeForEmotion(baseHL, { valence: -0.8, arousal: 0.7, label: "frustration" });
    const neutralDecay = weibullDecay(30, baseHL, "working");
    const emotionalDecay = weibullDecay(30, emotionalHL, "working");
    expect(emotionalDecay).toBeGreaterThan(neutralDecay);
  });

  test("arousal boost is 1.0 for zero arousal", () => {
    expect(computeArousalBoost({ valence: 0.5, arousal: 0, label: "positive" })).toBe(1.0);
  });

  test("arousal boost max ~1.1 for high arousal", () => {
    const boost = computeArousalBoost({ valence: 0.5, arousal: 0.9, label: "excitement" });
    expect(boost).toBeCloseTo(1.09, 1);
  });

  test("arousal boost is 1.0 for null emotion", () => {
    expect(computeArousalBoost(undefined)).toBe(1.0);
    expect(computeArousalBoost(null)).toBe(1.0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd $HOME/Projects/recallnest && bun test src/__tests__/emotion-decay.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in decay-engine.ts**

Open `src/decay-engine.ts`. Add import at top:

```typescript
import type { EmotionMetadata } from "./memory-schema.js";
```

After the `weibullDecay` function (after line 87), add:

```typescript
/**
 * Adjust half-life based on emotional intensity.
 * Strong emotion extends half-life by up to 30%.
 */
export function adjustHalfLifeForEmotion(
  baseHalfLife: number,
  emotion: EmotionMetadata | null | undefined,
): number {
  if (!emotion) return baseHalfLife;
  const intensity = Math.abs(emotion.valence);
  return baseHalfLife * (1 + 0.3 * intensity);
}

/**
 * Compute initial strength boost from arousal (flashbulb memory effect).
 * Returns multiplier in [1.0, 1.1].
 */
export function computeArousalBoost(
  emotion: EmotionMetadata | null | undefined,
): number {
  if (!emotion) return 1.0;
  return 1 + 0.1 * emotion.arousal;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd $HOME/Projects/recallnest && bun test src/__tests__/emotion-decay.test.ts`
Expected: All 8 tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `cd $HOME/Projects/recallnest && bun test`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
cd $HOME/Projects/recallnest
git add src/decay-engine.ts src/__tests__/emotion-decay.test.ts
git commit -m "feat: add emotion-adjusted half-life and arousal boost to decay engine"
```

---

### Task 4: Emotion Scoring Stage in Retriever

**Files:**
- Modify: `src/retriever.ts`
- Create: `src/__tests__/emotion-retrieval.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/emotion-retrieval.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { applyEmotionWeight } from "../retriever.js";

describe("applyEmotionWeight", () => {
  const makeResult = (id: string, score: number, emotionJson?: object) => ({
    id,
    text: "test",
    vector: [],
    category: "events" as const,
    scope: "test",
    importance: 0.5,
    timestamp: Date.now(),
    metadata: emotionJson ? JSON.stringify({ emotion: emotionJson }) : "{}",
    score,
    sources: {},
  });

  test("null query emotion returns unchanged", () => {
    const results = [makeResult("a", 0.8, { valence: 0.9, arousal: 0.5 })];
    const output = applyEmotionWeight(results, null);
    expect(output[0].score).toBe(0.8);
  });

  test("low-valence query returns unchanged", () => {
    const queryEmotion = { valence: 0.1, arousal: 0, label: "neutral" };
    const results = [makeResult("a", 0.8, { valence: 0.9, arousal: 0.5 })];
    const output = applyEmotionWeight(results, queryEmotion);
    expect(output[0].score).toBe(0.8);
  });

  test("negative query boosts negative memories", () => {
    const queryEmotion = { valence: -0.8, arousal: 0.5, label: "frustration" };
    const results = [
      makeResult("neg", 0.7, { valence: -0.7, arousal: 0.5 }),
      makeResult("pos", 0.7, { valence: 0.8, arousal: 0.3 }),
    ];
    const output = applyEmotionWeight(results, queryEmotion);
    expect(output.find(r => r.id === "neg")!.score).toBeGreaterThan(
      output.find(r => r.id === "pos")!.score
    );
  });

  test("no emotion data leaves score unchanged", () => {
    const queryEmotion = { valence: -0.8, arousal: 0.5, label: "negative" };
    const results = [makeResult("no-emo", 0.7)];
    const output = applyEmotionWeight(results, queryEmotion);
    expect(output[0].score).toBe(0.7);
  });

  test("max boost is 15%", () => {
    const queryEmotion = { valence: 1.0, arousal: 1.0, label: "positive" };
    const results = [makeResult("a", 1.0, { valence: 1.0, arousal: 1.0 })];
    const output = applyEmotionWeight(results, queryEmotion);
    expect(output[0].score).toBeCloseTo(1.15, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd $HOME/Projects/recallnest && bun test src/__tests__/emotion-retrieval.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add applyEmotionWeight to retriever.ts**

Add imports at top of `src/retriever.ts`:

```typescript
import { parseEmotion, isEmotionScoringEnabled } from "./memory-schema.js";
import type { EmotionMetadata } from "./memory-schema.js";
import { detectEmotion } from "./emotion-detector.js";
```

Add the exported function near other `apply*Weight` functions:

```typescript
/**
 * Emotion scoring stage: boost memories matching query emotional tone.
 * No-op when query is neutral or memory lacks emotion data.
 */
export function applyEmotionWeight(
  results: Array<{ score: number; metadata: string; [k: string]: unknown }>,
  queryEmotion: EmotionMetadata | null,
): typeof results {
  if (!queryEmotion || Math.abs(queryEmotion.valence) < 0.2) {
    return results;
  }
  return results.map(r => {
    const memEmotion = parseEmotion(r.metadata);
    if (!memEmotion) return r;
    const alignment = 1 - Math.abs(queryEmotion.valence - memEmotion.valence) / 2;
    const boost = 1.0 + 0.15 * alignment;
    return { ...r, score: r.score * boost };
  });
}
```

Integrate into `retrieve()` pipeline after importance weight:

```typescript
if (isEmotionScoringEnabled()) {
  const queryEmotion = detectEmotion(context.query);
  scored = applyEmotionWeight(scored, queryEmotion);
}
```

- [ ] **Step 4: Run tests**

Run: `cd $HOME/Projects/recallnest && bun test src/__tests__/emotion-retrieval.test.ts`
Expected: All 5 PASS.

- [ ] **Step 5: Full suite**

Run: `cd $HOME/Projects/recallnest && bun test`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
cd $HOME/Projects/recallnest
git add src/retriever.ts src/__tests__/emotion-retrieval.test.ts
git commit -m "feat: add emotion scoring stage to retrieval pipeline"
```

---

### Task 5: Store Path Integration

**Files:**
- Modify: `src/store.ts` (store method ~line 343, storeBatch ~line 369)

- [ ] **Step 1: Add import**

At top of `src/store.ts`:

```typescript
import { detectEmotionIfEnabled } from "./emotion-detector.js";
```

- [ ] **Step 2: Inject emotion in store() method**

In `store()` (line 343), after metadata is set (line 350), add:

```typescript
const emotionResult = detectEmotionIfEnabled(entry.text);
if (emotionResult) {
  const existingMeta = JSON.parse(fullEntry.metadata || "{}");
  existingMeta.emotion = emotionResult;
  fullEntry.metadata = JSON.stringify(existingMeta);
}
```

- [ ] **Step 3: Inject emotion in storeBatch() method**

In `storeBatch()` (line 369), before the table add call, map entries:

```typescript
const enrichedEntries = fullEntries.map(e => {
  const emotionResult = detectEmotionIfEnabled(e.text);
  if (emotionResult) {
    const meta = JSON.parse(e.metadata || "{}");
    meta.emotion = emotionResult;
    return { ...e, metadata: JSON.stringify(meta) };
  }
  return e;
});
```

Use `enrichedEntries` in the table add.

- [ ] **Step 4: Run full test suite**

Run: `cd $HOME/Projects/recallnest && bun test`
Expected: All pass (emotion is no-op when flag off).

- [ ] **Step 5: Verify with flag ON**

Run: `cd $HOME/Projects/recallnest && RECALLNEST_EMOTION_SCORING=true bun test`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
cd $HOME/Projects/recallnest
git add src/store.ts
git commit -m "feat: inject emotion metadata at store time"
```

---

### Task 6: LLM Emotion Piggyback (Optional)

**Files:**
- Modify: `src/llm-client.ts` (SmartExtraction interface ~line 128, smartExtract ~line 222)

- [ ] **Step 1: Extend SmartExtraction interface**

Add to `SmartExtraction` interface (line 128-138):

```typescript
emotion?: {
  valence: number;
  arousal: number;
  label?: string;
};
```

- [ ] **Step 2: Extend smartExtract system prompt**

Append to the system prompt in smartExtract:

```
Also rate emotional tone:
- emotion.valence: [-1, 1] (negative to positive)
- emotion.arousal: [0, 1] (calm to excited)
- emotion.label: one word (e.g., "frustration", "neutral")
```

- [ ] **Step 3: Parse emotion from response**

In the JSON parsing section of smartExtract, add:

```typescript
if (isEmotionScoringEnabled() && parsed.emotion) {
  result.emotion = {
    valence: Math.max(-1, Math.min(1, parsed.emotion.valence ?? 0)),
    arousal: Math.max(0, Math.min(1, parsed.emotion.arousal ?? 0)),
    label: parsed.emotion.label,
  };
}
```

Add import: `import { isEmotionScoringEnabled } from "./memory-schema.js";`

- [ ] **Step 4: Full test suite**

Run: `cd $HOME/Projects/recallnest && bun test`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
cd $HOME/Projects/recallnest
git add src/llm-client.ts
git commit -m "feat: piggyback emotion detection on LLM smartExtract"
```

---

## Phase 2: Constructive Retrieval (Tasks 7-10)

### Task 7: Context Reconstructor Core

**Files:**
- Create: `src/context-reconstructor.ts`
- Create: `src/__tests__/context-reconstructor.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/context-reconstructor.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import {
  shouldReconstruct,
  extractCitedIds,
  removeSentencesWithId,
  computeCoverage,
} from "../context-reconstructor.js";

describe("reconstruction gate", () => {
  test("false when flag off", () => {
    expect(shouldReconstruct({ flagEnabled: false, callerOptIn: true, resultCount: 5, llmAvailable: true })).toBe(false);
  });
  test("false when no opt-in", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: false, resultCount: 5, llmAvailable: true })).toBe(false);
  });
  test("false when too few results", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: true, resultCount: 2, llmAvailable: true })).toBe(false);
  });
  test("false when LLM down", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: true, resultCount: 5, llmAvailable: false })).toBe(false);
  });
  test("true when all conditions met", () => {
    expect(shouldReconstruct({ flagEnabled: true, callerOptIn: true, resultCount: 5, llmAvailable: true })).toBe(true);
  });
});

describe("extractCitedIds", () => {
  test("extracts [src:ID] references", () => {
    expect(extractCitedIds("A [src:abc]. B [src:def].")).toEqual(["abc", "def"]);
  });
  test("empty for no citations", () => {
    expect(extractCitedIds("No refs.")).toEqual([]);
  });
  test("deduplicates", () => {
    expect(extractCitedIds("A [src:abc]. B [src:abc].")).toEqual(["abc"]);
  });
});

describe("removeSentencesWithId", () => {
  test("removes sentence with invalid ID", () => {
    const text = "Valid [src:real]. Fake [src:bad]. Also valid [src:ok].";
    const result = removeSentencesWithId(text, "bad");
    expect(result).toContain("[src:real]");
    expect(result).toContain("[src:ok]");
    expect(result).not.toContain("[src:bad]");
  });
  test("unchanged if ID not found", () => {
    const text = "All valid [src:a].";
    expect(removeSentencesWithId(text, "nope")).toBe(text);
  });
});

describe("computeCoverage", () => {
  test("high for identical text", () => {
    expect(computeCoverage("user prefers dark mode", ["user prefers dark mode"])).toBeGreaterThan(0.8);
  });
  test("low for unrelated text", () => {
    expect(computeCoverage("quantum physics wave function", ["user prefers dark mode"])).toBeLessThan(0.3);
  });
  test("partial for mixed", () => {
    const cov = computeCoverage("User likes TypeScript. Weather is sunny.", ["User likes TypeScript", "User uses Bun"]);
    expect(cov).toBeGreaterThan(0.3);
    expect(cov).toBeLessThan(0.9);
  });
});
```

- [ ] **Step 2: Run tests to fail**

Run: `cd $HOME/Projects/recallnest && bun test src/__tests__/context-reconstructor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement context-reconstructor.ts**

Create `src/context-reconstructor.ts`:

```typescript
import type { RetrievalResult } from "./retriever.js";
import type { LLMClient } from "./llm-client.js";

// --- Types ---

export interface ReconstructionInput {
  query: string;
  results: RetrievalResult[];
  mode: "resume" | "search";
  maxTokens?: number;
}

export interface ReconstructionOutput {
  reconstructed: string | null;
  sources: string[];
  confidence: number;
  fallbackReason?: string;
  raw: RetrievalResult[];
}

export interface GateConditions {
  flagEnabled: boolean;
  callerOptIn: boolean;
  resultCount: number;
  llmAvailable: boolean;
}

// --- Gate ---

export function shouldReconstruct(c: GateConditions): boolean {
  return c.flagEnabled && c.callerOptIn && c.resultCount >= 3 && c.llmAvailable;
}

// --- Grounding Utilities ---

export function extractCitedIds(text: string): string[] {
  const ids = new Set<string>();
  const regex = /\[src:([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ids.add(match[1]);
  }
  return [...ids];
}

export function removeSentencesWithId(text: string, id: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.filter(s => !s.includes(`[src:${id}]`)).join(" ");
}

/**
 * Word-overlap coverage: fraction of reconstructed sentences grounded in sources.
 * Lightweight heuristic, no embedding calls.
 */
export function computeCoverage(reconstructed: string, sourceTexts: string[]): number {
  const sentences = reconstructed.split(/(?<=[.!?])\s+/).filter(s => s.length > 5);
  if (sentences.length === 0) return 0;

  const sourceWords = new Set<string>();
  for (const src of sourceTexts) {
    for (const w of src.toLowerCase().split(/\s+/)) {
      if (w.length > 2) sourceWords.add(w);
    }
  }

  let covered = 0;
  for (const sent of sentences) {
    const words = sent.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) continue;
    const overlap = words.filter(w => sourceWords.has(w)).length / words.length;
    if (overlap > 0.3) covered++;
  }
  return covered / sentences.length;
}

// --- Prompt ---

function buildPrompt(input: ReconstructionInput): { system: string; user: string } {
  const modeHint = input.mode === "resume"
    ? "Focus on what the user was working on, key decisions, and pending actions."
    : "Focus on the most relevant facts for the query.";

  const system = `You are a memory reconstruction engine. Synthesize a coherent summary from stored memories.

${modeHint}

Rules:
1. Every claim MUST cite [src:MEMORY_ID]
2. Do NOT invent facts not in source memories
3. Contradictions: present both with [conflict]
4. Keep under ${input.maxTokens ?? 500} tokens`;

  const block = input.results.slice(0, 10).map(r =>
    `[ID: ${r.id}] ${r.text} (importance: ${r.importance})`
  ).join("\n\n");

  return { system, user: `Context: ${input.query}\n\nMemories:\n${block}\n\nReconstruct:` };
}

// --- Main Pipeline ---

const TIMEOUT_MS = 3000;
const COVERAGE_FLOOR = 0.6;

export async function reconstruct(
  input: ReconstructionInput,
  llmClient: LLMClient,
): Promise<ReconstructionOutput> {
  const raw = input.results;

  const timeout = new Promise<ReconstructionOutput>(resolve =>
    setTimeout(() => resolve({
      reconstructed: null, sources: [], confidence: 0, fallbackReason: "timeout", raw,
    }), TIMEOUT_MS)
  );

  const work = (async (): Promise<ReconstructionOutput> => {
    const { system, user } = buildPrompt(input);
    const response = await llmClient.generateReconstruction(system, user);

    if (!response) {
      return { reconstructed: null, sources: [], confidence: 0, fallbackReason: "llm_empty", raw };
    }

    let text = response;
    let confidence = 1.0;

    // Layer 1: ID verification
    const validIds = new Set(raw.map(r => r.id));
    for (const id of extractCitedIds(text)) {
      if (!validIds.has(id)) {
        text = removeSentencesWithId(text, id);
        confidence -= 0.2;
      }
    }
    confidence = Math.max(0, confidence);

    // Layer 2: Coverage
    const coverage = computeCoverage(text, raw.map(r => r.text));
    if (coverage < COVERAGE_FLOOR) {
      return { reconstructed: null, sources: [], confidence: 0, fallbackReason: "low_grounding", raw };
    }

    const validSources = extractCitedIds(text).filter(id => validIds.has(id));
    return {
      reconstructed: text,
      sources: validSources,
      confidence: Math.min(confidence, coverage),
      raw,
    };
  })();

  return Promise.race([work, timeout]);
}
```

- [ ] **Step 4: Run tests**

Run: `cd $HOME/Projects/recallnest && bun test src/__tests__/context-reconstructor.test.ts`
Expected: All 12 PASS.

- [ ] **Step 5: Full suite**

Run: `cd $HOME/Projects/recallnest && bun test`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
cd $HOME/Projects/recallnest
git add src/context-reconstructor.ts src/__tests__/context-reconstructor.test.ts
git commit -m "feat: context reconstructor with grounding validator and triple fallback"
```

---

### Task 8: LLM Client Extension

**Files:**
- Modify: `src/llm-client.ts` (add public methods)

- [ ] **Step 1: Add generateReconstruction method**

In `src/llm-client.ts`, after the existing public methods, add:

```typescript
/** Public wrapper for reconstruction pipeline */
async generateReconstruction(system: string, user: string): Promise<string | null> {
  return this.chat(system, user);
}

/** Check if LLM circuit breaker allows requests */
isAvailable(): boolean {
  return !this.circuitBreaker.isOpen();
}
```

- [ ] **Step 2: Full test suite**

Run: `cd $HOME/Projects/recallnest && bun test`
Expected: All pass.

- [ ] **Step 3: Commit**

```bash
cd $HOME/Projects/recallnest
git add src/llm-client.ts
git commit -m "feat: add generateReconstruction and isAvailable to LLMClient"
```

---

### Task 9: Retriever + Composer + MCP Integration

**Files:**
- Modify: `src/retriever.ts` (RetrievalContext + output, ~line 136-155, ~line 670)
- Modify: `src/context-composer.ts` (resume flow, ~line 445)
- Modify: `src/mcp-server.ts` (search_memory schema, ~line 889)

- [ ] **Step 1: Extend RetrievalContext in retriever.ts**

Add to `RetrievalContext` interface (line 136-155):

```typescript
/** Request constructive retrieval reconstruction */
reconstruct?: boolean;
```

- [ ] **Step 2: Add reconstruction gate to retrieve() output**

At end of `retrieve()` (around line 670), before final return, add:

```typescript
import { shouldReconstruct, reconstruct as runReconstruction, type ReconstructionOutput } from "./context-reconstructor.js";

// In retrieve(), before return:
const constructiveFlag = process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL === "true";
if (shouldReconstruct({
  flagEnabled: constructiveFlag,
  callerOptIn: context.reconstruct === true,
  resultCount: finalResults.length,
  llmAvailable: this.llmClient?.isAvailable() ?? false,
})) {
  try {
    const reconstruction = await runReconstruction(
      { query: context.query, results: finalResults, mode: "search" },
      this.llmClient!,
    );
    // Attach to first result's metadata as side-channel
    // (preserves return type compatibility)
    if (finalResults.length > 0) {
      const meta = JSON.parse(finalResults[0].metadata || "{}");
      meta._reconstruction = {
        text: reconstruction.reconstructed,
        sources: reconstruction.sources,
        confidence: reconstruction.confidence,
        fallbackReason: reconstruction.fallbackReason,
      };
      finalResults[0] = { ...finalResults[0], metadata: JSON.stringify(meta) };
    }
  } catch {
    // Silent degradation
  }
}
```

- [ ] **Step 3: Add reconstruct param to search_memory in mcp-server.ts**

In `src/mcp-server.ts`, find search_memory input schema (line 889-906). Add:

```typescript
reconstruct: z.boolean().default(false).describe(
  "Return LLM-synthesized reconstruction alongside raw results. Requires RECALLNEST_CONSTRUCTIVE_RETRIEVAL=true."
),
```

Pass it through in the handler:

```typescript
reconstruct: input.reconstruct,
```

In the response formatting, check for reconstruction data:

```typescript
// After building the results sections
const firstMeta = results[0] ? JSON.parse(results[0].metadata || "{}") : {};
if (firstMeta._reconstruction?.text) {
  const r = firstMeta._reconstruction;
  sections.unshift(
    `## Reconstructed Context (confidence: ${r.confidence.toFixed(2)})\n${r.text}\n\nSources: ${r.sources.join(", ")}`
  );
}
```

- [ ] **Step 4: Integrate into context-composer.ts**

In `src/context-composer.ts`, in `composeResumeContext` (around line 445), add:

```typescript
import { shouldReconstruct, reconstruct as runReconstruction } from "./context-reconstructor.js";

// After stable + patterns + cases assembly:
const constructiveFlag = process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL === "true";
if (constructiveFlag && deps.llmClient?.isAvailable?.()) {
  const allResults = [...(stableResults || []), ...(patternResults || []), ...(caseResults || [])];
  if (allResults.length >= 3) {
    try {
      const taskQuery = latestCheckpoint?.summary ?? "general context";
      const recon = await runReconstruction(
        { query: taskQuery, results: allResults, mode: "resume", maxTokens: 600 },
        deps.llmClient,
      );
      if (recon.reconstructed) {
        response.reconstructedContext = recon.reconstructed;
        response.reconstructionConfidence = recon.confidence;
      }
    } catch { /* silent fallback */ }
  }
}
```

Add `reconstructedContext?: string` and `reconstructionConfidence?: number` to the response schema.

- [ ] **Step 5: Full test suite**

Run: `cd $HOME/Projects/recallnest && bun test`
Expected: All pass (feature flag off = no-op).

- [ ] **Step 6: Commit**

```bash
cd $HOME/Projects/recallnest
git add src/retriever.ts src/mcp-server.ts src/context-composer.ts
git commit -m "feat: integrate constructive retrieval into search_memory and resume_context"
```

---

### Task 10: Integration Tests + Docs + Ship

**Files:**
- Create: `src/__tests__/feature-flags-integration.test.ts`
- Modify: `CLAUDE.md` (feature flags section)

- [ ] **Step 1: Write integration tests**

Create `src/__tests__/feature-flags-integration.test.ts`:

```typescript
import { describe, test, expect, afterAll } from "bun:test";

describe("feature flag isolation", () => {
  const saved = {
    emo: process.env.RECALLNEST_EMOTION_SCORING,
    con: process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL,
  };

  afterAll(() => {
    if (saved.emo !== undefined) process.env.RECALLNEST_EMOTION_SCORING = saved.emo;
    else delete process.env.RECALLNEST_EMOTION_SCORING;
    if (saved.con !== undefined) process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL = saved.con;
    else delete process.env.RECALLNEST_CONSTRUCTIVE_RETRIEVAL;
  });

  test("emotion off -> detectEmotionIfEnabled returns null", () => {
    delete process.env.RECALLNEST_EMOTION_SCORING;
    const { detectEmotionIfEnabled } = require("../emotion-detector.js");
    expect(detectEmotionIfEnabled("terrible bug")).toBeNull();
  });

  test("constructive off -> shouldReconstruct false", () => {
    const { shouldReconstruct } = require("../context-reconstructor.js");
    expect(shouldReconstruct({
      flagEnabled: false, callerOptIn: true, resultCount: 10, llmAvailable: true,
    })).toBe(false);
  });
});

describe("emotion + decay end-to-end", () => {
  test("emotional memory retains more score at 30 days", () => {
    const { adjustHalfLifeForEmotion } = require("../decay-engine.js");
    const { weibullDecay } = require("../decay-engine.js");

    const baseHL = 60;
    const emoHL = adjustHalfLifeForEmotion(baseHL, { valence: -0.8, arousal: 0.7, label: "frustration" });
    expect(weibullDecay(30, emoHL, "working")).toBeGreaterThan(weibullDecay(30, baseHL, "working"));
  });
});

describe("grounding end-to-end", () => {
  test("removes phantom citations and lowers confidence", () => {
    const { extractCitedIds, removeSentencesWithId } = require("../context-reconstructor.js");

    const text = "Valid [src:r1]. Fake [src:phantom]. Also valid [src:r2].";
    const validIds = new Set(["r1", "r2"]);
    let result = text;
    let confidence = 1.0;

    for (const id of extractCitedIds(result)) {
      if (!validIds.has(id)) {
        result = removeSentencesWithId(result, id);
        confidence -= 0.2;
      }
    }

    expect(result).not.toContain("phantom");
    expect(confidence).toBe(0.8);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `cd $HOME/Projects/recallnest && bun test src/__tests__/feature-flags-integration.test.ts`
Expected: All PASS.

- [ ] **Step 3: Full suite flags OFF**

Run: `cd $HOME/Projects/recallnest && bun test`
Expected: ALL pass.

- [ ] **Step 4: Full suite flags ON**

Run: `cd $HOME/Projects/recallnest && RECALLNEST_EMOTION_SCORING=true RECALLNEST_CONSTRUCTIVE_RETRIEVAL=true bun test`
Expected: All pass.

- [ ] **Step 5: Update CLAUDE.md feature flags**

Add to section 5 in `CLAUDE.md`:

```markdown
- `RECALLNEST_EMOTION_SCORING=true` — Emotion detection + adjusted decay + retrieval scoring
- `RECALLNEST_CONSTRUCTIVE_RETRIEVAL=true` — LLM context reconstruction with grounding (resume default, search opt-in)
```

- [ ] **Step 6: Commit + push**

```bash
cd $HOME/Projects/recallnest
git add src/__tests__/feature-flags-integration.test.ts CLAUDE.md
git commit -m "feat: integration tests and feature flag documentation for v1.5"
git push
```

---

## Task Summary

| # | Phase | Component | Risk | Est. LOC |
|---|-------|-----------|------|----------|
| 1 | Emotion | Types + flag | None | ~40 |
| 2 | Emotion | Heuristic detector | None | ~70+80 |
| 3 | Emotion | Decay adjustment | Low | ~25+50 |
| 4 | Emotion | Retrieval scoring | Low | ~25+50 |
| 5 | Emotion | Store integration | Low | ~15 |
| 6 | Emotion | LLM piggyback | Low | ~20 |
| 7 | Constructive | Reconstructor core | Medium | ~180+80 |
| 8 | Constructive | LLM client extension | Low | ~15 |
| 9 | Constructive | Pipeline integration | Medium | ~60 |
| 10 | Both | Integration tests + docs | None | ~80 |
| | | **Total** | | **~790** |
