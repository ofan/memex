# Benchmarks — memex

**Updated:** 2026-07-11

## Environment

| Component | Value |
|---|---|
| Test host | Ubuntu, Xeon CPU, 16GB RAM, Node 25.9 |
| Embedding | Qwen3-Embedding-4B-Q8_0 (2560d) via llama-swap on a dedicated Apple Silicon host |
| Reranker | Cross-encoder: **Qwen3-Reranker-0.6B-Q8_0** via same endpoint (upgraded 2026-04-10, replaced bge-reranker-v2-m3-Q8_0). LLM reranker also available (opt-in via `MEMEX_RERANK_LLM_MODEL`, ordering-based, e.g. deepseek-v4-flash). |
| Network | Test host → inference host via Tailscale (~3-90ms RTT) |
| Database | SQLite + sqlite-vec + FTS5 |
| Memories | ~2100 entries (avg 94 chars, max 650 chars) |
| Documents | 505 docs, 973 chunks |

---

## LongMemEval (ICLR 2025) — Conversation Memory Retrieval

Cross-system conversation-memory benchmark. Measures **memory-only retrieval quality** — does not cover document search or the production mixed-source path (UnifiedRetriever). N=50, LongMemEval_s subset. Official LongMemEval prompts + GPT-4o-mini LLM-judge. Numbers below are from `tests/fast-benchmark.ts` with chunked embeddings (2000-char chunks, 200-char overlap, max-sim aggregation).

| Metric | No reranker | + Qwen3-Reranker-0.6B | What it measures |
|---|---|---|---|
| **R@1** | 78% | **82%** | Correct session ranked #1 |
| **R@3** | 90% | **90%** | Correct session in top 3 |
| **R@5** | 96% | 96% | Correct session in top 5 (auto-recall window) |
| **E2E** | 90% | **94%** | LLM extracts correct answer from retrieved sessions |

- **R@1** is the strictest — requires the retriever to put the exact right session at position 1.
- **R@3** reflects production behavior where the LLM sees the top 3 results.
- **R@5** matches the auto-recall limit (5 results injected per turn). Only 2 queries miss at R@5.
- **E2E** is what users experience — can the system actually answer the question? E2E ≥ R@1 because the LLM reads multiple sessions and may find the answer in an alternative session even when the "official" correct one isn't ranked first.

| System | R@1 | R@3 | E2E Accuracy | Reader LLM |
|---|---|---|---|---|
| **memex (Qwen3-Reranker)** | **82%** | **90%** | **94%** | GPT-4o |
| Hindsight/TEMPR | — | — | 91.4% | GPT-4o |
| memex (no reranker) | 78% | 90% | 90% | GPT-4o |
| Zep/Graphiti | — | — | ~85% | GPT-4o |
| mem0 (graph) | — | — | ~78% | GPT-4o |
| MemGPT/Letta | — | — | ~75% | GPT-4o |

Evaluated with official LongMemEval prompts and GPT-4o-mini LLM-judge.

Key techniques: z-score fusion (0.8v+0.2b), chunked embedding (max-sim over 2000-char overlapping chunks).

Full details: `docs/research/longmemeval-baseline-2026-03-18.md`

---

## Production Latencies

Measured against ~2100 memories + 505 documents.

| Operation | Latency |
|---|---|
| Embed query (uncached) | ~130ms |
| Embed passage (uncached) | ~130ms |
| Embed (cached) | <0.03ms |
| Vector search (1.9K memories) | ~4ms |
| BM25 search (1.9K memories) | <0.3ms |
| Vector search (documents) | ~3ms |
| BM25 search (documents) | <0.3ms |
| Rerank (10 candidates) | ~50ms |
| **Unified retriever (full pipeline)** | **~150ms p50** |
| **Auto-capture (per window)** | **~834ms** |
| Store to SQLite | ~15ms |
| Memory heap (after init) | ~13MB |

### Latency Breakdown: Unified Retriever (~150ms)

```
embed query      ~130ms  ████████████░░░░  (cached: <0.03ms)
vec search         ~4ms  ░░░░░░░░░░░░░░░░  (parallel with BM25)
BM25 search       <1ms  ░░░░░░░░░░░░░░░░  (parallel with vec)
z-score fusion    ~10ms  █░░░░░░░░░░░░░░░
rank + select      ~5ms  ░░░░░░░░░░░░░░░░
```

Embedding API call dominates. Local compute (SQLite, fusion) is negligible.

---

## Domain Eval (Recall Quality)

Production recall-quality benchmark against live memex DB. 26 entity-rich queries, Wilson 95% confidence intervals. Measured via `tests/domain-eval.ts`.

| Config | Accuracy | Notes |
|---|---|---|
| Baseline (no reranker) | 69% | Hybrid retrieval only |
| Cross-encoder (Qwen3-Reranker-0.6B) | 77% | Standard reranker |
| LLM reranker (deepseek-v4-flash) | **85%** | Ordering-based, opt-in via `MEMEX_RERANK_LLM_MODEL` |

The LLM reranker adds ~1-2s latency but is the strongest option for quality. Cross-encoder is the default (fast, local). See `docs/design/recall-quality-design.md` for the canonical spec.

---

## Issue #7 Production Recall Test

9 queries against known facts from conversations.

| Query | Result |
|---|---|
| TTS voice preference | ✅ (vec 0.950) |
| Ban sorry/apologize | ✅ (vec 0.717) |
| Private repos GitHub | ✅ (vec 0.737) |
| VPN deployment conflict | ✅ (vec 0.828) |
| Backup config S3 | ✅ (vec 0.793) |
| Model server migration | ✅ (vec 0.896) |
| Notifications channel | ✅ (vec 0.875) |
| Secret expiry date | ✅ (vec 0.793) |
| User phone number | ❌ (in docs, not memories) |

**Score: 8/9**

---

## Benchmark Tracks

- `LongMemEval` measures **conversation-memory retrieval** quality across multi-session recall tasks. Does not exercise document search.
- `BEIR` is the standard **document-retrieval** track for memex's document search path.
- **Production mixed-source** (memories + documents via UnifiedRetriever) is not yet benchmarked — see #19.

## Reproduction

```bash
# Unit tests (~700)
node --import jiti/register --test tests/*.test.ts

# LongMemEval fast benchmark (~1s, memory-only harness, no LLM cost)
TIER=fast node --import jiti/register tests/fast-benchmark.ts

# LongMemEval fast benchmark with Qwen3-Reranker (~2min, rerank adds latency)
TIER=fast RERANK=1 RERANK_ENDPOINT=... RERANK_MODEL=Qwen3-Reranker-0.6B-Q8_0 RERANK_API_KEY=... \
  node --import jiti/register tests/fast-benchmark.ts

# LongMemEval fast benchmark with LLM reranker
TIER=fast RERANK=llm MEMEX_RERANK_LLM_MODEL=deepseek/deepseek-v4-flash \
  node --import jiti/register tests/fast-benchmark.ts

# LongMemEval E2E benchmark with fresh GPT-4o generation (~4min, OpenAI cost)
TIER=e2e RERANK=1 LLM_API_KEY=... OPENAI_API_KEY=... \
  node --import jiti/register tests/fast-benchmark.ts

# Full bakeoff harness — PASS/HOLD/FAIL verdict for any candidate reranker
./scripts/bakeoff reranker <endpoint> <model>
./scripts/bakeoff reranker <endpoint> <model> --skip-e2e

# BEIR document benchmark (fast FTS smoke)
BEIR_MODE=fts BEIR_DATASETS=fiqa,scifact,nq node --import jiti/register tests/beir-benchmark.ts

# BEIR document benchmark (production hybrid path)
BEIR_MODE=hybrid EMBED_BASE_URL=... EMBED_MODEL=... node --import jiti/register tests/beir-benchmark.ts

# Latency benchmark
node --import jiti/register tests/benchmark.ts

# Domain eval (26 queries, Wilson 95% CI) — baseline
EVAL_DB=~/.openclaw/memory/memex/memex.sqlite \
  EMBED_BASE_URL=... EMBED_API_KEY=... EMBED_MODEL=... \
  node --import jiti/register tests/domain-eval.ts

# Domain eval — cross-encoder rerank
EVAL_DB=~/.openclaw/memory/memex/memex.sqlite \
  EMBED_BASE_URL=... EMBED_API_KEY=... EMBED_MODEL=... \
  RERANK=cross-encoder RERANK_ENDPOINT=... RERANK_MODEL=... RERANK_API_KEY=... \
  node --import jiti/register tests/domain-eval.ts

# Domain eval — LLM rerank
EVAL_DB=~/.openclaw/memory/memex/memex.sqlite \
  EMBED_BASE_URL=... EMBED_API_KEY=... EMBED_MODEL=... \
  RERANK=llm MEMEX_RERANK_LLM_MODEL=deepseek/deepseek-v4-flash \
  node --import jiti/register tests/domain-eval.ts
```
