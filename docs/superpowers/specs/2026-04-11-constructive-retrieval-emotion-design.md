# Constructive Retrieval + Emotional Valence — Design Spec

> Date: 2026-04-11
> Status: Approved
> Scope: RecallNest v1.5 upgrade
> Philosophy basis: Simulation Theory (Michaelian) + Affective Memory (cognitive science)
> Risk strategy: Triple fallback — every new path degrades gracefully to current behavior

---

## 1. Problem Statement

RecallNest's retrieval pipeline (21 stages) returns **raw stored text**. This is a "causal theory" model — faithfully reproducing what was stored. But human memory doesn't work this way: we reconstruct memories in context, adapting them to our current needs.

Additionally, the decay engine lacks an emotional dimension. Cognitive science shows emotionally charged memories decay slower and are retrieved preferentially in matching emotional contexts. RecallNest currently treats all memories as emotionally neutral.

## 2. Goals

1. **Constructive Retrieval**: When context benefits from it, synthesize a coherent narrative from top-N retrieved memories, adapted to the current query context
2. **Emotional Valence**: Tag memories with emotional metadata at storage time, use it to modulate decay rates and retrieval scoring
3. **Zero regression**: All new behavior behind feature flags, all paths fallback to current behavior

## 3. Non-Goals

- Replacing the existing retrieval pipeline (it stays as-is)
- Complex emotion models (no 6-axis emotion wheels; just valence + arousal)
- Multi-agent shared memory (future phase)
- Autobiographical narrative architecture (future phase)

---

## 4. Constructive Retrieval

### 4.1 Architecture

New component: `context-reconstructor.ts` (~200-300 LOC)

Position in pipeline:
```
Existing 21-stage pipeline → top-N RetrievalResult[]
                                    ↓
                         Reconstruction Gate
                          (should reconstruct?)
                                    ↓ yes          ↓ no
                         Context Reconstructor    Return raw
                                    ↓
                         Grounding Validator
                                    ↓
                         Return { reconstructed, sources, confidence, raw }
```

### 4.2 Reconstruction Gate

Conditions for reconstruction (ALL must be true):
- Feature flag `RECALLNEST_CONSTRUCTIVE_RETRIEVAL=true`
- Caller opt-in: `reconstruct: true` in retrieval context
- Retrieved results count ≥ 3 (too few = not enough material)
- LLM client available and responding

If any condition fails → return raw results immediately. No error, no log noise.

### 4.3 Context Reconstructor

**Input:**
```ts
interface ReconstructionInput {
  query: string;              // current user query / resume context
  results: RetrievalResult[]; // top-N from pipeline (max 10)
  mode: "resume" | "search";  // affects prompt style
  maxTokens?: number;         // output budget (default 500)
}
```

**LLM Prompt Strategy:**
```
System: You are a memory reconstruction engine. Given a set of stored memories
and a current context, synthesize a coherent, contextually relevant summary.

Rules:
1. Every factual claim MUST cite its source as [src:MEMORY_ID]
2. Do NOT invent facts not present in any source memory
3. If memories contradict each other, present both views with [conflict] tag
4. Prioritize information most relevant to the current query context
5. Keep output concise — this is context, not an essay

Current context: {query}

Source memories:
{for each result: [ID: {id}] {text} (importance: {importance}, stored: {date})}

Synthesize a contextually relevant reconstruction:
```

**Output:**
```ts
interface ReconstructionOutput {
  reconstructed: string;        // synthesized text with [src:ID] citations
  sources: string[];            // list of cited memory IDs
  confidence: number;           // [0, 1] grounding confidence
  fallbackReason?: string;      // if degraded, why
  raw: RetrievalResult[];       // always included
}
```

### 4.4 Grounding Validator

Three-layer validation, executed sequentially:

**Layer 1: ID Verification**
```ts
for (const citedId of extractCitedIds(reconstructed)) {
  if (!topNResults.some(r => r.id === citedId)) {
    reconstructed = removeSentencesWithId(reconstructed, citedId);
    confidence -= 0.2;
  }
}
```
- Extract all `[src:MEMORY_ID]` references from LLM output
- Verify each ID exists in the top-N result set
- Remove sentences citing non-existent IDs (hallucination)
- Penalize confidence per phantom citation

**Layer 2: Coverage Check**
```ts
const coverage = computeSemanticOverlap(reconstructed, topNResults);
if (coverage < 0.6) {
  return { reconstructed: null, fallbackReason: "low_grounding", raw };
}
```
- Compute semantic overlap between reconstructed text and source memories
- Method: chunk reconstructed text into sentences, embed each, find max cosine similarity to any source memory
- Coverage = percentage of sentences with similarity > 0.7
- Below 60% → full degradation to raw results

**Layer 3: Timeout Guard**
```ts
const result = await Promise.race([
  reconstruct(input),
  timeout(3000).then(() => ({ fallbackReason: "timeout" }))
]);
```
- 3-second hard timeout on entire reconstruction pipeline
- Timeout → return raw results

### 4.5 Integration Points

**resume_context (context-composer.ts):**
- After assembling stable context + patterns + cases
- Call reconstructor with mode="resume", query=task description from checkpoint
- If reconstruction succeeds, use it as the primary context narrative
- Always keep raw results in response for transparency
- Default: reconstruction ON when feature flag is ON

**search_memory (mcp-server.ts):**
- New optional parameter: `reconstruct?: boolean` (default false)
- When true, pass through to retriever with reconstruct flag
- Return both reconstructed and raw in tool response

**brief_memory, memory_lint, list_pins, etc.:**
- Never reconstruct. These tools need raw data.

### 4.6 Observability

- Trace stage: `reconstruction` added to TraceCollector
- Logged fields: `{ attempted: boolean, succeeded: boolean, confidence: number, fallbackReason?: string, latencyMs: number, sourceCount: number }`
- No memory content logged (privacy)

---

## 5. Emotional Valence

### 5.1 Schema Extension

Add optional `emotion` field to memory metadata:

```ts
interface EmotionMetadata {
  valence: number;    // [-1, 1]  negative ← → positive
  arousal: number;    // [0, 1]   calm ← → excited
  label?: string;     // human-readable: "frustration" | "excitement" | "neutral" | etc.
}
```

Stored in `metadata` JSON string (no schema migration needed):
```json
{
  "tier": "working",
  "emotion": { "valence": -0.7, "arousal": 0.8, "label": "frustration" }
}
```

### 5.2 Detection at Store Time

**Two-tier detection (store.ts / noise-filter.ts):**

**Tier 1: Heuristic (zero LLM cost, always runs)**
```ts
const NEGATIVE_SIGNALS = ["失败", "痛苦", "困扰", "bug", "broken", "frustrat", "hate", "wrong", "error"];
const POSITIVE_SIGNALS = ["突破", "搞定", "成功", "solved", "great", "love", "perfect", "works"];
const HIGH_AROUSAL = ["!", "紧急", "urgent", "critical", "immediately", "ASAP"];

function heuristicEmotion(text: string): EmotionMetadata {
  const negCount = NEGATIVE_SIGNALS.filter(s => text.toLowerCase().includes(s)).length;
  const posCount = POSITIVE_SIGNALS.filter(s => text.toLowerCase().includes(s)).length;
  const arousalCount = HIGH_AROUSAL.filter(s => text.includes(s)).length;
  
  const valence = clamp((posCount - negCount) * 0.3, -1, 1);
  const arousal = clamp(arousalCount * 0.3, 0, 1);
  const label = valence > 0.3 ? "positive" : valence < -0.3 ? "negative" : "neutral";
  
  return { valence, arousal, label };
}
```

**Tier 2: LLM (optional, piggybacked on importance evaluation)**
- When LLM is called to evaluate importance (existing flow), add to prompt:
  ```
  Also rate the emotional tone:
  - valence: [-1, 1] (negative to positive)
  - arousal: [0, 1] (calm to excited)
  - label: one word (e.g., "frustration", "excitement", "neutral")
  ```
- Merged into existing LLM call → zero additional API cost
- LLM result overrides heuristic result when available

**Backward compatibility:** Existing memories without emotion field → treated as `{ valence: 0, arousal: 0, label: "neutral" }` everywhere.

### 5.3 Decay Integration (decay-engine.ts)

**Modified half-life calculation:**
```ts
function adjustedHalfLife(baseHalfLife: number, emotion?: EmotionMetadata): number {
  if (!emotion) return baseHalfLife;
  const emotionalIntensity = Math.abs(emotion.valence);
  // Emotional memories last up to 30% longer
  const boost = 1 + 0.3 * emotionalIntensity;
  return baseHalfLife * boost;
}
```

- Strong negative memory (valence = -0.9): half-life × 1.27
- Strong positive memory (valence = 0.8): half-life × 1.24
- Neutral memory (valence = 0.1): half-life × 1.03 (negligible)
- No emotion field: no change

**Arousal modulation (secondary):**
```ts
// High arousal slightly accelerates initial strength but doesn't change half-life
// This models the "flashbulb memory" effect — vivid but not necessarily longer-lasting
const initialBoost = 1 + 0.1 * (emotion?.arousal ?? 0);
```

### 5.4 Retrieval Integration (retriever.ts)

**New scoring stage: `applyEmotionWeight` (after `applyImportanceWeight`)**

```ts
function applyEmotionWeight(
  results: ScoredResult[],
  queryEmotion: EmotionMetadata | null
): ScoredResult[] {
  if (!queryEmotion || Math.abs(queryEmotion.valence) < 0.2) {
    return results; // neutral query → no-op
  }
  
  return results.map(r => {
    const memEmotion = parseEmotion(r.metadata);
    if (!memEmotion) return r; // no emotion data → unchanged
    
    // Emotional alignment boost: same-valence memories score higher
    const alignment = 1 - Math.abs(queryEmotion.valence - memEmotion.valence) / 2;
    const boost = 1.0 + 0.15 * alignment;
    
    return { ...r, score: r.score * boost };
  });
}
```

- Query has emotional tone + memory has matching emotion → up to 15% score boost
- Query is neutral → stage is no-op (zero overhead)
- Memory has no emotion data → unchanged

**Query emotion detection:**
- Reuse heuristic detector on query text
- Lightweight, no LLM needed at query time

### 5.5 Feature Flag

`RECALLNEST_EMOTION_SCORING=true` — controls:
- Emotion detection at store time
- Emotion-adjusted decay calculation
- Emotion scoring stage in retriever

When OFF: all emotion code paths are no-op. Existing behavior preserved exactly.

---

## 6. File Change Map

| File | Change Type | Description |
|------|-------------|-------------|
| `src/context-reconstructor.ts` | **NEW** | Reconstruction engine + grounding validator |
| `src/retriever.ts` | Modify | Add reconstruction gate at output + emotion scoring stage |
| `src/decay-engine.ts` | Modify | Add emotion-adjusted half-life |
| `src/memory-schema.ts` | Modify | Add EmotionMetadata type definition |
| `src/store.ts` | Modify | Call emotion detector at store time |
| `src/context-composer.ts` | Modify | Call reconstructor in resume flow |
| `src/mcp-server.ts` | Modify | Add `reconstruct` param to search_memory |
| `src/config.ts` | Modify | Add feature flags |
| `src/__tests__/context-reconstructor.test.ts` | **NEW** | Unit tests for reconstruction + grounding |
| `src/__tests__/emotion-scoring.test.ts` | **NEW** | Unit tests for emotion detection + decay + retrieval |

**Estimated LOC:**
- New code: ~400-500 lines
- Modified code: ~100-150 lines across existing files
- Tests: ~300-400 lines

---

## 7. Test Strategy

### Unit Tests
- Reconstruction gate: all 4 conditions tested (flag off, no opt-in, too few results, LLM down)
- Grounding validator: phantom ID removal, coverage threshold, timeout
- Emotion heuristic: positive/negative/neutral/mixed texts
- Decay adjustment: verify half-life calculations
- Retrieval emotion stage: neutral query no-op, matching boost, missing data handling

### Integration Tests
- End-to-end: store memories → search with reconstruct=true → verify output format
- End-to-end: store emotional memory → verify decay score after N days vs neutral memory
- resume_context with reconstruction → verify grounding and fallback

### Regression Tests
- All feature flags OFF → existing test suite must pass unchanged (zero regression)
- Memories without emotion field → same scores as before

---

## 8. Rollout Plan

**Phase 1: Emotion Valence (low risk, no LLM dependency)**
1. Add schema types
2. Implement heuristic detector
3. Integrate into store path
4. Add decay adjustment
5. Add retrieval scoring stage
6. Tests
7. Feature flag ON for testing

**Phase 2: Constructive Retrieval (medium risk, LLM dependent)**
1. Implement context-reconstructor.ts
2. Implement grounding validator
3. Integrate into retriever output
4. Integrate into context-composer
5. Add search_memory parameter
6. Tests
7. Feature flag ON for testing

**Phase 3: LLM Emotion Detection (optional enhancement)**
1. Piggyback on importance evaluation prompt
2. Override heuristic when available
3. A/B test heuristic vs LLM accuracy

---

## 9. Success Criteria

- [ ] Feature flags OFF → all existing tests pass (baseline per CLAUDE.md)
- [ ] Emotion-tagged memories decay 20-30% slower than neutral (verified in test)
- [ ] Reconstruction produces grounded output (coverage ≥ 0.6) in ≥ 80% of cases
- [ ] Reconstruction fallback triggers correctly when LLM is unavailable
- [ ] resume_context with reconstruction provides more contextually relevant summaries (qualitative)
- [ ] No additional LLM API calls for emotion detection (piggybacked on existing calls)
- [ ] Reconstruction latency < 3s in 95% of cases

---

## 10. Open Questions (resolved)

| Question | Decision |
|----------|----------|
| How aggressive should reconstruction be? | **Moderate (B)**: LLM rewrite from top-N, not fragment synthesis |
| What emotion model? | **Valence-Arousal**: simple, proven, low overhead |
| When to reconstruct by default? | **resume_context only**; search_memory opt-in |
| Grounding threshold? | **0.6 coverage**; tunable via config |
| Timeout? | **3 seconds**; hard cutoff |

---

## Sources

- Michaelian, K. — Simulation Theory of Memory
- Ebbinghaus Forgetting Curve + Weibull extensions
- Cognitive science consensus on emotional memory persistence
- [Stanford Encyclopedia of Philosophy: Memory](https://plato.stanford.edu/entries/memory/)
- [Memory in the Age of AI Agents](https://arxiv.org/abs/2512.13564)
- [SuperLocalMemory V3.3: Biologically-Inspired Forgetting](https://arxiv.org/html/2604.04514)
