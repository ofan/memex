# Claude Code Integration — Use Cases & Constraints

**Date:** 2026-04-13 · **Updated:** 2026-07-11
**Status:** Brainstorm — many questions resolved by v0.7.x implementation. Notes below reflect current state.

---

## The question

Memex was built for OpenClaw. Now it's also an MCP server for Claude Code.
What should the experience be? What problems does memex solve for Claude Code users?

## What Claude Code already has

| Capability | Built-in | Memex adds |
|---|---|---|
| File search | Grep, Glob, Read | Nothing — Claude Code is better at this |
| Project context | CLAUDE.md (one file) | Could add structured memory per project |
| Cross-session memory | None — each session starts fresh | Persistent memory across sessions |
| User preferences | CLAUDE.md (manual) | Auto-learned preferences (auto-capture in OpenClaw; explicit memory_store in Claude Code) |
| Codebase knowledge | Reads files on demand | Indexed, searchable knowledge base (document_search) |
| Session history | Conversation compaction | Extracted learnings from past sessions (dreaming reflection) |
| Project isolation | None — CLAUDE.md is per-project but flat | Multi-valued scope tags with server-authoritative derivation |

**The gap Claude Code has:** No memory between sessions. Every conversation starts cold. CLAUDE.md helps but is manually maintained and limited to one file.

## Use cases (what users would want)

### UC1: Cross-session memory (the core)
"Remember that I prefer functional components" / "Remember the deploy process"
- Store facts, preferences, decisions during conversation
- Recall them in future conversations
- **This works today** via memory_store + memory_recall MCP tools
- **Implemented:** MCP tools available in Claude Code via .mcp.json (stdio or HTTP transport)
- **Reranking:** Cross-encoder (Qwen3-Reranker-0.6B) and LLM reranker (deepseek-v4-flash) available, env-var gated

### UC2: Project-scoped memory
"This project uses pnpm, not npm" / "The API base URL is /api/v2"
- Memory that's specific to a project, not global
- Different projects have different conventions
- **Implemented:** Scope tags (`memory_scopes` table, `src/scope-derive.ts`). Server-authoritative derivation auto-tags `global` + `project:<git-remote-hash>`. MCP tools accept `scopes`, `agent_id`, `session_id` params. Tag-intersection filtering prevents cross-project leakage. Configurable DB path via `MEMEX_DB_PATH` for per-project isolation.

### UC3: Codebase indexing
"What does the auth middleware do?" / "How does the payment flow work?"
- Index the codebase as searchable knowledge
- More than file search — semantic understanding
- **Needs:** document indexing pipeline (memex already has this for OpenClaw)

### UC4: Team knowledge
"What did the team decide about the database migration?"
- Shared memory across team members
- **Needs:** shared DB (maybe via git or cloud sync)

### UC5: Auto-learning from sessions
"Remember what we discussed about the API redesign"
- Extract knowledge from conversation history
- **Needs:** The OpenClaw plugin has auto-capture (LLM nudged to call memory_store). Claude Code MCP path relies on explicit memory_store calls from the agent, assisted by MCP server instructions. Dreaming reflection (LLM-based) consolidates stored memories into learnings. No session-extraction pipeline exists for Claude Code standalone.

## Constraints

| Constraint | Detail |
|---|---|
| Zero config ideal | Users shouldn't need to set up embedding servers |
| Works offline | Can't depend on cloud APIs for basic functionality |
| Privacy | Memories stay local (no cloud sync by default) |
| Performance | Recall must be fast enough for every conversation start |
| CLAUDE.md compatibility | Should complement, not replace CLAUDE.md |
| Multiple projects | Users work on many repos, each with different context |

## Architecture options

### Option A: BM25-only (zero infrastructure)
- No embedding server needed
- Keyword search only — good enough for explicit facts, bad for semantic
- Works offline, zero config
- Tradeoff: lower recall quality

### Option B: Local embeddings (bundled model)
- Bundle a small embedding model (EmbeddingGemma-300M, ~200MB)
- Runs in the MCP server process
- No external dependency
- Tradeoff: startup time, memory usage

### Option C: Cloud embeddings (API key)
- Use OpenAI/Voyage/etc. embeddings
- Best quality, simplest code
- Tradeoff: requires API key, costs money, needs internet

### Option D: Configurable (current — implemented)
- Embedding endpoint is optional (OpenAI-compatible API)
- BM25 fallback when no embedder
- User brings their own infrastructure
- **Production deployment:** All inference (embed + rerank + LLM) routed through a single llm-proxy. Embed model: qwen3-embedding (Qwen3-Embedding-4B). Reranker: cross-encoder (Qwen3-Reranker-0.6B) and/or LLM reranker (deepseek-v4-flash, opt-in). Server runs as HTTP daemon on a dev host, shared across devices.
- Tradeoff: complex setup for full features, but one proxy endpoint simplifies configuration

## DB strategy options

### DB-A: Single global DB
- One memex.sqlite for all projects
- All memories in one pool
- Scope by project via metadata
- Pro: cross-project knowledge, simple
- Con: noisy recall, privacy across projects

### DB-B: Per-project DB
- Each project gets its own memex.sqlite (in .claude/ or project root)
- Clean separation, project-specific context
- Pro: focused recall, no cross-contamination
- Con: no shared knowledge, duplicate preferences

### DB-C: Global + project (layered)
- Global DB for user preferences and cross-project facts
- Project DB for project-specific knowledge
- Recall merges both, prioritizing project-local
- Pro: best of both worlds
- Con: complexity, merge logic

### DB-D: Configurable (let user choose) — implemented
- Default: global DB at `~/.openclaw/memory/memex/memex.sqlite`
- Override: `MEMEX_DB_PATH` env var or `--db` CLI flag
- Scope tags provide project isolation within a shared DB (server-authoritative, auto-derived from git remote)
- User decides per-project vs shared
- Pro: flexible, scope tags prevent cross-contamination without separate DBs
- Con: user has to think about it

## Relationship to CLAUDE.md

CLAUDE.md is Claude Code's built-in project context file. Options:

### MD-A: Memex replaces CLAUDE.md
- Auto-recall injects context, no manual file needed
- Bad: CLAUDE.md is version-controlled, team-shared, human-readable

### MD-B: Memex complements CLAUDE.md
- CLAUDE.md for static project rules (team conventions, repo structure)
- Memex for dynamic learned knowledge (preferences, decisions, insights)
- Best: each does what it's good at

### MD-C: Memex generates CLAUDE.md sections
- Dreaming produces a "learned context" block that gets appended to CLAUDE.md
- Version-controlled, human-auditable
- Like Mastra's append-only observation log, but as a file

## Questions for user — answers as of v0.7.3

1. **Primary use case?** Cross-session memory (UC1) + project-scoped (UC2). Both work via the same MCP server. Codebase indexing (UC3) is handled by document_search (separate pipeline).
2. **Embedding strategy?** Configurable (D). Production uses an OpenAI-compatible proxy. BM25 fallback works for zero-config usage.
3. **DB scope?** Configurable (DB-D). Default global DB at `~/.openclaw/memory/memex/memex.sqlite`. Scope tags prevent cross-project contamination.
4. **CLAUDE.md relationship?** Complement (MD-B). CLAUDE.md for static project rules, memex for dynamic learned knowledge.
5. **Should memex work for Claude Code users who don't have OpenClaw?** Yes — the MCP server is standalone. OpenClaw plugin and MCP server share the same DB so users can use both.
