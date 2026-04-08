# Dreaming Implementation Progress

**Plan**: `docs/plans/012-memex-dreaming.md`
**Started**: 2026-04-08
**Branch**: master

## Completed

### Step 1: Intake Guards ✅ `041c7f4`
- Text hash dedup (SHA-256, UNIQUE index, rejects exact duplicates on store/bulkStore)
- Conversation fragment rejection (single-turn `[user]`/`[assistant]` prefix blocked, multi-turn windows allowed)
- Schema migration: `text_hash`, `recall_count`, `last_recalled_at` columns added
- 15 tests in `tests/intake-guards.test.ts`

### Step 2: Schema Migration ✅ (done in step 1)
- `text_hash TEXT` + unique index
- `recall_count INTEGER DEFAULT 0`
- `last_recalled_at INTEGER`
- Idempotent via `migrateAddColumn()`

### Step 3: Recall Tracking ✅ `ea4f94e`
- `MemoryStore.recordRecalls(ids)` persists to DB
- Wired into auto-recall in `index.ts` (after every injection)
- Survives gateway restarts (was ephemeral in-memory Map)
- 4 tests added to `tests/intake-guards.test.ts`

### Step 4: Light Sweep ✅ `6e89e36`
- Exact text dedup (group by text, keep newest timestamp)
- Conversation fragment purge (single-turn `[user]`/`[assistant]`)
- Noise scan (`isNoise()` on all existing entries)
- Writes to plain text log file
- 5 tests in `tests/dreaming.test.ts`

### Step 5: Deep Sweep ✅ `6e89e36`
- Recall-based re-scoring: recalled 5+ → importance ≥0.7, recalled 1-4 → ≥0.5
- Age-based decay: never-recalled >30d → ≤0.3, >90d → ≤0.1
- Ephemeral pattern decay: "was committed/pushed/deleted" + >30d + importance <0.5 → 0.1
- Idempotent, no LLM needed
- 6 tests in `tests/dreaming.test.ts`

### Step 6: Dream Cycle Orchestrator ✅ `1b1b386`
- `runDreamCycle()` runs light → deep sequentially
- Each phase independent (if one fails, next runs)
- Fires `track("dream")` and `track("dream_metrics")` per phase
- Checks for recent backup before proceeding
- Writes `[dream:cycle]` summary to log
- 5 orchestrator tests in `tests/dreaming.test.ts` (total: 16)

## In Progress

### Step 7: Wire into Gateway + CLI ✅ `60d9151`
- Dream cycle timer: 5 min after startup, then daily
- Config: `dreaming.enabled` (default true), `dreaming.phases`
- CLI: `memex log [--type dream] [-n 50]`, `memex dream [--dry-run]`

### Step 9: Backfill ✅ `41e7f34`
- Computes SHA-256 text_hash for all existing entries with NULL hash on startup
- Idempotent — only touches NULLs
- Creates unique index after backfill

## Remaining

| Step | Description | Effort |
|---|---|---|
| 7 | CLI (`memex log`, `dream --dry-run`, `dream --now`) | Small |
| 8 | Reflection (LLM-driven learnings via subagent) | Large |
| 9 | Backfill (hash existing entries, run initial sweep) | Small |
| 10 | Telemetry (dream/dream_metrics/dream_cost events, OpenPanel) | Small |

## Also Done This Session (pre-dreaming)

| Commit | Description |
|---|---|
| `acbcd60` | Fix 5x hook registration + unified telemetry timing |
| `d12e0d9` | Fix #26: doc indexer context overflow via Embedder |
| `8f4156b` | Docs: LongMemEval is memory-only (#17, #18) |
| `c3353be` | Release v0.5.12 |

## Test Coverage

595 tests, all passing.

## Live Deployment Results

First dream cycle on production DB (2,137 entries):
- **10 duplicates removed** (text-level dedup)
- **3 noise entries removed** (greetings, fillers)
- **21 conversation fragments removed** (single-turn `[user]`/`[assistant]`)
- **Pool: 2,137 → 2,103** (34 entries cleaned)
- **Duration: 108ms**
- **Second run: 0 changes, 29ms** (idempotent)

Note: discovered Node 25.8.1→25.9.0 upgrade wiped global npm modules, causing gateway crash loop (unrelated to memex). Fixed by reinstalling openclaw globally.

Key new test files:
- `tests/intake-guards.test.ts` — 19 tests (dedup, fragments, schema, recall tracking)
- `tests/registration.test.ts` — 1 test (5x registration idempotency)
- `tests/telemetry.test.ts` — 5 tests (Stopwatch)
- `tests/instrumentation.test.ts` — 7 tests (retriever timings, tool track payloads)
- `tests/doc-indexer-overflow.test.ts` — 10 tests (context overflow handling)

## Open Issues

| # | Status |
|---|---|
| 26 | ✅ Closed (v0.5.12) |
| 23 | Open — debug recall mode (partially addressed by unified log in dreaming plan) |
| 20 | ✅ Closed (v0.5.12) |
| 19 | Open — BEIR benchmark (backlog) |
| 18 | ✅ Closed (v0.5.12) |
| 17 | ✅ Closed (v0.5.12) |
| 27 | Open — memory browser (backlog) |

## Key Design Decisions

1. **Learnings are first-class knowledge** — `category: "learning"`, high importance (0.85), correction chains (supersedes + demotion)
2. **No extra DB tables for logs** — plain text `memex.log` file, 5MB rotation
3. **All telemetry through `track()`** — dream events in OpenPanel alongside recall/store
4. **Idempotent operations** — no checkpoint state, safe to re-run after crash
5. **Recovery via existing JSONL backup** — no changelog, no soft-delete
6. **Reflection uses OpenClaw subagent** — no separate LLM config needed
