# 020 — MCP-Surface Recall Quality Audit (2026-09-07)

Continuation of the interrupted analysis thread `01a07a68-c186-7e50-9c5b-1f19822bd643`
("do analysis on sessions and logs, and evaluate memex's performance, quality"), which
died mid-turn at 06:43 UTC on an upstream 400 (`System message must be at the
beginning.`) before writing anything up. That error is the Qwen non-leading-system-message
bug, fixed in llm-proxy v0.7.209 and verified live (`https://[llm-proxy-gateway]/version`).

Numbers here are re-derived from the live surface, not carried over from that thread's
scratch notes (its harness survives at `/tmp/memex_audit/`).

**Audited surface:** the memex daemon Codex and Claude actually use — `memex.service`,
HTTP on `100.117.49.20:7878`, reached via the llm-proxy MCP gateway
(`http://memex-mcp-egress` → Caddy `:8098`). Code runs from `/home/ubuntu/projects/memex`
(jiti, started 2026-09-05). The OpenClaw plugin path is **not** measured (see F9).

**Baseline:** `main` @ `a5b7b55`, clean tree.
`node --import jiti/register --test tests/*.test.ts` → **947 tests, 946 pass, 1 fail**.
The failure is pre-existing: `tests/tools-scoping.test.ts:200` ("BUG1: session_id derives
session tag and filters recall" → *No relevant memories found.*). It is **not** root-caused
here — scope tag intersection itself verified working in an isolated probe, so treat the
cause as open, not as evidence for F1/F2 below.

---

## Verdict

Retrieval on the MCP surface is broken in ways AGENTS.md does not describe. The document
channel returns near-constant scores and is never relevance-gated; the memory channel's
lexical half returns an *arbitrary* subset of matches instead of the best ones; the
highest-value memories (reflections) are invisible to vector search entirely; and the
reranker the config enables is not wired into this path. Net effect: **a specific stored
memory is almost never returned**, and results are document-dominated regardless of
relevance.

F1, F2 and F3 each independently explain the "recall doesn't work" symptom. None of them
is the temporal-override issue AGENTS.md currently leads with.

---

## F1 — `bm25Search` has no `ORDER BY`: the lexical channel returns an arbitrary window
**P0 — root cause, highest impact, one-line fix**

`src/memory.ts` (`bm25Search`) builds:

```sql
... FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE ${conditions}
LIMIT ?          -- ← no ORDER BY
```

FTS5 without `ORDER BY` returns matches in rowid order, so the `limit` window is an
arbitrary slice of the match set, not the best matches. The document-side queries do have
it (`src/search.ts:2475`, `:2534` — `ORDER BY bm25_score ASC`); the memory side was missed.

Measured against the live corpus (369 memories) by replaying the **138 real-traffic MCP
queries** preserved in the debug traces, restricted to those whose FTS match count exceeds
the 15-row window — the only case where the window can lose anything:

| | |
|---|---|
| Qualifying queries (of ~137 distinct) | 136 |
| Ideal top-5 recovered by the unordered window | **61 / 680 (9%)** |
| Queries recovering **zero** of the ideal top-5 | **98 / 136 (72%)** |

Direct demonstration — target is FTS-matchable and ranks #1 by BM25, but is absent from
what the code asks for:

```
"llm-proxy routing should use cache-aware sticky routing, separate optimization
 from failover"        → 290 FTS matches
  unordered LIMIT 15 (what the code retrieves): ae8dbdc5 ABSENT
  ORDER BY bm25 ASC LIMIT 15 (what it should retrieve): ae8dbdc5 = rank 1
```

Same for `"Anemll"` (355 matches, 4/4 targets dropped) and `"start-dsh-web"` (351
matches, 2/2 dropped). Narrow phrase queries that happen to return <15 rows are
unaffected — which is why this hid for so long.

`fuseMemoryResults` scores `0.8*vz + 0.2*bz` and treats an *absent* signal as 0
("neutral, at the mean"), so a wrong BM25 set doesn't merely miss candidates: it
actively demotes every vector hit to "not lexically relevant".

**Fix:** add `ORDER BY bm25_score ASC`. ~1ms at this size. Add a test seeding >15 matching
memories with graded BM25 and asserting the returned ids are the top-`limit` — no existing
test asserts ordering (0 hits for order/rank/relevance against `bm25Search` in `tests/`).

## F2 — Reflection inserts bypass the vector store
**P0 — makes the best memories permanently invisible**

`src/dreaming.ts:450` writes learned rows with a raw `INSERT INTO memories ...` (category
`learning`, importance `0.85`) and **never writes `vectors_vec` or `memory_vectors`**. The
embedder is used only for the *dedup probe* (`:416`), which can never fire, because nothing
new ever becomes a vector to compare against.

| Live DB | |
|---|---|
| `memories` total | 369 |
| Distinct memories with ≥1 vector | 355 |
| **Unembedded** | **14 — all 14 are `category='learning'`** |
| `learning` rows total / unembedded | 23 / **14 (61%)** |

The unembedded set is exactly the high-value tail: mean importance **0.73 vs 0.29** for
embedded rows, dates 2026-08-06 → 2026-09-07, `recall_count = 0` on every one. It is also
the paraphrase-duplicate cluster the prior run flagged:

```
"llm-proxy routing should use cache-aware sticky routing…"  ×5 paraphrases
"Production DS4 stack is Anemll 0.25.2 + Patch 4 + k5…"     ×4 paraphrases
"dsh web on [device]-pc must run via the persistent launcher…"  ×2 paraphrases
```

Semantic dedup cannot catch a paraphrase of a memory that has no vector — so F2 also
sustains the duplication loop. Exact-text `dedup_hash` is clean (0 collisions), which is
why the prior run's "dupes=0" and "re-stored weekly" are both true simultaneously.

**Fix:** route reflection writes through the embedding store path (or embed+insert
inline). Test: `getVectorCount(id) > 0` for a `reflectionSweep` output.

## F3 — The reranker is not wired on the MCP path (corrects AGENTS.md item #2)
**P1**

`src/mcp-server.ts:123`:

```ts
retriever = new UnifiedRetriever(store, documentSearchFn, embedder, { captureTrace });
```

`DEFAULT_CONFIG.reranker = null` → **Stage 7 confidence-gated reranking never runs**. The
`reranker` block is constructed only in `index.ts:942` (OpenClaw plugin path), and
`applyEnvOverrides` is called at `index.ts:306` — `grep -c applyEnvOverrides
src/mcp-server.ts` → **0**. So `MEMEX_RERANK_*` is read nowhere on the daemon path.

The live service *does* configure it against a working reranker
(`/proc/2798933/environ`): `MEMEX_RERANK_ENDPOINT=http://[llm-proxy-gateway]/v1/rerank`,
`MEMEX_RERANK_MODEL=qwen3-reranker`, key set.

Trace evidence over the 138 real-traffic MCP traces. The retained corpus straddles the
switch and dates it precisely:

| Pipeline | Traces | Date range | Traces with reranked rows | `config.reranker` |
|---|---|---|---|---|
| `memory-hybrid` (`createRetriever`) | 77 | 2026-07-15 → **07-18** | 35 | set |
| `unified` (`UnifiedRetriever`) | 60 | **2026-07-18** → 09-07 | **0** | **null on 0/60** |

`git log -L` shows #116 (`a85e4a5`, **2026-07-18**) replaced the correctly-configured
`createRetriever(...)` call with `new UnifiedRetriever(..., { captureTrace })` and dropped
the rerank args; #117 (`a2c414e`, same day) unified the pipeline everywhere. Reranking
stopped the day the change shipped, and `AGENTS.md`'s own #116/#117 bullet never revisited
it. This is a deploy-date regression, not drift.

So AGENTS.md "Reranker now wired (FIXED in #103)" is true for the plugin path and **false
for the path Codex/Claude use**; #103 shipped `memex.env.example` with `MEMEX_RERANK_*` but
not the wiring. That is exactly the "rerank quality regressed since mid-July" symptom, and it is not a
model or data change.

**Fix:** call `applyEnvOverrides` (or build the `reranker` block as `index.ts:942` does) in
`createMemexMcpServer` and pass it to `UnifiedRetriever`. Test: with
`MEMEX_RERANK_ENDPOINT` set, the MCP retriever's `config.reranker` is non-null. Keep it
provider-agnostic.

## F4 — Cross-source scores are incomparable; documents systematically win
**P1**

`mergeAndCalibrate` no longer calibrates — `calMem`/`calDoc` are identity (comment: *"Z-score
calibration was removing absolute relevance signal"*). Despite the name, and despite
AGENTS.md's "z-score fusion" claim, z-scoring now applies only *within* the memory channel.
Cross-source it is raw score × fixed weight, across four different scales:

| Channel | Formula | Range |
|---|---|---|
| memory (vector) | `1/(1+distance)` | 0.275–0.55 → ×0.55 |
| memory (fused) | `sigmoid(0.8·vz+0.2·bz)` | ~0.15–0.5 → ×0.55 |
| doc (vector) | `1 − cosine_distance` | 0–1 → ×0.45 |
| doc (FTS) | `\|bm25\|/(1+\|bm25\|)` | **saturates**: −30 → 0.4355 → ×0.45 = 0.435 |

Two defects. (a) `1/(1+d)` compresses all cosines into 0.5–1.0, so memory's dynamic range
is ~0.05 of its nominal scale. (b) The doc FTS squash is near-constant for any decent
match, so doc scores cluster at 0.43–0.44 — and still land *above* most real memory
scores once F1/F2 have starved that channel.

Over the 138 real-traffic MCP traces (428 returned rows):

| Source | n | min | median | max | mean rank |
|---|---|---|---|---|---|
| document | 297 | 0.247 | **0.431** | 0.444 | 3.60 |
| conversation | 62 | 0.151 | **0.307** | 0.488 | 5.19 |
| reranked (pre-07-18 only) | 69 | 0.154 | 0.273 | 0.810 | 1.78 |

**Documents out-ranked memories in 52 of the 58 queries where both were present.**
Rank-1 was a memory in **8 of 138** queries, and memory rows make up only 62 of 428 results. Note `applyPostMergeModifiers` only touches
`source === "conversation"`, so time decay/importance/length all act on the losing side
alone — the AGENTS.md temporal-override analysis describes the *pre-unified* retriever and
is not what is suppressing memories here.

**Fix (not a weight re-tune):** normalize both channels onto one shared absolute scale, or
gate the doc channel by route intent, before weighting. The `reranked` rows show the blend
already yields usable spread (0.154→0.810), so F3 is a prerequisite for F4 tuning to mean
anything. Calibrate on the domain eval, not by eyeball.

## F5 — No relevance gate on the document channel (no abstention)
**P1**

```
"zzxqf blorp quantum fluxbank nobody-asked-this-2026" → 5 results, best doc 0.4226
real-query corpus, best doc: min 0.258  median 0.435  max 0.444
```

0.4226 sits inside the real-query band (median 0.431), and `minScore` 0.15 / `hardMinScore` apply
to weighted scores a doc always clears. The doc path is effectively **unconditional
top-k**, so it fills every slot with plausible-looking noise — which *masks* F1/F3 rather
than exposing them, because `limit` results always come back. Meanwhile 42 of 138 real
queries returned 0 results (memory-only routes with nothing retrievable). Same disease,
opposite symptom: pollutes when it should abstain, abstains when it should answer.

This is the "confidence floor + AutoCut + abstention" item `docs/design/recall-quality-design.md`
still lists as design-only. On this surface it is load-bearing, not a refinement.

## F6 — Embedding-model drift: a latent full-corpus re-embed
**P2**

```
store_meta.embedding_model = "Qwen3-Embedding-4B-Q8_0"
live env MEMEX_EMBED_MODEL = "qwen3-embedding"
content_vectors by model  = {Qwen3-Embedding-4B-Q8_0: 365 hashes, qwen3-embedding: 2067}
```

`getEmbeddingStatus` compares those strings exactly → `model_changed`. Dormant today only
because the MCP `MemoryStore` is built without a current-model argument and the MCP path
never calls `needsReEmbed` (all callers are in `index.ts`). The moment that check reaches
this path — or a rebuild runs — it targets **5,604** document vectors plus 369 memories
against [embedding-host].

If the two names alias one served model this is cosmetic; if not, the shared `vectors_vec`
space already mixes representations and similarity is unsound. The live proxy `/v1/models`
lists only `qwen3-embedding`, so the alias question is unresolved from this host.
**Verify before anything re-embeds** (cosine of a same-text pair embedded under both
names). AGENTS.md constraint #5 claims drift is detected and warned — it is not, on this
path.

## F7 — Stale-data hygiene (corrects the prior run's "pollutes retrieval" claim)
**P2 — bookkeeping, not a retrieval bug**

The interrupted thread reported "2,454 of 4,793 docs active, yet 70,905 sections remain"
as retrieval pollution. First number right, interpretation wrong. Reconciled live:

| | |
|---|---|
| `documents` rows / active | 4,794 / **2,455** |
| `document_sections` total | 70,943 |
| …on active docs (reachable) | 37,836 |
| …on inactive docs | 33,107 |
| `sections_fts` rows joining to nothing (true orphans) | **2,972** |
| active-doc sections present in `sections_fts` | **37,836 / 37,836** |

`searchFTS`/`searchVec` both filter `d.active = 1`, so the 33,107 inactive rows cannot be
returned. **Nothing stale is retrievable and no active section is missing from FTS.** Real
cost is ~45MB of dead index rows plus 2,972 unjoinable FTS rows.

Gap: `deleteInactiveDocuments()` (`src/search.ts:1250`) is exported but **never called
from any runtime path** — only exposed on the store object. `deactivateDocument` correctly
removes section FTS before flipping the flag, so the orphans came from a path that didn't
(likely a bulk collection drop, or `document_sections` rowid reuse — its sequence is 77,709
against 70,943 rows). Needs an integrity pass + maintenance wired to the CLI, not an
emergency purge.

## F8 — Corpus quality (upstream of everything)
**P2**

| Signal | Value |
|---|---|
| Memories starting `[assistant]`/`[user]` (raw turns, undistilled) | **119 / 369 = 32%** |
| Memories pinned at the `importance` floor 0.10 | **216 / 369 = 59%** |
| Memories carrying only the `global` scope tag | **277 / 369 = 75%** |
| Ever recalled (`recall_count > 0`) | 74 / 369 (20%) — **not** the 99%→healthy trend AGENTS.md #5 predicted |
| Recalled in last 30 days / 7 days | **12 distinct / 3** |
| Corpus age | median **163 days**; 263 of 369 older than 90 days |
| `memories.timestamp` unit | uniformly **ms**, matching retriever math — no unit bug |
| Exact `dedup_hash` collisions | 0 |

Scope isolation is effectively off: 75% carry only `global`, so the 62 distinct
`session:<device>:<uuid>` tags (92 rows) can neither isolate nor prioritize. Scope tag
*intersection* itself works (isolated probe: filtered BM25 returns the tagged memory).
`scope` holds `global` ×333 plus 35 one-offs including `__latency_test__`, `project_ds4`,
`agent:coder`, and `homelab`/`[infra-project]`/`[infra-project]-llm-proxy` for one concept; and
`project:9ab54a48881088a5` (92 rows) sits alongside human-readable `project:llm-proxy` —
two naming schemes for the same idea. 32% raw fragments + 59% importance floor + 75%
undifferentiated scope is why the retriever has little to rank on even after F1–F5.

## F9 — Operating state
**Info — and it corrects the "gateway DOWN" alarm in both directions**

- **Dreaming has not run since 2026-04-09.** `memex.log` last cycle
  `2026-04-09T03:18:37Z`, and that cycle was
  `light(deduped=0, noise=0, fragments=0) deep(rescored=0, decayed=0)` — a no-op, exactly
  as AGENTS.md item #6 predicts. 5 months of un-deduped, un-rescored growth.
- **`monitor.sh`'s `gateway: DOWN` line is a false alarm — but the state it describes is
  real.** `scripts/monitor.sh:14` runs `pgrep -f "openclaw-gateway"` inside a
  `bash -c`/`zsh -c` wrapper, and `-f` matches the wrapper's own command line, so it
  *self-matches* and prints "up" with the pid of the shell running the check. (My first
  check fell into the identical trap.) Which value gets written therefore depends on the
  invoking shell — the DOWN streak since May is largely artifact.
  Independently: `systemctl --user is-active openclaw-gateway` → **`inactive`**, unit dead
  since `2026-06-29 17:17:16`. So OpenClaw auto-recall/auto-capture genuinely are not
  running — which is *why* F1/F3 go unnoticed: the only path with correct rerank wiring is
  the dead one.
- **Prior run's "pool dropped 2103→363":** actual transitions in `monitor-report.log` are
  `2103` (2026-04-08) → `465` (2026-04-13, a one-time ~1,650-row purge) and a
  `395 → 0 → 399` blip (2026-05-19/20) where the monitor read a different/rotated DB.
  Current 369. Not a live leak.
- **MCP usage (gateway shared telemetry, 72h):** memex 18 calls — 5 `memory_recall`,
  7 `memory_store`, 3 `document_upsert`, 1 each forget/collections/stats, 0 errors,
  against 381 total MCP calls (web-tools alone 187). `memory_recall` avg **443ms**
  vs AGENTS.md's ~150ms p50 — that doc figure is the plugin path; the daemon's embed
  round-trip to [embedding-host] via the proxy is the likely delta (not decomposed here).
- **Deployment drift:** `~/.openclaw/plugins/memex` (2026-05-20) differs from
  `projects/memex` on `mcp-server.ts`, `unified-retriever.ts`, `dreaming.ts`. The audited
  daemon runs from `projects/memex`, but any OpenClaw-side restart would run code 3.5
  months older than this report.

---

## Fix plan and gates

Ordered so each gate is falsifiable at the real surface. Nothing trades performance for
correctness: F1 is index order, F2/F3 remove dead config, F4/F5 change score *shape* and
must be calibrated on evals.

**Rollback target:** `a5b7b55`. Branch per fix; keep the daemon on `main` until Gate 1.

1. **F1** — `ORDER BY bm25_score ASC` in `bm25Search`.
   *Pre:* write the failing test first (seed >15 matching memories, graded BM25, assert
   top-`limit`). Confirm it fails on `a5b7b55`.
   *Gate 1 (blocks everything else):* the three verbatim probes below return their target
   in the top 5; full suite ≥946 pass / 0 fail.
2. **F2** — reflection writes embed.
   *Test:* `getVectorCount(id) > 0` for a `reflectionSweep` output.
   *Gate 2:* backfill the 14 unembedded learnings on a **copy** of `memex.sqlite`; unembedded
   count → 0; re-run the probe set; then check whether the sticky-routing / DS4 / dsh-web
   clusters collapse under semantic dedup (they should now be able to). Do not purge
   originals until dedup is proven.
3. **F3** — wire `applyEnvOverrides`/`reranker` into the MCP server.
   *Gate 3:* a live daemon trace shows `config.reranker != null` and a `rerank` stage;
   measure recall p50/p95 before/after (rerank adds a proxy round-trip — this is the one
   change with real latency cost, so keep the confidence gate rather than reranking every
   call).
4. **F4 + F5** — shared absolute scale + doc-channel gate/abstention.
   *Gate 4:* on the domain eval, memory:doc mix moves materially from 62:297,
   doc-beats-memory drops well below 52/58, rank-1-is-memory rises well above 8/138,
   **and** the nonsense query abstains. Replay the 138 traces and diff score
   distributions. This is where `hardMinScore`/AutoCut finally threshold on something honest.
5. **F6** — settle `qwen3-embedding` vs `Qwen3-Embedding-4B-Q8_0` as alias-or-not
   **before** any re-embed is wired or triggered. If aliases: normalize the recorded name
   and add a drift check to the MCP path (constraint #5). If distinct: pick one and plan an
   explicit re-embed.
6. **F8/F9** — hygiene, explicitly not urgent: wire `deleteInactiveDocuments` + a
   `sections_fts` orphan reconciler into `memex rebuild`; fix `monitor.sh` to read systemd
   unit state instead of a self-matching `pgrep`; decide the scope policy (one project-id
   naming scheme; whether 75% `global`-only is intended); get `dream` running again — or
   stop documenting consolidation as a feature.

## Repro

```bash
# F1 — read-only, against a throwaway copy of the live DB
cp ~/.openclaw/memory/memex/memex.sqlite /tmp/repro.sqlite
cat > /tmp/f1_repro.ts <<'TS'
import { MemoryStore } from "/home/ubuntu/projects/memex/src/memory.js";
const s = new MemoryStore({ dbPath: process.env.MEMEX_DB_PATH!, vectorDim: 4 });
const q = "llm-proxy routing should use cache-aware sticky routing, separate optimization from failover";
const r = await s.bm25Search(q, 15);
console.log("as-shipped present:", r.some((x: any) => x.entry.id.startsWith("ae8dbdc5")), `(n=${r.length})`);
await s.close();
TS
MEMEX_DB_PATH=/tmp/repro.sqlite node --import jiti/register /tmp/f1_repro.ts
# verified output today: `as-shipped present: false (n=15)`
# same DB, adding `ORDER BY bm25(memories_fts)`: target present, at rank 1
# → should print `true` after the fix

# F2 — 14 unembedded, all category=learning
sqlite3 -readonly ~/.openclaw/memory/memex/memex.sqlite \
 "select m.category,count(*) from memories m where not exists(select 1 \
  from vectors_vec_rowids v where v.id like 'mem_'||m.id||'%') group by 1;"

# F3 — static + trace inspection
grep -n "new UnifiedRetriever" src/mcp-server.ts
python3 -c "import json,glob
for f in glob.glob('/tmp/memex-debug-recall/*.json'):
    d=json.load(open(f)); t=d.get('trace') or {}
    print(d['ts'], t.get('pipeline'), t.get('config',{}).get('reranker'))"

# F4/F5 — score distribution over retained traces + live MCP probes
#   live probes need the daemon token; read it from /proc/<pid>/environ, never print it
```

## Latency (added — decomposes the 443ms figure in F9)

AGENTS.md documents ~150ms p50 for the unified retriever. Measured on the audited
daemon path, cold-cache components (local, so no network confound):

| Component | Measured |
|---|---|
| HTTP/daemon framing (`tools/list`, no work) | p50 **8ms** |
| Query embed round-trip (`qwen3-embedding` @ 2560-d, proxy→[embedding-host]) | p50 **45ms**, max 223ms |
| `bm25Search` over 369 memories | p50 **1ms** |
| `list()` (no embed, no ANN) | **0ms** |
| Doc channel: `sections_fts` join over 70,943 sections + `content` lookup | p50 **14ms**, max 19ms |
| …same query via `documents_fts` only (whole-doc path) | p50 **2ms** |

End-to-end `memory_recall` over HTTP: **70ms – 772ms** across probes, gateway telemetry
averaging 443ms (n=5). The 70ms case is the LRU embed cache hitting; the slow cases are
cache-miss embeds. Summing warm-path components (~8 + 0 + 1 + 14 + ANN) still lands near
the documented figure, so **the retrieval pipeline itself is not the problem — the
~45–225ms remote embed per cache-miss dominates, and the doc-side `sections_fts`→`content`
join is the one local cost worth noting** (14ms vs 2ms whole-doc; it fetches the entire
document body per hit). No performance regression to fix, and no reason to accept the
reranker (F3) as a latency excuse for F1/F2 — those are ~free.

## Limitations

- Sources: live `memex.sqlite` (read-only), the retained debug traces
  (`/tmp/memex-debug-recall`, `MEMEX_DEBUG_RECALL=1`), the gateway's 72h shared-telemetry
  window, `/proc/2798933/environ`, `monitor-report.log`, `memex.log`. No OpenClaw-plugin
  claims — that gateway has been dead since 2026-06-29.
- **Trace population, stated once:** 147 MCP traces are retained. **9 are my own probes**
  and are excluded from every statistic above, leaving **138 real-traffic traces / 428
  result rows** spanning 2026-07-15 → 2026-09-07: 77 `memory-hybrid` (07-15→07-18), 60
  `unified` (07-18→09-07), and 1 pre-switch trace whose `pipeline` field did not survive.
  Retention is short — ~8 weeks — so this is *not* full history, and pre-July recall is
  unmeasurable from traces.
  `mcp-server.ts:123` corroborates F3 statically regardless of retention, and the
  F1/F2/F6/F7/F8 findings come from the DB, not the traces, so they carry no such limit.
- The prior thread's transcript scan (60 explicit memex calls in 1,728 live sessions;
  its own `resmap.json` shows 20 recall / 39 store / 1 stats and **0 recall errors**) was
  not re-derived. Worth noting: zero errors means the failure mode is silent mis-ranking,
  not tool breakage — consistent with F1–F5.
- F1/F2/F3 are confirmed by code + measurement. F4/F5 are confirmed as score-*shape*
  facts; their severity ordering versus F1 is judgment, and Gate 4 settles it.
- Gate 2's re-embed and Gate 5's alias check were deliberately **not** executed: both
  touch the live corpus or a remote model, and F6 makes an unreviewed re-embed risky.
- The pre-existing `tools-scoping.test.ts:200` failure is documented, not attributed.

## Incident correction — live ANN index rebuild (2026-09-07 18:05–18:33 EDT)

During continuation of this audit, a diagnostic script opened the live DB through
`MemoryStore` with `vectorDim: 2560`. Its `ensureVecTable()` startup behavior detected a
schema mismatch (the exact pre-drop dimension was not captured) and dropped/recreated the
shared `vectors_vec` table. This was an **agent-caused destructive diagnostic side effect**;
regular SQLite rows were not deleted, but the prior ANN vectors were.

Actions taken:

1. Stopped `memex.service` and created a coherent snapshot at
   `~/.openclaw/memory/memex/backups/accidental-ann-snapshot-20260907-183105.sqlite`.
2. Rebuilt all 375 memory vectors successfully with the daemon's configured
   `qwen3-embedding`/2560-d embedder.
3. Attempted document repair first serially and then in 8-way batches. The proxy embedder
   was ~57 seconds per 16-item batch, so both attempts were stopped rather than left
   running unattended. The current DB has only a partial document ANN rebuild (132
   `content_vectors` rows at the time of this note); the document FTS index and all
   document/memory text rows remain intact.
4. Restarted `memex.service`; it is active on `100.117.49.20:7878`. Startup dreaming ran
   once and added no learnings; it rescored 8 and decayed 3 memories.

**Current impact:** memory ANN recall is restored; document vector recall is incomplete.
Document lexical recall remains available. The report's pre-incident trace measurements
remain historical observations, but any live vector counts taken after 18:05 must be
replaced after a controlled document rebuild. Do not open the live DB with an arbitrary
`MemoryStore({ vectorDim })` until the stored `vectors_vec` schema is explicitly read and
matched; use a read-only connection or a controlled rebuild procedure.

**Recovery decision still open:** the correct next step is a controlled, resumable,
batched document re-embedding under service maintenance (or restoration from a verified
full ANN backup if one exists). It should first record the current schema/dim, take a
second backup, use bounded concurrency with progress checkpoints, verify active-document
coverage and query behavior, then restart the daemon. No further live rebuild was started
in this turn.
