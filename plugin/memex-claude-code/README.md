# Memex — Claude Code plugin

Cross-session memory for Claude Code. Bundles:
- **MCP server config** — points at a memex daemon (HTTP) or local subprocess
- **Hooks** — `SessionStart`, `UserPromptSubmit`, `Stop` nudge the LLM to use memory tools

## Installation

```sh
claude plugin install /path/to/memex/plugin/memex-claude-code
```

Or symlink for development:

```sh
ln -s /path/to/memex/plugin/memex-claude-code ~/.claude/plugins/local/memex
```

## Configuration

The plugin's `.mcp.json` references two environment variables. Set them in your shell profile (or per-project `.env`):

```sh
# For an HTTP daemon (recommended — cross-device shared pool)
export MEMEX_ENDPOINT="http://memex-host.tailff9ac.ts.net:7878/mcp"
export MEMEX_AUTH_TOKEN="$(op read 'op://homelab/memex-daemon/memex-daemon-token')"
```

Or, if you want a local stdio subprocess instead of the HTTP daemon, replace `.mcp.json` with:

```json
{
  "mcpServers": {
    "memex": {
      "command": "op",
      "args": ["run", "--", "node", "/path/to/memex/node_modules/.bin/jiti", "/path/to/memex/src/mcp-server.ts"],
      "env": { "MEMEX_DB_PATH": "...", "MEMEX_EMBED_ENDPOINT": "...", ... }
    }
  }
}
```

## What the hooks do

| Hook | Trigger | Behavior |
|---|---|---|
| `SessionStart` | conversation begins / resume / clear / compact | Inject system instruction telling the LLM about `mcp__memex__*` tools. |
| `UserPromptSubmit` | every user message | If prompt is non-trivial (>20 chars, not a confirmation), nudge the LLM to call `memory_recall` for cross-session context. |
| `Stop` | end of assistant turn | Remind the LLM to capture any cross-session-worthy facts via `memory_store`. |

Hooks emit `additionalContext` text — they don't directly call MCP tools. The LLM decides whether to actually invoke recall/store.

## Why both MCP server and hooks?

- **MCP server** — exposes the tools (`memory_recall`, `memory_store`, `memory_forget`, `memory_dream`, `memory_stats`) so the LLM can call them.
- **Hooks** — deterministic per-turn nudges that improve the LLM's reliability about *when* to call the tools. The MCP `instructions` field only injects once at initialize; hooks run per turn.

## Verifying

After installing, run `claude` in any project. On the first user message, you should see:
- Auto-recall: the LLM calls `mcp__memex__memory_recall` to load context
- Auto-store: at the end of each turn, the LLM may call `mcp__memex__memory_store` for new facts

Check the daemon's logs for activity:

```sh
journalctl --user -u memex.service -f
```
