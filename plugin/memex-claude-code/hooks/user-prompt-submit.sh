#!/usr/bin/env bash
# UserPromptSubmit hook: nudge the LLM to recall relevant memories for THIS turn.
# Conditional — skip for trivial messages where recall is unlikely to help.

set -euo pipefail

INPUT=$(cat)

# Extract the prompt text (best-effort — fall back to empty)
PROMPT=$(echo "$INPUT" | python3 -c "import sys,json
try:
    d = json.load(sys.stdin)
    print(d.get('prompt','') or d.get('message','') or '')
except Exception:
    print('')
" 2>/dev/null || echo "")

# Skip recall for very short prompts (greetings, confirmations) — saves tokens.
LEN=${#PROMPT}
if [ "$LEN" -lt 20 ]; then
  echo '{}'
  exit 0
fi

# Skip for one-word confirmations.
if echo "$PROMPT" | grep -iqE "^(ok|thanks|got it|done|cool|sure|yes|no|y|n|fine|good)\.?$"; then
  echo '{}'
  exit 0
fi

# Inject a per-turn nudge. The LLM decides whether to actually call memory_recall.
cat <<JSON
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "If this query could benefit from cross-session context (preferences, past decisions, project conventions, infrastructure facts), call mcp__memex__memory_recall before answering."
  }
}
JSON
