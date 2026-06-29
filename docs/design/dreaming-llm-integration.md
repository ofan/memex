# Dreaming LLM Integration Design

**Date:** 2026-04-12
**Project:** Project 3 (Dreaming Reflection) from `docs/plans/02-projects.md`
**Goal:** Wire an LLM chat endpoint into the MCP server so dreaming reflection runs autonomously.

---

## Problem

Reflection code exists (`src/dreaming.ts:reflectionSweep`) but can't run because:
1. No LLM config flows from MCP server → dream cycle → reflection
2. Background dreaming timer hardcodes `reflection: false`
3. No env vars for LLM endpoint

## Design

### Config flow

```
.mcp.json env vars
    ↓
MCP server CLI (main())
    ↓
createMemexMcpServer({ ..., reflectionLLM })
    ↓
background dreaming timer
    ↓
runDreamCycle(store, { phases: { reflection: true }, reflectionLLM })
    ↓
reflectionSweep(store, llmConfig)
    ↓
fetch(llmConfig.endpoint + "/v1/chat/completions")
```

### Env vars

```
MEMEX_LLM_ENDPOINT   — base URL (e.g. http://<host>:<port>), /v1/chat/completions appended
MEMEX_LLM_MODEL      — model name for chat completions
MEMEX_LLM_API_KEY    — optional, falls back to MEMEX_EMBED_API_KEY, then op://
```

Same pattern as embedding config. Same inference host, different model.

### Changes

| File | Change |
|---|---|
| `src/mcp-server.ts` | Read LLM env vars, pass `reflectionLLM` to `createMemexMcpServer`, wire into dream timer |
| `src/dreaming.ts` | `reflectionSweep` already accepts `ReflectionLLMConfig` — no changes needed |
| `tests/mcp-server.test.ts` | Add test: dream with reflection config passes through to reflectionSweep |

### reflectionSweep endpoint format

`reflectionSweep` currently calls `fetch(llmConfig.endpoint, ...)` — it expects the full chat completions URL. The MCP server should construct:

```typescript
const reflectionLLM = {
  endpoint: `${baseURL}/v1/chat/completions`,
  model: llmModel,
  apiKey: llmApiKey,
};
```

### Background timer update

Current:
```typescript
await runDreamCycle(store, {
  enabled: true,
  phases: { light: true, deep: true, reflection: false },
});
```

New:
```typescript
await runDreamCycle(store, {
  enabled: true,
  phases: { light: true, deep: true, reflection: !!reflectionLLM },
  reflectionLLM,
});
```

### memory_dream tool update

The `/dream` MCP tool should also support reflection when LLM is configured:
```typescript
phases: {
  light: phase === "all" || phase === "light",
  deep: phase === "all" || phase === "deep",
  reflection: (phase === "all" || phase === "reflect") && !!reflectionLLM,
},
reflectionLLM,
```

## Testing

1. Unit test: `createMemexMcpServer` with reflectionLLM config → dream cycle includes reflection
2. Unit test: `memory_dream` tool with phase="reflect" → calls reflectionSweep
3. Production test: run against live DB with real LLM, verify learnings

## Not in scope

- Dedicated reflection LLM model selection (use whatever's on the inference host)
- Reflection scheduling separate from dreaming (same timer)
- Reflection quality tuning (prompt iteration comes after first production run)
