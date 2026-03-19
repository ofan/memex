# Resiliency Guide

How memex protects data integrity across crashes, model changes, and interrupted operations.

## Data Stores

Single SQLite database with WAL mode. Four data layers per memory:

| Layer | Table | Sync mechanism |
|---|---|---|
| Text | `memories` | Source of truth |
| FTS | `memories_fts` | SQL triggers (INSERT/UPDATE/DELETE) |
| Vectors | `vectors_vec` | Explicit in store code |
| Mapping | `memory_vectors` | CASCADE on delete |

Same pattern for documents: `documents` → `documents_fts` / `sections_fts` / `vectors_vec` / `content_vectors`.

## CRUD Integrity

### Store (insert)

```
INSERT memories → trigger populates memories_fts
INSERT vectors_vec (mem_<id>)
INSERT memory_vectors
```

All three writes in the same synchronous call. If the process crashes mid-call, SQLite WAL ensures either all writes commit or none do (autocommit per statement, but the `store()` method executes sequentially within a single connection).

### Update

```
UPDATE memories.text → trigger updates memories_fts
DELETE + INSERT vectors_vec (if text changed, caller provides new vector)
```

The tools layer (`memory_update` tool) re-embeds text before calling `store.update()`, so vector always matches current text.

### Delete

```
DELETE memories → trigger deletes from memories_fts
                → CASCADE deletes from memory_vectors
DELETE vectors_vec (explicit, virtual tables don't CASCADE)
```

No orphan vectors possible through the API. Direct SQL manipulation bypasses these guarantees.

### Bulk Delete

Same as delete but iterates IDs. Vectors cleaned up in a loop after the bulk delete.

## Embedding Model Changes

### Detection

`store_meta` table tracks:
- `embedding_model`: model name of the last COMPLETED embedding run
- `embedding_target`: model name of an IN-PROGRESS re-embed (set before starting, cleared after completion)

### Startup Logic

```
target = store_meta.embedding_target
model  = store_meta.embedding_model
config = current embedding config model name

if target exists:
  if target == config:
    interrupted re-embed to current model → re-embed all
  else:
    interrupted re-embed to different model → re-embed all to config

else if model != config:
  model changed → warn user, prompt to re-embed

else:
  consistent → do nothing
```

### Re-embed Flow

```
1. SET embedding_target = new_model        ← marks intent
2. For each batch of 100 memories:
     BEGIN TRANSACTION
       DELETE old vectors for batch
       INSERT new vectors for batch
     COMMIT
3. SET embedding_model = new_model         ← marks completion
4. DELETE embedding_target                 ← clean up
```

### Failure Modes

| Crash point | State after | Next startup | Data state |
|---|---|---|---|
| Before step 1 | model=A, no target | Detects config change, warns | All vectors model A ✓ |
| After step 1, before batches | model=A, target=B | Detects interrupted, re-embeds all | All vectors model A ✓ |
| Mid-batch (batch 50/200) | model=A, target=B | Detects interrupted, re-embeds all | Mixed A+B, overwritten on retry ✓ |
| After all batches, before step 3 | model=A, target=B | Detects interrupted, re-embeds all (redundant but safe) | All vectors model B ✓ |
| After step 3, before step 4 | model=B, target=B | Cleans up target | All vectors model B ✓ |
| Complete | model=B, no target | Consistent | All vectors model B ✓ |

### Switch Back After Interrupted Re-embed

Config=A, model=A, target=B (interrupted A→B re-embed, user switched back to A).

Target exists and target≠config → re-embeds everything to config (A). Mixed A+B vectors all become A. Safe.

### Dimension Mismatch Protection

Before starting re-embed:
1. Test-embed one string with new model
2. Check dimensions match `vectors_vec` table schema
3. If mismatch: abort with clear error, don't touch any data

### User Notification

Model mismatch is surfaced to the user via context injection (not just logs):

```xml
<system-warning>
Memory embedding model mismatch. Memories were embedded with "model-A"
but current model is "model-B". Recall quality may be degraded.
Run: openclaw memex rebuild
</system-warning>
```

Warning auto-clears once re-embed completes successfully.

## Session Import

### Extraction

LLM extracts memories from session transcripts. The extraction is idempotent:
- `--fresh` flag deletes all session-imported memories before re-importing
- Without `--fresh`, already-imported sessions are skipped (tracked by session ID)
- Deduplication: cosine similarity >0.95 against existing store → skip

### Interrupted Import

If import crashes mid-way:
- Memories already stored are committed (per-batch transactions)
- Session registry tracks which sessions were processed
- Re-running without `--fresh` picks up where it left off
- Re-running with `--fresh` starts clean

## Document Indexing

### FTS Sync

Whole-doc FTS uses SQL triggers (automatic). Section-level FTS is managed by JS code:
- `populateSectionsFTS()` called after document insert/update
- `removeSectionsFTS()` called before document deactivation
- Backfill runs on startup if `document_sections` is empty but documents exist

### Vector Sync

Document vectors are managed separately via `content_vectors` table which tracks the embedding model per vector. Documents needing re-embedding are detected by comparing `content_vectors.model` against current config.

## SQLite Guarantees

- **WAL mode**: readers never block writers, crash recovery via write-ahead log
- **Foreign keys ON**: CASCADE deletes enforce referential integrity
- **Single connection**: MemoryStore and search store share one `Database` instance, avoiding write contention
- **Autocommit**: each statement is atomic unless wrapped in explicit transaction

## Manual Recovery

If data is suspected corrupt:

```bash
# Check integrity
sqlite3 memex.sqlite "PRAGMA integrity_check"

# Rebuild everything (re-embed memories + re-index docs + clean noise)
openclaw memex rebuild

# Re-import sessions from scratch
openclaw memex import --fresh --llm-extract

# Nuclear: delete database and start over
rm memex.sqlite
# Restart gateway (recreates tables, re-indexes documents)
# Then: openclaw memex import --llm-extract
```

## Unified Retriever Pipeline

The `UnifiedRetriever` (src/unified-retriever.ts) replaces the dual-pipeline architecture. It searches both memories and documents in a single pass.

### Failure modes

| Stage | Failure | Impact | Recovery |
|---|---|---|---|
| Embed query | API timeout | No vector search | BM25-only results (degraded but functional) |
| Memory search | SQLite error | No memory results | Document results only |
| Document search | SQLite error | No doc results | Memory results only |
| Reranking | API timeout (10s) | Skip reranking | Calibrated scores pass through (slightly lower quality) |
| Reranking | Model swap timeout | Same as above | Same — confidence gate may skip future reranks |

### Confidence gate

The reranker is skipped when:
- Top result score > 0.88 (high confidence)
- Gap between top-1 and top-2 > 0.15 (dominant result)
- Pool has ≤ 1 candidate

This reduces model swap frequency and latency for ~25-30% of queries.

### Source diversity guarantee

The top result from each active source is protected from minScore filtering. Both conversation memories and documents appear in results when both sources have matches.

## Lazy DB Initialization

The database opens lazily on first use, not at plugin registration. This prevents `openclaw --help` and other non-memex commands from holding sqlite handles that keep the Node event loop alive.

- `openclaw --help` → register() runs, no DB opened → exits cleanly
- `openclaw memex search` → DB opens on first query → runs → postAction closes DB → exits
- `openclaw gateway` → DB opens on first hook/recall → stays open for process lifetime
