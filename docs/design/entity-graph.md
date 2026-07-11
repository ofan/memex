# Entity Graph — Design Doc

**Status: Implemented (v0.7.0).** `src/graph.ts` exists with `createLinks()`, `expandOneHop()`, `deleteLinks()`. Wired into `src/memory.ts` (store-time link creation) and `src/retriever.ts` (retrieval-time one-hop expansion). However, `entityGraph` defaults to **off** — measured zero quality impact on the current 26-query domain eval (BM25 + rerank already capture the same signal). Domain eval baseline is 69% (no rerank), 77% (cross-encoder), 85% (LLM reranker) on Wilson CI; graph expansion does not improve these.

## Problem

Entity boost as a score multiplier doesn't work — BM25 already captures keyword entity matching. Tuning showed it hurts ranking (80% without boost vs 73% with).

Hindsight's actual advantage is **graph traversal** — following entity relationships to find connected memories, not just boosting by keyword overlap. When you ask "Why did Jordan switch from Gemma to Qwen?", traversal finds: Jordan → deployed_on → host-a → also_ran → Gemma 4 → crashed → switched_to → Qwen3.5.

## Approach

Lightweight entity graph in SQLite. No Neo4j, no graph DB. Just an adjacency table + one-hop expansion at retrieval.

### Store-time: Create links

When storing a new memory, find existing memories sharing ≥2 entities. Insert bidirectional links:

```sql
CREATE TABLE memory_links (
  source_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
  shared_entities TEXT,  -- JSON array of shared entity names
  created_at INTEGER,
  PRIMARY KEY (source_id, target_id)
);
```

No typed relations (would need LLM). Just `related` via shared entities.

### Retrieval-time: One-hop expansion

After vector+BM25 fusion returns top-5:
1. Collect IDs of top-5 results
2. Query `memory_links` for linked memories (one hop)
3. Add linked memories as bonus candidates with discounted score (0.7× linking memory's score)
4. Re-sort by score, apply rest of scoring pipeline

### Why this should work

The 3 misses from domain eval:
- "What model is running on host-a?" — correct memory shares entities with top result via links
- "Why did Jordan switch?" — crash memory linked to switch memory via shared entities
- "What should Cabbie stop doing?" — "Do not explain. Fix." linked to "leaves tasks unfinished" via shared Alex+Cabbie entities

Graph traversal surfaces the *related but different* memory that keyword matching alone misses.

## Trade-offs

| Choice | Alternative | Why |
|---|---|---|
| Untyped links (`related`) | Typed (`deploys_on`, `crashed`) | No LLM needed, entity overlap is sufficient signal |
| ≥2 shared entities threshold | ≥1 entity | Reduces noise — single entity overlap too broad |
| One hop | Two hops | Keep it simple, avoid noise explosion |
| 0.7× score discount | Fixed bonus | Scales with linking memory's relevance |
| Bidirectional links | Directional | Simpler, memory links are symmetric |

## Failure Modes

| Failure | Impact | Mitigation |
|---|---|---|
| Too many links (dense graph) | Slow retrieval | Cap at 10 links per memory |
| Irrelevant linked memories | Noise in results | 0.7× discount + scoring pipeline filters |
| Schema migration on existing DB | Startup delay | New table, no ALTER — instant |
| Orphaned links after memory deletion | Dead links | ON DELETE CASCADE handles it |

## Open Questions

1. Should graph expansion only run for `memory_recall` tool, or also for auto-recall? Auto-recall is latency-sensitive (~150ms budget).
   **Resolved: off by default for both.** Measured zero quality impact on domain eval — BM25 + rerank already capture the signal.
2. Should dreaming maintain links (relink after dedup/eviction)?
3. Cap on links per memory — 10? 20?
   **Resolved: 10** (MAX_LINKS_PER_MEMORY in src/graph.ts).

## Metrics

| Metric | Baseline (no graph) | Target |
|---|---|---|
| Domain eval | 18/26 (69%, Wilson CI) | N/A — graph off by default |
| Multi-entity queries | 2/3 (67%, old 15-query set) | N/A |
| LongMemEval R@3 | 90% | ≥90% (no regression) |
| Retrieval latency | ~150ms | <200ms (one-hop adds ~10ms) |

Note: domain eval expanded from 15 to 26 queries (2026-07-02). The original 12/15 (80%) metric was measured before the query set expansion. Graph expansion is disabled by default — BM25 + rerank already capture the same entity-overlap signal.

## Files

| File | Change |
|---|---|
| `src/graph.ts` | Implemented — createLinks(), expandByLinks() |
| `src/memory.ts` | Links table created, createLinks called on store |
| `src/retriever.ts` | expandByLinks after fusion (gated behind `entityGraph` config, off by default) |
| `tests/acceptance-entity-graph.test.ts` | Acceptance tests |
| `tests/graph.test.ts` | Unit tests |
