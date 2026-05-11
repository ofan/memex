# Housekeeping loop (post-v0.7.1)

**Created:** 2026-05-10 (right after v0.7.1 publish)
**Branch:** `memex-v0.7` (then merge to `main` as part of LOOP.M1)
**Purpose:** Knock out 4 mechanical post-release housekeeping items in one unattended loop pass. None of these change runtime behavior; all are reversible; all have clear verification.

## Pre-decided judgment calls

- **Tag policy**: do NOT tag v0.7.2 from this loop. The changes here are cleanup; if/when a substantive v0.7.2 emerges (e.g. from architecture work), it can pick up these commits.
- **Branch deletes**: only delete fully-merged or clearly-obsolete branches. If a branch's tip commit isn't reachable from `main` or `memex-v0.7`, **stop and surface** rather than delete.
- **Tag deletes**: keep `v0.6.0` / `v0.6.1` as historical records of the failed-publish path. Don't delete tags in this loop. Tag deletions are user-driven if ever wanted.
- **Merge strategy**: `--no-ff` merge for memex-v0.7 → main (explicit merge commit so the v0.7 history is visible in main's log).

## Operating principle

Each item is mechanically scoped. If any item hits a real conflict, surface immediately and mark `[?]` rather than guess. Verification gates (`npm test` + `npm run build`) apply to code-changing items.

---

## In scope

### LOOP.M1 — Merge `memex-v0.7` → `main`
- [x] **M1.1** Branch divergence confirmed: memex-v0.7 has 153 commits not in main (all v0.7 work); main has 22 commits not in memex-v0.7 (v0.6.2 release fixes). Common ancestor: `ebe1907 chore: bump version to 0.5.12`. **Real 3-way merge required** (not ff). Direction: memex-v0.7 → main, forward-only, no force push. Conflicts likely on `package.json`, `CHANGELOG.md`, `dist/`. If conflicts, M1.2 will stop and mark [?].
- [?] **M1.2** Merge produced conflicts in 9 files: `package.json`, `package-lock.json`, `CHANGELOG.md`, `index.ts`, `openclaw.plugin.json`, `src/memory-instructions.ts`, `tests/plugin-mock.test.ts`, `dist/src/tools.js.map`, `dist/src/unified-retriever.js`, `dist/src/unified-retriever.js.map`. **Every conflict is "v0.7's version wins"** (newer code, supersedes the v0.6.2 release-fix commits on main). But per plan rule, stopped and aborted — surfacing for user decision. **Three paths**: (a) user resolves manually with `git merge --no-ff memex-v0.7` then accepts v0.7's side on each; (b) tell loop to do `git merge -X theirs --no-ff memex-v0.7` (auto-take v0.7's version everywhere); (c) abandon merge, accept that main stays at v0.6.2 indefinitely and dependabot UI shows stale alerts. Option (b) is what I'd do given the conflict topology, but it's not in the loop's mandate without user OK.
- [?] **M1.3** Blocked by M1.2.
- [?] **M1.4** Blocked by M1.2.
- [?] **M1.5** N/A — never left memex-v0.7 (merge aborted).

### LOOP.M2 — Switch `@sinclair/typebox` → unscoped `typebox`
**Goal**: align memex with openclaw's typebox choice; eliminate the dual-package situation; remove the 4 type-bridge casts in `src/tools.ts`.

- [x] **M2.1** Audit complete. **Single import surface**: `src/tools.ts:6` imports just `Type`. No `Static`, `TSchema`, or other types pulled. No existing imports of unscoped `typebox` in our code (it's only transitive via openclaw/pi-agent-core). Switch will be 1 import line + 4 cast removals + 1 package.json edit.
- [x] **M2.2** `package.json` updated: `@sinclair/typebox` removed, `typebox: ^1.1.37` added. `npm install` clean, 0 vulns.
- [x] **M2.3** Single import in `src/tools.ts:6` switched to `from "typebox"`. (No other files needed updates per M2.1's audit.)
- [x] **M2.4** All 4 casts removed in `src/tools.ts` — `Type.Optional(stringEnum(MEMORY_CATEGORIES))` works directly now since both `Type` and `stringEnum` come from the same `typebox` package.
- [x] **M2.5** `npm run build` clean. No API drift surfaced — `Type` API is identical between the two packages for the surface memex uses (`Type.Object`, `Type.Optional`, `Type.String`, `Type.Number`).
- [x] **M2.6** Tests 725/725 pass.
- [x] **M2.7** Bundled commit covers M2.2-M2.6 (tightly coupled — splitting would leave broken-build commits between iterations).

### LOOP.M3 — CI: bump GitHub Actions to Node 24-compatible majors
**Goal**: pre-empt June 2026 GitHub deadline; silence the 6+ deprecation warnings on every CI run.

- [x] **M3.1** Two workflows audited: `release.yml` and `ci.yml`. Seven `uses:` lines total — 4× `actions/checkout@v4`, 2× `actions/setup-node@v4`, 1× `softprops/action-gh-release@v2`. All are v4-or-older and trigger Node 20 deprecation warnings per CI annotation.
- [ ] **M3.2** Bump `actions/checkout@v4` → `@v5`, `actions/setup-node@v4` → `@v5`. For `softprops/action-gh-release@v2`, check the GitHub releases page (or `gh api`) for the latest major; bump if a newer one exists that supports Node 24.
- [ ] **M3.3** Don't trigger CI by editing the workflow alone — the workflow only fires on `v*` tag push (per existing config). Verify by inspecting the `on:` block. If the workflow would auto-trigger on push to memex-v0.7, surface and pause.
- [ ] **M3.4** Commit + push. Next tag push (whenever) will exercise the new action versions.

### LOOP.M4 — Cosmetic branch/tag cleanup
**Goal**: clean repo browsing surface. No functional change.

- [ ] **M4.1** Delete `rename-to-memclaw` remote branch — confirmed historical, not merged anywhere active. `git push origin --delete rename-to-memclaw`.
- [ ] **M4.2** Audit the 28 dependabot branches on origin. For each: if the underlying advisory is closed by `memex-v0.7`'s lockfile (verify via `npm audit` shows 0), delete the dependabot branch. List the deleted branches in the iteration log.
- [ ] **M4.3** Audit the legacy feature branches (`chore/repo-hygiene`, `debug/release-payload-listing`, `feat/build-step-and-0.6-bump`, `feat/citation-anchors`, all `fix/release-*` and `fix/track-dist-in-git`, `fix/runtime-extensions-and-files`). For each: if its tip commit is reachable from `main` (i.e. fully merged), delete. If not reachable, **stop and surface** before deleting.
- [ ] **M4.4** Document in `docs/plans/PROGRESS.md`: "Branch cleanup post-v0.7.1: deleted N branches; reasoning: X, Y, Z."

---

## Out of scope

- **Tagging v0.7.2 or v0.8.0** — explicit user decision when there's a release narrative.
- **Merging dependabot PRs individually** — superseded by v0.7's `npm audit fix`. Just delete the branches.
- **Deleting v0.6.0 / v0.6.1 tags** — historical records, kept by pre-decision.
- **Force push to main** — never. If the merge in M1 doesn't ff and creates conflicts, stop.
- **Any code refactoring beyond the 4-cast removal in M2** — security-bump-loop discipline applies: no incidental cleanup.

---

## Loop operating rules

Each iteration:
1. Read this file, find the next `[ ]` item.
2. Do the item. Verify (`npm test` + `npm run build` for code-changing items; `git log` / `git branch` inspection for hygiene items).
3. Mark `[x]` (or `[?]` with one-line rationale).
4. Commit + push.
5. End the iteration.

If all items are `[x]` or `[?]`, AND `npm audit` is still 0 vulns, AND main has been pushed with the merge, AND the branch list has been audited, output:
```
<promise>HOUSEKEEPING LOOP COMPLETE</promise>
```

**Hard cap: 15 iterations.**

---

## Iteration log

<!-- (loop fills this in) -->

---

## Pointers

- Predecessors: [`014-v0.7-cleanup-loop.md`](./014-v0.7-cleanup-loop.md), [`015-v0.7.1-security-bump-loop.md`](./015-v0.7.1-security-bump-loop.md)
- Roadmap context: [`013-post-v0.6.2-roadmap.md`](./013-post-v0.6.2-roadmap.md) — T1.3 (cosmetic), and references to dependabot/typebox debt.
- Critical sequencing: M1 first (so the merge-to-main hygiene win lands before any further code churn); M2 next (most code-touching); M3 + M4 are independent and can be done in either order.
