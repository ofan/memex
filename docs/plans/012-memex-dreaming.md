# Memex Dreaming — Memory Consolidation System

## Context

Memex has 2,137 memories. 76% are low-quality session imports (importance 0.3), 7% are raw conversation fragments (`[assistant]`/`[user]` prefixed), and there are exact duplicates (one message stored 7x). The 5.5% of high-quality agent-stored memories compete with this noise in vector search.

The root cause is multi-layered:
1. **Intake**: Session import bypasses the noise filter and stores raw dialogue
2. **Dedup**: Only vector similarity (0.98 threshold) — no text hash dedup
3. **No eviction**: Ephemeral action logs persist forever
4. **No consolidation**: Near-duplicate entries never get merged

The fix is not a one-time cleanup but a system that continuously maintains memory quality — preventing garbage from entering, deduplicating on write, and periodically consolidating old entries.

Inspired by OpenClaw's dreaming framework (light/deep/REM phases) but built natively for memex's SQLite+vector architecture.

## Design Decisions (from user interview)

| Decision | Choice | Rationale |
|---|---|---|
| LLM dependency | Summarization skips when no generation LLM | Light + deep work without LLM. Most value is dedup + noise removal. |
| Scope | All memories equally | Source-agnostic. Agent-stored entries can be deduped/merged too. |
| Recovery | Existing daily JSONL backup | No extra changelog. Backup runs before dream cycle. |
| Scheduling | Cron-style, configurable | Default: daily 3am. Uses OpenClaw cron or internal scheduler. |
| Observability | Log line + CLI command | `memex dream-log` for details. |
| Crash recovery | Idempotent operations | No checkpoint. Each operation is safe to re-run. |

---

## Architecture

### Two systems, one goal

**A. Intake guards** — prevent garbage from entering (runs at write time)
**B. Dream cycle** — clean up what's already stored (runs on schedule)

### A. Intake Guards (write-time)

Applied to every `store()` and `bulkStore()` call. Zero-config, always on.

#### A1. Text hash dedup

Before embedding, hash the text (SHA-256) and check if it already exists:

```
memories table: add column text_hash TEXT
CREATE UNIQUE INDEX idx_memories_text_hash ON memories(text_hash)
```

On `INSERT`, if `text_hash` collides, skip silently. This catches:
- Session import re-running on the same sessions
- LLM calling `memory_store` with identical text
- Cost: O(1) index lookup. No embedding call wasted.

#### A2. Conversation fragment rejection

Reject entries starting with `[user]` or `[assistant]` — these are raw dialogue, not distilled knowledge. Applied in `store()` and `bulkStore()`:

```typescript
if (/^\[(user|assistant)\]/i.test(text)) {
  return null; // reject silently
}
```

#### A3. Noise filter on session import

The `isNoise()` filter already exists but session-indexer bypasses it. Wire it in:

```
session-indexer.ts line 886: before bulkStore, filter each entry through isNoise()
```

#### A4. Embedding similarity vs source (session import only)

When session-import extracts knowledge from a conversation turn, compare the extraction's embedding against the source turn's embedding. If cosine similarity > 0.95, the LLM just copied the text instead of distilling — reject it.

### B. Dream Cycle (background)

Three phases, run sequentially on a configurable cron schedule.

#### B1. Light Sweep (always runs, no LLM needed)

**What**: Mechanical cleanup — dedup, noise removal, fragment rejection.
**When**: Every dream cycle (default: daily 3am).
**Cost**: Pure DB operations + optional embedding calls for similarity dedup.

Operations (all idempotent):

1. **Exact dedup**: Group by `text_hash`, keep newest, delete rest.
2. **Conversation fragment purge**: Delete entries matching `^\[(user|assistant)\]`.
3. **Noise scan**: Run `isNoise()` on all entries, delete matches.
4. **Near-dedup** (optional, needs embedder): For entries with cosine similarity > 0.95, keep the one with higher importance, delete the other. Batch: process 100 entries per cycle max.

#### B2. Deep Sweep (always runs, no LLM needed)

**What**: Re-score importance based on observed value. Entries that are frequently recalled are proven useful; entries never recalled after 30+ days are likely noise.
**When**: Every dream cycle, after light sweep.
**Cost**: DB reads + writes. No external calls.

Operations:

1. **Recall frequency scoring**: Track which memories are recalled (already have `retriever.recordRecall()`). Persist recall counts in a new column:
   ```
   memories table: add column recall_count INTEGER DEFAULT 0
   memories table: add column last_recalled_at INTEGER
   ```
   Deep sweep reads these and adjusts importance:
   - Recalled 5+ times → importance = max(current, 0.7)
   - Recalled 1-4 times → importance = max(current, 0.5)
   - Never recalled, age > 30 days → importance = min(current, 0.3)
   - Never recalled, age > 90 days → importance = min(current, 0.1)

2. **Stale action log decay**: Entries matching ephemeral patterns (`was committed`, `was pushed`, `was deleted`, `was deployed`, `was created`, `was updated`) older than 30 days with importance < 0.5 → set importance to 0.1. They'll be suppressed at retrieval and eventually consolidated or evicted.

3. **Log + telemetry**: Append to plain text log file AND fire `track()`:
   ```
   ~/.openclaw/memory/memex/memex.log
   ```
   Format: `TIMESTAMP [TYPE] key=value key=value`
   ```
   2026-04-08T03:00:12Z [dream:light] deduped=3 noise_removed=12 duration=45ms
   2026-04-08T03:00:13Z [dream:deep] rescored=45 decayed=8 duration=87ms
   ```
   Rotate at 5MB. CLI `memex log` is just tail + grep.
   
   Telemetry:
   ```typescript
   track("dream", { phase: "deep", rescored: 45, decayed: 8, ...sw.timings });
   ```

#### B3. Reflection (optional, needs LLM via OpenClaw subagent)

**What**: Review the memory pool, reason over scattered facts, and produce new **learnings** — synthesized insights that didn't exist in any single entry. This is not compression; it's the system forming new understanding from its experiences.
**When**: Weekly (every 7th dream cycle). Skips if OpenClaw subagent runtime is unavailable.
**Cost**: LLM API calls via `api.runtime.subagent.run()`. Uses whatever model the gateway has configured. Bounded to max 5 learnings per cycle.

**The `learning` category:**

Learnings are first-class memories with high default importance (0.85). They represent processed understanding — more valuable than raw facts. Stored with `category: "learning"` and `metadata.source: "dream-reflection"`.

Operations:

1. **Fact pool selection**: Sample recent entries (last 14 days) + high-recall entries + entries with thematic overlap (cosine similarity clusters). Cap at 50 entries per cycle to bound LLM context.

2. **Reflection prompt**: Send the fact pool to the LLM via subagent:
   ```
   You are reviewing memories collected over recent sessions. Look for:
   - Patterns across separate events (what connects them?)
   - Lessons learned from failures or successes
   - Implicit preferences or rules that aren't stated explicitly
   - Contradictions between old and new information
   
   For each insight, output:
   - The learning (concise, self-contained statement)
   - The evidence (which memory IDs support this)
   - Your confidence (high/medium/low)
   
   Only produce learnings you're confident about. Quality over quantity.
   ```
   Timeout: 60s. On failure, skip reflection (idempotent — will retry next week).

3. **Store learnings**: Each learning becomes a new memory entry:
   - `category: "learning"`
   - `importance: 0.85` (high — processed understanding)
   - `metadata.source: "dream-reflection"`
   - `metadata.evidence: ["id1", "id2", ...]` (source memory IDs)
   - `metadata.confidence: "high" | "medium"`
   - Only store `high` and `medium` confidence learnings

4. **Correction chains**: When a learning is later contradicted (user calls `memory_forget` on it, or stores a correcting fact):
   - The old learning's importance is demoted to 0.2
   - A new learning can reference `metadata.supersedes: "old_learning_id"`
   - The *reason* it was wrong is itself a learning ("Learning X was wrong because Y")
   - This chain is preserved — the system learns from its mistakes

5. **Safety bounds**:
   - Max 5 learnings per cycle
   - Only `high` and `medium` confidence stored
   - Never reflect on entries from the last 24 hours (let facts settle)
   - Learnings are clearly marked and can be filtered in retrieval if needed

---

## Failure Modes & Mitigation

| Failure | Impact | Mitigation |
|---|---|---|
| **Process killed mid-dream** | Partial dedup/delete completed | All operations are idempotent. Next cycle re-runs safely. SQLite WAL mode ensures atomic writes per statement. |
| **Embedding server down** | Near-dedup (B1.4) fails | Skip near-dedup for this cycle. Other operations don't need embedder. Log warning. |
| **Generation LLM down** | Consolidation (B3) fails | Skip consolidation. Light + deep still run. Log warning. |
| **LLM generates bad summary** | Merged entry loses detail | Summary entry has `metadata.source = "dream-consolidation"` + `metadata.originals = [ids]`. Originals are in the daily JSONL backup. Manual recovery possible. |
| **Dedup incorrectly merges** | Loses a unique memory | Text-hash dedup is exact match — no false positives. Near-dedup (0.95 cosine) is conservative. JSONL backup has the original. |
| **Dream takes too long** | Blocks gateway | Each phase has a timeout (light: 60s, deep: 60s, consolidation: 5min). Total max: ~7min. SQLite writes are per-row, not transaction-locked. |
| **Dream runs during peak usage** | Competes with auto-recall | Cron default is 3am. DB reads (auto-recall) and writes (dreaming) are concurrent-safe in WAL mode. |
| **Log file grows** | Unbounded memex.log | Rotate at 5MB — truncate oldest half when limit reached. |
| **Backup missing before dream** | No recovery path | Dream cycle checks that a backup exists from today (or yesterday). If no recent backup, run one before proceeding. |

---

## Disaster Recovery

**Scenario: Dreaming deleted important memories**

1. Find the most recent pre-dream backup: `~/.openclaw/memory/backups/memory-backup-YYYY-MM-DD.jsonl`
2. Identify deleted IDs from dream_log or by diffing backup against current DB
3. Re-import specific entries: `openclaw memex import-jsonl --file backup.jsonl --ids id1,id2,id3`
4. Or full restore: `openclaw memex import-jsonl --file backup.jsonl --replace`

**Scenario: DB corrupted during dream**

1. Stop gateway
2. Copy backup DB: `cp memex.sqlite memex.sqlite.corrupt`
3. Restore from backup JSONL (entries) + re-embed
4. Or restore from SQLite WAL recovery: `sqlite3 memex.sqlite ".recover"`

**Scenario: Dream cycle keeps failing**

1. Check `openclaw memex dream-log` for error details
2. Disable dreaming: `openclaw config set plugins.entries.memex.config.dreaming.enabled false`
3. Gateway continues normally — dreaming is a background optimization, never blocks core functionality

---

## UX

### User never thinks about memory quality

- Dreaming is **on by default** (light + deep). Consolidation is off by default (needs LLM config).
- No manual intervention needed. The system self-cleans.
- The user only notices dreaming when they run `memex dream-log` or see the startup log line.

### Config

```json
{
  "dreaming": {
    "enabled": true,
    "cron": "0 3 * * *",
    "phases": {
      "light": { "enabled": true },
      "deep": { "enabled": true },
      "reflection": { "enabled": false }
    }
  }
}
```

Reflection auto-enables when OpenClaw subagent runtime is available (no extra config needed).

### CLI

```bash
openclaw memex log                       # tail -50 the log file
openclaw memex log --type dream          # grep for dream events
openclaw memex log --type recall         # grep for recall events
openclaw memex log -f                    # tail -f (follow)
openclaw memex dream --dry-run           # preview what dreaming would do
openclaw memex dream --now               # run a dream cycle immediately
```

### Gateway log line

```
memex dream: light(deduped=3, noise=12) deep(rescored=45, decayed=8) [132ms]
```

### Telemetry

Dream events flow through `track()` with Stopwatch timings, same as recall/store/forget:

```typescript
track("dream", { phase: "light", deduped: 3, noise_removed: 12, ...sw.timings });
```

### Resiliency contract

**Dreaming never breaks the gateway.** If dreaming fails, crashes, or is misconfigured:
- Auto-recall continues working
- Memory store/forget tools continue working
- The only effect is that memory quality degrades over time (which is the status quo without dreaming)

Dreaming is a **background optimization**, not a critical path.

---

## Schema Changes

```sql
-- New columns on memories table
ALTER TABLE memories ADD COLUMN text_hash TEXT;
ALTER TABLE memories ADD COLUMN recall_count INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_recalled_at INTEGER;

-- Unique index for dedup (applied after backfill)
CREATE UNIQUE INDEX idx_memories_text_hash ON memories(text_hash);
```

No new tables. Dream results go to `memex.log` (plain text file) and `track()` (telemetry).

Migration: backfill `text_hash` for existing entries on first startup.

---

## Files to Create/Modify

| File | Change |
|---|---|
| `src/dreaming.ts` | **NEW** — Dream cycle orchestrator (light, deep, consolidation phases) |
| `src/memory.ts` | Add `text_hash` column, dedup on write, recall tracking columns |
| `src/session-indexer.ts` | Wire `isNoise()` filter, reject conversation fragments |
| `src/noise-filter.ts` | Add conversation fragment pattern (`^\[(user\|assistant)\]`) |
| `src/cli.ts` | Add `log` (tail+grep), `dream --dry-run`, `dream --now` commands |
| `src/logger.ts` | **NEW** — Append-only log writer with rotation |
| `index.ts` | Register dream cycle cron timer, config parsing |
| `tests/dreaming.test.ts` | **NEW** — Full test suite |
| `tests/intake-guards.test.ts` | **NEW** — Test dedup, noise rejection, fragment rejection |

---

## Test Plan

### tests/intake-guards.test.ts

```
describe("text hash dedup at write time")
  it("rejects exact duplicate text on store()")
    - Store "User prefers dark mode"
    - Store "User prefers dark mode" again
    - Assert: only 1 entry in DB
    - Assert: second store returns null or existing ID

  it("allows different text with same semantic meaning")
    - Store "User prefers dark mode"
    - Store "Dark mode is the user's preference"
    - Assert: 2 entries in DB (different text hash)

  it("rejects duplicates in bulkStore()")
    - bulkStore 5 entries, 2 of which have identical text
    - Assert: 3 entries stored

describe("conversation fragment rejection")
  it("rejects entries starting with [assistant]")
    - Store "[assistant] yo — I'm back on the new config"
    - Assert: not stored, returns null

  it("rejects entries starting with [user]")
    - Store "[user] ok\n[user] yes\n[user] add WHAT exactly"
    - Assert: not stored

  it("allows entries that mention [assistant] mid-text")
    - Store "The [assistant] role should always verify facts"
    - Assert: stored successfully

describe("noise filter on session import")
  it("filters noise entries before bulkStore in session-indexer")
    - Create entries: 3 valid facts + 2 noise (greeting, denial)
    - Run through session-import pipeline
    - Assert: only 3 stored

describe("embedding similarity vs source (session import)")
  it("rejects extractions that are >0.95 similar to source turn")
    - Mock embedder: return same vector for source and extraction
    - Assert: extraction rejected as copy-paste
  it("accepts extractions that differ from source")
    - Mock embedder: return different vectors
    - Assert: extraction stored
```

### tests/dreaming.test.ts

```
describe("light sweep")
  Setup: create MemoryStore with seeded test data

  it("removes exact text duplicates, keeps newest")
    - Store same text 3 times with different timestamps
    - Run light sweep
    - Assert: 1 entry remains (newest timestamp)
    - Assert: log file contains "[dream:light] deduped=2"

  it("removes conversation fragments")
    - Store 5 entries: 3 normal, 2 with [assistant] prefix
    - Run light sweep
    - Assert: 3 entries remain
    - Assert: log file contains "noise_removed=2"

  it("removes entries matching isNoise()")
    - Store "got it", "done", "ok", plus 2 real entries
    - Run light sweep
    - Assert: 2 entries remain

  it("near-dedup removes entries with >0.95 cosine similarity")
    - Store 2 entries with nearly identical vectors (cosine > 0.95)
    - Store 1 entry with a different vector
    - Run light sweep with mock embedder
    - Assert: 2 entries remain (1 deduped)
    - Assert: the one with higher importance survives

  it("is idempotent — running twice produces same result")
    - Seed data with duplicates and noise
    - Run light sweep
    - Record entry count
    - Run light sweep again
    - Assert: same entry count (nothing new removed)

  it("completes within timeout even with large dataset")
    - Seed 1000 entries (mix of noise and good)
    - Run light sweep
    - Assert: completes in < 60 seconds

describe("deep sweep")
  it("boosts importance for frequently recalled entries")
    - Store entry with importance=0.3, set recall_count=10
    - Run deep sweep
    - Assert: importance >= 0.7

  it("decays importance for old never-recalled entries")
    - Store entry with importance=0.5, age=60 days, recall_count=0
    - Run deep sweep
    - Assert: importance <= 0.3

  it("does not decay recent entries even if never recalled")
    - Store entry with importance=0.5, age=5 days, recall_count=0
    - Run deep sweep
    - Assert: importance unchanged (0.5)

  it("decays stale action logs matching ephemeral patterns")
    - Store "The webhook was deleted" with age=45 days, importance=0.3
    - Run deep sweep
    - Assert: importance = 0.1

  it("writes a dream_log row with correct counts")
    - Seed data triggering rescoring
    - Run deep sweep
    - Assert: log file contains "[dream:deep] rescored="

  it("is idempotent — decayed entries stay decayed")
    - Store old never-recalled entry
    - Run deep sweep twice
    - Assert: importance same after both runs

describe("reflection")
  it("skips when subagent runtime is unavailable")
    - Run reflection with no subagent runtime
    - Assert: 0 learnings created
    - Assert: no LLM calls made

  it("produces learnings from scattered facts")
    - Store 10 related facts about model deployments
    - Mock subagent to return 2 learnings with evidence IDs
    - Run reflection
    - Assert: 2 new entries with category="learning"
    - Assert: importance = 0.85
    - Assert: metadata.source = "dream-reflection"
    - Assert: metadata.evidence is array of memory IDs

  it("stores only high/medium confidence learnings")
    - Mock subagent to return 3 learnings: high, medium, low confidence
    - Run reflection
    - Assert: 2 learnings stored (high + medium)
    - Assert: low confidence one discarded

  it("does not reflect on entries from last 24 hours")
    - Store 5 entries all from today
    - Run reflection
    - Assert: 0 learnings (nothing old enough to reflect on)

  it("limits to 5 learnings per cycle")
    - Mock subagent to return 10 learnings
    - Run reflection
    - Assert: at most 5 stored

  it("handles subagent timeout gracefully")
    - Mock subagent that times out
    - Run reflection
    - Assert: no learnings stored
    - Assert: log file contains "[error]"
    - Assert: function returns without crashing

  it("is idempotent — same facts don't produce duplicate learnings")
    - Run reflection, produces learning L1
    - Run reflection again with same fact pool
    - Assert: L1 not duplicated (text hash dedup catches it)

describe("correction chains")
  it("demotes learning when user forgets it")
    - Store a learning at importance=0.85
    - Call memory_forget on it
    - Assert: learning importance demoted to 0.2 (not deleted)

  it("new learning can supersede an old one")
    - Store learning A
    - Store learning B with metadata.supersedes = A.id
    - Assert: A.importance demoted to 0.2
    - Assert: B.importance = 0.85
    - Assert: B.metadata.supersedes = A.id

  it("preserves the correction chain for retrieval")
    - Create chain: A → B supersedes A → C supersedes B
    - Assert: A.importance = 0.2, B.importance = 0.2, C.importance = 0.85
    - Assert: all 3 entries exist in DB (nothing deleted)

describe("dream cycle orchestrator")
  it("runs phases in order: light → deep → reflection")
    - Track phase execution order via side effects
    - Run full dream cycle
    - Assert: light runs first, then deep, then consolidation

  it("continues to next phase if a phase fails")
    - Mock light sweep to throw
    - Run dream cycle
    - Assert: deep sweep still runs
    - Assert: dream_log shows light error + deep success

  it("checks for recent backup before running")
    - Remove all backup files
    - Run dream cycle
    - Assert: creates a backup before proceeding

  it("respects phase-level enabled flags")
    - Config: light=true, deep=true, reflection=false
    - Run dream cycle
    - Assert: reflection did not run

  it("total cycle completes within 7 minutes")
    - Seed realistic dataset (2000 entries)
    - Run full cycle
    - Assert: < 420 seconds

describe("recall tracking")
  it("increments recall_count when memory is recalled")
    - Store entry, recall it 3 times via retriever
    - Assert: recall_count = 3
    - Assert: last_recalled_at is recent

  it("persists recall counts across gateway restarts")
    - Store entry, recall it, close store, reopen
    - Assert: recall_count preserved

describe("memex log CLI")
  it("shows recent log lines")
    - Write 10 lines to memex.log
    - Run CLI log command
    - Assert: output shows recent lines

  it("filters by --type")
    - Write mix of [dream:light], [recall], [store] lines
    - Run CLI log --type dream
    - Assert: only dream lines shown

  it("supports -f (follow)")
    - Start CLI log -f in background
    - Append a line to memex.log
    - Assert: new line appears in output

describe("config parsing")
  it("dreaming defaults to enabled with light + deep on")
    - Parse config with no dreaming section
    - Assert: dreaming.enabled = true
    - Assert: phases.light.enabled = true
    - Assert: phases.deep.enabled = true
    - Assert: phases.consolidation.enabled = false

  it("consolidation auto-enables when generation LLM is configured")
    - Parse config with generation.model set
    - Assert: phases.consolidation.enabled = true

  it("respects explicit dreaming.enabled = false")
    - Parse config with dreaming.enabled = false
    - Assert: no dream timer registered

describe("resiliency")
  it("gateway starts normally when dream_log table is missing")
    - Open DB without dream_log table
    - Start plugin
    - Assert: no crash, table created on first dream cycle

  it("auto-recall works during an active dream cycle")
    - Start a dream cycle in background
    - Simultaneously run a retriever.retrieve() call
    - Assert: retrieve returns results (not blocked)

  it("dreaming failure does not affect memory_store tool")
    - Force dream cycle to crash
    - Call memory_store tool
    - Assert: memory stored successfully

  it("dreaming failure does not affect memory_recall tool")
    - Force dream cycle to crash
    - Call memory_recall tool
    - Assert: recall returns results
```

---

## Measurement & Visualization

### Metrics (4 layers, no extra LLM calls for v1)

| Layer | Metric | Source | Cost |
|---|---|---|---|
| **Pool health** | pool_size, noise_ratio, never_recalled_ratio | DB query per dream cycle | Free |
| **Retrieval precision** | avg top-3 recall score | Already in `track("recall")` | Free |
| **Token economics** | tokens_in/out per reflection | Subagent response metadata | Free |
| **Context utilization** | Did LLM use recalled context? | Periodic eval (monthly) | LLM judge cost |

### Telemetry Events

All events flow through existing `track()` → telemetry relay → OpenPanel (`op.mlab.dev`).

**Existing events (already instrumented):**

| Event | Key Properties | Chart Type |
|---|---|---|
| `recall` | results, source, embed_ms, search_ms, total_ms | Time series (latency p50/p95) |
| `store` | chunks, category, total_ms | Bar (stores/day by category) |
| `forget` | found, total_ms | Counter |
| `startup` | embed_probe_ms, retrieval_probe_ms | Time series |
| `error` | operation, message | Counter (errors/day) |

**New events from dreaming:**

| Event | Key Properties | Chart Type |
|---|---|---|
| `dream` | phase, deduped, noise_removed, rescored, learnings, total_ms | Time series per phase |
| `dream_metrics` | pool_size, noise_ratio, never_recalled_ratio, avg_recall_score | Line (health over time) |
| `dream_cost` | tokens_in, tokens_out, phase | Stacked bar (token cost/cycle) |

### OpenPanel Dashboards (3 views)

**1. Memory Health** (primary)
- `pool_size` over time — stable or slowly growing (line)
- `noise_ratio` over time — should decrease after dreaming starts (line)
- `never_recalled_ratio` over time — should decrease as deep sweep decays stale entries (line)
- `avg_recall_score` over time — should increase as noise is removed (line)
- `learnings` created per cycle (bar)

**2. Performance**
- `recall` total_ms p50/p95 (time series)
- `embed_ms` vs `search_ms` breakdown (stacked area)
- `dream` duration per phase (stacked bar)
- `store` total_ms (time series)

**3. Token Economics**
- `dream_cost` tokens_in/out per cycle (bar)
- Daily auto-recall count × avg injected tokens (estimated injection cost, line)
- Dream tokens as % of total recall tokens (should be small, pie)

### Dashboard Setup

One-time manual setup in OpenPanel UI — no code needed. OpenPanel auto-discovers events from `track()` calls. Create charts by selecting event name → property → aggregation → time range.

The telemetry relay at `telemetry-relay-memex.mlab42.workers.dev` already forwards to OpenPanel. The only code work is firing the 3 new events (`dream`, `dream_metrics`, `dream_cost`) at the right points in the dream cycle.

---

## Implementation Order

1. **Intake guards** (A1-A3) — prevent new garbage, no dream cycle needed
2. **Schema migration** (text_hash, recall_count, last_recalled_at)
3. **Recall tracking** — persist recall counts in DB
4. **Light sweep** — dedup + noise removal
5. **Deep sweep** — recall-based re-scoring + ephemeral decay
6. **Dream cycle orchestrator** — cron scheduling, phase sequencing, log file
7. **CLI** — `memex log`, `dream --dry-run`, `dream --now`
8. **Reflection** (optional phase) — LLM-driven learnings via subagent
9. **Backfill** — hash existing entries, run initial light+deep sweep
10. **Telemetry** — fire `dream`, `dream_metrics`, `dream_cost` events; set up OpenPanel dashboards

Each step is independently shippable. Steps 1-6 deliver the core value.
