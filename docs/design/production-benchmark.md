# Production benchmark design (issue #19)

**Status:** Scoped, not implemented. Design committed 2026-05-11 as part of the resolve-everything loop (017). Implementation deferred to a dedicated session — see "Concrete next steps" at the bottom.

## Problem statement

Memex's current published metrics confuse two distinct things:

1. **Conversation-memory quality** — measured by LongMemEval (94% E2E in v0.7). This is a memory-only benchmark on synthetic chat-history Q&A.
2. **Production mixed-source quality** — what the live `UnifiedRetriever` actually does for users: memories + workspace documents fused, scored, reranked, returned to the agent as context for *real* tasks.

We have no externally-comparable number for #2. The README's leaderboard table mixes #1 numbers with vendors' generic "memory benchmark" numbers, but in practice memex's value to a user is the mixed-source path. A reader can't tell from current docs whether memex's mixed-source quality is competitive, and we can't tell either.

This issue (and design) is about closing that gap with a benchmark whose numbers are honestly comparable across systems.

## Why BEIR

[BEIR](https://github.com/beir-cellar/beir) is the de facto standard heterogeneous IR benchmark. 18 datasets across domains (scientific papers, fact verification, biomedical, financial, etc.), each with a corpus, queries, and qrels (graded relevance judgments). nDCG@10 / Recall@10 / MAP are the common reporting metrics, comparable across published systems and a deep body of public results.

**Why BEIR fits memex's mixed-source path:**

- Each BEIR dataset has a *corpus* of documents and a *query set*. The corpus maps cleanly onto memex's "documents" pool. The corpus + queries can be thought of as "this is what's in your memex; what's the right answer for each query?"
- BEIR's metrics (nDCG@10, Recall@10) directly measure what memex's UnifiedRetriever is supposed to do well: rank the right items into the top-10 window.
- Public leaderboards mean we can position memex against systems people already know about (BM25, BGE, Cohere, OpenAI embeddings, Voyage, ColBERT, etc.) without having to invent a new yardstick.

**Why BEIR doesn't fit cleanly:**

- BEIR assumes pure document retrieval. Memex's twist is **conversation memory + documents in the same retrieval pass**. To use BEIR honestly, we have to either:
  - **Treat BEIR as a documents-only test** (skip the conversation-memory side; report the single-source number as the production-floor)
  - **Synthetically inject conversation memories** derived from the BEIR corpus (questionable — the synthesis itself biases the result)
  - **Run BEIR alongside a real conversation-memory benchmark** like LongMemEval and report both numbers separately
- BEIR is large. Full BEIR is ~18 corpora, some with millions of documents. We don't need to run all of it. (A subset is fine and standard practice.)

## Recommended scope (subset)

Run a **3-dataset subset**:

| Dataset | Why | Size |
|---|---|---|
| **SciFact** | Tiny (5K corpus, 300 queries), fact verification — closest to memex's "did the agent's claim get supported?" use case | 5K docs |
| **NFCorpus** | Medical / scientific, 3.6K corpus, longer documents — exercises memex's chunking + max-sim pipeline | 3.6K docs |
| **FiQA-2018** | Financial Q&A, 57K corpus, harder than SciFact — exercises retrieval at slightly larger scale | 57K docs |

Total: ~65K documents to index. ~1500 queries to run. Reportable numbers: nDCG@10, Recall@10, MAP.

**Not in scope for the first run:** TREC-COVID (too topic-narrow), MS MARCO (too large), Touché-2020 (argumentation-style, not memex's use case), CQADupStack (too narrow), Touché (subjective relevance).

## Implementation sketch

```
src/benchmark/
  beir/
    download.ts        ← fetches BEIR datasets via official URLs
    runner.ts          ← indexes corpus into memex, runs queries, computes metrics
    metrics.ts         ← nDCG@10, Recall@10, MAP (already have ir-metrics in tests/)
  cli.ts               ← `npm run benchmark:beir [dataset]`
```

Key wiring decisions:

1. **Indexing path**: BEIR corpora become `documents` in memex's existing `documents` pool, not synthetic memories. This honestly tests the document-side production path. (Conversation memory is tested separately by LongMemEval.)
2. **Embedding model**: same as production (Qwen3-Embedding-4B-Q8_0). Don't switch to BEIR-tuned models — defeats the point.
3. **Reranker**: run twice — without and with Qwen3-Reranker-0.6B. Two columns in the report.
4. **Output**: structured JSON to `bench/beir-<dataset>-<timestamp>.json` + summary table.

## Expected runtime + cost

- **Indexing**: ~65K documents at ~50 docs/sec via Qwen3-Embedding-4B-Q8_0 = ~22 min. One-time per dataset (cache embeddings).
- **Querying**: 1500 queries × ~150ms p50 = ~3.75 min per pass. Two passes (no rerank, with rerank) = ~7.5 min.
- **Total wall-clock**: ~30 min for first run, ~10 min for cached re-runs.
- **API cost**: zero if running against local Qwen3 + Qwen3-Reranker. (Could also run against GPT embeddings for a comparison column, but that's $$$.)

## Headline reporting story

After this lands, memex's docs split into two clear tracks:

| Track | Benchmark | What it measures | Current/target |
|---|---|---|---|
| Conversation memory | LongMemEval | Long-horizon chat recall quality | 94% E2E (already known) |
| Production mixed-source | BEIR (3 subset) | Document IR quality on the real pipeline | TBD — first run will set baseline |

The README leaderboard table gets two clearly-labeled sections instead of a confused single one. Vendors who report on BEIR can be compared apples-to-apples on the IR track.

## Concrete next steps (checklist for the implementation session)

- [ ] Add `src/benchmark/beir/download.ts` — wraps `wget` for the 3 datasets, validates checksums
- [ ] Add `src/benchmark/beir/runner.ts` — index → query → metrics pipeline using existing `UnifiedRetriever` and `documents` store
- [ ] Add `npm run benchmark:beir` script
- [ ] First run on SciFact only (smallest); validate metrics calculation against published BM25 baseline
- [ ] Add NFCorpus + FiQA-2018 once SciFact baseline matches
- [ ] Update README's "Benchmarks" section: split into "Conversation Memory" + "Production Mixed-Source" headers
- [ ] Optional: add CI gate that runs SciFact on every release tag (~30 min CI time, gates regressions)

## Open questions for the implementation session

1. **Where do BEIR docs live**? Each dataset is 50MB-500MB; not in the repo. Probably download to `~/.openclaw/benchmark/beir/` on first run.
2. **Reranker comparison**: only compare default (no rerank) vs Qwen3-Reranker, or also include older rerankers for backward-compat tracking?
3. **Caching strategy**: persist embeddings to `bench/cache/` keyed by `(dataset_version, model)` so re-runs skip the indexing step?
4. **CI cost**: 30 min CI per tag may be too much. Maybe only run SciFact in CI, full subset locally / weekly?

## Out of scope for issue #19

- **Live agent E2E benchmark** (does the agent's answer use the recalled context correctly?). That's a separate research lane closer to MemoryAgentBench (`arXiv:2507.05257`) — see roadmap T4.2.
- **Multi-modal documents** (PDFs, images). BEIR is text-only; that's fine.
- **Real-time streaming benchmark**. BEIR is batch-oriented.

---

**Related**: Roadmap T4.2 (MemoryAgentBench) is the natural follow-up — measures *agentic* mixed-source workflows, where this BEIR work measures *retrieval* mixed-source quality.
