# Post-v0.6.2 Roadmap

**Created:** 2026-05-10
**Context:** v0.6.2 just shipped to ClaHub (citation-anchored recall + dep hygiene + build step). v0.7 branch has all the daemon / dreaming / entity-graph / Claude Code plugin work pending architectural decisions. This document is the punch list for what comes next, organized by urgency and energy required.

## Principle

Architectural decisions deserve fresh attention, not session-fatigue energy. Quick wins and tech-debt cleanup can happen anytime. The two should not be mixed.

---

## Tier 1 — Close the dangling threads (next session, low cognitive load)

These are the items that finish work already in flight. ~1-2 hours total.

### T1.1 Verify v0.6.2 install end-to-end
- `clawhub package install @ofan/memex --dir /tmp/test-install`
- Inspect what landed; confirm dist/ and manifests are present
- Smoke-test it loads (load `dist/index.js` or wire it into a throwaway openclaw config)
- Closes the loop on the publishing saga
- **Done when:** install succeeds, files inspected, plugin loads without error

### T1.2 Backport citation completeness to v0.7's MCP server
- v0.7 has `src/mcp-server.ts` with `memory_recall` and `memory_forget` tools that still return full UUIDs
- Port the anchor format + `memory_forget` anchor-prefix support from v0.6.2's `src/tools.ts` into v0.7's `src/mcp-server.ts`
- Add tests
- Should reuse the existing `src/anchor.ts` helper (already on v0.7 from the backport)
- **Done when:** both tools return `[mem:abc12345]` format consistently; `memory_forget` accepts anchor prefix; tests pass

### T1.3 Cosmetic backlog cleanup
- Delete `rename-to-memclaw` branch on origin (likely an old experiment)
- Decide what to do with v0.6.0 / v0.6.1 tags (failed-publish records — keep as historical or delete)
- Drop the empty test commits `885fecb` and `d289f8b` from main if they bother you (not strictly necessary)
- **Done when:** branch list is clean; tag list reflects intentional state

---

## Tier 2 — Architecture decisions for v0.7 (fresh-head session required)

These four questions block v0.7 from converging. Each requires a real decision, not just code. Recommend a dedicated session for these — possibly a brainstorm with the SOTA research doc as input.

### T2.1 Doc corpus location across devices
**Question:** Where do indexed documents live when memex serves multiple devices?
- Option A: Daemon co-located with docs (single source of truth on dev VM; other devices query)
- Option B: Per-device docs + cross-device shared memory (clients run their own retriever for local docs, query daemon for memory only — breaks unified abstraction)
- Option C: Docs uploaded to daemon (privacy/sync overhead but preserves unified retrieval)
- **Entangled with:** T2.2 (daemon location)

### T2.2 Daemon location
**Question:** Mac mini-1 vs dev VM permanent home?
- Currently runs on dev VM as systemd user unit
- Mac mini-1 has the embedding server already (Qwen3-Embedding-4B-Q8_0 + Qwen3-Reranker-0.6B-Q8_0)
- Migration cost: launchd unit + secret transfer
- **Done when:** decision made + (if migrating) launchd unit set up and verified

### T2.3 Offline behavior
**Question:** Fail-closed (no memory when daemon unreachable) vs read-only local cache?
- Fail-closed is simple — no offline UX
- Cache adds sync complexity but preserves UX
- WorldDB-style content-addressed memory IDs would make eventual sync deterministic
- **Done when:** decision made; if cache, design documented

### T2.4 Correction semantics
**Question:** How should memex handle conflicting / superseded memories?
- Camp A (Mem0): self-edit on conflict (loses correction history)
- Camp B (Zep/Hydra): bitemporal append-only (validity intervals)
- Camp C (WorldDB): content-addressed immutable (Merkle audit trail)
- Memex is currently Camp C-ish via dreaming/learnings two-tier
- **Done when:** explicit choice documented; if changing, schema migration designed

**Reference:** [`docs/research/003-memory-retrieval-sota.md`](../research/003-memory-retrieval-sota.md) §10–11 for camp definitions and trade-offs.

---

## Tier 3 — Code quality / tech debt (anytime, mechanical)

### T3.1 Fix the 42 latent type errors
- Run `npx tsc` (without `--noCheck`) to see the list
- Categories: missing optional handling (`config.documents` possibly undefined), missing module declarations (`@lancedb/lancedb` — likely dead code), better-sqlite3 `pluck` type gap, typebox version mismatch (`stringEnum` returns `TUnsafe`), schema drift (`LLMSessionOptions.timeout`)
- Probably 1-3 hours; mostly mechanical
- Could be a focused PR or split into batches

### T3.2 Re-enable type checking in CI
- Once T3.1 is done, change build script from `tsc --noCheck` to real `tsc`
- Future type errors will fail the build
- ~5 min once T3.1 is done
- **Depends on:** T3.1

### T3.3 Pre-commit hook drama
- The `host-1`-style hostname block we hit during the v0.7 backport cost time
- Decide: hook is worth its cost OR loosen to allow comments mentioning example hostnames
- Probably loosen to "block secrets and infra refs in CODE PATHS, not comments"
- 30 min if changing the hook

---

## Tier 4 — Validation / observability (when motivated)

### T4.1 ENGRAM-R live verification
- Watch a Claude Code turn in production produce `[mem:...]` citations
- Confirms the prompt-engineering pass is actually working
- Manual: ~10 min once you have a session to observe

### T4.2 Run memex against MemoryAgentBench
- Open-source successor benchmark from `arXiv:2507.05257`
- Will honestly surface selective-forgetting weakness (field caps at 7%)
- Repo: `github.com/HUST-AI-HYZ/MemoryAgentBench`
- **Done when:** benchmark runs against memex, results documented in `docs/research/`
- 1-2 hours

### T4.3 Citation telemetry
- Track what % of recalls produce `[mem:...]` references in LLM responses
- Validates the prompt-engineering pass at scale (vs anecdotal observation)
- Requires post-turn parsing of LLM output — could land in dreaming or as separate pass
- 1 hour

---

## Tier 5 — New features (deferred indefinitely)

These are real research lanes but not 2026 priorities. Listed for awareness.

- **T5.1 FadeMem-style explicit half-life decay** — replaces ad-hoc decay; reported 45% storage savings vs Mem0. ~1-2 hours.
- **T5.2 RL-trained memory ops (AgeMem-style discard)** — only after dreaming is well-validated; reward-model fragility >64K tokens caps reliable supervision range. Multiple weeks if pursued seriously.
- **T5.3 Multimodal memory (MemLoRA-V style)** — Claude Code transcripts include screenshots; memex doesn't index them. Cost: significant (vlm in stack). Defer until a use case demands it.
- **T5.4 Causal grounding (ARGORA / STITCH-style)** — research direction, no SOTA winner yet.

---

## Recommended sequencing

If you want to ship something useful in the next week without making big architectural decisions:
1. **T1.1 + T1.2** in one session (close publishing loop + finish citations on v0.7) — ~1 hour
2. **T1.3** when you remember (cleanup) — 15 min
3. **T3.1 + T3.2** as a focused weekend block (fix types, re-enable real type-check) — half day

When you have fresh-head energy and want to make architectural progress:
4. **T2.1–T2.4** in one focused session, ideally with the SOTA research doc open. The decisions don't need code — they need a notes document. Code follows the decisions.

When motivated:
5. **T4.2** (MemoryAgentBench) — produces real, quotable, defensible numbers vs the LongMemEval-tinged historical claims.

Defer indefinitely:
6. Tier 5.

---

## Explicit non-goals

- **Don't backport more from v0.6.2 to v0.7 beyond the citation MCP server work.** The two branches will diverge as v0.7 picks up architectural changes; backports add cost.
- **Don't pursue ClaHub publishing for v0.7 prematurely.** Wait until v0.7 actually has a meaningful release narrative — no more interim 0.7.0-dev publishes.
- **Don't try to "win" benchmarks.** Per the SOTA research, vendor benchmark numbers are unreliable and the field has moved past them. Memex's positioning is cost + governance + cross-device pool.

---

## Status of underlying questions

| Decision | Status | Reference |
|---|---|---|
| MCP/HTTP/CLI process model | Tentative: single daemon, HTTP transport, CLI as thin client | Earlier in conversation |
| Shared DB | Tentative: daemon-owned single SQLite | Earlier in conversation |
| Memory categories | Partially settled: episodic/semantic/procedural × device/project/agent + source-of-truth | `two-problems-architecture.md` |
| Doc corpus location | **Open** | T2.1 |
| Daemon location | **Open** | T2.2 |
| Offline behavior | **Open** | T2.3 |
| Correction semantics | **Open (Camp C-ish currently)** | T2.4 |
| Protocol choice | Settled: MCP for v0.6, REST for v0.7+ | Earlier in conversation |
| Citation feature | Complete on v0.6.2; partial on v0.7 (T1.2 closes this) | `docs/research/003-memory-retrieval-sota.md` |

---

## Pointers

- **Consolidated SOTA research:** [`../research/003-memory-retrieval-sota.md`](../research/003-memory-retrieval-sota.md)
- **Two-problems architecture (live design):** [`two-problems-architecture.md`](./two-problems-architecture.md)
- **CHANGELOG (current state):** [`/CHANGELOG.md`](../../CHANGELOG.md)
