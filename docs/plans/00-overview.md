# Memex Development Plan — Overview

**Last reviewed: 2026-07-11.** This file is a historical index; it may not reflect current state. See PROGRESS.md for latest.

## Files

| File | Contents | Review Priority |
|---|---|---|
| `00-overview.md` | This file — structure + decisions needing review | Read first |
| `01-methodology.md` | Dev philosophy, loops, crash recovery, milestone types | Review methodology |
| `02-projects.md` | All project definitions with goals, metrics, ACs | Review goals + ACs |
| `03-agent-roles.md` | Agent team roles, composition, handoff rules | Review roles |
| `04-skill-pack.md` | Skill extraction for reuse across projects | Review if building skills |

## Decisions Needing Your Review

### Resolved (April–July 2026)

| Project | Outcome |
|---|---|
| Entity Extraction | Shipped, net-neutral. Entity boost disabled (weight=0). Entity graph disabled by default. Gated behind config flags. |
| Temporal Queries | Shipped. Regex date detection + timestamp filtering merged. |
| Entity boost weight | Resolved: 0 (disabled). BM25 already captures keyword entities. |
| Reflection LLM | Shipped (v0.7.0). Dreaming reflection phase: light + deep + LLM reflection via `/dream`. |
| Eviction threshold | Resolved: 0.05. Implemented in deep sweep. |
| MCP transport | Shipped (v0.7.0). HTTP + stdio, bearer auth, systemd+jiti deployment. |
| MCP server | Shipped (v0.7.0). See `docs/design/mcp-server.md`. |
| Session import | Killed. Real-time capture via `memory_store` replaces batch import. |

### Still Open

| Question | Options | Current assumption |
|---|---|---|
| Contradiction detection | Heuristic vs embedding similarity | Not started |
| Memory hierarchy (topic->episode->fact) | Future architectural project | Not started |
| Container daemon deploy | Dockerfile built + smoke-validated, not deployed | TBD |
