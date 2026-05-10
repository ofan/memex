# State-of-the-Art Algorithms for Conversational Memory Retrieval and Ranking

**Last updated:** 2026-04-27 (consolidated from March 2026 SOTA review + April 2026 independent re-survey)
**Context:** memex unified recall pipeline — architectural research for merging heterogeneous sources (short memory facts + long documents) under a single ranking framework, with attention to the field's reproducibility crisis and benchmark-shape problems documented in April 2026.

This is the canonical SOTA reference for memex. Replaces and consolidates the prior March 2026 doc and the April 2026 standalone research log.

---

## Table of Contents

1. [Survey of Memory Retrieval Systems](#1-survey-of-memory-retrieval-systems)
2. [Ranking and Fusion Algorithms for Heterogeneous Sources](#2-ranking-and-fusion-algorithms-for-heterogeneous-sources)
3. [Minimizing API Calls: Adaptive Retrieval Strategies](#3-minimizing-api-calls-adaptive-retrieval-strategies)
4. [Score Normalization and Multi-Source Merging](#4-score-normalization-and-multi-source-merging)
5. [Benchmarks and Evaluation Metrics](#5-benchmarks-and-evaluation-metrics)
6. [Analysis: What Fits Our Constraints](#6-analysis-what-fits-our-constraints)
7. [Memory Governance and Security (added Apr 2026)](#7-memory-governance-and-security)
8. [Multi-Agent Memory (added Apr 2026)](#8-multi-agent-memory)
9. [Production Deployment Realities (added Apr 2026)](#9-production-deployment-realities)
10. [Recommended Algorithm Design for memex](#10-recommended-algorithm-design-for-memex)
11. [Concrete actions for memex, ordered by ROI](#11-concrete-actions-for-memex-ordered-by-roi)

---

## Headline shifts since March 2026

- **Mem0 jumped from 49% to 93.4% on LongMemEval** via parallel multi-signal fusion (semantic + keyword + entity). Memex is on the same trend.
- **Vendor benchmark numbers cannot be trusted at face value.** Three Mem0 LongMemEval scores in the public record (49% / 93.4% / 29.07%); Zep dispute (84% → 58.44% → 75.14%); MemPalace's "100%" was three post-hoc patches against a non-held-out set.
- **Long-context beats memory systems on raw accuracy** by 33–35pp. Memory's win is *cost amortization past ~10 turns*, not accuracy.
- **On causally-dependent agentic tasks, memory tools fail.** MemoryArena, MEMTRACK, and AMA-Bench all converge: external memory loses to long-context. Letta themselves report a raw-text-filesystem memory beats their specialized stack on some tasks.
- **WorldDB introduced executable graph semantics** (Apr 21, 2026): recursive worlds + content-addressed immutable nodes + edges that execute on insert/delete/query-rewrite. Self-reports 96.40% LongMemEval.
- **RL for memory operations is no longer "emerging"** — 5 primary papers + ICLR 2026 workshop. Reward models cap supervision at ~64K tokens.
- **Memory governance and attacks** are now a real sub-field with 6 attack papers and 84.30% attack success rate on Agent Security Bench.
- **Production deployment** has joined the conversation: P99 SLOs, dual-layer hot/cold path, sub-100ms cold-path retrieval as the operational target.

---

## 1. Survey of Memory Retrieval Systems

### 1.1 Generative Agents (Park et al., 2023) — the baseline formula [older context]

```
score(m, q) = alpha_rec * recency(m) + alpha_imp * importance(m) + alpha_rel * relevance(m, q)
```

Min-max normalized, equal weights, LLM-rated importance. Limitations: min-max destroys tightly-clustered scores; equal weights lack source-type awareness; LLM importance per memory at store time is too costly. Memex's pipeline supersedes this.

**Reference:** Park, J.S. et al. (2023). UIST 2023. [arXiv:2304.03442](https://arxiv.org/abs/2304.03442)

### 1.2 MemoryBank (Zhong et al., 2024) — Ebbinghaus forgetting curve [older context]

```
retention(m) = e^(-t / S(m))
```

Validates memex's existing time decay (`score *= 0.5 + 0.5 * exp(-ageDays / halfLife)`) and recall-frequency boost. Critical gap: pure decay doesn't distinguish *permanent preferences* from *ephemeral facts*.

**Reference:** Zhong, W. et al. (2024). AAAI 2024. [arXiv:2305.10250](https://arxiv.org/abs/2305.10250)

**Apr 2026 update — FadeMem.** Operationalizes Ebbinghaus with concrete half-lives (LML 11.25d, SML 5.02d) and reports **45% storage savings vs Mem0**. Memex's decay is currently ad-hoc; FadeMem-style explicit half-lives are an upgrade path. [https://co-r-e.com/method/agent-memory-forgetting](https://co-r-e.com/method/agent-memory-forgetting); FSFM `arXiv:2604.20300`.

### 1.3 MemGPT / Letta (Packer et al., 2023) — virtual context management

Memory as paging system: Core Memory (always in context), Recall Memory (recent, searchable), Archival Memory (long-term, on-demand). Memex's `recall` and `document_search` tools are structurally similar.

**Apr 2026 update — Letta filesystem result.** Letta themselves published a result showing that a simple "filesystem" memory (raw text files indexed by timestamp) surpassed several specialized systems on some tasks. This is a strong negative for the memory-as-elaborate-vector+graph-stack thesis, coming from the company that pioneered MemGPT. Cited via *The New Stack* April 2026 piece.

**Reference:** Packer, C. et al. (2023). [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)

### 1.4 Mem0 — production-mature, with rapid evolution

The Mem0 line went through dramatic changes between March and April 2026:

| Version | Date | LongMemEval | LoCoMo | Mechanism |
|---|---|---:|---:|---|
| Mem0 (Apr 2025 paper) | Apr 2025 | 49.0% | 67.13% | Hybrid vector + graph + KV; self-edit on conflict; ~1,764 tokens/conv. p95 0.20 s. |
| **Mem0 token-efficient** | **Apr 28, 2026** | **93.4%** | **91.6%** | **Multi-signal fusion (semantic + keyword + entity in parallel) + agent-generated facts as first-class. ~6,950–6,780 tokens/retrieval. BEAM 1M: 64.1, BEAM 10M: 48.6** |
| Mem0 (WorldDB re-run) | Apr 2026 | 29.07% | — | Same system, third party's harness. The 64-pp spread is the cleanest single illustration of the reproducibility crisis. |

**Implication:** memex's existing multi-signal pipeline (vector + BM25 + entity + temporal + Qwen3-rerank) is the *same family* as Mem0's winning approach. The earlier "Mem0 graph adds 3× latency for 1.5% gain" framing is now obsolete — Mem0 dropped the graph and won on fusion.

**References:** [arXiv:2504.19413](https://arxiv.org/abs/2504.19413) (Apr 2025 paper), [mem0.ai/research](https://mem0.ai/research) (Apr 28, 2026 update), [Zep blog dispute](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/), [WorldDB arXiv:2604.18478](https://arxiv.org/abs/2604.18478).

### 1.5 Zep / Graphiti (Rasmussen, 2025) — temporal knowledge graph

Bitemporal tracking: every node and edge has both `valid_at` (event time) and `created_at` (ingestion time). 3-tier graph: episode subgraph, semantic entity subgraph, community subgraph. Hybrid BM25 + semantic + graph traversal, no LLM at retrieval.

| Source | LongMemEval | LoCoMo |
|---|---:|---:|
| Zep's own paper | ~85% | 84% |
| Mem0's rebuttal re-run | 71.2% | 58.44% (cat 1-4 only, 10-run mean) |
| Zep's counter-rebuttal | — | 75.14% (corrected re-implementation) |

The Mem0/Zep dispute is the canonical case study for the field's reproducibility crisis. Zep alleges Mem0 misconfigured them (wrong user-graph role, timestamps appended-not-fielded, sequential-not-parallel search). Both methodologies have been challenged by independents.

**Implication for memex:** SQLite cannot host Graphiti directly, but the *concept* of bitemporal columns is implementable in SQLite with two timestamp columns. memex's temporal-query detection covers the read side; provenance metadata (current design) covers the write side.

**References:** [arXiv:2501.13956](https://arxiv.org/abs/2501.13956), [Zep blog](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/), [Mem0 rebuttal GitHub Issue](https://github.com/getzep/zep-papers/issues/5).

### 1.6 Hindsight / TEMPR (Deshpande et al., 2025) — structured entity-temporal memory

4-way parallel search:
1. Semantic vector similarity
2. BM25 keyword matching
3. Graph traversal through shared entities
4. Temporal filtering for time-constrained queries

Reports 91.4% on LongMemEval (Gemini-3 Pro). Multi-session questions: 21.1% → 79.7%; temporal: 31.6% → 79.7%.

**Implication for memex:** memex's entity + temporal + vector + BM25 channels are *already* this pattern. Doc 003 (March) flagged TEMPR's 4-way search as the most impactful upgrade memex could make; that work is now landed in v0.6.

**Reference:** [arXiv:2512.12818](https://arxiv.org/abs/2512.12818)

### 1.7 Observational Memory / Mastra (2026) — no-retrieval architecture

Background Observer + Reflector continuously compress conversation into timestamped, priority-ranked observations. Three-date temporal model: observation date, referenced date, relative date. Priority emoji markers. **3–6× compression for text, 5–40× for tool-heavy workloads.**

**LongMemEval results:**
- gpt-5-mini: **94.87%** (highest mainstream-aggregated score, Mar 2026)
- gpt-4o: 84.23% (above the oracle config given only answer-bearing sessions)
- gemini-3-pro-preview: 93.27%
- Strong category breakdowns: 95.5% temporal, 96.4% single-session-assistant, 97.1% single-session-user

**Trade-off:** requires continuous LLM inference for Observer/Reflector (conflicts with memex's "no LLM at query time" constraint). The *concept* of pre-computing compressed summaries at write-time is valuable — memex's dreaming reflection is the same idea applied to learnings, not raw observations.

**Reference:** [mastra.ai/research/observational-memory](https://mastra.ai/research/observational-memory)

### 1.8 A-MEM (Xu et al., 2025) — Zettelkasten-style self-organizing memory

Each memory = structured note with contextual descriptions, keywords, tags, and links. Memory *agency*: new experiences retroactively refine attributes of existing notes. NeurIPS 2025 poster.

**Apr 2026 caveat (xMemory paper):** A-MEM and MemoryOS suffer fragility in LLM-generated structure — formatting deviations and failed updates documented as failure modes. Deterministic, schema-first structure has been proposed as more reliable.

**Implication for memex:** memex's entity graph is the structural shape; the LLM-driven update fragility is a real risk for memex's dreaming reflection. Worth watching.

**Reference:** [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)

### 1.9 RL for memory operations [HIGH CONFIDENCE — promoted from "emerging" in March]

Five primary papers in the line, plus ICLR 2026 workshop:

| System | Method | Headline result |
|---|---|---|
| **Memory-R1** ([arXiv:2508.19828](https://arxiv.org/abs/2508.19828)) | Manager (ADD/UPDATE/DELETE/NOOP) + Answer Agent. PPO + GRPO. | LLaMA-3.1-8B: F1 +68.9% / B1 +48.3% / J +37.1% over Mem0. **Backbone-sensitive** — drops to 62.74% on Qwen3-4B when MemBuilder re-ran. |
| **Mem-α** ([arXiv:2509.25911](https://arxiv.org/abs/2509.25911)) | RL on memory construction; core/episodic/semantic components. | Qwen3-4B 0.389 → 0.642. **Generalizes 30k → 400k tokens (13×)** — RL learns principles, not patterns. |
| **AgeMem / Agentic Memory** ([arXiv:2601.01885](https://arxiv.org/abs/2601.01885)) | Five memory ops (store/retrieve/update/summarize/**discard**) as callable tools, step-level GRPO. | Outperforms baselines on 5 long-horizon benchmarks. Learns proactive summarization and semantic-redundancy discard. |
| Learn to Memorize ([arXiv:2508.16629](https://arxiv.org/abs/2508.16629)) | MoE gate function for retrieval, on/off-policy hybrid. | — |
| MemRL (Jan 2026) | Self-evolving via runtime RL on episodic memory. | — |

**Reward-model bottleneck:** MemoryRewardBench ([arXiv:2601.11969](https://arxiv.org/abs/2601.11969)) shows reward models degrade abruptly **beyond 64K tokens** and cannot reliably judge parallel/mixed memory-management strategies. RL-memory's reliable supervision range is upper-bounded by RM quality.

**Implication for memex:** memex's dreaming reflection is heuristic. AgeMem's discard-as-action and Memory-R1's ADD/UPDATE/DELETE/NOOP framings are concrete reference points. *Not a 2026 priority* — RL-memory is not yet beating heuristics consistently across backbones, and the reward-model fragility caps the supervision window memex would need.

### 1.10 WorldDB (Apr 2026) — executable graph semantics [NEW]

[`arXiv:2604.18478`](https://arxiv.org/abs/2604.18478). Three architectural commitments:

1. **Recursive worlds**: every node is a world — a container with its own interior subgraph, ontology scope, composed embedding.
2. **Content-addressed immutability**: nodes are content-addressed; any edit produces a new hash at the edited node and every ancestor (Merkle audit trail).
3. **Edges as write-time programs**: each edge type ships `on_insert` / `on_delete` / `on_query_rewrite` handlers (`SUPERSEDES` closes validity, `CONTRADICTS` preserves both, `SAME_AS` stages a merge proposal). No raw append path exists.

**Results:** LongMemEval-s with Claude Opus 4.7 — **96.40% overall, 97.11% task-averaged**, perfect single-session-assistant recall, 96.24% temporal. +5.61pp vs Hydra DB (90.79%), +11.20pp vs Supermemory (85.20%). Largest gains on multi-session (+15.79pp) where cross-session entity unification matters most.

**Caveat:** numbers are paper-self-reported, not yet independently aggregated. WorldDB's own re-run of Mem0 produced 29.07% (vs Mem0's own 93.4%), illustrating the harness-dependence problem.

**Implication for memex:** for Problem 1 (multi-device shared pool), content-addressed immutable nodes with executable edges give *audit trail + cross-device + correction history simultaneously* — exactly what memex's correction-chain design points toward. WorldDB is an existence proof you can have this without a graph database.

### 1.11 Continual / lifelong learning systems [NEW]

The Jan 2026 "From Storage to Experience" survey explicitly names continual learning as the field's "ultimate goal."

- **SimpleMem** ([arXiv:2601.02553](https://arxiv.org/abs/2601.02553), ICLR 2026 Workshop) — three-stage pipeline: semantic structured compression → recursive consolidation → adaptive query-aware retrieval. **Inspired by Complementary Learning Systems (CLS) theory** — same theoretical basis as memex's facts + learnings two-tier. Reports F1 +26.4%, 30× token reduction.
- **Cross-Session SimpleMem** (Feb 2026): +64% over Claude-Mem on LoCoMo.
- **Omni-SimpleMem** (Apr 2026): multimodal extension. **LoCoMo F1=0.613 (+47%), Mem-Gallery F1=0.810 (+51%)**.
- AriadneMem ([arXiv:2603.03290](https://arxiv.org/html/2603.03290)) — "Threading the Maze of Lifelong Memory."
- MemoryBench (Ai et al., 2025): "existing systems fail to use feedback effectively without forgetting."

**Field consensus:** "Memory corruption emerges through catastrophic interference. New memories don't simply add — they overwrite, distort, or contradict previous information. Agents may end up remembering conflicting versions simultaneously."

**Implication for memex:** memex's dreaming (light/deep sweep + reflection) is exactly this line of work. Storage→Reflection→Experience framing fits memex's two-tier (facts + learnings) architecture. SimpleMem's CLS-theory is the same theoretical basis.

### 1.12 Other systems (briefer)

- **MEM1** ([arXiv:2506.15841](https://arxiv.org/abs/2506.15841)) — RL-trained 7B model maintaining compact internal state. Validates "what to forget = what to remember" but RL training infrastructure not relevant for memex.
- **MemWalker** ([arXiv:2310.05029](https://arxiv.org/abs/2310.05029)) — hierarchical summary tree, iterative LLM navigation. Single-doc focus; not relevant to multi-source memex.
- **Ensue** (2026) — open-source pipeline, 88% LongMemEval (93% with GPT-5-mini). Architectural validation for memex's local-inference stack.
- **xMemory** (Feb 2026) — 4-level hierarchy (messages → episodes → semantics → themes) with uncertainty-gated drill-down. Up to 29% token reduction per query. Beats A-MEM, MemoryOS, LightMem, Nemori on LoCoMo. Critical paper in the LLM-driven structure-fragility documentation.
- **MemoryOS** ([arXiv:2506.06326](https://arxiv.org/abs/2506.06326), EMNLP 2025 Oral) — short/mid/long tiers, FIFO + segmented paging + heat-driven eviction. +49.11% F1 on LoCoMo (gpt-4o-mini). Documented LLM-update fragility (xMemory critique).
- **Engram / ENGRAM-R** ([arXiv:2511.12960](https://arxiv.org/abs/2511.12960), [arXiv:2511.12987](https://arxiv.org/abs/2511.12987)) — typed memory + Fact Cards + citation enforcement. **Read-time-heavy** philosophy ("recall-based beats extraction-based — invest intelligence at read time"). 80.0% LoCoMo, +19.6% over Mem0, **−85% input tokens, −75% reasoning tokens vs full-context**. *High-ROI reference for memex's prompt-engineering pass.*
- **MemPalace** — claimed "100% LongMemEval"; primary critic [`arXiv:2604.21284`] attributes the 96.6% R@5 to ChromaDB defaults + verbatim storage, not the spatial-palace metaphor. The "100%" was three post-hoc patches against a non-held-out dev set.
- **Supermemory ASMR** — 99% via 8–12 specialist-prompt parallel ensemble. Production-fatal P99 (T21).

---

## 2. Ranking and Fusion Algorithms for Heterogeneous Sources

### 2.1 RRF and its limitations [unchanged from March]

Standard RRF: `RRF(d) = SUM_r 1 / (k + rank_r(d))`. Limitations: information loss (drops absolute scores), hyperparameter sensitivity, no source weighting, latency cost (must run all pipelines first).

### 2.2 Weighted RRF

`WRRF(d) = SUM_r w_r / (k + rank_r(d))`. Elasticsearch shipped this in 2025; up to +6.4% nDCG@10 vs standard RRF. For memex: `w_conversation = 0.6`, `w_document = 0.4`. [Elastic blog](https://www.elastic.co/search-labs/blog/weighted-reciprocal-rank-fusion-rrf).

### 2.3 HF-RAG: hierarchical fusion with z-score standardization [CIKM 2025]

Two stages: (1) intra-source RRF, (2) cross-source z-score then merge.

```
z_score(s, source) = (s - mean(scores_source)) / std(scores_source)
```

Improves OOD generalization +3 pp Macro F1. Already adopted in memex's pipeline. [arXiv:2509.02837](https://arxiv.org/abs/2509.02837)

### 2.4 Multi-signal fusion is the 2026 winning pattern [REINFORCED]

Mem0's Apr 2026 update jumped from 49% → 93.4% by running **three scoring passes in parallel and fusing**: semantic similarity, keyword matching, entity matching. xMemory does it with 4-level hierarchy. Hindsight/TEMPR with 4-way. Memex with vector + BM25 + entity + temporal + rerank.

The pattern: **parallel scoring across orthogonal signals, fusion at read time**. Memex was on this trend before Mem0 was. The math (z-score normalization + weighted fusion) was already correct in March; April just added more empirical validation.

### 2.5 Cross-encoder reranking and length bias

Cross-encoders bias toward longer documents (more matching tokens). Mitigations: truncate documents to best-matching chunk before reranking (memex's `bestChunk`); length-normalized reranking (`score / log(length)`); CMC for parallel candidate processing. Practical recommendation for memex: rerank `bestChunk` from documents alongside short memories' full text.

### 2.6 Auxiliary Cross Attention Networks (ACAN) [reference only]

Hong et al. (2025) — learned cross-attention model trained on LLM-generated ground truth. Requires training infrastructure. Not in 2026 priority for memex; could be approximated with offline-trained logistic regression / GBDT. [Frontiers in Psychology DOI:10.3389/fpsyg.2025.1591618](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2025.1591618/full)

---

## 3. Minimizing API Calls: Adaptive Retrieval Strategies

### 3.1 Query Classification: Skip Retrieval Entirely

memex's `adaptive-retrieval.ts` skips for greetings/commands. Adaptive-RAG (NAACL 2024) generalizes to three tiers: no retrieval / single retrieval / iterative retrieval.

### 3.2 Source Routing

RAGRouter (2025): predicts which source is useful before retrieval. Heuristics for memex: "my preference / I said / I want" → memory-only; "in the file / documentation says / config" → document-only. Estimated savings: 30–40% of queries skip document search, ~200ms each. [arXiv:2505.23052](https://arxiv.org/abs/2505.23052)

### 3.3 Confidence-Based Reranker Gating

Skip rerank if `(score_1 - score_2 > gap_threshold) OR (score_1 > high_threshold)`. Suggested: `gap=0.15, high=0.9`. Already implemented as `shouldRerank` gate in memex v0.6.

### 3.4 Early Termination [already implemented]

memex skips document search when conversation results all clear `highConfidenceThreshold` (0.6). Bidirectional extension: also skip conversation when query is clearly document-oriented.

---

## 4. Score Normalization and Multi-Source Merging

[Math content unchanged from March — still mathematically valid]

### 4.1 Why min-max fails

Already discovered empirically: `[0.92, 0.83, 0.79] → [1.0, 0.31, 0.0]` is wrong. BM25 follows normal-exponential mixture; cosine clusters near corpus floor (0.3–0.5). Min-max assumes uniform — violated by both. [Manmatha 2001 Information Retrieval 4(3)](https://link.springer.com/article/10.1007/s10791-010-9145-5)

### 4.2 Z-score normalization [recommended, adopted]

```
calibrated(s) = sigmoid(z_score(s)) = 1 / (1 + exp(-z_score(s)))
```

Maps z=0 → 0.5, z=2 → ~0.88, z=-2 → ~0.12. Robust to outliers, preserves spacing. memex uses this.

### 4.3 CDF-based calibration [reference]

Transform through CDF of known distribution. For cosine: `Phi((s-mu)/sigma)`. For BM25: `F_gamma(s; alpha, beta)`. Maps to percentile rank. Requires offline corpus stats.

### 4.4 RRF as normalization

RRF sidesteps normalization at the cost of magnitude information. memex uses score-based fusion + z-score, which preserves magnitudes within trusted-pipeline sources.

### 4.5 Recommended (memex)

```
final_score(d) = w_source * sigmoid(z_score(d, source)) + w_type * type_bonus(d)
```

`w_conversation = 0.55`, `w_document = 0.45`, `type_bonus` favors concise direct memories over long document chunks.

---

## 5. Benchmarks and Evaluation Metrics

### 5.1 The reproducibility crisis [NEW SECTION]

The most consequential finding of the April 2026 re-survey: **vendor benchmark numbers cannot be trusted at face value**. Three structural failure modes documented:

1. **Cherry-picking with no held-out split.** MemPalace's "100% LongMemEval" was achieved by inspecting the 3 wrong answers in the dev set and writing 3 targeted patches (a quoted-phrase boost for "sexual compulsions", a person-name boost for "Rachel", phrase patterns for "I still remember" / "when I was in high school"). LongMemEval has no official train/dev/test split — the 50-question dev set was carved out *after* the patches. ([GitHub Issue #29](https://github.com/MemPalace/mempalace/issues/29))

2. **Top-k larger than candidate pool.** LoCoMo conversations have 19–32 sessions; default `top_k=50`. LongMemEval has ~53 sessions per question; ChromaDB `n_results=50` returns ~94% of corpus on every query. **The retrieval step does not meaningfully filter.** BM25 alone hits 93.8% R@5 under this methodology. ([ATANT v1.1 `arXiv:2604.10981`](https://arxiv.org/html/2604.10981))

3. **Reproducible scoring defects.** A 2026 paper found LoCoMo's **scoring function makes 23% of items unscorable**, and its largest category (42%) scores paraphrase overlap rather than structural correctness. Covers 2 of 7 continuity properties at partial strength.

**Concrete illustrations:**
- **Mem0 has three different LongMemEval scores in the public record:** 49% (Apr 2025 paper), 93.4% (Apr 2026 own update), **29.07% (WorldDB's re-implementation)**. 64-point spread depending on harness.
- **Zep dispute:** 84% (original) → 58.44% (Mem0's correction, cat 1-4 only, 10-run mean) → 75.14% (Zep's counter-rebuttal with corrected re-implementation).
- Multiple practitioners report inability to reproduce Mem0's published LoCoMo numbers from the open-source repo (mem0ai/mem0 issues #2800, #3943, #3944).

**Implication for memex:** memex's `R@5=96% / E2E=94%` LongMemEval numbers (doc 005) are vendor-self-reported against a benchmark with documented integrity problems. Not necessarily wrong, but they should not be the sole validation. Treat any LongMemEval / LoCoMo number above ~85% with strong skepticism unless accompanied by a held-out test split and an independent re-run.

### 5.2 LongMemEval (ICLR 2025) [updated]

500 questions, 6 categories: information extraction, single-session-user, single-session-assistant, preference extraction, multi-session reasoning, knowledge update. ~115k tokens of chat history per question, 30-40 sessions.

**Current SOTA — top mainstream-aggregated scores:**
| System | Score | Reader LLM | Date | Notes |
|---|---:|---|---|---|
| Supermemory ASMR | ~99% | — | Mar 2026 | 8–12 specialist-prompt ensemble. P99-fatal in production. |
| WorldDB | **96.40%** (overall) / **97.11%** (task-avg) | Claude Opus 4.7 | Apr 2026 | Paper-self-reported; not yet independently aggregated. |
| Mastra Observational Memory | **94.87%** | gpt-5-mini | Mar 2026 | Highest mainstream-aggregated. |
| Mem0 token-efficient | **93.4%** | — | Apr 28, 2026 | Multi-signal fusion. |
| Hindsight (TEMPR) | 91.4% | Gemini-3 Pro | Late 2025 | 4-way parallel search. |
| Ensue (open-source) | 88% / 93% | OS / GPT-5-mini | 2026 | Validates open-source pipeline. |
| Emergence EmergenceMem | 86% / 82.4% | — | 2025 | At 3.2 s/item. |
| Letta | ~83.2% | — | 2025 | OS-style tiered context. |
| RetainDB | 79% / 88% pref | gpt-5.4-mini | Mar 2026 | Per-turn extraction, canonical dedupe. |
| LiCoMemory | 73.8% | gpt-4o-mini | Nov 2025 | +26.6 pp multi-session, +15.9 pp temporal. |
| **memex (self-reported)** | **94% E2E / 96% R@5** | GPT-4o | Mar 2026 | Per [005-longmemeval-baseline.md](./005-longmemeval-baseline.md). Subject to §5.1. |
| Zep / Graphiti | 71.2% / 75.14% | — | 2025 | Disputed; see §1.5. |
| Mem0 (Apr 2025) | 49.0% | — | Apr 2025 | Superseded. |

**Saturation watch:** Both 2026 surveys flag this benchmark as approaching its useful ceiling, but per §5.4, this is a *benchmark-shape* problem, not a capability ceiling.

**Reference:** [arXiv:2410.10813](https://arxiv.org/abs/2410.10813)

### 5.3 LoCoMo (NAACL 2024) [updated]

~1,500–2,000 QA pairs, 4 reasoning categories (single-hop, multi-hop, temporal, adversarial). Avg conversation: 300 turns / 9k tokens / 35 sessions. Human F1 ≈ 88%.

**Notable 2025-2026 results:**
- Mem0 token-efficient: 91.6
- MemMachine Episodic Memory: 0.8487 llm_score
- MemBuilder (Qwen3-4B): 82.00%
- MemoryOS: +49.11% F1 over baseline (gpt-4o-mini)
- Omni-SimpleMem: F1=0.613 (+47%)
- Engram: 80.0% (vs Mem0 66.9%)

Standard GPT-4o ≈ 30% on temporal. Full neuro-symbolic reaches ~78%.

**Reference:** [arXiv:2402.17753](https://arxiv.org/abs/2402.17753)

### 5.4 Successor benchmarks: agentic-task evaluation [NEW]

Three benchmarks released in late 2025 / early 2026 expose that LongMemEval/LoCoMo saturation is a *benchmark-shape* problem, not capability ceiling.

#### MemoryArena (`arXiv:2602.16313`, Feb 2026)
Stanford Digital Economy Lab + UCSD. Memory-Agent-Environment loops with **causally interdependent subtasks** across 4 domains: web navigation, preference-constrained planning, progressive search, sequential formal reasoning. 5 dataset configs.

**Concrete leaderboard (Table 3 — best Success Rate per dataset):**

| Dataset | Best SR | Winning paradigm |
|---|---:|---|
| Bundled Web Shopping | 0.12 | long-context |
| Group Travel Planning | 0.06 | long-context |
| Progressive Web Search | 0.62 | long-context |
| Formal Reasoning Math | 0.50 | long-context |
| Formal Reasoning Physics | 0.60 | long-context |

Three paradigms tested: long-context (GPT-5.1-mini, GPT-4.1-mini, Gemini-3-Flash, Claude-Sonnet-4.5), external memory (Letta, Mem0, Mem0-g, ReasoningBank), RAG (BM25, Text-Embedding-3-Small, MemoRAG, GraphRAG). **Long-context wins all 5 categories.** External-memory systems (Mem0, Letta) lose on every dataset.

#### MemoryAgentBench (`arXiv:2507.05257`, Jul 2025, ICLR 2026)
Hu et al. (HUST-AI). Four competencies: accurate retrieval, test-time learning, long-range understanding, **selective forgetting**. Two new datasets: EventQA (retrieval), FactConsolidation (forgetting). [Code](https://github.com/HUST-AI-HYZ/MemoryAgentBench).

**Headline:** all methods cap at **~7% accuracy on multi-hop selective forgetting**. Single-hop forgetting: only long-context reaches reasonable scores. Reasoning models don't change the qualitative conclusion.

#### MEMTRACK (`arXiv:2510.01353`, Patronus AI, NeurIPS 2025)
47 datapoints across **Slack + Linear + Git** (full Gitea + dockerized FS). Cross-platform dependencies, contradictions, codebase comprehension. Metrics: Correctness, Efficiency, Redundancy.

**Headline:** **GPT-5 only achieves 60% Correctness.** Strong negative result: "memory components like Zep and Mem0 do not significantly improve performance" — current memory tooling fails on enterprise-shaped tasks.

#### AMA-Bench (`arXiv:2602.22769`, 2026)
"Agent memory techniques often outperform long-context LLM baselines on dialogue-centric benchmarks, but fall short to the baselines in many long-horizon agentic tasks." GPT 5.2 hits **72.26%**. "Suboptimal memory system design serves as the primary bottleneck."

**Implication for memex:** memex is dialogue-shaped (Claude Code conversations), where memory tools win. But these three benchmarks suggest the gains may not transfer to agentic, multi-step Claude Code workflows (tool calls + planning). Roadmap risk.

### 5.5 Other benchmarks (named)

- **MemoryRewardBench** ([arXiv:2601.11969](https://arxiv.org/abs/2601.11969)) — RMs for memory; 8K–128K context; abrupt fragility >64K.
- **MEMTRACK**, **Mem2ActBench** ([arXiv:2601.19935](https://arxiv.org/abs/2601.19935)), **MemGUI-Bench** ([arXiv:2602.06075](https://arxiv.org/abs/2602.06075)), **MemBench** ([arXiv:2506.21605](https://arxiv.org/abs/2506.21605)), **MemoryBench** ([arXiv:2510.17281](https://arxiv.org/abs/2510.17281)), **AMA-Bench**, **From Recall to Forgetting** ([arXiv:2604.20006](https://arxiv.org/html/2604.20006)).
- **BEAM** (1M / 10M tokens) — production-scale; Mem0 reports 64.1 / 48.6.

### 5.6 Memory-specific metrics

| Metric | Description | Standard IR equivalent |
|---|---|---|
| Temporal accuracy | Does it return the *current* version of an updated fact? | None |
| Source attribution accuracy | Memory vs document correctly identified? | None |
| Abstention rate | Correctly declines when asked about something never discussed? | Precision at zero recall |
| Knowledge update lag | How fast a corrected fact propagates? | None |
| Preference consistency | Permanent preferences recall across sessions? | None |
| Cross-session reasoning | Connects facts across sessions? | Multi-hop QA |
| **Selective forgetting accuracy** | Drops obsolete info on demand? | None — and field caps at 7% |

### 5.7 Custom benchmark design for memex

Given memex's specific needs (short facts + long documents + temporal + multi-device scoping), benchmark categories:

1. Direct memory recall: "What voice do I use for TTS?" → "Alice" (memory)
2. Document retrieval: "What does REQUIREMENTS.md say about embedding?" → (document)
3. Source priority: "What is my TTS voice?" — memory says "Alice", doc mentions "Alice" 34× — memory should win
4. Temporal correctness: After "TTS voice is now Koda", "Alice" should not appear first
5. Permanent preference: After 90 days unmentioned, "never say sorry" should still be retrievable
6. Abstention: "What is my favorite color?" (never discussed) → no confident result
7. **Cross-device scoping** (NEW): A laptop-scoped fact should not leak to dev-VM context
8. **Selective forgetting** (NEW): "Don't remember anything I said last Tuesday about X" — memex doesn't yet support this; the field caps at 7% multi-hop

---

## 6. Analysis: What Fits Our Constraints

### Constraint summary

| Constraint | Value |
|---|---|
| Database | SQLite + FTS5 + sqlite-vec |
| Latency budget | < 500ms total pipeline |
| Embedding | Local via llama.cpp (Qwen3-Embedding, ~83ms uncached) |
| Reranker | Local via llama.cpp (Qwen3-Reranker-0.6B, ~53ms for 5 docs) |
| LLM calls at query time | Zero (too slow/expensive for retrieval path) |
| Memory count | ~1,900 memories, ~450 documents |
| Build system | None (TypeScript via jiti) |

### Algorithm compatibility matrix

| System | Fits constraints? | Key blocker |
|---|---|---|
| Generative Agents formula | Yes (trivially) | Naive weights, min-max fails |
| MemoryBank Ebbinghaus | Yes | Already implemented; FadeMem half-lives are an upgrade |
| FadeMem (45% storage savings) | **Yes** | Pure decay-formula change |
| MemGPT paging | Partially | Agent-controlled paging adds complexity |
| Mem0^g graph | No | Requires Neo4j (Mem0 itself dropped graph) |
| Mem0 token-efficient (multi-signal fusion) | **Yes** — already this shape | Memex's pipeline = same family |
| Zep / Graphiti temporal KG | No | Requires Neo4j |
| Hindsight / TEMPR 4-way search | **Yes** — landed in v0.6 | Entity resolution at store-time only |
| Observational Memory (Mastra) | No | Continuous LLM Observer/Reflector |
| A-MEM Zettelkasten | Partially | LLM at store-time; structure fragility risks |
| MEM1 / Memory-R1 / Mem-α / AgeMem (RL) | No (2026) | RL training infra; reward-model fragility >64K caps supervision |
| WorldDB content-addressed graph | Partially | Conceptually adoptable; requires schema redesign |
| HF-RAG z-score fusion | **Yes** | Pure math, adopted |
| Weighted RRF | **Yes** | Simple formula change |
| ENGRAM-R citation enforcement | **Yes** | Prompt-engineering pass; high ROI |
| SimpleMem CLS-inspired pipeline | **Yes** — same shape | memex's facts + learnings two-tier |
| Learned fusion (GBDT / ACAN) | Partially | Needs labeled data |

### The long-context vs memory framing [NEW]

"Beyond the Context Window" ([arXiv:2603.04814](https://arxiv.org/html/2603.04814v1), Mar 2026) directly benchmarks long-context GPT-5-mini vs fact-based memory:

| Metric | Long-context GPT-5-mini | Memory (Mem0, pre-update) | Δ |
|---|---:|---:|---:|
| LongMemEval | 82.40% | 49.00% | +33.4 pp |
| LoCoMo | 92.85% | 57.68% | +35.2 pp |
| PersonaMem v2 | 69.75% | 62.48% | +7.3 pp |

Cost / break-even: write phase ~$0.0435/conversation; per-query memory $0.0013 vs long-context $0.0265 (first turn at 100k) / $0.0036 (with 90% prompt caching). **Break-even at ~10 turns** at 100k tokens; ~9 turns at 500k.

**Implication for memex:** the value proposition needs to be re-articulated. Not "better recall than long-context" — that's losing on accuracy. The honest pitch: *cross-device, cross-session amortization with provenance and scope*, which the academic field doesn't have a clean benchmark for yet.

### Recommended picks (updated for April)

**Already adopted in memex v0.6:**
- Z-score normalization for cross-source merging (HF-RAG)
- Source routing heuristics
- Confidence-based reranker gating (`shouldRerank`)
- Hindsight/TEMPR 4-way search (entity + temporal + vector + BM25)
- Mem0-style multi-signal fusion (memex was on this trend before Mem0)
- Local Qwen3-Reranker (essentially free at ~53ms)

**High ROI, low effort to add:**
- **ENGRAM-R citation enforcement** — render retrieved memories as anchored Fact Cards, instruct LLM to cite by anchor. Estimated −75% reasoning tokens at maintained accuracy.
- **FadeMem-style explicit half-life decay** — replace ad-hoc decay; reported 45% storage savings vs Mem0.
- **Benchmark-honesty section in README** — two sentences acknowledging LongMemEval integrity issues and memex's actual design center.

**Medium-term:**
- **Bitemporal columns** (event_time, ingestion_time) in memory schema — covers Zep concept without graph DB.
- **Memory durability classification** (permanent / transient / ephemeral).
- Optional: WorldDB-inspired content-addressed memory IDs for cross-device dedup.

**Long-term / out of 2026 scope:**
- Learned fusion model (GBDT / ACAN)
- RL-learned memory ops (AgeMem-style discard)
- Multimodal memory (MemLoRA-V style)

---

## 7. Memory Governance and Security [NEW Apr 2026]

A real sub-field with concrete attack and defense papers. memex must consider this if it ships as a service.

**Attack class:**

| Attack | Vector | Source |
|---|---|---|
| **MINJA** | Query-only memory injection (no privileged access) | [arXiv:2503.03704](https://arxiv.org/abs/2503.03704) (Mar 2025, v5 Feb 2026) |
| **MemoryGraft** | Poisoned successful experiences exploit semantic-imitation heuristic | [arXiv:2512.16962](https://arxiv.org/abs/2512.16962) (Dec 2025) |
| **InjecMEM** | Targets layered systems (evaluated against MemoryOS); persists after benign drift | [OpenReview](https://openreview.net/forum?id=QVX6hcJ2um) |
| **Memory Poisoning EHR** | Empirical eval on GPT-4o-mini, Gemini-2.0-Flash, Llama-3.1-8B | [arXiv:2601.05504](https://arxiv.org/abs/2601.05504) (Jan 2026) |
| Implicit memory "time bombs" | Even agents without explicit memory carry state via output→input | [arXiv:2602.08563](https://arxiv.org/) (Feb 2026) |
| Morris-II AI worm | Self-replicating worm propagating across RAG-connected agents | [arXiv:2403.02817](https://arxiv.org/) |

**Defense / detection:**
- **SuperLocalMemory** ([arXiv:2603.02240](https://arxiv.org/)) — Bayesian trust model; **72% trust-degradation detection at 10.6 ms median latency**.
- **Agent Security Bench** ([arXiv:2410.02644](https://arxiv.org/)) — **84.30% average attack success rate** across 27 attack/defense combinations on 400+ tools.
- "Just five carefully crafted documents → 90% RAG manipulation" (Jan 2026 MDPI review).

**The "mnemonic sovereignty" framing:** [arXiv:2604.16548](https://arxiv.org/html/2604.16548v1) introduces *mnemonic sovereignty* as a normative concept — verifiable, recoverable governance over what may be written, who may read, when updates are authorized, and what may be forgotten. Argues the next generation of competition will be on governance, not raw recall.

**Implication for memex:** for Problem 1 (multi-device daemon), every memory write is now an attack surface. Memex's correction-chain is partial defense (preserves provenance). No detection mechanism integrated. **New roadmap item if memex ships as a service.**

---

## 8. Multi-Agent Memory [NEW Apr 2026]

memex's daemon serving multiple devices ≡ a multi-agent memory system. The field has organized this as its own sub-problem.

**Architecture position paper:** [arXiv:2603.10062](https://arxiv.org/html/2603.10062v1) (Mar 2026) frames multi-agent memory as a **computer-architecture problem**: shared vs. distributed memory paradigms, three-layer hierarchy (I/O, cache, memory), and names two open protocol gaps: **cache sharing across agents** and **structured memory access control**. The named single-most-pressing challenge: *multi-agent memory consistency*.

**Ontological drift:** [arXiv:2604.03430](https://arxiv.org/html/2604.03430) — when agents have isolated memory, they diverge in conceptual definitions, causing systemic hallucinations and logical mismatches across the swarm.

**Emergent collective memory:** [arXiv:2512.10166](https://arxiv.org/html/2512.10166v1) — stigmergy (indirect communication via environment modification, like ant pheromone trails) as a primitive for decentralized memory.

**Attack class — contagious jailbreak via shared memory:**
- **TMCHT** ([arXiv:2410.16155](https://arxiv.org/abs/2410.16155)) — Troublemaker Makes Chaos in Honest Towns. Multi-topology attack benchmark (graph, line, star). +52.93% attack success in 100-agent settings vs prior single-agent attacks. Key finding: *toxicity disappears* after few hops, so single-agent attacks don't propagate without topology-aware construction.
- **MemJack** ([arXiv:2604.12616](https://arxiv.org/abs/2604.12616)) — Memory-augmented multi-agent jailbreak on VLMs.
- **Agent Smith** ([arXiv:2402.08567](https://arxiv.org/html/2402.08567v2)) — single adversarial image jailbreaks ~1M MLLM agents exponentially fast.

**Implication for memex:** Problem 1 is *exactly* multi-agent memory consistency. Read [arXiv:2603.10062](https://arxiv.org/html/2603.10062v1) before finalizing the daemon protocol. Stigmergy-style indirect-write patterns are interesting for future cross-device coordination.

---

## 9. Production Deployment Realities [NEW Apr 2026]

**Memory at scale is mandatory.** A 200K context isn't storage. At Sonnet 4.6's $3/MTok input rate, a 1M-token call costs $3 each — full-history is impractical for daily-operation agents.

**Dual-layer architecture is now standard:**
- **Hot Path:** recent messages + summarized graph state, in-context.
- **Cold Path:** Zep / Mem0 / Pinecone / pgvector, retrieved on demand.
- **Memory Node** coordinates after each turn.
- **Sub-100ms cold-path retrieval** is the operational target.

**Latency tail dominates UX.** Microsoft Research 2024:
- P99 >5s → **45% user abandonment**
- P99 <2s → 8% abandonment

**Industry SLO targets:**
- Customer service: P99 <3s end-to-end, TTFT <500ms
- Real-time decisioning (fraud, credit): P99 <500ms
- Document AI: P99 10–30s acceptable

**Gateway compounding.** A gateway adding 40 ms/call × 5 sequential agent calls = **200 ms pure proxy latency** — visible in P99. Inference-aware load balancing > round-robin in agentic stacks.

**Mitigations:**
- Semantic caching (>50% hit rate at <10 ms)
- Request hedging (after P75 elapses, duplicate at ~25% extra spend)
- Workload separation (batch vs real-time queues)
- Consistent hashing for tenant cache locality

**Concrete production numbers:**
- **Mem0 selective vs full-context:** 1.44 s p95 vs 17.12 s — **91% latency reduction at −6 pp accuracy**.
- **Tencent Cube Sandbox** (Apr 21, 2026, Apache 2.0): 100K+ instance bursts, P99 <200ms under 100 concurrent launches/host, ~60ms cold start (1/3 of industry average).

**Implication for memex:** memex's daemon design (Tailscale-connected, single SQLite, scope-aware retrieval) is well-positioned for the cost/latency axis. **Don't chase ensemble-style accuracy** — Supermemory's 99% requires 8–12 parallel calls; that's a P99 disaster. ENGRAM-R's −85% input / −75% reasoning tokens is the kind of trade-off production actually needs.

---

## 10. Recommended Algorithm Design for memex

### 10.1 TEMPR-Lite (already landed in v0.6)

memex's v0.6 implements the four-way parallel search inspired by Hindsight/TEMPR:

1. Semantic vector similarity (Qwen3-Embedding-4B-Q8 + sqlite-vec)
2. BM25 keyword (FTS5)
3. Entity graph traversal (entity extraction + adjacency links + one-hop expansion)
4. Temporal query detection (regex date-range filtering)

Plus reranker (Qwen3-Reranker-0.6B), `shouldRerank` gate, in-turn recall cache, source routing.

This is the same family as Mem0's April 2026 winning multi-signal fusion approach.

### 10.2 Storage enhancements (recommended additions)

```sql
ALTER TABLE memories ADD COLUMN durability TEXT DEFAULT 'transient';
-- 'permanent' | 'transient' | 'ephemeral'

ALTER TABLE memories ADD COLUMN event_time INTEGER;     -- when the fact occurred
ALTER TABLE memories ADD COLUMN ingestion_time INTEGER; -- when memex observed it
-- bitemporal pattern (Zep concept, no graph DB needed)

ALTER TABLE memories ADD COLUMN provenance TEXT;
-- JSON: {device, project, agent, origin, projectPath?, provenanceVersion}
-- See two-problems-architecture.md for design
```

### 10.3 Read-time citation enforcement (ENGRAM-R-style, recommended)

Replace raw injected memories with anchored Fact Cards in the prompt template, instructing the model to cite by anchor:

```
[mem:abc123 · memex/main · 3d ago · cross-context]
We use pnpm for this project.

[mem:def456 · homelab/infra · 2w ago]
Default deploy strategy is blue-green.
```

Plus instruction to the LLM: "Cite supporting memories by anchor (e.g., [mem:abc123]) in your reasoning." Estimated −75% reasoning tokens at maintained accuracy.

### 10.4 Provenance-aware recall (Problem 2 — already designed)

Soft boost via scope expansion. `RequestContext` (device, project, agent) expands to `["global", "project:X", "agent:Y"]`; existing scope-filter in retriever consumes the array. No retriever changes needed.

LLM-visible recall labels surface judgment opportunity:

```
[memex/main · 3d ago] We use pnpm for this project.
[homelab/infra · 2w ago · cross-context] Default deploy is blue-green.
[unknown context · 5mo ago] Prefer tabs over spaces.
```

### 10.5 What NOT to build (in 2026)

- **Ensemble specialist-agent retrieval** (Supermemory ASMR style) — P99 disaster.
- **RL-trained memory policies** — reward-model fragility >64K caps supervision; not yet beating heuristics consistently.
- **Graph database (Neo4j)** — Mem0 dropped it, gains came from fusion not graph.
- **Continuous LLM observer/reflector** (Mastra style) — conflicts with memex's no-LLM-at-query-time constraint.

---

## 11. Concrete actions for memex, ordered by ROI

### High ROI, low effort
1. **Add a benchmark-honesty section to README.** Two sentences: "(1) memex's LongMemEval numbers are self-reported; that benchmark has documented integrity issues. (2) memex's design center is *cross-device, cross-session amortization with provenance and scope*, which the field doesn't have a clean benchmark for yet." Positions memex as professional and skeptical instead of competing on numbers the research has discredited.

2. **Adopt citation-enforcement in the LLM prompt** (ENGRAM-R style). Render retrieved memories as anchored Fact Cards, instruct the model to cite by anchor. Estimated −75% reasoning tokens at maintained accuracy. One prompt-engineering pass.

3. **Re-frame v0.6 release notes.** memex's win condition is *cost + governance + cross-device pool*, not "better recall." Doc 003's earlier framing was implicitly accuracy-first; flip it.

### Medium ROI, medium effort
4. **Run memex against MemoryAgentBench** ([github.com/HUST-AI-HYZ/MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench)) to surface selective-forgetting weaknesses honestly. The benchmark is open-source.

5. **Wire FadeMem-style explicit half-life decay** into memex's session-import path. Reported 45% storage savings vs Mem0; current memex decay is ad-hoc.

6. **Read the multi-agent memory architecture paper** ([arXiv:2603.10062](https://arxiv.org/html/2603.10062v1)) before finalizing the daemon protocol. "Multi-agent memory consistency" is the academic name for what Problem 1 is solving.

7. **Add bitemporal columns** (event_time, ingestion_time) to the memory schema. Covers Zep's concept in SQLite without graph DB.

### Lower ROI / longer horizon
8. **Add memory-attack detection.** SuperLocalMemory's Bayesian trust model is a reference point. Skip until memex ships as a service.

9. **Consider RL-learned memory ops** (AgeMem-style discard) only after the heuristic dreaming policy is well-validated. Reward-model fragility above 64K tokens makes this premature.

10. **Multimodal memory** (MemLoRA-V) — out of 2026 scope; revisit in 2027 if user use cases shift.

---

## Pointers

- **Memex's LongMemEval baseline:** [`005-longmemeval-baseline.md`](./005-longmemeval-baseline.md) — note: numbers should be re-read in light of §5.1 (reproducibility crisis).
- **Two-problems architecture (multi-device daemon + scoping):** [`../plans/two-problems-architecture.md`](../plans/two-problems-architecture.md) — Problem 1 is multi-agent memory consistency (§8); Problem 2's provenance design is consistent with the field.
- **Unified pipeline design:** [`004-unified-pipeline-design.md`](./004-unified-pipeline-design.md)
- **Ranking mathematics:** [`002-ranking-mathematics.md`](./002-ranking-mathematics.md)
- **Extraction model comparison:** [`001-extraction-model-comparison.md`](./001-extraction-model-comparison.md)
