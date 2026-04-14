# Research: Hermes Agent & Claude Code Memory Landscape

**Date:** 2026-04-13
**Context:** Memex is now an MCP server. How does it fit in the Claude Code ecosystem? What can we learn from Hermes and competitors?

---

## 1. Claude Code Already Has Built-in Memory

This changes the product positioning fundamentally.

| Feature | Built-in | Description |
|---|---|---|
| **Auto Memory** | MEMORY.md | 200 lines / 25KB cap, auto-maintained by Claude |
| **Session Memory** | Auto-injected | Past session summaries (Anthropic API only) |
| **CLAUDE.md** | Manual | Permanent project rules, version-controlled |

Claude Code's built-in Auto Memory already does basic cross-session memory via MEMORY.md. Memex needs to offer something **beyond** what's built in.

## 2. Hermes Agent Memory Architecture

### Built-in (MEMORY.md + USER.md)
- **Frozen snapshot** — injected at session start, never updated mid-session (preserves KV prefix cache)
- **Character-limited** — MEMORY.md: 2,200 chars (~800 tokens), USER.md: 1,375 chars (~500 tokens)
- **Agent-curated** — agent decides add/replace/remove via substring matching
- **At 80% capacity** — agent consolidates before adding
- **No per-project scoping** — global only, which is a significant limitation

### hermes-memory (standalone MCP server)
- **Two-tier hot/cold** — hot: ~150 tokens injected always. Cold: SQLite + FTS5 queried on demand.
- **MEMORY_SPEC notation** — typed prefixes (`C[target]` constraints, `D[target]` decisions, `V[target]` values). 65% token savings over prose.
- **Pressure relief** — at 70/85/95% capacity: auto-dedup, scope archiving, LLM consolidation
- **Scope lifecycle** — scopes auto-close after 6 idle turns, move to cold storage
- **7 MCP tools** — write, search, tick, status, reflect, export, purge
- **Zero infrastructure** — no embeddings, no API keys, just SQLite + FTS5

### Cognitive Memory (proposed, not shipped — issue #509)
- **Write-time consolidation** — on store, check cosine similarity >= 0.85 for contradictions
- **Composite scoring** — `0.5*similarity + 0.3*recency_decay + 0.2*importance`
- **Confidence-based depth routing** — high confidence returns immediately, low triggers deeper search
- **Key insight from production user:** "The consolidation LLM should be a different model from the primary agent" — validates memex's dedicated reflection endpoint.

## 3. Claude Code MCP Memory Landscape

The market is crowded but shallow:

| Server | Approach | Differentiator |
|---|---|---|
| **hermes-memory** | Structured facts, FTS5, hot/cold tiers | Token-budgeted, scope lifecycle |
| **mcp-memory-service** | v10.28.4, auth/admin UI, Docker | Most mature, enterprise features |
| **agentmemory** | Cross-agent shared memory | Works across Claude Code + Cursor + Gemini CLI |
| **ClawMem** | Hybrid RAG | Both OpenClaw plugin and MCP server |
| **claude-mem** | LLM compression, semantic search | Web dashboard |
| **mcp-memory-keeper** | Lightweight persistence | Simple `~/mcp-data/` storage |
| **neural-memory** | Neuron/synapse metaphor | SQLite-backed |

**None offer:** embedding-based semantic retrieval with reranking, offline dreaming/reflection, or benchmark-validated quality (R@1=82%, E2E=94%).

## 4. What Memex Uniquely Offers

| Capability | Memex | Hermes | Others |
|---|---|---|---|
| Semantic retrieval (embeddings + reranking) | Yes (94% E2E) | No (FTS5 only) | Mostly no |
| Offline dreaming/reflection | Yes (3 phases) | Proposed, not shipped | No |
| Contradiction detection | Yes (SUPERSEDED markers) | Proposed (cosine >= 0.85) | No |
| Unlimited capacity | Yes (SQLite + vectors) | 800 tokens (built-in), unlimited cold (hermes-memory) | Varies |
| Per-project scoping | Yes (via DB path) | No (global only) | Some |
| Benchmark-validated | Yes (LongMemEval, domain eval) | No | No |
| Background processing | Yes (dreaming timer) | No | No |

## 5. Patterns to Adopt from Hermes

### 5a. Hot/cold tier (from hermes-memory)
Instead of always injecting full memory text, maintain a small "hot" context (~150-300 tokens) of the most critical facts, with deeper recall on demand. Maps to memex's `autoRecallLimit` but more explicit.

### 5b. Write-time contradiction check (from cognitive memory proposal)
Before storing a new memory, quick cosine check against existing memories (similarity >= 0.85 on same entities). Lighter than full dreaming, catches contradictions immediately instead of waiting for the next dream cycle.

### 5c. Composite recall scoring
`0.5*semantic + 0.3*recency_decay + 0.2*importance` — memex already has these signals but doesn't combine them this explicitly in the final ranking.

### 5d. Separate consolidation model
Use a different LLM for reflection than the one the agent uses. Prevents feedback loops where the agent's phrasing becomes "ground truth." Memex already does this via dedicated `MEMEX_LLM_ENDPOINT`.

### 5e. Scope lifecycle with auto-archival
Memories never referenced in N sessions auto-demote. Similar to memex's recall-count decay but more aggressive.

## 6. Strategic Implications

### Claude Code's built-in memory means memex must differentiate on:

1. **Quality** — semantic retrieval beats FTS5 keyword matching. This is measurable and provable.
2. **Intelligence** — dreaming/reflection produces insights no other system offers.
3. **Scale** — unlimited capacity vs 200-line/800-token caps.
4. **Cross-platform** — works in both OpenClaw and Claude Code (and any MCP client).

### What memex should NOT try to compete on:

1. **Zero-config simplicity** — hermes-memory and Claude's built-in memory win here. Memex requires an embedding endpoint for full features.
2. **Token efficiency** — hermes-memory's MEMORY_SPEC notation and hot/cold tiers are specifically optimized for minimal context injection. Memex injects full text.
3. **Ease of installation** — `pip install hermes-memory` vs memex's multi-step setup.

### The positioning:

**hermes-memory** = lightweight, zero-infra, good enough for most users.
**Memex** = high-quality, embedding-powered, with autonomous dreaming — for users who want the best retrieval and active knowledge management.

Think: **SQLite vs PostgreSQL**. Both are databases. One is zero-config and everywhere. The other is powerful and requires setup. Both have their market.

## 7. Deep Dive: hermes-memory Architecture

### Hot/Cold Tier
- **Hot**: ~150 tokens injected at session start. Deliberately tiny — under 180 tokens regardless of memory size.
- **Cold**: SQLite + FTS5, unlimited, queried on demand. Max 20 results per search.
- **Pressure relief**: 70% → merge duplicates. 85% → archive closed scopes. 95% → LLM consolidation or evict oldest.

### MEMORY_SPEC Notation
Typed prefixes: `C[target]` constraint, `D[target]` decision, `V[target]` value, `?[target]` unknown, `~[target]` obsolete.
Example: `D[auth]: JWT 7j refresh 6j`. 65-78% compression vs prose.

### Scope Lifecycle
Scope = unit of work (feature, bug). Opens on first write. Closes on signals ("merged", "deployed"), 6 idle turns, or 3 turns on different scope. Closed → cold automatically.

### Key insight
hermes-memory is NOT a retrieval system. It's a **structured fact store with lifecycle semantics**. Very different from memex's RAG approach. No embeddings, no semantic search — just typed facts with automatic tiering.

## 8. Deep Dive: Claude Code Built-in Auto Memory

### How it works
- Stored at `~/.claude/projects/<project>/memory/`
- MEMORY.md is a concise index (target: 200 lines / 25KB)
- When details accumulate, Claude creates topic files (`debugging.md`, `api-conventions.md`)
- Topic files NOT auto-loaded — read on demand via file tools
- **Auto Dream** (background sub-agent) consolidates after 24+ hours and 5+ sessions

### Triggers
- Automatic: Claude writes when it learns build commands, style prefs, architecture decisions
- Explicit: "remember that we use pnpm", "save to memory"
- Background: Auto Dream reorganizes between sessions

### Known limitations (user complaints)
- **Silent truncation** — entries past 200 lines silently lost (#39811, #40210)
- **No semantic search** — flat file loading, no meaning-based recall
- **Newest lost first** — append-at-bottom + truncate-from-bottom = recent context discarded
- **No line-count feedback** — Claude never reports proximity to limit
- **No extension API** — `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` disables but no hooks to extend

### Implication for memex
Claude Code's memory is project-scoped (`~/.claude/projects/<project>/`), plain markdown, has a background consolidation agent, but has hard capacity limits and no semantic search. The truncation bug is a real pain point memex could solve.

## 9. Deep Dive: Mature Competitors

### mcp-memory-service (doobidoo) — the established choice
- **1,300 stars**, 180+ releases, v10.25.1
- SQLite-vec or ChromaDB backend. Sentence-transformers embeddings. Hybrid retrieval.
- **24 MCP tools** + REST API + HTTP dashboard
- Heavy: Python, PyTorch optional, ~150MB minimum
- LongMemEval ~86% R@5 with session storage
- Setup: Docker (2 min) or pip install

### agentmemory (rohitg00) — the new contender
- **736 stars**, 2 months old, Apache-2.0
- BM25 + vector + knowledge graph fusion (triple-hybrid)
- **43 MCP tools**, 12 auto-capture hooks, real-time viewer
- One command: `npx @agentmemory/agentmemory`
- Cross-agent by default — shared memory across all clients
- Young, API may shift

### Neither approaches memex's quality
- doobidoo: ~86% R@5 vs memex 96% R@5
- agentmemory: unverified claims
- Neither has dreaming/reflection

## 10. Competitive Landscape Summary

| System | Approach | Embeddings | Capacity | Search | Dreaming | Setup |
|---|---|---|---|---|---|---|
| **Claude built-in** | MEMORY.md files | No | 200 lines | No search | Auto Dream | Zero |
| **hermes-memory** | Typed facts, hot/cold | No | Unlimited cold | FTS5 | No | `pip install` |
| **doobidoo** | Vector DB | Yes (sentence-transformers) | Unlimited | Hybrid | No | Docker/pip |
| **agentmemory** | Triple-hybrid | Yes (local) | Unlimited | BM25+vec+graph | No | `npx` |
| **Memex** | SQLite + sqlite-vec | Yes (configurable) | Unlimited | Hybrid + rerank | **Yes (3-phase)** | MCP config |

## 11. Strategic Recommendations

### What memex should do for Claude Code

**Don't compete with built-in Auto Memory on basic persistence.** Claude already does that. Instead:

1. **Semantic recall** — Claude's memory has no search. Memex has 94% E2E retrieval. This is the killer feature.

2. **Dreaming/reflection** — No competitor has offline consolidation. Learnings, contradiction detection, memory evolution. Unique differentiator.

3. **Unlimited capacity** — Claude's 200-line cap with silent truncation is a real pain point. Memex has no cap.

4. **Complement MEMORY.md, don't replace it** — Use Claude's built-in for static project rules. Memex for dynamic knowledge that grows beyond 200 lines.

5. **BM25-only as viable default** — Not everyone has an embedding server. hermes-memory proves FTS5-only is useful. Make BM25 the zero-config path, embeddings the upgrade.

### What memex should NOT do

1. Don't try to be zero-config simpler than `pip install hermes-memory`
2. Don't add 43 tools (agentmemory) — keep the 5-tool surface area
3. Don't build a dashboard or REST API — stay focused on memory quality
4. Don't try to replace CLAUDE.md — it's version-controlled and team-shared

### Open Questions

1. **Should memex generate a `memories.md` file** that Claude's Auto Dream can discover and incorporate?
2. **Should the hot/cold tier pattern** be adopted? (Small injected summary + deep recall on demand)
3. **Should BM25-only be the default** with embeddings as opt-in?
4. **Per-project or global?** Claude Code is project-scoped. Memex is currently global. Should it match?
5. **Write-time contradiction detection** — lightweight cosine check before dreaming, or keep it batch-only?
