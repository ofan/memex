# Progress

## Last Updated: 2026-04-09 22:30

## Active Projects
- **Entity Graph** — scoped, design doc written, not started
  - Design: `docs/design/entity-graph.md`
  - Goal: domain eval from 80% → ≥93%
  - Open questions for user: auto-recall latency budget? link cap?

## Recently Completed
- Entity boost tuning: disabled (weight=0), domain eval 73% → 80%
- Domain eval created: 15 entity-rich queries against live DB (80% baseline)
- Entity Extraction — merged (entities stored in metadata, backfill on startup)
- Temporal Queries — merged (regex date detection, timestamp filtering)
- LongMemEval rebenchmarked with GPT-4o: R@1 78%, R@3 90%, E2E 92%
- Dreaming v1 merged (light + deep sweep + /dream command)
- v0.5.12 released

## Key Insight This Session
Entity boost as score multiplier DOESN'T WORK (BM25 already handles it).
What Hindsight actually does differently is **graph traversal** — following
entity relationships, not counting keyword overlap. Pivoting to entity
graph with adjacency table + one-hop expansion.

See `docs/plans/LEARNINGS.md` for full session retrospective.

## Decisions Made
- 2026-04-09: Entity boost weight=0 (disabled). BM25 is sufficient for keyword entities
- 2026-04-09: Pivot to entity graph (adjacency table, one-hop expansion)
- 2026-04-09: Domain eval is primary metric (not LongMemEval)
- 2026-04-09: GPT-4o default for E2E benchmark
- 2026-04-09: OpenAI key in 1Password `dev-claude` item

## Next Session Should
1. Review entity graph design doc — answer open questions
2. Create worktree, write ACs, implement entity graph
3. Run domain eval — target 93%+
4. If successful, deploy + push
