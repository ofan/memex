# Research Brief: Data Quality & Memory Consolidation
**Date:** 2026-04-12
**Context:** Memex retrieval pipeline is near-ceiling (94% E2E). Bottleneck has shifted to data quality (76% low-quality session imports). This research informs session import v2 and dreaming reflection.

---

## 1. Competitive Landscape Update

### Memex is no longer sole SOTA on LongMemEval

| System | E2E (GPT-4o) | E2E (best reader) | Architecture |
|---|---|---|---|
| **Mastra OM** | 84.23% | **94.87% (GPT-5-mini)** | Append-only observation log, no RAG |
| **Memex** | **94%** | 94% (GPT-4o) | Hybrid retrieval + reranking |
| HyperMem | — | 92.73% (LoCoMo) | Hypergraph: topic/episode/fact hierarchy |
| Hindsight/TEMPR | 91.4% | 91.4% | 4-network (world/bank/opinion/observation) |
| MemMachine | — | 91.69% (LoCoMo) | Sentence-level episode indexing |
| Zep/Graphiti | 63.8% | — | Temporal knowledge graph (Neo4j) |
| Mem0 | 49% | — | Flat fact store + graph layer |

**Key observation:** Mastra's Observational Memory sidesteps RAG entirely — two background agents (Observer + Reflector) compress history into a stable context window. Architecturally very different from memex. On GPT-4o specifically, memex still leads (94% vs 84.23%), but the headline SOTA with GPT-5-mini (94.87%) has been taken.

### New benchmarks
- **LoCoMo**: 300-turn, 9K-token conversations, becoming second standard alongside LongMemEval
- **MemBench** (2025): extraction, multi-hop, knowledge update, preference, temporal reasoning
- **10M-token benchmark** (2026): contradiction resolution, event ordering

### New models worth evaluating
- **EmbeddingGemma-300M** (Google): best-in-class sub-500M, MRL truncation (768→128 dims), <200MB RAM quantized
- **Contextual AI Reranker v2** (1B/2B/6B): instruction-following, +35% recency-awareness, open-source
- **Voyage rerank-2.5**: instruction-following, 32K context
- **ZeroEntropy zerank-2**: instruction-based, calibrated scores, 40x cheaper than Cohere

---

## 2. Conversation Extraction SOTA

### How systems extract knowledge from conversations

| System | What | How | When | Model |
|---|---|---|---|---|
| **Mem0** | Atomic typed facts | Two-phase: LLM→JSON facts, then vector-match against existing store, LLM decides ADD/UPDATE/DELETE/NOOP | Synchronous at add-time | GPT-4o/Claude |
| **Letta** | "Learned context" blocks | Lightweight incremental edits during conversation; sleep-time subagent for batch consolidation | Hybrid (real-time + sleep) | Frontier |
| **Zep/Graphiti** | Entity-relation triples with temporal validity | Sliding window (n=4 messages) for NER context, bi-temporal model | Incremental at ingestion | GPT-4o |
| **Hindsight** | Narrative units across 4 networks | "Coarse chunking" by topic/turn boundaries (not fixed windows) | Batch | 20B open-source |

### Key lessons

1. **Mem0's defaults produce 97.8% junk** (GitHub issue #4573). Custom extraction prompts with few-shot examples and negative cases are essential.
2. **Narrative chunking > fixed windows.** Hindsight chunks by topic boundaries, preserving cross-turn reasoning. Memex's current session import uses tiny sliding windows (3 turns, stride 2, 500 char truncation) — worst of all approaches.
3. **Small models (< 7B) are not viable** for extraction without task-specific fine-tuning. All production systems use frontier models.
4. **Hybrid is consensus:** incremental extraction for real-time + batch consolidation for cleanup. For memex's session import backlog, batch-only is fine.
5. **Two-phase pipeline is proven:** extract first, then dedupe/merge against existing store. Don't try to do both in one pass.

### Recommended extraction pipeline for session import v2

```
Sessions → narrative chunking (topic boundaries) → LLM extraction (JSON facts)
  → vector-match against existing memories → LLM decides ADD/UPDATE/NOOP
  → store with provenance metadata (sessionKey, agentId, source)
```

---

## 3. Memory Consolidation & Reflection

### Proven mechanisms (ordered by implementation feasibility)

#### 1. Stanford Generative Agents — threshold-triggered question synthesis
**Trigger:** cumulative importance of recent un-reflected memories exceeds threshold.
**Mechanism:** Send ~100 recent memories to LLM → generate 3 most salient questions → retrieve relevant memories per question → synthesize insight statements → store insights as new memories with importance scores.
**Why it fits memex:** Already has importance scores and recall counts. Clean, testable, directly implementable.

#### 2. Graphiti — bi-temporal contradiction detection
**Mechanism:** New facts trigger semantic search against existing facts. Contradictions resolved using temporal metadata — old edges invalidated (not deleted), preserving history.
**Why it fits memex:** Maps to `superseded_by` field rather than deletion. Bi-temporal validity concept aligns with existing timestamp + importance decay.

#### 3. A-MEM — Zettelkasten-style memory evolution
**Mechanism:** On insertion, find nearest neighbors via embedding similarity, LLM decides which to link. "Memory evolution" module revisits linked neighbors and updates context fields.
**Why it fits memex:** Goes beyond textual dedup to semantic consolidation. During reflection, retrieve clusters of similar memories → ask LLM whether any should be merged, updated, or linked.

#### 4. Letta — sleep-time defragmentation
**Mechanism:** Background subagent rewrites raw context into "learned context." Separate "defrag subagent" refactors bloated blocks, removing redundancies.
**Why it fits memex:** Dreaming reflection phase is already structured for this (`src/dreaming.ts` line 249). A reflection subagent reads low-recall memories and produces synthesized learnings.

### Recommended reflection implementation order
1. **Stanford-style question synthesis** — simplest, proven, testable
2. **Contradiction detection** via pairwise comparison of thematically clustered memories
3. **Memory evolution** — updating stale memories with new context (not just decaying)

---

## 4. Implications for Memex Roadmap

### Session import v2 (plan 003)
- **Use narrative chunking** (topic boundaries), not fixed windows or bin-packing
- **Use frontier model** for extraction (user's configured LLM, not local small model)
- **Two-phase pipeline**: extract → dedupe against existing store
- **Custom extraction prompt** with few-shot examples — critical to avoid Mem0's junk problem
- **Measure with domain-specific gold set** (fact precision + recall)

### Dreaming reflection (plan 012 step 8)
- **Start with Stanford-style question synthesis** — threshold trigger, 3 questions, retrieve + synthesize
- **Add contradiction detection** as second pass — find semantically similar memories, check temporal consistency
- **Store insights as first-class memories** with `category: "learning"`, high importance

### Model evaluation
- **Bakeoff EmbeddingGemma-300M** — potential 10x smaller embedding model with comparable quality
- **Bakeoff Contextual AI Reranker v2** — instruction-following could help temporal queries
- **Consider adding LoCoMo** as second benchmark for broader coverage

### Competitive positioning
- Memex leads on GPT-4o (94% vs Mastra's 84.23%)
- Mastra's no-RAG architecture is interesting but fundamentally different — requires large context windows
- HyperMem's hypergraph hierarchy (topic → episode → fact) is worth studying for potential retrieval improvements
- Mem0 (49%) and Zep (63.8%) are not competitive on LongMemEval

---

## Sources

- [Mastra Observational Memory](https://mastra.ai/research/observational-memory)
- [Letta Sleep-Time Compute](https://www.letta.com/blog/sleep-time-compute)
- [Mem0 Research (ECAI 2025)](https://arxiv.org/html/2504.19413v1)
- [Mem0 Junk Issue #4573](https://github.com/mem0ai/mem0/issues/4573)
- [Graphiti (arXiv:2501.13956)](https://arxiv.org/abs/2501.13956)
- [Hindsight (arXiv:2512.12818)](https://arxiv.org/abs/2512.12818)
- [A-MEM (arXiv:2502.12110)](https://arxiv.org/abs/2502.12110)
- [HyperMem (arXiv:2604.08256)](https://arxiv.org/abs/2604.08256)
- [MemMachine (arXiv:2604.04853)](https://arxiv.org/html/2604.04853)
- [Generative Agents (Park et al., 2023)](https://arxiv.org/abs/2304.03442)
- [EmbeddingGemma-300M](https://huggingface.co/google/embeddinggemma-300m)
- [Contextual AI Reranker v2](https://contextual.ai/blog/rerank-v2)
