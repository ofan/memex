---
name: memex
description: "Unified memory plugin for OpenClaw — conversation memory + document search in a single SQLite database. 90% E2E accuracy on LongMemEval (ICLR 2025) with GPT-4o. 3 tools: recall, store, forget. Works with any OpenAI-compatible embedding API."
metadata:
  openclaw:
    kind: memory
---

# Memex — Unified Memory for OpenClaw

## LongMemEval (ICLR 2025)

| System | E2E Accuracy | Reader LLM |
|---|---|---|
| Hindsight/TEMPR | 91.4% | GPT-4o |
| **Memex** | **90%** | GPT-4o |
| Zep/Graphiti | ~85% | GPT-4o |
| mem0 | ~78% | GPT-4o |
| MemGPT | ~75% | GPT-4o |

## Install

```bash
clawhub install memex --dir ~/.openclaw/plugins --force
cd ~/.openclaw/plugins/memex && npm install
```

## Minimal Config

Only `embedding.apiKey` is required:

```bash
openclaw config set plugins.slots.memory memex
openclaw config set plugins.entries.memex.config.embedding '{"provider":"openai-compatible","apiKey":"${EMBED_API_KEY}","model":"text-embedding-3-small","baseURL":"https://api.openai.com/v1"}'
```

## Config Reference

### Auto-Recall (memory injection)

Injects relevant memories into the prompt before each turn.

```bash
# On by default. To disable:
openclaw config set plugins.entries.memex.config.autoRecall false

# Limit to specific agents (default: all agents):
openclaw config set plugins.entries.memex.config.autoRecallAgents '["main","cabbie"]'

# Number of results per turn (default: 3, R@3=90%, R@5=96%):
openclaw config set plugins.entries.memex.config.autoRecallLimit 5
```

### Auto-Capture (LLM-driven storage)

Injects a system prompt nudging the LLM to store facts via `memory_store`.

```bash
# On by default. To disable:
openclaw config set plugins.entries.memex.config.autoCapture false

# Limit to specific agents:
openclaw config set plugins.entries.memex.config.autoCaptureAgents '["main"]'
```

### Scopes (per-agent memory isolation)

Control which agent sees which memories.

```bash
# Give an agent access to global + its own scope (default):
openclaw config set plugins.entries.memex.config.scopes.agentAccess.coder '["global","agent:coder"]'

# Isolate an agent — only sees its own memories:
openclaw config set plugins.entries.memex.config.scopes.agentAccess.coder '["agent:coder"]'

# Set all scopes at once:
openclaw config set plugins.entries.memex.config.scopes '{"default":"global","agentAccess":{"main":["global","agent:main"],"coder":["agent:coder"],"infra":["global","agent:infra"]}}'
```

### Document Search

Auto-discovers agent workspace markdown files. On by default.

```bash
# Disable:
openclaw config set plugins.entries.memex.config.documents.enabled false

# Change re-index interval (default 30 min, 0 = disabled):
openclaw config set plugins.entries.memex.config.documents.reindexIntervalMinutes 60
```

### Reranker (optional)

Cross-encoder reranker. Off by default. Recommended when `autoRecallLimit=1`.

```bash
openclaw config set plugins.entries.memex.config.reranker '{"enabled":true,"endpoint":"http://localhost:8090/v1/rerank","model":"bge-reranker-v2-m3-Q8_0"}'
```

## All Settings

| Setting | Default | Description |
|---|---|---|
| `embedding.apiKey` | (required) | Embedding API key |
| `embedding.model` | text-embedding-3-small | Embedding model |
| `embedding.baseURL` | — | OpenAI-compatible endpoint |
| `autoRecall` | true | Inject memories before each turn |
| `autoRecallAgents` | (all) | Agent whitelist for recall |
| `autoRecallLimit` | 3 | Results per turn |
| `autoCapture` | true | LLM-driven memory storage |
| `autoCaptureAgents` | (all) | Agent whitelist for capture |
| `scopes.default` | global | Default memory scope |
| `scopes.agentAccess` | (all global) | Per-agent scope access |
| `documents.enabled` | true | Document search |
| `reranker.enabled` | false | Cross-encoder reranker |
