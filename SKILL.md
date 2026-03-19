---
name: memex
description: "Unified memory plugin for OpenClaw — conversation memory + document search in a single SQLite database. 90% E2E accuracy on LongMemEval (ICLR 2025) with GPT-4o, within 1.4pp of the best system. Hybrid retrieval with z-score fusion and max-sim chunked embedding. 3 tools: recall, store, forget. Auto-recall injects relevant memories every turn. Works with any OpenAI-compatible embedding API."
metadata:
  openclaw:
    kind: memory
---

# Memex — Unified Memory for OpenClaw

## LongMemEval (ICLR 2025)

| System | E2E Accuracy | Reader LLM |
|---|---|---|
| Hindsight/TEMPR | 91.4% | GPT-4o |
| **Memex** | **90%** | GPT-4o |
| Zep/Graphiti | ~85% | GPT-4o |
| mem0 | ~78% | GPT-4o |
| MemGPT | ~75% | GPT-4o |

## Features

- 3 tools: `memory_recall`, `memory_store`, `memory_forget`
- Hybrid retrieval: z-score fusion (vector + BM25), max-sim chunked embedding
- Document search: FTS5 + sqlite-vec, dual-granularity
- Auto-recall: injects relevant memories every turn (~150ms)
- Single SQLite database for everything
- Works with llama.cpp, llama-swap, Gemini, OpenAI, or any OpenAI-compatible API

## Install

```bash
git clone https://github.com/ofan/memex.git ~/.openclaw/plugins/memex
cd ~/.openclaw/plugins/memex && npm install
```

Config:

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
