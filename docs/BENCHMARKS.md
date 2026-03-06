# Benchmarks — LanceDB Pro vs QMD

**Date:** 2026-03-02
**Environment:**
- **VM:** Ubuntu, Xeon CPU, 16GB RAM, Node 25.6.1
- **Mac Mini:** macOS, Apple M4, 16GB unified memory, 11.8GB VRAM, Node 25.7.0

---

## LanceDB Pro (VM) — Live Benchmarks

Corpus: 3 memories (fresh install). Embedding: Gemini `gemini-embedding-001` (3072 dims).

### Embedding (Gemini API)
| Operation | Latency | Notes |
|---|---|---|
| Single embedding | 340–365 ms | Network-bound (API call) |
| Batch embedding (5 texts) | 364 ms | Near-constant — batched in one API call |
| Per-text in batch | ~73 ms | Amortized |

### Search (LanceDB local)
| Operation | Latency | Results | Notes |
|---|---|---|---|
| Vector search | 27 ms | 3 | Pure cosine similarity |
| BM25/FTS search | 8 ms | 2 | Full-text index |
| Hybrid (parallel vector+BM25) | 9 ms | 3+2 | Promise.all, faster than sequential |

### End-to-End Recall
| Operation | Latency | Breakdown |
|---|---|---|
| embed + hybrid search | ~348 ms | 339ms embed + 9ms search |
| Full recall (Node startup + embed + search) | ~611 ms | Consistent across 3 runs (610–612ms) |

### Write Operations
| Operation | Latency | Notes |
|---|---|---|
| Single write (pre-embedded) | 28 ms | LanceDB add only, no embedding |
| Batch write (10 entries) | 12 ms | 1.2ms per entry amortized |
| Delete | 12 ms | SQL-like filter |

### Key Insight
**Embedding is the bottleneck.** LanceDB operations (search, write) are <30ms. The Gemini API call dominates at ~340ms. With local embeddings, recall could drop from ~350ms to <50ms.

---

## QMD (Mac Mini M4) — Phase 1 Benchmarks (2026-03-02)

Corpus: 879 chunks across 355 markdown files, 5 collections. Embedding: `nomic-embed-text` (768 dims) via llama.cpp with Metal GPU.

### Search
| Operation | Latency | Notes |
|---|---|---|
| BM25 search | 200 ms | Same as VM |
| Query mode (BM25 + vector + rerank) | 800 ms | All local (Metal GPU) |
| Same query mode on VM | >10,000 ms | Timeout — Xeon too slow for local inference |

### Embedding
| Environment | Speed | Notes |
|---|---|---|
| Mac Mini M4 (Metal) | 960 vectors/min | 16 vectors/sec |
| VM (Xeon CPU) | 4 vectors/min | 240x slower |
| Full corpus (879 chunks) | 55 seconds | Mac Mini |
| Full corpus (879 chunks) | ~4 hours (est.) | VM |

### Key Insight
**Mac Mini M4 is 240x faster for local inference.** Metal GPU makes local embedding/reranking viable. VM is limited to API-based embedding.

---

## QMD Status (current)

⚠️ **QMD is not running on Mac Mini** as of 2026-03-02 22:00 EST. The process was not persisted (launchd TODO from Phase 1). Port 8182 is occupied by a Python process. QMD binary is not in PATH — may have been removed during cleanup.

Phase 1 benchmarks above are from earlier the same day during initial setup.

---

## Comparison Summary

| Metric | LanceDB Pro (VM, Gemini API) | QMD (Mac Mini, local) |
|---|---|---|
| **Embedding model** | gemini-embedding-001 (3072d) | nomic-embed-text (768d) |
| **Single embed latency** | ~350ms (API) | ~63ms (local Metal) |
| **Vector search** | 27ms | ~200ms (includes BM25) |
| **BM25 search** | 8ms | ~200ms |
| **Hybrid search** | 9ms (search only) | ~800ms (search + rerank) |
| **E2E recall** | ~350ms (embed + search) | ~800ms (embed + search + rerank) |
| **Reranking** | disabled (cosine fallback) | local cross-encoder |
| **Bulk embedding** | 73ms/text (API batch) | 63ms/text (Metal GPU) |
| **Write** | 28ms | N/A (index-based) |
| **Storage** | Arrow files (local) | SQLite + llama.cpp |
| **Cost** | Gemini API (free tier) | $0 (local) |

### Projected: LanceDB Pro with Local Embedding (Mac Mini)
| Metric | Projected |
|---|---|
| Single embed latency | ~63ms (local) + network |
| E2E recall | ~100–150ms (embed over Tailscale + local LanceDB search) |
| Reranking | ~50–100ms (local cross-encoder on M4) |
| Full pipeline | ~200–300ms |

This is the target for Phase 4 (local inference service on Mac Mini).

---

## Recommendations for memory-unified

1. **Keep Gemini API as default** — 350ms recall is acceptable, simpler setup
2. **Local inference as optional upgrade** — Mac Mini service for sub-100ms search
3. **Document indexing** — reuse LanceDB's built-in FTS (8ms BM25) rather than QMD's approach
4. **Batch embedding for indexing** — Gemini batch (73ms/text) is fast enough for incremental doc syncs
5. **Reranking** — worth enabling (Jina free tier or local on Mac Mini) for merged results quality
