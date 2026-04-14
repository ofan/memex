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

## 7. Open Questions (updated)

1. Should memex offer a **BM25-only zero-config mode** as the default, with embeddings as an upgrade? (Currently the opposite — embeddings expected, BM25 as fallback.)
2. Should memex adopt the **hot/cold tier** pattern for context injection? (Small always-in-context summary + deeper recall on demand.)
3. Should memex add **write-time contradiction detection** as a lightweight alternative to full dreaming reflection?
4. Is per-project DB the right default, or should memex default to **global with project scoping**?
5. Should memex **generate MEMORY.md** sections that Claude Code's built-in system can use? (Complement the built-in, don't compete with it.)
