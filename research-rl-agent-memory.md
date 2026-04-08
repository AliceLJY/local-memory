# RL + Agent Memory: Research Report from "Memory in the Age of AI Agents"

**Source**: arXiv 2512.13564 (v2, Jan 2026), 107 pages  
**Focus**: Section 7.3 + all cross-references to RL-driven memory systems  
**Purpose**: Extract actionable design insights for RecallNest renovation  

---

## 1. The Three-Stage Evolution (Figure 11, Page 71)

The paper identifies a clear evolutionary trajectory from manually designed to fully learned memory systems.

### Stage 1: RL-Free Memory Systems

These rely on **heuristic or manually specified mechanisms** with no RL training:

| Mechanism | Examples | How It Works |
|-----------|----------|--------------|
| Heuristic Threshold | MemoryBank | Fixed thresholding rules inspired by forgetting curves |
| Semantic Search | MemOS, Mem0, MemoBase | Rigid semantic search pipelines (embedding similarity) |
| Chunk Concat | Early systems | Simple concatenation-based strategies for storing chunks |
| Prompt-based Generation | ExpeL, EvolveR, G-Memory, Dynamic Cheatsheet, A-Mem, ReasoningBank | LLM generates memory entries but has **no dedicated training** for memory control. Behavior is entirely prompt-driven. |

**Key insight from the paper**: "The LLM is asked to generate memory entries but has not received any dedicated training for effective memory control." This describes **most current production systems including RecallNest**.

### Stage 2: RL Partially Involved (Current SOTA)

RL governs **selected** memory operations while others remain manual:

| System | Memory Op RL-ified | What Remains Manual |
|--------|-------------------|-------------------|
| **RMM** | Retrieval reranking | Memory formation, storage structure |
| **Mem-alpha** | Memory construction (writing) + memory updating | Retrieval pipelines |
| **Memory-R1** | Memory extraction fusion component | Extraction itself (LLMExtract module), retrieval |
| **Mem1** | Summarization (PPO) | Memory structure, retrieval |
| **MemAgent** | Summarization (GRPO) | Memory structure |
| **Memento** | Trajectory selection (Q-learning) | Memory formation |
| **MemSearcher** | Search + memory management (end-to-end RL) | Long-term consolidation |
| **ReSum** | Summary-conditioned behavior (RL) | Memory structure |
| **IterResearch** | Workspace reconstruction (MDP-inspired) | Storage architecture |
| **Context Folding** | Folding/compression policy (RL) | Storage, long-term memory |
| **Memory-as-Action** | Context compression (RL) | Storage architecture |
| **MemGen** | Latent memory trigger + weaver (RL) | External storage |
| **ACON** | State consolidation (optimization) | Actually PE, not RL |

### Stage 3: Fully RL-Driven (Future Vision)

The paper's two defining properties for this stage:

1. **No human-engineered priors**: Agents should invent their own memory organizations (formats, schemas, update rules) through RL incentives rather than inheriting human cognitive analogies (hippocampal, cortical, episodic/semantic/core categories).

2. **Complete lifecycle control**: The agent autonomously handles formation + evolution + retrieval in an integrated manner via end-to-end RL training.

**The paper states this does not yet exist.** No current system achieves both properties.

---

## 2. Detailed System Analysis

### RMM (Tan et al., 2025c)

| Aspect | Detail |
|--------|--------|
| **Memory op RL optimizes** | Retrieval reranking |
| **RL algorithm** | Lightweight policy gradient |
| **Reward signal** | Downstream task performance after reranking |
| **How it works** | After initial retrieval (BM25 or semantic similarity), a lightweight policy gradient learner ranks memory chunks by predicted utility |
| **Difference from prompt-engineering** | The reranker is trained, not prompted. Fixed retriever + learned reranker |
| **Memory structure** | Reflection-organized flat entries; topic-based memory with top-K similarity matching and LLM-based merge decisions |

### Mem-alpha (Wang et al., 2025p) -- arXiv 2509.25911

| Aspect | Detail |
|--------|--------|
| **Memory op RL optimizes** | Memory formation (insight extraction) + memory updating |
| **RL algorithm** | RL-based policy learning (specific algorithm not named in survey, likely GRPO/PPO-family given the field) |
| **Reward signal** | Downstream task performance (document reasoning, multi-objective QA) |
| **How it works** | "Explicitly trains the LLM on **what insights to extract and how to preserve them**." Delegates the entire process of memory construction to an RL-trained agent. Memory updating is formulated as a policy-learning problem -- the LLM learns when, how, and whether to update. |
| **Difference from prompt-engineering** | Most systems use fixed prompts for insight extraction (sensitive to prompt design). Mem-alpha makes extraction itself a learnable policy. |
| **Memory structure** | Core, Semantic, and Episodic memory (three-tier) |
| **Gap** | Still relies on manually defined retrieval pipelines |

### Memory-R1 (Yan et al., 2025c) -- arXiv 2508.19828

| Aspect | Detail |
|--------|--------|
| **Memory op RL optimizes** | Memory fusion (integrating extracted outputs into memory bank) + post-retrieval filtering |
| **RL algorithm** | RL-trained (specific algorithm not named; "R1" naming convention suggests GRPO-family like DeepSeek-R1) |
| **Reward signal** | Answer correctness in long-conversation QA |
| **How it works** | An auxiliary agent with a "memory manager" tool handles memory updates. Uses an LLMExtract module for experiential/factual knowledge extraction. Only the fusion component is trained. Also introduces LLM-based evaluators that filter retrieved content before final response. |
| **Difference from prompt-engineering** | The extraction module itself is not RL-trained (falls short), but the integration/fusion layer is. Prompt-based filtering is limited by LLM capacity; RL training improves robustness. |
| **Memory structure** | RL-managed mem0-like architecture |

### MemGen (Zhang et al., 2025d)

| Aspect | Detail |
|--------|--------|
| **Memory op RL optimizes** | Memory formation (latent representation) + retrieval timing |
| **RL algorithm** | RL + SFT (combined) |
| **Reward signal** | Task performance across web search, embodied simulation, reasoning, math, code |
| **How it works** | Two LoRA adapters: one determines **where** to insert memory fragments, another determines **what** latent content to insert. A "memory trigger" detects critical retrieval moments from latent rollout states. Converts explicit agent-level retrieval decisions into **latent, trainable processes**. |
| **Difference from prompt-engineering** | Memory is latent tokens injected into reasoning stream (not text). Retrieval timing is learned, not rule-based. End-to-end differentiable. |
| **Memory structure** | Latent memory tokens (not human-readable) |

### Context Folding (Sun et al., 2025b)

| Aspect | Detail |
|--------|--------|
| **Memory op RL optimizes** | Working memory compression (hierarchical folding) |
| **RL algorithm** | RL (specific variant not named) |
| **Reward signal** | Task performance in deep research and SWE tasks |
| **How it works** | Makes the folding operation a **learnable policy**. Agents learn to autonomously determine **when to branch** into sub-trajectories and **how to abstract** them into high-level states. Internalizes the ability to compress working memory. In multi-step interactions, automatically summarizes and condenses the global context after each step. |
| **Difference from prompt-engineering** | HiAgent (prompt-based) uses fixed subgoal-based folding. Context Folding trains the folding policy via RL. |

### Memory-as-Action (Zhang et al., 2025r) -- also listed as "MemAct" in tables

| Aspect | Detail |
|--------|--------|
| **Memory op RL optimizes** | Working memory management (context compression) |
| **RL algorithm** | RL (specific variant not named) |
| **Reward signal** | Multi-objective QA task performance |
| **How it works** | Treats memory operations as actions in the agent's policy. Context compression and management are framed as agent actions optimized via RL. |
| **Difference from prompt-engineering** | Memory management is part of the action space, not a separate pipeline |

### MemSearcher (Yuan et al., 2025a)

| Aspect | Detail |
|--------|--------|
| **Memory op RL optimizes** | Reasoning + search + memory management (end-to-end) |
| **RL algorithm** | SFT + RL (end-to-end reinforcement learning per the title) |
| **Reward signal** | Multi-hop QA correctness |
| **How it works** | Employs recurrent mechanisms to update fixed-budget memory and discard redundancy. Answers queries from a compact, evolving state. Title literally says "Training LLMs to Reason, Search and Manage Memory via End-to-End Reinforcement Learning." |
| **Difference from prompt-engineering** | Jointly trains reasoning, search, and memory management. Not a modular pipeline. |
| **Gap** | Focuses primarily on short-term working memory; does not address long-term consolidation or evolution |

### Mem1 / MEM1 (Zhou et al., 2025b) -- arXiv 2506.15841

| Aspect | Detail |
|--------|--------|
| **Memory op RL optimizes** | Incremental summarization |
| **RL algorithm** | **PPO** (Proximal Policy Optimization) |
| **Reward signal** | Retrieval accuracy, open-domain QA, shopping task performance |
| **How it works** | Maintains a shared internal state that merges new observations with prior memory. Enhanced LLM's own summarization capability through RL with PPO. "Learning to synergize memory and reasoning for efficient long-horizon agents." |
| **Difference from prompt-engineering** | MemGPT/Mem0 rely on LLM's inherent summarization (often drifts). Mem1 trains the summarization policy. |

### ReSum (Wu et al., 2025f) -- arXiv 2509.13313

| Aspect | Detail |
|--------|--------|
| **Memory op RL optimizes** | Summary-conditioned behavior for exploration |
| **RL algorithm** | RL (specific variant not named) |
| **Reward signal** | Long-horizon web search task performance |
| **How it works** | Periodically distills history into reasoning states. Uses RL to optimize summary-conditioned behavior for indefinite exploration. "Unlocking Long-Horizon Search Intelligence via Context Summarization." |
| **Difference from prompt-engineering** | The summarization is optimized for downstream exploration performance, not just compression fidelity |

### IterResearch (Chen et al., 2025b)

| Aspect | Detail |
|--------|--------|
| **Memory op RL optimizes** | Workspace reconstruction (iterative memory synthesis) |
| **RL algorithm** | RL with MDP-inspired formulation |
| **Reward signal** | Long-horizon QA, reasoning, web navigation performance |
| **How it works** | Adopts an MDP-inspired formulation with iterative workspace reconstruction. An evolving report serves as persistent memory. Periodic synthesis mitigates "context suffocation" and noise contamination. |
| **Difference from prompt-engineering** | Framed as sequential decision-making (MDP), not static summarization |

### Additional RL-Adjacent Systems

| System | RL Method | What It Does |
|--------|-----------|-------------|
| **MemAgent** (Yu et al., 2025a) | GRPO | Multi-conversation RL-based memory agent. Recurrent memory update for long-term doc QA |
| **Memento** (Zhou et al., 2025a) | Q-learning | Predicts probability that a retrieved item contributes to a correct answer. Fine-tunes retrieval without fine-tuning LLMs. |
| **ACON** (Kang et al., 2025c) | PE (not RL) | Frames state consolidation as optimization but uses prompt engineering, not gradient-based RL |
| **AgentEvolver** | RL | Evolves memory architecture patterns, not just content |
| **SUMER** | RL | QA-focused summarization |
| **Sculptor** | PE + RL | Multi-needle QA |

---

## 3. Which Memory Operations Are RL-ified vs. Still Manual?

### Memory Lifecycle Coverage

| Memory Operation | RL-ified Examples | Still Mostly Manual/Prompt-Based |
|-----------------|-------------------|----------------------------------|
| **Formation: Summarization** | Mem1 (PPO), MemAgent (GRPO), ReSum (RL) | MemGPT, Mem0 (prompt-based) |
| **Formation: Knowledge Distillation** | Mem-alpha (policy learning), Memory-R1 (fusion only) | ExpeL, Reflexion, H2R (all prompt-based) |
| **Formation: Structured Construction** | None fully RL | GraphRAG, Zep, AriGraph (all heuristic/prompt) |
| **Formation: Latent Representation** | MemGen (RL + SFT) | MemoryLLM, M+ (SFT only) |
| **Evolution: Consolidation** | Context Folding (RL policy) | Most systems (rule-based merge) |
| **Evolution: Updating** | Mem-alpha (policy learning) | MemGPT, D-SMART, Mem0g (rule-based) |
| **Evolution: Forgetting** | None fully RL | All systems (heuristic: LRU, LFU, time-decay) |
| **Retrieval: Timing** | MemGen (learned triggers) | MemGPT (prompt-based triggers) |
| **Retrieval: Reranking** | RMM (policy gradient), Memento (Q-learning) | Most systems (cosine similarity + top-K) |
| **Retrieval: Query Construction** | Limited work | Mostly prompt-engineered |
| **Working Memory: Compression** | MemSearcher, Context Folding, Memory-as-Action, IterResearch | HiAgent, ACON (prompt-based) |

### Key Gaps (Still Entirely Manual)

1. **Memory forgetting**: No RL-based forgetting policy exists. All use heuristic LRU/LFU/time-decay.
2. **Structured construction**: No RL for building knowledge graphs or tree structures.
3. **Retrieval query construction**: Almost entirely prompt-engineered.
4. **Cross-stage coordination**: No system integrates formation + evolution + retrieval under a single RL policy.

---

## 4. Practical Takeaways for RecallNest

### What We Can Implement WITHOUT Training Our Own Models

These are architectural and pipeline improvements inspired by RL systems but implementable with prompt-engineering or off-the-shelf components:

| Improvement | Inspired By | Implementation Approach |
|-------------|------------|----------------------|
| **Memory-as-Action framing** | Memory-as-Action, MemSearcher | Expose memory operations (store/update/delete/retrieve) as explicit tool calls. The LLM agent reasons about when and how to use them. RecallNest already does this via MCP tools -- validate and refine the tool design. |
| **Hierarchical folding for working memory** | HiAgent (prompt-based), ACON | Implement subgoal-based context compression. When a sub-task completes, fold its detailed trace into a summary. ACON does this with prompt engineering only. |
| **Dual-phase updating** | MOOM, LightMem | Soft online update (immediate) + offline reflective consolidation (batch merge/conflict resolution). No RL needed. |
| **Temporal-aware soft deletion** | Zep | Instead of hard-delete, mark conflicting facts with invalid timestamps. Preserves history. |
| **Composite retrieval scoring** | Generative Agents, MAICC | Score memories by recency + importance + relevance (multi-factor). Existing prompt-based approach. |
| **LLM-based post-retrieval filtering** | Memory-R1 | Before injecting retrieved memories into context, have the LLM evaluate relevance and filter. Works without training. |
| **Importance-driven forgetting** | TiM, MemTool | Use LLM to assess memory importance rather than pure recency/frequency heuristics. |
| **Three-tier memory structure** | Mem-alpha | Organize into Core (permanent), Semantic (factual), Episodic (event-based) tiers with different retention policies. |
| **MDP-style workspace reconstruction** | IterResearch | For long research tasks, periodically synthesize an evolving report as persistent state. Reduces context noise. |

### What REQUIRES Model Training (Cannot Do with Prompt-Only)

| Capability | Why Training Is Needed | Example System |
|-----------|----------------------|---------------|
| **RL-trained summarization** | PPO/GRPO-optimized summarization significantly outperforms prompt-based (reduces semantic drift over iterations) | Mem1, MemAgent |
| **Learned memory construction policy** | Training what insights to extract and how to preserve them -- prompt sensitivity is the bottleneck | Mem-alpha |
| **Latent memory tokens** | Requires LoRA adapters trained to inject latent representations into reasoning stream | MemGen |
| **Trained retrieval reranker** | Policy gradient or Q-learning trained reranker consistently outperforms prompt-based reranking | RMM, Memento |
| **End-to-end memory + reasoning** | Joint optimization of search, memory management, and reasoning | MemSearcher |
| **Learned folding policy** | When to fold and how to abstract sub-trajectories | Context Folding |

### Hybrid Strategy: What RecallNest Should Do

**Phase 1 (No training, immediate)**:
- Refine MCP tool design to match the "Memory-as-Action" paradigm. Each tool call should be a deliberate memory action the agent reasons about.
- Implement hierarchical memory tiers (core/semantic/episodic) with differentiated retention policies.
- Add temporal-aware soft deletion instead of hard-delete.
- Implement dual-phase updating (online soft + offline consolidation).
- Add multi-factor retrieval scoring (recency + importance + relevance).
- Add LLM-based post-retrieval filtering before context injection.

**Phase 2 (Lightweight training / fine-tuning)**:
- Train a small reranker model for memory retrieval (following RMM). This is a lightweight policy gradient learner, not a full LLM training job.
- Fine-tune a summarization adapter using task performance as reward. Even SFT on curated summary examples would help.

**Phase 3 (Full RL, requires infrastructure)**:
- Train memory construction policy (Mem-alpha style): what to extract, when to update.
- End-to-end RL for memory management (MemSearcher style): joint optimization of retrieval + storage + reasoning.

---

## 5. Is "Fully RL-Driven Memory" Realistic for an MCP Server?

### The Paper's Prediction

The paper predicts fully RL-driven memory as "the next major stage" with two properties:
1. No human-engineered priors (agent invents its own memory organization)
2. Complete lifecycle control (formation + evolution + retrieval integrated under RL)

### Reality Check for RecallNest (MCP Server Context)

**Structural constraint**: RecallNest operates as an external MCP server called by LLM agents. It does not control the LLM's weights or training process. This creates a fundamental architectural gap:

| Paper's Vision | RecallNest's Reality | Implication |
|---------------|---------------------|-------------|
| RL trains the agent's memory policy | RecallNest is a tool, not the agent | RecallNest can't train the calling LLM. It can only design better tools for the LLM to use. |
| End-to-end RL across memory lifecycle | MCP tools are discrete API calls | Each tool call is a separate decision by the LLM. No gradient flows through RecallNest. |
| Agent invents memory architecture | MCP server defines the schema | RecallNest defines what memory operations exist. The agent can only choose among them. |
| Latent memory tokens | MCP transmits text | RecallNest cannot inject latent representations into the LLM's reasoning stream. |

**What this means**: RecallNest will never be a "fully RL-driven memory system" in the paper's sense. That requires model-native integration (LoRA adapters, KV-cache manipulation, gradient-based optimization). An MCP server is architecturally external.

**However**, RecallNest can still capture significant value:

1. **Be the best possible tool for RL-capable agents**: As LLMs become RL-trained for memory management (Mem-alpha, MemSearcher), they need well-designed external memory tools. RecallNest should provide the richest, most flexible tool interface.

2. **Server-side intelligence without RL**: Even without RL, RecallNest can implement sophisticated heuristics on the server side:
   - Importance scoring for memories
   - Conflict detection during updates
   - Temporal-aware retrieval with decay functions
   - Automatic consolidation of related memories
   - Proactive forgetting of low-value entries

3. **Prepare for model-native integration**: When future LLMs expose hooks for external memory systems to inject into their reasoning (KV-cache APIs, latent memory injection), RecallNest should be architecturally ready to plug in. This means:
   - Keep memory representations rich enough to be converted to latent tokens
   - Maintain structured metadata that could inform a retrieval reranker
   - Design the API to support streaming/incremental operations, not just request-response

### Bottom Line

The "fully RL-driven" vision is **not realistic for an MCP server in its current architectural form**. But it is realistic for RecallNest to be the **best external memory system** that RL-trained agents want to use. The key insight is: as agents get smarter about memory management via RL, they need **richer, more capable external memory stores** -- not simpler ones. The demand for sophisticated MCP memory servers increases, not decreases, in an RL-driven world.

---

## 6. Summary Table: All RL Memory Systems

| System | RL Algorithm | Memory Op Optimized | Reward Signal | Stage |
|--------|-------------|-------------------|---------------|-------|
| RMM | Policy gradient | Retrieval reranking | Task accuracy | Partial |
| Mem-alpha | RL policy learning | Formation + updating | Task performance | Partial |
| Memory-R1 | RL (R1-family) | Fusion + filtering | QA correctness | Partial |
| MemGen | RL + SFT | Latent formation + retrieval timing | Multi-task performance | Partial |
| Context Folding | RL | Working memory folding | Research/SWE performance | Partial |
| Memory-as-Action | RL | Context compression | Multi-obj QA | Partial |
| MemSearcher | SFT + RL (E2E) | Reasoning + search + memory | Multi-hop QA | Partial |
| Mem1 | PPO | Summarization | QA + retrieval accuracy | Partial |
| MemAgent | GRPO | Summarization | Doc QA | Partial |
| ReSum | RL | Summary-conditioned exploration | Web search performance | Partial |
| IterResearch | RL (MDP) | Workspace reconstruction | Long-horizon QA | Partial |
| Memento | Q-learning | Trajectory selection | Answer contribution probability | Partial |
| SUMER | RL | QA summarization | QA accuracy | Partial |
| AgentEvolver | RL | Architecture evolution | Task performance | Partial |
| (Fully RL-driven) | -- | All operations | -- | **Does not exist yet** |

---

## 7. Key Quotes from the Paper

> "Memory, as one of the foundational components of agentic capability, follows a similar trend from pipeline-based to model-native paradigm." (p.71)

> "Mem-alpha delegates the entire process of memory construction to an agent trained with RL, and Memory-R1 employs a similar philosophy." (p.71)

> "Mem-alpha automates certain aspects of memory writing yet still relies on manually defined retrieval pipelines, whereas systems such as MemSearcher focus primarily on short-term working memory without addressing long-term consolidation or evolution." (p.72)

> "A fully agentic memory system would require the agent to autonomously handle multi-granular memory formation, memory evolution, and memory retrieval in an integrated manner. Achieving this level of control will almost certainly require end-to-end RL training, since heuristic or prompt-based methods are insufficient for coordinating the complex interactions among these components across long-time horizons." (p.72)

> "The agent is encouraged to design new memory formats, storage schemas, or update rules through RL incentives, enabling memory architectures that are adaptive and creative rather than handcrafted." (p.72)
