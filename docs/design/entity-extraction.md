# Entity Extraction — Design Doc

**Status: Implemented (v0.7.0).** `src/entities.ts`, `src/graph.ts`, and the retriever wiring all exist. Entity boost (`entityBoost`) defaults to **off** — BM25 already captures entity-keyword overlap, and enabling it regresses domain eval (73-75% vs 80% without). The graph traversal path (`entityGraph`) is also off by default (zero measured quality impact on the current 26-query domain eval).

## Problem

Memex retrieval uses 2 signals: vector similarity + BM25 keywords. Hindsight (91.4%) uses 4 signals including entity graph traversal. The gap is primarily from entity-aware retrieval — when you ask "What's Alex's rule for host-a?", memex relies on vector closeness. Entity overlap as a discrete signal directly boosts memories mentioning the same entities.

This implements ACT-R spreading activation — a 40-year validated cognitive model.

## Approach

### Store-time: Extract entities

On every `store()` and `bulkStore()`, extract named entities using `compromise` (250KB, rule-based NLP). Also extract capitalized multi-word terms (proper nouns compromise may miss, like "host-a", "Qwen3.5").

Stored in `metadata.entities` as JSON array. Existing metadata preserved.

### Query-time: Extract + boost

After vector+BM25 fusion, apply entity overlap boost:

```
boost = 1 + (overlap_count / query_entity_count) * ENTITY_BOOST_WEIGHT
```

`ENTITY_BOOST_WEIGHT` starts at 0.15 (ACT-R formula). Tunable.

### Pipeline position

```
Query → Embed → Vector+BM25 (parallel) → Fuse → (ENTITY BOOST, off by default) → Rerank → Score → Top-K
```

After fusion, before scoring pipeline. Doesn't change z-score math.
Entity boost is gated behind `entityBoost: true` in `RetrievalConfig`. Default is off — BM25 already captures entity-keyword overlap, and enabling it regresses domain eval.

### Backfill

On startup, extract entities for entries missing `metadata.entities`. Idempotent.

## Trade-offs

| Choice | Alternative | Why |
|---|---|---|
| compromise | wink-nlp, Transformers.js | 250KB, no native deps, 0.1ms/call |
| Boost after fusion | 3-way z-score fusion | Simpler, doesn't change fusion |
| Entities in metadata JSON | Separate table | No schema change |
| Regex for proper nouns | NER only | Catches technical terms |

## Failure Modes

| Failure | Mitigation |
|---|---|
| compromise can't install | Graceful fallback — no boost |
| Bad entity extraction | Entities lowercase + deduped. Worst case: overlap=0 |
| Too many entities | Cap at 10 per entry |
| Weight too high/low | Start 0.15, tune with benchmark |

## API

```typescript
// src/entities.ts
extractEntities(text: string): string[]
entityOverlap(a: string[], b: string[]): number
```

## Data Model

No schema changes. Entities in existing metadata JSON:
```json
{ "source": "agent", "agentId": "main", "entities": ["alex", "host-a"] }
```

## Files

| File | Change |
|---|---|
| `src/entities.ts` | Implemented |
| `src/memory.ts` | Wired into store/bulkStore |
| `src/retriever.ts` | applyEntityBoost() (gated behind `entityBoost` config, off by default) |
| `src/graph.ts` | Entity graph (link creation + one-hop expansion, off by default) |
| `src/dreaming.ts` | Eviction threshold |
| `index.ts` | agentId passthrough |
