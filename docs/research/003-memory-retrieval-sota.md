# State-of-the-Art Algorithms for Conversational Memory Retrieval and Ranking

**Date:** 2026-03-15
**Context:** memex unified recall pipeline — architectural research for merging heterogeneous sources (short memory facts + long documents) under a single ranking framework

---

## Table of Contents

1. [Survey of Memory Retrieval Systems](#1-survey-of-memory-retrieval-systems)
2. [Ranking and Fusion Algorithms for Heterogeneous Sources](#2-ranking-and-fusion-algorithms-for-heterogeneous-sources)
3. [Minimizing API Calls: Adaptive Retrieval Strategies](#3-minimizing-api-calls-adaptive-retrieval-strategies)
4. [Score Normalization and Multi-Source Merging](#4-score-normalization-and-multi-source-merging)
5. [Benchmarks and Evaluation Metrics](#5-benchmarks-and-evaluation-metrics)
6. [Analysis: What Fits Our Constraints](#6-analysis-what-fits-our-constraints)
7. [Recommended Algorithm Design](#7-recommended-algorithm-design)
8. [Proposed Benchmark Methodology](#8-proposed-benchmark-methodology)

---

## 1. Survey of Memory Retrieval Systems

### 1.1 Generative Agents (Park et al., 2023) — The Baseline Formula

The foundational memory scoring formula from the Stanford Generative Agents paper:

```
score(m, q) = alpha_rec * recency(m) + alpha_imp * importance(m) + alpha_rel * relevance(m, q)
```

where all alpha values = 1 in their implementation, and scores are min-max normalized to [0, 1] before combination. Importance is LLM-rated on a 1-10 scale.

**Limitations for our case:**
- Min-max normalization destroys scores for tightly clustered results (e.g., [0.92, 0.83, 0.79] becomes [1.0, 0.31, 0.0]). We already discovered this failure mode in our pipeline.
- Equal alpha weights are naive — no source-type awareness.
- LLM-rated importance requires an API call per memory at store time.

**Reference:** Park, J.S. et al. (2023). "Generative Agents: Interactive Simulacra of Human Behavior." UIST 2023. [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)

### 1.2 MemoryBank (Zhong et al., 2024) — Ebbinghaus Forgetting Curve

MemoryBank applies exponential decay based on the Ebbinghaus Forgetting Curve to modulate memory strength. Frequently accessed memories are reinforced; rarely accessed ones decay.

**Key formula:**
```
retention(m) = e^(-t / S(m))
```
where `S(m)` is the memory strength parameter that increases on each recall event. This creates a use-it-or-lose-it dynamic where important memories self-reinforce through access frequency.

**Relevance to our system:** Our 7-stage pipeline already has time decay (`score *= 0.5 + 0.5 * exp(-ageDays / halfLife)`) and recall frequency boost (`freqBoost = min(0.1, recallCount / 200)`). MemoryBank validates this direction but adds nothing new.

**Critical gap:** No mechanism to distinguish *permanent preferences* ("never say sorry") from *ephemeral facts* ("meeting at 3pm today"). Pure decay-based systems will eventually forget permanent preferences.

**Reference:** Zhong, W. et al. (2024). "MemoryBank: Enhancing Large Language Models with Long-Term Memory." AAAI 2024. [arXiv:2305.10250](https://arxiv.org/abs/2305.10250)

### 1.3 MemGPT / Letta (Packer et al., 2023) — Virtual Context Management

MemGPT treats memory as a paging system: main context (RAM) holds the working set; archival/recall storage (disk) holds everything else. The agent explicitly calls functions to page data in and out.

**Architecture:**
- Core Memory: always in context, compressed representation
- Recall Memory: searchable database (recent conversations)
- Archival Memory: long-term storage, retrieved on demand

**Relevance:** Our system is structurally similar — conversation memories and documents are "paged in" via the unified recall pipeline. MemGPT's key insight is that retrieval is a function the agent controls, not just a background process. We already implement this via the `recall` and `document_search` tools.

**Reference:** Packer, C. et al. (2023). "MemGPT: Towards LLMs as Operating Systems." [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)

### 1.4 Mem0 (Chadha et al., 2025) — Graph-Enhanced Memory with Entity Resolution

Mem0 is the most production-mature memory system. Its graph variant (Mem0^g) layers a knowledge graph over vector memory to capture entity relationships. Key retrieval approach: extract entities from query, find similar nodes via embedding search, rerank with BM25.

**Scoring approach:**
- Dual-strategy retrieval: entity-centric (find nodes, traverse relationships) + semantic triplet (dense embedding match against relationship triplets)
- Conflict detection: LLM-based update resolver marks obsolete relationships as invalid rather than deleting them, enabling temporal reasoning
- Performance: 66.9% accuracy (vector-only) vs 68.4% (graph-enhanced) on their benchmark; p95 latency 0.15s (vector) vs 0.48s (graph)

**Relevance:** The graph layer adds overhead (~3x latency) for modest accuracy gains (+1.5%). Not worth it for our scale (1900 memories). However, Mem0's *conflict detection* pattern — marking superseded facts rather than deleting them — is valuable for handling knowledge updates.

**Reference:** Chadha, T. et al. (2025). "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory." [arXiv:2504.19413](https://arxiv.org/abs/2504.19413)

### 1.5 Zep / Graphiti (Rasmussen, 2025) — Temporal Knowledge Graph

Zep's core innovation is Graphiti, a temporally-aware knowledge graph with **bitemporal tracking**: every node and edge has both *event time* (when the fact occurred) and *ingestion time* (when it was observed). This enables precise temporal reasoning including retroactive corrections.

**Architecture (3-tier graph):**
1. Episode subgraph: raw conversation episodes
2. Semantic entity subgraph: extracted entities and relationships
3. Community subgraph: high-level concept clusters

**Retrieval:** Hybrid BM25 + semantic embedding + graph traversal — no LLM calls during retrieval. P95 latency: 300ms.

**Benchmark results:**
- DMR benchmark: 94.8% (vs MemGPT 93.4%)
- LongMemEval: up to 18.5% accuracy improvement over baselines, 90% latency reduction

**Relevance:** Graphiti's bitemporal model is the correct solution for the "permanent preference vs ephemeral fact" problem. However, it requires Neo4j or similar graph database, which conflicts with our SQLite constraint. The *concept* of bitemporal tracking can be implemented in SQLite with two timestamp columns.

**Reference:** Rasmussen, P. (2025). "Zep: A Temporal Knowledge Graph Architecture for Agent Memory." [arXiv:2501.13956](https://arxiv.org/abs/2501.13956)

### 1.6 Hindsight / TEMPR (Deshpande et al., 2025) — Structured Entity-Temporal Memory

The current benchmark leader. TEMPR (Temporal Entity Memory Priming Retrieval) organizes memory into four logical networks: world facts, agent experiences, entity summaries, and evolving beliefs.

**Retain pipeline:** fact extraction -> embedding generation -> entity resolution -> link construction

**Recall pipeline (4 parallel searches):**
1. Semantic vector similarity
2. BM25 keyword matching
3. Graph traversal through shared entities
4. Temporal filtering for time-constrained queries

**Results:** 91.4% on LongMemEval. Multi-session questions improved from 21.1% to 79.7%; temporal reasoning from 31.6% to 79.7%.

**Relevance:** TEMPR's 4-way parallel search is directly applicable to our architecture. We currently do 2-way (conversation memories + documents). Adding entity-based traversal and explicit temporal filtering as additional retrieval channels is the most impactful architectural upgrade we could make.

**Reference:** Deshpande, A. et al. (2025). "Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects." [arXiv:2512.12818](https://arxiv.org/abs/2512.12818)

### 1.7 Observational Memory / Mastra (2026) — No-Retrieval Architecture

A radical departure: instead of per-query retrieval, two background agents (Observer + Reflector) continuously compress conversation history into timestamped, priority-ranked observations. No dynamic retrieval at all — just a stable context window with observations at the start and recent messages at the end.

**Key features:**
- Three-date temporal model: observation date, referenced date, relative date
- Priority ranking using emoji markers (critical / important / informational)
- 3-6x compression for text, 5-40x for tool-heavy workloads
- Context window is fully prompt-cacheable (huge latency/cost win)

**Results:** 94.87% on LongMemEval (gpt-5-mini), highest ever recorded. 84.23% with gpt-4o.

**Relevance:** This approach eliminates the retrieval problem entirely by keeping everything in a compressed observation log. However, it requires continuous LLM inference for the Observer/Reflector agents, which conflicts with our "minimize API calls" constraint. The *concept* of pre-computing compressed summaries at write-time (rather than retrieve-time) is valuable.

**Reference:** Mastra. (2026). "Observational Memory: 95% on LongMemEval." [mastra.ai/research/observational-memory](https://mastra.ai/research/observational-memory)

### 1.8 A-MEM (Xu et al., 2025) — Zettelkasten-Style Self-Organizing Memory

A-MEM treats each memory as a structured note with contextual descriptions, keywords, tags, and links to related notes — inspired by the Zettelkasten method. Memories autonomously evolve their content and relationships as new information arrives.

**Key innovation:** Memory *agency* — new experiences retroactively refine context/attributes of existing notes, enabling the memory graph to mirror human associative learning.

**Results:** NeurIPS 2025 poster. Superior improvement over baselines across six foundation models.

**Relevance:** The self-organizing aspect is interesting but requires LLM calls for each memory update. The *structured note* concept (contextual description + keywords + tags + links) could enhance our memory storage format at low cost by pre-computing these at store-time.

**Reference:** Xu, W. et al. (2025). "A-MEM: Agentic Memory for LLM Agents." NeurIPS 2025. [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)

### 1.9 MEM1 (Zhou et al., 2025) — RL-Trained Memory Consolidation

MEM1 uses reinforcement learning to train a 7B model to maintain a compact internal state across multi-turn interactions, learning which information to retain and which to discard.

**Results:** MEM1-7B improves performance 3.5x while reducing memory usage 3.7x compared to Qwen2.5-14B on 16-objective multi-hop QA.

**Relevance:** The RL-training approach is not applicable to our system (we use retrieval, not trained consolidation). However, the core insight — that *what to forget* is as important as *what to remember* — validates our time-decay and importance-weighting approach.

**Reference:** Zhou, R. et al. (2025). "MEM1: Learning to Synergize Memory and Reasoning for Efficient Long-Horizon Agents." [arXiv:2506.15841](https://arxiv.org/abs/2506.15841)

### 1.10 MemWalker (Chen et al., 2024) — Tree-Structured Navigation

MemWalker builds a hierarchical summary tree over long text, then navigates it with iterative LLM prompting to find relevant segments.

**Two-stage process:**
1. Build memory tree: split text into segments, summarize recursively
2. Navigate tree: LLM reasons about child summaries, descends to relevant segments, can backtrack

**Relevance:** Primarily designed for single long documents, not multi-source memory retrieval. Not applicable to our architecture.

**Reference:** Chen, H. et al. (2024). "Walking Down the Memory Maze: Beyond Context Limit through Interactive Reading." ICLR 2024. [arXiv:2310.05029](https://arxiv.org/abs/2310.05029)

### 1.11 Ensue (2026) — Open-Source Model Pipeline

Ensue built a competitive memory retrieval system using only open-source models, achieving 88% on LongMemEval (93% with GPT-5-mini).

**Key insight:** 88% accuracy comes from the architecture alone; the gap to 93% is what better models add. The pipeline uses embeddings, open-source language models, and a fine-tuned classifier for each retrieval phase.

**Relevance:** Validates that our open-source/local-inference approach can be competitive. The architecture matters more than the model.

**Reference:** Ensue. (2026). "How We Built a Competitive Memory Retrieval System using Open-Source Models." [ensue.dev/blog/beating-memory-benchmarks](https://ensue.dev/blog/beating-memory-benchmarks/)

---

## 2. Ranking and Fusion Algorithms for Heterogeneous Sources

### 2.1 RRF and Its Limitations

Our current system uses score-based fusion (vector score + BM25 boost), not true RRF. Standard RRF:

```
RRF(d) = SUM_r  1 / (k + rank_r(d))
```

where k = 60 (standard), and the sum is over all ranking lists r.

**Known limitations (2024-2025):**
1. **Information loss:** Discards absolute similarity scores. Two documents ranked #1 with scores 0.99 and 0.51 get identical RRF contribution.
2. **Hyperparameter sensitivity:** Optimal k varies per domain. The "parameter-free" claim is folklore.
3. **No source weighting:** Treats all ranking lists equally. A high-precision memory index and a noisy document search get the same weight.
4. **Latency cost:** Requires running all retrieval pipelines before fusion.

### 2.2 Weighted RRF

Extension that assigns per-list weights:

```
WRRF(d) = SUM_r  w_r / (k + rank_r(d))
```

Elasticsearch shipped this in 2025. Up to +6.4% nDCG@10 vs standard RRF on multimodal benchmarks. This is the simplest upgrade path from standard RRF.

**For our case:** `w_conversation = 0.6`, `w_document = 0.4` would give memory results more influence in the final ranking.

**Reference:** Elastic. (2025). "Weighted Reciprocal Rank Fusion (RRF) in Elasticsearch." [elastic.co/search-labs/blog/weighted-reciprocal-rank-fusion-rrf](https://www.elastic.co/search-labs/blog/weighted-reciprocal-rank-fusion-rrf)

### 2.3 HF-RAG: Hierarchical Fusion with Z-Score Standardization

HF-RAG (CIKM 2025) addresses exactly our problem: merging ranked lists from heterogeneous sources with incomparable score distributions.

**Two-stage process:**
1. **Intra-source fusion:** Within each source (memories, documents), fuse ranked lists from multiple IR models using standard RRF.
2. **Cross-source fusion:** Apply z-score standardization to each source's fused scores, then merge:

```
z_score(s, source) = (s - mean(scores_source)) / std(scores_source)
```

This maps each source's distribution to a standard normal, removing source-specific biases.

**Results:** Improves out-of-domain generalization by 3 pp in Macro F1. Consistently beats single-source and single-ranker baselines.

**Relevance:** Directly applicable. Our conversation pipeline produces scores with a different distribution than our document pipeline. Z-score normalization before cross-source merge is mathematically principled and cheap to compute.

**Reference:** HF-RAG (2025). "Hierarchical Fusion-based RAG with Multiple Sources and Rankers." [arXiv:2509.02837](https://arxiv.org/abs/2509.02837)

### 2.4 Learned Fusion (Learning-to-Rank)

Gradient Boosted Decision Trees (GBDT) as ranking models for multi-channel fusion. The query-dependent formulation learns non-linear feature interactions:

```
score(d, q) = GBDT(f_1(d,q), f_2(d,q), ..., f_n(d,q))
```

where features include: vector similarity, BM25 score, source type, document length, recency, importance, entity overlap, etc.

**Advantage:** Can learn that "short memory with high vector similarity" should beat "long document with high BM25 score" without explicit source-type boosting.

**Disadvantage:** Requires labeled training data (relevance judgments). We do not currently have this.

**Reference:** Alibaba (2025). "Unified Learning-to-Rank for Multi-Channel Retrieval." [arXiv:2602.23530](https://arxiv.org/html/2602.23530v3)

### 2.5 Cross-Encoder Reranking for Mixed-Length Results

Cross-encoders jointly encode (query, candidate) pairs with full attention, enabling nuanced relevance judgments. Key considerations for mixed-length content:

**Length bias problem:** Cross-encoders are biased toward longer documents because they contain more potential matching tokens. A 5000-word document mentioning "Alice" 34 times will score higher than a concise memory "TTS voice is Alice" even though the memory is more relevant.

**Mitigation strategies:**
1. **Truncation:** Truncate long documents to best-matching chunk before reranking. We already do this (`bestChunk`).
2. **Length-normalized reranking:** Divide cross-encoder score by log(length), similar to our length normalization stage.
3. **CMC (Comparing Multiple Candidates):** Process all candidates simultaneously via self-attention with Arrow Attention masking. Each candidate interacts with the query but not with other candidates.

**Practical recommendation:** Rerank the *bestChunk* from documents (not the full document), alongside the full text of short memories. This puts both sources on comparable footing for the cross-encoder.

### 2.6 Auxiliary Cross Attention Networks (ACAN)

Hong et al. (2025) proposed replacing the hand-tuned {recency, importance, relevance} weight combination with a learned cross-attention model trained using LLM-generated ground truth.

**Training approach:** The loss function penalizes deviations from LLM-generated "correct" memory selections, and the model learns to score memories based on context without manual weight tuning.

**Relevance:** Interesting research direction but requires training infrastructure. Could be approximated by collecting recall-quality labels over time and training a simple logistic regression or GBDT model offline.

**Reference:** Hong, W. et al. (2025). "Enhancing memory retrieval in generative agents through LLM-trained cross attention networks." Frontiers in Psychology. [DOI:10.3389/fpsyg.2025.1591618](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1591618/full)

---

## 3. Minimizing API Calls: Adaptive Retrieval Strategies

### 3.1 Query Classification: Skip Retrieval Entirely

Our `adaptive-retrieval.ts` already classifies queries as greetings/commands and skips retrieval. The research validates this:

**Adaptive-RAG (2024):** Classifies queries into three tiers:
1. **No retrieval needed:** Simple greetings, commands, general knowledge
2. **Single retrieval sufficient:** Factual questions with clear keywords
3. **Iterative retrieval required:** Complex, multi-hop queries

We implement tier 1 (skip). Adding tier 2/3 distinction could save a reranker call on simple queries.

**Reference:** Jeong, S. et al. (2024). "Adaptive-RAG: Learning to Adapt Retrieval-Augmented Large Language Models." NAACL 2024.

### 3.2 Source Routing: Skip Irrelevant Sources

**RAGRouter (2025):** Predicts which retrieval source is most useful for a given query before executing any retrieval. For our case:

- Queries about user preferences/decisions -> conversation memory only
- Queries about file contents/documentation -> documents only
- Ambiguous queries -> both sources

**Implementation:** A lightweight classifier (even regex + heuristics) can route queries. Example heuristics:
- Contains "my preference", "I said", "I want" -> memory-only
- Contains "in the file", "documentation says", "config" -> document-only
- Default -> both

**Estimated savings:** Skip document search for ~30-40% of queries, saving ~200ms each.

**Reference:** RAGRouter (2025). "Query Routing for Retrieval-Augmented Language Models." [arXiv:2505.23052](https://arxiv.org/abs/2505.23052)

### 3.3 Confidence-Based Reranker Gating

**When to skip the cross-encoder reranker:**

Research identifies two conditions where reranking adds no value:
1. **High confidence gap:** Top result score >> second result score. The ranking is already clear.
2. **Low ambiguity:** All candidate texts are very similar (near-duplicates). Reranking cannot distinguish them.

**Proposed formula:**
```
skip_rerank = (score_1 - score_2 > gap_threshold)  OR  (score_1 > high_threshold)
```

With gap_threshold = 0.15, high_threshold = 0.9.

Optimal configurations use a high upper threshold (~0.9) coupled with a low lower threshold (~0.1-0.4).

**Estimated savings:** Skip reranker for ~20-30% of queries where top result is clearly dominant, saving ~53ms each.

### 3.4 Early Termination (Already Implemented)

Our `earlyTermination` config option already implements this: skip document search when all conversation results score above `highConfidenceThreshold` (0.6). The research validates this approach.

**Enhancement opportunity:** Make it bidirectional — also skip conversation memory search when the query is clearly document-oriented (e.g., "what's in REQUIREMENTS.md").

---

## 4. Score Normalization and Multi-Source Merging

### 4.1 Why Min-Max Normalization Fails

We already discovered this empirically and documented it in `unified-recall.ts`:

> "Min-max normalization was destroying scores for tightly clustered results
> (e.g., [0.92, 0.83, 0.79] -> [1.0, 0.31, 0.0] which is wrong)."

The theoretical basis: score distributions from different retrieval systems follow different statistical models. BM25 scores follow a normal-exponential mixture, while vector cosine similarity scores cluster near the model's inherent similarity floor (~0.3-0.5 for most embedding models). Min-max normalization assumes uniform distributions, which is violated by both.

**Reference:** Manmatha, R. et al. (2001). "Modeling score distributions in information retrieval." Information Retrieval, 4(3), 191-213. [DOI:10.1007/s10791-010-9145-5](https://link.springer.com/article/10.1007/s10791-010-9145-5)

### 4.2 Z-Score Normalization (Recommended Upgrade)

Z-score normalization accounts for the distribution shape:

```
normalized(s) = (s - mean(S)) / std(S)
```

**Advantages over min-max:**
- Robust to outliers (a single very high/low score does not distort others)
- Preserves relative spacing between scores
- Works well for approximately normal distributions (which BM25 and cosine similarity approximate)

**Disadvantage:** Produces unbounded scores. Needs a final sigmoid or clamp to [0, 1].

**For our case:** Apply z-score normalization within each source, then rescale to [0, 1] with a sigmoid:

```
calibrated(s) = sigmoid(z_score(s)) = 1 / (1 + exp(-z_score(s)))
```

This maps z=0 (average score) to 0.5, z=2 (strong result) to ~0.88, z=-2 (weak result) to ~0.12.

### 4.3 CDF-Based Calibration

A more principled approach: transform scores through the cumulative density function of their known distribution.

For cosine similarity (approximately normally distributed around a corpus-specific mean):
```
calibrated(s) = Phi((s - mu_corpus) / sigma_corpus)
```

where Phi is the standard normal CDF. This requires knowing the corpus statistics, which we can compute offline.

For BM25 (approximately gamma-distributed):
```
calibrated(s) = F_gamma(s; alpha, beta)
```

**Advantage:** Maps scores to a uniform [0, 1] distribution that represents *percentile rank* — a 0.8 means "better than 80% of all possible results." This makes scores from different sources directly comparable.

**Disadvantage:** Requires corpus-level statistics (mean, std for vector; alpha, beta for BM25). These drift as the corpus grows.

### 4.4 Rank-Based Fusion (RRF) as Normalization

RRF sidesteps the normalization problem entirely by using only rank information:

```
RRF(d) = SUM_r  1 / (k + rank_r(d))
```

This is maximally robust to score distribution differences but loses magnitude information. A document with score 0.99 and rank 1 is treated identically to a document with score 0.51 and rank 1.

**For our case:** RRF is a reasonable default when we cannot trust score magnitudes. However, we *can* trust them within each source (our conversation pipeline produces calibrated scores through the 7-stage pipeline). So score-based fusion with z-score normalization is better.

### 4.5 Recommended Normalization Strategy

Combine z-score normalization with source-weighted merge:

```
final_score(d) = w_source * sigmoid(z_score(d, source)) + w_type * type_bonus(d)
```

where:
- `w_source` = source weight (conversation: 0.55, document: 0.45)
- `sigmoid(z_score(...))` = calibrated score within source
- `w_type` = type-specific bonus weight
- `type_bonus` = bonus for concise, direct memories over long document chunks

---

## 5. Benchmarks and Evaluation Metrics

### 5.1 LongMemEval (ICLR 2025)

The most comprehensive benchmark for agent memory. 500 questions across 6 categories:

| Category | Description |
|----------|-------------|
| Information Extraction | Recall facts from a session |
| Single-Session-User | Context mentioned by the user |
| Single-Session-Assistant | Context mentioned by the assistant |
| Preference Extraction | Implicit user preferences |
| Multi-Session Reasoning | Aggregation across sessions |
| Knowledge Update | Correct adaptation to changed information |

**Key difficulty:** 115k tokens of chat history per question, 30-40 sessions.

**Current SOTA scores (LongMemEval_S):**
- Observational Memory (Mastra) + gpt-5-mini: 94.87%
- Hindsight (TEMPR) + Gemini-3-Pro: 91.4%
- Ensue + open-source models: 88%
- Supermemory + GPT-4o: 81.6%
- Mem0: 66.9% (vector), 68.4% (graph)

**Reference:** Wu, X. et al. (2024). "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory." ICLR 2025. [arXiv:2410.10813](https://arxiv.org/abs/2410.10813)

### 5.2 LoCoMo (NAACL 2024)

Evaluates QA, event summarization, and dialogue generation across long conversations. Subtypes:
- Single-hop QA (intra-session)
- Multi-hop QA (cross-session)
- Temporal reasoning (date/order/interval)
- Open-domain
- Adversarial (unanswerable)

**Key insight:** Temporal QA is the hardest category — most systems score 20-40% below other categories.

**Reference:** Maharana, A. et al. (2024). "Evaluating Very Long-Term Conversational Memory of LLM Agents." [arXiv:2402.17753](https://arxiv.org/abs/2402.17753)

### 5.3 Mem0 Research Benchmark

Custom benchmark emphasizing production scenarios: 66.9% baseline (vector-only), 68.4% with graph memory. The modest improvement suggests that graph structure helps but is not transformative for simple fact retrieval.

**Reference:** [mem0.ai/research](https://mem0.ai/research)

### 5.4 Memory-Specific Metrics (Beyond IR)

Standard IR metrics (nDCG, MRR, Recall@k) are necessary but insufficient for memory systems. Additional metrics that capture memory-specific quality:

| Metric | Description | Standard IR Equivalent |
|--------|-------------|----------------------|
| **Temporal Accuracy** | Did the system return the *current* version of a fact that has been updated? | None (IR assumes static corpus) |
| **Source Attribution Accuracy** | Did the system correctly identify whether a fact came from memory vs document? | None |
| **Abstention Rate** | Does the system correctly decline when asked about something never discussed? | Precision at zero recall |
| **Knowledge Update Lag** | How quickly does the system reflect a corrected/updated fact? | None |
| **Preference Consistency** | Does the system consistently recall permanent preferences across sessions? | None |
| **Cross-Session Reasoning** | Can the system connect facts from different sessions? | Multi-hop QA accuracy |

### 5.5 Custom Benchmark Design for memex

Given our specific needs (short facts + long documents + temporal awareness), we should build a benchmark with these categories:

1. **Direct Memory Recall:** "What voice do I use for TTS?" -> "Alice" (from memory)
2. **Document Retrieval:** "What does REQUIREMENTS.md say about embedding?" -> (from document)
3. **Source Priority:** "What is my TTS voice?" where both memory says "Alice" and a document mentions "Alice" 34 times -> memory should rank higher
4. **Temporal Correctness:** After updating "TTS voice is now Koda", the old answer "Alice" should not appear first
5. **Permanent Preference:** After 90 days of not mentioning it, "never say sorry" should still be retrievable
6. **Abstention:** "What is my favorite color?" (never discussed) -> should return no confident result

---

## 6. Analysis: What Fits Our Constraints

### Constraint Summary

| Constraint | Value |
|-----------|-------|
| Database | SQLite + FTS5 + sqlite-vec |
| Latency budget | < 500ms total pipeline |
| Embedding | Local via llama.cpp (Qwen3-Embedding, ~83ms uncached) |
| Reranker | Local via llama.cpp (bge-reranker-v2-m3, ~53ms for 5 docs) |
| LLM calls at query time | Zero (too slow/expensive for retrieval path) |
| Memory count | ~1900 memories, ~450 documents |
| Build system | None (TypeScript loaded via jiti) |

### Algorithm Compatibility Matrix

| System | Fits Constraints? | Key Blocker |
|--------|-------------------|-------------|
| Generative Agents formula | Yes (trivially) | Naive weights, min-max normalization |
| MemoryBank (Ebbinghaus) | Yes | Already implemented via time decay |
| MemGPT (paging) | Partially | Agent-controlled paging adds complexity |
| Mem0^g (graph) | No | Requires graph database (Neo4j) |
| Zep/Graphiti (temporal KG) | No | Requires Neo4j, bitemporal adds schema complexity |
| Hindsight/TEMPR (4-way search) | **Yes** | Entity resolution at store-time only |
| Observational Memory | No | Requires continuous LLM inference |
| A-MEM (Zettelkasten) | Partially | LLM calls at store-time (not query-time) |
| MEM1 (RL-trained) | No | Requires RL training infrastructure |
| HF-RAG (z-score fusion) | **Yes** | Pure math, no dependencies |
| Weighted RRF | **Yes** | Simple formula change |
| Learned fusion (GBDT) | **Partially** | Needs labeled data; could bootstrap |
| ACAN (learned scoring) | No | Needs training infrastructure |

### Recommended Picks

**Immediate (no new dependencies):**
1. Z-score normalization for cross-source merging (HF-RAG approach)
2. Weighted RRF as alternative to score-based fusion
3. Source routing heuristics to skip irrelevant sources
4. Confidence-based reranker gating

**Medium-term (modest effort):**
5. TEMPR-style entity extraction at store-time for entity-aware retrieval
6. Bitemporal columns (event_time, ingestion_time) in memory schema
7. Memory durability classification (permanent / transient / ephemeral)

**Long-term (significant effort):**
8. Learned fusion model trained on collected relevance labels
9. Custom LongMemEval-style benchmark

---

## 7. Recommended Algorithm Design

### 7.1 Proposed Architecture: TEMPR-Lite

A simplified version of Hindsight's TEMPR adapted for our SQLite-based system.

#### Storage Enhancements

Add columns to memory table:
```sql
ALTER TABLE memories ADD COLUMN durability TEXT DEFAULT 'transient';
  -- 'permanent': preferences, rules, identity facts (no time decay)
  -- 'transient': facts that may change (normal time decay)
  -- 'ephemeral': time-bounded facts (aggressive time decay)

ALTER TABLE memories ADD COLUMN entities TEXT DEFAULT '[]';
  -- JSON array of extracted entity names, computed at store-time

ALTER TABLE memories ADD COLUMN event_time INTEGER;
  -- When the fact actually occurred/was stated (may differ from store time)
```

Durability classification can be done at store-time using the existing importance scoring heuristics:
- importance >= 0.9 and category in ("preference", "rule", "identity") -> permanent
- importance <= 0.3 or contains temporal markers ("today", "this week") -> ephemeral
- everything else -> transient

#### Retrieval Pipeline: 3-Channel Parallel Search

```
Query
  |
  +--[Source Router]--+
  |                   |
  v                   v
[Conv Memory]    [Documents]    (skip one if router is confident)
  |                   |
  +--- vector ---|    +--- vector ---|
  +--- BM25 ----|    +--- BM25 ----|
  +--- entity --|    +--- FTS5 ----|
  |                   |
  [Intra-source       [Intra-source
   RRF fusion]         RRF fusion]
  |                   |
  [Z-score            [Z-score
   normalize]          normalize]
  |                   |
  +-------Merge-------+
          |
  [Source-weighted combine]
          |
  [Durability-aware time decay]
          |
  [Confidence gate: rerank?]
          |
  [Cross-encoder rerank] (if needed)
          |
  [Final top-k]
```

#### Mathematical Formulation

**Stage 1: Intra-source fusion (per source)**

For conversation memories, fuse vector and BM25 using weighted combination (current approach works well):
```
fused_conv(m, q) = sim_vec(m, q) + 0.15 * sim_vec(m, q) * I_bm25(m, q)
```

For documents, use weighted RRF across vector, BM25, and section-level FTS:
```
fused_doc(d, q) = SUM_r  w_r / (60 + rank_r(d))
```

**Stage 2: Cross-source calibration (z-score + sigmoid)**

```
calibrated(s, S) = sigmoid( (s - mean(S)) / max(std(S), epsilon) )
```

where S is the set of all scores from the same source, and epsilon = 0.01 to prevent division by zero.

**Stage 3: Source-weighted merge**

```
final(r) = w_src(r) * calibrated(r) + bonus(r)
```

where:
```
w_src = 0.55  if source = conversation
        0.45  if source = document

bonus = 0.05  if source = conversation AND len(text) < 200  (concise fact bonus)
        0.0   otherwise
```

**Stage 4: Durability-aware time decay**

Replace the current uniform time decay with durability-specific decay:
```
decay(r) = case durability(r):
  permanent:  1.0  (no decay)
  transient:  0.5 + 0.5 * exp(-age_days / 60)   (current formula)
  ephemeral:  0.5 + 0.5 * exp(-age_days / 7)    (aggressive: 1-week half-life)
```

**Stage 5: Confidence-gated reranking**

```
skip_rerank = (score_1 - score_2 > 0.15) OR (score_1 > 0.9 * w_src)

if not skip_rerank:
  reranked_score = 0.6 * cross_encoder(q, r) + 0.4 * final(r)
```

### 7.2 Source Router (Heuristic)

```typescript
function routeQuery(query: string): "conversation" | "document" | "both" {
  const q = query.toLowerCase();

  // Document-only signals
  if (/\b(in the file|documentation|readme|config file|\.md|\.ts|\.json)\b/.test(q)) {
    return "document";
  }

  // Memory-only signals
  if (/\b(my preference|i said|i want|i told you|remember when|do i)\b/.test(q)) {
    return "conversation";
  }

  // Default: search both
  return "both";
}
```

### 7.3 Entity-Aware Retrieval (Future Enhancement)

At store-time, extract entity names from each memory:
```
"TTS voice is Alice" -> entities: ["TTS", "Alice"]
"Token budget is $200/week" -> entities: ["token budget"]
```

At query-time, extract query entities and add an entity-overlap signal:
```
entity_overlap(m, q) = |entities(m) INTERSECT entities(q)| / |entities(q)|
```

This can be implemented as a SQLite JSON query:
```sql
SELECT * FROM memories
WHERE json_each.value IN (SELECT value FROM json_each(?query_entities))
```

No graph database needed — just a JSON column and SQLite's json_each function.

### 7.4 Latency Budget

| Stage | Current (ms) | Proposed (ms) | Delta |
|-------|-------------|---------------|-------|
| Source routing | 0 | ~0.01 | +0.01 |
| Vector search (both) | ~33 | ~33 | 0 |
| BM25 search (both) | ~14 | ~14 | 0 |
| Entity lookup | 0 | ~2 | +2 |
| Intra-source fusion | ~0.1 | ~0.1 | 0 |
| Z-score calibration | 0 | ~0.01 | +0.01 |
| Cross-source merge | ~0.1 | ~0.1 | 0 |
| Time decay | ~0.01 | ~0.01 | 0 |
| Reranker (when needed) | ~53 | ~53 (70% of queries) | -16 avg |
| **Total** | **~250-300** | **~235-285** | **-15 avg** |

The proposed changes actually *reduce* average latency by skipping the reranker ~30% of the time, while improving ranking quality.

---

## 8. Proposed Benchmark Methodology

### 8.1 Test Suite Structure

Create a golden test set of query-answer pairs covering our specific failure modes:

```typescript
interface BenchmarkCase {
  id: string;
  query: string;
  // Expected results, ordered by expected rank
  expected: Array<{
    source: "conversation" | "document";
    textSubstring: string;  // substring that should appear in result
    mustRank: number;       // must be at or above this rank (1-indexed)
  }>;
  // Category for per-category metrics
  category: "direct_recall" | "document_retrieval" | "source_priority"
           | "temporal_correctness" | "permanent_preference" | "abstention";
}
```

### 8.2 Scoring Metrics

For each benchmark run, compute:

1. **Recall@k** (k=1,3,5,10): What fraction of expected results appear in top-k?
2. **nDCG@10**: Standard ranking quality metric.
3. **Source Priority Score:** When both sources match, does the expected source rank higher?
4. **Temporal Correctness:** For updated facts, does the new version rank above the old?
5. **Preference Persistence:** For permanent preferences, do they appear in top-3 even after simulated time passage?
6. **Abstention Rate:** For queries with no relevant memory, is the top score below threshold?
7. **API Call Efficiency:** How many embedding + reranker calls per query?
8. **Latency p50/p95/p99**

### 8.3 Test Data Generation

Populate the test database with controlled data:

1. **Memories (500):** Mix of preferences (50), rules (30), decisions (50), facts (200), ephemeral (170)
2. **Documents (50):** Mix of config files, task files, meeting notes, documentation
3. **Deliberately overlapping content:** Same entity mentioned in both memories and documents
4. **Temporal chains:** Facts that have been updated 2-3 times (to test knowledge update)
5. **Decoy documents:** Long documents that mention query keywords many times but are not the correct answer

### 8.4 Automated Regression

Run the benchmark on every change to the retrieval pipeline:

```bash
node --import jiti/register tests/benchmark-retrieval-quality.ts
```

Output a comparison table showing per-category scores before/after the change.

---

## Key Takeaways

1. **The field is converging on parallel multi-signal retrieval** (vector + BM25 + entity + temporal), not single-method search. Hindsight/TEMPR's 4-way search is the gold standard.

2. **Z-score normalization before cross-source merge** is the mathematically correct approach and directly addresses our tightly-clustered-scores problem. This is the single most impactful upgrade.

3. **Durability classification** (permanent / transient / ephemeral) solves the "preferences should not decay" problem without adding complexity to the time-decay formula.

4. **Source routing** and **confidence-gated reranking** can reduce average latency while improving quality by avoiding unnecessary work.

5. **The architecture matters more than the model.** Ensue achieves 88% on LongMemEval with open-source models, within 5 points of frontier-model systems. Our local-inference approach is not a handicap.

6. **Graph databases are not required.** Entity-aware retrieval can be implemented with SQLite JSON columns and entity extraction at store-time.

7. **Observational Memory's no-retrieval approach** is the most radical and highest-performing, but requires continuous LLM inference that conflicts with our constraints. The *concept* of pre-computing compressed summaries at write-time is worth borrowing.

---

## References

- Chadha, T. et al. (2025). "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory." [arXiv:2504.19413](https://arxiv.org/abs/2504.19413)
- Chen, H. et al. (2024). "Walking Down the Memory Maze." ICLR 2024. [arXiv:2310.05029](https://arxiv.org/abs/2310.05029)
- Cormack, G.V. et al. (2009). "Reciprocal rank fusion outperforms Condorcet." SIGIR 2009. [DOI:10.1145/1571941.1572114](https://dl.acm.org/doi/10.1145/1571941.1572114)
- Deshpande, A. et al. (2025). "Hindsight is 20/20." [arXiv:2512.12818](https://arxiv.org/abs/2512.12818)
- Elastic (2025). "Weighted RRF in Elasticsearch." [elastic.co](https://www.elastic.co/search-labs/blog/weighted-reciprocal-rank-fusion-rrf)
- Ensue (2026). "Competitive Memory Retrieval with Open-Source Models." [ensue.dev](https://ensue.dev/blog/beating-memory-benchmarks/)
- HF-RAG (2025). "Hierarchical Fusion-based RAG." CIKM 2025. [arXiv:2509.02837](https://arxiv.org/abs/2509.02837)
- Hong, W. et al. (2025). "Enhancing memory retrieval via LLM-trained cross attention networks." [DOI:10.3389/fpsyg.2025.1591618](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1591618/full)
- Maharana, A. et al. (2024). "Evaluating Very Long-Term Conversational Memory." [arXiv:2402.17753](https://arxiv.org/abs/2402.17753)
- Manmatha, R. et al. (2001). "Modeling score distributions in information retrieval." [DOI:10.1007/s10791-010-9145-5](https://link.springer.com/article/10.1007/s10791-010-9145-5)
- Mastra (2026). "Observational Memory." [mastra.ai/research](https://mastra.ai/research/observational-memory)
- Packer, C. et al. (2023). "MemGPT: Towards LLMs as Operating Systems." [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)
- Park, J.S. et al. (2023). "Generative Agents." UIST 2023. [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)
- Rasmussen, P. (2025). "Zep: Temporal Knowledge Graph Architecture." [arXiv:2501.13956](https://arxiv.org/abs/2501.13956)
- Wu, X. et al. (2024). "LongMemEval." ICLR 2025. [arXiv:2410.10813](https://arxiv.org/abs/2410.10813)
- Xu, W. et al. (2025). "A-MEM: Agentic Memory for LLM Agents." NeurIPS 2025. [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)
- Zhong, W. et al. (2024). "MemoryBank." AAAI 2024. [arXiv:2305.10250](https://arxiv.org/abs/2305.10250)
- Zhou, R. et al. (2025). "MEM1." [arXiv:2506.15841](https://arxiv.org/abs/2506.15841)
- MemEngine (2025). "Unified and Modular Library." WWW 2025. [arXiv:2505.02099](https://arxiv.org/abs/2505.02099)
- PAMU (2025). "Preference-Aware Memory Update." [arXiv:2510.09720](https://arxiv.org/abs/2510.09720)
