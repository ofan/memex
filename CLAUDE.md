# CLAUDE.md — memory-unified

## What This Is

An OpenClaw memory plugin that unifies conversation memory (LanceDB Pro) and document search (QMD replacement) into a single system with shared embedding and reranking backends.

## Project Structure

```
memory-unified/
├── CLAUDE.md              ← you are here
├── REQUIREMENTS.md        ← full requirements doc
├── index.ts               ← plugin entry point
├── cli.ts                 ← CLI interface
├── openclaw.plugin.json   ← plugin manifest
├── package.json
├── tsconfig.json
└── src/
    ├── store.ts           ← LanceDB storage (conversation memories)
    ├── doc-store.ts       ← LanceDB storage (document chunks) [NEW]
    ├── doc-indexer.ts     ← file discovery, chunking, incremental sync [NEW]
    ├── retriever.ts       ← 7-stage retrieval pipeline
    ├── unified-recall.ts  ← fan-out to both stores, merge, rerank [NEW]
    ├── embedder.ts        ← OpenAI-compatible embedding client
    ├── chunker.ts         ← smart document chunking
    ├── scopes.ts          ← multi-scope access control
    ├── tools.ts           ← agent tools (recall, store, forget, update)
    ├── noise-filter.ts    ← noise detection
    ├── adaptive-retrieval.ts ← skip retrieval for greetings
    └── migrate.ts         ← migration utilities
```

## Starting Point

This project is a fork of `memory-lancedb-pro` v1.0.22. The source is at:
`/home/ubuntu/.openclaw/plugins/memory-lancedb-pro/`

Copy all source files first, then add the new document store layer on top.

## Key Constraints

1. **Must remain backward compatible** — all existing memory tools (recall, store, forget, update) must work identically
2. **Same plugin kind** — `"kind": "memory"` in openclaw.plugin.json
3. **No MCP dependency** — document search is internal to the plugin, not an MCP server
4. **OpenAI-compatible embedding API** — the embedding layer uses the OpenAI SDK pointed at any compatible endpoint (Gemini, Ollama, local server, etc.)
5. **TypeScript, no build step** — OpenClaw loads .ts files directly (tsx/ts-node)

## Testing

- Deploy to `~/.openclaw/plugins/memory-unified/`
- Update `openclaw.json` to load it instead of `memory-lancedb-pro`
- Restart gateway and verify plugin loads
- Test conversation memory tools (should be identical to before)
- Test document indexing (trigger manual reindex, search for workspace content)

## Current Deployment

- **VM:** Ubuntu, Node 25.6.1, OpenClaw gateway
- **Mac Mini:** macOS, M4, available via Tailscale for local inference
- **Embedding (current):** Gemini `gemini-embedding-001` via OpenAI-compat endpoint
- **Reranker (current):** disabled (cosine fallback)
- **LanceDB data:** `~/.openclaw/memory/lancedb-pro/`
