# Memex Flow

## Per-Turn Pipeline

```
                          USER MESSAGE
                               │
                               ▼
                    ┌─────────────────────┐
                    │  before_prompt_build │  0ms
                    │                     │
                    │  Inject instruction: │
                    │  "store important    │
                    │   facts immediately" │
                    └──────────┬──────────┘
                               │
              ┌────────────────┴────────────────┐
              │  autoRecall: true? (default: no) │
              └────────────────┬────────────────┘
                          yes  │  no → skip
                               ▼
                    ┌─────────────────────┐
                    │  Embed query  130ms  │
                    │  Vec search    4ms   │
                    │  BM25 search   1ms   │
                    │  Fuse + rank   5ms   │
                    │  Inject context      │
                    └──────────┬──────────┘
                               │  ~150ms
                               ▼
            ┌──────────────────────────────────────┐
            │              LLM THINKS              │
            │                                      │
            │  Has tools:                          │
            │    memory_recall  ── search memories │
            │    memory_store   ── save new fact   │
            │    memory_forget  ── delete          │
            │                                      │
            │  System prompt says:                 │
            │  "did user reveal a fact? store it"  │
            └──────────────────┬───────────────────┘
                               │
                               ▼
                     RESPONSE TO USER
                               │
              ┌────────────────┴────────────────┐
              │ autoCapture: true? (default: no) │
              └────────────────┬────────────────┘
                          yes  │  no → done
                               ▼
                    ┌─────────────────────┐
                    │  (fire-and-forget)  │
                    │  Sliding window     │
                    │  Filter + embed     │
                    │  Dedup + store      │
                    └─────────────────────┘
                          ~834ms async
```

## memory_store (LLM-driven)

```
  LLM calls memory_store("User prefers dark mode", 0.8, "preference")
                               │
                               ▼
                     noise filter → skip junk
                               │
                               ▼
                  ┌────────────┴────────────┐
                  │  text ≤ 1500 chars?     │
                  ├─── yes ─────┬─── no ────┤
                  │             │            │
                  ▼             │            ▼
          embed(text)           │    chunkDocument(text)
            130ms               │    embedBatch(chunks)
                  │             │         800ms
                  ▼             │            ▼
              dedup check       │       dedup check
              (cosine>0.98)     │       (cosine>0.98)
                  │             │            │
                  ▼             │            ▼
              store()           │    storeWithChunks()
               15ms             │         15ms
                  │             │            │
                  └─────────────┴────────────┘
                               │
                               ▼
                  SQLite: memories + vectors_vec
                  Key: mem_{id} [+ mem_{id}_c1, _c2, ...]
```

## memory_recall / Unified Retriever

```
  LLM calls memory_recall("What keyboard do they use?")
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Embed query  130ms  │
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │     PARALLEL        │
              ┌─────┴─────┐        ┌─────┴─────┐
              │  MEMORIES  │        │   DOCS    │
              │            │        │           │
              │ vec  ~4ms  │        │ FTS  <1ms │
              │ BM25 <1ms  │        │ vec  ~3ms │
              └─────┬─────┘        └─────┬─────┘
                    │                    │
                    ▼                    ▼
              ┌──────────────────────────────┐
              │  Z-score fusion (0.8v+0.2b)  │
              │  Cross-source calibration    │
              │  Reranker (optional, ~50ms)  │
              │  Time decay + importance     │
              │  Source diversity guarantee  │
              └──────────────┬───────────────┘
                             │
                             ▼
                     Top-K results
                     Total: ~150ms
```

## vectorSearch: Max-Sim Aggregation

```
  Query vector
       │
       ▼
  sqlite-vec MATCH (top 200 nearest)
       │
       ▼
  ┌─────────────────────────────────────┐
  │  mem_abc         dist=0.3          │
  │  mem_abc_c1      dist=0.8          │  → max-sim: take 0.3
  │  mem_abc_c2      dist=0.1  ← best │  → max-sim: take 0.1 ✓
  │  mem_xyz         dist=0.5          │  → single vec: 0.5
  └─────────────────────────────────────┘
       │
       ▼
  Group by memory ID, keep best (lowest) distance
  Score = 1/(1+distance)
```

## Default Config (what's active)

```
  ✅ Memory instruction   ─── injected every turn (0ms)
  ✅ Tools                 ─── always available to LLM
  ✅ Auto-recall           ─── on by default (~150ms)
  ❌ Auto-capture          ─── off (opt-in: autoCapture: true)
  ✅ Doc indexer            ─── background, every 30min
```

**Zero added latency per turn by default.** LLM decides when to recall/store via tools.
