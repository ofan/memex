# How memex Compares

## vs Its Origins

memex was built by merging and rewriting two open-source projects. Here's what changed:

|  | QMD | LanceDB Pro | **memex** |
|---|---|---|---|
| **Scope** | Documents only | Memories only | **Both, unified** |
| **Storage** | SQLite (separate MCP server) | LanceDB (Arrow, 267MB binary) | **Single SQLite file** |
| **Memory usage** | ~30MB | ~230MB RSS | **~13MB heap** |
| **Search method** | FTS5 + sqlite-vec | Vector + own BM25 | **FTS5 + sqlite-vec + cross-encoder rerank** |
| **Retrieval** | Single-pass, no reranking | 7-stage pipeline, per-source rerank | **Unified single-pass, one rerank** |
| **API calls/query** | 1-3 | 2-4 (+ model swaps) | **1.5 avg, ≤1 swap** |
| **Processes** | 2 (MCP server + plugin) | 1 | **1** |
| **Section-level FTS** | No | No | **Yes (heading + bullet splitting)** |
| **Embedding model tracking** | No | No | **Yes (detect changes, warn user)** |
| **Session import (LLM)** | No | No | **Yes (Gemini extraction)** |
| **Durability-aware decay** | No | Single half-life | **Per-type (permanent/transient/ephemeral)** |
| **Tests** | ~50 | ~80 | **506** |

## vs External Solutions

|  | **memex** | mem0 | Zep/Graphiti | MemGPT/Letta |
|---|---|---|---|---|
| **Architecture** | SQLite + local models | Cloud API | Neo4j graph DB | LLM-managed paging |
| **Latency (p50)** | ~130ms | ~200ms¹ | ~300ms¹ | ~500ms+¹ |
| **Memory** | 13MB heap | Cloud (N/A) | 500MB+ (Neo4j) | Varies |
| **Cost per query** | $0 (local inference) | ~$0.01 (API) | Self-host | LLM token cost |
| **Offline capable** | Yes | No | Partial | No |
| **Setup complexity** | 1 SQLite file, 1 config | API key | Neo4j + schema + config | Multi-component |
| **Source types** | Memories + documents | Memories only | Memories + graph | Memories only |
| **Search** | Hybrid BM25+vec+rerank | Vector + graph | BM25 + semantic + graph | LLM function calls |
| **Temporal reasoning** | Durability classes | TTL-based | Bitemporal (best)¹ | LLM-managed |
| **Entity graph** | No² | Yes (+1.5% accuracy)¹ | Yes (core feature) | No |
| **CI quality gates** | Yes (R@5 ≥ 0.70) | Unknown | Unknown | Unknown |

¹ Published numbers from respective papers. Not measured on identical benchmarks.
² Entity relations can be stored in memory text; no graph traversal.

### Where memex wins
- **Speed:** Fastest retrieval (~130ms) — no cloud roundtrip, no graph DB query
- **Cost:** $0/query with local inference. No API keys required for core functionality
- **Simplicity:** Single SQLite file. Copy to deploy. No external services
- **Dual search:** Memories AND documents in one query. Others do one or the other
- **Privacy:** Everything local. No data leaves your machine

### Where others win
- **Zep:** Superior temporal reasoning with bitemporal tracking. Best for "what changed between X and Y?"
- **mem0:** Entity graph relations. Better for "how is person A related to project B?"
- **MemGPT:** Dynamic context management. Better for very long conversations with limited context

## Retrieval Quality

### Retrieval quality (same corpus, same embedding model, head-to-head)

Controlled benchmark: 36 documents, 29 queries, all using Qwen3-Embedding-4B (2560d). Only the search pipeline differs.

| System | nDCG@5 | MRR | Recall@5 | Misses | Latency | What's different |
|---|---|---|---|---|---|---|
| **QMD** (FTS only) | 0.636 | 0.634 | 77.6% | 5/29 | 35ms | Doc-level FTS only |
| **QMD** (hybrid) | 0.597 | 0.611 | 72.4% | 7/29 | 471ms | + vector search |
| **memex** (FTS) | **0.691** | **0.700** | **83.3%** | **4/29** | 171ms | + section/bullet FTS |
| **memex** (hybrid) | 0.629 | 0.681 | 75.9% | 6/29 | 590ms | + unified retriever |

**memex FTS vs QMD FTS:** +8.6% nDCG, +10.4% MRR, +5.7% Recall. Wins 7 queries, loses 3, ties 19.

The section/bullet-level FTS is the primary quality driver — it finds facts in dense multi-topic documents that doc-level FTS misses.

> LanceDB Pro is not included — it only searched conversation memories, not documents, so it can't be compared on this corpus.

### memex by query category

| Category | nDCG@5 | Recall@5 | Misses |
|---|---|---|---|
| temporal_query | 1.000 | 1.000 | 0/2 |
| proper_noun | 0.845 | 0.944 | 0/9 |
| semantic_concept | 0.782 | 0.800 | 1/5 |
| ambiguous_keyword | 0.733 | 0.833 | 0/2 |
| factoid_lookup | 0.483 | 0.625 | 3/8 |
| preference_recall | 0.387 | 1.000 | 0/1 |

Quality floors enforced in CI: FTS R@5 ≥ 0.70, Hybrid R@5 ≥ 0.65.

### LongMemEval (ICLR 2025) — cross-system benchmark

**Important:** The published numbers for Hindsight/Zep/mem0/MemGPT are **end-to-end accuracy** (retrieval + LLM answer generation). memex's numbers include both retrieval Recall@K and E2E accuracy (with an LLM reading step). Other systems' published numbers use GPT-4o with their own evaluation methodology.

Measured on LongMemEval_s (ICLR 2025). N=50 for memex, published numbers for others.

| System | R@1 | R@3 | R@5 | E2E Accuracy | Reader LLM | Latency | Architecture |
|---|---|---|---|---|---|---|---|
| Hindsight/TEMPR | — | — | — | **91.4%** | GPT-4o | ~400ms | 4-way parallel, entity-aware |
| **memex** (hybrid) | **78%** | **90%** | **96%** | **90%** | GPT-4o | **~150ms** | Z-score fusion + chunked Qwen3-Embedding-4B |
| Zep/Graphiti | — | — | ~85% | GPT-4o | ~300ms | Bitemporal graph (Neo4j) |
| mem0 (graph) | — | — | ~78% | GPT-4o | ~200ms | Cloud API + knowledge graph |
| MemGPT/Letta | — | — | ~75% | GPT-4o | ~500ms+ | LLM-managed paging |

Evaluated using official LongMemEval prompts and GPT-4o-mini LLM-judge (same methodology as published systems). memex retrieves the correct session at R@3=90% and achieves 90% E2E accuracy with GPT-4o reader — within 1.4pp of the best system (Hindsight/TEMPR). In production memex returns ≤3 results, making R@3 the most relevant retrieval metric.

## Performance Profile

| Operation | Latency |
|---|---|
| Embed query (cached, >97% hit rate) | <0.03ms |
| Embed query (uncached) | ~75ms |
| Vector search (1.9K memories) | ~4ms |
| BM25 search (1.9K memories) | <0.3ms |
| Cross-encoder rerank (10 candidates) | ~50ms |
| Full unified retriever pipeline | ~130ms p50 |
| Heap memory after init | ~13MB |
| API calls per query (avg) | 1.5 |
