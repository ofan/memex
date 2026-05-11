# Projects

## Completed

| Project | Outcome | Date |
|---|---|---|
| Entity Extraction | Shipped, net-neutral. Gated off (entityBoost/entityGraph flags). | 2026-04-09 |
| Temporal Queries | Shipped. Regex date detection + timestamp filtering. | 2026-04-09 |
| SQLite Consolidation (006) | Shipped. LanceDB dropped. Single SQLite DB. | 2026-03 |
| Unified Retriever (009) | Shipped. 10-stage pipeline in `src/unified-retriever.ts`. | 2026-04 |
| Rename Cleanup (007) | Shipped. `src/qmd/` flattened to `src/`. | 2026-03 |
| Retrieval Quality (004) | Shipped. BM25 OR matching + adaptive fusion gate. | 2026-03 |
| Reranker Upgrade | Shipped. Qwen3-Reranker-0.6B + rank-mode scoring + blend weight. | 2026-04-10 |
| Dreaming v1 (012) | Shipped. Light + deep sweep + CLI `/dream` + intake guards + recall tracking. | 2026-04-08 |

## Active Roadmap

See `docs/plans/ROADMAP.md` for strategic context and research backing.

Dependency chain:
```
1. Pool Cleanup → 2. MCP Server → 3. Dreaming Reflection
                                 → 4. Session Import v2
                                 → 5. Model Bakeoff
                                      → 6. Memory Hierarchy (future)
```

---

### Project 1: Pool Cleanup

**Goal:** Remove the noise floor. 79% of pool is session import garbage.
**Branch:** master (small, surgical changes to dreaming)
**Depends on:** nothing

**Diagnosis (required before design):**
- Classify the 1,669 importance=0.3 session imports: what fraction are genuinely useful vs noise?
- Sample 50 random session imports, human-label as keep/delete
- Check if any session imports have ever been recalled (answer: no, 0 of 1,669)

**Metrics:**

| Metric | Baseline | Target |
|---|---|---|
| Pool noise ratio | ~79% | < 30% |
| Never-recalled ratio | 99% | < 70% |
| Domain eval | 12/15 | ≥ 12/15 (no regression) |

**Milestones:**

0. Diagnose — sample + classify session imports (30 min)
1. Design — decay rules, semantic dedup approach
2. Build — update deep sweep with session-import-aware decay
3. Build — semantic near-duplicate detection (embedding similarity clustering)
4. Evaluate — run domain eval, verify no regression, measure pool reduction

**ACs:**
```
AC1: Session imports (source=session, importance=0.3, never-recalled) decay to 0.1 after 14d
AC2: Entries at importance ≤ 0.05 are evicted (deleted)
AC3: Semantic near-duplicates (cosine > 0.95) are merged (keep newest)
AC4: Domain eval ≥ 12/15 after cleanup
AC5: Pool size < 800 after full cleanup cycle
```

---

### Project 2: MCP Server

**Goal:** Memex as a standalone, always-on memory server. Cross-platform. Enables background processing.
**Branch:** `project/mcp-server`
**Depends on:** Pool Cleanup (clean data before exposing to new platforms)

**Why MCP is infrastructure, not a feature:**
- Long-lived process enables auto-dreaming (no OpenClaw lifecycle issues)
- Conversation observation enables active extraction (Mastra Observer pattern)
- Cross-platform enables memory across OpenClaw, Claude Code, Cursor, etc.
- Solves issue #8 (lazy DB init) — MCP server owns its own lifecycle

**Metrics:**

| Metric | Baseline | Target |
|---|---|---|
| Platforms supported | 1 (OpenClaw) | ≥ 2 (+ Claude Code) |
| MCP tools | 0 | 5 (recall/store/forget/dream/stats) |
| Background dreaming | manual only | automatic (interval) |

**Milestones:**

0. Design — transport (stdio), schemas, shared DB, dreaming integration
1. Build — server skeleton, initialize response, tool schemas
2. Build — full tools (recall/store/forget/dream/stats), shared SQLite DB
3. Build — background dreaming timer (reflection runs on schedule)
4. Integration — Claude Code `.mcp.json`, real E2E test
5. Evaluate — verify cross-platform, dreaming runs, latency overhead

**ACs:**
```
AC1: Server starts, responds to MCP initialize
AC2: memory_store via MCP → entry in DB (same DB as OpenClaw plugin)
AC3: memory_recall via MCP → results with scores
AC4: memory_forget via MCP → entry deleted
AC5: Shared DB — memory stored via MCP visible in OpenClaw, and vice versa
AC6: Background dreaming runs on configurable interval (default: daily)
AC7: .mcp.json works in Claude Code
AC8: Zero required config — only --db-path needed
```

---

### Project 3: Dreaming Reflection — THE CORE FEATURE

**Goal:** LLM-driven knowledge synthesis. Turn scattered facts into learnings. Detect contradictions. This is the memory lifecycle — what makes memex a memory system, not just a retrieval system.
**Branch:** master (reflection code is in `src/dreaming.ts`)
**Depends on:** MCP Server (reflection runs in MCP server's background timer)
**Requires:** LLM chat endpoint (`MEMEX_LLM_ENDPOINT` / `MEMEX_LLM_MODEL`) for synthesis

**Diagnosis (required before design):**
- What do the 21 recalled memories have in common? Why are they useful?
- What would a "learning" look like for memex's actual data?
- Can we synthesize a learning from 5 sample memory clusters?

**Metrics:**

| Metric | Baseline | Target |
|---|---|---|
| Learnings per cycle | 0 | 3-5 |
| Contradictions caught | 0 | > 0 per cycle |
| False contradictions | N/A | < 5% |
| Domain eval | 12/15 | ≥ 13/15 |

**Milestones:**

0. Diagnose — cluster sample memories, manual learning synthesis (30 min)
1. Design — Stanford question synthesis, contradiction schema, LLM strategy
2. Build — question synthesis: threshold trigger → generate questions → retrieve → synthesize
3. Build — contradiction detection: semantic similarity → temporal check → superseded_by
4. Build — memory evolution: update stale facts with new context (A-MEM pattern)
5. Evaluate — quality review, false positive rate, domain eval

**ACs:**
```
AC1: Reflection produces learnings with evidence memory IDs
AC2: Learnings stored as category="learning", importance ≥ 0.8
AC3: Contradicting memories: newer wins, older gets superseded_by + importance demotion
AC4: Non-contradicting similar memories coexist (no false positives)
AC5: Reflection skips gracefully when no LLM configured
AC6: Reflection runs as part of dreaming cycle (light → deep → reflect)
AC7: At least 3 learnings produced from real memex production data
```

---

### ~~Project 4: Session Import v2~~ — KILLED

Real-time capture via `memory_store` MCP tool replaces batch session import. The garbage session imports get evicted by cleanup decay rules. Agents that need to bulk-import can call `memory_store` directly — no platform-specific import pipeline needed.

---

### Project 4: Model Bakeoff

**Goal:** Evaluate newer embedding/reranker models for incremental gains.
**Branch:** master (uses existing bakeoff harness)
**Depends on:** Clean pool (project 1) for meaningful evaluation

**Candidates:**
- EmbeddingGemma-300M — 10x smaller, MRL dimension truncation
- Contextual AI Reranker v2 — instruction-following, +35% recency-awareness

**Milestones:**

0. Deploy candidates to inference host
1. Run bakeoff harness: domain eval + fast benchmark
2. If stage 1 passes, run E2E with GPT-4o reader
3. Decision: ship, hold, or reject

No design doc needed — bakeoff harness and criteria already exist.

---

## Backlog

| Project | Goal | Trigger |
|---|---|---|
| Memory Hierarchy | Topic → episode → fact structure | After reflection produces learnings |
| LoCoMo Benchmark | Second eval benchmark | After pool cleanup |
| Debug Recall (#23) | Capture injected context | Recall quality issues |
| Memory Browser (#27) | Visual exploration | User request |
| Issue #30 | Merge autoRecallAgents + autoCaptureAgents | User request |
| Active Observation | MCP server observes + extracts from conversations | After MCP + reflection |

## Open Issues

| # | Project |
|---|---|
| #30 | Config merge (backlog) |
| #27 | Memory Browser (backlog) |
| #23 | Debug Recall (backlog) |
| #8 | Lazy DB Init (solved by MCP server — separate process) |
