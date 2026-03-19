# Benchmarks — memex

**Updated:** 2026-03-18

## Environment

| Component | Value |
|---|---|
| VM | Ubuntu, Xeon CPU, 16GB RAM, Node 25.6.1 |
| Embedding | Qwen3-Embedding-4B-Q8_0 (2560d) via llama-swap on Mac Mini M4 |
| Reranker | bge-reranker-v2-m3-Q8_0 via same endpoint |
| Network | VM → Mac Mini via Tailscale (~3-90ms RTT, WiFi jitter) |
| Database | SQLite + sqlite-vec + FTS5 |
| Memories | 1900 entries (avg 94 chars, max 650 chars) |
| Documents | 505 docs, 973 chunks |

---

## LongMemEval (ICLR 2025)

Cross-system memory retrieval benchmark. N=50, LongMemEval_s subset. Official LongMemEval prompts + GPT-4o-mini LLM-judge.

| Metric | Score | What it measures |
|---|---|---|
| **R@1** | **78%** | Correct session ranked #1 |
| **R@3** | **90%** | Correct session in top 3 |
| **E2E** | **90%** | LLM extracts correct answer from retrieved sessions |

- **R@1** is the strictest — requires the retriever to put the exact right session at position 1.
- **R@3** reflects production behavior where the LLM sees the top 3 results.
- **E2E** is what users experience — can the system actually answer the question? E2E ≥ R@1 because the LLM reads multiple sessions and may find the answer in an alternative session even when the "official" correct one isn't ranked first.

| System | R@1 | R@3 | E2E Accuracy | Reader LLM |
|---|---|---|---|---|
| Hindsight/TEMPR | — | — | 91.4% | GPT-4o |
| **memex** | **78%** | **90%** | **90%** | GPT-4o |
| Zep/Graphiti | — | — | ~85% | GPT-4o |
| mem0 (graph) | — | — | ~78% | GPT-4o |
| MemGPT/Letta | — | — | ~75% | GPT-4o |

Evaluated with official LongMemEval prompts and GPT-4o-mini LLM-judge.

Key techniques: z-score fusion (0.8v+0.2b), chunked embedding (max-sim over 2000-char overlapping chunks).

Full details: `docs/research/longmemeval-baseline-2026-03-18.md`

---

## Production Latencies

Measured against 1900 memories + 505 documents.

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

## Reproduction

```bash
# Unit tests (561+)
node --import jiti/register --test tests/*.test.ts

# LongMemEval fast benchmark (~1s)
TIER=fast node --import jiti/register tests/fast-benchmark.ts

# LongMemEval E2E benchmark (~2min)
TIER=e2e GEMINI_API_KEY=... node --import jiti/register tests/fast-benchmark.ts

# Latency benchmark
node --import jiti/register tests/benchmark.ts
```
