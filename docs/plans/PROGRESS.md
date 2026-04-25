# Progress

## Last Updated: 2026-04-25

## Active Architectural Tracking

**Two open architectural problems** are being formalized — see `docs/plans/two-problems-architecture.md`:

1. **MCP Process Architecture** — single daemon vs subprocess-per-platform; user wants cross-device pool (Pattern B, single daemon on Mac mini-1 via Tailscale)
2. **Memory Scoping** — provenance metadata (device × project × agent), classification on store, recall policy, judgment layer

Both problems are in **understanding phase**. Do not collapse into a single plan. Reasonable order: Problem 2 first (data model), Problem 1 second (deployment).

## Last Updated: 2026-04-13

## Current State

**Retrieval quality:** 94% E2E (LongMemEval, GPT-4o), 82% R@1, 90% R@3. Domain eval 12/15.
**Test suite:** 710 tests, all passing.
**Architecture:** Single SQLite DB. Dual retriever: MemoryRetriever (tools) + UnifiedRetriever (auto-recall). MCP server for cross-platform access. Background dreaming with LLM reflection.

## Roadmap Status

| # | Project | Status |
|---|---|---|
| 1 | Pool Cleanup | **Done** — session import decay, entity gating, 1,652 entries at 0.1 pending eviction |
| 2 | MCP Server | **Done** — 5 tools, stdio, env config, op injection, BM25 fallback, background dreaming, server instructions. 11 tests. Live in Claude Code. |
| 3 | Dreaming Reflection | **Done** — Stanford question synthesis, contradiction detection, LLM wiring, E2E verified (3 learnings, 2 contradictions from production). 27 dreaming tests. |
| ~~4~~ | ~~Session Import v2~~ | **Killed** — real-time capture via `memory_store` replaces batch import |
| 4 | Model Bakeoff | Queued — EmbeddingGemma-300M, Contextual AI Reranker v2 |
| 5 | Memory Hierarchy | Future |
| **NEW** | Claude Code Integration | **Research needed** — design doc at `docs/design/claude-code-integration.md` |

## Commits This Session (2026-04-12 to 2026-04-13)

| Commit | What |
|---|---|
| `aa37247` | Pool cleanup: session import decay + entity feature gating |
| `56b52f2` | MCP server: 5 tools, stdio, background dreaming |
| `f384b01` | Dreaming reflection: LLM synthesis + contradiction detection |
| `165aabb` | MCP: shared DB, BM25-only mode |
| `7bebad9` | Gitignore .mcp.json, env var for API key |
| `cc58895` | .mcp.json: jiti loader, absolute paths |
| `9315017` | MCP: full env-driven config, op for API key |
| `01201ed` | Remove hardcoded op call from server |
| `eacef48` | Kill session import v2, dreaming is core feature |
| `85c212a` | Wire LLM config into MCP server for reflection |
| `a65e0b0` | Fix: reflection handles reasoning models, max_tokens 8192 |
| `e064b65` | Configurable background dreaming schedule |
| `4720c17` | Dreaming dry-run script + docs visualization |
| `0543cfe` | Progress update |
| `84decae` | MCP server instructions — auto-recall and auto-store |

## Key Decisions

- 2026-04-13: MCP server instructions inject auto-recall/auto-store prompting via protocol (more reliable than CLAUDE.md)
- 2026-04-13: Session import v2 killed — real-time capture replaces batch import
- 2026-04-13: Dreaming is the core feature — the memory lifecycle
- 2026-04-13: Claude Code integration needs product design research (use cases, DB strategy, embedding strategy)
- 2026-04-12: MCP server is infrastructure, not just adoption
- 2026-04-12: Entity boost + entity graph gated off (net-neutral on quality)
- 2026-04-12: Session import decay rules (>14d → 0.1, >30d → evict)
- 2026-04-12: op injection via `op run` in .mcp.json for secrets

## Open Questions (Claude Code Integration)

1. **DB scope:** Global pool (shared with OpenClaw) vs per-project vs layered?
2. **Embedding strategy:** Zero-config BM25-only vs bundled local model vs cloud API?
3. **CLAUDE.md relationship:** Complement (static rules vs dynamic memory) vs generate sections?
4. **Document search:** Needed in Claude Code (which has file access) or OpenClaw-only?
5. **Standalone product:** Should memex work for users without OpenClaw?

Design doc: `docs/design/claude-code-integration.md`

## Next Session Should

1. **Research Claude Code integration** — study how other MCP memory servers handle DB scope, embedding, project context
2. **Verify session import eviction** — entries cross 30d on ~April 14
3. **Decide on Claude Code product direction** based on research
