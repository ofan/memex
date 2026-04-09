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

**90% end-to-end accuracy** — #2 overall, within 1.4pp of the best system.

Tested on LongMemEval_s (N=50) using official prompts and GPT-4o-mini LLM-judge.

| System | E2E Accuracy | Reader LLM |
|---|---|---|
| Hindsight/TEMPR | 91.4% | GPT-4o |
| **Memex** | **90.0%** | GPT-4o |
| Zep/Graphiti | ~85% | GPT-4o |
| mem0 (graph) | ~78% | GPT-4o |
| MemGPT/Letta | ~75% | GPT-4o |

**What the metrics mean:**
- **R@1 (78%)** — correct session ranked #1. Strictest measure of retrieval precision.
- **R@3 (90%)** — correct session in top 3. Reflects production behavior (LLM sees top 3).
- **R@5 (96%)** — correct session in top 5. Matches auto-recall window. Only 2 queries miss.
- **E2E (90%)** — can the system actually answer the question? This is what users experience. E2E can exceed R@1 because the LLM reads multiple retrieved sessions and may find the answer even when the "official" correct session isn't ranked first.

LongMemEval is the right benchmark for "does memex remember conversation history well over time?" It is **not** the canonical benchmark for mixed memory + document retrieval quality. That benchmark track is being separated out so the project does not overclaim an overall quality number from a memory-only benchmark.

## Technical Overview

Memex unifies memory and document search for agents, but it does not flatten them into the same thing.

- **Conversation memory** stores durable facts learned from interaction: preferences, decisions, conventions, corrections
- **Document search** retrieves facts from workspace source material: docs, notes, configs, code-adjacent markdown
- **Unified retrieval** lets the agent query both in one pass, with source-aware ranking and attribution

This is why memex is a `memory` plugin instead of a plain search plugin: the goal is not just retrieval quality, but long-term agent recall across both remembered interaction state and external source material.

## Features

- **3 tools**: `memory_recall`, `memory_store`, `memory_forget`
- **Hybrid retrieval**: z-score fusion (vector + BM25), max-sim chunked embedding
- **Document search**: FTS5 + sqlite-vec, dual-granularity (whole-doc + section/bullet)
- **Auto-recall**: injects relevant memories into prompt every turn (~150ms)
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
# Run tests (488)
node --import jiti/register --test tests/*.test.ts

# Run benchmarks
node --import jiti/register tests/benchmark.ts

# Deploy
rm -rf ~/.openclaw/plugins/memex
cp -r . ~/.openclaw/plugins/memex
rm -rf ~/.openclaw/plugins/memex/.git
openclaw gateway restart
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
│   ├── Time decay + importance weighting
│   └── Source diversity guarantee
└── Embedding
    ├── OpenAI-compatible HTTP client
    ├── LRU cache (256 entries, 30min TTL)
    └── Auto-chunking for long documents
```

## License

MIT
