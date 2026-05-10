# Memex — Claude Code plugin

Cross-session memory for Claude Code. Bundles:
- **MCP server config** — points at a memex daemon (HTTP) via env-var references
- **Hooks** — `SessionStart`, `UserPromptSubmit`, `Stop` nudge the LLM to use memory tools

## Installation

Symlink for development:

```sh
ln -s /path/to/memex/plugin/memex-claude-code ~/.claude/plugins/local/memex
```

## Configuration

`.mcp.json` references `${MEMEX_ENDPOINT}` and `${MEMEX_AUTH_TOKEN}`. Set them
in Claude Code's `settings.json` `env` block — no shell exports needed:

`~/.claude/settings.json` (user-global) or `.claude/settings.json` (per-project):

```json
{
  "env": {
    "MEMEX_ENDPOINT": "http://<your-memex-host>:7878/mcp",
    "MEMEX_AUTH_TOKEN": "PASTE_YOUR_TOKEN_HERE"
  }
}
```

Pull the token from 1Password once and paste:

```sh
op read 'op://<your-vault>/memex-daemon/memex-daemon-token'
```

`settings.json` is git-ignored by Claude Code by default; safe place for the literal token.

### Local stdio fallback

If you don't want to run the daemon and prefer a per-session subprocess:

```json
{
  "mcpServers": {
    "memex": {
      "command": "op",
      "args": ["run", "--", "node", "/path/to/memex/node_modules/.bin/jiti", "/path/to/memex/src/mcp-server.ts"]
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

## Citation anchors

Every result from `mcp__memex__memory_recall` carries a stable 8-char `anchor` field (first hex chars of the memory's UUID). The recall response also includes a `note` instructing the model to cite memories by anchor when relying on them.

The intended LLM usage:

```
> "Use pnpm here, not npm [mem:7e9b4520]. Also note the user prefers tabs [mem:a3f1c0d2]."
```

To delete a stale memory, the LLM can call `mcp__memex__memory_forget` with the anchor (or any longer hex prefix) — no need to remember the full UUID:

```
mcp__memex__memory_forget({ id: "7e9b4520" })
```

If the prefix is ambiguous (multiple memories share it), the tool returns `error: anchor_ambiguous` with the matching ids. If nothing matches, `error: anchor_not_found`.

Why this matters: anchors give the model a control surface for memory it doesn't have to re-narrate. Empirically reduces reasoning-token usage (see ENGRAM-R, `arXiv:2511.12987`).

## Why both MCP server and hooks?

- **MCP server** — exposes the tools (`memory_recall`, `memory_store`, `memory_forget`, `memory_dream`, `memory_stats`) so the LLM can call them.
- **Hooks** — deterministic per-turn nudges that improve the LLM's reliability about *when* to call the tools. The MCP `instructions` field only injects once at initialize; hooks run per turn.

## Verifying

After installing, restart Claude Code. On the first user message, you should see:
- Auto-recall: the LLM calls `mcp__memex__memory_recall` to load context
- Auto-store: at the end of each turn, the LLM may call `mcp__memex__memory_store` for new facts

Daemon logs show activity:

```sh
journalctl --user -u memex.service -f
```
