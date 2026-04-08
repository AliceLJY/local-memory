# Research: Memory Evolution Mechanisms for RecallNest

> Source: "A Survey on Memory-Augmented LLM Agents" (107 pages), Sections 5.2, 7.7
> Date: 2026-04-01
> Purpose: Feed directly into RecallNest memory evolution implementation (P0 priority)

---

## Part 1: Memory Consolidation (Section 5.2.1)

### What It Is

Consolidation transforms fragmented short-term traces into structured, generalizable long-term knowledge. Its core mechanism: identify semantic relationships between new and existing memories, then integrate them into higher-level abstractions. Two purposes: (1) reorganize fragments into coherent structures, preventing detail loss; (2) abstract and compress experiential data into reusable patterns for cross-task generalization.

### Three Granularities

#### 1. Local Consolidation (fine-grained, pair-level)

**Trigger**: New memory arrives that is highly similar to an existing entry.

**Algorithm**:
- RMM: Each new topic memory retrieves its top-K most similar candidates. An LLM decides whether merging is appropriate. This reduces the risk of incorrect generalization.
- VLN: Triggers a pooling mechanism when capacity is saturated. Identifies the most similar or redundant memory pairs and compresses them into higher-level abstractions.

**Trade-off**: Refines detailed knowledge while preserving global structure. Improves precision and storage efficiency. BUT cannot capture cluster-level relations or higher-order dependencies that emerge across semantically related memories.

**RecallNest applicability**: HIGH. This is the simplest starting point. On each `store_memory`, retrieve top-K similar entries, ask LLM "should these be merged?", merge if yes.

#### 2. Cluster-level Fusion (cross-instance regularities)

**Trigger**: Memory store grows large enough that cross-instance patterns emerge.

**Algorithm**:
- PREMem: Aligns new memory clusters with similar existing ones. Applies fusion modes such as "generalization" and "refinement" to form higher-order reasoning units. Clusters extracted factual, experiential, and subjective memories to identify cross-session reasoning patterns.
- EverMemOS: Computes similarity between a newly generated MemCell and the centroids of all MemScenes (clusters). Merges into the MemScene that is sufficiently similar (above threshold).
- TiM (Think-in-Memory): Periodically invokes an LLM to examine memories sharing the same hashing bucket. Merges semantically redundant entries. Uses hash-based grouping for efficiency.
- CAM: Merges all nodes within a target cluster into a representative summary, yielding higher-level cross-sample representations. Handles overlapping clusters via node replication.

**Trade-off**: Reorganizes memory at broader scale, important step toward structured knowledge. BUT requires a clustering mechanism and periodic maintenance cycles.

**RecallNest applicability**: MEDIUM. Implement as a background job. Group memories by topic/entity, periodically run LLM-driven cluster summarization.

#### 3. Global Integration (holistic, system-level)

**Trigger**: Accumulated experience reaches a threshold where system-level insights can be distilled.

**Algorithm**:
- MOOM: Constructs stable role profiles by integrating temporary role snapshots with historical traces. Uses rule-based processing + embedding methods + LLM-driven abstraction.
- Matrix: Iterative optimization combining execution trajectories and reflective insights with global memory. Distills task-agnostic principles reusable across scenarios.
- AgentFold / Context Folding: After each step in multi-step interactions, automatically summarize and condense the global context.

**Trade-off**: Provides reliable contextual foundation, improves generalization and reasoning. BUT highest computational cost, risk of over-abstraction.

**RecallNest applicability**: LOW for MVP. This is a future feature for generating "insight memories" from accumulated data.

### Critical Risk: Information Smoothing

The survey explicitly warns: consolidation risks "information smoothing" where **outlier events or unique exceptions are lost during the abstraction process**, potentially reducing the agent's sensitivity to anomalies and specific events.

**Mitigation for RecallNest**: NEVER delete originals during consolidation. Create a new consolidated entry that links back to source entries. Mark originals as `consolidated_into: <id>` but retain them in an archive tier.

---

## Part 2: Memory Updating (Section 5.2.2)

### What It Is

Memory updating revises or replaces existing memory when conflicts arise or new information is acquired. Goal: maintain factual consistency and continual adaptation without full retraining. Unlike consolidation (which abstracts), updating emphasizes localized correction and synchronization.

### Evolution of External Memory Update Mechanisms

The survey traces a clear progression:

#### Stage 1: Destructive Replacement (early systems)
- **Systems**: MemGPT, D-SMART, Mem0g
- **Algorithm**: LLM detects conflicts between new information and existing entries, then invokes replace or delete operations.
- **Problem**: Erases valuable historical context and breaks temporal continuity.

#### Stage 2: Temporal Annotation / Soft Deletion
- **System**: Zep
- **Algorithm**: Marks conflicting facts with `invalid` timestamps rather than deleting them. Preserves both semantic consistency and temporal integrity.
- **Key insight**: Shift from hard replacement to soft, time-aware updating.

**RecallNest applicability**: CRITICAL. This is the approach to adopt. Add `valid_from` / `valid_until` timestamps. Never hard-delete; mark as superseded.

#### Stage 3: Dual-Phase Updating
- **Systems**: MOOM, LightMem
- **Algorithm**: Two phases:
  1. **Soft online update**: Real-time responsiveness. Quick, lightweight conflict marking.
  2. **Offline reflective consolidation**: Similar entries merged, conflicts resolved via LLM reasoning.
- **Rationale**: Real-time updates impose significant computational and I/O burdens under high-frequency interaction. Eventual consistency paradigm balances latency and coherence.

**RecallNest applicability**: HIGH. Online phase = mark conflicts at write time. Offline phase = periodic `distill_memory` enhancement.

#### Stage 4: Learned Update Policies (RL-driven)
- **System**: Mem-alpha
- **Algorithm**: Formulates memory updating as a policy-learning problem. LLM learns when, how, and whether to update, achieving dynamic trade-offs between stability and freshness.

**RecallNest applicability**: LOW for MVP. Requires RL training. Future direction only.

### Conflict Detection: How Systems Detect Contradictions

Based on surveyed systems, conflict detection follows these patterns:
1. **Semantic similarity + LLM judgment**: Retrieve entries similar to the new memory, ask LLM "does new info contradict existing?" (MemGPT, D-SMART, Mem0g approach)
2. **Entity-based matching**: Extract entities from new memory, find existing memories about same entities, compare predicates (Zep's temporal KG approach)
3. **Temporal comparison**: Same entity + different attribute value + different timestamp = likely update, not contradiction

### The Stability-Plasticity Dilemma

The survey calls this the key challenge: "determining when to overwrite existing knowledge versus when to treat new information as noise. Incorrect updates can overwrite critical information, leading to knowledge degradation and faulty reasoning."

**RecallNest design principle**: Default to PRESERVING both old and new, linked with a `supersedes` relationship. Let the retrieval layer handle recency-preference. Only truly merge after explicit confirmation or high-confidence LLM judgment.

---

## Part 3: Memory Forgetting (Section 5.2.3)

### What It Is

Deliberate removal of outdated, redundant, or low-value information to free capacity and maintain focus. Unlike updating (which resolves conflicts), forgetting prioritizes eliminating outdated information for efficiency and relevance.

### The Core Tension

"Unbounded memory accumulation leads to increased noise, retrieval delays, and interference from outdated knowledge. Controlled forgetting helps mitigate overload. Yet, overly aggressive pruning risks erasing rare but essential knowledge."

### Three Forgetting Mechanisms

#### 1. Time-based Forgetting

**Trigger**: Memory age exceeds threshold or context overflows.

**Implementations**:
- **MemGPT**: Evicts earliest messages upon context overflow (FIFO).
- **Xu et al. / Wang et al.**: Stochastic token replacement with ratio K/N, simulating exponential forgetting in human cognition. Discard oldest entries once pool exceeds capacity.
- **MAICC**: Implements **soft forgetting** by gradually decaying memory weights over time. Mirrors natural forgetting. Continuous adaptation without historical overload.

**Trade-off**: Simple and predictable. BUT old memories may still be critically relevant. Pure time-based decay is too blunt.

**RecallNest applicability**: MEDIUM. Use as one signal in a composite score, not as sole criterion. Implement as a decay multiplier on retrieval relevance, not as a deletion trigger.

#### 2. Frequency-based Forgetting (LRU/LFU)

**Trigger**: Memory access frequency falls below threshold.

**Implementations**:
- **XMem**: LFU (Least Frequently Used) policy to remove low-frequency entries.
- **KARMA**: Uses **counting Bloom filters** to track access frequency. Space-efficient probabilistic tracking.
- **MemOS**: LRU (Least Recently Used) strategy. Removes long-unused items while **archiving highly active ones**. Maintains storage equilibrium.

**Key insight from survey**: Time-based decay captures natural temporal aging, while frequency-based forgetting reflects usage dynamics. These two axes are orthogonal and should be combined.

**RecallNest applicability**: HIGH. Track `access_count` and `last_accessed_at` per memory. Use these in retrieval scoring. MemOS's "archive highly active" pattern is excellent -- frequently accessed memories get promoted, not just retained.

#### 3. Importance-driven Forgetting (semantic intelligence)

**Trigger**: LLM judges a memory as low-value relative to current context.

**Implementations**:
- **Early approaches (Zhong et al., Chen et al.)**: Composite scores combining temporal decay + access frequency. Numeric-based selective forgetting.
- **VLN**: Pools semantically redundant memories via similarity clustering (merge, not delete).
- **Livia**: Incorporates **emotional salience** and contextual relevance. Models emotion-driven selective forgetting.
- **TiM**: Leverages LLM to assess memory importance and explicitly prune less important memories. The LLM reads the memory and rates its importance.
- **MemTool**: Also uses LLM to judge importance. Explicitly prunes or forgets less important memories.

**Trade-off**: Most sophisticated approach. Agents can perform "conscious forgetting." BUT LLM calls are expensive and introduce latency. Risk of the LLM misjudging what's important.

**RecallNest applicability**: HIGH for the importance scoring. CAUTIOUS on actual deletion. Use LLM importance scores to deprioritize in retrieval, not to delete.

### The Archive vs Delete Debate

The survey states clearly: **"When storage cost is not a critical constraint, many memory systems avoid directly deleting certain memories."** Heuristic forgetting mechanisms like LRU "may eliminate long-tail knowledge, which is seldom accessed but essential for correct decision-making."

**RecallNest design principle**: ARCHIVE-FIRST, DELETE-NEVER as default policy. "Forgotten" memories move to a cold tier, excluded from default retrieval but recoverable. Actual deletion only via explicit user request (privacy/GDPR compliance).

---

## Part 4: Trustworthy Memory (Section 7.7)

### Privacy Risks

**Wang et al. (2025b) finding**: Memory modules can **leak private data through indirect prompt-based attacks**. Risk of memorization and over-retention. The paper references MEXTRA (Wang et al., 2025b), which demonstrated extracting raw dialogue data from memory systems.

**Implications for RecallNest**:
- An MCP server that persists user memories across sessions is a privacy attack surface.
- Memory entries may contain PII, credentials, or sensitive context that the user didn't intend to persist.

### Three Pillars of Trustworthy Memory

#### 1. Privacy Preservation
- Granular **permissioned memory** (who can read what)
- **User-governed retention policies** (user controls what persists)
- Encrypted or on-device storage
- Federated access where needed
- Techniques: differential privacy, **memory redaction**, adaptive forgetting (decay-based or user-erasure interfaces)

#### 2. Explainability
- Traceable access paths (which memory was retrieved for which response)
- Self-rationalizing retrievals
- Counterfactual reasoning: "what would have changed without this memory?"
- Visualizations of memory attention, causal graphs of memory influence
- User-facing debugging tools

#### 3. Hallucination Robustness
- Conflict detection between memories
- Multi-document reasoning
- Uncertainty-aware generation
- Abstention under low-confidence retrieval
- Multi-agent cross-checking

### Auditable Updates and Verifiable Forgetting

Wu et al. (2025g) argues that agent memory systems must support:
- **Explicit mechanisms for access control**
- **Verifiable forgetting**: Proof that data was actually removed, not just hidden
- **Auditable updates**: Log of what changed, when, and why

### Future Vision

The survey envisions "memory systems governed by OS-like abstractions: segmented, **version-controlled**, **auditable**, and jointly managed by agent and user."

**RecallNest applicability**: Version control is achievable now. Every update creates a new version, old version retained with audit trail. Access control can be per-scope. Verifiable forgetting (actual data erasure on request) is a hard requirement for production use.

---

## Part 5: Practical Design for RecallNest

### 5.1 Minimum Viable Memory Evolution Fields

Every memory record in RecallNest should gain these fields:

```python
# --- Lifecycle metadata ---
created_at: datetime          # Already exists
updated_at: datetime          # Last modification time
valid_from: datetime          # When this fact became true (temporal annotation, Zep-style)
valid_until: datetime | None  # When this fact was superseded (None = currently valid)

# --- Access tracking (frequency-based forgetting) ---
access_count: int             # How many times retrieved (for LFU scoring)
last_accessed_at: datetime    # When last retrieved (for LRU scoring)

# --- Evolution tracking ---
importance: float             # 0.0-1.0, LLM-assessed or composite score
status: str                   # "active" | "superseded" | "archived" | "consolidated"
superseded_by: str | None     # ID of the memory that replaced this one
consolidated_into: str | None # ID of the consolidated memory this fed into
source_memories: list[str]    # IDs of memories that were consolidated into this one
version: int                  # Incremented on each update (audit trail)

# --- Decay signal ---
decay_score: float            # Composite of time_decay * frequency_score * importance
                              # Recomputed periodically or at retrieval time
```

### 5.2 Consolidation Algorithm (No Model Training Required)

**Recommended: Local Consolidation (RMM-style) as MVP**

```
TRIGGER: On each store_memory() call, OR periodic background sweep

ALGORITHM:
1. For the new memory M_new:
   a. Retrieve top-K (K=5) most similar existing memories by embedding similarity
   b. Filter to only those with similarity > MERGE_THRESHOLD (e.g., 0.85)
   c. For each candidate M_old:
      - Ask LLM: "Memory A says: '{M_old.content}'. Memory B says: '{M_new.content}'. 
        Are these about the same topic? Should they be merged into one? 
        Or does B update/supersede A? Or are they complementary?"
      - LLM returns: MERGE | SUPERSEDE | COMPLEMENT | UNRELATED
   d. If MERGE: Create M_consolidated with merged content. 
      Set M_old.status = "consolidated", M_old.consolidated_into = M_consolidated.id
      Set M_new.status = "consolidated", M_new.consolidated_into = M_consolidated.id
      Set M_consolidated.source_memories = [M_old.id, M_new.id]
   e. If SUPERSEDE: Set M_old.status = "superseded", M_old.superseded_by = M_new.id
      Set M_old.valid_until = now()
   f. If COMPLEMENT: Store M_new as new entry, add cross-reference link
   g. If UNRELATED: Store M_new as new entry, no linking
```

**Cluster-level consolidation (phase 2, background job)**:

```
TRIGGER: Periodic (daily or on-demand via distill_memory tool)

ALGORITHM:
1. Group active memories by scope + topic embedding clusters (k-means or HDBSCAN)
2. For each cluster with > N members (N=5):
   a. Present all cluster members to LLM
   b. Ask: "Synthesize these related memories into a single high-level insight. 
      Preserve any contradictions or temporal evolution."
   c. Create insight memory with source_memories linking to all originals
   d. Mark originals as consolidated_into the insight (but keep status="active" 
      so they're still individually retrievable)
```

### 5.3 Forgetting Policy: Archive-First, Delete-Never

```
COMPOSITE DECAY SCORE (recomputed at retrieval time or periodically):

decay_score = (
    time_weight * time_decay(created_at, half_life=90_days) +
    frequency_weight * frequency_score(access_count, last_accessed_at) +
    importance_weight * importance
)

Where:
- time_decay = 0.5 ^ (days_since_creation / half_life)
- frequency_score = log(1 + access_count) * recency_boost(last_accessed_at)
- importance = LLM-assessed on creation, or default 0.5

Weights: time=0.2, frequency=0.3, importance=0.5
(Importance dominates because time and frequency are blunt instruments)

ARCHIVE POLICY:
- Memory with decay_score < ARCHIVE_THRESHOLD (e.g., 0.1) for > 30 days 
  AND status != "pinned":
  -> Set status = "archived"
  -> Excluded from default retrieval
  -> Still searchable via explicit search_memory with include_archived=true
  
- NEVER auto-delete. Delete only on explicit user request (for privacy/GDPR).
- Pinned memories (via pin_memory tool) are exempt from archiving.
```

### 5.4 Conflict Detection Using Existing LLM Capabilities

**At write time (online phase, lightweight)**:

```
1. On store_memory(content):
   a. Extract key entities/claims from content (can be simple: just use the content as query)
   b. Retrieve top-3 existing memories by similarity
   c. Quick conflict check (can be part of the consolidation LLM call):
      "Does the new information contradict any existing memory? 
       If so, which one and how?"
   d. If conflict detected:
      - Flag the old memory with valid_until = now()
      - Store new memory with a supersedes link
      - Log the conflict for audit trail
      
2. Conflict severity levels:
   - FACTUAL_UPDATE: "User moved from Singapore to Tokyo" supersedes "User lives in Singapore"
   - PREFERENCE_CHANGE: "User now prefers dark mode" supersedes "User prefers light mode"  
   - CONTRADICTION: Genuinely conflicting info, keep both, flag for human review
   - ELABORATION: New info adds detail, no conflict
```

**At retrieval time (read-path dedup)**:

```
When retrieving memories:
1. If multiple memories about the same entity/topic are retrieved:
   a. Prefer the one with valid_until = None (currently valid)
   b. If both are current, prefer higher importance score
   c. If conflict detected at retrieval time, include both but annotate:
      "[Note: conflicting memories found. Memory A (from DATE) says X. 
       Memory B (from DATE) says Y.]"
```

### 5.5 Privacy Considerations for MCP Server

**Immediate (MVP)**:
- Scope-based access isolation (already exists in RecallNest: memories are per-scope)
- No cross-scope memory leakage in retrieval
- Audit log: every memory access logged with timestamp, tool, and scope
- User can list all their memories via `export_memory`
- User can request deletion of specific memories (hard delete on request)

**Short-term (next quarter)**:
- Memory redaction: ability to mark parts of memory as redacted (PII scrubbing)
- Retention policies per scope: "auto-archive after N days", "auto-delete after N days"
- Content classification on write: flag potential PII/secrets, warn before persisting

**Long-term**:
- Encrypted at-rest storage for memory content
- Verifiable forgetting: cryptographic proof that data was erased
- Access control lists per memory entry (not just per scope)

---

## Summary: Priority Implementation Order

| Priority | Feature | Effort | Source Inspiration |
|----------|---------|--------|--------------------|
| P0 | Add lifecycle fields (valid_from/until, status, version) | Low | Zep temporal annotation |
| P0 | Add access tracking fields (access_count, last_accessed_at) | Low | KARMA, MemOS |
| P0 | Implement supersede-on-conflict (never hard-delete) | Medium | Zep, MOOM |
| P1 | Local consolidation on store_memory (top-K similarity + LLM merge decision) | Medium | RMM |
| P1 | Composite decay scoring for retrieval ranking | Medium | MemoryBank, TiM |
| P1 | Archive policy (status="archived" for low-decay memories) | Low | MemOS archive pattern |
| P2 | Periodic cluster-level consolidation (background distill) | High | PREMem, EverMemOS |
| P2 | LLM-driven importance scoring on store | Medium | TiM, MemTool |
| P2 | Conflict detection at write time | Medium | Mem0g, D-SMART |
| P3 | Audit logging for all memory operations | Medium | Wu et al. trustworthy memory |
| P3 | User-governed retention policies | Medium | Survey 7.7 privacy |
| P3 | Memory redaction / PII detection | High | Wang et al. 2025b |

---

## Key Quotes from the Survey

> "A naive strategy is simply appending new entries to the existing memory bank. However, it overlooks the semantic dependencies and potential contradictions between memory entries and neglects the temporal validity of information." (p.55)

> "When storage cost is not a critical constraint, many memory systems avoid directly deleting certain memories." (p.59)

> "Heuristic forgetting mechanisms like LRU may eliminate long-tail knowledge, which is seldom accessed but essential for correct decision-making." (p.59)

> "Memory modules can leak private data through indirect prompt-based attacks, highlighting the risk of memorization and over-retention." (p.75)

> "Agent memory systems must support explicit mechanisms for access control, verifiable forgetting, and auditable updates to remain trustworthy." (p.75)

> "The stability-plasticity dilemma: determining when to overwrite existing knowledge versus when to treat new information as noise." (p.58)

---

## Named Systems Quick Reference

| System | Key Contribution to Memory Evolution | Paper |
|--------|--------------------------------------|-------|
| RMM | Local consolidation: top-K similar + LLM merge decision | Tan et al., 2025c |
| VLN | Capacity-triggered pooling of redundant memory pairs | Song et al., 2025b |
| PREMem | Cluster-level fusion: align + generalize/refine memory clusters | Kim et al., 2025b |
| EverMemOS | MemCell-to-MemScene centroid similarity merging | Hu et al., 2026a |
| TiM | Hash-bucket periodic LLM merging + importance-driven forgetting | Liu et al., 2023a |
| CAM | Cluster summarization with overlapping cluster handling | Li et al., 2025g |
| MOOM | Dual-phase updating (soft online + offline reflective) + global integration | Chen et al., 2025e |
| Matrix | Iterative optimization for global experiential consolidation | Liu et al., 2024 |
| MemGPT | FIFO eviction + LLM-driven retrieval timing | Packer et al., 2023a |
| Mem0/Mem0g | LLM-driven summarization + entity-level KG + destructive replacement | Chhikara et al., 2025 |
| Zep | Temporal KG + soft deletion via invalid timestamps (not hard delete) | Rasmussen et al., 2025 |
| D-SMART | OWL-compliant dynamic memory graph + conflict detection | Lei et al., 2025 |
| LightMem | Topic-clustered summarization + dual-phase updating | Fang et al., 2025b |
| MemOS | LRU forgetting + archive highly active + MemScheduler routing | Li et al., 2025l |
| KARMA | Counting Bloom filters for access frequency tracking | Wang et al., 2025r |
| MemTool | LLM-driven importance assessment + explicit pruning | Lumer et al., 2025 |
| Livia | Emotional salience + contextual relevance for forgetting | Xi and Wang, 2025 |
| Mem-alpha | RL-trained memory update policy (when/how/whether to update) | Wang et al., 2025p |
| A-MEM | Networked notes with semantic links (structured construction) | Xu et al., 2025c |
