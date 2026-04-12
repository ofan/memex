# Progress

## Last Updated: 2026-04-12

## Current State

**Retrieval quality:** 94% E2E (LongMemEval, GPT-4o), 82% R@1, 90% R@3. Domain eval 12/15.
**Test suite:** 709 tests, all passing.
**Architecture:** Single SQLite DB. Dual retriever: MemoryRetriever (tools) + UnifiedRetriever (auto-recall). MCP server for cross-platform access.

## Roadmap Status

| # | Project | Status |
|---|---|---|
| 1 | Pool Cleanup | **Done** — session import decay (>14d → 0.1, >30d → evict), entity boost/graph gated off |
| 2 | MCP Server | **Done** — 5 tools (recall/store/forget/dream/stats), stdio transport, env-driven config, op injection, BM25-only fallback, background dreaming. 10 tests. E2E verified against production DB. |
| 3 | Dreaming Reflection | **Done** — Stanford question synthesis, contradiction detection via SUPERSEDED markers, idempotent learning storage. 5 tests. Not yet tested on production data. |
| ~~4~~ | ~~Session Import v2~~ | **Killed** — real-time capture via `memory_store` replaces batch import |
| 4 | Model Bakeoff | Queued — EmbeddingGemma-300M, Contextual AI Reranker v2 |
| 5 | Memory Hierarchy | Future — topic → episode → fact structure |

## Commits This Session (2026-04-12)

| Commit | What |
|---|---|
| `aa37247` | Pool cleanup: session import decay + entity feature gating |
| `56b52f2` | MCP server: 5 tools, stdio, background dreaming |
| `f384b01` | Dreaming reflection: LLM synthesis + contradiction detection |
| `165aabb` | MCP: shared DB test, BM25-only mode, .mcp.json |
| `7bebad9` | Gitignore .mcp.json, env var for API key |
| `cc58895` | .mcp.json: jiti loader, absolute paths |
| `9315017` | MCP: full env-driven config, op for API key, base URL |
| `01201ed` | Remove hardcoded op call from server code |

## Pool State

- 2,112 memories total
- 1,666 session imports (importance 0.3, from March 14 batch) — will be evicted when >30 days old
- 263 agent-stored memories (importance 0.6-0.95)
- 21 memories ever recalled (recall tracking added April 8; 254 agent memories predate it)
- After cleanup: pool will shrink to ~450 memories

## Key Decisions This Session

- 2026-04-12: MCP server is infrastructure (enables background processing), not just adoption
- 2026-04-12: Entity boost + entity graph gated behind disabled-by-default config flags
- 2026-04-12: Session import decay: source=session + never-recalled + imp≤0.3 → 0.1 after 14d, evict after 30d
- 2026-04-12: Server reads secrets via env vars, not hardcoded — op injection via `op run` in .mcp.json
- 2026-04-12: Dreaming reflection uses Stanford Generative Agents pattern (threshold → questions → synthesis)

## Next Session Should

1. **Add LLM config to MCP server** — `MEMEX_LLM_ENDPOINT` / `MEMEX_LLM_MODEL` env vars, wire into reflection
2. **Test reflection on production data** — run dream cycle with reflection, verify learnings are sensible
3. **Focus on dreaming** — this is now the core feature. Reflection → contradiction detection → memory evolution
4. Reference `02-projects.md` for ACs, `ROADMAP.md` for strategic context
