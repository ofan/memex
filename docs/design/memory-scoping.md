# Memory Scoping and Provenance Design (Problem 2)

**Status:** Design (revised 2026-06-28 after review). Not implemented.
**Scope:** Problem 2 from `docs/plans/two-problems-architecture.md` — make the shared memory pool context-aware so memories don't leak across contexts.
**Siblings:** `docs/design/v0.8-architecture-decisions.md` (T2.1 per-device docs, T2.2 Mac mini daemon, T2.3 fail-closed, T2.4 Camp C).

---

## Problem

A shared pool sees inputs from many contexts: different devices, projects, clients, sessions. Without context-awareness, a memory from one project surfaces in another. Today 407/413 production memories are `global` with no provenance.

Three needs: **scope** at store time, **filter** at recall time, **provenance** for judgment. Philosophy: OS-style isolation — default-scoped, explicit promotion to `global`. Retrieval is transparent, not "perfect": surface candidate memories with provenance and let the agent judge.

---

## Design at a glance

- **Scope is multi-valued tags**, not a single column. A memory carries N tags.
- **Server-authoritative derivation**: the daemon derives the tags itself wherever the transport allows, so scope is consistent and does not depend on client behavior.
- **Dimensions**: `global`, `project`, `client`, `session` (universal) + `agent` (optional). Device is provenance-only.
- **Recall = tag intersection** with the active context; `global` always surfaces; missing tags never break recall.

---

## Scope is multi-valued tags

A memory is naturally relevant to several contexts at once (a fact about *this project* captured by *this client* in *this session*). A single scope value cannot express that, so scope is a **set of tags** per memory.

- Storage: a `memory_scopes(memory_id, scope)` table (one row per tag). A memory has 1..N tags.
- This supersedes the single `memories.scope` column (a small migration — see Data Model).

---

## Dimensions

| tag | universal? | who sets it | recall includes it when |
|---|---|---|---|
| `global` | yes | default / explicit | always |
| `project:<git_remote-hash>` | yes | server-derived (git) | you're in that project |
| `client:<name>` | yes | server (`clientInfo.name`) | that client asks |
| `session:<ns>:<id>` | yes | client-generated, namespaced | that session asks |
| `agent:<name>` | **optional** | client explicit (only clients with personas) | that agent asks |

- **Device is not a tag** — provenance only (metadata), never a recall filter.
- **`agent` is not universal** (only OpenClaw / Pi profiles have a persona concept; Claude Code, Codex, OpenCode do not). It is an opt-in tag, not a dimension the design depends on.

---

## Derivation — server-authoritative

The server (daemon) derives tags itself wherever the transport gives it the signal. This is the consistency guarantee: one algorithm, one place — clients cannot get it wrong because they are not the ones doing it.

| tag | stdio (server has client env) | HTTP (remote daemon) |
|---|---|---|
| `project` | server: cwd → git → `git_remote` hash | **client must supply** (daemon can't see client fs); server validates |
| `client` | server: `clientInfo.name` | server: `clientInfo.name` / configured name |
| `session` | server: own session id | server: own session id |
| `device` (metadata) | server: hostname + HOME | **client must supply**; server validates |
| `agent` | client explicit (optional) | client explicit (optional) |

**Auto vs opt-in tags** (prevents general facts from being siloed by capturing context):

- **Auto** (server adds by default): `project` (from git) and `global` (default/fallback).
- **Opt-in** (attached only when genuinely specific): `client`, `agent`, `session`. Otherwise "I like dark mode" captured in Claude Code would be walled into `client:claude-code` and hidden from Codex.

**Consequence:** stdio needs **no client wrapper** (the server self-derives everything). Only HTTP needs a thin wrapper to pass `project` + `device`; the server validates and canonicalizes them.

---

## Recall — tag intersection

A memory surfaces if **any** of its tags is in the active context: `{global} ∪ {current project} ∪ {current client} ∪ {current session} ∪ {current agent}`.

- **Additive:** `global`-tagged memories always surface.
- **No cross-project leak:** a memory tagged only `project:A` does not surface in project B.
- **Sparse:** absent tags do not filter — a memory with no `client` tag is client-agnostic and surfaces in all clients.
- Every result carries provenance so the agent can judge relevance.

---

## Missing signals — graceful fallback

Tags are best-effort; a missing signal degrades, never breaks recall:

- `project`: `git_remote` hash → (no remote) local-path hash → (no git) cwd hash → (nothing) `global`.
- `client` / `session` / `device`: simply absent if unavailable.
- `global` is the ultimate fallback — a memory is always recallable somewhere.

---

## Metadata (provenance)

Always captured server-side, orthogonal to tags: `project_root` (hash), `device_id`, `git_branch`, `git_remote` (normalized), `client`, `captured_at`.

- **All filesystem paths hashed — raw paths are never stored** (they are PII revealing directory structure / project names).
- `git_remote` is normalized: strip `.git`, SSH form → HTTPS form, lowercase host.
- Missing fields are absent, never `null`.

---

## Dreaming — scope-aware

- **Dedup** key: `(text, scope-set)` — identical text under different tags is not a duplicate; each tag-group dedups independently.
- **Reflection** learnings inherit tags: a single-context input batch → those tags; a mixed-context batch → `global`.

---

## Data model

- `memory_scopes(memory_id, scope)` table replaces the single `memories.scope` value. Small migration: existing 407 `global` memories become one `global` tag each.
- `memories.metadata` JSON column gains the provenance keys above (schemaless, no migration).
- Recall uses an `EXISTS`/join on `memory_scopes` against the active-context tag set.

---

## What changes in code (gap notes for the implementer — not implementation)

- Store: hardcoded `scope:"global"` → server-derived tag set (+ optional explicit tags from client).
- Recall: single scope filter → tag-intersection filter (join on `memory_scopes`).
- Dreaming dedup: `GROUP BY text` → `GROUP BY text, scope-set`; reflection: hardcoded `global` → tag-inheriting.
- `client`/`session` derived server-side from `clientInfo` / session; `device` provenance captured and hashed.
- The daemon is the authority: it re-derives/validates/canonicalizes tags on store, so a client cannot corrupt the pool.

---

## Open questions (deferred)

- **Feedback loop** (boost/demote recalled memories) — separate design.
- **Scope promotion UX** (project → global) — tool-surface design.
- **Sensitive/private memories** (never cross device) — an orthogonal `visibility` field; out of scope here.
- **`headersHelper` capability** for Claude Code HTTP project-passing — validate before T2.2 implementation.

---

## Pointers

- `docs/plans/two-problems-architecture.md` — Problem 2 framing
- `docs/design/v0.8-architecture-decisions.md` — T2.1–T2.4
- `src/scopes.ts`, `src/memory.ts`, `src/mcp-server.ts`, `src/dreaming.ts`, `src/retriever.ts` — current code
