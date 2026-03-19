# Rename & Cleanup: Remove Fork Artifacts

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flatten `src/qmd/` into `src/`, rename fork-era naming, update all imports and references. No logic changes.

**Architecture:** Pure rename/move. Every import path changes, no behavior changes. Run full test suite after each task.

**Tech Stack:** TypeScript, jiti (no build step)

---

## Context

The codebase was built from two forks (QMD + LanceDB Pro) with a new unified layer on top. After the SQLite consolidation, 60% of the code is original or fully rewritten. The `src/qmd/` subdirectory and fork-era naming no longer reflect reality.

## Rules

- **No logic changes** — this is purely structural
- **Every task must pass full test suite** before committing
- **Update all imports** in source + test files
- **Update CLAUDE.md** at the end

---

## Task 1: Flatten `src/qmd/` into `src/`

Move 5 files, update all imports.

| From | To | Notes |
|------|----|-------|
| `src/qmd/store.ts` | `src/search.ts` | The big file — FTS, vector search, document indexing, chunking |
| `src/qmd/llm.ts` | `src/llm.ts` | Embedding + reranker HTTP client |
| `src/qmd/db.ts` | `src/db.ts` | SQLite open/vec helpers |
| `src/qmd/collections.ts` | `src/collections.ts` | Workspace path management |
| `src/qmd/formatter.ts` | `src/formatter.ts` | Result formatting |

- [ ] Move files with `git mv`
- [ ] Update all imports in `src/*.ts` (`./qmd/store.js` → `./search.js`, etc.)
- [ ] Update all imports in `tests/*.ts`
- [ ] Update imports in `index.ts`
- [ ] Delete empty `src/qmd/` directory
- [ ] Run full test suite
- [ ] Commit: `refactor: flatten src/qmd/ into src/`

## Task 2: Rename `store.ts` → `memory.ts`

Current `src/store.ts` is the MemoryStore (conversation memories). With `src/qmd/store.ts` moved to `src/search.ts`, having `src/store.ts` is confusing. Rename to `src/memory.ts`.

| From | To |
|------|----|
| `src/store.ts` | `src/memory.ts` |

- [ ] `git mv src/store.ts src/memory.ts`
- [ ] Update all imports (`./store.js` → `./memory.js`)
- [ ] Run full test suite
- [ ] Commit: `refactor: rename store.ts to memory.ts`

## Task 3: Rename variables and types

Replace fork-era naming in source code. No file moves.

| Old | New | Where |
|-----|-----|-------|
| `createQmdStore` | `createSearchStore` | `index.ts` |
| `qmdStore` / `qmdStoreUnified` | `searchStore` | `index.ts` |
| `qmdHybridQuery` / `qmdHybridQueryFn` | `hybridQueryFn` | `index.ts`, `unified-recall.ts` |
| `qmdDb` | `db` | `index.ts` |
| `qmdDims` | `searchDims` | `index.ts` |
| `qmdLLMConfig` | `llmConfig` | `index.ts` |
| `qmdDbFile` | `dbFile` | anywhere remaining |
| `setQmdStore` | `setSearchStore` | `unified-recall.ts` |
| Comment: "LanceDB Pro" | "memex" | everywhere |
| Comment: "QMD" | "document search" or "search" | everywhere |
| Comment: "forked from" | remove or "based on" | CLAUDE.md |

- [ ] Search-and-replace in `index.ts`
- [ ] Search-and-replace in `unified-recall.ts`
- [ ] Search-and-replace in test files
- [ ] Grep for remaining `qmd` / `lancedb` / `LanceDB` references, fix any stragglers
- [ ] Run full test suite
- [ ] Commit: `refactor: rename qmd/lancedb variables to memex conventions`

## Task 4: Update CLAUDE.md

Rewrite to reflect the actual architecture. Remove fork provenance tables, update file listing, update test counts.

- [ ] Rewrite architecture section (single SQLite, no more fork references)
- [ ] Update project structure (flat `src/`, new file names)
- [ ] Remove "Forked Code" section entirely
- [ ] Update "New code" section → just list all files
- [ ] Update test count, file counts
- [ ] Update deployment section (no more LanceDB)
- [ ] Commit: `docs: rewrite CLAUDE.md for post-consolidation architecture`

## Task 5: Clean up dead code

- [ ] Remove `src/migrate-lancedb.ts` if migration is disabled
- [ ] Remove `loadLanceDB()` export from `src/memory.ts` if no longer used
- [ ] Check `src/migrate.ts` — does legacy migration still make sense?
- [ ] Remove `@lancedb/lancedb` from `optionalDependencies` if no migration code remains
- [ ] Grep for any dead imports or unused exports
- [ ] Run full test suite
- [ ] Commit: `chore: remove dead LanceDB migration code`

## Verification

- All 385+ tests pass after each task
- `grep -ri "qmd" src/` returns only legitimate uses (like collection names in data)
- `grep -ri "lancedb" src/` returns nothing (except maybe migration docs)
- CLAUDE.md accurately reflects the codebase
