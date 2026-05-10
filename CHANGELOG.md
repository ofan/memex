# Changelog

## [0.6.0] — 2026-05-10

**Theme: real build step + version-line shift.** ClaHub's validator now requires compiled JS output for TypeScript code plugins. memex now compiles `index.ts` and `src/**/*.ts` to `dist/` at publish time. Source remains the editable artifact; tests still run against `.ts` via jiti. The `memex-v0.6` development branch is concurrently renamed to `memex-v0.7` so its in-flight architectural work (HTTP MCP daemon, dreaming, entity graph, Claude Code plugin) lands as v0.7+ and doesn't collide with the now-shipped v0.6 namespace.

### Added
- **`tsconfig.build.json`** — extends the main config with `noEmit: false`, `outDir: dist`, excluding tests. Used only for publish.
- **`build` script** in `package.json` — `tsc --noCheck -p tsconfig.build.json`. `--noCheck` strips types without type-checking (jiti-equivalent semantics; the existing 42 latent type errors are out of scope for this release and will be addressed separately).
- **`prepublishOnly`** runs build automatically.
- **`.github/workflows/release.yml`** — runs `npm run build` between `npm ci` and the publish step; copies `dist/` alongside the source files in the publish payload.

### Changed
- **`.gitignore`** — `dist/` excluded.
- **Version-line shift:** main bumps to `0.6.0`. The previously-named `memex-v0.6` branch is renamed to `memex-v0.7` (its in-flight features will ship as v0.7+).

### Notes for downstream
- ClaHub installs of `memex@0.6.0` get pre-built JS in `dist/`. OpenClaw's loader can use either `dist/index.js` or `index.ts` (jiti); local `npm link` deploys still work without running `npm run build`.
- 42 latent type errors exist in the codebase (jiti was hiding them). They don't block the build (`--noCheck`) but should be cleaned up in a follow-up PR. Run `npx tsc` to see the list.

## [0.5.15] — 2026-05-10

**Re-publish of v0.5.13/v0.5.14 after release-pipeline shakeout.** The clawhub CLI required a sequence of fixes (`--slug` → `--name`, `--family code-plugin`, `--source-repo`/`--source-commit`/`--source-ref`, and finally `openclaw.compat.pluginApi` + `openclaw.build.openclawVersion` in `package.json`). Code is identical to v0.5.13.

### Fixed
- **`package.json`** — added `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion` (required for external code plugins per the new clawhub validator).
- **`.github/workflows/release.yml`** — added `workflow_dispatch` trigger so future re-publishes don't need a fresh version bump.

## [0.5.14] — 2026-05-09

**Re-publish of v0.5.13 after release-workflow fix.** v0.5.13 was tagged but its publish job failed because the `clawhub` CLI changed its publish syntax (`clawhub publish` → `clawhub package publish`) and nothing landed on ClaHub. Code is identical to v0.5.13.

### Fixed
- **`.github/workflows/release.yml`** — use `clawhub package publish <source>` (the old `clawhub publish <source>` form fails with "This looks like a plugin. Use `clawhub package publish <source>` instead.").

## [0.5.13] — 2026-05-09

**Theme: citation-anchored recall.** Each recalled memory now carries a short stable handle (`[mem:abc12345]`); the LLM is instructed to cite it when used and can `memory_forget` by the anchor. Inspired by ENGRAM-R (`arXiv:2511.12987`), which reports −85% input / −75% reasoning tokens vs full-context with this pattern at maintained accuracy.

### Added

- **`src/anchor.ts`** — citation-anchor helpers: `anchor(id)` returns the 8-char hex prefix used in `[mem:...]` / `[doc:...]` markers; `expandAnchor(prefix, candidates)` resolves a prefix back to a full id and detects ambiguity (`AnchorAmbiguityError`); `looksLikeAnchor(s)` for input validation. Storage-agnostic — caller passes the candidate id list. Unit tests in `tests/anchor.test.ts` (12 cases).
- **Citation instruction** added to `buildRecallContext` (`src/memory-instructions.ts`): tells the LLM to cite recalled memories by anchor in reasoning and how to delete by anchor via `memory_forget`. Verified by two new assertions in `tests/plugin-mock.test.ts`.

### Changed

- **Auto-recall format** (`index.ts` `before_prompt_build` hook) — both unified-recall and memory-only paths now render `- [mem:abc12345 · category · scope] ...` and `- [doc:abc12345 · path] ...` in the prepended `<relevant-memories>` block. Replaces the previous `[memory:category:scope]` / `[doc:path]` format.
- **`memory_recall` tool output** (`src/tools.ts`) — all three response paths (unified-retriever, unified-recall fallback, conversation-only fallback) now use the same `[mem:anchor · category · scope]` / `[doc:anchor · path]` format the auto-recall hook uses, so the LLM sees one consistent anchor surface across both auto and explicit recall.
- **`memory_forget` tool** (`src/tools.ts`) — `memoryId` parameter now accepts a citation anchor (8 hex chars) or any longer prefix in addition to the full UUID. Ambiguous prefixes return `error: anchor_ambiguous` with the matches list; non-matching prefixes return `error: anchor_not_found`. Tool description updated. Telemetry: `forget` events now include `anchor_prefix`, `anchor_ambiguous`, and `via_anchor` flags.
- **`memory_forget` candidates list** (the "Found N candidates" path) now uses `[mem:abc12345]` to match the canonical anchor format.

### Documentation

- **README** — new "Citation anchors" section explains the format, the LLM-side citation contract, and how `memory_forget` accepts anchor prefixes.
