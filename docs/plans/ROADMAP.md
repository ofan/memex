# Memex Roadmap — Path to SOTA Memory System

**Original date:** 2026-04-12 (historical vision document)
**Status as of 2026-07-11:** Projects 1-3 shipped. Pool stats, domain-eval metrics, and "where memex is" below reflect April 2026 state; see PROGRESS.md for current metrics.
**Research base:** 15 SOTA iterations (`agent-memory-sota-2026.md`), data quality research (`006-data-quality-research-apr2026.md`), session learnings (`LEARNINGS.md`)

---

## Where memex is

Memex has a strong **retrieval** system (94% E2E, rank-mode reranking, z-score fusion, confidence-gated skip). But it's a retrieval system, not a memory system. The difference:

- A **retrieval system** stores things and finds them.
- A **memory system** stores, organizes, maintains, evolves, and intelligently surfaces knowledge.

The pool tells the story: 2,111 memories, 79% session import noise, 99% never recalled, 21 memories carrying all the actual value. The retrieval pipeline is excellent at finding needles — but the haystack is 80% straw.

## What SOTA looks like (2026)

Every leader has something memex doesn't:

| System | Key differentiator | Memex gap |
|---|---|---|
| **Mastra OM** (94.87%) | Background Observer + Reflector agents compress history into stable context. No retrieval at all. | No background processing. Dreaming exists but doesn't run automatically and has no LLM reflection. |
| **HyperMem** (92.73%) | Topic → episode → fact hierarchy. Coarse-to-fine retrieval. | Flat store. No hierarchy. All memories compete equally. |
| **Hindsight** (91.4%) | 4 specialized networks + narrative chunking + graph traversal | Single undifferentiated pool. Session import uses worst-possible chunking (3 turns, 500 char truncation). |
| **MemMachine** (91.69%) | Sentence-level episode indexing, 80% token reduction, ground-truth preserving | No episode structure. No compression. |
| **xMemory** | Uncertainty-gated retrieval — returns abstracts first, drills down on demand | Always returns raw memories, no abstraction layer. |

The common pattern: **structured knowledge with active maintenance**. Not just store-and-retrieve.

## What we learned from failures

Three quality projects shipped with zero improvement:
1. **Entity boost** — BM25 already captures keyword matching. Double-counting the same signal.
2. **Entity graph** — correct memories weren't reachable from top hits via graph.
3. **Blend weight sweep** — raw-score blending dissolved reranker ordinal signal (fixed by rank-mode).

The lesson (from LEARNINGS.md): **don't implement what a paper describes — implement what makes their results different.** And: **diagnose actual failures before scoping solutions.**

## The gap: five missing capabilities

### 1. Memory lifecycle
Memories are created and sit forever. No evolution, no consolidation, no reflection. The dreaming mechanical sweeps (dedup, noise, decay) clean surface garbage but can't synthesize knowledge or detect contradictions.

### 2. Intake quality
Session import dumped 1,666 short fragments on March 14 using tiny sliding windows (3 turns, 500 char truncation). Research consensus: narrative chunking by topic boundaries + frontier model extraction + two-phase dedupe against existing store. The extraction prompt is the make-or-break element (Mem0's defaults → 97.8% junk).

### 3. Pool hygiene
No semantic near-duplicate detection. No contradiction detection. No staleness detection (a high-confidence memory becomes wrong when facts change — worse than no memory). Deep sweep's age-based decay is too slow (90 days to reach 0.1).

### 4. Memory structure
Flat store with importance scores. No hierarchy (topic → episode → fact), no typed networks (world/experience/opinion), no temporal validity windows. Categories exist (fact/decision/preference) but don't influence retrieval.

### 5. Active observation
Auto-capture is passive — nudges the LLM to call `memory_store`. Mastra and Letta use background agents that actively observe conversations and extract knowledge. The sliding-window capture code exists (`capture-windows.ts`) but is dormant.

---

## The path

Ordered by dependency and impact.

```
1. Pool Cleanup → 2. MCP Server → 3. Dreaming Reflection
                                 → 4. Session Import v2
                                 → 5. Model Bakeoff
                                      → 6. Memory Hierarchy (future)
```

### Project 1: Pool cleanup ✅ SHIPPED (v0.7.x)
**Goal:** Remove the noise floor so every subsequent improvement has clean data to work with.

**What:**
- Aggressive decay for session imports: source=session + never-recalled + importance=0.3 → decay to 0.1 after 14d, evict after 30d
- Semantic near-duplicate detection: cluster by embedding similarity, merge or delete clusters
- Manual audit of surviving high-importance memories for accuracy

**Why first:** Every other project builds on the pool. Reflection on garbage produces garbage insights. Better extraction into a noisy pool just adds more noise. Clean first.

**Research backing:** Mem0's 97.8% junk finding. MemMachine's 80% token reduction. xMemory's token efficiency.

**Measured by:** Pool size reduction, domain eval stability (should not regress), never-recalled ratio drop.

**Shipped as:** Dreaming mechanical sweeps (dedup, noise removal, re-scoring, reflection). 13 noise entries purged (LLM meta-commentary). CoT/meta-commentary noise rule added.

### Project 2: MCP server ✅ SHIPPED (v0.7.0)

**Shipped as:** `src/mcp-server.ts` with HTTP+stdio transports, bearer auth, `/health` endpoint. Deployed via systemd+jiti behind Tailscale. Dockerfile built + smoke-validated. Cross-platform (OpenClaw + Claude Code). See original vision below:

**Goal:** Memex as a standalone, always-on memory server. Cross-platform. Enables background processing.

**What:**
- MCP server over stdio — 5 tools (recall/store/forget/dream/stats)
- Shared SQLite DB between OpenClaw plugin and MCP server
- Background dreaming timer (reflection runs on schedule in the server process)
- Claude Code integration via `.mcp.json`

**Why second:** MCP is **infrastructure, not a feature**. The #1 gap with SOTA (Mastra, Letta) is no background processing. The MCP server is a long-lived process that enables:
- Auto-dreaming (no OpenClaw `service.start()` lifecycle issues)
- Active conversation observation (Mastra Observer pattern)
- Cross-platform memory (OpenClaw + Claude Code + Cursor + any MCP client)
- Solves issue #8 (lazy DB init) — MCP server owns its own lifecycle

**Research backing:** Mastra's Observer+Reflector architecture. Letta's sleep-time agents. MCP as universal agent integration layer.

**Measured by:** Platforms supported (≥2), background dreaming running, latency overhead (<10ms).

### Project 3: Dreaming reflection ✅ SHIPPED (v0.7.0)

**Shipped as:** Light sweep + deep sweep + LLM reflection phase (`src/dreaming.ts`). Reflection runs via `/dream` command or on a schedule in the MCP server. Dedicated LLM endpoint supported. See original vision below:

**Goal:** LLM-driven knowledge synthesis — turn scattered facts into coherent learnings.

**What:**
- Stanford-style question synthesis: threshold trigger → generate questions → retrieve per question → synthesize insight → store as `category: "learning"`
- Contradiction detection: find semantically similar memories, check temporal consistency, mark older contradicted ones with `superseded_by`
- Memory evolution: update stale memories with new context rather than just decaying them (A-MEM pattern)
- Runs as part of MCP server's background dreaming cycle

**Why third:** After cleanup gives clean data and MCP server provides the runtime, reflection produces knowledge synthesis. Insights are higher-level than raw facts — the hierarchy emerges naturally.

**Research backing:** Stanford Generative Agents (proven, simple), Graphiti bi-temporal contradiction detection, A-MEM memory evolution, Letta sleep-time validation.

**Measured by:** Number of learnings generated, contradiction resolution rate, domain eval improvement.

### ~~Project 4: Session import v2~~ — KILLED

Session import was an OpenClaw-specific workaround for backfilling from historical conversations. Now that memex is an MCP server with real-time capture (`memory_store` tool), facts get extracted during conversation — no batch import needed. The 1,666 garbage session imports get evicted by cleanup decay rules. Going forward, the memory lifecycle is: **capture → store → reflect → synthesize**.

Agents that want to bulk-import memories can use the `memory_store` MCP tool directly.

### Project 4: Model bakeoff 🔄 PARTIAL (ongoing)
**Goal:** Evaluate whether newer models improve retrieval without architectural changes.

**What:**
- EmbeddingGemma-300M — 10x smaller than current Qwen3-Embedding-4B, MRL dimension truncation
- Contextual AI Reranker v2 — instruction-following, +35% recency-awareness, open-source
- Run through existing bakeoff harness (domain eval + fast benchmark + optional E2E)

**Why fifth:** Model improvements are incremental. Architecture improvements (projects 1-4) have higher leverage. But once the data is clean, better models can provide additional gains.

**Research backing:** EmbeddingGemma-300M benchmarks, Contextual AI Reranker v2 recency findings.

**Measured by:** Domain eval, LongMemEval R@1/R@3/E2E, latency.

### Project 5: Memory hierarchy (future)
**Goal:** Evolve from flat store to structured knowledge — topic → episode → fact.

**What:**
- Dreaming reflection naturally produces higher-level memories (learnings, insights)
- Cluster memories by topic, generate topic summaries
- Coarse-to-fine retrieval: match topics first, then drill into facts (HyperMem pattern)
- Uncertainty-gated expansion: return abstracts first, detail on demand (xMemory pattern)

**Why last:** Hierarchy emerges from reflection (project 3) and clean data (project 1). Building hierarchy on a noisy flat store would be premature structure. Let the lifecycle produce the hierarchy naturally.

**Research backing:** HyperMem hypergraph, xMemory 4-level hierarchy, MACLA 15:1 compression.

---

## What we're NOT doing (and why)

| Item | Why not |
|---|---|
| Entity boost / entity graph | Tried, measured, net-neutral. BM25 captures the same signal. Gated off. |
| Knowledge graph (Neo4j/Graphiti-style) | Overhead doesn't pay off at 2K entries. Graph shines at 100K+. |
| Small model extraction (< 7B) | Research consensus: not viable without fine-tuning. All production systems use frontier models. |
| Mastra-style no-RAG architecture | Fundamentally different approach requiring large context windows. Interesting but incompatible. |
| Full BEIR benchmark suite | Bakeoff harness covers the critical path. Academic overhead. |
| ~~MCP server~~ | **PROMOTED to Project 2.** Enables background processing (the #1 SOTA gap), cross-platform memory, and solves issue #8. |
| Session import v2 | **Killed.** Real-time capture via `memory_store` replaces batch import. Platform-agnostic. |
| Procedural memory | New category, not a quality improvement. Future. |

---

## Success criteria

**Note:** This table reflects April 2026 targets. Current state (July 2026) summarized below.

| Metric | April 2026 | Target | Which project |
|---|---|---|---|
| Pool noise ratio | ~79% | < 20% | 1 (cleanup decay) |
| Never-recalled ratio | 99% | < 60% | 1 (cleanup) + 3 (reflection) |
| Domain eval | 12/15 (80%) | >= 14/15 | 3 (reflection) + 4 (models) |
| LongMemEval E2E | 94% | >= 95% | 3 + 4 |
| Memories with contradictions | Unknown | 0 detected | 3 (reflection) |
| Learnings generated | 0 | 10+ per reflection cycle | 3 (reflection) |

**July 2026 update:** Domain eval is now 26 queries: baseline 69%, cross-encoder 77%, LLM reranker 85% (Wilson CI). MCP path calls `recordRecalls` (F5 fix). LLM reranker added as opt-in second reranker option. See `docs/design/recall-quality-design.md` for the canonical quality plan.
