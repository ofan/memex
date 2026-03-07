# Benchmark & Comparison Design

**Date:** 2026-03-05
**Status:** Approved

## Goals

1. Measure retrieval quality and latency across pipeline modes using industry-standard benchmarks and real data
2. Simulate realistic OpenClaw plugin usage patterns and measure performance at scale
3. Compare feature-set against state-of-the-art memory systems
4. Produce actionable optimization recommendations

## 1. Quality Benchmark Suite (`tests/quality-bench.ts`)

### Three-layer corpus

**Layer 1: BEIR (industry standard)**
- Datasets: FiQA (financial Q&A), NQ (natural questions), SciFact (fact verification)
- Freely downloadable, widely published nDCG@10 numbers for comparison
- Eliminates labeling bias — established ground truth

**Layer 2: LongMemEval (conversational memory)**
- Designed for long-term conversational memory recall
- Tests fact retention, temporal reasoning, multi-session recall
- 500+ queries with ground truth

**Layer 3: Real OpenClaw data**
- Session transcripts from OpenClaw session data
- Workspace files from current project
- Validates that public benchmark results hold on actual user data

### Synthetic stress layer
- Script generates 500-2000 memories with controlled properties
- Varying length, age, importance, category distribution
- Adversarial cases: near-duplicates, very old entries, extremely long entries

### Metrics

| Metric | What it measures |
|--------|-----------------|
| Recall@k (k=1,3,5,10) | Did the relevant memory appear in top-k? |
| Precision@k | What fraction of top-k is relevant? |
| MRR | How high is the first relevant result? |
| nDCG@k | Ranking quality with graded relevance |
| Latency (p50, p95) | Per-query wall time |

### Pipeline modes compared

1. Vector-only (no BM25, no rerank)
2. Hybrid (vector + BM25 + RRF fusion)
3. Hybrid + cross-encoder rerank
4. Hybrid + rerank + recency boost
5. Unified recall (conversation + document search)

### Model swap (deferred — run last)

Harness accepts embedding config. Run all modes on Qwen3-0.6B first, optimize pipeline, then re-run with stella-1.5B and Gemini to measure model impact.

Models to compare:
- Qwen3-Embedding-0.6B (current, MTEB 64.3, 1024d, ~1.2GB VRAM)
- stella_en_1.5B_v5 (MTEB 71.19, 1536d, ~3GB VRAM)
- Gemini-embedding-001 (MTEB 68.3, 3072d, API)

## 2. Usage Simulation (`tests/simulation-bench.ts`)

Uses a thin OpenClaw plugin API mock to exercise real tool handlers (auto-capture, noise filtering, adaptive retrieval, scopes).

### Scenario 1: Day-in-the-life
- Morning: 5 conversations (10-20 messages each), auto-capture stores ~15 memories, 3 manual stores
- Afternoon: 20 recall queries on growing corpus, mix of precise and vague
- End of day: forget 2 memories, update 1
- Measures: store latency, recall quality + latency, auto-capture filtering accuracy

### Scenario 2: Corpus growth
- Grow from 0 to 50, 200, 500, 1000, 2000 memories
- At each checkpoint: run 10 standard queries
- Measures: recall@5, latency (p50/p95), memory usage (heap + RSS)
- Answer: where does performance degrade?

### Scenario 3: Document indexing
- Index this project's workspace (~30 markdown files)
- Then index larger synthetic workspaces (200, 500, 1000 files)
- Measures: indexing throughput (files/sec, chunks/sec), incremental re-index time, unified recall latency with documents

### Scenario 4: Concurrent patterns
- Rapid-fire stores + recalls interleaved (simulates active conversation)
- Background re-index running while user queries hit
- Measures: latency stability under concurrent load

### Output per scenario
- Latency table (p50, p95, p99)
- Memory usage over time (heap + RSS snapshots)
- Quality metrics where applicable
- Chart-friendly JSON dump

## 3. Feature Comparison (`docs/COMPARISON.md`)

### Systems compared
- **memclaw** (ours) — live benchmarks
- **mem0** — documentation + published benchmarks
- **Zep** — documentation + published benchmarks
- **MemGPT/Letta** — documentation + published benchmarks
- **LangChain ConversationMemory** — documentation
- **LlamaIndex Memory** — documentation

### Comparison dimensions
- Retrieval: vector, BM25, hybrid, reranking, fusion strategy
- Storage: backend, persistence, scalability
- Memory management: auto-capture, forget, update, importance scoring
- Scoping: multi-agent isolation, namespaces, access control
- Document search: workspace indexing, chunking, unified recall
- Quality: published recall/nDCG numbers
- Latency: published or documented numbers
- Cost: cloud pricing vs local inference
- Integration: SDK, API, plugin, agent loop

## 4. Findings & Recommendations (appended to `docs/BENCHMARKS.md`)

1. **Pipeline mode comparison** — recall@k, MRR, nDCG@10 per mode, quality-per-ms analysis
2. **BEIR comparison** — our nDCG@10 vs Pinecone, Cohere, ColBERT published numbers
3. **Scalability profile** — latency/memory at each corpus size checkpoint
4. **Optimization targets** — ranked list of where to focus effort with data backing
5. **Model swap results** — deferred until after pipeline optimization

## Deliverables

| Deliverable | File | Description |
|-------------|------|-------------|
| Quality benchmark | `tests/quality-bench.ts` | BEIR + LongMemEval + real data |
| Usage simulation | `tests/simulation-bench.ts` | 4 scenarios, plugin mock |
| Plugin mock | `tests/helpers/plugin-mock.ts` | Thin OpenClaw API mock |
| BEIR loader | `tests/helpers/beir-loader.ts` | Download + parse BEIR datasets |
| Feature comparison | `docs/COMPARISON.md` | Feature matrix vs SOTA |
| Findings | `docs/BENCHMARKS.md` (appended) | Analysis + recommendations |

## Execution order

1. Build test infrastructure (plugin mock, BEIR loader, bench harness)
2. Run quality benchmarks on current pipeline (Qwen3-0.6B)
3. Run usage simulation
4. Research and write feature comparison
5. Analyze results, write findings and optimization recommendations
6. Optimize pipeline based on findings
7. Re-run benchmarks to validate improvements
8. Swap embedding models, measure marginal impact
