# Memex Recall Validation: Gaps, Criteria, and Improvement Plan

**Superseded by:** [recall-quality-design.md](../recall-quality-design.md) — canonical spec.
**Status:** REVISED (iteration 3 -- addresses 16 critique points from third adversarial review: 7 critical, 6 major, 3 minor). All claims cite file:line sources verified 2026-07-01. Target audience: engineering team that owns the eval and retrieval pipelines.

---

## 1. What "Good Recall" Means

A memory retrieval system is "good" when it returns the _right_ memories, at the _right_ rank, with _honest_ confidence, for _real_ traffic, under _realistic noise_, _knows when to say nothing_, _across all scope cardinalities_, and _its quality is measured on the code path users actually hit, with verified collection mechanisms_. The current evals measure a narrow slice of this. The full validation surface is:

### 1.1 Ranking Quality

**nDCG@k with graded relevance** on production-like data. R@k binary hit/miss (the current primary metric) cannot distinguish "relevant at rank 1" from "relevant at rank 5 buried under 4 junk entries." In a fixed-N-item payload sent to a referring agent, rank order determines what the agent actually reads.

- **Metric:** nDCG@5 (position-aware, graded relevance). Also Precision@1, MRR. nDCG@5 on production-config retrievals is the **pre-registered primary metric** for all config changes; all other metrics are exploratory (Section 4.10).
- **Why it matters:** The live failure mode is not "the right memory is missing from top-5" -- it is "the right memory is rank 4 and a leaked CoT fragment is rank 1." R@k=100% on top-5 can coexist with top-1=20%.
- **Source:** `tests/helpers/ir-metrics.ts:36-56` already implements nDCG@k with graded relevance (exponential gain `2^rel - 1`). It is defined but never wired into any quality eval outside of BEIR.

### 1.2 Score Calibration (Trust Thresholds)

A retrieval score of 0.73 should mean something consistent across queries. Without calibration, the agent cannot know whether to trust a result or ignore it.

- **Metric:** Expected Calibration Error (ECE) on retrieval scores vs. binary relevance. Also: what fraction of scored-above-0.6 results are actually relevant?
- **Why it matters:** The junk-magnet problem (`ca1b32c6` scores ~0.7 on unrelated queries) is a _calibration_ failure: noise entries achieve scores in the range the agent treats as trustworthy. A calibrated system would score junk near 0.15 and signal near 0.65, with a clean decision boundary.
- **Source:** RAGConf (arXiv:2405.16621), Calibrating RAG (arXiv:2403.06964). Both propose lightweight calibrators combining retrieval confidence with token probabilities.

### 1.3 Abstention-Correctness (with False-Negative Measurement)

The system must know when it has no useful answer and return empty (or near-empty) results. This MUST be evaluated as a two-sided tradeoff, not a one-sided "filter junk" metric.

- **Metrics:**
  - **Precision@empty:** fraction of abstentions that would have been wrong (correct abstentions).
  - **Recall@empty (false-negative rate):** fraction of abstentions where relevant information DID exist in the DB but scored below threshold. This is the context-starvation metric -- measuring ONLY precision@empty hides the recall loss.
  - **Coverage:** fraction of legitimate queries that return >=1 result.
  - **Abstention precision-recall curve:** at each threshold, compute precision and recall of the abstention _decision_ itself (treating "should return results" as the positive class). Optimal threshold maximizes F1 of the abstention decision, not `coverage * (1 - abstention_rate)`.
- **Why it matters:** memex fields dozens of irrelevant speculative recall queries daily. A system that always returns 5 results -- 4 junk -- passes R@k=100% if the 1 relevant entry appears anywhere. The user experience is top-1 garbage. But over-filtering starves legitimate queries of context: if hardMinScore=0.40 and typical top-result scores range from 0.35-0.55 (plausible for weighted fusion), the effective floor `max(best*0.3, 0.40)` could filter ALL results for moderate-signal queries, dropping coverage to 40-60%. Neither side of this tradeoff has been measured.
- **Source:** Conformal Retrieval (Angelopoulos et al., 2024), Conformal Abstention (Gupta et al., 2024). The `applyAdaptiveMinScore` method (retriever.ts:881-888) already filters below `max(best*0.3, 0.15)` -- a near-zero bar. The typed `hardMinScore: 0.40` (retriever.ts:108,162) is dead config (never wired; see Gap 11).

### 1.4 Noise-Robustness

The system must maintain quality under adversarial memory pool conditions: duplicates, contradictions, near-duplicate-but-wrong facts, and irrelevant keyword-matched decoys.

- **Metrics:** Recall degradation under injected pollution (PoisonedRAG methodology). Selective Forgetting score from MemoryAgentBench taxonomy.
- **Why it matters:** The production DB accumulates auto-captured CoT fragments, conversation noise, and stale facts -- currently ~2100 entries and growing. The evals use clean, ephemeral, 53-document stores with zero pollution. The ratio of junk-to-signal is the dominant variable in real recall quality, and evals set it to near-zero.
- **Source:** MemoryAgentBench (arXiv:2507.05257) defines 4 competencies including Selective Forgetting -- the hardest competency (all systems score <= 7% on multi-hop FactConsolidation). PoisonedRAG and SafeRAG benchmarks formalize adversarial injection into vector stores.

### 1.5 Production-Fidelity

The _exact_ code path that serves users must be the one measured. This means the same class, the same config, the same database.

- **Metrics:** All of the above, measured on `MemoryRetriever` (not `UnifiedRetriever`), with the MCP production config (`fusionMethod: "weighted"`, `vectorWeight: 0.7`, `bm25Weight: 0.3`, `rerank: "none"`), against a production-scale DB (not a fresh temp DB per example).
- **Why it matters:** No quality eval currently tests the production config. domain-eval.ts and LongMemEval both use `fusionMethod: "zscore"` with different weights. The BEIR benchmark calls `hybridQuery()` from `src/search.ts` -- a completely different code path (RRF fusion, built-in reranker) that does not go through `MemoryRetriever.retrieve()` at all. The `UnifiedRetriever` mixed-source path has zero quality-eval coverage. Only latency-probe.ts and unified-retriever-benchmark.test.ts touch `UnifiedRetriever`, and neither measures retrieval quality. Additionally, four code paths totaling 333 lines have zero quality coverage (Section 2.2): `adaptive-retrieval.ts` (99 lines, binary serve-or-skip gate), `recall-cache.ts` (89 lines, cache staleness), `debug-recall.ts` (145 lines, MEMEX_DEBUG_RECALL), and the BM25-only fallback in mcp-server.ts:266.
- **Source:** mcp-server.ts:56-57 (`rerank: "none"` hardcoded, `mode: "hybrid"`, all other params default from DEFAULT_RETRIEVAL_CONFIG); retriever.ts:148-152 (DEFAULT uses weighted fusion, 0.7/0.3); domain-eval.ts:160-164 (eval uses zscore, 0.8/0.2); beir-benchmark.ts:192-197 (calls hybridQuery() directly, not retriever.retrieve()); latency-probe.ts:72-76 (tests UnifiedRetriever latency but not quality).

### 1.6 Multi-Session / Temporal

Facts recalled at session N+1 must be consistent with sessions 1..N. Recency and time-decay must help, not hurt.

- **Metrics:** Temporal recall degradation curve (recall of fact at +1 session, +5 sessions, +20 sessions). Separate tracking of fresh vs. stale fact recall.
- **Why it matters:** Temporal effects are disabled in LongMemEval (`recencyHalfLifeDays: 0, recencyWeight: 0, timeDecayHalfLifeDays: 0` in longmemeval-benchmark.ts:374-376). The production failure mode -- "new irrelevant memory +0.09 recency floats to 0.72 while old relevant fact sinks to 0.30" -- is never tested.
- **Source:** LoCoMo benchmark (arXiv:2403.16777), MemoryAgentBench FactConsolidation-MH (o4-mini degrades from 80.0 at 6K to 14.0 at 32K context).

### 1.7 Distribution Transfer (Production Relevance)

Benchmark results only matter if the benchmark data resembles production traffic. Vocabulary overlap alone is near-useless for IR transfer analysis -- two corpora can have identical word distributions but completely different relevance patterns.

- **Metrics:**
  - Embedding-space distribution comparison: compute pairwise cosine similarities within-corpus vs. cross-corpus on 100 random production memories and 100 random BEIR passages. Test for significant difference using a two-sample Kolmogorov-Smirnov test.
  - If production query logs exist: compute BEIR-query-to-production-memory relevance rate (what fraction of BEIR queries retrieve relevant memories from the production DB).
  - BM25 degradation ratio: (nDCG_memex - nDCG_BM25)_production vs. (nDCG_memex - nDCG_BM25)_BEIR. Measures relative performance degradation when moving from one domain to another against a shared BM25 baseline. This avoids the false ratio-scale assumptions of dividing raw nDCG values from different query sets.
- **Why it matters:** BEIR uses SciFact (scientific claims), FiQA (financial Q&A), and NQ (natural questions) -- zero overlap with memex's actual traffic (developer conversations, system config, preferences, tooling Q&A). Results may not transfer. BEIR's own paper (Thakur et al., 2021) and TREC transfer-learning literature document this risk extensively.
- **Source:** BEIR paper (Thakur et al., 2021), TREC transfer-learning meta-analyses. The KS test directly answers "are these distributions different?" without requiring ratio-scale assumptions.

### 1.8 E2E Attribution (Retrieval Contribution Isolation)

Published E2E accuracy numbers conflate retrieval quality with the LLM's ability to infer plausible answers without retrieved context. For LongMemEval specifically, the dataset uses **synthetic chat histories** -- questions ask about facts from conversations that never existed in training data (e.g., "What did the user say about their preference for X?"). GPT-4o cannot "know" these answers from pre-training. The confound is different: the LLM may **infer plausible answers** from general reasoning patterns and persona-modeling, even without the specific memory. This is a retrieval-complement effect (the LLM fills gaps with plausible inference), not a training-data-contamination effect.

However, for any factual/public-knowledge subset that may exist in the dataset, the training-data confound is real. These question types should be analyzed separately.

- **Metric:** E2E_delta = E2E_with_retrieval - E2E_with_zero_context. The delta isolates retrieval contribution from LLM inference ability. Run as three conditions (see Section 4.1.4): zero-context, irrelevant-context (top-5 from a different random session), and correct-context. This decomposes the total delta into hallucination-prevention (irrelevant minus zero) and knowledge-filling (correct minus irrelevant).
- **Two-stage citation verification (attention-attribution check):**
  - **Stage 1 (existence):** For each correct E2E answer, ask the LLM to cite which specific passage from the injected context supports its answer. Verify the cited passage EXISTS in the retrieved payload.
  - **Stage 2 (entailment):** For each cited passage, use an NLI model (or a separate LLM judge with an entailment prompt) to judge: "Does this passage entail or support this answer?" Binary entailment judgment.
  - **Citation-verified rate:** fraction of answers where (a) at least one passage is cited AND (b) at least one cited passage is judged as entailing the answer. This avoids the false-positive problem where passage-existence checking alone passes citations to irrelevant but present passages.
  - **Documented limitation:** Even this two-stage check has imperfect recall for genuine multi-hop reasoning where no single passage is sufficient to entail the answer. Report a separate "multi-hop" annotation for answers requiring synthesis across multiple passages.
- **Why it matters:** The 94% headline E2E number in PROGRESS.md may substantially overstate retrieval quality. The delta from no-context isolates what retrieval actually contributes beyond the LLM's inference ability. Decomposing into hallucination-prevention vs. knowledge-filling shows whether retrieval helps by providing facts or just by keeping the LLM grounded.
- **Source:** longmemeval-benchmark.ts:501 (system prompt "Answer the question based ONLY on the provided conversation history"), longmemeval-benchmark.ts:213-237 (substring-match answer checking, not entailment-based). LongMemEval paper (Maharana et al., 2024) confirms synthetic construction methodology.

### 1.9 Live-Production Quality (the metric users experience)

No current benchmark samples actual production recall queries. All proposed benchmarks use hand-curated queries, synthetic chat histories, or generated noise. After implementing all validation items, the team still won't know whether users get better results -- only whether synthetic metrics improved. **Critically, the sampling source (MEMEX_DEBUG_RECALL logs) suffers from survivorship bias: it only contains queries where the system decided to retrieve.** Queries blocked by adaptive-retrieval.ts skip logic, queries routed to the BM25-only fallback path, and queries where the embedder was unavailable are ALL absent from the log.

- **Metric:** Live-recall nDCG@5. Sample 100 actual production recall queries from both the MCP path (MEMEX_DEBUG_RECALL logs) AND the auto-recall hook path (index.ts:1344), since these are different code paths with different skip logic. Have a human or strong LLM judge the top-5 results for each query on a 0-3 relevance scale (0=irrelevant, 1=tangential, 2=relevant, 3=directly-answers). Compute nDCG@5 with graded relevance. Run BEFORE and AFTER any config changes.
- **Denominator audit (CRITICAL):** For each sampled period, compute three counts: (a) total user turns, (b) turns where retrieval was attempted, (c) turns with DEBUG_RECALL output. Report **coverage = retrieval-attempted / total-turns** alongside nDCG@5. If coverage < 80%, the nDCG@5 number overstates user-experienced quality because 20%+ of queries are silently not served. A system that drops 40% of queries but does well on the remaining 60% looks great in biased sampling.
- **Collection mechanism validation (Step 0):** Before using DEBUG_RECALL as a data source, validate the collection mechanism: seed 10 known memories, run 10 known queries, capture DEBUG_RECALL output, verify the JSON contains the expected queries, result IDs, and injected context. If debug-recall.ts (which has zero test coverage per Section 2.3) has a bug -- writes wrong query text, truncates results, misses certain code paths -- the live-sampling data is silently corrupted. Add this validation as a CI smoke test.
- **Why it matters:** This is the ONLY metric that directly answers "are users getting good results?" It is the evaluation equivalent of "test the code path users actually hit." All other metrics are proxy signals that may or may not correlate with user experience. The denominator audit ensures the sampling is honest.
- **Source:** Standard IR evaluation practice (TREC-style pooled judgment with human relevance labels); the novelty here is applying it to the production retrieval path with coverage auditing rather than a synthetic benchmark.

### 1.10 Scoped Retrieval

The `memory_recall` tool accepts a `scopes` parameter that dramatically changes the candidate pool. All calibration thresholds (hardMinScore, abstention thresholds, score calibration) are derived assuming full-DB retrieval. A query with `scopes: ['project-foo']` operates on a much smaller, topically-homogeneous pool with different score distributions, different optimal thresholds, and different noise characteristics.

- **Metrics:** Score distribution comparison across scope cardinalities. Abstention threshold sweep at 3 levels: single-scope (e.g., `['project-foo']`), multi-scope (e.g., `['global', 'alex']`), and unscoped (full DB). Per-cardinality optimal hardMinScore.
- **Why it matters:** A hardMinScore of e.g. 0.35 derived on full-DB may be far too aggressive for scoped queries with a small candidate pool (causing context starvation -- zero results when relevant memories exist), or too permissive (causing noise injection when the homogeneous pool has many high-scoring irrelevant entries). If optimal hardMinScore differs by >0.10 across scope cardinalities, per-cardinality thresholds (or a scoped-aware adaptive floor) are needed.
- **Source:** `memory_recall` tool schema accepts `scopes: string[]`. `MemoryRetriever.retrieve()` applies scope filtering early in the pipeline (retriever.ts:344-352), reducing the candidate pool before fusion and scoring. No existing eval measures quality at different scope cardinalities.

---

## 2. Current Eval Inventory

### 2.1 Quality Evaluations (measure retrieval correctness)

| Eval | Code Path | Config (fusion, rerank) | Data | Metrics | N | Production-Fidelity |
|---|---|---|---|---|---|---|
| **domain-eval.ts** | `MemoryRetriever.retrieve()` (domain-eval.ts:187) | zscore, 0.8/0.2, **rerank:none** (domain-eval.ts:160-165) | 15 hand-curated queries, live production DB | Binary hit/miss (substring match in top-3 joined text) (domain-eval.ts:193-197) | 15 | **Partial.** Same retriever class as production (`MemoryRetriever`), real DB, but wrong config (zscore vs. weighted fusion, different weights, minScore 0.05 vs 0.3). Rerank opt-in via `RERANK=1`. |
| **longmemeval-benchmark.ts** | `MemoryRetriever.retrieve()` (longmemeval-benchmark.ts:385) | zscore, 0.8/0.2, **rerank:none** (longmemeval-benchmark.ts:356-363) | LongMemEval_s_cleaned.json (50 synthetic chat-history QA) | R@1/R@3/R@5/R@10 + E2E (LLM reader, substring match) (longmemeval-benchmark.ts:407-410, 500-540) | 50 | **None.** Fresh temp DB per example (longmemeval-benchmark.ts:273-274, 413), 53-doc clean corpus, temporal disabled, noise disabled. Wrong config. Rerank opt-in via `RERANK=1`. **E2E conflated with LLM inference ability** (no no-context baseline subtracted; LLM may infer plausible answers from persona-modeling without retrieved context). |
| **fast-benchmark.ts** (pipeline tier) | `MemoryRetriever.retrieve()` | Same as LongMemEval | Same LongMemEval dataset, cached vectors | Same as LongMemEval | 50 | None (same as above, plus pre-computed vectors bypass embedding) |
| **fast-benchmark.ts** (fast tier) | Pure fusion math simulation | N/A (no real retriever) | Pre-computed vector scores from cache | Same as above | 50 | Zero (no production code exercised) |
| **beir-benchmark.ts** | `hybridQuery()` from `src/search.ts` (beir-benchmark.ts:192-194) | RRF fusion, **reranker always on internally** (search.ts:3490) | BEIR fiqa/scifact/nq from HuggingFace | nDCG@10, MRR, R@5, R@10 (beir-eval.ts:33-36, 57-63) | 50-300 per dataset | **None.** Different code path entirely (`src/search.ts` standalone, not via retriever). Fresh temp DB per dataset (beir-benchmark.ts:148). **Document-only** -- no memories, no mixed-source. Reranker always on (cannot be disabled without editing search.ts). |

### 2.2 Performance Evaluations (measure latency only, zero retrieval quality)

| Eval | Code Path | What It Measures |
|---|---|---|
| **benchmark.ts** | Individual components: embedQuery, embedPassage, embedBatch, rerank, store-entry, vector-search, bm25-search, retriever-hybrid+rerank, unified-recall-conv-only, adaptive-skip-check | p50/p90/p95/mean wall-clock latency (10 iterations, 2 warmup) |
| **latency-probe.ts** | `UnifiedRetriever` (latency-probe.ts:72-76) -- real embedder, real DB, reranker ON by default (`RERANK !== "0"`) | p50/p90/p95/mean/min/max wall-clock latency on 8 hand-picked queries x 3 iterations |
| **unified-retriever-benchmark.test.ts** | `UnifiedRetriever` with mock embedders, mock rerankers | API call count (embed, rerank), pipeline latency with mocks, routing correctness (memory-only vs. doc-only vs. mixed vs. skip) |

### 2.3 Source Files With Zero Quality-Eval Coverage (not just performance paths)

These files contain decision logic that affects whether users receive results at all, or which results they receive, but have no quality-eval coverage:

| File | Lines | What It Does | Why It Matters |
|---|---|---|---|
| **adaptive-retrieval.ts** | 99 | Binary serve-or-skip gate: decides whether to even run retrieval for a given query. Uses regex patterns (SKIP_PATTERNS, FORCE_RETRIEVE_PATTERNS) to classify queries. | A bug here means users get empty results for ALL queries of a certain pattern. A false-positive skip on "what did I say about X?" starves the user of needed context. No eval tests the skip logic against answerable vs. unanswerable queries. |
| **recall-cache.ts** | 89 | Caches retrieval results to avoid re-embedding. Returns stale results on cache hit. | Staleness regression: a cache hit that returns results from a previous query could inject irrelevant context. No test verifies cache-hit results match cache-miss results. |
| **debug-recall.ts** | 145 | MEMEX_DEBUG_RECALL path: writes per-turn JSON snapshots of injected recall payload to `${tmpdir}/memex-debug-recall/`. | If this path has a bug (e.g., writes wrong payload), production debugging is compromised. This is also the planned source for live-recall quality sampling (Section 1.9) -- if the collection mechanism is unvalidated, the live-sampling data is silently corrupted. |
| **mcp-server.ts:266** (BM25-only fallback) | ~15 | When no embedder is configured, the MCP server falls back to pure BM25. **BM25 scores are unbounded, not normalized to [0,1] like vector cosine similarity.** Any `minScore` or `hardMinScore` threshold calibrated on the hybrid path is meaningless for BM25-only results. | This path has zero quality testing. Users without an embedding API key get BM25-only results with thresholds designed for a different score space. If the team deploys without an embedder, they unknowingly ship an unevaluated, differently-calibrated retrieval path. |

### 2.4 Metric Unit-Test Wrappers (test metrics implementations, not retrieval quality)

| File | What |
|---|---|
| `tests/helpers/ir-metrics.ts` | Pure functions: recallAtK, precisionAtK, mrr, ndcgAtK |
| `tests/ir-metrics.test.ts` | Unit tests for the above (no retrieval involved) |
| `tests/helpers/beir-eval.ts` | evaluateBeirQuery (wraps ir-metrics for BEIR-style qrels), summarizeBeirQueries (simple arithmetic mean, no CIs) |
| `tests/beir-eval.test.ts` | Unit tests for evaluateBeirQuery (no retrieval involved) |

### 2.5 Design Doc (scoped, never implemented)

| Doc | What It Proposed |
|---|---|
| `docs/design/production-benchmark.md` (issue #19) | BEIR-based document-retrieval benchmark using `UnifiedRetriever` path. Proposed but all 7 checklist items remain unchecked. Would test the document side of the mixed-source path but would NOT test `MemoryRetriever` (the actual MCP production path for memory_recall). |

---

## 3. Gaps: Why Published Metrics Coexist With a Junk-Magnet Live System

### Gap 1: Production code path is never quality-tested

- **Blind spot:** The MCP `memory_recall` handler (mcp-server.ts:57) creates a `MemoryRetriever` with `{ mode: "hybrid", rerank: "none" }`, which inherits `fusionMethod: "weighted"`, `vectorWeight: 0.7`, `bm25Weight: 0.3` from `DEFAULT_RETRIEVAL_CONFIG` (retriever.ts:148-152). **Zero quality evals test this exact configuration.** domain-eval.ts and LongMemEval both use `MemoryRetriever` with `fusionMethod: "zscore"`, `vectorWeight: 0.8`, `bm25Weight: 0.2`, `minScore: 0.05` -- a different and arguably better fusion pipeline. The BEIR benchmark calls `hybridQuery()` from `src/search.ts`, which uses RRF fusion with a built-in reranker -- a third, completely different code path. The `UnifiedRetriever` (mixed-source path) has zero quality-eval coverage; only latency-probe.ts and unified-retriever-benchmark.test.ts touch it, and neither measures correctness.
- **Impact:** If a bug degrades `MemoryRetriever`'s weighted fusion (the actual production path), no eval catches it. If a config change accidentally flips `rerank` from "none" to "cross-encoder" (the DEFAULT, retriever.ts:154), users would get different results but evals would stay green. The entire eval suite tests a _better_ pipeline than what users get.
- **What's needed:** An eval that runs the exact MCP production config (`weighted` fusion, 0.7/0.3, `rerank: "none"`, `minScore: 0.3`) through `MemoryRetriever.retrieve()` against a known corpus. Report both the production-config number AND the eval-optimal-config number as separate columns.

### Gap 2: Corpus composition -- evals use clean ephemeral stores; production is polluted

- **Blind spot:** LongMemEval creates a fresh temp DB per example, indexes only 53 haystack sessions, then destroys it (longmemeval-benchmark.ts:273-274, 413). BEIR creates a fresh temp DB per dataset (beir-benchmark.ts:148). The production DB has ~2100 auto-captured memories including CoT fragments, conversation noise, and leaked internal reasoning. The ratio of junk-to-signal is the dominant variable in real recall quality, and evals set it to near-zero.
- **Impact:** R@3=90% on a 53-document clean corpus does not predict behavior on a 2100-document polluted store. A system that always returns 5 results with 4 junk can achieve R@k=100% if the 1 relevant entry appears anywhere.
- **What's needed:** A noisy-store benchmark: take the live production DB, run known-answer queries, report recall before and after dreaming cycles. Hard-code this into a repeatable benchmark script with tracked metrics. Also a synthetic pollution-injection benchmark that injects controlled noise types and measures degradation curves.

### Gap 3: Metric mismatch -- R@k binary recall vs. top-1 calibration and precision

- **Blind spot:** domain-eval.ts:193-197 checks "does substring X appear ANYWHERE in top-3 joined text?" (binary hit/miss). longmemeval-benchmark.ts:390-394 checks "does any answer_session_id appear in top-K session IDs?" Neither measures score calibration, precision@1, or whether junk outranks signal. nDCG is implemented in ir-metrics.ts:36-56 but never wired into any quality eval. beir-benchmark.ts reports nDCG@10 via beir-eval.ts but the independent `hybridQuery()` code path means those numbers don't describe production behavior.
- **Impact:** The live failure mode is `ca1b32c6` (a leaked CoT fragment) topping 5 unrelated queries at ~0.7 score. R@3=90% can be true while precision@1 is 30%. The agent trusts the ranking order; if rank-1 is garbage, the agent ignores rank-4 (which may contain the right answer).
- **What's needed:** nDCG@5, precision@1, and calibration error measured on production-config retrievals. Wire the existing ir-metrics functions into domain-eval.ts and all new benchmarks.

### Gap 4: Config drift -- eval config is strictly better than production config

- **Blind spot:** Production `memory_recall` uses **weighted fusion** with 0.7/0.3 weights and **no reranker** (mcp-server.ts:57 + retriever.ts:148-152). Domain eval and LongMemEval use **zscore fusion** with 0.8/0.2 weights and **no reranker** (by default). Weighted fusion blends cosine [0,1] with unbounded BM25 on incompatible scales -- a known-broken configuration that the retrieval-redesign spec explicitly advocates replacing with zscore. The evals are already using the better fusion method. When an eval says "80% hit rate," it describes a pipeline that is more robust than what users get.
- **Impact:** The production pipeline is objectively worse than what is measured. Config drift means eval numbers are inflated relative to user experience.
- **What's needed:** Either (a) align production config to eval config (switch MCP to zscore fusion per the retrieval-redesign spec), or (b) run evals against production config so numbers reflect reality. Option (a) is preferred -- if zscore is provably better, ship it. Either way, document the config gap explicitly. **Note:** F11 (config alignment) is estimated at 2-4 hours, not 15 minutes, when verification and monitoring are included. Any fusion-method change in production requires: re-running all benchmarks, verifying no behavioral regressions, monitoring production abstention rate for 48 hours, and preparing a rollback plan.

### Gap 5: Reranker story is inconsistent and misleading

- **Blind spot:** The MCP server hardcodes `rerank: "none"` (mcp-server.ts:57). `DEFAULT_RETRIEVAL_CONFIG` has `rerank: "cross-encoder"` (retriever.ts:154). LongMemEval hides reranker behind `RERANK=1` env var (default off). domain-eval hides it behind `RERANK=1` (default off). The BEIR benchmark always enables the reranker internally via `hybridQuery()` (search.ts:3490). Published metrics from LongMemEval show an 82% R@1 _with_ reranker (via `RERANK=1`), but the no-reranker number (~78%) is what users actually experience. The claimed 4pp improvement is presented as a headline but represents a code path users never hit. With N=50, the 95% CI spans roughly +/- 5.4pp -- the 4pp delta is within sampling noise.
- **Impact:** Published benchmarks report reranker-on numbers. Production runs reranker-off. Users experience the lower number. The 82% R@1 figure is a prospective upgrade figure, not a current-capability figure. The 4pp delta cannot be statistically distinguished from zero without larger N or confidence intervals.
- **What's needed:** Report the production-config (rerank:none) number as the primary metric in all published benchmarks. Include reranker-on as a separate "with reranker upgrade" column. Either re-enable reranking in the MCP retriever config and re-benchmark, or stop reporting reranker numbers as the primary result.

### Gap 6: BEIR benchmark mislabeled as "production mixed-source"

- **Blind spot:** The original design doc (production-benchmark.md) and prior analysis drafts labeled BEIR as a "production mixed-source" track. The BEIR benchmark (beir-benchmark.ts) is **pure document retrieval**: it calls `hybridQuery()` from `src/search.ts`, which goes through the document-search stack (FTS, vector search, RRF fusion, chunk selection, reranking). It never creates a `MemoryRetriever`, never calls `UnifiedRetriever`, never stores or retrieves a single memory, and never fuses memory+document results. The "mixed-source" label is factually incorrect.
- **Impact:** Readers of the benchmark report would believe they are seeing a metric that reflects the fused memory+document path. They are not. This misrepresents the evaluation coverage and creates a false sense that the mixed-source pipeline has been benchmarked.
- **What's needed:** Rename the BEIR track to **"Document Retrieval (BEIR subset)"**. For genuine mixed-source benchmarking, implement issue #19 as a `UnifiedRetriever`-based eval, or separately seed memories alongside documents and measure the fused path through `MemoryRetriever.retrieve()`.

### Gap 7: No temporal/recency effects in evals

- **Blind spot:** Temporal effects are explicitly zeroed in LongMemEval: `recencyHalfLifeDays: 0, recencyWeight: 0, timeDecayHalfLifeDays: 0` (longmemeval-benchmark.ts:374-376). This is correct for the benchmark (all sessions indexed at the same time) but means the "double temporal penalty" failure mode is never exercised.
- **Impact:** The production failure where a brand-new irrelevant memory gets +0.09 recency boost and floats to ~0.72 while an old relevant fact sinks to ~0.30 cannot appear in LongMemEval results. domain-eval.ts runs against live DB with real timestamps, so temporal effects ARE active there, but the eval only checks binary presence in top-3 joined text -- it can't distinguish rank-ordering failures caused by recency boost.
- **What's needed:** A staggered-index benchmark: index memories at timestamps -30d, -14d, -7d, -1d, and "now." Query for old facts. Measure recall with timeDecay and recencyWeight swept through a range. Find the optimal defaults empirically.

### Gap 8: No abstention or noise-robustness measurement

- **Blind spot:** Zero eval queries are designed to return empty. domain-eval.ts has 15 queries all with expected substrings (except one temporal query that only checks `retrieved.length > 0`, domain-eval.ts:192). LongMemEval has 50 questions all with ground-truth answers. There is no measurement of false-positive rate, over-retrieval rate, or whether the system knows when it doesn't know. Crucially, the false-negative side of abstention is also unmeasured: no test checks whether the system abstains on queries where relevant memories DO exist.
- **Impact:** memex fields dozens of irrelevant speculative recall queries daily. A system that always returns 5 results -- 4 junk -- can achieve R@k=100% if the 1 relevant entry appears anywhere in the payload. The evals reward this behavior. At the same time, an over-aggressive threshold starves legitimate queries of context -- and no eval would detect this regression either.
- **What's needed:** True IR negatives (not "guaranteed absent" queries -- see Section 4.2 for methodology): sample production queries, have a strong judge label each top-5 result, and designate queries where ALL results score 0 as the negative set. Measure the score distribution of top-1 results on negative queries vs. positive queries. The gap between distributions should be large and consistent. Also measure false negatives on positive queries: for queries where the system returns empty, manually verify whether relevant memories exist. Report the full precision-recall curve of the abstention decision, not just coverage vs. abstention rate. Add an abstention threshold sweep to find the optimal `hardMinScore` value empirically. **Extend to scoped queries** at 3 scope-cardinality levels: single-scope, multi-scope, and unscoped (Section 1.10).

### Gap 9: Small-N with no confidence intervals -- and overstated familywise error rate

- **Blind spot:** domain-eval N=15 (domain-eval.ts:36-137). LongMemEval N=50 split across ~5 question types = ~10 per type (longmemeval-benchmark.ts:57). BEIR N=50 per dataset (beir-benchmark.ts:44). summarizeBeirQueries() in beir-eval.ts:40-63 computes simple arithmetic means with no variance reporting. Point estimates are reported without confidence intervals.
- **Impact:** 12/15 = 80% has a 95% Wilson CI of approximately [52%, 96%] -- margin of error near +/- 22%. A version-to-version delta of "R@1 went from 78% to 82%" on N=50 (with standard error ~5.4pp) gives a 95% CI spanning roughly [71%, 93%]. The claimed 4pp improvement from reranking is well within sampling noise. Decisions based on these deltas are indistinguishable from coin flips. **Multiple comparison correction must account for correlation:** the naive FWER calculation `1 - 0.95^30 = 78%` assumes 30 independent comparisons, but metrics computed on the same queries (nDCG@5, precision@1, MRR, R@1, R@3, R@5, R@10 for the same retrieval run) are highly correlated -- nDCG@5 and R@5 share the same numerator structure. The true FWER under correlation is substantially lower. A resampling-based max-T correction (bootstrap all metrics, find maximum deviation from null in each resample, 95th percentile of max distribution is the multiplicity-adjusted critical value) automatically accounts for correlation.
- **What's needed:** Bootstrap 95% CIs (1000 resamples) on all reported metrics. For paired comparisons (reranker on/off), use McNemar's test or paired bootstrap. Pre-register ONE primary metric (nDCG@5 on production config) and ONE secondary metric (abstention-aware precision). All other metrics are exploratory and must be reported with Benjamini-Hochberg FDR control at q=0.10 (not Bonferroni -- FDR controls the proportion of false positives among claimed discoveries, which is appropriate for exploratory analysis; Bonferroni controls FWER and is so conservative at 30 metrics it guarantees no exploratory finding will ever pass, making it self-censorship). Report both raw and BH-adjusted p-values. Alternatively, adopt pure pre-registration: exactly 2 pre-registered metrics with unadjusted CIs, all others descriptive-only with no significance claims. Also compute the minimum detectable effect size at N=50 with 80% power BEFORE running benchmarks so the team knows what effect sizes the eval CAN and CANNOT detect.

### Gap 10: No MCP tool code path coverage (and recordRecalls is a data-corruption bug, not just a metrics gap)

- **Blind spot:** Zero eval imports or references `mcp-server.ts`, MCP tool handlers, or the `memory_dream`/`memory_recall`/`memory_store`/`memory_forget`/`memory_stats` infrastructure. The `memory_recall` handler (mcp-server.ts:245-261) returns results but never calls `store.recordRecalls()` -- the `recall_count` column (memory.ts:222, 848-852) stays at 0/NULL for all MCP-recalled memories. The ONLY caller of `recordRecalls` is `index.ts:1344` (the auto-recall hook path). **This is a data-corruption bug, not merely a missing metric:**
  - The dreaming pipeline (dreaming.ts:143-158) uses `recall_count` to boost frequently-recalled entries to importance >=0.5 or >=0.7, and to decay never-recalled entries (dreaming.ts:168-172: importance clamped to <=0.3 after 30 days, <=0.1 after 90 days).
  - The dreaming health metric (dreaming.ts:579-580) queries `COUNT(*) WHERE recall_count IS NULL OR recall_count = 0` -- because MCP never records recalls, nearly ALL memories show as "never recalled."
  - Session imports with `recalls === 0` get aggressive decay at 14 days and eviction at 30 days (dreaming.ts:178-184). Memories actively consumed via the MCP tool may be deleted because the system believes they were never used.
  - **Existing test `intake-guards.test.ts:301-345` tests `recordRecalls` behavior directly** -- but this unit test only proves the method works when called; it doesn't catch that the MCP path never calls it.
- **Impact:** Memory quality degrades over time as dreaming deprioritizes and evicts memories that users actively consume via the MCP tool. The `never_recalled_ratio` health metric is systematically inflated. Existing memories with `recall_count=0` may already have been deprioritized or deleted. This is a feedback-loop corruption bug that has existed for the entire v0.7 cycle.
- **What's needed:** (a) Add `store.recordRecalls(results.map(r => r.entry.id))` after mcp-server.ts:246. (b) Backfill `recall_count` for existing memories (set to 1 for any memory that has been retrieved, or at minimum mark them so dreaming doesn't treat them as never-used). (c) Add an integration test: call `memory_recall` via MCP, verify `recall_count` is non-zero afterwards. (d) Audit dreaming's existing decay decisions -- how many memories have already been deprioritized with `recall_count=0` that were actually MCP-recalled?

### Gap 11: hardMinScore is dead config -- and tests are vacuously true (with quantified effective floor)

- **Blind spot:** `hardMinScore: 0.40` is typed and defaulted in `RetrievalConfig` (retriever.ts:108) and `DEFAULT_RETRIEVAL_CONFIG` (retriever.ts:162) but never read anywhere outside its own definition. `applyAdaptiveMinScore` (retriever.ts:881-888) hardcodes `max(best*0.3, 0.15)` -- a near-zero absolute floor. The variable `this.config.hardMinScore` is never referenced in the method body.
- **The effective floor is NOT a constant 0.15.** The hardcoded expression is `max(best*0.3, 0.15)` -- the floor depends on the top result's score. For queries where `best > 0.5`, the effective floor is `best*0.3 > 0.15` (e.g., `best=0.8` implies `floor=0.24`). For queries where `best=0.2`, the floor is `max(0.06, 0.15)=0.15`. **The claim "tests with hardMinScore=0.0 run with floor=0.15" is only true when `best <= 0.5`.** For strong queries, the floor is higher and more results are filtered than implied.
- **Critical testing implication:** **8+ test files set `hardMinScore` to specific values** that are silently ignored:
  - tools-scoping.test.ts:66 (`hardMinScore: 0.0`)
  - retriever-rerank-fallback.test.ts:112, 127, 178 (`hardMinScore: 0.0`)
  - retriever-rerank-blend-weight.test.ts:71, 172, 190, 245, 262 (`hardMinScore: 0.0`)
  - acceptance-temporal-queries.test.ts:192 (`hardMinScore: 0`)
  - longmemeval-benchmark.ts:373 (`hardMinScore: 0.10`)
  - fast-benchmark.ts:401 (`hardMinScore: 0.10`)
  **To properly audit these, the effective floor must be quantified per test:** instrument `applyAdaptiveMinScore` during a test run to log the actual effective floor value `max(best*0.3, 0.15)` for each query, then report the min/mean/max effective floor. Tests where effective floor exceeds 0.20 for >50% of queries are the ones where assertions are most likely invalid and should be audited first. Tests that pass despite an unexpected score floor may indicate that the filtering is actually harmless for those particular query-result pairs -- useful information for calibration.
- **Impact:** The retrieval-redesign spec's top-priority fix (raise the confidence floor to 0.40) is a one-line wiring change that has been dead config for the entire v0.7 cycle. No eval measures the impact of this floor because no eval measures calibration or abstention. Test assertions that depend on `hardMinScore=0.0` behavior are unvalidated and the actual floor varies per query depending on the best score.
- **What's needed:** (a) Instrument each test that sets `hardMinScore` with effective-floor logging. Report min/mean/max effective floor per test file. Prioritize audit of tests where mean effective floor > 0.20. (b) Add a two-phase canary test (see Section 4.12): Phase A: set `hardMinScore=0.01`, verify at least one result returned (proves the config is NOT filtering everything). Phase B: mock retrieval scores to known values (all scores = 0.20), set `hardMinScore=0.50`, verify zero results. The mock approach isolates the wiring from score magnitude. (c) Wire `hardMinScore` into `applyAdaptiveMinScore` as the effective absolute floor (replace the hardcoded `0.15` with `this.config.hardMinScore`). (d) Run the calibration probe (Section 4.2) BEFORE wiring to establish the empirical optimal value, then wire the measured value, not a guess.

### Gap 12: No production-scale DB characteristics

- **Blind spot:** All quality evals create fresh temp DBs per example using `mkdtempSync` (beir-benchmark.ts:148, longmemeval-benchmark.ts:273). domain-eval.ts uses the live production DB (domain-eval.ts:17) but is N=15 with binary metrics. Zero evals test against a database with thousands of memories, mixed scopes, real importance distributions, WAL mode concurrency patterns, or B-tree fragmentation from deletes+inserts.
- **Impact:** Scale-dependent performance regressions (query planner changes, index efficiency degradation) are invisible to the eval suite. The production DB grows unbounded; eval DBs live for seconds. WAL mode, connection pooling, and long-lived schema state are never exercised in benchmarks.
- **What's needed:** A persistent benchmark DB with synth-generated memories at production scale (500+ entries, multiple scopes, mixed categories). Document as a known limitation of the current eval suite that temp-DB benchmarks may differ from long-lived-DB behavior. Optionally run at least one dataset against a persistent DB with realistic schema state to verify no path-dependent differences.

### Gap 13: Distribution-shift analysis between BEIR and production is inadequate (vocabulary overlap is near-useless)

- **Blind spot:** Prior analysis proposed Jaccard similarity of top-1000 vocabulary tokens as the distribution-shift analysis. Two corpora can have identical vocabulary distributions but completely different relevance patterns -- "memory" appears in both computer-science papers and personal journals but means different things. The BEIR paper's actual transfer-learning methodology (zero-shot transfer evaluation across datasets, relative performance degradation metrics) was not adopted. BEIR domains (SciFact: scientific claims, FiQA: financial Q&A, NQ: natural questions from Google search) have zero overlap with memex's actual usage (developer conversations, system configuration, personal preferences, tooling Q&A).
- **Impact:** Published BEIR numbers may be completely unrepresentative of production quality. Vocabulary overlap analysis would give a false sense of safety by showing surface-level similarity while missing deep semantic divergence. A strong BEIR score does not guarantee strong memex recall, and a weak BEIR score may not indicate a production problem.
- **What's needed:** Replace vocabulary-overlap analysis with: (a) embedding-space comparison: run the production embedding model on 100 random production memories and 100 random BEIR passages, compute the distribution of pairwise cosine similarities within-corpus vs. cross-corpus, test whether they differ significantly using a two-sample Kolmogorov-Smirnov test; (b) if production query logs exist, compute BEIR-query-to-production-memory relevance rate; (c) BM25 degradation ratio -- measure relative performance degradation when moving from one domain to another against a shared BM25 baseline: `(nDCG_memex - nDCG_BM25)_production` vs `(nDCG_memex - nDCG_BM25)_BEIR`. This avoids the mathematically meaningless ratio of raw nDCG values (which are not ratio-scale -- computed on different query sets, different relevance judgments, and different document pools, nDCG division conflates query-difficulty differences with domain-transfer effects). Add a transfer-gap caveat in all BEIR reporting.

### Gap 14: Score calibration and abstention threshold not measured

- **Blind spot:** No measurement of whether retrieval scores correlate with relevance at all. No binning-by-score analysis. No threshold study to determine the score below which results should not be injected. No measurement of whether bad context actively harms LLM answers.
- **Impact:** The system injects results with scores as low as ~0.15 (the hardcoded floor in `applyAdaptiveMinScore` at retriever.ts:881-888). No one knows whether 0.15-scored results are noise or signal. No one knows whether a 0.15 result is better or worse than injecting nothing at all.
- **What's needed:** Bin results by score deciles, compute precision/recall per bin. Run E2E with score-thresholded injection (only inject above threshold T). Find T where injection quality crosses below no-context baseline. Also run a no-memory baseline (zero injected context) to establish the abstention tradeoff.

### Gap 15: Embedding model is treated as fixed infrastructure -- contradicts own reasoning

- **Blind spot:** The analysis treats the embedding model as fixed infrastructure when it is a configurable component that affects all downstream metrics. This contradicts the analysis's own logic: if different embedding models produce different score distributions, then hardMinScore (Section 4.2) and ALL calibration thresholds are model-specific. A user who deploys with a local llama.cpp embedding model instead of OpenAI text-embedding-3-small would get different scores, and the carefully-tuned threshold would be wrong. This is not merely a documentation issue -- it is a calibration portability problem.
- **Impact:** Benchmark results from one embedding model may not transfer to a deployment using a different model. If the calibration probe derives an optimal hardMinScore of e.g. 0.35 using text-embedding-3-small, a deployment with a local model might need 0.20 or 0.50. The analysis recommends documenting this but not measuring it -- this understates the risk.
- **What's needed:** Elevate from documentation-only to measurement. Run the calibration probe (Section 4.2) with at least 2 embedding models (e.g., OpenAI text-embedding-3-small + one local model via llama.cpp) on the same query set. Report the difference in optimal hardMinScore between models. If the difference exceeds 0.10, add per-model threshold configuration capability. If it doesn't, the documentation-only approach is validated.

### Gap 16: Goodhart's law risk -- benchmark queries become optimizable targets

- **Blind spot:** Once the team starts optimizing for nDCG@5 on the calibration probe's queries, those queries become a de-facto training set. Without a held-out set or query registration process, the benchmark becomes optimizable and its scores become uninformative over time. The proposed persistent benchmark DB (Section 4.6) partially mitigates this by standardizing the data, but the queries themselves are not protected.
- **Impact:** Over multiple release cycles, config tuning that improves benchmark scores may not improve (and could degrade) production quality. The team would be optimizing for a proxy that has been contaminated by repeated exposure.
- **What's needed:** Split calibration queries into a dev set (used for threshold tuning and config selection) and a held-out test set (run only once per release). Document this split. For the persistent benchmark DB, generate 200 queries but keep 100 held-out for final validation; only make 100 public for development.

### Gap 17: Scoped retrieval is completely unaddressed

- **Blind spot:** The `memory_recall` tool accepts a `scopes` parameter that dramatically changes the candidate pool. All calibration thresholds (hardMinScore, abstention thresholds, score calibration) are derived assuming the full-DB retrieval pool. A query with `scopes: ['project-foo']` operates on a much smaller, topically-homogeneous pool with different score distributions, different optimal thresholds, and different noise characteristics.
- **Impact:** The calibration probe's empirically-derived hardMinScore of e.g. 0.35 may be appropriate for full-DB but far too aggressive (or too permissive) for scoped queries, causing either context starvation or noise injection in scoped mode. A user querying within a narrow scope may get zero results even though relevant memories exist, or may get noise entries that score highly within the small homogeneous pool. No existing eval measures quality at different scope cardinalities.
- **What's needed:** Extend the calibration probe (Section 4.2) to measure score distributions separately for scoped vs. unscoped retrieval. Run the abstention threshold sweep at 3 scope-cardinality levels: single-scope (e.g., `['project-foo']`), multi-scope (e.g., `['global', 'alex']`), and unscoped (full DB). If optimal hardMinScore differs by >0.10 across scope cardinalities, consider per-cardinality thresholds or a scoped-aware adaptive floor (e.g., lower the floor when the candidate pool is small to avoid context starvation). At minimum, document scoped retrieval as a known limitation of all threshold recommendations.
- **Source:** `memory_recall` tool schema in mcp-server.ts; `MemoryRetriever.retrieve()` applies scope filtering at retriever.ts:344-352.

---

## 4. How to Validate Results Are Good: Concrete Plan

This is NOT a re-run of the existing benchmarks. It is a new validation framework that measures live-system quality across all dimensions from Section 1.

### 4.1 Production-Config Quality Benchmark (Priority: P0)

**What:** Measure `MemoryRetriever.retrieve()` with the exact MCP production config against a known corpus.

**Implementation:**

1. **Production-config runs of existing benchmarks:**
   - Run domain-eval.ts with production config: `fusionMethod: "weighted"`, `vectorWeight: 0.7`, `bm25Weight: 0.3`, `rerank: "none"`, `minScore: 0.3`. Compare against the current eval config (zscore, 0.8/0.2). Report both columns.
   - Run LongMemEval with production config (weighted fusion + rerank:none) as the primary reported number. Keep zscore+rerank as an optional/upgrade column.
   - This immediately quantifies the config-drift gap (Section 3, Gap 4).

2. **Reranker A/B reporting:**
   - Publish **two columns** for every benchmark: (A) production config (rerank:none) as the primary metric, (B) with reranker enabled as the upgrade metric.
   - Stop reporting reranker-on numbers as the headline without clearly labeling them as prospective.

3. **Report with confidence intervals:**
   - Bootstrap 95% CI with 1000 resamples on all metrics. Use paired bootstrap for A/B comparisons.
   - For N=50, report the minimum detectable effect size at 80% power. If directional, say so.
   - Pre-register ONE primary metric (nDCG@5 on production config) and ONE secondary metric (abstention-aware precision). All other metrics are exploratory, reported with Benjamini-Hochberg FDR control at q=0.10 (not Bonferroni; see Gap 9). Report both raw and BH-adjusted p-values.

4. **E2E delta reporting with decomposition:**
   - Run LongMemEval E2E under **three conditions:**
     - (a) **Zero-context baseline:** zero injected context. Measures LLM inference ability alone.
     - (b) **Irrelevant-context baseline:** inject top-5 results from a DIFFERENT random session. Controls for "the LLM just needs any context to stay grounded" effect.
     - (c) **Correct-context:** inject actual retrieved context.
   - Decompose the total E2E delta:
     - **Hallucination-prevention effect:** E2E(irrelevant-context) - E2E(zero-context). Measures how much retrieval helps by keeping the LLM grounded, even with wrong context.
     - **Knowledge-filling effect:** E2E(correct-context) - E2E(irrelevant-context). Measures how much retrieval helps by providing actual facts beyond grounding.
     - **Total retrieval contribution:** E2E(correct-context) - E2E(zero-context) = hallucination_prevention + knowledge_filling.
   - This decomposition shows whether retrieval helps by providing facts or just by keeping the LLM grounded -- two very different mechanisms conflated by the simple delta.
   - **Split question types:** Report E2E delta separately for factual questions (if any exist in the dataset -- GPT-4o may have prior knowledge) vs. personal/synthetic questions (where the confound is inference ability, not training-data contamination). LongMemEval is primarily synthetic, but any factual subset should be isolated.
   - **Two-stage citation verification** (attention-attribution check):
     - Stage 1: Ask the LLM to cite which passage supports its answer. Verify the passage EXISTS in context.
     - Stage 2: For each cited passage, use an NLI model or separate LLM judge to assess: "Does this passage entail or support this answer?" Binary entailment judgment.
     - Report **citation-verified rate:** fraction of answers where (a) at least one passage is cited AND (b) at least one cited passage is judged as entailing the answer.
     - Document the limitation: multi-hop answers where no single passage is sufficient may fail this check legitimately. Report a separate "multi-hop" annotation for such cases.

**Effort:** ~2 days (config changes are minimal; the work is running all benchmarks with both configs, computing CIs, running 3-condition E2E baseline + entailment judgments, and executing the no-context baseline).

### 4.2 Calibration and Abstention Probe (Priority: P0 -- MUST precede hardMinScore wiring)

**What:** A focused probe that measures whether retrieval scores are trustworthy, whether the system can say "I don't know," whether abstention starves legitimate queries of context, AND whether thresholds transfer across scoped vs. unscoped retrieval and across embedding models.

**CRITICAL:** This probe must run BEFORE wiring `hardMinScore` (F4). It establishes the empirical score distribution and optimal threshold. Wiring first and measuring later risks degrading production before understanding the impact.

**Implementation:**

1. **Score calibration measurement (using true IR negatives, not "guaranteed absent" queries):**
   - **Methodology caveat:** Do NOT use "40 negative queries (topics guaranteed NOT in the DB)" as negative controls. In a ~2100-entry auto-captured production DB, fragments of nearly any topic may exist -- a "negative" query about "quantum computing" could match a CoT fragment where the agent mused about quantum computing. A hit on a "negative" query would appear as a calibration failure when it is actually a correct retrieval of an auto-captured fragment. This inflates apparent calibration error and biases the optimal hardMinScore downward.
   - **Correct approach (true IR negatives):** Sample 100 production queries. Re-run each through production `MemoryRetriever.retrieve()`. Have a human or strong LLM judge label each of the top-5 results on a 0-3 relevance scale (0=irrelevant, 1=tangential, 2=relevant, 3=directly-answers). The **negative set** is queries where ALL top-5 results scored 0 (genuinely irrelevant retrievals). The **positive set** is queries where at least one result scored >= 2 (clearly relevant). Queries with mixed results (some 1s, no 2+) are set aside as ambiguous.
   - Split: reserve 20% of each set as held-out (run only once per release); use the remaining 80% as the dev set for threshold tuning.
   - For each query in both sets, retrieve top-5 with full scores using the production config.
   - Compute ECE: bin scores into deciles (0-0.1, 0.1-0.2, ... 0.9-1.0) and compare fraction-of-relevant within each bin to the bin midpoint.
   - Expected: negative-query results clustered in 0-0.2 bins, positive-query results clustered in 0.5+ bins. Quantify the separation.

2. **Abstention threshold sweep with false-negative measurement:**
   - Sweep `hardMinScore` from 0.0 to 0.8 in 0.05 increments on the dev-set queries.
   - At each threshold, measure:
     - **Coverage:** fraction of positive queries with >=1 result.
     - **Abstention rate (specificity):** fraction of negative queries with zero results.
     - **Precision@empty:** fraction of abstained positive queries that would have gotten a wrong answer (correct abstentions).
     - **False-negative rate:** fraction of abstained positive queries where a relevant memory DOES exist in the DB but scored below threshold.
   - Compute precision and recall of the abstention decision itself (treating "should return results" as positive class). Optimal threshold maximizes F1 of the abstention decision, not `coverage * (1 - abstention_rate)`.

3. **Scoped retrieval calibration (NEW -- addresses Gap 17):**
   - Run the same abstention threshold sweep at **3 scope-cardinality levels:**
     - **Single-scope:** e.g., `['global']` or `['project-foo']` -- small, homogeneous pool.
     - **Multi-scope:** e.g., `['global', 'alex']` -- intermediate pool.
     - **Unscoped:** full DB -- the baseline.
   - For each level, compute the optimal hardMinScore (maximizing F1 of the abstention decision).
   - If optimal hardMinScore differs by >0.10 across cardinalities, per-cardinality thresholds (or a scoped-aware adaptive floor that relaxes when the candidate count is small) are needed.
   - At minimum, document scoped retrieval as a known limitation of all threshold recommendations.

4. **Embedding model sensitivity (NEW -- addresses Gap 15):**
   - Run the calibration probe with at least 2 embedding models on the same query set (e.g., OpenAI text-embedding-3-small + one local model via llama.cpp, if available).
   - Report the difference in optimal hardMinScore between models.
   - If the difference exceeds 0.10, per-model threshold configuration is necessary.
   - If the difference is <= 0.10, the documentation-only approach is validated.

5. **No-memory baseline (E2E context-starvation measurement):**
   - Run E2E with zero injected context. Compare against: low-confidence injection (score < 0.3), medium-confidence injection (0.3-0.6), high-confidence injection (>0.6).
   - Establishes the abstention tradeoff: is injecting bad context worse than injecting nothing? At what score does injection become net-harmful?

6. **Wire hardMinScore (AFTER measurement):**
   - Based on the empirical optimal threshold from step 2 (dev set, unscoped queries), wire `hardMinScore` into `applyAdaptiveMinScore` (retriever.ts:886: replace `0.15` with `this.config.hardMinScore`).
   - Add a kill-switch env var (e.g., `MEMEX_HARD_MIN_SCORE_OVERRIDE`) that allows overriding `hardMinScore` in production without redeploying.
   - Run calibration probe again with the wired value. Report the delta against the unwired baseline.
   - Monitor production abstention rate for 48 hours after wiring. **Operational spec (see F4):** abstention rate change < 10pp absolute from baseline is acceptable; >15pp deviation in any 2-hour window triggers rollback. Rollback: set `MEMEX_HARD_MIN_SCORE_OVERRIDE=0.15`, restart, verify abstention returns to baseline. Designate an on-call engineer for the monitoring window.
   - Validate on the held-out test set (from step 1) after the monitoring period -- run once, report the held-out nDCG@5 and abstention F1.

**Effort:** ~2.5 days (probe script with true-IR-negative labeling + scoped calibration sweep + embedding model comparison + wiring change + no-memory baseline + 48h monitoring). Increased from prior estimate due to: LLM judging 100 queries x 5 results for true IR negatives, scoped calibration at 3 cardinality levels, and embedding model comparison.

### 4.3 Noise-Robustness Stress Test (Priority: P1)

**What:** A direct test of the junk-magnet failure mode. Inject controlled synthetic pollution and measure recall degradation.

**Implementation:**

1. **Pollution types:**
   - **Type A (keyword parasites):** High-keyword-relevance but semantically irrelevant. Example: inject "I love Grafana dashboards, they are beautiful visualization tools" alongside the real "Grafana password" memory.
   - **Type B (noise fragments):** CoT-style reasoning fragments. "Let me think about this... the user wants X but Y might be better... actually Z is the answer."
   - **Type C (contradictory facts):** Direct contradictions. Inject "User lives in Chicago" when DB says "User lives in New York."
   - **Type D (stale near-duplicates):** Slightly different versions with temporal staleness. "The inference host runs Gemma" (old) vs. "The inference host runs Qwen" (current).

2. **Measurement protocol:**
   - Baseline: run 30 positive queries (dev set of 20 + held-out set of 10) against the live production DB. Record nDCG@5, precision@1, and top-1 ID.
   - Inject batches of 20 pollution entries of each type. Re-query after each batch.
   - Plot degradation curve: nDCG@5 vs. pollution count, by type.
   - Measure: does `memory_dream` clean up injected pollution? Run dream after injection and re-measure.

3. **Selective Forgetting score** (MemoryAgentBench taxonomy):
   - After injecting contradictory facts (Type C), query with the original fact's topic. Does the system return the NEW fact or the OLD one?
   - Score: fraction of queries where new fact outranks old fact.

**Effort:** ~1.5 days.

### 4.4 Temporal Degradation Curve (Priority: P1)

**What:** Measure how recall degrades as memories age and new ones enter.

**Implementation:**

1. **Staggered-index benchmark:**
   - Create a persistent DB with 100 synth-generated memories timestamped at -30d, -14d, -7d, -1d, and "now."
   - Include 20 ground-truth facts at each timestamp bucket.
   - Query for old facts. Measure recall with `timeDecayHalfLifeDays` at 0 (disabled), 30, 60 (default), and 90.
   - Plot: recall of -30d facts vs. timeDecayHalfLifeDays.

2. **Recency boost calibration:**
   - Same DB. For queries where both an old relevant fact (score 0.55, age 30d) and a new irrelevant fact (score 0.35, age 0d) are in the candidate pool, does recency boost cause the irrelevant fact to outrank the relevant one?
   - Sweep `recencyWeight` from 0.0 to 0.30. Find the value where this inversion does NOT occur.

**Effort:** ~1 day.

### 4.5 MCP Integration Smoke Tests + recordRecalls Bug Fix (Priority: P0)

**What:** Fix the data-corruption bug and add minimum coverage for the MCP tool code path.

**Implementation:**

1. **Fix recordRecalls wiring bug (CRITICAL):**
   - Add `store.recordRecalls(results.map(r => r.entry.id))` after mcp-server.ts:246.
   - **Backfill strategy:** Execute a one-time migration that sets `recall_count = 1` for all existing memories (preventing dreaming from treating them as never-recalled). Document the migration.
   - **Audit dreaming impact:** Query `SELECT COUNT(*) FROM memories WHERE importance <= 0.3 AND recall_count = 0` to estimate how many memories dreaming has already deprioritized due to this bug.

2. **memory_recall e2e test:**
   - Create store, seed 5 memories, call `memory_recall` with a known-relevant query.
   - Verify: results returned, `recall_count` incremented (was broken), correct scoping applied.
   - Regression test: after fix, verify recall_count > 0 for MCP-recalled memories.

3. **memory_dream integration test:**
   - Seed 3 duplicate memories + 1 noise fragment. Call `memory_dream` (light phase).
   - Verify: duplicates deduplicated, noise removed, surviving memories rescored.

4. **memory_store + memory_recall round-trip:**
   - Store a unique fact. Immediately recall with a query targeting it. Verify it appears in top-3.

**Effort:** ~1 day (fix is one line, but backfill audit, integration tests, and dreaming-impact analysis take time).

### 4.6 Production-Scale Persistent Benchmark DB (Priority: P2)

**What:** A synth-generated, version-controlled benchmark DB with production-like characteristics and validated data quality.

**Implementation:**

1. **Generation script:**
   - Generate 500+ synth memories (LLM-generated) across 5+ scopes (global, alex, jordan, system, project-foo).
   - Include 50 ground-truth facts with known query-answer pairs.
   - Include 100 noise entries (CoT fragments, off-topic chat).
   - Include 30 contradictory pairs (old fact + new fact that supersedes it).
   - Timestamp distribution: 50% within last 30d, 25% 30-90d, 25% 90+d.

2. **Synth-data quality validation (NEW):**
   - **Diversity metrics:** Compute embedding-space dispersion (mean pairwise cosine distance), text-length distribution (mean, stddev, histogram), and entity-type distribution (person, place, technical term, preference, etc.) on the generated memories.
   - **Production-fidelity check:** Compare these distributions against a random sample of 100 production memories using the same KS-test methodology from Section 4.7. If the distributions differ significantly (p<0.05, KS test), the synth data is unrepresentative -- refine the generation prompts and regenerate.
   - **Realism audit:** Have a human spot-check 20 synth memories and flag any that are implausible as actual agent-captured memories (e.g., overly formal tone, missing conversational artifacts, unnaturally complete sentences). Iterate prompts until <= 10% are flagged.
   - This validation prevents a benchmark that measures the system's ability to handle an easy, stereotypical, homogeneous pool -- the opposite of the production noise problem the analysis identifies.

3. **Query protection:**
   - Generate 200 queries total. Make 100 public (for development and CI). Keep 100 held-out (for release validation only).
   - Document which queries are public vs. held-out.

3. **Use as read-only query target:**
   - All quality evals can point at this DB. Single source of truth prevents config drift.
   - Checked into repo as a generation script (not a SQLite binary). Generated on first run.

4. **Document temp-DB limitation:**
   - Add a caveat to all benchmark output noting that results are measured against fresh temp DBs and may differ from long-lived production DB behavior with WAL mode, connection pooling, and index fragmentation.

**Effort:** ~2 days (increased from 1.5d due to synth-data validation: diversity metrics computation, KS test against production sample, human realism audit).

### 4.7 Distribution-Shift Analysis (Priority: P2)

**What:** Quantify how well BEIR results transfer to memex's production domain using embedding-space methods and established IR transfer-evaluation methodology, not vocabulary overlap or invalid ratio metrics.

**Implementation:**

1. **Embedding-space distribution comparison (primary method):**
   - Sample 100 random production memories + 100 random passages from each BEIR subset (fiqa, scifact, nq).
   - Embed all using the production embedding model.
   - Compute pairwise cosine similarities: within-production, within-BEIR, and cross-corpus (production vs. BEIR).
   - Two-sample Kolmogorov-Smirnov test: are within-corpus and cross-corpus similarity distributions significantly different?
   - Report the KS statistic and p-value. A significant difference means BEIR results may not transfer. The KS test directly answers "are these distributions different?" without false ratio-scale assumptions.

2. **Production-relevance rate (if query logs available):**
   - For 50 BEIR queries from each subset, retrieve from the production memory DB.
   - Judge whether any retrieved memory is relevant to the BEIR query.
   - Report: "X% of BEIR-SciFact queries retrieve at least one relevant production memory."

3. **BM25 degradation ratio (replaces invalid transfer coefficient):**
   - **Do NOT compute `nDCG@5_production / nDCG@5_BEIR`.** nDCG is not ratio-scale -- the denominator is computed on a different query set, different relevance judgments, and a different document pool. Dividing them produces a unitless number that conflates query-difficulty differences with domain-transfer effects. No IR venue would accept this as a transfer metric.
   - Instead, use an established IR transfer-evaluation methodology: **measure relative performance degradation from a shared BM25 baseline.** Compute:
     - `delta_production = nDCG@5_memex_production - nDCG@5_BM25_production`
     - `delta_BEIR = nDCG@5_memex_BEIR - nDCG@5_BM25_BEIR`
   - Compare the deltas. If `delta_production` is much smaller than `delta_BEIR`, the system's advantage over BM25 is smaller in the production domain -- indicating domain-transfer degradation.
   - This avoids all ratio-scale problems because both deltas subtract on the same scale (nDCG units on their respective query sets), and BM25 serves as a shared calibration point.

4. **Transfer-gap caveat:**
   - Add to all BEIR reporting: "BEIR datasets (SciFact: scientific claims, FiQA: financial Q&A, NQ: open-domain web questions) may not represent memex's actual usage domain (developer conversations, system configuration, tooling queries). KS-test on embedding-space distributions: [result]. BM25 degradation ratio: [result]. Treat BEIR results as indicative of document-retrieval capability, not production recall quality."

**Effort:** ~1.5 days (BM25 baselines add run time for both domains).

### 4.8 BEIR Labeling Correction + Genuine Mixed-Source Benchmark (Priority: P1)

**What:** Fix the mislabeling and create the actual mixed-source benchmark that was promised.

**Implementation:**

1. **Rename BEIR track:**
   - Relabel as **"Document Retrieval (BEIR subset)"** in all reporting: README, benchmark output, design docs.
   - The current BEIR benchmark (beir-benchmark.ts) calls `hybridQuery()` directly -- it never goes through `MemoryRetriever` or `UnifiedRetriever`, never touches memories. This is honest document-only retrieval.

2. **Genuine mixed-source benchmark:**
   - Implement the core of issue #19 with one critical addition: seed conversation memories alongside BEIR documents.
   - Store 100+ synth memories (LLM-generated facts about the same domains as the BEIR corpus, but NOT from the corpus itself) in the same DB as the BEIR documents.
   - Run queries through `UnifiedRetriever.retrieve()` (the mixed-source code path) and measure nDCG@10, MRR, R@5, R@10.
   - Compare against: (a) memory-only retrieval, (b) document-only retrieval, (c) mixed-source retrieval. The delta quantifies the mixed-source benefit or penalty.

**Effort:** ~2.5 days (mostly implementing the memory seeding and `UnifiedRetriever` wiring; BEIR loader and metrics already exist).

### 4.9 Live-Production Quality Sampling (Priority: P0)

**What:** The ONLY metric that directly answers "are users getting good results?" Sample actual production recall queries, judge results, compute nDCG@5. Run before and after any config changes. **With coverage audit to correct survivorship bias and collection mechanism validation.**

**Implementation:**

0. **Step 0: Validate the collection mechanism (CRITICAL -- must precede any data use):**
   - debug-recall.ts (Section 2.3) has zero test coverage. If it has a bug -- writes wrong query text, truncates results, misses certain code paths -- the live-sampling data is silently corrupted.
   - **Validation procedure:** Seed 10 known memories, run 10 known queries through both the MCP path and the auto-recall hook path, capture DEBUG_RECALL output, verify the JSON contains the expected queries, result IDs, scores, and injected context. Add this as a CI smoke test.
   - Only AFTER the collection mechanism is validated should live-production sampling proceed.

1. **Query collection (with denominator audit):**
   - Source: BOTH the MCP path (MEMEX_DEBUG_RECALL logs, debug-recall.ts writes per-turn JSON to `${tmpdir}/memex-debug-recall/`) AND the auto-recall hook path (index.ts:1344), since these are different code paths with different skip logic.
   - **Denominator audit (CRITICAL):** For each sampled period, compute:
     - (a) **Total user turns:** count of all user messages in the sampling period.
     - (b) **Retrieval-attempted turns:** count of turns where retrieval was triggered (i.e., adaptive-retrieval.ts did NOT skip, and the code reached MemoryRetriever.retrieve()).
     - (c) **DEBUG_RECALL turns:** count of turns with DEBUG_RECALL output.
     - Report **coverage = retrieval-attempted / total-turns** alongside nDCG@5. If coverage < 80%, the nDCG@5 number overstates user-experienced quality because >=20% of queries are silently not served or sampled. A system that drops 40% of skippable queries but does well on the remaining 60% looks great in biased sampling.
   - Collect 100 actual production recall queries from the past 7 days. Exclude queries that are trivial (e.g., empty, single-word greetings).
   - Anonymize query text to remove PII before storage or review.

2. **Relevance judgment:**
   - For each query, re-run through production MemoryRetriever.retrieve() to get top-5 results.
   - Judge each result on a 0-3 scale: 0=irrelevant, 1=tangential, 2=relevant, 3=directly-answers.
   - Use a strong LLM judge (GPT-4o or better) with the same rubric. Spot-check 20% of judgments with a human for calibration.
   - Compute nDCG@5 with graded relevance.

3. **Before/after protocol:**
   - Run BEFORE any config changes to establish baseline.
   - Run AFTER each wave of changes to measure delta.
   - Report nDCG@5 baseline and delta with bootstrap 95% CIs.
   - Report coverage alongside nDCG@5 -- if coverage changes, flag it (a coverage drop means the sampling is becoming MORE biased).

4. **Coverage logging:**
   - Log which production code paths each sampled query exercised (BM25 gate? Lex expansion? Reranker? Which fusion method? Scoped or unscoped?). Include scope cardinality in the log.

**Effort:** ~2.5 days (increased from 2d due to: Step 0 collection validation, denominator audit instrumentation, sampling from both MCP and hook paths, coverage logging with scope cardinality).

### 4.10 Benchmark Query Protection (Priority: P2)

**What:** Prevent Goodhart's law contamination by protecting benchmark queries from overexposure.

**Implementation:**

1. **Query set splits:**
   - Calibration probe: positive + negative queries from Section 4.2 step 1. Split into dev set (80%, used for threshold tuning) and held-out test set (20%, run only once per release).
   - Noise-robustness test: 30 positive queries. Split into dev (20) and held-out (10).
   - Persistent benchmark DB: 200 queries. 100 public (CI, development), 100 held-out (release validation).
   - Document the split for each benchmark.

2. **CI enforcement:**
   - CI runs only dev-set queries. Held-out queries are never run in CI.
   - Held-out queries are run manually as a release gate.

**Effort:** ~0.5 day (query generation and splitting; mostly organizational).

### 4.11 Path Coverage Logging + Uncovered-Code-Path Integration (Priority: P2)

**What:** Ensure benchmark runs are auditable and cover the four zero-coverage code paths identified in Section 2.3. Address the BM25 score-scale issue.

**Implementation:**

1. **Per-run coverage logging:**
   - For each query processed, log which internal code paths were exercised: BM25 gate triggered? Lex expansion run? Reranker invoked? Which fusion method? Scope cardinality?
   - Append to benchmark output JSON.

2. **CI assertions:**
   - Assert in CI that specific paths were exercised (e.g., "hybrid mode must exercise both FTS and vector branches").
   - Detect silent path changes that could shift results undetectably.

3. **Coverage for zero-coverage paths (from Section 2.3):**
   - **adaptive-retrieval.ts (P1):** Add a test that verifies the skip logic correctly distinguishes answerable from unanswerable queries. Feed 10 answerable queries (should NOT be skipped) and 10 unanswerable queries (should be skipped). Verify skip/retrieve decisions.
   - **recall-cache.ts (P2):** Add a test that verifies cache hits return the same top-5 results as cache misses (no staleness regression). Feed the same query twice; verify identical result IDs and scores.
   - **debug-recall.ts (P2):** Add a smoke test verifying that setting MEMEX_DEBUG_RECALL produces a valid JSON file with the expected schema. This is also the Step 0 validation from Section 4.9.
   - **BM25-only fallback (P1):** **CRITICAL:** BM25 scores are unbounded, not normalized to [0,1] like vector cosine similarity. Any `minScore` or `hardMinScore` threshold calibrated on the hybrid path is meaningless for BM25-only results. Run the same calibration probe (Section 4.2) against the BM25-only path. BM25 scores may cluster in a completely different range (e.g., 0-50 instead of 0-1). Either (a) normalize BM25 scores to [0,1] using the max score in the candidate set per query, or (b) maintain separate threshold configuration for the BM25-only path. Add 5 queries to domain-eval.ts run with no embedder configured and report quality alongside embedded results. Document that users without an embedder should not expect the same quality or threshold behavior.

**Effort:** ~2 days (increased from 1.5d due to BM25-specific calibration probe run).

### 4.12 hardMinScore Test Audit (Priority: P0)

**What:** Audit every test that sets `hardMinScore` to determine whether its assertions are valid under the actual hardcoded floor, with per-test effective-floor quantification.

**Implementation:**

1. **Audit inventory with effective-floor quantification:**
   - tools-scoping.test.ts:66 (`hardMinScore: 0.0`)
   - retriever-rerank-fallback.test.ts:112, 127, 178 (`hardMinScore: 0.0`)
   - retriever-rerank-blend-weight.test.ts:71, 172, 190, 245, 262 (`hardMinScore: 0.0`)
   - acceptance-temporal-queries.test.ts:192 (`hardMinScore: 0`)
   - longmemeval-benchmark.ts:373 (`hardMinScore: 0.10`)
   - fast-benchmark.ts:401 (`hardMinScore: 0.10`)
   - **For each test file, instrument `applyAdaptiveMinScore` during a test run to log the actual effective floor value `max(best*0.3, 0.15)` for each query.** Report min/mean/max effective floor per test file.
   - **Prioritization:** Tests where the mean effective floor exceeds 0.20 for >50% of queries are the ones where assertions are most likely invalid. Audit these first.
   - Tests that pass despite an unexpected score floor may indicate that the filtering is harmless for those particular query-result pairs -- useful calibration information.

2. **Remediation:**
   - Tests that truly need `floor=0` should be annotated with `// KNOWN: hardMinScore not wired (Gap 11); actual floor varies by query (mean=X.XX, max=Y.YY)`.
   - Tests where assertions are invalid under the effective floor must be rewritten.
   - **Two-phase canary test (replaces the unreliable single-threshold approach):**
     - The previous proposal ("set hardMinScore=0.99, assert zero results") is unreliable: if hardMinScore is still dead, results are filtered by the hardcoded `max(best*0.3, 0.15)` floor. For queries where BM25 produces an exact keyword match, the fused weighted score could exceed 0.99, causing the test to PASS (return results) even though hardMinScore is still dead -- a false positive. Conversely, if hardMinScore IS wired, the test could FAIL if any result scores >= 0.99 -- a false negative. The test's outcome is coupled to score magnitudes, not to whether the config value is actually read.
     - **Phase A (sanity check):** Set `hardMinScore` to 0.01. Verify at least one result is returned. This proves the config is NOT filtering everything (i.e., we are not accidentally setting a floor so high that all results are filtered).
     - **Phase B (wiring isolation):** Mock the retrieval scores to known values (e.g., all scores = 0.20). Set `hardMinScore` to 0.50. Verify zero results. The mock approach isolates the wiring from score magnitude -- it directly tests whether `this.config.hardMinScore` is read and applied.
     - **Alternative (code-level assertion):** Add an internal assertion in `applyAdaptiveMinScore` that logs or throws if `this.config.hardMinScore` differs from the effective floor value -- a direct code-level check that doesn't depend on score distributions. Not a test, but a development-time guard.
   - The Phase A+B canary test will FAIL until `hardMinScore` is wired, serving as a canary for the wiring gap.

3. **Post-F4 re-audit:**
   - After wiring `hardMinScore`, re-run all audited tests. Tests annotated with the known-limitation tag should be updated or removed.

**Effort:** ~4 hours (increased from 3h due to effective-floor instrumentation and two-phase canary implementation).

---

## 5. Fixes and Improvements -- Prioritized by Leverage

| # | Fix | Gap(s) Closed | Effort | Validation Overhead | Risk | Leverage |
|---|---|---|---|---|---|---|
| **F1** | Run domain-eval + LongMemEval with production config (weighted fusion, 0.7/0.3, rerank:none) as primary metric; report zscore+rerank as optional column; add E2E delta decomposed into hallucination-prevention + knowledge-filling with two-stage citation verification | Gap 1 (prod code path), Gap 4 (config drift), Gap 5 (reranker story), Gap 9 (CIs) | 2 days | -- | Low (reporting only) | **Extreme.** Immediately measures what users actually experience. Quantifies config-drift gap. Isolates retrieval contribution from LLM inference ability. Decomposes E2E into grounding vs. knowledge effects. |
| **F2** | Live-production quality sampling: Step 0 validate collection mechanism; collect 100 production recall queries from BOTH MCP and auto-recall hook paths; denominator audit (coverage = retrieval-attempted/total-turns); judge top-5 relevance (0-3 scale); compute nDCG@5 baseline with coverage metric. Run before AND after all config changes | Gap 17 (scoped unaddressed via coverage logging), NEW (Section 4.9, critique points 1, 13) | 2.5 days | -- | Low (measurement only) | **Extreme.** The ONLY metric that directly answers "are users getting good results?" Denominator audit prevents survivorship-bias inflation. |
| **F3** | Calibration + abstention probe (Section 4.2) with true IR negatives (not "guaranteed absent" queries), false-negative measurement, scoped calibration at 3 cardinality levels, embedding model comparison, precision-recall curve, and no-memory baseline. Run BEFORE wiring hardMinScore | Gap 3 (metric mismatch), Gap 8 (no abstention), Gap 11 (dead config), Gap 14 (threshold study), Gap 15 (embedding model), Gap 17 (scoped retrieval) | 2.5 days | -- | Low (measurement only) | **Very high.** First data on whether scores correlate with relevance. Finds optimal hardMinScore empirically per scope cardinality and per embedding model. Measures context-starvation risk. True IR negatives avoid calibration inflation. |
| **F4** | Wire `hardMinScore` into `applyAdaptiveMinScore` (retriever.ts:886: replace `0.15` with `this.config.hardMinScore`). Add kill-switch env var (`MEMEX_HARD_MIN_SCORE_OVERRIDE`). **Operational monitoring spec:** (a) metric = production abstention rate via telemetry; (b) acceptable range = abstention rate change < 10pp absolute from baseline; (c) alert threshold = if abstention rate exceeds baseline + 15pp for any 2-hour window, trigger rollback; (d) rollback = set `MEMEX_HARD_MIN_SCORE_OVERRIDE=0.15`, restart, verify abstention returns to baseline; (e) designate on-call engineer for the 48h window. **MUST follow F3; do not ship first.** | Gap 11 (dead config), Gap 8 (no abstention) | 1-2 hours (wiring) + 48h monitoring | 48h monitoring with on-call | **High** (alters production behavior; requires monitored rollout) | **Extreme.** Enables configurable noise floor. Kill-switch prevents degradation. Operational spec ensures rollback readiness. |
| **F5** | Fix `recordRecalls` wiring in `mcp-server.ts` + backfill existing memories + audit dreaming impact + add integration test verifying recall_count > 0 after MCP recall | Gap 10 (MCP path, data-corruption bug) | 1 day | -- | **High** (data migration) | **Critical.** Fixes feedback-loop corruption. Prevents dreaming from deleting actively-used memories. |
| **F6** | Add bootstrap 95% CIs to all benchmark reporting; use paired bootstrap for A/B; pre-register primary metric; apply Benjamini-Hochberg FDR control at q=0.10 for exploratory metrics (NOT Bonferroni -- FDR controls proportion of false discoveries, appropriate for exploratory analysis; Bonferroni's FWER control at alpha=0.05/30=0.0017 guarantees no finding passes, making it self-censorship). Report both raw and BH-adjusted p-values. Alternative: pre-register exactly 2 metrics with unadjusted CIs, all others descriptive-only. Compute minimum detectable effect size at N=50 with 80% power | Gap 9 (no CIs, multiple comparison) | 3 hours | -- | Low (reporting only) | **High.** Prevents reacting to sampling noise as signal. BH-FDR protects against false discoveries without the self-censorship of Bonferroni. |
| **F7** | Relabel BEIR as "Document Retrieval (BEIR subset)" + implement genuine mixed-source benchmark with `UnifiedRetriever` (Section 4.8) | Gap 6 (mislabeling), Gap 1 (UnifiedRetriever untested) | 2.5 days | -- | Medium | **High.** Closes the most misleading reporting gap and creates the benchmark that was promised. |
| **F8** | Noise-robustness stress test (Section 4.3) | Gap 2 (clean vs. polluted), Gap 8 (no noise testing) | 1.5 days | -- | Low | **High.** First eval testing actual production failure mode (junk-magnet). |
| **F9** | Temporal degradation benchmark (Section 4.4) | Gap 7 (temporal disabled) | 1 day | -- | Low | **High.** Data-driven values for recencyWeight and timeDecayHalfLifeDays. |
| **F10** | Report production-config (rerank:none) as PRIMARY metric; reranker-on as upgrade column | Gap 5 (reranker story) | 30 min (reporting change) | -- | Low | **High.** Fixes the most user-visible reporting issue immediately. |
| **F11** | Align production config to zscore fusion (or prove weighted is fine). Verify with F2 live-sampling before+after. **Operational monitoring spec (same as F4):** (a) metric = production abstention rate; (b) acceptable = < 10pp change; (c) alert = >15pp in 2h window triggers rollback; (d) rollback = revert config, restart, verify; (e) on-call engineer designated. | Gap 4 (config drift) | 2-4 hours (change + verify + monitor + rollback plan) | 48h monitoring with on-call | **High** (alters production behavior; requires monitored rollout) | **High.** If zscore is provably better, shipping it closes the gap between "what we measure" and "what we ship." |
| **F12** | hardMinScore test audit: instrument effective floor per test file (min/mean/max), audit 8+ test files with dead hardMinScore config, verify assertions, add two-phase canary test (Phase A: hardMinScore=0.01, verify results; Phase B: mock scores=0.20, hardMinScore=0.50, verify zero results) | Gap 11 (vacuously true tests) | 4 hours | -- | Medium | **High.** Fixes testing validity crisis. Two-phase canary isolates wiring from score magnitude. |
| **F13** | Implement MCP integration smoke tests (Section 4.5) | Gap 10 (MCP untested) | (included in F5) | -- | Medium | **Medium.** Catches regressions in the only path users hit. |
| **F14** | Persistent benchmark DB + synth-data validation (diversity metrics, KS test against production, realism audit) + query protection + temp-DB limitation documentation (Section 4.6 + 4.10) | Gap 12 (no scale testing), Gap 16 (Goodhart) | 2.5 days (combined with query protection and synth validation) | -- | Low | **Medium.** Enables scale-dependent regression detection. Synth validation prevents stereotypical-data bias. Query protection prevents benchmark contamination. |
| **F15** | Distribution-shift analysis with embedding-space KS test (primary) + BM25 degradation ratio (replaces invalid transfer coefficient) + transfer-gap caveat (Section 4.7) | Gap 13 (domain mismatch) | 1.5 days | -- | Low | **Medium.** Honest, quantitative domain-gap measurement using established IR methodology. BM25 degradation ratio avoids nDCG ratio-scale fallacy. |
| **F16** | Replace binary hit/miss in domain-eval with nDCG@5 + precision@1 (wire existing ir-metrics) | Gap 3 (metric mismatch) | 1 hour | -- | Low | **Medium.** Upgrades primary quality metric immediately. |
| **F17** | Path coverage logging + coverage tests for adaptive-retrieval.ts, recall-cache.ts, debug-recall.ts, BM25-only fallback with BM25-specific calibration and score normalization (Section 4.11) | NEW (critique point 6: 333 uncovered lines), BM25 score-scale gap (critique point 11) | 2 days | -- | Low | **Medium.** Covers decision-logic paths with zero quality testing. BM25 calibration ensures non-embedded path has valid thresholds. |
| **F18** | Embedding model dependency: run calibration probe with 2 models (text-embedding-3-small + one local). If optimal hardMinScore differs by >0.10 between models, add per-model threshold config. If not, documentation-only is validated. | Gap 15 (embedding model variable) | 4 hours (calibration + comparison) | -- | Low | **Medium** (elevated from Low). Directly measures calibration portability. Documentation-only if model difference <= 0.10. |

### Recommended Sequencing

**Wave 0 (this week, ~4 days):** F1 (production-config benchmarks + E2E delta with decomposition) + F2 (live-production quality sampling with Step 0 validation + denominator audit) + F6 (bootstrap CIs + BH-FDR multiple comparison correction) + F12 (hardMinScore test audit with effective-floor quantification). These establish the ground truth: what do users actually experience, is our sampling honest, and are our test assertions valid?

**Wave 1 (next week, ~3.5 days):** F3 (calibration probe with true IR negatives + scoped calibration + embedding model comparison -- MUST precede F4) + F5 (recordRecalls fix + backfill + integration test) + F4 (wire hardMinScore with kill-switch and operational monitoring spec, AFTER F3 establishes empirical optimal value) + F10 (reranker labeling fix) + F16 (nDCG in domain-eval). These produce the first data on calibration, abstention, scoped retrieval, and recall_count corruption, then ship the fixes with monitored rollout.

**Wave 2 (following week, ~3.5 days):** F7 (BEIR relabel + genuine mixed-source benchmark) + F8 (noise-robustness) + F9 (temporal degradation) + F11 (config alignment with operational monitoring, if zscore wins in Wave 1 measurement). These stress-test Wave 1 fixes against production-realistic conditions.

**Wave 3 (ongoing, ~5 days):** F13 (MCP smoke tests) + F14 (persistent benchmark DB + synth-data validation + query protection) + F15 (distribution shift analysis with BM25 degradation ratio) + F17 (path coverage + zero-coverage path tests + BM25 calibration) + F18 (embedding model comparison). These fill remaining blind spots and harden eval infrastructure.

**Gates:**
- **G1:** After Wave 0: nDCG@5 baseline established via live-production sampling with coverage >= 80%. DEBUG_RECALL collection mechanism validated (Step 0). All test file assertions validated against quantified effective floors.
- **G2:** After Wave 1: optimal hardMinScore measured empirically from calibration probe (dev set). Scoped vs. unscoped threshold divergence quantified. Embedding model sensitivity measured. recordRecalls wired and verified. hardMinScore wired with kill-switch. Production abstention rate monitored for 48 hours with on-call engineer. No regression in live-production nDCG@5.
- **G3:** After Wave 2: noise-robustness and temporal degradation quantified. Production config aligned if zscore wins. No regression in live-production nDCG@5.
- **G4:** After Wave 3: all zero-coverage code paths have at least one quality test. BM25-only path has its own calibration. Synth data validated against production distribution. Query protection in place for all benchmarks.

---

## 6. Embedding Model Dependency Caveat

All benchmark results and calibration thresholds in this document are measured against the embedding model configured in the eval environment. Production deployments may use different embedding models (OpenAI text-embedding-3-small, local llama.cpp, etc.). Different embedding models produce different vector similarity score distributions, which affect:

- Fusion weight calibration (vector vs. BM25 contribution)
- Reranker input (reranker receives vector-sorted candidates)
- Score calibration (ECE depends on embedding model score characteristics)
- Abstention thresholds (optimal hardMinScore may differ between models)

**This is not merely a documentation issue -- it is a calibration portability problem.** If the eval suite always uses a specific embedding model (e.g., text-embedding-3-small) and derives an optimal hardMinScore of 0.35, a deployment with a local model might need 0.20 or 0.50.

The calibration probe (Section 4.2, step 4) now includes a mandatory embedding model comparison: run the probe with at least 2 embedding models (e.g., OpenAI text-embedding-3-small + one local model via llama.cpp) on the same query set. Report the difference in optimal hardMinScore between models. If the difference exceeds 0.10, per-model threshold configuration capability must be added. If the difference is <= 0.10, the documentation-only approach is validated.

Document the embedding model used in all benchmark output explicitly. For deployments using a different model, calibration results may not transfer.

---

## Appendix A: Config Comparison Table

| Config Parameter | MCP Production (memory_recall) | domain-eval.ts | LongMemEval | BEIR Benchmark | DEFAULT_RETRIEVAL_CONFIG |
|---|---|---|---|---|---|
| **Code Path** | MemoryRetriever.retrieve() | MemoryRetriever.retrieve() | MemoryRetriever.retrieve() | hybridQuery() (src/search.ts) | (never used as-is in any eval or prod) |
| **fusionMethod** | weighted | zscore | zscore | RRF | weighted |
| **vectorWeight** | 0.7 | 0.8 | 0.8 | N/A (RRF) | 0.7 |
| **bm25Weight** | 0.3 | 0.2 | 0.2 | N/A (RRF) | 0.3 |
| **rerank** | **none** (hardcoded) | none (RERANK=1 to enable) | none (RERANK=1 to enable) | **always on** (internal) | cross-encoder |
| **minScore** | 0.3 | 0.05 | 0.05 | N/A | 0.3 |
| **hardMinScore** | 0.40 (dead -- not wired; effective floor = max(best*0.3, 0.15), varies per query) | (not configured) | 0.10 (dead -- not wired) | N/A | 0.40 (dead) |
| **candidatePoolSize** | 20 | 30 | K*6 (~60) | N/A | 20 |
| **recencyHalfLifeDays** | 14 | (default 14) | 0 | N/A | 14 |
| **recencyWeight** | 0.10 | (default 0.10) | 0 | N/A | 0.10 |
| **timeDecayHalfLifeDays** | 60 | (default 60) | 0 | N/A | 60 |
| **DB** | Persistent WAL | Persistent (real prod) | Fresh temp per example | Fresh temp per dataset | N/A |
| **Embedding Model** | Config-dependent (env) | Config-dependent (env) | Config-dependent (env) | Config-dependent (env) | N/A |
| **BM25 Score Scale** | Unbounded (raw BM25); normalized in weighted fusion but unbounded in BM25-only fallback | Unbounded (zscore-normalized before fusion) | Unbounded (zscore-normalized before fusion) | RRF-fused (normalized) | Unbounded before fusion |

Key takeaways:
1. **No eval matches the production config.** The DEFAULT_RETRIEVAL_CONFIG (which has rerank:cross-encoder) is never used anywhere -- both MCP and evals override it.
2. **hardMinScore is dead in all paths.** Any value set in this column is silently ignored by `applyAdaptiveMinScore` (retriever.ts:885 hardcodes `max(best*0.3, 0.15)` -- the floor varies per query depending on the best result's score).
3. **Embedding model is unspecified and calibration is model-specific.** All configs inherit the embedding model from the environment. Optimal hardMinScore, ECE, and all calibration thresholds may differ between embedding models. The calibration probe (F3) now measures this sensitivity.
4. **BM25 score scale differs from vector scores.** BM25 scores are unbounded, while vector cosine similarity is in [0,1]. The BM25-only fallback path (mcp-server.ts:266) operates on a different score scale, making hybrid-path thresholds meaningless for it. BM25-specific calibration (F17) addresses this.

## Appendix B: Code Path Diagram

```
MCP memory_recall
  └─ mcp-server.ts:57 → createRetriever(store, embedder, { mode:"hybrid", rerank:"none" })
       └─ retriever.ts:1032-1039 → new MemoryRetriever(store, embedder, mergedConfig)
            └─ MemoryRetriever.retrieve() [retriever.ts:330]
                 ├─ Scope filtering (retriever.ts:344-352) ← candidate pool size varies by scope cardinality
                 └─ hybridRetrieval() [retriever.ts:399]
                      ├─ embedQuery → vectorSearch + bm25Search (parallel)
                      ├─ fuseResults (weighted or zscore)
                      ├─ rerankResults (SKIPPED: rerank="none" per MCP config)
                      ├─ applyRecencyBoost, applyImportanceWeight, applyLengthNormalization, applyTimeDecay
                      ├─ applyAdaptiveMinScore (hardcoded max(best*0.3, 0.15) floor, ignores hardMinScore config)
                      └─ filterNoise → MMR diversity → slice(limit)
      └─ RETURNS results (but NEVER calls store.recordRecalls())  ← DATA CORRUPTION BUG
```

```
BEIR benchmark
  └─ beir-benchmark.ts:194 → hybridQuery(store, query.text, { ... })
       └─ search.ts:3326 → standalone function
            ├─ FTS probe (BM25 quality gate)
            ├─ Query expansion (lex/vec/hyde)
            ├─ Batch embed → sqlite-vec search
            ├─ RRF fusion (fixed weights, not configurable)
            ├─ Chunk selection
            ├─ store.rerank() [ALWAYS called, search.ts:3490]
            └─ Blend RRF + reranker scores
      └─ NEVER goes through MemoryRetriever or UnifiedRetriever
```

```
domain-eval.ts / LongMemEval
  └─ createRetriever(store, embedder, { fusionMethod:"zscore", vectorWeight:0.8, bm25Weight:0.2, rerank:"none", ... })
       └─ MemoryRetriever.retrieve() — SAME CLASS as production, DIFFERENT config
            └─ hybridRetrieval() → zscore fusion (better than prod's weighted)
```

```
UnifiedRetriever (mixed-source path)
  └─ latency-probe.ts:72 → new UnifiedRetriever(store, null, embedder, { reranker: {...} })
       └─ UnifiedRetriever.retrieve() [unified-retriever.ts:158]
            ├─ routeQuery → "memory" | "document" | "both"
            ├─ embedQuery (single call)
            ├─ searchMemories (vectorSearch + bm25Search, no MemoryRetriever involved)
            ├─ documentSearchFn (separate stack)
            ├─ fuseMemoryResults (hardcoded zscore, 0.8/0.2)
            ├─ mergeAndCalibrate (zscore calibrate both sources)
            ├─ rerank (if configured — latency-probe enables it)
            └─ applySourceDiversity
      └─ ZERO quality evals test this path
```

```
adaptive-retrieval.ts (99 lines, ZERO quality-eval coverage)
  └─ Called before retrieval
       ├─ normalizeQuery (strip cron wrappers)
       ├─ SKIP_PATTERNS (regex match → skip retrieval)
       ├─ FORCE_RETRIEVE_PATTERNS (regex match → force retrieval)
       └─ Binary decision: retrieve or skip
      └─ A bug here means users get EMPTY results for all matching queries
      └─ Also the reason DEBUG_RECALL logs have survivorship bias (skipped queries absent)
```

```
recall-cache.ts (89 lines, ZERO quality-eval coverage)
  └─ Cache keyed by query+scopes
       ├─ Cache hit → return cached results (no re-embedding)
       └─ Cache miss → retrieve, store in cache
      └─ Staleness: no test verifies cache-hit results match cache-miss results
```

```
debug-recall.ts (145 lines, ZERO quality-eval coverage)
  └─ MEMEX_DEBUG_RECALL env flag
       └─ Writes per-turn JSON snapshot to tmpdir/memex-debug-recall/
      └─ Planned source for live-recall quality sampling (Section 4.9)
      └─ MUST be validated before use (Step 0): seed known memories, verify output
```

```
BM25-only fallback (mcp-server.ts:266, ZERO quality-eval coverage)
  └─ When no embedder configured
       └─ store.bm25Search(query, limit, effectiveScopes)
      └─ Users without embedding API key get BM25-only results
      └─ BM25 scores are UNBOUNDED (not [0,1]) — hybrid-path thresholds meaningless
      └─ Needs separate calibration (F17)
```

```
Production sampling paths (for Section 4.9 denominator audit):
  Path A (MCP): memory_recall tool → mcp-server.ts:245-261 → MEMEX_DEBUG_RECALL log
  Path B (Hook): auto-recall → index.ts:1344 → recordRecalls() called here
  Queries SKIPPED by adaptive-retrieval.ts → NEITHER path → absent from DEBUG_RECALL
  → Survivorship bias: DEBUG_RECALL only contains queries that passed the skip gate
```

---

**Related files:**
- `/home/ubuntu/projects/memex/src/retriever.ts` -- RetrievalConfig, DEFAULT_RETRIEVAL_CONFIG, MemoryRetriever, applyAdaptiveMinScore (hardcoded `max(best*0.3, 0.15)` at line 885; floor varies per query), createRetriever factory, rerankResults, scope filtering at lines 344-352
- `/home/ubuntu/projects/memex/src/mcp-server.ts` -- MCP memory_recall handler (line 57: rerank:"none" hardcoded; lines 245-261: no recordRecalls call; line 266: BM25-only fallback with unbounded scores)
- `/home/ubuntu/projects/memex/src/memory.ts` -- MemoryStore, recordRecalls (line 848-852), recall_count column (line 222)
- `/home/ubuntu/projects/memex/src/unified-retriever.ts` -- UnifiedRetriever (mixed-source path, never quality-tested)
- `/home/ubuntu/projects/memex/src/search.ts` -- hybridQuery standalone function (BEIR benchmark path, RRF fusion, always reranks at line 3490)
- `/home/ubuntu/projects/memex/src/dreaming.ts` -- recall_count used for importance boost (lines 162-165), decay (lines 168-183), and health metric (lines 579-580); corrupted by missing recordRecalls in MCP path
- `/home/ubuntu/projects/memex/src/adaptive-retrieval.ts` -- (99 lines) Binary serve-or-skip gate; zero quality-eval coverage; source of survivorship bias in DEBUG_RECALL logs
- `/home/ubuntu/projects/memex/src/recall-cache.ts` -- (89 lines) Retrieval cache; zero quality-eval coverage
- `/home/ubuntu/projects/memex/src/debug-recall.ts` -- (145 lines) MEMEX_DEBUG_RECALL path; zero quality-eval coverage; must be validated before use as live-sampling data source
- `/home/ubuntu/projects/memex/index.ts` -- line 1344: ONLY caller of recordRecalls (auto-recall hook path only; MCP path never calls it)
- `/home/ubuntu/projects/memex/tests/domain-eval.ts` -- 15 queries, MemoryRetriever, zscore fusion, live DB
- `/home/ubuntu/projects/memex/tests/longmemeval-benchmark.ts` -- 50 queries, MemoryRetriever, zscore fusion, temp DB, temporal disabled, E2E conflated with LLM inference ability (synthetic dataset)
- `/home/ubuntu/projects/memex/tests/beir-benchmark.ts` -- BEIR document retrieval, hybridQuery() code path, temp DB, always reranks
- `/home/ubuntu/projects/memex/tests/latency-probe.ts` -- UnifiedRetriever latency, real DB, no quality metrics
- `/home/ubuntu/projects/memex/tests/helpers/ir-metrics.ts` -- nDCG, MRR, precision, recall (defined, unused in quality evals except BEIR)
- `/home/ubuntu/projects/memex/tests/helpers/beir-eval.ts` -- summarizeBeirQueries (simple mean, no CIs), evaluateBeirQuery
- `/home/ubuntu/projects/memex/tests/intake-guards.test.ts` -- line 301-345: unit tests for recordRecalls (proves method works when called, does NOT catch that MCP path never calls it)
- `/home/ubuntu/projects/memex/tests/tools-scoping.test.ts` -- line 66: sets hardMinScore:0.0 (dead config; effective floor varies by query = max(best*0.3, 0.15))
- `/home/ubuntu/projects/memex/tests/retriever-rerank-fallback.test.ts` -- lines 112, 127, 178: set hardMinScore:0.0 (dead config; effective floor varies by query)
- `/home/ubuntu/projects/memex/tests/retriever-rerank-blend-weight.test.ts` -- lines 71, 172, 190, 245, 262: set hardMinScore:0.0 (dead config; effective floor varies by query)
- `/home/ubuntu/projects/memex/tests/acceptance-temporal-queries.test.ts` -- line 192: sets hardMinScore:0 (dead config; effective floor varies by query)
- `/home/ubuntu/projects/memex/tests/fast-benchmark.ts` -- line 401: sets hardMinScore:0.10 (dead config; effective floor varies by query)
- `/home/ubuntu/projects/memex/docs/design/production-benchmark.md` -- Scoped but unimplemented (issue #19)
- `/home/ubuntu/projects/memex/docs/design/retrieval-redesign.md` -- Proposed zscore migration, hardMinScore fix
