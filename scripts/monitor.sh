#!/bin/bash
export PATH="/home/linuxbrew/.linuxbrew/bin:/usr/bin:/usr/local/bin:$PATH"
# Memex dreaming monitor — runs via cron, appends to report file
# Usage: */30 * * * * /home/ubuntu/projects/memex/scripts/monitor.sh

REPORT="/home/ubuntu/.openclaw/memory/memex/monitor-report.log"
DB="/home/ubuntu/.openclaw/memory/memex/memex.sqlite"
DREAM_LOG="/home/ubuntu/.openclaw/memory/memex/memex.log"
TS=$(date +%Y-%m-%dT%H:%M:%S%z)

echo "=== $TS ===" >> "$REPORT"

# Gateway alive?
if pgrep -f "openclaw-gateway" > /dev/null; then
  echo "gateway: up (pid $(pgrep -f openclaw-gateway | head -1))" >> "$REPORT"
else
  echo "gateway: DOWN" >> "$REPORT"
fi

# DB stats
sqlite3 "$DB" "
SELECT 'pool_size=' || COUNT(*) FROM memories;
SELECT 'fragments=' || COUNT(*) FROM memories WHERE (text LIKE '[assistant]%' OR text LIKE '[user]%');
SELECT 'dupes=' || COUNT(*) FROM (SELECT text, COUNT(*) as cnt FROM memories GROUP BY text HAVING cnt > 1);
SELECT 'avg_importance=' || ROUND(AVG(importance), 3) FROM memories;
SELECT 'recalled_ever=' || COUNT(*) FROM memories WHERE recall_count > 0;
SELECT 'null_hash=' || COUNT(*) FROM memories WHERE text_hash IS NULL;
" 2>/dev/null >> "$REPORT"

# Dream log — last entry
if [ -f "$DREAM_LOG" ]; then
  echo "last_dream=$(tail -1 "$DREAM_LOG")" >> "$REPORT"
else
  echo "last_dream=none" >> "$REPORT"
fi

# Embedding server
EMBED_MS=$(curl -s -o /dev/null -w "%{time_total}" http://REDACTED_IP:8090/v1/models 2>/dev/null)
echo "embed_server=${EMBED_MS}s" >> "$REPORT"

echo "" >> "$REPORT"
