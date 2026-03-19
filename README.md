# Memex

Unified memory plugin for [OpenClaw](https://github.com/nicobailon/openclaw) — conversation memory + document search in a single SQLite database.

## LongMemEval Benchmark (ICLR 2025)

Tested on LongMemEval_s, N=50. Official LongMemEval prompts and GPT-4o-mini LLM-judge evaluation.

| System | R@1 | R@3 | E2E Accuracy | Reader LLM |
|---|---|---|---|---|
| Hindsight/TEMPR | — | — | 91.4% | GPT-4o |
| **Memex** | **78%** | **90%** | **90%** | GPT-4o |
| Zep/Graphiti | — | — | ~85% | GPT-4o |
| mem0 (graph) | — | — | ~78% | GPT-4o |
| MemGPT/Letta | — | — | ~75% | GPT-4o |

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
