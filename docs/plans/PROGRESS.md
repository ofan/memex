# Progress

## Last Updated: 2026-04-09 22:10

## Active Projects
- No active projects

## Recently Completed
- Entity boost wired into retriever — 2026-04-09 (3rd signal active, 638 tests)
- Temporal Queries — merged to master 2026-04-09 (4 ACs, 24 tests)
- Entity Extraction — merged to master 2026-04-09 (7 ACs, 19 tests)
- LongMemEval re-benchmarked with GPT-4o — R@1: 78%, R@3: 90%, E2E: 92%
- Dreaming v1 (light + deep sweep + /dream command) — merged 2026-04-08
- v0.5.12 released (registration fix, doc indexer, telemetry)
- 15-iteration SOTA research — findings in `docs/research/agent-memory-sota-2026.md`

## Blocked
- Reflection: Entity Extraction done, can start now

## Decisions Made
- 2026-04-09: LongMemEval doesn't measure entity boost (casual conversation, few entities)
- 2026-04-09: Entity boost weight = 0.15 (ACT-R formula), benchmark shows no change on LongMemEval
- 2026-04-09: GPT-4o is default E2E benchmark LLM (was Gemini Flash)
- 2026-04-09: OpenAI key stored in 1Password dev-claude item
- 2026-04-09: R@1 target ≥85%, R@3 target ≥95% — may need domain-specific eval
- 2026-04-09: Entity extraction via `compromise` (250KB, rule-based)
- 2026-04-08: /dream as slash command, not internal timer

## Open Questions
- R@1 85% / R@3 95% targets may not be achievable on LongMemEval — benchmark uses casual conversation. Need production-like eval with technical/domain content.
- Entity boost weight 0.15 — is this optimal? Hard to tune without a benchmark that has entity-rich data.
- Should we build a domain-specific eval set from the live 2,103 memories?

## Next Session Should
1. Deploy entity boost + temporal queries to OpenClaw
2. Decide: build domain-specific eval, start MCP Server, or start Reflection
3. Push to GitHub
