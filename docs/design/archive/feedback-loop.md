# Feedback Loop — Bounded Recall-Frequency Boost (design)

**Superseded by:** [recall-quality-design.md](../recall-quality-design.md) — canonical spec.
**Status:** design-only (ready for TDD implementation). No code changes in this doc.
**Date:** 2026-06-29
**Roadmap item:** "Feedback loop — implicit recall-frequency boost (bounded)."

> This design was grounded by a parallel investigation of the *actual* codebase
> (recall-count plumbing, scoring pipeline, live pool signal) rather than SOTA
> citations. The decisive findings reshape the problem — see §2–3.

## 1. Goal

Memories that prove useful (get recalled) should edge out otherwise-equal
candidates in future retrieval — a bounded, implicit "popularity"/value signal
that **complements** semantic relevance, recency, and importance without
overriding them. The boost must be **bounded** (no rich-get-richer runaway) and
**cold-start fair** (never-recalled memories are not permanently buried).

## 2. The boost already exists — ephemerally

This is the key reframe. There is **already** a recall-frequency boost in the
retrieval pipeline:

```ts
// src/retriever.ts:806-808, inside applyImportanceWeight
const freqBoost = Math.min(0.1, (this.recallFrequency.get(r.entry.id) ?? 0) / 200);
score += freqBoost;                       // (applied via the importance factor)
```

- It is **bounded** at +10% (`min(0.1, …)`).
- But `this.recallFrequency` is an **in-memory `Map`** (`retriever.ts:977-986`)
  that **resets on every gateway/daemon restart**. It does **not** read the
  persistent `recall_count` column.

So the work is *not* "invent a boost." It is: **(a) make the boost consume the
persistent column, and (b) fix the capture so the column actually accumulates.**

## 3. The three gaps (validated against the live system)

| # | Gap | Evidence | Effect |
|---|-----|----------|--------|
| 1 | **Ephemeral.** The live boost uses an in-memory map, not the DB column. | `retriever.ts:807` vs `recall_count` schema at `memory.ts:222` | Boost is lost on restart; fresh processes start cold even for well-worn memories. |
| 2 | **MCP `memory_recall` tool never bumps `recall_count`.** | `mcp-server.ts:198-284` — neither the retriever path (`:246`) nor the BM25 fallback (`:266`) calls `recordRecalls`/`recordRecall`. Only the plugin auto-recall hook bumps (`index.ts:1343-1344`). | The **daemon's primary explicit recall path is uncounted.** A memory recalled 50× via the MCP tool still shows `recall_count = 0`. |
| 3 | **Near-empty signal today.** | Live pool: 267/269 memories at `recall_count = 0` (99.26%); the only 2 non-zero are at 1. | A persistent boost is a **no-op today** — *because* of gaps 1–2, not because the idea is wrong. It activates as capture is fixed. |

**Persistence state (good):** the column exists, is typed `INTEGER DEFAULT 0`,
has zero NULLs, and is incremented idempotently via
`UPDATE … SET recall_count = COALESCE(recall_count,0)+1` (`memory.ts:848-856`).
`last_recalled_at` is tracked alongside it. The column is already consumed by
the dreaming deep sweep (`dreaming.ts:158-172`) for importance re-scoring and by
`memory_stats`. So persistence works — it is just *under-fed* and *unused by live
retrieval*.

## 4. Recommended design: persistent bounded log-additive boost

**Prerequisite (do first or together):** fix gap #2 — bump `recall_count` on the
MCP `memory_recall` path. Without it the boost stays a no-op. Concretely: in the
`memory_recall` handler (`mcp-server.ts:198-284`), collect the returned ids on
both sub-paths and call `store.recordRecalls(ids)` (best-effort, mirroring
`index.ts:1343-1344`). This is a small, standalone correctness fix.

### 4.1 Formula

```
boost      = min(MAX_BOOST, F * log2(1 + recall_count))
finalScore = clamp01(rawScore + boost, floor = rawScore)
```

| Constant | Value | Rationale |
|----------|-------|-----------|
| `F` | `0.015` | ~1.5% per log2 unit. First recall → +0.015 (a visible tiebreaker); flattens fast. |
| `MAX_BOOST` | `0.10` | Matches the existing `recencyBoost` cap (`retriever.ts` `recencyWeight: 0.10`) and the current ephemeral `freqBoost` ceiling — the two popularity/recency signals have comparable max influence. |

Cap saturates at `recall_count ≥ 2^(0.10/0.015) − 1 ≈ 101`. With ~269 memories
that is effectively unreachable, so the cap is a safety bound, not the operating
point.

### 4.2 Why it is bounded (proof)

1. `log2(1+n)` is concave: each additional recall contributes **strictly less**
   marginal boost (derivative `1/((1+n)·ln 2) → 0`). Diminishing returns is built in.
2. `min(MAX_BOOST, …)` hard-caps the contribution at `+0.10` for all `n`.
3. `clamp01(…, floor = rawScore)` guarantees the score never drops below its
   pre-boost value and never exceeds 1.0.
4. Net: the boost is a **tiebreaker**, never a ranking inverter — a 0.15-relevance
   memory capped at +0.10 (≤0.25) still loses to an 0.80-relevance memory (§6, Test 4).

### 4.3 Cold-start fairness

- `recall_count = 0 → boost = 0`. New/never-recalled memories take **no penalty**.
- The curve is **steepest at low counts** (0→1 is the single largest step), which
  is exactly where discrimination is most valuable ("proven useful once").
- Established memories cannot run away because of the cap + concavity.

### 4.4 Hook points (from the pipeline map)

The memory pipeline is `MemoryRetriever.retrieve()` (`retriever.ts:400-473`),
ordered: fuse → rerank → recencyBoost → importanceWeight(+old ephemeral freqBoost)
→ lengthNorm → timeDecay → adaptiveMinScore → noise → recentlyRecalledPenalty →
MMR → slice. All scores are normalized to `[0,1]` via `clamp01` at every step
(`retriever.ts:175-178`), so an additive boost is well-behaved everywhere.

- **Replace** the ephemeral `freqBoost` inside `applyImportanceWeight`
  (`retriever.ts:806-808`) with the persistent formula reading
  `r.entry.recall_count`. Same call site, bounded the same way, but survives
  restart and counts every recall path (once gap #2 is fixed).
- **Unified path:** apply the same boost inside
  `applyPostMergeModifiers` (`unified-retriever.ts:524-567`) to **both** sources.
  Documents have no `recall_count` → `boost = 0` (correct no-op); the current
  `if (r.source !== "conversation") return r;` early-return at `:528` must be
  relaxed so documents still receive the (zero) boost path uniformly.
- **Documents pipeline (`search.ts` `hybridQuery`):** has *zero* frequency signal
  today. A future iteration can add document-level recall tracking; out of scope
  for v1 (documents are static content; the asymmetry is acceptable).

### 4.5 Schema/type change required

`MemoryEntry` (`memory.ts:21-33`) does **not** expose `recall_count`. Retrieval
cannot read it without either (a) adding `recall_count?: number` to `MemoryEntry`
and including `m.recall_count` in the `vectorSearch` (`memory.ts:~637`) and
`bm25Search` (`memory.ts:~689`) `SELECT` lists, or (b) a batched side query.
Option (a) is simpler and keeps the hot path single-query.

## 5. Alternatives considered

- **Multiplicative, hard-capped:** `score *= (1 + min(C, k·recall_count))`.
  Simple, but a *linear* `recall_count` term (even capped) is stiffer than log at
  low counts and needs the cap to do all the bounding work; it also compounds
  multiplicatively with importance, double-counting "value." Log-additive keeps
  frequency and importance orthogonal.
- **Frequency-as-prior via RRF:** treat `recall_count` ranking as a third list
  fused into `reciprocalRankFusion` (`search.ts:2798`) alongside vector + BM25.
  Elegant and inherently bounded (`1/(k+rank)`), and the most natural fit for the
  *document* pipeline — but the *memory* pipeline is not RRF-based (it's
  z-score+sigmoid fusion → multiplicative modifiers), so it would apply cleanly
  to only half the system. Log-additive applies uniformly to both.
- **Bayesian shrinkage / EMA:** decay `recall_count` over time + shrink toward
  the pool mean. Most principled for cold-start and rich-get-richer, but the most
  machinery for a signal that is currently 99% zero. Defer to a v2 if cap +
  concavity prove insufficient in practice.

**Recommendation:** log-additive (§4). It is the smallest change that makes the
*existing* bounded boost persistent and well-fed, applies uniformly, and its
bounding is provable. Revisit RRF-prior if/when document recall tracking lands.

## 6. Anti-rich-get-richer

The cap (0.10) + log concavity bound the per-memory advantage. As a **v2 lever**
if a memory saturates the cap (101+ recalls) and staleness becomes a concern,
add a slow nightly decay to `recall_count` in the deep sweep (e.g.
`recall_count = recall_count * 0.99`), so "proven useful in 2024" does not
permanently outrank "useful now." Not needed at current pool volumes.

## 7. Validation against current reality

- The boost is a **no-op for 99.26% of the pool today** (`recall_count = 0`).
  This is the *correct* outcome given the capture gaps — it means deploying the
  boost is safe (it changes nothing until signal accumulates) and that **gap #2
  (MCP capture) is the highest-leverage fix**, not the formula.
- Recall quality benchmarks (LongMemEval, domain-eval) will not move until the
  pool warms up. Do not claim benchmark wins from this change; measure pool
  `recall_count` distribution over weeks as the leading indicator instead.

## 8. TDD plan (acceptance criteria before implementation)

1. **Zero is identity.** Two identical memories with `recall_count = 0` retrieve
   at equal score, identical to the no-boost pipeline.
2. **Cap holds.** A memory with `recall_count = 10_000` and `rawScore = 0.50`
   yields `finalScore ≤ 0.60` and `≤ 1.0`.
3. **Concavity.** `boost(5) − boost(1) < boost(1) − boost(0)`; `boost(0) === 0`.
4. **Relevance dominance.** A weak semantic match (0.15) with `recall_count = 100`
   still ranks below a strong match (0.80) with `recall_count = 0`.
5. **Persistence survives restart.** Recall a memory, restart the retriever
   (in-memory map cleared), re-retrieve → boost is present (reads DB column).
6. **MCP capture (gap #2).** Recall a memory via the `memory_recall` MCP tool →
   its `recall_count` increments by 1 and `last_recalled_at` updates.
7. **Unified path applies to both sources.** A conversation memory with
   `recall_count = 5` gets a non-zero boost; a matched document is unchanged.

## 9. Open questions / future

- Document-level recall tracking (separate column / table) so `search.ts`
  `hybridQuery` can participate.
- Transactional hardening: `store.recordRecalls()` is best-effort
  (`index.ts:1344` try/catch); consider a write-ahead/retry so persistent count
  doesn't drift below true frequency.
- Nightly `recall_count` decay (§6) if saturation becomes real.
- Surface `recall_count` / `last_recalled_at` in `memory_list` for observability
  (relates to the deferred scope-visibility work on readable scope tags).
