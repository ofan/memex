# Unified Memory Retrieval Pipeline Design

**Date:** 2026-03-15
**Status:** Design draft
**Replaces:** Dual-pipeline architecture (separate `MemoryRetriever` + `hybridQuery` merged in `UnifiedRecall`)

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Architecture](#2-architecture)
3. [Detailed Pipeline Stages](#3-detailed-pipeline-stages)
4. [Scoring Formula](#4-scoring-formula)
5. [Model Swap Strategy](#5-model-swap-strategy)
6. [Routing Logic](#6-routing-logic)
7. [Comparison: Current vs Proposed](#7-comparison-current-vs-proposed)
8. [Migration Path](#8-migration-path)
9. [Open Questions](#9-open-questions)

---

## 1. Problem Statement

### Current Architecture (What We Replace)

The current system runs two independent retrieval pipelines, then merges
results in `UnifiedRecall.mergeResults()`:

```
Query
  |
  +-----> MemoryRetriever.hybridRetrieval()     (src/retriever.ts)
  |         embed query .................. [API call 1: embed, ~75ms]
  |         sqlite-vec search ............ [local, ~4ms]
  |         FTS5 BM25 search ............. [local, <1ms]
  |         RRF fusion ................... [local, <1ms]
  |         cross-encoder rerank ......... [API call 2: rerank, ~50ms]
  |         recency boost ................ [local]
  |         importance weight ............ [local]
  |         length normalization ......... [local]
  |         time decay ................... [local]
  |         adaptive min score ........... [local]
  |         noise filter ................. [local]
  |         recently-recalled penalty .... [local]
  |         MMR diversity ................ [local]
  |
  +-----> hybridQuery()                         (src/search.ts)
  |         BM25 probe (FTS5) ............ [local, <1ms]
  |         query expansion .............. [API call 3: generation, ~200ms]
  |         expanded FTS searches ........ [local, <1ms each]
  |         batch embed (original + expanded) [API call 1: reused? NO -- separate]
  |         sqlite-vec searches .......... [local, ~3ms]
  |         weighted RRF fusion .......... [local]
  |         chunk + pick best chunk ...... [local]
  |         cross-encoder rerank chunks .. [API call 4: rerank, ~50ms]
  |         blend RRF + rerank scores .... [local]
  |
  +-----> UnifiedRecall.mergeResults()          (src/unified-recall.ts)
            raw score * source weight .... [local]
            sort descending .............. [local]
            (optional cross-source rerank) [API call 5: rerank, ~50ms]
```

### Measured Problems

1. **Duplicate embedding:** The query gets embedded twice -- once in
   `MemoryRetriever` (via `embedder.embedQuery`) and again in `hybridQuery`
   (via `llm.embedBatch`). These use the same model but different code paths.
   Cost: 1 extra API call (~75ms, ~20 tokens), plus potential model swap.

2. **Duplicate reranking:** Memories are reranked in `retriever.ts:492-558`,
   documents are reranked in `search.ts:3482-3485`, and optionally both are
   reranked again in `unified-recall.ts:339-394`. Worst case: 3 rerank calls.
   Cost: up to 2 extra API calls (~100ms, ~20K tokens).

3. **Score incompatibility:** Memory scores pass through 7 multiplicative
   stages (compression up to 82.5%); document scores pass through a different
   RRF + rerank blend. Merging via `rawScore * 0.5` puts them on
   incomparable scales. (See ranking-mathematics.md Section 7.)

4. **Model swap thrashing:** The pipeline sequence is embed -> rerank ->
   expand (generation) -> embed -> rerank. On llama-swap with single-model
   loading, this causes at least 2 model swaps at 2-5s each. Worst case: 4
   swaps costing 8-20s.

5. **Query expansion waste:** `hybridQuery` calls `expandQuery()` which invokes
   the generation model (~200ms, ~500 tokens) for every query. This is skipped
   only when BM25 finds a "strong signal" (exact keyword match). For
   preference queries like "what's my TTS voice", expansion adds nothing.

6. **No routing:** Every query hits both pipelines regardless of type.
   "What's the Discord channel ID" (pure memory lookup) pays full document
   search cost. "What does REQUIREMENTS.md say" (pure doc lookup) pays full
   memory pipeline cost.

### Design Goals

| Goal | Metric | Target |
|------|--------|--------|
| Reduce API calls | calls/query | 2 (embed + rerank) from 4 |
| Reduce latency | p50 | <200ms from ~375ms |
| Eliminate model swaps | swaps/query | 0 (batch same-model calls) |
| Improve score quality | nDCG@5 (manual assessment) | Measurable improvement |
| Maintain accuracy | No regressions on 7 use cases | Pass all |

---

## 2. Architecture

### Proposed Pipeline (ASCII Diagram)

```
                              QUERY
                                |
                    +-----------+-----------+
                    |                       |
               [Skip Check]          [Source Router]
            (adaptive-retrieval.ts)    (heuristic)
                    |                       |
              skip? exit              "memory" | "document" | "both"
                                            |
                    +-----------------------+
                    |
              [EMBED QUERY]  ......................... 1 API call (~75ms)
                    |
        +-----------+-----------+
        |           |           |
   [Memory Vec]  [Memory BM25]  [Section FTS]
   sqlite-vec     memories_fts   sections_fts + documents_fts
   ~4ms           <1ms           <1ms
        |           |           |
        +-----+-----+           |
              |                  |
        [Memory Fusion]    [Doc Candidates]
        score-based        collect doc bodies + best chunks
        (vec + BM25 boost) from section/doc FTS hits
              |                  |
              +--------+---------+
                       |
                 [POOL & DEDUPLICATE]
                 union candidates, 1 entry per source item
                       |
                 [Z-SCORE CALIBRATE]
                 per-source z-score -> sigmoid -> [0, 1]
                       |
                 [CONFIDENCE GATE]
                 check if rerank needed
                       |
                  yes? | no?
                       |
          +------------+------------+
          |                         |
    [UNIFIED RERANK] ............ [skip rerank]
    1 API call (~50ms)              |
    embed+memory+doc together       |
          |                         |
          +------------+------------+
                       |
                 [TEMPORAL ADJUST]
                 durability-aware time decay
                 (memory entries only)
                       |
                 [IMPORTANCE + LENGTH]
                 importance weight + length norm
                 (memory entries only)
                       |
                 [FLOOR GUARANTEE]
                 max(score, 0.25 * relevance_score)
                       |
                 [SOURCE DIVERSITY]
                 protect top-1 per source
                       |
                 [FINAL TOP-K]
                       |
                    RESULTS
```

### Key Design Decisions

1. **Single embedding call.** Query is embedded once. The vector is reused for
   both memory vector search and document vector search (both use the same
   `vectors_vec` table with different key prefixes: `mem_*` vs `hash_seq`).

2. **Single rerank call.** Memories (short text) and document chunks
   (bestChunk, ~500 chars) are reranked together in one cross-encoder pass.
   The cross-encoder sees both types side by side, which lets it make
   direct relevance comparisons.

3. **No query expansion by default.** The generation model call is eliminated.
   Section-level FTS (`sections_fts`) provides the recall boost that query
   expansion was designed to give. If recall is insufficient on first pass,
   a fallback expansion can be triggered (see Stage 3 below).

4. **Z-score calibration replaces raw score weighting.** Scores from each
   source are standardized to a common distribution before merging. This
   mathematically solves the score incompatibility problem.

5. **Post-merge modifiers instead of pre-merge cascade.** Temporal decay,
   importance, and length normalization apply *after* cross-source merge,
   not within the per-source pipeline. This eliminates the 82.5%
   multiplicative compression problem.

---

## 3. Detailed Pipeline Stages

### Stage 0: Skip Check (Existing)

**Code:** `adaptive-retrieval.ts` (unchanged)

Determines if retrieval should be skipped entirely. Handles greetings,
commands, single-word affirmations, etc.

```
Input:  query string
Output: boolean (skip or proceed)
Cost:   ~0.001ms, 0 API calls
```

### Stage 1: Source Routing

**Code:** New function in unified pipeline

Classifies the query to determine which sources to search. Three outcomes:

| Route | When | Sources Searched |
|-------|------|-----------------|
| `memory` | User preferences, past decisions, "I said/told you" | memories table only |
| `document` | File references, config, docs ("in the file", ".md", ".ts") | documents/sections FTS + vec |
| `both` | Ambiguous, mixed, or general queries | all sources |

**Implementation:** Heuristic regex classifier. No API call.

```typescript
function routeQuery(query: string): "memory" | "document" | "both" {
  const q = query.toLowerCase();

  // Document-only signals
  if (/\b(in the file|documentation|readme|\.md|\.ts|\.json|config file|source code|codebase)\b/.test(q))
    return "document";
  if (/\b(what does .+ say|contents of|look at|check the file)\b/.test(q))
    return "document";

  // Memory-only signals
  if (/\b(my preference|i said|i want|i told you|remember when|do i|did we|have i)\b/.test(q))
    return "memory";
  if (/\b(what('s| is) (my|the) .*(key|token|password|secret|voice|port|channel|address))\b/.test(q))
    return "memory";

  return "both";
}
```

```
Input:  query string
Output: "memory" | "document" | "both"
Cost:   ~0.01ms, 0 API calls
```

**Estimated hit rate:** ~30-35% of queries route to a single source,
saving the full cost of the skipped source.

### Stage 2: Embed Query

**Code:** Single call to `embedder.embedQuery()` (existing)

Embeds the query once. The resulting vector is reused by both memory vector
search and document vector search.

```
Input:  query string
Output: Float32Array[2560]  (Qwen3-Embedding-4B dimensions)
Cost:   ~75ms uncached, <0.03ms cached (LRU, >97% hit rate)
        1 API call, ~20 tokens
```

**Model:** Qwen3-Embedding-4B-Q8_0 on llama-swap (Mac Mini)

### Stage 3: Parallel Retrieval

Three retrieval channels run in parallel (subject to source routing):

#### 3a: Memory Vector Search

**Code:** `MemoryStore.vectorSearch()` (existing, unchanged)

```sql
SELECT hash_seq, distance
FROM vectors_vec
WHERE embedding MATCH ?query_vec AND k = 40
-- filter to mem_* prefix
```

Fetches top-40 memory vectors by cosine distance.
Converts distance to score: `score = 1 / (1 + distance)`

```
Input:  query vector (from Stage 2)
Output: up to 40 MemorySearchResult[]
Cost:   ~4ms, 0 API calls
```

#### 3b: Memory BM25 Search

**Code:** `MemoryStore.bm25Search()` (existing, unchanged)

```sql
SELECT m.*, bm25(memories_fts) as bm25_score
FROM memories_fts f
JOIN memories m ON m.rowid = f.rowid
WHERE memories_fts MATCH ?fts_query
LIMIT 20
```

BM25 score normalized: `score = |bm25| / (1 + |bm25|)` -> [0, 1)

```
Input:  query string (FTS5 tokenized)
Output: up to 20 MemorySearchResult[]
Cost:   <1ms, 0 API calls
```

#### 3c: Document Search (FTS + Vector)

**Code:** New unified function replacing `hybridQuery()`

Unlike the current `hybridQuery()` which runs query expansion and its own
embedding, the new version:
- Receives the pre-computed query embedding from Stage 2
- Searches `sections_fts` and `documents_fts` for FTS candidates
- Searches `vectors_vec` (hash_seq prefix) for vector candidates
- Does NOT call query expansion (no generation model call)

```sql
-- Section-level FTS (dual-granularity, already deployed)
SELECT d.path, d.title, c.body, s.section_text, s.char_pos,
       bm25(sections_fts) as score
FROM sections_fts sf
JOIN sections s ON s.rowid = sf.rowid
JOIN documents d ON d.id = s.document_id
JOIN content c ON c.hash = d.hash
WHERE sections_fts MATCH ?fts_query
  AND d.active = 1
  AND (?collection IS NULL OR d.collection = ?collection)
LIMIT 20

-- Document-level FTS
SELECT d.path, d.title, c.body, bm25(documents_fts) as score
FROM documents_fts df
JOIN documents d ON d.id = df.docid
JOIN content c ON c.hash = d.hash
WHERE documents_fts MATCH ?fts_query
  AND d.active = 1
  AND (?collection IS NULL OR d.collection = ?collection)
LIMIT 20

-- Vector search (reuse query embedding from Stage 2)
SELECT hash_seq, distance
FROM vectors_vec
WHERE embedding MATCH ?query_vec AND k = 20
-- filter to hash_* prefix (document chunks)
```

For each unique document, pick the best chunk using section char_pos
from FTS or keyword overlap fallback. This replaces the per-document
chunking + keyword scanning in the current `hybridQuery()`.

```
Input:  query string + query vector (from Stage 2)
Output: up to 20 DocumentResult[] (with bestChunk, bestChunkPos)
Cost:   ~5ms total, 0 API calls
```

**Critical change:** No query expansion call. The current `expandQuery()`
calls the generation model (Qwen3-0.6B) at ~200ms and ~500 tokens to produce
lexical and vector variants of the query. With section-level FTS
(`sections_fts` with 13,326 entries), the recall improvement from expansion
is marginal: section-level indexing catches the same content that expansion
was designed to find.

**Fallback expansion (optional, not in default path):** If Stage 3c returns
zero FTS results AND zero vector results, trigger query expansion as a
recovery mechanism. This should happen for <5% of queries. Cost when
triggered: ~200ms + model swap penalty.

### Stage 4: Memory Fusion

**Code:** Modified from current `MemoryRetriever.fuseResults()`

Combines memory vector and BM25 results using the existing score-based
fusion formula:

```
fused(m) = vec_score(m) + bm25_hit(m) * 0.15 * vec_score(m)
```

BM25-only results (no vector match) keep their normalized BM25 score.
This formula is validated and works well; no change needed.

```
Input:  memory vec results + memory BM25 results
Output: fused MemoryResult[] with scores in ~[0.1, 0.95]
Cost:   <0.1ms, 0 API calls
```

### Stage 5: Document Fusion

**Code:** New, simplified from current `hybridQuery` RRF logic

For documents, fuse section FTS, document FTS, and vector results.
Use weighted RRF (not raw scores) because document scores from three
different retrieval methods are less calibrated than memory scores:

```
doc_score(d) = SUM_r  w_r / (60 + rank_r(d))

where:
  w_section_fts = 2.0   (section-level match is strongest signal)
  w_doc_fts     = 1.0   (document-level match is baseline)
  w_vector      = 1.5   (semantic match is second-strongest)
```

Per document, identify bestChunk via section char_pos (fast path)
or keyword overlap (fallback). Store bestChunk text for reranking.

```
Input:  section FTS results + doc FTS results + doc vector results
Output: fused DocumentResult[] with bestChunk
Cost:   <0.1ms, 0 API calls
```

### Stage 6: Pool and Z-Score Calibration

**Code:** New function replacing `UnifiedRecall.mergeResults()`

Pool all candidates from both sources. Apply z-score normalization
within each source, then sigmoid to map to [0, 1]:

```typescript
function calibrate(scores: number[]): (score: number) => number {
  const n = scores.length;
  if (n < 2) return () => 0.5;

  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(
    scores.reduce((a, s) => a + (s - mean) ** 2, 0) / n
  );
  const safeStd = Math.max(std, 0.01); // prevent div-by-zero

  return (score: number) => 1 / (1 + Math.exp(-(score - mean) / safeStd));
}
```

After calibration, apply source weights:

```
weighted(r) = calibrated(r) * w_source(r)

w_source = 0.55  for conversation memories
           0.45  for documents
```

The 0.55/0.45 split gives a mild preference to memories, reflecting that
short factual memories are more likely to be the "right answer" for typical
agent queries than document chunks. This weight can be tuned per deployment.

```
Input:  fused memory results + fused document results
Output: calibrated, weighted, merged result pool
Cost:   <0.1ms, 0 API calls
```

### Stage 7: Confidence-Gated Reranking

**Code:** Modified from `MemoryRetriever.rerankResults()` and
`UnifiedRecall.crossEncoderRerank()`

Check if reranking is needed:

```typescript
function shouldRerank(pool: CalibratedResult[]): boolean {
  if (pool.length <= 1) return false;

  const top = pool[0].score;
  const second = pool[1].score;

  // Skip if top result is dominant
  if (top - second > 0.15) return false;
  // Skip if top result is very high confidence
  if (top > 0.88) return false;

  return true;
}
```

When reranking IS needed:

- Take top-N candidates (N = min(pool.length, limit * 2, 15))
- For memory entries: use full text (typically <200 chars)
- For document entries: use bestChunk text (~500-3000 chars)
- Send as one batch to the cross-encoder

Score blending after rerank:

```
blended(r) = 0.7 * rerank_score(r) + 0.3 * calibrated_score(r)
```

The 0.7 weight is higher than the current unified recall blend (0.6)
because the cross-encoder now sees both memories and documents together,
giving it full context for cross-source comparison.

```
Input:  calibrated pool
Output: reranked pool (or unchanged if gate skips)
Cost:   ~50ms when triggered (1 API call, ~15K tokens for 10 candidates)
        0ms when skipped (~25-30% of queries)
```

### Stage 8: Post-Merge Modifiers

Applied only to conversation memory entries (documents do not have
temporal/importance metadata):

#### 8a: Durability-Aware Time Decay

Replace uniform time decay with per-durability-class parameters:

```
decay(m) = alpha(m) + (1 - alpha(m)) * exp(-age_days / halfLife(m))

| Durability  | alpha | halfLife | Behavior                    |
|-------------|-------|---------|-----------------------------|
| permanent   | 1.0   | -       | No decay (preferences, rules)|
| transient   | 0.5   | 60d     | Current behavior (default)   |
| ephemeral   | 0.1   | 7d      | Aggressive (daily facts)     |
```

Until the durability column is added to the schema, classify at
query-time using existing metadata:

```typescript
function inferDurability(entry: MemoryEntry): "permanent" | "transient" | "ephemeral" {
  const imp = entry.importance ?? 0.7;
  const cat = entry.category;
  const text = entry.text.toLowerCase();

  if (imp >= 0.85 && (cat === "preference" || cat === "decision")) return "permanent";
  if (imp <= 0.4 || /\b(today|right now|this morning|this afternoon)\b/.test(text)) return "ephemeral";
  return "transient";
}
```

```
Input:  pool with memory entries
Output: pool with decayed scores (memory entries only)
Cost:   <0.01ms, 0 API calls
```

#### 8b: Importance + Length Normalization

Applied after time decay. Uses the same formulas as current pipeline:

```
importance_factor = 0.7 + 0.3 * importance  // [0.7, 1.0]
length_factor = 1 / (1 + 0.5 * log2(max(charLen / 500, 1)))
```

These are multiplicative but bounded -- worst case compression is
`0.7 * 0.5 = 0.35`, much less than the current cascade's 0.175.

```
Input:  pool after time decay
Output: pool with adjusted scores
Cost:   <0.01ms, 0 API calls
```

#### 8c: Floor Guarantee

Prevent cascade compression from eliminating relevant results:

```
final_score(r) = max(adjusted_score(r), 0.25 * calibrated_score(r))
```

A highly relevant result (high calibrated score from Stage 6) cannot
be reduced below 25% of its calibrated relevance by temporal/importance/
length adjustments. This directly addresses the 82.5% compression failure
mode documented in ranking-mathematics.md Section 7.3.

### Stage 9: Source Diversity + Final Selection

Guarantee at least one result from each active source appears in top-k:

```typescript
const topMemory = pool.find(r => r.source === "conversation");
const topDoc = pool.find(r => r.source === "document");
const protectedIds = new Set<string>();
if (topMemory) protectedIds.add(topMemory.id);
if (topDoc) protectedIds.add(topDoc.id);

return pool
  .filter(r => r.score >= minScore || protectedIds.has(r.id))
  .slice(0, limit);
```

This is the same logic as the current `unified-recall.ts:214-223` and
works well. No change needed.

```
Input:  pool after floor guarantee
Output: final top-k results
Cost:   <0.01ms, 0 API calls
```

---

## 4. Scoring Formula

### Complete Formula (One Pass)

For a candidate result `r` with query `q`:

```
S(r, q) = max(
  F(r, q) * T(r) * I(r) * L(r),
  0.25 * C(r, q)
)
```

where:

**C(r, q) -- Calibrated relevance (z-score + sigmoid):**
```
C(r, q) = sigmoid((raw_score(r, q) - mean(S_source)) / std(S_source)) * w_source
```

**F(r, q) -- Fused score (after optional reranking):**
```
F(r, q) = {  0.7 * rerank(r, q) + 0.3 * C(r, q)   if reranked
          {  C(r, q)                                  if rerank skipped
```

**T(r) -- Temporal factor (memories only; documents get 1.0):**
```
T(r) = alpha(r) + (1 - alpha(r)) * exp(-age_days(r) / halfLife(r))
```

**I(r) -- Importance factor (memories only; documents get 1.0):**
```
I(r) = 0.7 + 0.3 * importance(r)
```

**L(r) -- Length factor (memories only; documents already chunked):**
```
L(r) = 1 / (1 + 0.5 * log2(max(|text(r)| / 500, 1)))
```

### Score Distribution After Each Stage (Estimated)

| Stage | Memory Scores | Document Scores |
|-------|--------------|-----------------|
| Raw (pre-calibration) | [0.10, 0.95] | [0.001, 0.25] (RRF) |
| After z-score + sigmoid | [0.12, 0.88] | [0.12, 0.88] |
| After source weight | [0.07, 0.48] | [0.05, 0.40] |
| After rerank blend | [0.05, 0.85] | [0.04, 0.82] |
| After time decay (worst) | [0.03, 0.85] | unchanged |
| After importance (worst) | [0.02, 0.85] | unchanged |
| After floor guarantee | [0.05, 0.85] | [0.04, 0.82] |

The floor guarantee prevents the worst-case compression from pushing
relevant results below the minimum score threshold (0.20).

---

## 5. Model Swap Strategy

### Current (Worst Case): 4+ Swaps

```
embed (Qwen3-Embedding)  ... loaded
rerank (bge-reranker)     ... SWAP #1 (2-5s)
expand (Qwen3-0.6B)      ... SWAP #2 (2-5s)
embed again               ... SWAP #3 (2-5s)
rerank again              ... SWAP #4 (2-5s)
```

Worst case total swap penalty: 8-20 seconds.

### Proposed: 1 Swap Maximum

```
embed (Qwen3-Embedding-4B) ... loaded (or already warm)
  -- all vector searches use pre-computed embedding
  -- all FTS searches are local SQLite, no model needed
rerank (bge-reranker)       ... SWAP #1 (2-5s) -- only if confidence gate triggers
```

**Sequencing rule:** All embedding work completes before any reranking
work begins. Since there is exactly one embed call and at most one rerank
call, there is at most one model swap per query.

**When reranking is skipped** (25-30% of queries per confidence gate):
zero model swaps. The embedding model stays loaded.

### Swap Amortization

llama-swap keeps the last-used model loaded. Across multiple queries:

- If the previous query loaded the embedding model and the current query
  skips reranking: 0 swaps.
- If the previous query loaded the reranker and the current query needs
  embedding: 1 swap.
- Steady state (alternating embed/rerank): 1 swap per query.

**Expected average:** 0.7 swaps per query (down from ~2.5).

---

## 6. Routing Logic

### Decision Matrix

| Query Pattern | Route | Stages Skipped | Savings |
|---------------|-------|----------------|---------|
| "what's my TTS voice" | `memory` | Doc FTS, Doc Vec, Doc fusion | ~5ms + doc rerank tokens |
| "I told you about X" | `memory` | Doc FTS, Doc Vec, Doc fusion | ~5ms |
| "what does REQUIREMENTS.md say" | `document` | Memory Vec, Memory BM25, Memory fusion | ~5ms |
| "how to deploy to k8s" | `document` | Memory Vec, Memory BM25, Memory fusion | ~5ms |
| "what did we decide about VPN-Tool" | `both` | nothing | baseline |
| "memory plugin" | `both` | nothing | baseline |

### Routing Accuracy Targets

- **Precision:** When the router says `memory` only, it should be correct
  >90% of the time. A wrong route means missing relevant documents.
- **Recall:** When a query NEEDS documents, the router should not
  route to `memory` only. False negatives are worse than false positives.
- **Default to `both`:** The router is conservative. When uncertain,
  search both sources. The cost of searching both is small (~5ms local
  queries); the cost of missing results is high.

### Early Termination (Enhanced)

The current `earlyTermination` config checks if all conversation results
exceed `highConfidenceThreshold`. The enhanced version is **bidirectional**:

```typescript
// After Stage 3, before Stage 7 (reranking):
if (route === "both") {
  const memScores = memoryPool.map(r => r.calibrated);
  const docScores = documentPool.map(r => r.calibrated);

  // All memory results are strong => skip doc reranking
  if (memScores.length >= limit
      && memScores.slice(0, limit).every(s => s > 0.75)) {
    skipDocReranking = true;
  }

  // All doc results are strong => skip memory reranking
  if (docScores.length >= limit
      && docScores.slice(0, limit).every(s => s > 0.75)) {
    skipMemReranking = true;
  }
}
```

---

## 7. Comparison: Current vs Proposed

### Per-Use-Case Analysis

#### Use Case 1: Factoid Lookup
**Query:** "what's the Discord channel ID"

| Metric | Current | Proposed |
|--------|---------|----------|
| Route | both | **memory** |
| API calls | 4 (embed, mem-rerank, expand, doc-rerank) | **1** (embed only; gate skips rerank) |
| Model swaps | 3 | **0** |
| Latency | ~375ms + swap penalty | **~80ms** |
| Tokens | ~20K | **~20** |
| Quality | Correct (memory result ranks #1) | Correct (same) |

**Why:** Router detects "what's the" + factoid pattern -> memory-only route.
Single high-confidence memory match -> confidence gate skips reranking.

#### Use Case 2: Preference Recall
**Query:** "does user have a TTS preference"

| Metric | Current | Proposed |
|--------|---------|----------|
| Route | both | **memory** |
| API calls | 4 | **2** (embed + rerank) |
| Model swaps | 3 | **1** |
| Latency | ~375ms + swap | **~130ms** |
| Tokens | ~20K | **~1K** |
| Quality | Correct but memory may rank below doc | **Better** (memory-only, no dilution) |

**Why:** "preference" keyword -> memory-only. Multiple memories may match
("TTS voice is Alice", "audio output preference"), so reranking happens.

#### Use Case 3: Document Search
**Query:** "how to deploy to k8s"

| Metric | Current | Proposed |
|--------|---------|----------|
| Route | both | **document** |
| API calls | 4 | **2** (embed + rerank) |
| Model swaps | 3 | **1** |
| Latency | ~375ms + swap | **~130ms** |
| Tokens | ~20K | **~15K** |
| Quality | Correct | Correct (same) |

**Why:** No explicit file reference but "deploy to k8s" is infrastructure
content -> heuristic routes to `document`. Reranking with bestChunks
provides accurate ranking.

#### Use Case 4: Mixed Query
**Query:** "what did we decide about VPN-Tool"

| Metric | Current | Proposed |
|--------|---------|----------|
| Route | both | **both** |
| API calls | 4 | **2** (embed + rerank) |
| Model swaps | 3 | **1** |
| Latency | ~375ms + swap | **~135ms** |
| Tokens | ~20K | **~15K** |
| Quality | Score incompatibility may misrank | **Better** (z-score calibration) |

**Why:** "we decided" could be a memory OR a document. Both sources searched.
Z-score calibration ensures memory "VPN-Tool decision: use as mesh VPN" and
document "vpn-tool-setup.md" are scored on the same scale. Single unified
rerank compares them directly.

#### Use Case 5: Temporal Query
**Query:** "what happened yesterday"

| Metric | Current | Proposed |
|--------|---------|----------|
| Route | both | **memory** (contains temporal marker) |
| API calls | 4 | **2** (embed + rerank) |
| Model swaps | 3 | **1** |
| Latency | ~375ms + swap | **~130ms** |
| Tokens | ~20K | **~1K** |
| Quality | Time decay may suppress recent | **Better** (ephemeral entries get less decay) |

**Why:** "yesterday" triggers memory-only route (temporal personal query).
Ephemeral classification ensures recent memories are not penalized. Recency
boost surfaces yesterday's entries.

#### Use Case 6: Ambiguous Query
**Query:** "memory plugin"

| Metric | Current | Proposed |
|--------|---------|----------|
| Route | both | **both** |
| API calls | 4 | **2** (embed + rerank) |
| Model swaps | 3 | **1** |
| Latency | ~375ms + swap | **~135ms** |
| Tokens | ~20K | **~15K** |
| Quality | Document chunks dilute memory results | **Better** (z-score + diversity guarantee) |

**Why:** "memory plugin" matches memex source code documents AND memories
about the plugin. Both searched; z-score calibration puts them on equal
footing; source diversity guarantee ensures both types appear in results.

#### Use Case 7: Greeting/Noise
**Query:** "hello"

| Metric | Current | Proposed |
|--------|---------|----------|
| Route | skip | **skip** |
| API calls | 0 | **0** |
| Model swaps | 0 | **0** |
| Latency | ~0.001ms | **~0.001ms** |
| Quality | Correct (no retrieval) | Correct (same) |

### Summary Table

| Metric | Current (worst) | Proposed (worst) | Proposed (average) |
|--------|----------------|-----------------|-------------------|
| API calls/query | 4 | 2 | 1.5 |
| Model swaps/query | 3-4 | 1 | 0.7 |
| Latency p50 | ~375ms + swaps | ~135ms | ~120ms |
| Latency p95 | ~500ms + swaps | ~200ms | ~180ms |
| Tokens/query | ~20K | ~15K | ~5K |
| Score calibration | None | Z-score + sigmoid | - |
| Cascade compression | Up to 82.5% | Floor at 75% | - |

---

## 8. Migration Path

### Phase 1: Unified Retrieval Function (Replaces Two Pipelines)

Create a new `UnifiedRetriever` class that replaces both `MemoryRetriever`
and `hybridQuery()` as the single retrieval entry point.

**Files to create:**
- `src/unified-retriever.ts` -- New unified pipeline (Stages 1-9)

**Files to modify:**
- `src/unified-recall.ts` -- Simplify to thin wrapper around `UnifiedRetriever`,
  or remove entirely. `UnifiedRecall.recall()` becomes a pass-through
  to `UnifiedRetriever.retrieve()`.
- `src/tools.ts` -- `memory_recall` tool calls `UnifiedRetriever` directly
  instead of going through `UnifiedRecall` -> `MemoryRetriever` +
  `hybridQuery()` independently.
- `index.ts` -- Wire up `UnifiedRetriever` during plugin init. Remove
  separate `MemoryRetriever` and `hybridQuery` setup paths.

**Files unchanged:**
- `src/memory.ts` -- `MemoryStore` data access layer unchanged
- `src/search.ts` -- Still used for `searchFTS()`, `searchVec()`,
  `chunkDocument()`, `buildFTS5Query()`. The `hybridQuery()` export
  is no longer called from the main path but remains for backward
  compatibility / CLI use.
- `src/embedder.ts` -- Unchanged, still provides `embedQuery()`
- `src/adaptive-retrieval.ts` -- Unchanged
- `src/noise-filter.ts` -- Unchanged
- `src/importance.ts` -- Unchanged
- `src/doc-indexer.ts` -- Unchanged (indexing is separate from retrieval)

### Phase 2: Z-Score Calibration

Implement `calibrate()` function and integrate into Stage 6. This is
a pure math change -- no schema or API changes.

**Files to modify:**
- `src/unified-retriever.ts` -- Add calibration logic

### Phase 3: Confidence-Gated Reranking

Implement `shouldRerank()` gate and modify reranking to accept mixed
memory + document candidates.

**Files to modify:**
- `src/unified-retriever.ts` -- Add confidence gate
- `src/retriever.ts` -- Extract rerank request building (already exported
  as `buildRerankRequest` / `parseRerankResponse`)

### Phase 4: Durability Classification

Add durability inference at query-time. No schema change initially --
classify based on existing `importance` + `category` fields.

**Files to modify:**
- `src/unified-retriever.ts` -- Add `inferDurability()` and
  durability-aware time decay

### Phase 5 (Future): Schema Migration

Add `durability` column to `memories` table and classify at store-time.

**Files to modify:**
- `src/memory.ts` -- Add `durability` column, classification at insert
- `src/tools.ts` -- `memory_store` tool sets durability based on category
  and importance

### Implementation Order

```
Phase 1: Unified retrieval function ............ ~400 LOC, 2-3 hours
  - Core pipeline with single embed + single rerank
  - Source routing
  - Drops query expansion from default path
  - All 7 use cases must pass manually

Phase 2: Z-score calibration ................... ~50 LOC, 30 min
  - calibrate() function
  - Integration test with known score distributions

Phase 3: Confidence gate ....................... ~30 LOC, 20 min
  - shouldRerank() function
  - Benchmark: measure rerank skip rate

Phase 4: Durability classification ............. ~40 LOC, 30 min
  - inferDurability() query-time heuristic
  - Test with preference vs ephemeral memories

Phase 5: Schema migration (future) ............ ~60 LOC, 1 hour
  - ALTER TABLE, store-time classification
  - Migration for existing entries
```

### Test Strategy

The existing 226 tests continue to pass because:
- `MemoryStore` data access layer is unchanged
- `MemoryRetriever` remains functional (not deleted, just no longer
  the primary path)
- `hybridQuery()` remains exported for CLI/backward compat

New tests needed:
- `unified-retriever.test.ts` -- Unit tests for each stage
- Extend `benchmark.ts` -- Add unified pipeline latency measurements
- Manual assessment on 7 use cases with production database

### Rollback Plan

`UnifiedRetriever` is a new class alongside the existing pipelines.
If quality regressions are detected:

1. In `index.ts`, switch back to wiring `MemoryRetriever` + `hybridQuery`
   through `UnifiedRecall` (the current architecture)
2. No data migration needed -- the SQLite schema is unchanged

---

## 9. Open Questions

### Q1: Should query expansion be eliminated entirely?

**Current thinking:** Yes, for the default path. Section-level FTS
(`sections_fts` with 13,326 entries) provides equivalent recall for
most queries. The ~200ms + model swap cost is not justified.

**Risk:** Some complex queries ("how do we handle auth token rotation
across microservices") may benefit from HyDE expansion. Monitor recall
quality after deployment; add expansion as opt-in fallback if needed.

### Q2: What about recency boost?

The current pipeline applies an additive recency boost (+0.10 max) in
`retriever.ts:601-619`. This should be preserved in the unified pipeline
as a post-merge modifier on memory entries. It is additive (not
multiplicative) and small, so it does not suffer from cascade compression.

**Placement:** After Stage 8b (importance + length norm), before Stage 8c
(floor guarantee). The recency boost value is small enough that it should
not trigger the floor guarantee.

### Q3: Should the source weights be query-dependent?

Fixed weights (0.55 memory / 0.45 document) are a reasonable default.
Query-dependent weights (e.g., temporal queries weight memories higher,
technical queries weight documents higher) would improve quality but
add complexity.

**Decision:** Start with fixed weights. If assessment shows specific
query types are misranked, add query-dependent weight adjustment as a
Phase 5+ enhancement.

### Q4: How to handle the `document_search` tool?

The `document_search` tool (`tools.ts:688-743`) currently routes through
`UnifiedRecall` with `sources: ["document"]`. In the new architecture,
this becomes `UnifiedRetriever.retrieve({ sources: ["document"] })`,
which forces the route to `document` regardless of the query classifier.

No behavioral change for the user.

### Q5: MMR diversity and recently-recalled penalty?

Both currently live in `retriever.ts` and apply only to memory results.
In the unified pipeline, they should apply to the final merged pool
(after Stage 9) so that near-duplicate document chunks are also
deduplicated against similar memory entries.

**Change:** Move MMR diversity and recently-recalled penalty to after
Stage 8c (floor guarantee), before final top-k selection.

---

## Appendix A: Token Budget Per Use Case

| Use Case | Embed Tokens | Rerank Tokens | Expand Tokens | Total |
|----------|-------------|---------------|---------------|-------|
| Factoid (memory-only, gate skip) | 20 | 0 | 0 | **20** |
| Preference (memory-only, reranked) | 20 | ~1K | 0 | **~1K** |
| Doc search (doc-only, reranked) | 20 | ~15K | 0 | **~15K** |
| Mixed (both, reranked) | 20 | ~15K | 0 | **~15K** |
| Temporal (memory-only, reranked) | 20 | ~1K | 0 | **~1K** |
| Ambiguous (both, reranked) | 20 | ~15K | 0 | **~15K** |
| Greeting (skipped) | 0 | 0 | 0 | **0** |
| **Average (weighted)** | | | | **~5K** |

Compared to current average of ~20K tokens/query, this is a **75% reduction**.

## Appendix B: Latency Budget Per Use Case

| Use Case | Embed | Vec Search | FTS | Calibrate | Rerank | Post-Mod | Total |
|----------|-------|-----------|-----|-----------|--------|----------|-------|
| Factoid | 75ms | 4ms | <1ms | <1ms | 0ms | <1ms | **~80ms** |
| Preference | 75ms | 4ms | <1ms | <1ms | 50ms | <1ms | **~130ms** |
| Doc search | 75ms | 3ms | <1ms | <1ms | 50ms | 0ms | **~130ms** |
| Mixed | 75ms | 7ms | <1ms | <1ms | 50ms | <1ms | **~135ms** |
| Temporal | 75ms | 4ms | <1ms | <1ms | 50ms | <1ms | **~130ms** |
| Ambiguous | 75ms | 7ms | <1ms | <1ms | 50ms | <1ms | **~135ms** |
| Greeting | 0ms | 0ms | 0ms | 0ms | 0ms | 0ms | **~0ms** |

Notes:
- Embed latency assumes warm cache miss. With >97% cache hit rate,
  average embed cost is <5ms.
- Latencies do NOT include model swap penalty. With the proposed
  sequencing, swap penalty is 0-5s on cold start, 0ms on warm path.
- All FTS and SQLite operations are local and sub-millisecond.

## Appendix C: Recency Boost Placement

The additive recency boost is preserved and placed after importance/length
normalization but before the floor guarantee:

```
Stage 8a: Time decay        score *= T(r)
Stage 8b: Importance        score *= I(r)
Stage 8b: Length norm        score *= L(r)
Stage 8d: Recency boost     score += exp(-age/14) * 0.10    [additive, memories only]
Stage 8c: Floor guarantee   score = max(score, 0.25 * C(r))
```

The recency boost is additive (+0.10 max) and cannot push a result above
its calibrated relevance by more than 10%. It serves to break ties among
similarly-relevant results in favor of more recent entries.

---

## Addendum: Async Query Expansion

### Rationale

Query expansion should be kept because:
- Users may have vague/imprecise memory of stored facts
- Typos and alternative phrasings are common in recall queries
- The 4B embedding model helps but can't cover all vocabulary gaps
- Natural language questions ("what embedding model do we use") need term extraction

### Strategy: Non-blocking Async Enrichment

Query expansion runs **in parallel** with the initial retrieval pass, not sequentially:

```
Query arrives
  │
  ├─ [async] Embed query                  ← ~75ms
  ├─ [async] Query expansion (LLM)        ← ~200ms, fires immediately
  │
  ├─ Wait for embedding (75ms)
  ├─ Run retrieval with original query     ← ~7ms
  │
  ├─ If expansion returned by now:
  │     Embed expanded terms
  │     Run additional vector search
  │     Merge into candidate pool
  │
  ├─ If expansion still pending:
  │     Continue with original results only
  │     (don't block on expansion)
  │
  └─ Continue to rerank + score
```

### Model Swap Consideration

The generation model (Qwen3.5-4B) and embedding model (Qwen3-Embedding-4B) conflict on llama-swap. Two strategies:

**Option A: Same-model expansion** — Use the embedding model's instruction mode for expansion instead of a separate generation model. Qwen3-Embedding supports instruction-following. This avoids the model swap entirely.

**Option B: Race with timeout** — Fire expansion request immediately. If llama-swap needs to swap models, the 200ms budget won't be enough and it silently fails. That's fine — expansion is optional. On subsequent queries, the generation model may already be loaded.

**Option C: Cached expansion** — Cache expanded queries by original query hash. Repeated or similar queries hit the cache. LRU with 256 entries × 30min TTL (same as embedding cache).

### Cost Budget

| Scenario | API Calls | Extra Latency | Extra Tokens |
|---|---|---|---|
| Expansion returns in time | +1 embed | +0ms (parallel) | ~500 gen + ~20 embed |
| Expansion too slow (skipped) | +0 | +0ms | ~500 gen (wasted) |
| Cache hit | +0 | +0ms | 0 |

Average impact: **+0.7 API calls, +0ms latency** (fully async), **+350 tokens**

### When to Skip Expansion

- Query is a single proper noun ("VPN-Tool", "Alice") — already specific
- Query has >5 terms — already detailed enough
- Source routing classified as greeting/noise — skip everything
- Previous identical query in cache — use cached expansion

### Update: Gemini Flash for Query Expansion (validated)

Tested Gemini 2.5 Flash with `reasoning_effort: "none"` for query expansion:

| Query | Expansion | Tokens | Latency |
|---|---|---|---|
| ban sorry apologize | prohibit forbid disallow restrict bar | 43 | 578ms |
| TTS voice Alice | text-to-speech, synthetic voice, AI voice | 75 | 732ms |
| vault secret expiry | expiration TTL time-to-live lifetime | 42 | 609ms |

**Decision:** Use Gemini Flash (the configured generation model) for async query expansion.
- Runs in parallel with embedding + initial retrieval
- No local model swap (cloud API, independent of llama-swap)
- ~40 tokens per query (negligible cost)
- ~600ms latency but non-blocking (merge if ready, skip if not)
- Quality is excellent — provides exactly the synonyms BM25 needs

Local model expansion was tested and rejected:
- Qwen3-Embedding-4B: generates garbage (not an instruction model)
- Qwen3.5-4B-Q8_0: 2000ms + model swap penalty, repetitive output

**Updated pipeline timing:**

```
t=0ms    Fire Gemini expansion (async)
t=0ms    Fire embedding request
t=75ms   Embedding returns → run BM25 + vector search (7ms)
t=82ms   Initial candidates ready
t=600ms  If expansion returned: embed expanded terms, add to candidates
t=82ms   Proceed to rerank (don't wait for expansion)
t=132ms  Rerank done → final scoring → return
```

Effective latency: ~132ms (expansion enriches results but doesn't block)

### Update: Query Expansion is Optional (disabled by default)

Query expansion adds marginal value when the caller is an LLM agent that already forms good queries. None of the issue #7 failures were vocabulary mismatch problems — they were ranking/fusion bugs, extraction gaps, or embedding quality issues.

**Config:**
```json
{
  "retrieval": {
    "queryExpansion": false
  }
}
```

When enabled, uses the configured generation model (Gemini Flash) for async non-blocking expansion. When disabled (default), skips the expansion call entirely — zero cost.
