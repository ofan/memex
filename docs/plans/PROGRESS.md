# Progress

## Last Updated: 2026-04-09 21:55

## Active Projects
- No active projects — both merged to master
  - Worktree: `../memex-entity-extraction`
  - Branch: `project/entity-extraction`

## Recently Completed
- Temporal Queries — merged to master 2026-04-09 (4 ACs, 24 tests)
- Entity Extraction — merged to master 2026-04-09 (7 ACs, 19 tests)
- Dreaming v1 (light + deep sweep + /dream command) — merged 2026-04-08
- v0.5.12 released (registration fix, doc indexer, telemetry)
- 15-iteration SOTA research — findings in `docs/research/agent-memory-sota-2026.md`

## Blocked
- Reflection: waiting on Entity Extraction (needs entities for clustering)

## Decisions Made
- 2026-04-09: R@1 is primary metric (target ≥85%), R@3 target ≥95%
- 2026-04-09: Entity extraction via `compromise` library (250KB, rule-based)
- 2026-04-09: Projects use git worktrees, independent branches
- 2026-04-08: /dream as slash command, not internal timer
- 2026-04-08: Dreaming on by default (light + deep), reflection optional

## Open Questions
- Does compromise NER quality suffice for R@1 85%?
- What entity boost weight works best? (Starting with 0.15 from ACT-R)

## Next Session Should
1. Monitor deployment — check memex health, entity backfill on live DB
2. Run live benchmark with embedding server for real R@1/R@3 numbers
3. Start MCP Server project (next on roadmap)
4. Or start Reflection project if entity extraction proves sufficient
