#!/usr/bin/env bash
# SessionStart hook: tell the LLM to load context from memex at conversation start.
# Hooks emit additionalContext that gets injected into the system prompt.

set -euo pipefail

# Read JSON input (we don't need anything from it for SessionStart).
cat > /dev/null

# Inject a brief instruction. The LLM will call memory_recall on its first turn.
cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Memex memory is available via mcp__memex__memory_recall, mcp__memex__memory_store, mcp__memex__memory_forget, mcp__memex__memory_dream, and mcp__memex__memory_stats. On your first response in this session, call memory_recall with a query derived from the user's first message to load relevant context. When you learn a new preference, fact, decision, or important insight worth remembering across sessions, call memory_store. Skip storing ephemeral state, file paths you just read, or anything already in the current conversation."
  }
}
JSON
