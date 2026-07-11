# Recall Quality Design -- Canonical Spec

**Status:** design (with implementation notes) · **Date:** 2026-07-01 · **Updated:** 2026-07-11
**Supersedes:** `retrieval-redesign.md`, `recall-validation-analysis-revised.md`, `feedback-loop.md`
**Single source of truth for:** recall quality redesign, validation framework, feedback-loop boost, and sequencing.

> This document is the canonical spec. The three source docs are archived; this doc is the authority for all recall-quality work going forward. It includes corrections from a spec-review pass (C1-C7) verified against current code at the listed file:line references.
>
> **Implementation status (2026-07-11):** Wave 0 is complete (PRs #95, #103). F5 (recordRecalls in MCP), F12 (hardMinScore wired), C1 (reranker enabled in MCP — both cross-encoder and LLM), and C3 (hardMinScore wired with MEMEX_HARD_MIN_SCORE_OVERRIDE kill-switch) are implemented. The LLM reranker (deepseek-v4-flash, ordering-based, opt-in via MEMEX_RERANK_LLM_MODEL) was added as a second reranker option alongside the cross-encoder. Changes 2 (zscore default), 4 (temporal caps), 5 (semantic dedup), 6 (AutoCut), 7 (abstention), and 8 (provenance) remain planned. See §1.4 for per-change status.

---

## 0. Problem Statement

memex retrieval returns ~20 results that are mostly noise. A leaked CoT fragment (`ca1b32c6`) tops unrelated queries at ~0.7 score. The 94% LongMemEval E2E headline (reported in PROGRESS.md) disguises the fact that:

- **No eval tests the production config.** MCP `memory_recall` ~~hardcodes `rerank:"none"`~~ (FIXED v0.7.3 — now reads MEMEX_RERANK_* env vars, supports "cross-encoder" and "llm" modes) and used `fusionMethod:"weighted"` (`mcp-server.ts:76-83` + `retriever.ts:163`). Every quality eval uses a different (better) config: zscore fusion, 0.8/0.2 weights (`domain-eval.ts:160-165`). The BEIR benchmark calls `hybridQuery()` from `src/search.ts` -- a third, completely different code path that always reranks internally.
- **The reranker was dead in production.** ~~`mcp-server.ts:57` hardcodes `rerank:"none"`.~~ (FIXED v0.7.3 — MCP server reads MEMEX_RERANK_ENDPOINT, MEMEX_RERANK_API_KEY, MEMEX_RERANK_MODEL and dynamically enables cross-encoder reranking. Also supports opt-in LLM reranker via MEMEX_RERANK_LLM_MODEL.) `UnifiedRetriever` has zero quality-eval coverage.
- **hardMinScore was dead config.** ~~`applyAdaptiveMinScore` (`retriever.ts:881-888`) hardcodes `max(best*0.3, 0.15)` and never reads `this.config.hardMinScore`.~~ (FIXED v0.7.3 — now reads `this.config.hardMinScore`, default changed from 0.40 to 0.15, MEMEX_HARD_MIN_SCORE_OVERRIDE kill-switch wired in `createRetriever`.) 8+ test files set `hardMinScore:0.0` believing they disabled the floor -- vacuously testing at a floor of the wired config value.
- **Temporal signals are double-applied, uncapped, and universal.** `timeDecay` (half-life 60d) and `recencyBoost` (+0.10) both apply to every query. Re3 ablation: removing a per-query temporal gate drops R@1 from 0.742 to 0.268. memex has no gate (MEMEX_RELEVANCE_FIRST env flag exists as opt-in, off by default).
- **The recall-frequency signal (`recall_count`) was 99.26% zero.** ~~MCP `memory_recall` never calls `store.recordRecalls()` (`mcp-server.ts:245-261`).~~ (FIXED v0.7.3 — MCP recall now calls `store.recordRecalls()` in both the retriever path and the BM25 fallback path.) The live boost (`retriever.ts:806-808`) still uses an in-memory `Map` that resets on restart -- it never reads the persistent column. Dreaming deprioritizes and may evict memories that users actively consume, because it believed they were never recalled (`dreaming.ts:168-183`).
- **E2E numbers conflate retrieval quality with LLM inference ability.** LongMemEval's synthetic chat histories mean GPT-4o cannot know the answers from pre-training, but it can infer plausible answers from persona-modeling. The published 94% E2E number has no zero-context baseline subtracted, so retrieval contribution is unknown.

### 0.1 Dual-Gate Iteration Thesis

```
TESTS  ⇄  VALIDATION  ⇄  LIVE-SAMPLING
  ↑                          ↓
  └── correctness gate       └── quality gate (nDCG@5 on real traffic)
```

Each retrieval change must pass three gates:
1. **Tests (correctness gate):** TDD -- red-green-refactor per change. Unit + integration tests verify the intended behavior.
2. **Validation (quality gate):** Benchmarks + calibration probes measure whether the change actually improves retrieval quality on representative data.
3. **Live-sampling (truth):** nDCG@5 sampled from real production traffic before and after every config-affecting change. This is the only metric that directly answers "are users getting better results?"

Iteration is a closed loop: live-sampling reveals gaps → validation adds criteria → tests lock in the fix.

---

## 1. Design -- Retrieval Pipeline Changes

### 1.1 Current Pipeline (broken) -- `MemoryRetriever.retrieve()` in `src/retriever.ts`

```
query → vector(0.7) + BM25(0.3)
      → weighted fusion (incomparable scales: cosine[0,1] vs unbounded BM25)
      → minScore ≥ 0.3
      → [cross-encoder reranker: DYNAMIC (env-var gated; "cross-encoder", "llm", or "none")]
      → [LLM reranker: opt-in via MEMEX_RERANK_LLM_MODEL]
      → + recencyBoost (+≤0.10, universal, halfLife 14d)              [retriever.ts:833]
      → × importance (0.7-1.0)                                         [retriever.ts:865]
      → × lengthNorm (charLen/500)                                      [retriever.ts:887]
      → × timeDecay (×0.50-1.0, universal, halfLife 60d)               [retriever.ts:920]
      → adaptiveFloor = max(best×0.3, config.hardMinScore)             [retriever.ts:945 — FIXED v0.7.3, was hardcoded 0.15]
      → noiseFilter / MMR
      → slice(limit=20)
```

### 1.2 Target Pipeline (noise-robust)

```
query → vector + BM25
      → zscore fusion (scale-invariant, implemented in v0.7, not yet wired to production)  [retriever.ts fuseResults:513-600]
      → semantic dedup (cosine > 0.9 → keep best) BEFORE rerank         [retriever.ts new pre-rerank step]
      → cross-encoder RERANK (LIVE, local Qwen3-Reranker-0.6B)          [retriever.ts:623 rerankResults]
      → QDF gate: detectTemporalRange(query) decides recency weight     [temporal.ts:40-115, imported but never called]
      → + capped recency (max +0.05, AND only if base ≥ 0.40)           [retriever.ts:774]
      → × importance (0.7-1.0, multiplicative only)                     [retriever.ts:800]
      → × lengthNorm (charLen/500, retained — valid signal)             [retriever.ts:461-462]
      → remove timeDecay (asymptotic floor 0.50 → old memories lose up to 50% of their score, redundant with additive recency)
      → confidence floor (wired hardMinScore, applied after all modifiers except MMR/AutoCut/abstention; modifiers between rerank and floor must be bounded to not push valid results below the floor through multiplicative effects)  [retriever.ts:881]
      → AutoCut: truncate at first score gap ≥ 0.15                     [retriever.ts new post-filter step]
      → abstention: return [] if nothing clears floor                   [retriever.ts new]
      → MMR diversity
      → slice(top-K) with source: vector|lexical|both|reranked
      → + bounded log-additive recall-frequency boost (§5)              [retriever.ts:806-808 rewrite]
```

### 1.3 Five Principles (with corrections)

**P1. Relevance is primary; temporal/popularity are capped tie-breakers, never overrides.**
Source: ES `max_boost` 1.5-2.0. Vespa additive `min(boost, 0.10-0.15)`. Temporal-RAG semantic-penalty floor. Re3: removing per-query temporal gate drops R@1 0.742→0.268.

**P2. Fuse with zscore normalization, not raw weighted blend.**
Cosine [0,1] and unbounded BM25 are incomparable; an alpha-blend is scale-dominated. Z-score normalizes each signal's distribution to zero-mean/unit-variance before combining (`retriever.ts:513-600` already implements this). **CORRECTION (C1):** RRF is NOT a one-line config flip. `RetrievalConfig.fusionMethod` only accepts `"weighted"|"zscore"` (`retriever.ts:27`). `reciprocalRankFusion` exists only on the document path (`search.ts:2798`). Adding RRF to the memory retriever requires: (a) extending the type to `"weighted"|"zscore"|"rrf"`, (b) adding an RRF branch in `fuseResults`, and (c) normalizing RRF scores to [0,1] for downstream modifiers. Z-score fusion, already implemented and used by domain-eval and LongMemEval, is the correct immediate target. RRF on the memory path is deferred to post-zscore measurement.

**P3. Query-Deserves-Freshness (QDF).** Apply recency only for time-sensitive queries. `detectTemporalRange` (`temporal.ts:40-115`) is a training-free gate that parses "yesterday," "last week," "past 3 days," etc. into [start, end] timestamps. It is imported in `retriever.ts:10` but never called. Universal recency penalizes evergreen content.

**P4. Retrieve → fuse → rerank with a LIVE cross-encoder; boosts after, capped.**
Reranker = the noise filter. Anthropic contextual retrieval: --67% retrieval failure with reranker. **CORRECTION (C5):** MCP `memory_recall` hardcodes `rerank:"none"` (`mcp-server.ts:57`). The reranker-dependent design is currently a NO-OP on the containerized daemon's primary explicit recall path. **CORRECTION (C7):** The reranker is a single point of failure. The existing graceful-degradation path (`retriever.ts:728-736` -- return fusion results unchanged on reranker API failure) is a good default, but it is LOST once the confidence floor depends on reranker scores. The fix: (a) enable the reranker in the MCP path, (b) deploy Qwen3-Reranker-0.6B via the existing llama-swap infra (already serving embedder + LLM), and (c) when the reranker is down, fall back to z-score-calibrated cosine scores with a relaxed floor.

**P5. Return only confident matches -- 1, or 0 (abstention).**
Oversample → reranker threshold → empty if nothing clears the bar. **CORRECTION (C6):** Abstention has zero agent guardrails. `return []` from `memory_recall` is indistinguishable from "store is empty" to the agent; the agent may hallucinate. The fix has three parts: (a) return a low-confidence signal (structured field `confidence: "low"|"medium"|"high"` or a sentinel result with `id:"memex:abstention:no_strong_match"` and explanatory text), (b) provide a best-effort fallback (return fusion-only results marked `confidence:"low"` when the reranker is available but all results score below the floor), and (c) add agent instructions to treat low-confidence results as speculative.

### 1.4 Change Specifications (with file:line references)

#### Change 1: Enable reranker in MCP production path -- IMPLEMENTED (v0.7.3, PR #103)

**File:** `src/mcp-server.ts:63-84` (createRetriever call + env var reads), `src/retriever.ts:628` (rerankResults guard)

**Implementation (complete):** The MCP server now reads `MEMEX_RERANK_ENDPOINT`, `MEMEX_RERANK_API_KEY`, and `MEMEX_RERANK_MODEL` from the environment. It dynamically sets `rerank: "cross-encoder"` when both endpoint and API key are set; `rerank: "none"` otherwise (preserving the prior safe default). Model default is `jina-reranker-v3`; override via env var.

**LLM reranker (also implemented):** A second reranker option, opt-in via `MEMEX_RERANK_LLM_MODEL`, uses a chat model (e.g., deepseek-v4-flash) as an ordering-based relevance judge (`src/rerankers/llm-reranker.ts`). When set, `rerank: "llm"` takes precedence over the cross-encoder. Requires `MEMEX_LLM_ENDPOINT`. Quality: baseline 69%, cross-encoder 77%, LLM reranker 85% (domain-eval, 26 queries, Wilson 95% CI).

**Graceful degradation:** Cross-encoder failures return fusion results unchanged (not cosine-fallback). LLM reranker failures also return fusion results unchanged. Both paths are in `retriever.ts:730-796`.

**Prerequisite:** Deploy Qwen3-Reranker-0.6B via llama-swap (the same infra serving the embedder). This model is already deployed as of v0.7, replacing the stale BGE-reranker-v2-m3 (which had an 8K context bug). Reranker endpoint + API key configured via env vars, not hardcoded. **Model config:** Do NOT change the DEFAULT `rerankModel` (`jina-reranker-v3` in `retriever.ts:170`) -- it is a safe Jina fallback. Override via env var `MEMEX_RERANK_MODEL=Qwen3-Reranker-0.6B` in the production environment.

**CORRECTION (C5, C7):** This enables the reranker on the primary explicit recall path. Paired with the graceful-degradation fallback.

#### Change 2: Flip fusion method from weighted to zscore

**File:** `src/retriever.ts:152`
**Current:** `fusionMethod: "weighted"` in `DEFAULT_RETRIEVAL_CONFIG`.
**Target:** `fusionMethod: "zscore"` in `DEFAULT_RETRIEVAL_CONFIG`.
**Note:** `mcp-server.ts:57` only sets `{ mode: "hybrid", rerank: "none" }` -- fusionMethod is inherited from DEFAULT. Changing `retriever.ts:152` alone propagates to all consumers; no separate MCP change needed.
**Rationale:** Z-score fusion (`retriever.ts:513-600`, already implemented) normalizes each signal to zero-mean/unit-variance before combining. Weighted fusion blends cosine [0,1] with unbounded BM25 on incompatible scales. Domain eval and LongMemEval already use zscore; this aligns production with what evals measure.

**CORRECTION (C1):** This is NOT a "one-line RRF config flip." RRF requires real plumbing (type extension + fuseResults branch + result-type mapping). Z-score is the correct immediate target -- it is already implemented, already tested in evals, and addresses the scale-domination problem. RRF on the memory path is captured as a deferred item for post-zscore measurement.

**Note:** The file header comment at `retriever.ts:3` (`Combines vector search + BM25 full-text search with RRF fusion`) is stale and misleading. Update it to `Combines vector search + BM25 full-text search with weighted or zscore fusion` as part of this change. Do not replace "RRF" with just "zscore" -- the code still supports both `"weighted"` and `"zscore"` (`config.fusionMethod` union type at `retriever.ts:27`).

#### Change 3: Wire hardMinScore into applyAdaptiveMinScore -- IMPLEMENTED (v0.7.3, PR #95)

**File:** `src/retriever.ts:945-951`
**Implementation (complete):**
```ts
private applyAdaptiveMinScore(results: RetrievalResult[]): RetrievalResult[] {
  if (results.length === 0) return results;
  const bestScore = results[0].score;
  const relativeFloor = bestScore * 0.3;
  const absoluteFloor = this.config.hardMinScore;            // wired from config
  const effectiveFloor = Math.max(relativeFloor, absoluteFloor);
  return results.filter(r => r.score >= effectiveFloor);
}
```
`DEFAULT_RETRIEVAL_CONFIG.hardMinScore` is now `0.15` (was `0.40`). The kill-switch `MEMEX_HARD_MIN_SCORE_OVERRIDE` is wired in `createRetriever` (`retriever.ts:1105-1108`), allowing rollback without redeploy.

**CORRECTION (C2):** `hardMinScore` is no longer dead config. The test audit (§3.1) still applies: 8+ test files set `hardMinScore` values whose effective floor was previously hardcoded.

#### Change 4: Cap temporal signals + add QDF gate

**File:** `src/retriever.ts:774-780` (recencyBoost), `src/retriever.ts:850-873` (timeDecay)
**Current:**
- `recencyBoost`: `+0.10` additive, universal, halfLife 14d
- `timeDecay`: `×0.50-1.0` multiplicative, universal, halfLife 60d
- The formula `0.5 + 0.5*exp(-ageDays/halfLife)` has an asymptotic floor of 0.50 implicit in the math -- it is not a separate configurable parameter. At 15d the factor is ~0.90, so even "young" entries lose 10%; old entries converge toward the 0.50 asymptote.

**Target:**
- `recencyWeight`: `0.10 → 0.05` (halve max additive delta)
- Relevance gate: only apply recency boost when `baseScore ≥ 0.40` (don't boost irrelevant docs)
- QDF gate: `recencyWeight` scales by QDF signal: `fullWeight` if `detectTemporalRange(query) !== null`, else `recencyWeight * QDF_OFF_PENALTY` (e.g., 0.05 * 0.1 = 0.005). `detectTemporalRange` (`temporal.ts:40-115`) is imported but never called (`retriever.ts:10`).
- **Remove `applyTimeDecay` entirely.** The multiplicative penalty (asymptotic floor 0.50 from `0.5 + 0.5*exp(-ageDays/halfLife)`) is redundant with the additive recency boost above. At 60d half-life, old-but-relevant memories lose up to 50% of their score (asymptotic floor 0.50) -- this is the mechanism that sinks old relevant facts below new irrelevant ones.

**CORRECTION (timeDecay removal):** The retrieval-redesign spec proposed adding a configurable floor (`max(factor, 0.90)`) to timeDecay. At 15d, the penalty is already ~0.90, so such a floor would only bind after 15d, effectively removing the temporal signal past that point. The better fix: remove the multiplicative timeDecay path entirely. The additive recency boost covers freshness with a single, auditable mechanism, and the asymptotic 0.50 floor is eliminated. No configurable floor is added; the entire signal path is removed.

#### Change 5: Implement semantic dedup before rerank

**File:** `src/retriever.ts` (new step in `hybridRetrieval`, between fusion and rerank)
**What:** After fusion, compute pairwise cosine similarity on candidate vectors. For pairs with cosine > 0.9, keep the higher-scored result and discard the other.
**Edge cases:**
- (a) Results without vectors (BM25-only results, ghost entries from the FIX(#15) check at `retriever.ts:558-565`) skip the pairwise comparison and are treated as unique -- they cannot be deduplicated by cosine.
- (b) Complexity: O(n^2) = ~780 cosine computations for 40 candidates. At typical vector dimensions (1024d), acceptable but should be measured in benchmarks. Optimization: pre-cluster by cosine > 0.9 using a single pass against a growing representative set rather than full pairwise.
**Rationale:** Near-duplicate fragments (e.g., three similar "SVG style" memories) consume reranker budget and crowd the top-K. Current dedup is exact-text only (`lightSweep`) and runs after MMR. This runs before the expensive rerank call.

#### Change 6: Implement AutoCut (gap-threshold truncation)

**File:** `src/retriever.ts` (new method, invoked after `applyAdaptiveMinScore`)
**What:** After the hardMinScore filter, walk the sorted results. At the first gap where `results[i].score - results[i+1].score ≥ 0.15`, truncate the list (keep results[0..i]).
**Rationale:** AutoCut finds the natural "knee" in score distribution. A gap of 0.15 between consecutive reranker scores is a strong signal of a relevance boundary. This replaces the `slice(limit=20)` padding pattern with data-driven truncation.

#### Change 7: Implement abstention with agent guardrails

**File:** `src/retriever.ts` (new logic after AutoCut), `src/mcp-server.ts:245-261` (return format)
**What:**
- If AutoCut removes all results, or if `applyAdaptiveMinScore` filters all results, return `[]` BUT with a structured signal.
- Add to `memory_recall` return: a top-level `confidence` field: `"high"` (all results above 0.5), `"medium"` (mixed, at least one above 0.4), `"low"` (results present but below 0.5), `"none"` (empty).
- When `confidence === "none"` or `"low"`, inject a sentinel result: `{ id: "memex:abstention:no_strong_match", text: "No strongly relevant memories found. Treat any prior knowledge as speculative.", score: 0, source: "abstention" }`. The `memex:` prefix namespace avoids collision with UUID-based entry IDs and with any future internal `__`-prefixed sentinel conventions.
- Add to MCP instructions: "When confidence is 'low' or 'none', do not fabricate information. Acknowledge that memory search found no strong matches."
- Best-effort fallback: when the reranker is DOWN (graceful degradation path, `retriever.ts:728-736`), return fusion results marked `confidence:"low"` rather than empty.

**CORRECTION (C6):** `return []` alone is indistinguishable from "store empty." The three-part guardrail (confidence field + sentinel result + agent instruction) distinguishes genuine empty-store from below-threshold.

**CORRECTION (C7):** The graceful-degradation path (`retriever.ts:728-736`) returns fusion results when the reranker is down. The best-effort fallback preserves this: fusion-only results are returned with `confidence:"low"` rather than discarded. The confidence floor is relaxed when the reranker is unavailable.

#### Change 8: Expose provenance in results

**File:** `src/retriever.ts:136-142` (already typed, needs wiring to output), `src/mcp-server.ts:245-261` (return format)
**What:** `RetrievalResult.sources` tracks `{vector, bm25, fused, reranked}` per result. Wire this to the `memory_recall` output as a `source` field.
**Rationale:** "both" (vector + lexical concordance) is a free high-precision signal. Provenance enables debugging of ranking failures.

### 1.5 What Changes for Each Recall Pipeline

**CORRECTION (C4):** There are three distinct recall pipelines, not one. Changes must target each:

| Pipeline | Entry Point | Current Config | Affected by |
|---|---|---|---|
| **MCP `memory_recall`** | `mcp-server.ts:57 → MemoryRetriever` | weighted fusion, rerank:none | Changes 1, 2, 3, 4, 5, 6, 7, 8 |
| **Auto-recall hook** | `index.ts:1344 → UnifiedRetriever` | Own config, zscore fusion, reranker optional | Changes 5, 6 (UnifiedRetriever has its own modifier pipeline at `unified-retriever.ts:524-567`) |
| **Document `search.ts`** | `search.ts:3326 → hybridQuery()` | RRF fusion, reranker always on (`search.ts:3490`) | Independent pipeline; not in scope for memory-retrieval changes |

The MCP `memory_recall` path is priority #1 (it is the daemon's primary explicit recall path and has the worst config). The auto-recall hook path (UnifiedRetriever) needs separate config alignment. The document path is a third concern, out of scope for this document.

---

## 2. Validation -- Criteria, Measurement, and Gaps

### 2.1 Ten Quality Criteria

Derived from `recall-validation-analysis-revised.md`. Each criterion has a metric, a measurement method, and a gap status.

| # | Criterion | Metric | Measurement | Status |
|---|---|---|---|---|
| V1 | Ranking quality | nDCG@5 (position-aware, graded relevance) | Production-config retrievals; bootstrap 95% CI | nDCG implemented (`ir-metrics.ts:36-56`), never wired into quality evals |
| V2 | Score calibration | ECE (expected calibration error); precision-at-threshold | Bin scores by decile; compare fraction-relevant to bin midpoint | Never measured |
| V3 | Abstention correctness | Precision@empty, Recall@empty (false-negative rate), Coverage, Abstention F1 | Threshold sweep 0.0-0.8 on true IR negatives + positives | Never measured; hardMinScore is dead config |
| V4 | Noise robustness | Recall degradation under injected pollution | 4 pollution types (keyword parasites, CoT fragments, contradictions, stale near-dupes); degradation curve | Clean-store-only evals |
| V5 | Production fidelity | All above, on MemoryRetriever with MCP production config | Exact code path, exact config, persistent DB | No eval uses production config (Appendix A) |
| V6 | Multi-session / temporal | Temporal recall degradation curve at +1/+5/+20 sessions | Staggered-index benchmark with timestamped memories | Temporal effects disabled in LongMemEval (`longmemeval-benchmark.ts:374-376`) |
| V7 | Distribution transfer | KS test on embedding-space distributions; BM25 degradation ratio | 100 production vs 100 BEIR embeddings; relative degradation from BM25 baseline | Not measured; BEIR domains have zero overlap with memex traffic |
| V8 | E2E attribution | E2E delta = E2E_with_retrieval - E2E_zero_context, decomposed | 3-condition (zero, irrelevant, correct) + two-stage citation verification | Delta never measured; 94% conflated with LLM inference |
| V9 | Live-production quality | nDCG@5 on 100 real recall queries, with coverage audit | Before/after each config change; denominator audit (coverage = retrieval-attempted/total-turns) | Never measured; DEBUG_RECALL collection mechanism unvalidated |
| V10 | Scoped retrieval | Per-cardinality optimal hardMinScore | Threshold sweep at single-scope, multi-scope, unscoped levels | Never measured; all thresholds assume full-DB |

### 2.2 Seventeen Gaps (from recall-validation-analysis-revised.md)

1. **Gap 1:** Production code path never quality-tested (`mcp-server.ts:57` config never used in evals)
2. **Gap 2:** Corpus composition -- evals use clean 53-doc temp stores; production has 2100+ polluted entries
3. **Gap 3:** Metric mismatch -- binary R@k vs nDCG@5/Precision@1 (nDCG implemented but never wired)
4. **Gap 4:** Config drift -- eval config (zscore, 0.8/0.2) is better than production (weighted, 0.7/0.3)
5. **Gap 5:** Reranker story inconsistent -- MCP hardcodes `rerank:none`; published numbers are reranker-on
6. **Gap 6:** BEIR mislabeled as "production mixed-source" -- it is pure document retrieval via `search.ts`
7. **Gap 7:** No temporal/recency effects in evals -- all zeroed in LongMemEval
8. **Gap 8:** No abstention or noise-robustness measurement -- all queries have ground-truth answers
9. **Gap 9:** Small-N (15-50), no confidence intervals, no multiple-comparison correction
10. **Gap 10:** MCP `memory_recall` never calls `recordRecalls()` -- data-corruption bug (`mcp-server.ts:245-261`)
11. **Gap 11:** `hardMinScore` is dead config (`retriever.ts:881-888` hardcodes `max(best*0.3, 0.15)`)
12. **Gap 12:** No production-scale DB characteristics tested (all temp DBs)
13. **Gap 13:** Distribution-shift analysis inadequate (vocabulary overlap is near-useless)
14. **Gap 14:** Score calibration and abstention threshold not measured
15. **Gap 15:** Embedding model treated as fixed infrastructure -- calibration is model-specific
16. **Gap 16:** Goodhart's law risk -- benchmark queries become optimizable targets
17. **Gap 17:** Scoped retrieval completely unaddressed (thresholds assume full-DB)

### 2.3 F-Number Reference (Fix-to-Gap Mapping)

The F-numbers (F1-F18) come from the archived `recall-validation-analysis-revised.md` and are used throughout the Wave sequencing in §6. Each F-number maps to a gap from §2.2 and a concrete action.

| F# | Description | Gap(s) Closed |
|---|---|---|
| F1 | Production-config benchmarks (domain-eval + LongMemEval with weighted fusion, 0.7/0.3, rerank:none as PRIMARY column; zscore+rerank as upgrade column) | Gap 1, Gap 4 |
| F2 | E2E delta reporting (3-condition LongMemEval: zero/irrelevant/correct) + two-stage citation verification | Gap 8 |
| F3 | Calibration + abstention probe with true IR negatives + scoped calibration + embedding model comparison | Gap 14 |
| F5 | Fix `recordRecalls` wiring in MCP path + dreaming impact audit | Gap 10 |
| F6 | Bootstrap 95% CIs on all metrics; pre-register nDCG@5 as primary metric; Benjamini-Hochberg FDR control | Gap 9 |
| F7 | BEIR relabeling + genuine mixed-source benchmark (UnifiedRetriever) | Gap 6 |
| F8 | Noise-robustness stress test (4 pollution types, degradation curves) | Gap 2, Gap 14 |
| F9 | Temporal degradation benchmark (staggered-index, before/after recency changes) | Gap 7 |
| F10 | Reranker labeling fix (report rerank:none as primary in all benchmarks) | Gap 5 |
| F11 | Config alignment verification (production vs eval config delta measurement) | Gap 4 |
| F12 | hardMinScore test audit with effective-floor quantification + two-phase canary test | Gap 11 |
| F13 | MCP integration smoke tests | -- |
| F14 | Persistent benchmark DB + synth-data validation + query protection | Gap 12, Gap 16 |
| F15 | Distribution-shift analysis (KS test + BM25 degradation ratio) | Gap 13 |
| F16 | Wire nDCG@5 into domain-eval | Gap 3 |
| F17 | Path coverage logging + zero-coverage path tests (adaptive-retrieval.ts, recall-cache.ts, debug-recall.ts, BM25-only fallback) | -- |
| F18 | Embedding model comparison (calibration probe with 2+ models) | Gap 15 |

### 2.4 How to Measure Each Criterion

The original measurement protocols are in §4 of `recall-validation-analysis-revised.md` (retained for reference in the archive). The essential implementation plan per criterion is listed below and is sufficient for all Wave 0-4 work:

- **V1 (nDCG@5):** Wire `ir-metrics.ts` nDCG into domain-eval.ts + all new benchmarks. Pre-register nDCG@5 on production config as the primary metric.
- **V2 (ECE):** True IR negatives via LLM judging (0-3 scale on 100 production queries x 5 results). Score-decile bins. ECE computation.
- **V3 (Abstention):** Threshold sweep on calibratrion probe queries. F1 of the abstention decision. False-negative measurement on positive queries.
- **V4 (Noise):** Inject 4 pollution types; plot nDCG@5 degradation curve.
- **V5 (Production fidelity):** Run domain-eval + LongMemEval with production config as the PRIMARY column. Report eval-config as an upgrade column.
- **V6 (Temporal):** Staggered-index benchmark: -30d/-14d/-7d/-1d/now timestamps. Sweep recencyWeight.
- **V7 (Distribution transfer):** KS test on embedding-space cosine distributions. BM25 degradation ratio. Transfer-gap caveat on all BEIR reporting.
- **V8 (E2E attribution):** 3-condition LongMemEval (zero/irrelevant/correct). Decompose into hallucination-prevention + knowledge-filling. Two-stage citation verification.
- **V9 (Live sampling):** Step 0: validate DEBUG_RECALL collection mechanism. Sample 100 queries from BOTH MCP and auto-recall hook paths. Denominator audit (coverage). Before/after nDCG@5.
- **V10 (Scoped):** Abstention threshold sweep at 3 scope cardinality levels. Per-cardinality optimal hardMinScore.

---

## 3. Testing Layer -- TDD Test Per Change

Every design change MUST have a corresponding test BEFORE implementation. Tests serve as the correctness gate in the dual-gate thesis.

| Change | Test | Type | What It Verifies |
|---|---|---|---|
| C1: Enable reranker in MCP | `tools-recall-reranker.test.ts` | Integration | MCP `memory_recall` with rerank:"cross-encoder" invokes reranker and returns reranked scores |
| C1: Reranker graceful degradation | `retriever-rerank-fallback.test.ts` (extend) | Unit | When reranker API fails, fusion results returned with confidence:"low" |
| C2: Z-score fusion in MCP | `tools-scoping.test.ts` (extend) | Integration | MCP `memory_recall` uses zscore fusion; results differ from weighted; config alignment verified |
| C3: hardMinScore wired | `retriever-hardminscore-wired.test.ts` (new) | Unit (two-phase canary) | Phase A: hardMinScore=0.01 → results returned. Phase B: mock scores=0.20, hardMinScore=0.50 → zero results. Verifies config is read and applied. |
| C3: hardMinScore threshold | `retriever-hardminscore-threshold.test.ts` (new) | Unit | Known scores [0.5, 0.3, 0.2], hardMinScore=0.35 → only 0.5 returned |
| C4: Recency cap + relevance gate | `retriever-recency-cap.test.ts` (new) | Unit | Below-threshold result (score 0.30) gets no recency boost; above-threshold gets capped +0.05 max |
| C4: QDF gate | `retriever-qdf-gate.test.ts` (new) | Unit | Query "what is the server password" → no QDF → recencyWeight ≈ 0. Query "what did I change yesterday" → QDF detected → recencyWeight = full |
| C4: timeDecay removed | `retriever-no-time-decay.test.ts` (new) | Unit | Old (60d) relevant result scores identically to new (0d) relevant result (no multiplicative penalty) |
| C5: Semantic dedup | `retriever-semantic-dedup.test.ts` (new) | Unit | Three memories with cosine>0.9 → only best-survives. Two dissimilar memories → both survive. |
| C6: AutoCut | `retriever-autocut.test.ts` (new) | Unit | Scores [0.8, 0.75, 0.30, 0.28] → gap 0.45 at position 2 → truncate to [0.8, 0.75] |
| C7: Abstention with guardrails | `retriever-abstention.test.ts` (new) | Unit + Integration | All results below floor → returns [] with confidence:"none" + sentinel. Reranker down → confidence:"low" + fusion results. Results above floor → confidence:"high"/"medium". |
| C8: Provenance | `retriever-provenance.test.ts` (new) | Unit | Vector-only result → source:"vector". Both → source:"both". Reranked → source:"reranked". |

### 3.1 hardMinScore Test Audit (Priority Fix)

**CORRECTION (C2):** 8+ test files set `hardMinScore` to values that are silently ignored:

- `tools-scoping.test.ts:66` (`hardMinScore: 0.0`)
- `retriever-rerank-fallback.test.ts:112,127,178` (`hardMinScore: 0.0`)
- `retriever-rerank-blend-weight.test.ts:71,172,190,245,262` (`hardMinScore: 0.0`)
- `acceptance-temporal-queries.test.ts:192` (`hardMinScore: 0`)
- `longmemeval-benchmark.ts:373` (`hardMinScore: 0.10`)
- `fast-benchmark.ts:401` (`hardMinScore: 0.10`)

**Effective floor varies per query:** `max(best*0.3, 0.15)`. For queries where `best > 0.5`, effective floor > 0.15. For `best=0.8`, floor=0.24. Tests with `hardMinScore: 0.0` believe they disabled the floor but actually run with floor 0.15-0.24+.

**Audit plan (F12 from validation doc):**
1. Instrument `applyAdaptiveMinScore` during test runs to log min/mean/max effective floor per test file.
2. Identify all test queries where effective floor > 0, and annotate whether any ground-truth result falls below the effective floor (i.e., the floor silently filtered a correct answer). Prioritize audit of test files with at least one such case.
3. Annotate tests with `// KNOWN: hardMinScore not wired (Gap 11); actual floor varies`.
4. Implement two-phase canary test (see table above, C3 test row).
5. Re-audit all tests after wiring.

---

## 4. Change-to-Test-to-Validation Mapping

Every design change maps to one or more tests (correctness) and one or more validation criteria (quality).

| Design Change | TDD Test | Validates | Gap(s) Closed |
|---|---|---|---|
| C1: Enable reranker in MCP | tools-recall-reranker.test.ts | V5 (production fidelity) | Gap 5 (reranker story) |
| C1: Graceful degradation fallback | retriever-rerank-fallback.test.ts (extend) | V3 (abstention) | C7 (SPOF) |
| C2: Z-score fusion in MCP | tools-scoping.test.ts (extend) | V5 (production fidelity), V1 (ranking) | Gap 4 (config drift) |
| C3: Wire hardMinScore | retriever-hardminscore-wired.test.ts + threshold.test.ts | V3 (abstention), V2 (calibration) | Gap 11 (dead config), Gap 8 (abstention) |
| C3: hardMinScore test audit | (audit, not new test) | V3 | Gap 11 (vacuously true tests) |
| C4: Cap recency + relevance gate | retriever-recency-cap.test.ts | V1 (ranking), V6 (temporal) | Gap 7 (recency inversion) |
| C4: QDF gate | retriever-qdf-gate.test.ts | V1, V6 | Gap 7 (universal recency penalty) |
| C4: Remove timeDecay | retriever-no-time-decay.test.ts | V1, V6 | Gap 7 (double temporal penalty) |
| C5: Semantic dedup | retriever-semantic-dedup.test.ts | V4 (noise robustness) | Gap 2 (near-dupe crowding) |
| C6: AutoCut | retriever-autocut.test.ts | V3 (abstention) | Gap 8 (padding to limit) |
| C7: Abstention + guardrails | retriever-abstention.test.ts | V3, V1 | Gap 8, C6 (no guardrails) |
| C8: Provenance | retriever-provenance.test.ts | V1 (diagnostic) | -- |

---

## 5. Feedback-Loop Boost -- Bounded Recall-Frequency Signal

Integrated from `feedback-loop.md`. This is a small, bounded signal that complements semantic relevance without overriding it.

### 5.1 Problem

The `recall_count` column exists and is persisted correctly (`memory.ts:222, 848-852`), but:
- **MCP never bumps it:** `memory_recall` never calls `store.recordRecalls()` (`mcp-server.ts:245-261`). Only the auto-recall hook path bumps it (`index.ts:1344`). This is a data-corruption bug (Gap 10).
- **Live retrieval ignores it:** The ephemeral `freqBoost` in `applyImportanceWeight` (`retriever.ts:806-808`) uses an in-memory `Map` that resets on restart; it never reads the persistent column.
- **Pool signal is 99.26% zero:** 267/269 memories have `recall_count = 0`. Dreaming deprioritizes and may evict "never recalled" memories that were actually MCP-recalled (`dreaming.ts:168-183`).

### 5.2 Prerequisite Fix (do first)

Add `store.recordRecalls(results.map(r => r.entry.id))` after `mcp-server.ts:246` (and after the BM25 fallback at `:266`). This is a one-line correctness fix. Without it, the feedback-loop boost is a no-op.

**Backfill strategy:** Do NOT backfill `recall_count = 1` for existing memories. There is no way to know which memories were actually MCP-recalled historically; setting `recall_count = 1` for all would mark every memory as recalled, artificially inflating the boost signal and defeating the purpose of distinguishing frequently-used from never-used memories. Instead, accept the cold-start: `recall_count` already defaults to 0 via the column migration at `memory.ts:222`. The feedback-loop boost is a no-op for 99.26% of the pool until real signal accumulates. The deployment note in §7 already acknowledges that the boost "changes nothing on day 1" -- this cold-start aligns with that reality. Measure `recall_count` distribution over weeks as the leading indicator, not benchmark scores.

### 5.3 Formula

```
boost       = min(MAX_BOOST, F * log2(1 + recall_count))
finalScore  = clamp01(rawScore + boost, floor = rawScore)
```

| Constant | Value | Rationale |
|---|---|---|
| `F` | `0.015` | ~1.5% per log2 unit. First recall → +0.015 (visible tiebreaker). Flattens fast. |
| `MAX_BOOST` | `0.10` | Matches the existing `recencyBoost` cap and the current ephemeral `freqBoost` ceiling. |

### 5.4 Boundedness Proof

1. `log2(1+n)` is concave: derivative `1/((1+n)*ln 2) → 0`. Diminishing returns built in.
2. `min(MAX_BOOST, …)` hard-caps at +0.10 for all n.
3. `clamp01(…, floor = rawScore)` guarantees score never drops below pre-boost value and never exceeds 1.0.
4. Net: the boost is a tiebreaker, never a ranking inverter. A 0.15-relevance memory at +0.10 (≤0.25) still loses to an 0.80-relevance memory.

### 5.5 Hook Points

- **MemoryRetriever:** Replace the ephemeral `freqBoost` inside `applyImportanceWeight` (`retriever.ts:806-808`) with the persistent formula reading `r.entry.recall_count`.
- **Cleanup:** Remove the private `recallFrequency: Map<string, number>` field (`retriever.ts:978`) and its `recordRecall` mutator (`retriever.ts:985`) once the persistent boost is verified. The ephemeral Map becomes dead code after the switch to the persistent column.
- **UnifiedRetriever:** Apply the same boost inside `applyPostMergeModifiers` (`unified-retriever.ts:524-567`) to conversation results. Documents have no `recall_count` → boost = 0 (correct no-op).
- **Document pipeline (`search.ts`):** Out of scope for v1. Documents are static content; the asymmetry is acceptable.

### 5.6 Schema Change

`MemoryEntry` (`memory.ts:21-33`) does not expose `recall_count`. Add `recall_count?: number` to `MemoryEntry` and include `m.recall_count` in the `vectorSearch` and `bm25Search` SELECT lists. This keeps the hot path single-query.

### 5.7 TDD Plan

1. **Zero is identity:** Two memories with `recall_count=0` retrieve at equal score, identical to no-boost pipeline.
2. **Cap holds:** `recall_count=10_000`, `rawScore=0.50` → `finalScore ≤ 0.60` and `≤ 1.0`.
3. **Concavity:** `boost(5) - boost(1) < boost(1) - boost(0)`; `boost(0) === 0`.
4. **Relevance dominance:** Weak semantic match (0.15) with `recall_count=100` still ranks below strong match (0.80) with `recall_count=0`.
5. **Persistence survives restart:** Recall a memory, restart retriever, re-retrieve → boost is present (reads DB column).
6. **MCP capture:** Recall via MCP tool → `recall_count` increments by 1 and `last_recalled_at` updates.
7. **Unified path:** Conversation memory with `recall_count=5` gets non-zero boost; document is unchanged.

---

## 6. Sequencing -- Waves and Gates

### Wave 0: Ground Truth (~4 days)

F1: Production-config benchmarks (domain-eval + LongMemEval with weighted fusion, 0.7/0.3, rerank:none as PRIMARY column; zscore+rerank as upgrade column)
F2: E2E delta reporting (3-condition LongMemEval: zero/irrelevant/correct) + two-stage citation verification
F6: Bootstrap 95% CIs on all metrics; pre-register nDCG@5 as primary metric; Benjamini-Hochberg FDR control for exploratory metrics
F12: hardMinScore test audit with effective-floor quantification + two-phase canary test
F5: Fix `recordRecalls` wiring in MCP + backfill + dreaming impact audit

**Gate G0:** nDCG@5 baseline established on production config with CIs. Config-drift gap quantified (zscore vs weighted delta). E2E retrieval contribution isolated (delta from zero-context). `recordRecalls` bug fixed and verified. All test assertions validated against quantified effective floors.

**Acceptance criteria (numeric thresholds set at Wave 0 completion):** Each gate below defines the measurements required. Specific numeric pass/fail thresholds (e.g., nDCG@5 floor, maximum acceptable degradation, minimum abstention F1) will be set at Wave 0 completion once baselines are measured on the production config. The baseline values themselves become the regression floor; any improvement target is aspirational, not gating.

### Wave 1: Correctness + Calibration (~5 days)

C5 (semantic dedup) -- order-independent from other Wave 1 changes, can parallelize. Note: AutoCut (C6) is NOT in Wave 1 because it depends on the post-reranker score distribution, which requires the reranker enabled (C1) and hardMinScore wired (C3) before the gap threshold is meaningful. AutoCut belongs in Wave 3.
F3: Calibration + abstention probe with true IR negatives + scoped calibration + embedding model comparison (MUST precede C3)
F10: Reranker labeling fix (report rerank:none as primary in all benchmarks)
F16: Wire nDCG@5 into domain-eval
C3: Wire hardMinScore (AFTER F3 establishes empirical optimal value) + kill-switch env var + 48h monitoring
C1: Enable reranker in MCP path + deploy Qwen3-Reranker-0.6B + graceful-degradation verification
C2: Flip fusion to zscore in MCP config + 48h monitoring (if different from eval-config measurement)

**Gate G1:** Optimal hardMinScore measured empirically (dev set). Scoped vs. unscoped threshold divergence quantified. Embedding model sensitivity measured. hardMinScore wired with kill-switch. Reranker enabled in MCP path with fallback verified. Production abstention rate monitored for 48h per operational spec. No regression in live-production nDCG@5 (F2).

### Wave 2: Temporal + Noise (~3 days)

C4: Cap recency + QDF gate + remove timeDecay
F9: Temporal degradation benchmark (staggered-index, before/after recency changes)
F8: Noise-robustness stress test (4 pollution types, degradation curves)
F11: Config alignment verification (if needed after Wave 1 measurement)

**Gate G2:** Recency cap and QDF gate verified. Noise-robustness quantified (degradation curves by pollution type). Temporal recall curve measured. No regression in live-production nDCG@5.

### Wave 3: Abstention + Guardrails (~3 days)

C6: AutoCut implementation
C7: Abstention with guardrails (confidence field + sentinel result + agent instruction)
C7: Best-effort fallback on reranker failure (confidence:"low" + fusion results)
C8: Provenance wiring

**Gate G3:** Abstention behavior verified: correct empty on below-threshold, low-confidence fallback on reranker failure, sentinel result injected. Agent instruction tested (LLM does not hallucinate on empty results). Provenance field populated correctly.

### Wave 4: Infrastructure + Hardening (~5 days)

F7: BEIR relabeling + genuine mixed-source benchmark (UnifiedRetriever)
F13: MCP integration smoke tests
F14: Persistent benchmark DB + synth-data validation + query protection
F15: Distribution-shift analysis (KS test + BM25 degradation ratio)
F17: Path coverage logging + zero-coverage path tests (adaptive-retrieval.ts, recall-cache.ts, debug-recall.ts, BM25-only fallback)
F18: Embedding model comparison (calibration probe with 2+ models)

**Gate G4:** All zero-coverage code paths have at least one quality test. BM25-only path has its own calibration. Synth data validated against production distribution. Query protection in place for all benchmarks. BEIR correctly labeled. Mixed-source benchmark operational.

### Operational Monitoring Spec (for any production-config change)

- **Abstention rate:** Production abstention rate via telemetry.
  - **Acceptable range:** Abstention rate change < 10pp absolute from baseline.
  - **Alert threshold:** If abstention rate exceeds baseline + 15pp for any 2-hour window, trigger rollback.
- **Reranker health:** Error rate and p50/p95/p99 latency tracked per-recall.
  - **Acceptable range:** Error rate < 5% of recall calls. p95 latency < 500ms.
  - **Alert threshold:** If error rate exceeds 10% or p95 latency exceeds 1000ms for any 30-min window, escalate.
- **Z-score fusion quality:** Pre/post change score distribution comparison (mean, std, decile buckets) on a fixed query sample.
  - **Acceptable range:** Mean fused score shift < 0.05; no decile bucket shift > 0.10 from baseline.
  - **Alert threshold:** Mean shift > 0.10 OR any decile shift > 0.15, trigger investigation before proceeding.
- **Rollback:** Set `MEMEX_HARD_MIN_SCORE_OVERRIDE=0.15` (or revert config), restart, verify metrics return to baseline.
  - **Note:** The `MEMEX_HARD_MIN_SCORE_OVERRIDE` env var must be implemented alongside Change 3 wiring (it does not exist yet; this doc specifies its creation).
- **On-call:** Designate an engineer for the 48h monitoring window.
- **Rollback plan:** Documented per-change. Tested before shipping.

---

## 7. Feedback-Loop Boost Integration Point

The feedback-loop boost (§5) integrates at a specific point in the pipeline:

```
... → reranker → QDF-gated recency → importance → FEEDBACK-LOOP BOOST → AutoCut → abstention → MMR → slice
```

The boost is applied AFTER all relevance signals (reranker, recency, importance) because it is a tiebreaker, not a primary signal. It is applied BEFORE AutoCut and abstention so that frequently-recalled memories get a small edge in surviving the floor -- but not enough to override a genuine relevance gap (see boundedness proof, §5.4).

**Prerequisite (Wave 0):** Fix `recordRecalls` in MCP path (F5). Without this, the boost is a no-op.

**Deployment note:** The boost is a no-op for 99.26% of the pool until signal accumulates. It changes nothing on day 1. Measure `recall_count` distribution over weeks as the leading indicator, not benchmark scores.

---

## Appendix A: Config Comparison Table

| Config Parameter | MCP Production | domain-eval.ts | LongMemEval | BEIR Benchmark | DEFAULT |
|---|---|---|---|---|---|
| **Code Path** | MemoryRetriever | MemoryRetriever | MemoryRetriever | hybridQuery() (search.ts) | (never used) |
| **fusionMethod** | weighted | zscore | zscore | RRF | weighted |
| **vectorWeight** | 0.7 | 0.8 | 0.8 | N/A (RRF) | 0.7 |
| **bm25Weight** | 0.3 | 0.2 | 0.2 | N/A (RRF) | 0.3 |
| **rerank** | **dynamic** (env-var gated: "cross-encoder", "llm", or "none") | env-var gated (RERANK env) | env-var gated (RERANK env) | **always on** (search.ts) | cross-encoder |
| **minScore** | 0.3 | 0.05 | 0.05 | N/A | 0.3 |
| **hardMinScore** | 0.15 (WIRED, was 0.40 dead) | (not configured) | 0.10 | N/A | 0.15 (WIRED, was 0.40 dead) |
| **candidatePoolSize** | 20 | 30 | K*6 (~60) | N/A | 20 |
| **recencyHalfLifeDays** | 14 | (default 14) | 0 | N/A | 14 |
| **recencyWeight** | 0.10 | (default 0.10) | 0 | N/A | 0.10 |
| **timeDecayHalfLifeDays** | 60 | (default 60) | 0 | N/A | 60 |

Key takeaways:
1. **No eval matches the production config.**
2. **hardMinScore is now wired** (v0.7.3) -- config value 0.15 is read by `applyAdaptiveMinScore`, with MEMEX_HARD_MIN_SCORE_OVERRIDE kill-switch.
3. **The DEFAULT config is never used by evals** -- both MCP and evals override it. DEFAULT applies to the MCP path unless overridden by env vars.
4. **Embedding model is unspecified** -- all calibration thresholds are model-specific.

**Config field classification -- eval-only vs production:**

Some config fields are eval-tuning knobs only and must NOT be wired into the production config (they exist to explore the parameter space during benchmarking, not to control runtime behavior):

| Field | Classification | Used By | Notes |
|---|---|---|---|
| `rerankBlendWeight` | Eval-only | domain-eval.ts (line 167), longmemeval-benchmark.ts | Tuning knob for reranker/fusion blending experiments. Not read by MCP path or UnifiedRetriever. |
| `rerankScoreMode` | Eval-only | domain-eval.ts, longmemeval-benchmark.ts | Controls reranker output mapping (`"direct"`, `"sigmoid"`, `"blend"`). Only used in eval scripts. |
| `fusionMethod` | Production | MCP path (inherited from DEFAULT), eval scripts | Controls weighted vs zscore fusion. Must be changed in DEFAULT (Change 2). |
| `rerank` | Production | MCP path (overridden), eval scripts (env-var gated), DEFAULT | Controls reranker activation. Must be changed in MCP path (Change 1). |
| `hardMinScore` | Production | DEFAULT, eval scripts | Dead config until Change 3 wires it. Once wired, controls the absolute floor in `applyAdaptiveMinScore`. |
| `rerankModel` | Production | DEFAULT, eval scripts (env-var override) | Model selection. DEFAULT is `jina-reranker-v3`; override via `MEMEX_RERANK_MODEL` env var. |

Implementers must not wire eval-only fields (`rerankBlendWeight`, `rerankScoreMode`) into the production config or MCP path. These knobs exist solely for benchmark parameter sweeps.

## Appendix B: Spec-Review Criticals -- Resolution Summary

| # | Critical | Resolution in This Doc |
|---|---|---|
| C1 | RRF is not a one-line config flip (type + branch + mapping) | Adopted. Z-score fusion is the immediate target (§1.4 Change 2). RRF on memory path deferred to post-zscore measurement. |
| C2 | hardMinScore is dead config (hardcoded floor, 8+ test files vacuously true) | IMPLEMENTED (v0.7.3). hardMinScore wired to config at 0.15. MEMEX_HARD_MIN_SCORE_OVERRIDE kill-switch in createRetriever. Test audit (§3.1) still applies. |
| C3 | Fallback architecture contradicts primary path (RRF scores not on relevance scale) | Adopted. Z-score fallback used, not RRF. Relaxed floor on reranker failure. Best-effort fallback with confidence:"low" (§1.4 Change 7). |
| C4 | Only 1 of 3 recall pipelines covered | Adopted. Three pipelines identified (§1.5). MCP path prioritized. UnifiedRetriever deferred to Wave 4 mixed-source benchmark. Document path out of scope. |
| C5 | MCP memory_recall disables reranker (NO-OP for reranker-dependent design) | IMPLEMENTED (v0.7.3). MCP path reads MEMEX_RERANK_* env vars and dynamically enables "cross-encoder" or "llm" reranker. |
| C6 | Abstention has zero agent guardrails | Adopted. Three-part guardrail: confidence field + sentinel result + agent instruction (§1.4 Change 7). |
| C7 | Reranker is single point of failure | Adopted. Graceful-degradation path preserved (`retriever.ts:728-736`). Best-effort fallback with relaxed floor + confidence:"low" (§1.4 Change 7). |

**Non-critical corrections applied:**
- Reranker model: BGE-reranker-v2-m3 → Qwen3-Reranker-0.6B (already deployed in v0.7; BGE has 8K context bug).
- timeDecay: floor 0.90 proposal replaced with removal of the multiplicative path entirely (§1.4 Change 4).
- AutoCut: specified gap threshold (0.15) rather than just naming the concept (§1.4 Change 6).
- detectTemporalRange: identified as a ready training-free QDF gate, already imported but never called (`retriever.ts:10` + `temporal.ts:40-115`).
- embedding model sensitivity: calibration probe now includes 2+ embedding models (F3/F18).
- **Gap 11 / C2 crosswalk:** Gap 11 (hardMinScore dead config) in §2.2 is resolved by C2/Change 3. The 17-gaps list in §2.2 tracks the validation-doc gap inventory; the Change 3 spec (§1.4) and test audit (§3.1) track the implementation. Both references point to the same fix; there is no inconsistency.
- **Sentinel id:** Changed from `__no_strong_match__` to `memex:abstention:no_strong_match` (namespace-prefixed, avoids collision with UUID-based entry IDs and any future `__`-prefixed internal conventions).
- **retriever.ts:3 header comment:** Still says `RRF fusion` (UNFIXED as of v0.7.3). Should be updated to `Combines vector search + BM25 full-text search with weighted or zscore fusion` as part of Change 2.

## Appendix C: Related Files

- `/home/ubuntu/projects/memex/src/retriever.ts` -- RetrievalConfig (line 20), DEFAULT_RETRIEVAL_CONFIG (line 159), MemoryRetriever.retrieve() (line 356), fuseResults (line 524), recencyBoost (line 833), importanceWeight (line 865), lengthNormalization (line 887), timeDecay (line 920), applyAdaptiveMinScore (line 945, now wired to config.hardMinScore), rerankResults (line 628), ephemeral freqBoost (line 871), graceful-degradation (line 730-747), stale RRF header comment (line 3, UNFIXED), LLM reranker branch (line 752-796), MEMEX_HARD_MIN_SCORE_OVERRIDE (line 1105-1108), MEMEX_RELEVANCE_FIRST (line 1112-1115)
- `/home/ubuntu/projects/memex/src/mcp-server.ts` -- createRetriever with dynamic rerank (line 76-83, reads MEMEX_RERANK_* env vars), memory_recall handler (line 225-297, now calls recordRecalls at line 275-278), BM25-only fallback (line 300-323, also calls recordRecalls at line 303), VERSION (line 24, stale at 0.7.2), LLM reranker wiring (line 71-74, 82)
- `/home/ubuntu/projects/memex/src/memory.ts` -- MemoryEntry (line 21, missing recall_count), recall_count column (line 222), recordRecalls (line 848-852)
- `/home/ubuntu/projects/memex/src/unified-retriever.ts` -- UnifiedRetriever (line 138), applyPostMergeModifiers (line 524-567)
- `/home/ubuntu/projects/memex/src/search.ts` -- hybridQuery (line 3326), reciprocalRankFusion (line 2798), always-on reranker (line 3490)
- `/home/ubuntu/projects/memex/src/temporal.ts` -- detectTemporalRange (line 40-115, imported but never called)
- `/home/ubuntu/projects/memex/src/dreaming.ts` -- recall_count used for importance boost (line 162-165), decay (line 168-183), health metric (line 579-580)
- `/home/ubuntu/projects/memex/src/adaptive-retrieval.ts` -- Binary serve-or-skip gate (99 lines, zero quality-eval coverage)
- `/home/ubuntu/projects/memex/src/recall-cache.ts` -- Retrieval cache (89 lines, zero quality-eval coverage)
- `/home/ubuntu/projects/memex/src/debug-recall.ts` -- MEMEX_DEBUG_RECALL path (145 lines, zero quality-eval coverage)
- `/home/ubuntu/projects/memex/index.ts` (project root, not src/) -- line 1344: ONLY caller of recordRecalls (auto-recall hook path only)
- `/home/ubuntu/projects/memex/tests/domain-eval.ts` -- 26 queries, MemoryRetriever, zscore fusion (line 160-165), binary metrics, Wilson 95% CI, RERANK env supports "1"|"cross-encoder"|"llm"|"none", QUERY_DELAY_MS pacing
- `/home/ubuntu/projects/memex/tests/longmemeval-benchmark.ts` -- 50 queries, MemoryRetriever, zscore fusion (line 356-363), temporal disabled (line 374-376), temp DB (line 273-274)
- `/home/ubuntu/projects/memex/tests/beir-benchmark.ts` -- BEIR document retrieval, hybridQuery() (line 192-194), temp DB (line 148), always reranks
- `/home/ubuntu/projects/memex/tests/helpers/ir-metrics.ts` -- nDCG@k (line 36-56), MRR, precision, recall (defined, unused in quality evals except BEIR)
- `/home/ubuntu/projects/memex/tests/intake-guards.test.ts` -- recordRecalls unit tests (line 301-345, proves method works, doesn't catch MCP path bug)

## Appendix D: Source Document Archive

This document supersedes:
- `docs/design/retrieval-redesign.md` -- recall-quality fix (5 principles, pipeline, patch sketch)
- `docs/design/recall-validation-analysis-revised.md` -- validation plan (10 criteria, 17 gaps, 18 fixes F1-F18, 4-wave sequencing, gates)
- `docs/design/feedback-loop.md` -- bounded recall-frequency boost

These three docs are retained for history but are no longer authoritative. All new recall-quality work references this canonical spec.
