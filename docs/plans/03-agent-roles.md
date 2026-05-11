# Agent Team Roles

## Roles

| Role | Responsibility | When Active | Tools |
|---|---|---|---|
| **Planner** | Define ACs, write design docs, set metrics | Design milestones | Plan agent, Read, Write, AskUserQuestion |
| **Builder** | TDD inner loop — write tests, implement, commit | Build milestones | Edit, Write, Bash (tests only), Git |
| **Researcher** | Web search, findings doc, ROI analysis | Research milestones | WebSearch, Write, Bash (budget check) |
| **Reviewer** | Code review, benchmark comparison, AC verification | Evaluate milestones | Read, Bash (tests + benchmarks), code-reviewer agent |
| **Deployer** | Merge, deploy, monitor, report | Release milestones | Bash (rsync, systemctl, monitor), Git |

## Assignment Rules

### Single-Agent Projects (default)

One agent plays all roles sequentially. Most projects are small enough for this.

```
Planner → Builder → Builder → Builder → Reviewer → done
```

The agent switches roles based on the milestone type.

### Multi-Agent Projects (large scope)

Spawn parallel agents when:
- Multiple independent milestones can proceed simultaneously
- A project has clearly disjoint file ownership
- Research and build can happen in parallel

Use `superpowers:dispatching-parallel-agents` or `TeamCreate`.

### Role Transitions

| From | To | Trigger |
|---|---|---|
| Planner | Builder | Design doc reviewed + approved by user |
| Builder | Builder | AC goes green, pick next red AC |
| Builder | Researcher | Implementation reveals unknowns |
| Researcher | Builder | Findings written, plan updated |
| Builder | Reviewer | All ACs green |
| Reviewer | Deployer | Benchmark confirms, user approves release |
| Any | Planner | Pivot needed — redesign |

## Rules

1. **Builder commits directly.** No PR review during inner loop. Review happens at evaluate milestone.
2. **Each session works one project.** Reads PROGRESS.md, picks the active project, stays focused.
3. **PROGRESS.md is the handoff mechanism.** Updated after every milestone. Next agent reads it.
4. **Budget is global.** Check `usage-poll.sh` at loop start. No per-project allocation.
5. **User makes release decisions.** Agent proposes, user disposes.
6. **Research pivots are normal.** If a build milestone reveals unknowns, switch to research. Don't guess.

## Session Handoff

When a session ends (budget, user stops, crash):

1. Agent writes current state to PROGRESS.md:
   - Which project, which milestone, which AC was in progress
   - What was tried, what worked, what didn't
   - What the next agent should do first
2. Commits PROGRESS.md
3. Next session starts by reading PROGRESS.md

### PROGRESS.md Format

```markdown
# Progress

## Last Updated: 2026-04-09 17:00

## Active
- Entity Extraction: Milestone 2, AC3 in progress
  - AC1 ✅ AC2 ✅ AC3 🔴 AC4 ⬜ AC5 ⬜ AC6 ⬜ AC7 ⬜
  - Working on: entity boost weight in retriever.ts
  - Tried: weight=0.15, R@1 still 78%. May need higher weight.

## Next Session Should
1. Try entity weight 0.25 and re-run benchmark
2. If still no improvement, research: is compromise NER quality sufficient?
```

## Parallel Project Rules

If running multiple projects simultaneously:

1. Each project has its own worktree — no file conflicts
2. Each session works ONE project — don't context-switch mid-session
3. PROGRESS.md tracks all projects — any agent can see the full picture
4. Merge order doesn't matter — projects are independent
5. If projects share files (e.g., both touch retriever.ts), coordinate via PROGRESS.md notes
