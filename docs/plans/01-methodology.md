# Development Methodology

## Philosophy

1. Tests and measurements first. Always.
2. Nothing is fixed. New insights change the plan.
3. Progress is persisted. Any agent can pick up after a crash.
4. Research is a first-class task, not a side activity.
5. Release when ready, not on a schedule.

## Two Loops

### Inner Loop (fast, local, agent-driven)

```
READ PROGRESS → PICK TASK → WRITE TESTS (red) → IMPLEMENT (green) → 
COMMIT → UPDATE PROGRESS → NEXT TASK
```

- Runs entirely in git worktree
- No deployment, no gateway, no integration tests
- Tests: `node --import jiti/register --test tests/*.test.ts`
- Benchmark: `TIER=pipeline fast-benchmark` (local, cached vectors)
- Automated via `/ralph-loop` with completion promise
- Minutes per iteration

### Outer Loop (release evaluation, user-driven)

```
ALL ACs GREEN? → BENCHMARK → MERGE → DEPLOY → MONITOR → DECIDE
```

- Only at release-candidate milestones
- Deploy to OpenClaw, restart gateway, check monitor
- User decides release
- Hours/days

**90% of agent time is in the inner loop.**

## Milestone Types

| Type | What | Who | Inner/Outer |
|---|---|---|---|
| **Design** | Write design doc, review with user | Agent + user | N/A |
| **Build** | TDD loop until ACs green | Agent | Inner |
| **Research** | Web search loop, findings doc | Agent | Inner |
| **Evaluate** | Benchmark + decide | Agent + user | Inner |
| **Release** | Deploy, monitor, tag | User | Outer |

## Design Docs

Every project starts with `docs/plans/<project>.md` before code:
- Problem, motivation, approach, trade-offs
- API surface, data model changes
- Failure modes, edge cases, dependencies

Living document — updated during and after implementation.

## Crash Recovery

Two files contain everything needed to resume:

**`docs/plans/PROGRESS.md`:**
```markdown
## Last Updated: 2026-04-09 17:00 by agent-session-abc

## Active Projects
- Entity Extraction: Milestone 2. AC1,AC2 green. AC3 red.

## Next Session Should
1. Continue Entity Extraction — implement entity boost in retriever
2. Run AC3 test
```

**Project plan files** (`docs/plans/<project>.md`):
- Design doc with ACs, metrics, file list

### Agent Startup Sequence

```
1. Read PROGRESS.md
2. Read active project's plan
3. Check budget: usage-poll.sh
4. Pick up from "Next Session Should"
5. Continue inner loop
```

## Research Tasks

When implementation reveals unknowns:
1. Pause current task
2. Add research milestone to project
3. Research (web search, code exploration)
4. Update plan with findings
5. Resume or pivot

## Worktree Convention

```
~/projects/memex/                     # master (production)
~/projects/memex-entity-extraction/   # project/entity-extraction
~/projects/memex-mcp-server/          # project/mcp-server
```

Merge only when: all ACs pass, no regression after rebase, benchmark confirms.
