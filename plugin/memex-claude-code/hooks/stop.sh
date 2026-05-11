#!/usr/bin/env bash
# Stop hook: remind the LLM to capture any new memorable facts from this turn.
# Auto-store extraction. The LLM decides whether to actually call memory_store.

set -euo pipefail

# Read input (we don't process the transcript here — the LLM decides what to store)
cat > /dev/null

cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "Stop",
    "additionalContext": "Before ending this turn, scan what was discussed for any cross-session-worthy memories. If you learned a new user preference, made an architectural decision, identified a project convention, or formed a useful insight, call mcp__memex__memory_store with concise text. Skip ephemeral state, file paths, debugging output, or anything already in conversation context."
  }
}
JSON
