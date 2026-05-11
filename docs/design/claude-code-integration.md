# Claude Code Integration — Use Cases & Constraints

**Date:** 2026-04-13
**Status:** Brainstorm — needs user input on direction

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
| User preferences | CLAUDE.md (manual) | Auto-learned preferences |
| Codebase knowledge | Reads files on demand | Indexed, searchable knowledge base |
| Session history | Conversation compaction | Extracted learnings from past sessions |

**The gap Claude Code has:** No memory between sessions. Every conversation starts cold. CLAUDE.md helps but is manually maintained and limited to one file.

## Use cases (what users would want)

### UC1: Cross-session memory (the core)
"Remember that I prefer functional components" / "Remember the deploy process"
- Store facts, preferences, decisions during conversation
- Recall them in future conversations
- **This works today** via memory_store + memory_recall MCP tools

### UC2: Project-scoped memory
"This project uses pnpm, not npm" / "The API base URL is /api/v2"
- Memory that's specific to a project, not global
- Different projects have different conventions
- **Needs:** per-project DB or scoped memories within shared DB

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
- **Needs:** session extraction (killed for batch, but could work incrementally via auto-capture)

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

### Option D: Configurable (current)
- Embedding endpoint is optional
- BM25 fallback when no embedder
- User brings their own infrastructure
- Tradeoff: complex setup for full features

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

### DB-D: Configurable (let user choose)
- Default: global DB at ~/.memex/memex.sqlite
- Override: MEMEX_DB_PATH in .mcp.json per project
- User decides per-project vs shared
- Pro: flexible
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

## Questions for user

1. **Primary use case?** Cross-session memory (UC1), project-scoped (UC2), codebase indexing (UC3), or all?
2. **Embedding strategy?** Zero-config BM25 (A), bundled model (B), cloud API (C), or configurable (D)?
3. **DB scope?** Global (DB-A), per-project (DB-B), layered (DB-C), or configurable (DB-D)?
4. **CLAUDE.md relationship?** Replace (MD-A), complement (MD-B), or generate sections (MD-C)?
5. **Should memex work for Claude Code users who don't have OpenClaw?** (i.e., standalone product)
