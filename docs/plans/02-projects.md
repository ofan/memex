# Projects

## Active Projects

### Entity Extraction

**Goal:** Add 3rd retrieval signal. Close Hindsight gap.
**Branch:** `project/entity-extraction`

**Metrics:**

| Metric | Baseline | Target |
|---|---|---|
| R@1 | 78% | ≥85% | PRIMARY |
| R@3 | 90% | ≥95% |
| Entity coverage | 0% | >90% new stores |

**Milestones:**

0. Design — `docs/plans/entity-extraction.md`
1. Tests + foundation — extractEntities(), unit tests green
2. Wire into store + retrieval — entity boost, backfill, AC3-5 green
3. Agent provenance + eviction — agentId, importance ≤ 0.05 delete
4. Evaluate — benchmark, decide merge/iterate/pivot

**ACs:**
```
AC1: extractEntities("Ryan deployed Gemma 4 on mbp-1") → ["ryan","gemma","mbp"]
AC2: extractEntities("The webhook was deleted") → []
AC3: 3 ryan-memories rank in top 5 for "What does Ryan prefer?"
AC4: R@1 ≥ 0.85, R@3 ≥ 0.95 after entity boost
AC5: Backfill populates existing entries
AC6: metadata.agentId present on new stores
AC7: importance ≤ 0.05 deleted by deep sweep
```

---

### Temporal Queries

**Goal:** Date-filtered retrieval. Zero LLM cost.
**Branch:** `project/temporal-queries`

**Metrics:**

| Metric | Baseline | Target |
|---|---|---|
| Temporal accuracy | 0% | >80% |
| R@3 non-temporal | 90% | ≥90% |

**Milestones:**

0. Design — `docs/plans/temporal-queries.md`
1. Tests + implementation — detectTemporalRange(), wire into retriever
2. Evaluate — benchmark, merge or iterate

**ACs:**
```
AC1: "what happened last week" → [7d ago, now]
AC2: "deploy the model" → null
AC3: 2 recent + 3 old → query "last week" → only 2 returned
AC4: Non-temporal R@3 ≥ 0.90
```

---

### MCP Server

**Goal:** Universal memory layer via MCP.
**Branch:** `project/mcp-server`

**Metrics:**

| Metric | Baseline | Target |
|---|---|---|
| Platforms | 1 | ≥2 |
| MCP tools | 0 | 5 |
| Latency overhead | 0ms | <10ms |

**Milestones:**

0. Design — transport, schemas, auth
1. Tests + server skeleton — initialize response
2. Full tools — recall/store/forget/dream/stats
3. Claude Code integration — .mcp.json, real test

**ACs:**
```
AC1: Server starts, responds to initialize
AC2: memory_store via MCP → entry in DB
AC3: memory_recall via MCP → results
AC4: memory_forget via MCP → deleted
AC5: Shared DB between OpenClaw + MCP
AC6: Zero config — only --db-path
AC7: .mcp.json works in Claude Code
```

---

### Reflection

**Goal:** Produce learnings. Prevent confidently-wrong recalls.
**Branch:** `project/reflection`
**Depends on:** Entity Extraction

**Metrics:**

| Metric | Baseline | Target |
|---|---|---|
| Learnings/cycle | 0 | 3-5 |
| Contradictions caught | 0 | >0/week |
| False contradictions | N/A | <5% |

**Milestones:**

0. Design — LLM strategy, learning schema, correction chains
1. Contradiction detection — entity overlap + conflict heuristics
2. Reflection phase — LLM call, learnings, corrections, procedures
3. Evaluate — quality review, false positive rate

**ACs:**
```
AC1: Contradicting store demotes old entry
AC2: Non-contradicting updates coexist
AC3: Reflection produces learnings with evidence IDs
AC4: Correction chain: B supersedes A → A demoted
AC5: Procedure category surfaces for "how to" queries
AC6: Reflection skips when no LLM (no error)
```

---

## Backlog Projects

| Project | Goal | Trigger |
|---|---|---|
| Eval Expansion | 70+ questions, CI gate | After entity extraction |
| Debug Recall (#23) | Capture injected context | Recall quality issues |
| Memory Browser (#27) | Visual exploration | User request |
| OpenPanel Dashboards | Health + perf visualization | After dreaming stabilizes |

## Open Issues

| # | Project |
|---|---|
| #23 | Debug Recall (backlog) |
| #19 | Eval Expansion (backlog) |
| #27 | Memory Browser (backlog) |
| #30 | MCP Server |
