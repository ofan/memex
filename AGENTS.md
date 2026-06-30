# memex

Unified memory plugin for OpenClaw — conversation memory + document search in a single SQLite database. **~892 tests, 51 files.**

## Architecture

```
memex (kind: "memory")
├── SQLite (FTS5 + sqlite-vec)
│   ├── memories table — recall, store, forget (5 MCP tools + 2 plugin tools)
│   ├── memory_scopes table — multi-valued scope tags per memory
│   ├── documents + content — markdown chunking, dual-granularity FTS
│   └── vectors_vec — shared vector store (memories + documents)
├── Scope Derivation — server-authoritative tag derivation (src/scope-derive.ts)
├── Unified Retriever — z-score fusion, max-sim chunked embedding, tag-intersection scoping, reranking
├── Dreaming — scope-aware dedup, reflection, noise removal (src/dreaming.ts)
├── MCP Server — stdio/HTTP daemon, cross-device access (src/mcp-server.ts)
└── Embedding — OpenAI-compatible HTTP client, LRU cache
```

## Retrieval Quality — known issues + redesign (2026-06-29)

Recall is **not store-invariant**: for old or sparse topics a genuinely relevant memory ranks
below recent garbage, and ~`limit` results come back almost regardless of relevance. Root-caused
in `src/retriever.ts`:

1. **Temporal override** — additive recency `+exp(-age/14)*0.10` AND multiplicative
   `timeDecay ×(0.5+0.5*exp(-age/60))` compound; both universal, applied post-rerank with no
   relevance gate. A 1-day-old memory gets ~+0.09 and ~×1.0; a 60-day-old relevant one gets ~+0
   and ×0.60. The ~0.4-pt temporal swing exceeds the ~0.15 relevance spread.
2. **Dead reranker** — `rerank="cross-encoder"` (jina-reranker-v3) is the default, but
   `rerankApiKey` is unset, so the cross-encoder is silently skipped every query. The system
   runs vector+BM25 only.
3. **No confidence floor / always pads** — `applyAdaptiveMinScore = max(best*0.3, 0.15)` returns
   ~`limit` results almost no matter what. No abstention (return 1, or 0).
4. **Miscalibrated fusion** — `fusionMethod="weighted"` (raw cosine[0,1] × unbounded BM25). The
   file header claims RRF but the default is weighted; RRF is a supported option.
5. **Counter disconnected** — `recordRecalls` (DB `recall_count`) runs only on the auto-inject
   path; `memory_recall` increments only an in-memory `recallFrequency`. `neverRecalled 99%` is
   an artifact, not a real signal.
6. **dream "deep" ≠ cleanup** — `deepSweep` is ephemeral/session-import decay only; dedup +
   noise removal live in `lightSweep`. Running "deep" no-ops when nothing qualifies.
7. **Provenance stripped** — `sources` (vector/lexical/reranked) is tracked internally but
   omitted from the `memory_recall` output.

**Redesign (design only, not implemented):** `docs/design/retrieval-redesign.md` — RRF fusion,
revive a **local** cross-encoder reranker (via the llama-swap infra; rerank-client format
compat with the `/rerank` endpoint is TBD), cap+gate temporal signals, confidence floor 0.40 +
AutoCut + abstention (return 1 or 0), and expose provenance. Research-grounded; citations in
the doc. **Build order:** cheap-and-model-free first (RRF + cap temporal + z-score-calibrated
cosine floor + abstention ⇒ store-invariant, zero added latency); add the reranker last and
only if precision still falls short (~1–3s/query on Apple Silicon for top-K).

## Key Files

| File | Purpose |
|---|---|
| `index.ts` | Plugin entry point, hooks, auto-recall |
| `src/memory.ts` | Memory CRUD, vectorSearch (max-sim), chunked embedding |
| `src/search.ts` | Document search (FTS5, sqlite-vec, chunking) |
| `src/unified-retriever.ts` | Single-pass retrieval pipeline |
| `src/scopes.ts` | Scope manager, tag-intersection filter |
| `src/scope-derive.ts` | Server-authoritative scope derivation |
| `src/tools.ts` | Agent tools (recall, store, forget) |
| `src/dreaming.ts` | Background consolidation, scope-aware dedup, reflection |
| `src/mcp-server.ts` | Standalone MCP server (stdio + HTTP), cross-device access |
| `src/embedder.ts` | Embedding client + LRU cache |
| `src/noise-filter.ts` | Noise detection + filterAssistantText |
| `src/capture-windows.ts` | Sliding window builder |
| `src/memory-instructions.ts` | System prompt instruction |

## Docs

| Doc | Purpose |
|---|---|
| `docs/BENCHMARKS.md` | Current benchmark results |
| `docs/COMPARISON.md` | Cross-system comparison (LongMemEval) |
| `docs/RESILIENCY.md` | Embedding state machine, failure modes |
| `docs/flow.md` | Per-turn pipeline flow |
| `docs/research/` | Ranking math, SOTA survey, baselines |
| `docs/plans/` | Implementation plans (numbered, chronological) |
| `docs/design/retrieval-redesign.md` | Retrieval redesign (noise-robust recall): RRF + local reranker + abstention |

## Constraints

1. Plugin kind: `"kind": "memory"` in openclaw.plugin.json
2. Single SQLite database for both memories and documents
3. TypeScript — tests run via jiti (no build); production build step exists since v0.6.0 (`tsc -p tsconfig.build.json`)
4. All logging uses `console.warn` (stderr) — `console.log` corrupts the stdio protocol
5. Embedding model changes are detected and user is warned (see docs/RESILIENCY.md)
6. Lazy DB init — database opens on first use, not at plugin registration

## Conventions

- Plans location: `docs/plans/`
- Docs numbered sequentially (001, 002...), chronological order
- Test: `node --import jiti/register --test tests/*.test.ts`
- Deploy: `rm -rf ~/.openclaw/plugins/memex && cp -r . ~/.openclaw/plugins/memex && rm -rf ~/.openclaw/plugins/memex/.git ~/.openclaw/plugins/memex/.clone && openclaw gateway restart`
- No `console.log` — use `console.warn`
- Embedding server URL via env var `EMBED_BASE_URL`, never hardcoded
- Test data must be anonymous — no real IPs, usernames, or env-specific references

## Performance

| Operation | Latency |
|---|---|
| Unified retriever | ~150ms p50 |
| Embed (cached) | <0.03ms |
| Vector search (1.9K) | ~4ms |
| BM25 search | <0.3ms |

Spec directories live under `specs` unless a nested AGENTS.md documents a more specific convention.
Spec directory names use `YYYY-MM-DD-kebab-feature`, for example `2026-05-01-spec-lifecycle-audit`.
Spec directories include a free-form `MILESTONES.md` implementation log for milestones, setbacks, fixes, validation notes, and decisions.
