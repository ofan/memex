# Benchmark & Comparison Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build quality benchmarks (BEIR + LongMemEval + real data), usage simulation (4 scenarios), and feature comparison against SOTA memory systems. Produce actionable optimization recommendations.

**Architecture:** Three new benchmark scripts (`quality-bench.ts`, `simulation-bench.ts`) plus helper modules (`plugin-mock.ts`, `beir-loader.ts`, `ir-metrics.ts`). All use the same bench harness pattern from existing `benchmark.ts`. Comparison is a research doc. Requires Mac Mini llama.cpp at 100.122.104.26:8090.

**Tech Stack:** TypeScript, Node.js test runner via jiti, LanceDB, SQLite/sqlite-vec, fetch for BEIR dataset download.

---

### Task 1: IR Metrics Module

**Files:**
- Create: `tests/helpers/ir-metrics.ts`
- Create: `tests/ir-metrics.test.ts`

**Step 1: Write the failing test**

Create `tests/ir-metrics.test.ts` with tests for `recallAtK`, `precisionAtK`, `mrr`, `ndcgAtK`:
- recall@5 = 1.0 when all relevant in top 5
- recall@3 = 0.5 when 1 of 2 relevant in top 3
- recall@k = 0 when no relevant returned
- precision@3 = 2/3 when 2 of 3 results relevant
- mrr = 0.5 when first relevant at rank 2
- mrr = 1.0 when first relevant at rank 1
- mrr = 0 when no relevant found
- ndcg@3 perfect ranking = 1.0
- ndcg@3 imperfect ranking < 1.0
- ndcg@k = 0 when all irrelevant

**Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/ir-metrics.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement `tests/helpers/ir-metrics.ts`**

Pure functions, no dependencies:
- `recallAtK(relevantIds, resultIds, k)` - fraction of relevant in top-k
- `precisionAtK(relevantIds, resultIds, k)` - fraction of top-k that are relevant
- `mrr(relevantIds, resultIds)` - 1/rank of first relevant
- `ndcgAtK(relevanceMap, resultIds, k)` - normalized DCG with graded relevance (0/1/2)

**Step 4: Run test to verify it passes**

Run: `node --import jiti/register --test tests/ir-metrics.test.ts`
Expected: PASS (all 10 tests)

**Step 5: Commit**

```bash
git add tests/helpers/ir-metrics.ts tests/ir-metrics.test.ts
git commit -m "add IR metrics module: recall@k, precision@k, MRR, nDCG@k"
```

---

### Task 2: BEIR Dataset Loader

**Files:**
- Create: `tests/helpers/beir-loader.ts`
- Create: `tests/beir-loader.test.ts`
- Update: `.gitignore` (add `tests/.cache/`)

**Step 1: Write the failing test**

Create `tests/beir-loader.test.ts`:
- Lists available datasets (fiqa, nq, scifact)
- Loads fiqa with maxQueries=10, maxCorpus=100
- Validates queries have id + text
- Validates corpus docs have id + title + text
- Validates qrels map queryId to docId relevance grades
- Each query has at least one relevant doc

**Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/beir-loader.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement `tests/helpers/beir-loader.ts`**

Downloads BEIR JSONL files from HuggingFace, caches in `tests/.cache/beir/`:
- `corpus.jsonl`: `{"_id": "...", "title": "...", "text": "..."}`
- `queries.jsonl`: `{"_id": "...", "text": "..."}`
- `qrels/test.tsv`: `query-id \t corpus-id \t score`

Key functions:
- `loadBeirDataset(name, opts)` - returns `{ queries, corpus, qrels }`
- Supports `maxQueries` and `maxCorpus` for fast iteration
- Filters queries to those with relevance judgments
- Caches downloaded files locally

**Step 4: Run test to verify it passes**

Run: `node --import jiti/register --test tests/beir-loader.test.ts`
Expected: PASS (downloads dataset on first run)

**Step 5: Add `tests/.cache/` to `.gitignore` and commit**

```bash
echo "tests/.cache/" >> .gitignore
git add tests/helpers/beir-loader.ts tests/beir-loader.test.ts .gitignore
git commit -m "add BEIR dataset loader with HuggingFace download and caching"
```

---

### Task 3: Plugin Mock

**Files:**
- Create: `tests/helpers/plugin-mock.ts`
- Create: `tests/plugin-mock.test.ts`

**Step 1: Write the failing test**

Create `tests/plugin-mock.test.ts`:
- Registers tools via `api.registerTool()`
- Retrieves registered tools via `api.getRegisteredTool(name)`
- Executes tools via `api.executeTool(name, params)`
- Records event hooks via `api.onEvent(event, handler)`
- Provides mock identity (pluginId, pluginName, pluginVersion)

**Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/plugin-mock.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement `tests/helpers/plugin-mock.ts`**

Thin mock of `OpenClawPluginApi`:
- `registerTool(def)` - stores tool definitions in a Map
- `getRegisteredTool(name)` - returns tool def
- `executeTool(name, params)` - calls tool's execute handler
- `onEvent(event, handler)` - stores handlers
- `getEventHandlers(event)` - returns handlers
- `identity` - static mock object

**Step 4: Run test to verify it passes**

Run: `node --import jiti/register --test tests/plugin-mock.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add tests/helpers/plugin-mock.ts tests/plugin-mock.test.ts
git commit -m "add OpenClaw plugin API mock for benchmark harness"
```

---

### Task 4: Quality Benchmark Harness

**Files:**
- Create: `tests/quality-bench.ts`

This benchmarks both **indexing** (how fast corpus is ingested into LanceDB) and **retrieval quality** (recall/MRR/nDCG across pipeline modes).

**Step 1: Implement `tests/quality-bench.ts`**

CLI: `node --import jiti/register tests/quality-bench.ts [--dataset fiqa|nq|scifact|synthetic] [--max-queries 50]`

Structure:
1. **Dataset loading** - BEIR via beir-loader, or synthetic generator
2. **Indexing phase** - Import raw corpus docs into fresh LanceDB store. Measure:
   - Total indexing time (embed + store)
   - Per-document indexing latency
   - Throughput (docs/sec, embeddings/sec)
   - Memory usage before/after indexing
3. **Retrieval phase** - Run queries across 4 pipeline modes:
   - vector-only
   - hybrid (vector + BM25)
   - hybrid + cross-encoder rerank
   - hybrid + rerank + recency boost
4. **Metrics per mode**:
   - Recall@1, @3, @5, @10
   - Precision@5
   - MRR
   - nDCG@10
   - Latency (avg, p95)
5. **Output**: Markdown tables + JSON dump to `tests/.cache/`

Synthetic dataset generator creates ~120 corpus docs (20 topics x 1 exact match + 5 distractors) with 20 queries and graded relevance labels.

**Step 2: Test with synthetic data**

Run: `node --import jiti/register tests/quality-bench.ts --dataset synthetic --max-queries 10`
Expected: Outputs indexing stats + quality table for all 4 modes

**Step 3: Commit**

```bash
git add tests/quality-bench.ts
git commit -m "add quality benchmark: indexing speed + IR metrics across pipeline modes"
```

---

### Task 5: Usage Simulation Benchmark

**Files:**
- Create: `tests/simulation-bench.ts`

CLI: `node --import jiti/register tests/simulation-bench.ts [--scenario all|daily|growth|indexing|concurrent]`

**Step 1: Implement 4 scenarios**

**Scenario 1: Day-in-the-life**
- Morning: 5 conversations (10-20 msgs), auto-capture with noise filtering
- Afternoon: 20 recall queries
- End of day: forget 2, update 1
- Output: store/recall latency, noise filter stats, memory

**Scenario 2: Corpus growth**
- Grow from 0 to 50/200/500/1000/2000 memories
- At each checkpoint: 10 benchmark queries
- Output: table of latency + memory at each size

**Scenario 3: Document indexing**
- Generate synthetic workspaces (30/200/500 markdown files)
- Index into QMD SQLite store, measure:
  - Indexing throughput (files/sec, chunks/sec)
  - Index size on disk
  - Incremental re-index time (no changes)
  - Search latency after indexing
- Output: table of throughput + search latency per workspace size

**Scenario 4: Concurrent patterns**
- Seed 200 memories
- 50 interleaved store+recall cycles
- Output: latency stability stats

**Step 2: Test with daily scenario**

Run: `node --import jiti/register tests/simulation-bench.ts --scenario daily`
Expected: Outputs store/recall latency and memory stats

**Step 3: Commit**

```bash
git add tests/simulation-bench.ts
git commit -m "add usage simulation benchmark: daily, growth, indexing, concurrent scenarios"
```

---

### Task 6: Feature Comparison Research

**Files:**
- Create: `docs/COMPARISON.md`

**Step 1: Research**

Use web search to gather architecture, features, published benchmarks, pricing for:
- mem0 (https://mem0.ai)
- Zep (https://getzep.com)
- MemGPT / Letta (https://letta.com)
- LangChain ConversationMemory
- LlamaIndex Memory

**Step 2: Write `docs/COMPARISON.md`**

Structure:
1. Feature matrix table (all systems x all dimensions)
2. Per-system analysis (1-2 paragraphs each)
3. Strengths and weaknesses of memory-unified
4. Recommendations for what to prioritize

Dimensions: retrieval approach, storage backend, memory management, scoping, document search, quality, latency, cost, integration model.

**Step 3: Commit**

```bash
git add docs/COMPARISON.md
git commit -m "add feature comparison: memory-unified vs mem0, Zep, MemGPT, LangChain, LlamaIndex"
```

---

### Task 7: Run All Benchmarks and Write Findings

**Step 1: Run quality benchmarks**

```bash
node --import jiti/register tests/quality-bench.ts --dataset synthetic --max-queries 20
node --import jiti/register tests/quality-bench.ts --dataset fiqa --max-queries 50
node --import jiti/register tests/quality-bench.ts --dataset scifact --max-queries 50
```

**Step 2: Run simulation benchmarks**

```bash
node --import jiti/register tests/simulation-bench.ts --scenario all
```

**Step 3: Append findings to `docs/BENCHMARKS.md`**

New sections:
1. **Indexing Performance** - docs/sec, embeddings/sec at various corpus sizes
2. **Pipeline Mode Comparison** - recall@k, MRR, nDCG@10 per mode with quality-per-ms analysis
3. **BEIR Comparison** - our nDCG@10 vs published numbers (Pinecone, Cohere, BM25 baseline)
4. **Scalability Profile** - latency/memory at 50/200/500/1000/2000 memories
5. **Optimization Targets** - ranked list with data backing each recommendation
6. **Model Swap Results** - placeholder (deferred)

**Step 4: Commit**

```bash
git add docs/BENCHMARKS.md
git commit -m "add quality + simulation benchmark results and optimization recommendations"
```

---

### Task 8: Verify All Tests Still Pass

**Step 1: Run full test suite**

```bash
node --import jiti/register --test tests/*.test.ts
```

Expected: 145+ tests pass (original 145 + new ir-metrics + beir-loader + plugin-mock tests)

**Step 2: Fix any issues**

**Step 3: Final commit**

```bash
git commit -m "verify all tests pass after benchmark additions"
```

---

## Execution order

1. Task 1: IR metrics (pure functions, no deps)
2. Task 2: BEIR loader (network + caching)
3. Task 3: Plugin mock (thin mock)
4. Task 4: Quality benchmark harness (indexing speed + retrieval quality)
5. Task 5: Simulation benchmark (4 scenarios)
6. Task 6: Feature comparison (research doc)
7. Task 7: Run benchmarks, write findings
8. Task 8: Final test verification
