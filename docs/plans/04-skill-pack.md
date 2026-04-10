# Skill Pack: `project-engine`

Generic development methodology extracted from memex. Reusable across any project.

## Skills

### `project-init`

**Triggers:** "start a project", "new project", "create project for X"

Creates worktree, design doc template, acceptance test file, PROGRESS.md entry. Prompts user for goal metric and target.

### `project-resume`

**Triggers:** session start, "continue", "what's next"

Reads PROGRESS.md, finds active project + milestone, checks budget, presents status, continues loop. No user input needed.

### `tdd-loop` (core — 90% of agent time)

**Triggers:** "implement", "build", "continue", "make tests pass"

Reads ACs → runs tests → finds red → implements → commits on green → updates PROGRESS.md → loops.

Automated: `/ralph-loop 10m --completion-promise "All acceptance tests pass"`

### `research-loop`

**Triggers:** "research X", "investigate", "what's the SOTA"

Budget check → web search → write findings → rate ROI → update backlog → commit → loop.

Automated: `/ralph-loop 10m Research <topic>`

### `project-eval`

**Triggers:** "evaluate", "are we done", "check milestone"

Runs ACs + benchmark. Presents decision: continue / merge / pivot / research. Updates PROGRESS.md.

### `release-eval`

**Triggers:** "release", "deploy and test", "ship it"

User-triggered only. Merge → deploy → monitor → user decides tag/rollback.

## Composition

```
project-resume → tdd-loop ←→ tdd-loop → project-eval
       ↑              ↑                       │
       │         research-loop                 │
       └───────────────────────────────────────┘

project-init → design doc → user review → tdd-loop → ...

project-eval → "ship" → release-eval → deploy → monitor
```

## Existing Tools Used

| Tool | Used By |
|---|---|
| `/ralph-loop` | tdd-loop, research-loop |
| `/plan` | project-init |
| `superpowers:dispatching-parallel-agents` | Multi-project |
| `superpowers:using-git-worktrees` | project-init |
| `superpowers:verification-before-completion` | project-eval |
| `code-review:code-review` | project-eval |
| `commit-commands:commit` | tdd-loop |
| WebSearch | research-loop |
| `usage-poll.sh` | All loops |

## Design Decisions

- **Skill pack, not monolith.** Each skill is focused and composable.
- **Generic.** Skills know nothing about memex. Domain comes from PROGRESS.md and project plans.
- **Start local.** Build as local skills first. Extract to GitHub skill pack when proven.
