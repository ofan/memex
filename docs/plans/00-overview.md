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

### Resolved (April 2026)

| Project | Outcome |
|---|---|
| Entity Extraction | Shipped, net-neutral. Entity boost disabled (weight=0). Entity graph disabled by default. Gated behind config flags. |
| Temporal Queries | Shipped. Regex date detection + timestamp filtering merged. |
| Entity boost weight | Resolved: 0 (disabled). BM25 already captures keyword entities. |
| Reflection LLM | Deferred. Light + deep dreaming work without LLM. Reflection phase is future work. |
| Eviction threshold | Resolved: 0.05. Implemented in deep sweep. |

### Still Open

| Question | Options | Current assumption |
|---|---|---|
| Temporal detection scope | Regex vs full NLP date parsing | Regex only — shipped, covers 80% |
| MCP transport | stdio vs HTTP vs both | Not started |
| Contradiction detection | Heuristic vs embedding similarity | Not started |
