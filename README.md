# Memex

Unified memory plugin for [OpenClaw](https://github.com/nicobailon/openclaw) — conversation memory + document search in a single SQLite database.

## Why Memex

Agents do not learn only from conversations.

They pick up durable facts from user interaction, but they also depend on workspace documents, notes, READMEs, configs, and research files to answer correctly over time. Most systems split these into separate products or separate retrieval paths: "memory" for remembered conversation facts, and "search" for documents.

Memex treats both as long-term agent knowledge.

It gives the agent one recall surface for both remembered interaction facts and retrieved workspace knowledge, while still preserving the distinction internally:
- conversation memory is scoped, editable, and can be corrected or forgotten
- documents stay tied to their source files and are reindexed from source of truth

That separation matters operationally, but from the agent's point of view both are part of the context it should be able to recall when needed.

## Benchmarks

### LongMemEval Benchmark (ICLR 2025)

This benchmark measures **conversation-memory quality**, not the full mixed-source memex path.

**94% end-to-end accuracy with Qwen3-Reranker** (90% without reranker) — competitive with the best published systems.

Tested on LongMemEval_s (N=50) using official prompts and GPT-4o reader with GPT-4o-mini LLM-judge. Numbers below are from `tests/fast-benchmark.ts` TIER=e2e with fresh response generation.

| System | E2E Accuracy | Reader LLM | Notes |
|---|---|---|---|
| **Memex (Qwen3-Reranker)** | **94.0%** | GPT-4o | added 2026-04-10 |
| Hindsight/TEMPR | 91.4% | GPT-4o | |
| Memex (no reranker) | 90.0% | GPT-4o | prior baseline |
| Zep/Graphiti | ~85% | GPT-4o | |
| mem0 (graph) | ~78% | GPT-4o | |
| MemGPT/Letta | ~75% | GPT-4o | |

**What the metrics mean:**
- **R@1 (82% with reranker, 78% without)** — correct session ranked #1. Strictest measure of retrieval precision.
- **R@3 (90%)** — correct session in top 3. Reflects production behavior (LLM sees top 3).
- **R@5 (96%)** — correct session in top 5. Matches auto-recall window. Only 2 queries miss.
- **E2E (94% with reranker, 90% without)** — can the system actually answer the question? This is what users experience. E2E can exceed R@1 because the LLM reads multiple retrieved sessions and may find the answer even when the "official" correct session isn't ranked first.

N=50 is small enough that a ±2 query swing is within noise. The reranker improvement was reproduced twice on independent runs and is supported by a mechanistic argument (32K context Qwen3-Reranker vs. 8K-truncating bge-reranker-v2-m3 on long chunked sessions — see `docs/research/embed-rerank-upgrade-brief.md`).

LongMemEval is the right benchmark for "does memex remember conversation history well over time?" It is **not** the canonical benchmark for mixed memory + document retrieval quality. That benchmark track is being separated out so the project does not overclaim an overall quality number from a memory-only benchmark.

#### Caveats on the leaderboard table above

The 2026 research consensus (see [`docs/research/003-memory-retrieval-sota.md`](./docs/research/003-memory-retrieval-sota.md)) is that LongMemEval / LoCoMo numbers should be read with significant skepticism:

- LoCoMo / LongMemEval default `top_k=50` exceeds candidate-pool size (~50 sessions per question on LongMemEval, 19–32 sessions on LoCoMo) → retrieval doesn't meaningfully filter; the benchmark mostly measures whether the LLM can read.
- LoCoMo's scoring function makes 23% of items unscorable; the largest category (42%) scores paraphrase overlap rather than structural correctness.
- Vendor numbers vary by ±20pp depending on harness. Mem0 alone has been reported at 49% / 93.4% / 29.07% on LongMemEval across three different evaluators.
- MemPalace's "100% LongMemEval" was three post-hoc patches against a non-held-out dev set.

Memex's 94% is honestly self-measured and reproducible from this repo, but a leaderboard table comparing memex to other vendors on this benchmark is no longer particularly informative. Successor benchmarks like MemoryArena (`arXiv:2602.16313`), MemoryAgentBench (`arXiv:2507.05257`), and MEMTRACK (`arXiv:2510.01353`) test causally-dependent agentic workflows and are the better basis for comparison going forward. v0.7 plans an honest run against MemoryAgentBench.

### Domain eval

A 15-query entity-rich eval against the author's production memex DB lives at `tests/domain-eval.ts`. It's the primary regression gate for day-to-day retrieval tuning because it runs in under 10s with no LLM cost. Current score: 12/15 without reranker, 11/15 with Qwen3-Reranker (one query loses to a "defensible but wrong" semantic match). See `docs/plans/LEARNINGS.md` for the history.

### Model bakeoff harness

Run a complete go/no-go evaluation for a candidate reranker model in under 5 minutes:

```sh
./scripts/bakeoff reranker <endpoint-url> <model-name> [--skip-e2e]
```

Two-stage gate: cheap stage 1 (domain-eval + fast-benchmark) runs first; expensive stage 2 (e2e with GPT-4o reader) runs only if stage 1 wasn't a hard fail. Exits 0 on PASS, 1 on HOLD/FAIL, 2 on error. Unit-tested decision logic. See `docs/design/model-bakeoff.md`.

## Technical Overview

Memex unifies memory and document search for agents, but it does not flatten them into the same thing.

- **Conversation memory** stores durable facts learned from interaction: preferences, decisions, conventions, corrections
- **Document search** retrieves facts from workspace source material: docs, notes, configs, code-adjacent markdown
- **Unified retrieval** lets the agent query both in one pass, with source-aware ranking and attribution

This is why memex is a `memory` plugin instead of a plain search plugin: the goal is not just retrieval quality, but long-term agent recall across both remembered interaction state and external source material.

## Features

- **3 tools**: `memory_recall`, `memory_store`, `memory_forget`
- **Hybrid retrieval**: z-score fusion (vector + BM25), max-sim chunked embedding
- **Cross-encoder reranking**: configurable (Jina / SiliconFlow / Voyage / Pinecone shapes). Default off; enable via config when running against an instruction-capable reranker like Qwen3-Reranker-0.6B.
- **Transient-failure retry**: embedder and reranker clients both retry on 502/503/504/timeouts with exponential backoff (`src/transient-retry.ts`), so inference-server crashes never propagate to callers as failed recalls.
- **Document search**: FTS5 + sqlite-vec, dual-granularity (whole-doc + section/bullet)
- **Auto-recall**: injects relevant memories into prompt every turn, with an in-turn dedup cache so multiple prompt rebuilds per agent turn only cost one retrieve() call
- **LLM-driven storage**: system prompt nudges the LLM to store facts, no heuristic auto-capture
- **Multi-vector**: long memories (>1500 chars) get chunked, each chunk independently embedded
- **Single SQLite database**: memories + documents + vectors in one file
- **OpenAI-compatible embedding**: works with llama.cpp, llama-swap, Gemini, OpenAI, etc.

## Performance

| Operation | Latency |
|---|---|
| Unified retriever (full pipeline) | ~150ms p50 |
| Embed (cached) | <0.03ms |
| Vector search (1.9K memories) | ~4ms |
| BM25 search | <0.3ms |

## Install

```bash
git clone https://github.com/ofan/memex.git ~/.openclaw/plugins/memex
cd ~/.openclaw/plugins/memex && npm install
```

Add to your OpenClaw config:

```json
{
  "plugins": {
    "memory": "memex",
    "entries": {
      "memex": {
        "embedding": {
          "provider": "openai-compatible",
          "apiKey": "${EMBED_API_KEY}",
          "model": "text-embedding-3-small",
          "baseURL": "https://api.openai.com/v1"
        }
      }
    }
  }
}
```

## Development

```bash
# Run tests (~680)
node --import jiti/register --test tests/*.test.ts

# Run benchmarks
node --import jiti/register tests/fast-benchmark.ts           # cached-fusion simulator, <1s
TIER=e2e node --import jiti/register tests/fast-benchmark.ts  # + GPT-4o reader, ~4 min
node --import jiti/register tests/domain-eval.ts              # 15 entity-rich queries, ~10s

# Evaluate a candidate reranker end-to-end (PASS/HOLD/FAIL verdict)
./scripts/bakeoff --help
./scripts/bakeoff reranker <endpoint-url> <model-name> --skip-e2e

# Deploy (when installed via link)
rsync -av --exclude=node_modules --exclude=.git --exclude=tests --exclude=docs \
  . ~/.openclaw/plugins/memex/
systemctl --user restart openclaw-gateway
```

## Architecture

```
memex (kind: "memory")
├── SQLite (FTS5 + sqlite-vec)
│   ├── memories — recall, store, forget
│   ├── documents — markdown chunking, dual-granularity FTS
│   └── vectors_vec — shared vector store
├── Unified Retriever
│   ├── Z-score fusion (0.8 vec + 0.2 BM25)
│   ├── Max-sim chunked embedding
│   ├── Cross-encoder reranking (optional)
│   ├── In-turn recall cache (per-agent-turn dedup)
│   ├── Rerank-failure fallback → hybrid fusion ranking unchanged (not cosine)
│   ├── Time decay + importance weighting
│   └── Source diversity guarantee
├── Embedding + Rerank Clients
│   ├── OpenAI-compatible HTTP client
│   ├── LRU cache (256 entries, 30min TTL)
│   ├── Transient-failure retry (502/503/504/AbortError, exponential backoff)
│   └── Auto-chunking for long documents
```

## License

MIT
