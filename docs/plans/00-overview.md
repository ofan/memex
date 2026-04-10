# Memex Development Plan — Overview

## Files

| File | Contents | Review Priority |
|---|---|---|
| `00-overview.md` | This file — structure + decisions needing review | Read first |
| `01-methodology.md` | Dev philosophy, loops, crash recovery, milestone types | Review methodology |
| `02-projects.md` | All project definitions with goals, metrics, ACs | Review goals + ACs |
| `03-agent-roles.md` | Agent team roles, composition, handoff rules | Review roles |
| `04-skill-pack.md` | Skill extraction for reuse across projects | Review if building skills |

## Decisions Needing Your Review

### Goals (set by agent — need your validation)

| Project | Goal Metric | Target | Your call |
|---|---|---|---|
| Entity Extraction | LongMemEval R@1 (primary) | 78% → ≥85% | R@3 ≥ 95%. E2E eval deferred to release plan. |
| Temporal Queries | Temporal recall accuracy | >80% | How to measure? No existing benchmark for temporal queries. |
| MCP Server | Platforms supported | ≥2 | Is Claude Code the right second platform? Or Cursor/Zed? |
| Reflection | Learnings per cycle | 3-5 | Is quality more important than quantity? How to measure quality? |
| Reflection | False contradiction rate | <5% | Is 5% too aggressive? We have no baseline. |

### Design Ambiguities

| Question | Options | Current assumption |
|---|---|---|
| Entity extraction library | compromise (250KB) vs wink-nlp (900KB) vs Transformers.js (400MB) | compromise — fast, small, good enough? |
| Entity boost weight | How much to weight entity overlap vs vector vs BM25? | 0.15 (from ACT-R formula) — needs tuning |
| Temporal detection scope | Regex for common phrases vs full NLP date parsing | Regex only — covers 80%, zero deps |
| MCP transport | stdio vs HTTP vs both | stdio first (Claude Code standard) |
| Reflection LLM | Dedicated endpoint vs client tool vs both | Dedicated first, client fallback (from earlier discussion) |
| Contradiction detection | Heuristic ("switched to", date changes) vs embedding similarity | Heuristic first — cheaper, no LLM |
| Eviction threshold | importance ≤ 0.05 delete vs ≤ 0.01 vs never delete | 0.05 — entries already invisible to retrieval at this level |

### Agent Role Ambiguities

| Question | Current assumption |
|---|---|
| Can builder agents commit directly or need review? | Commit directly, review at milestone eval |
| Should parallel projects share a single session or separate? | Separate sessions, each reads PROGRESS.md |
| Who updates PROGRESS.md — the agent or a dedicated coordinator? | The active agent, after each milestone |
| Budget allocation per project or shared? | Shared — check global budget, not per-project |
