# memex Retrieval Redesign — Noise-Robust Hybrid Recall

**Superseded by:** [recall-quality-design.md](../recall-quality-design.md) — canonical spec.
**Status:** design proposal (not implemented) · **Date:** 2026-06-29
**Goal:** make recall **store-invariant** — return the one relevant memory (or none) regardless of how polluted the store is.

## TL;DR
memex's retrieval machinery already supports almost everything the literature recommends
(RRF, a cross-encoder stage, MMR, internal `sources` tracking). It is **mis-configured and
mis-wired, not missing**. Five changes — most of them config flips or small rewrites in
`src/retriever.ts` — take it from "returns ~20 mostly-garbage results" to "returns the one
relevant hit, or nothing."

## The core principle
**Relevance is the only primary signal. Recency/importance are capped, gated tie-breakers —
never overrides of a relevance gap. A real confidence floor returns 1, or 0 (abstention).**
Retrieval quality must be invariant to store composition; "the store is dirty" can never be
why retrieval fails.

---

## Pipelines

### Current (broken) — `src/retriever.ts`
```
query ─▶ vector(0.7) ─┐
        BM25(0.3) ────┴─▶ weighted fusion (incomparable scales: cosine[0,1] vs unbounded BM25)
                          ─▶ minScore ≥ 0.3
                          ─▶ [cross-encoder reranker: OFF — no API key → skipped silently]   ◀── dead
                          ─▶ + recencyBoost   (additive, +≤0.10, UNIVERSAL, halfLife 14d)
                          ─▶ × importance     (0.7–1.0)
                          ─▶ × timeDecay      (×0.50–1.0, UNIVERSAL, halfLife 60d)            ◀── double temporal penalty
                          ─▶ adaptiveFloor = max(best×0.3, 0.15)                              ◀── near-zero bar
                          ─▶ noiseFilter / MMR
                          ─▶ slice(limit=20)                                               ◀── always ~20, mostly garbage
```
Failure mode for a sparse/old topic: an old *relevant* fact is crushed by `×timeDecay ≈ 0.60`
and gets ~0 recency, sinking to ~0.30; a brand-new *irrelevant* memory gets +0.09 recency and
~×1.0 decay, floating to ~0.72. The 0.15 floor lets ~everything through, so 20 come back.

### Proposed (noise-robust)
```
query ─▶ vector + BM25
        ─▶ RRF fusion (rank-based; immune to scale; degrades gracefully when a retriever returns garbage)
        ─▶ semantic dedup (cosine > 0.9 → keep best)          ◀── drop near-dup fragments BEFORE rerank
        ─▶ cross-encoder RERANK (LIVE, local BGE-reranker-v2-m3)   ◀── the noise filter; emits calibrated relevance scores
        ─▶ QDF gate (apply recency only if query is time-sensitive; else weight ≈ 0)
        ─▶ + capped recency (max +0.05, AND only if base ≥ 0.40)   ◀── tie-break, cannot override a relevance gap
        ─▶ confidence floor 0.40 + AutoCut (score-gap knee) + ABSTENTION   ◀── return 1, or 0; never pad
        ─▶ MMR diversity
        ─▶ slice(top-K)  with  source: vector | lexical | both | reranked
```

---

## The 5 principles (research consensus, cited)
1. **Relevance is primary; temporal/importance are capped tie-breakers.** ES `max_boost` 1.5–2.0; Vespa additive `min(boost, 0.10–0.15)`; Temporal-RAG semantic-penalty floor. Re3 ablation: removing the per-query temporal gate drops R@1 **0.742 → 0.268**.
2. **Fuse with RRF, not raw weighted blend.** Cosine ∈ [0,1] and unbounded BM25 are incomparable; an alpha-blend is scale-dominated. RRF is rank-based, tuning-free, ~5% param sensitivity, graceful under garbage.
3. **Query-deserves-freshness (QDF).** Apply recency only for time-sensitive queries; universal recency penalizes evergreen content (OpenClaw exempts `MEMORY.md` entirely).
4. **Retrieve → fuse → rerank with a *live* cross-encoder; boosts after, capped.** Reranker = the noise filter (Anthropic: −67% retrieval failure). RRF → rerank top-K → capped boosts → floor.
5. **Return only confident matches — 1, or 0 (abstention).** Oversample → threshold → empty if nothing clears the bar (AutoCut knee / z-score floor / conformal).

---

## Failure → fix map

| Failure | Root in memex | Fix | Code |
|---|---|---|---|
| Garbage tops unrelated queries | additive recency `+0.10` + multiplicative `timeDecay ×0.60`, both universal | cap recency to +0.05; relevance-gate; floor/remove timeDecay; QDF | `retriever.ts:774`, `:850` |
| BM25 common-token over-firing | `fusionMethod: "weighted"` (raw blend, incomparable scales) | flip to `"rrf"` (already supported) | `retriever.ts:152` |
| Reranker can't suppress noise | `rerankApiKey` unset → cross-encoder skipped every query | serve local BGE reranker via llama-swap; set key | `.mcp.json`, `retriever.ts:623` |
| Always returns ~20, never 1/0 | floor = `max(best×0.3, 0.15)`; pads to `limit` | real floor on **reranker** scores + AutoCut + abstention | `retriever.ts:879` |
| Results don't say vector vs lexical | `sources` tracked internally, stripped from `memory_recall` output | record origin in `sources`; expose `source` field | `retriever.ts:136`, `mcp-server.ts` |
| Near-dup fragments crowd the pool | dedup is exact-text only (`lightSweep`); post-MMR only | semantic dedup (cosine>0.9) **before** rerank | `retriever.ts` (new step) |

---

## Patch sketch (design only — not applied)

**Config (`DEFAULT_RETRIEVAL_CONFIG`, `retriever.ts:147`):**
```ts
fusionMethod:        "weighted" → "rrf"     // rank-based; fixes scale domination + common-token over-fire
recencyWeight:       0.10      → 0.05       // halve max additive delta → tie-break magnitude, not override
timeDecayHalfLifeDays: 60      → floor multiplier at ≥0.90  (or remove applyTimeDecay entirely)
// hardMinScore now applied to RERANKER scores, not fused scores
```

**Temporal — capped + gated (`applyRecencyBoost` / `applyTimeDecay`):**
```ts
// recency: cap (recencyWeight=0.05 ⇒ max +0.05) + relevance gate
if (baseScore < 0.40) return results;                         // don't boost irrelevant docs
// timeDecay: floor so old-but-relevant isn't crushed
factor = Math.max(0.90, 0.5 + 0.5 * Math.exp(-age / 60));     // old gold loses ≤10%, not 50%
// (ideal, no training data) QDF: recencyWeight ≈ 0 unless query has fresh/current/latest/now
```

**Confidence + abstention (`applyAdaptiveMinScore` → rewrite):**
```ts
// Operate on RERANKER scores (a real relevance scale), not RRF/fused scores.
let kept = results.filter(r => r.score >= 0.40);   // genuine bar, not 0.15
kept = autoCut(kept);                              // truncate at first large score gap (knee)
if (kept.length === 0 || kept[0].score < 0.40) return [];   // ABSTENTION: return empty, not padded
return kept;                                       // may be 1. may be 0.
```
Dependency: a calibrated floor needs the **reranker live** (RRF scores aren't on a relevance
scale — RRF's known cost). Without it, fall back to a z-score-calibrated cosine floor
(maintain per-collection μ/σ).

**Reranker — revive locally:** serve **BGE-reranker-v2-m3** (0.6B, Apache-2.0) on the existing
llama-swap infra (the same endpoints already serving the embedder and the LLM); point
`rerankEndpoint`/`rerankApiKey` at it. No external API dependency. (Don't hardcode hostnames
in docs/config — reference them via env or the secret store; the pre-commit hook enforces this.)

**Provenance — expose (`mcp-server.ts` + `retriever.ts:136`):**
```ts
// fuseResults records origin per result:
sources: { vector: bool, bm25: bool, both: vec && bm25, fused?: {score}, reranked?: {score} }
// memory_recall output gains, per result:
{ id, text, score, source: "vector"|"lexical"|"both"|"reranked", category, scope }
```
"both" is a free high-precision concordance signal.

---

## Priority (leverage × effort)
1. **Confidence floor + abstention** (return 1 or 0) — small rewrite; the core "there should be just one." *Needs the reranker for calibrated scores → bundle with #4.*
2. **Cap temporal** (recencyWeight 0.05 + relevance-gate + floor timeDecay) — tiny; fixes the inversion directly.
3. **Flip fusion to RRF** — one config line; fixes BM25 scale domination.
4. **Revive a local reranker** (BGE via llama-swap) — bigger (serve a model); highest-precision lever; enables #1.
5. **Expose provenance** — small output change; immediate debug value.

The triangle **RRF (robust candidate pool) + live reranker (robust ranking) + abstention
(refuse to pad)** is self-reinforcing: fix all three and a transcript-polluted store stops
affecting recall quality.

---

## Citations
- Reciprocal Rank Fusion — Cormack, Clarke, Buettcher, SIGIR 2009 — https://dl.acm.org/doi/10.1145/1571941.1572114
- Elasticsearch hybrid + RRF — https://www.elastic.co/blog/improving-information-retrieval-elastic-stack-hybrid , https://www.elastic.co/guide/en/elasticsearch/reference/current/rrf.html
- Elasticsearch function-score (max_boost, decay) — https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-function-score-query.html
- Weaviate hybrid fusion + AutoCut — https://weaviate.io/blog/hybrid-search-fusion-algorithms , https://docs.weaviate.io/weaviate/search/hybrid
- Vespa rank features (freshness) — https://docs.vespa.ai/en/reference/rank-features.html
- Qdrant hybrid queries — https://www.qdrant.tech/documentation/concepts/hybrid-queries/
- Re3: Relevance & Recency Retrieval (learned per-query gate) — https://arxiv.org/html/2509.01306v1
- Temporal RAG (content-type half-lives, semantic penalty) — https://towardsdatascience.com/rag-is-blind-to-time-i-built-a-temporal-layer-to-fix-it-in-production/
- Bruch et al., fusion functions (Convex Combination) — https://arxiv.org/abs/2210.11934
- Conformal risk control for retrieval — https://arxiv.org/abs/2404.17769
- Pinecone rerankers — https://www.pinecone.io/learn/series/rag/rerankers/
- Anthropic contextual retrieval — https://www.anthropic.com/news/contextual-retrieval
- AnswerDotAI rerankers (open-source defaults) — https://github.com/AnswerDotAI/rerankers
- BGE-reranker-v2-m3 — https://huggingface.co/BAAI/bge-reranker-v2-m3
- Lost in the Middle — https://arxiv.org/abs/2307.03172
