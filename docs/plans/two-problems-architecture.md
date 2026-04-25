# Memex Architecture — Two Open Problems

## Context

Memex started as an OpenClaw plugin. It's now also an MCP server, used live in Claude Code. The user's vision is **one shared memory pool across all devices** — memex as a personal memory service rather than a per-device library.

Two architectural problems block this vision. They are independent and need to be solved separately. This document formalizes both, captures what's known, and tracks progress.

**Status:** Both problems in **understanding phase**. Do not jump to implementation. Do not collapse them into a single plan.

---

## Problem 1: MCP Process Architecture

> "Whether you use one server to handle all the requests for our devices or you can get complicated with local process with cache. Then now you have a distributed system which is much more complicated."

### What it is

Memex needs to serve memory requests from multiple devices (laptop, dev VM, Mac mini) and multiple platforms (OpenClaw, Claude Code, future MCP clients). The data lives in `memex.sqlite`. The question is **where the process that owns the DB runs**, and **how clients connect**.

### Current state

- `src/mcp-server.ts` uses **stdio transport only** (file: `src/mcp-server.ts:329-330`)
- MCP SDK supports HTTP via `StreamableHTTPServerTransport` (in `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts`) — **not used**
- Each MCP client (Claude Code, OpenClaw plugin) **spawns its own subprocess** of the server
- SQLite is in **WAL mode** — concurrent reads OK, writes serialized via file lock
- **No coordination primitives** in the codebase (no lock tables, no leader election)
- No graceful shutdown (no SIGTERM handler in `mcp-server.ts:main()`)
- Background dreaming runs via `setInterval()` per process (file: `mcp-server.ts:325`)

### User's first-pass understanding

- "Each MCP or each deployment are different interfaces" — i.e., different platforms produce different memories from different conversations, so concurrent inserts of the *same* memory are not a real concern
- "I want to use the same memory pool for all devices" — implies a **single source of truth**, not local caches with sync
- "Local process with cache" → "distributed system much more complicated" — distributed cache architectures are a known cost the user wants to avoid

### Dimensions of the problem

| Dimension | Question | Known constraints |
|---|---|---|
| **Where does the daemon run?** | Mac mini-1, Mac mini-2, dev VM, or wherever's always on? | Embedding server already on Mac mini-1; co-locating reduces network hops |
| **Transport between client and daemon?** | stdio subprocess vs HTTP/SSE | stdio = same machine only; HTTP = cross-machine but needs auth |
| **Who manages the daemon's lifecycle?** | systemd/launchd unit, or auto-spawn by first client? | Tradeoff: install friction vs zombie processes |
| **What's the offline behavior?** | Fail closed (no memory when host unreachable) or local read-only cache? | Pure single source = simple, no offline; cache = complex sync |
| **Coordination if multiple processes** | DB lock table, advisory locks, or single-process-only? | SQLite WAL handles correctness; the issue is duplicate work (esp. dreaming) |
| **Authentication** | Bearer token, mTLS, Tailscale ACL? | Tailscale ACL gives network-layer auth for free |

### What's been ruled out (so far)

- **Pattern B with CRDT sync** — too complex, not justified by use case
- **Pattern C hybrid (auto-elect leader from subprocess)** — file-system races, hard to debug

### What remains under consideration

- **Pattern A**: subprocess per platform + DB lock table for dreaming — works for single-machine
- **Pattern A'**: subprocess per platform on each machine, each machine has its own DB — defeats cross-device pool
- **Pattern B**: single daemon on Mac mini-1, all platforms connect via Tailscale HTTP — matches user's vision
- **Pattern C-lite**: Pattern B + small read-only local cache for offline — additive, can defer

### Open questions for user

1. Is **fail-closed when host unreachable** acceptable, or do you need offline reads?
2. Where should the daemon live by default? Mac mini-1?
3. Auto-start on boot via launchd, or manual?
4. Should the local OpenClaw plugin **embed an MCP client** that connects to remote daemon, or run its own subprocess that proxies?

### Progress

- [x] Identify three patterns (A, B, C) and trade-offs
- [x] Confirm SQLite WAL handles correctness (only "duplicate work" is a real issue)
- [x] User signals preference for Pattern B (single daemon, cross-device pool)
- [ ] Decide on host machine for daemon
- [ ] Decide on offline behavior
- [ ] Decide on lifecycle (manual vs auto-start)
- [ ] Decide on auth model
- [ ] Implementation plan

---

## Problem 2: Memory Scoping

> "When you have shared memory now you have to smartly, first smartly store the memory and classify them to the correct scope, and also when retrieving you have to consider all the scope context and everything."

### What it is

A shared memory pool sees inputs from many contexts: different devices, different projects, different agents, different platforms. Without context-awareness, memories from one project leak into another. The system must:

1. **At store time**: classify each memory's scope (where it's relevant)
2. **At recall time**: use the asker's context to filter or rank memories
3. **At judgment time**: surface provenance to the agent so it can decide what to use

### Current state

- `memories.scope` column exists (file: `src/memory.ts:200`), defaults to `'global'`
- `ScopeManager` (`src/scopes.ts`) supports patterns: `global`, `agent:X`, `custom:X`, `project:X`, `user:X`, `session:X`
- Recall **already filters by scope** in SQL (file: `src/memory.ts:511-514` for vector, `:566-569` for BM25)
- But: `mcp-server.ts:86` **hardcodes `scope: "global"`** for all stores — scope semantics unused in MCP path
- Metadata JSON column exists; today only tracks `entities`, `source` (`session-import`/`session-indexer`), `sessionId`
- `metadata.agentId`, `metadata.device`, `metadata.project` — **not tracked**
- No automatic scope classification on store

### User's first-pass understanding

- **OS analogy**: process isolation + shared memory pages. Default-isolated, explicit promotion to shared.
- **Three context dimensions to track**: device, project, origin (agent/source)
- **Judgment is key**: don't try to make the retrieval system perfectly correct — return memories with provenance and let the agent judge
- **Feedback loop is desirable** but should not be excessive (token cost, latency)
- "Don't overdo it" — surface judgment opportunity but don't force it on every recall

### Dimensions of the problem

| Dimension | Question | Notes |
|---|---|---|
| **Scope vocabulary** | What scope dimensions exist? device × project × agent? Multi-dimensional or flat namespace? | `agent:main` is flat. `project:memex/agent:main/device:mbp` is hierarchical. |
| **Default scope on store** | What's the default when scope is omitted? | Today: `global` in MCP, `agent:X` fallback in plugin |
| **Auto-classification** | LLM classifies, heuristics, or agent-decides explicitly? | LLM = accurate but extra call; heuristics = fast but error-prone |
| **Recall policy** | Strict filter, soft boost, or tiered? | Today: strict filter. Soft boost preserves cross-context value. |
| **Provenance surface** | What metadata is shown to the agent at recall? | Need: source, project, agent, age, recall_count |
| **Update vs create** | If agent gets a memory from a different scope and wants to "fix" it, does it create a new scoped memory or update the original? | Affects mental model — superseded_by chains? |
| **Feedback loop** | Should agent's judgment feed back into the system (boost recalled memories, demote ignored)? | Risk: feedback loop pollutes; benefit: auto-tuning |

### Possible store-time classification approaches

1. **LLM classify** — extra call per store, accurate, expensive
2. **Heuristics** — regex for "I prefer", "always", "never" → global; mention of specific files/projects → project-scoped
3. **Agent-explicit** — `memory_store` has a `scope` parameter the LLM sets
4. **Default by current context** — store in current project scope unless agent opts into global
5. **Hybrid (4 + 3)** — sensible default, agent can override

### Possible recall-time policy approaches

1. **Strict filter** — only return memories matching scope (today)
2. **Soft boost** — return all matching the scope hierarchy, boost current-context matches
3. **Tiered** — global → project → agent, stop when enough relevant results
4. **LLM-judges** — return more, with provenance; let the LLM filter

### Open questions for user

1. What **scope dimensions** matter to you? device + project + agent, or simpler?
2. Should `memex` know about your **project structure** (read directory paths)? Or scope is opaque (just labels)?
3. **Update semantics** — when agent updates a global preference, does it stay global? When it updates a project-scoped fact, does it stay project-scoped?
4. **Feedback loop scope** — should agent annotate "this was useful / not useful" on recalled memories? How is that signal used?
5. Is there a notion of **shared vs private** memories? E.g., should some memories never cross device boundaries (sensitive ones)?

### Progress

- [x] Identify three context dimensions (device, project, origin)
- [x] Confirm `scope` column exists but is underused
- [x] Confirm metadata column exists; provenance fields not yet stored
- [x] OS analogy validated — default-isolated, explicit-shared
- [x] User confirms judgment layer is critical; feedback loop desirable but bounded
- [ ] Decide scope vocabulary (multi-dim hierarchy vs flat)
- [ ] Decide store-time classification approach
- [ ] Decide recall-time policy
- [ ] Decide on feedback loop design (or defer)
- [ ] Implementation plan

---

## Working principle for these two problems

These problems are **decoupled**:

- Problem 1 is about **where the bytes live and how they travel**
- Problem 2 is about **what the bytes mean and how they're filtered**

Solving Problem 1 first (single daemon, cross-device pool) **makes Problem 2 more urgent** (shared pool = more contexts mixing).
Solving Problem 2 first (rich scope semantics) **makes Problem 1 more flexible** (we can ship subprocess-per-device first, daemon later, without changing data model).

A reasonable order: **Problem 2 first** (data model is more fundamental and harder to change later), **Problem 1 second** (deployment can change without affecting stored data).

But this is still under discussion — not a conclusion.

## Critical files (for reference)

- `src/memory.ts` — schema, store/recall, metadata handling
- `src/scopes.ts` — ScopeManager, accessible scopes logic
- `src/mcp-server.ts` — MCP entry, dreaming loop, hardcoded `scope: global`
- `index.ts` (root) — OpenClaw plugin, before_prompt_build hook (lines 1188-1319)
- `src/retriever.ts` & `src/unified-retriever.ts` — recall pipeline, scope filter consumption
- `src/dreaming.ts` — dream cycle (light/deep/reflection)
- `node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.d.ts` — HTTP transport (unused)
- `.mcp.json` — current Claude Code MCP config (uses MagicDNS hostnames)

## Verification approach (for whichever change ships first)

- Tests: `node --import jiti/register --test tests/*.test.ts` (currently 710 tests pass)
- E2E: spawn MCP server, send JSON-RPC over stdio, verify tool calls
- Production validation: run `scripts/dream-dry-run.ts` against live DB
- Integration: live MCP tools in Claude Code session (already working)
