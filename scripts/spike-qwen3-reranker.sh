#!/bin/bash
#
# Spike: verify Qwen3-Reranker-0.6B boots and serves /v1/rerank on an
# Apple Silicon Mac with llama.cpp, without crashing or pushing the host
# into swap. Runs OUTSIDE llama-swap on a dedicated test port so the
# production embedding lane is not disturbed.
#
# Context:
#   - llama.cpp issue #19756 reports stack-overflow on Apple Silicon when
#     running Qwen3-Reranker-0.6B with --rerank. Closed stale on
#     2026-04-07, never reproduced by maintainers, never fixed. One user
#     in the same thread confirmed bge-reranker-v2-m3 works on the same
#     M2 Max, so the issue is specific to the Qwen3 reranker path.
#   - PR #20009 (instruction-aware rerank) is still OPEN as of 2026-04-10.
#     Scores from this spike are a LOWER BOUND on the model's real quality.
#
# Host assumptions:
#   - macOS on Apple Silicon (M-series)
#   - llama.cpp built from source or installed via brew; `llama-server`
#     on PATH. If you built from source, point LLAMA_SERVER at the binary.
#   - ~/models/ as the model directory (override with MODEL_DIR).
#   - curl, jq, awk, vm_stat, memory_pressure available.
#
# Usage:
#   chmod +x scripts/spike-qwen3-reranker.sh
#   ./scripts/spike-qwen3-reranker.sh              # run full spike
#   ./scripts/spike-qwen3-reranker.sh --download   # download model only
#   ./scripts/spike-qwen3-reranker.sh --cleanup    # kill test server
#
# Safe-to-run guarantees:
#   - Uses port 8099 (not the llama-swap port). Override with SPIKE_PORT.
#   - Does not modify llama-swap.yaml or touch any existing model files.
#   - Writes model into $MODEL_DIR/spike/ subdir so it's easy to delete.
#   - Clean SIGTERM on exit; verifies RAM returns before declaring success.
#
set -uo pipefail

MODEL_DIR="${MODEL_DIR:-$HOME/models}"
SPIKE_DIR="$MODEL_DIR/spike"
MODEL_FILE="$SPIKE_DIR/Qwen3-Reranker-0.6B-Q8_0.gguf"
MODEL_URL="https://huggingface.co/ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/resolve/main/qwen3-reranker-0.6b-q8_0.gguf?download=true"
SPIKE_PORT="${SPIKE_PORT:-8099}"
LLAMA_SERVER="${LLAMA_SERVER:-llama-server}"
LOG_DIR="${LOG_DIR:-/tmp/memex-spike}"
SERVER_LOG="$LOG_DIR/llama-server.log"
RESULT_LOG="$LOG_DIR/results.log"
PID_FILE="$LOG_DIR/server.pid"

mkdir -p "$LOG_DIR" "$SPIKE_DIR"

# ---------- utilities ----------

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }
hr()    { printf '─%.0s' $(seq 1 60); echo; }
step()  { hr; yellow "▶ $*"; }

# Pull memory snapshot: pressure state + pageouts + swap usage in MB
snapshot_mem() {
  local label="$1"
  local pressure pageouts swapused_mb
  # memory_pressure prints multi-line; grab the "System-wide memory free percentage" line
  pressure=$(memory_pressure 2>/dev/null | awk -F': ' '/System-wide memory free percentage/ {print $2}' || echo "?")
  # vm_stat: pageouts (lifetime count of pages written to swap). Delta vs baseline matters.
  pageouts=$(vm_stat | awk '/Pageouts/ {gsub("\\.",""); print $2}' || echo "?")
  # sysctl vm.swapusage: "total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)"
  swapused_mb=$(sysctl -n vm.swapusage 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="used") {gsub("M","",$(i+2)); print $(i+2); exit}}' || echo "?")
  echo "[$label] mem_free_pct=$pressure pageouts=$pageouts swap_used_mb=$swapused_mb"
}

wait_for_port() {
  local port="$1" timeout="${2:-30}"
  local i=0
  while [ $i -lt "$timeout" ]; do
    if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; then
      return 2  # process died
    fi
    sleep 1
    i=$((i+1))
  done
  return 1
}

kill_server() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      yellow "Stopping test server (pid $pid)..."
      kill -TERM "$pid" 2>/dev/null
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$pid" 2>/dev/null; then
        red "Server did not exit on SIGTERM; sending SIGKILL"
        kill -KILL "$pid" 2>/dev/null
      fi
    fi
    rm -f "$PID_FILE"
  fi
}

trap 'kill_server' EXIT INT TERM

# ---------- sub-commands ----------

cmd_cleanup() {
  kill_server
  green "Cleanup done. Model file left at $MODEL_FILE (delete manually if desired)."
  exit 0
}

cmd_download() {
  if [ -f "$MODEL_FILE" ]; then
    green "Model already present: $MODEL_FILE ($(du -h "$MODEL_FILE" | awk '{print $1}'))"
    return 0
  fi
  step "Downloading Qwen3-Reranker-0.6B Q8_0 GGUF (~640MB)"
  echo "From: $MODEL_URL"
  echo "To:   $MODEL_FILE"
  curl -L --fail --progress-bar -o "$MODEL_FILE.part" "$MODEL_URL" || {
    red "Download failed"
    rm -f "$MODEL_FILE.part"
    exit 1
  }
  mv "$MODEL_FILE.part" "$MODEL_FILE"
  green "Downloaded $(du -h "$MODEL_FILE" | awk '{print $1}')"
}

# ---------- main spike ----------

case "${1:-}" in
  --cleanup)  cmd_cleanup ;;
  --download) cmd_download; exit 0 ;;
esac

: >"$RESULT_LOG"

step "0. Preflight"
command -v "$LLAMA_SERVER" >/dev/null || { red "llama-server not found on PATH (set LLAMA_SERVER=...)"; exit 1; }
"$LLAMA_SERVER" --version 2>&1 | head -5 | tee -a "$RESULT_LOG"
command -v jq >/dev/null || { red "jq not found"; exit 1; }

# Is the spike port free?
if lsof -iTCP:"$SPIKE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  red "Port $SPIKE_PORT is already in use. Pick another with SPIKE_PORT=... or free it."
  exit 1
fi

snapshot_mem "baseline" | tee -a "$RESULT_LOG"

step "1. Ensure model is present"
cmd_download

step "2. Boot llama-server with --rerank (THE crash test)"
# Start with modest -c 8192 to match the bug report. If it survives, we'll
# bump context later for the long-session test.
"$LLAMA_SERVER" \
  --model "$MODEL_FILE" \
  --port "$SPIKE_PORT" \
  --host 127.0.0.1 \
  --no-webui \
  -c 8192 \
  --pooling rank \
  --rerank \
  >"$SERVER_LOG" 2>&1 &
echo $! >"$PID_FILE"
echo "Started llama-server pid=$(cat "$PID_FILE"). Log: $SERVER_LOG"

if ! wait_for_port "$SPIKE_PORT" 45; then
  rc=$?
  red "Server did not become healthy (rc=$rc)."
  echo "--- last 40 lines of llama-server log ---"
  tail -40 "$SERVER_LOG"
  if [ $rc -eq 2 ]; then
    red "CRASH DETECTED: process exited. This is likely issue #19756 reproducing on your M4."
    red "Decision: Qwen3-Reranker-0.6B is NOT viable on this host until llama.cpp fixes the crash."
  fi
  exit 1
fi
green "Server is healthy on port $SPIKE_PORT. Boot survived — #19756 does NOT reproduce here."
snapshot_mem "after_load" | tee -a "$RESULT_LOG"

step "3. Rerank smoke test (short query, 3 documents)"
smoke=$(curl -sf "http://127.0.0.1:$SPIKE_PORT/v1/rerank" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3-reranker",
    "query": "How do I configure llama-swap for a reranker lane?",
    "documents": [
      "llama-swap.yaml accepts a models block with cmd and aliases for each lane.",
      "Paris is the capital of France.",
      "The BGE reranker v2 uses a Q8_0 GGUF of roughly 635MB."
    ]
  }')
if [ -z "$smoke" ]; then
  red "Smoke rerank call failed"
  tail -20 "$SERVER_LOG"
  exit 1
fi
echo "$smoke" | jq . | tee -a "$RESULT_LOG"
# Sanity: top-ranked document should be index 0 (the actual relevant one)
top_idx=$(echo "$smoke" | jq -r '.results | sort_by(-.relevance_score)[0].index')
if [ "$top_idx" = "0" ]; then
  green "✓ Top-ranked doc is the relevant one (index 0)"
else
  red "✗ Top-ranked doc is index=$top_idx, expected 0. Scores may be inverted or instruction template broken."
fi

step "4. Realistic top-10 test (memex-shaped query)"
# Ten candidate docs, mix of technical memories matching the entity-rich
# failure mode the brief flags. Target doc is index 3.
curl -sf "http://127.0.0.1:$SPIKE_PORT/v1/rerank" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3-reranker",
    "query": "What is the llama-swap port used for the memex embedding lane?",
    "documents": [
      "memex uses z-score fusion between vector and BM25 with a 0.8/0.2 weight split.",
      "The Qwen3-Embedding-4B model is 2560-dimensional and runs as a Q8_0 GGUF.",
      "Auto-recall injects memories via the before_prompt_build hook, not before_agent_start.",
      "llama-swap exposes the Qwen3-Embedding-4B lane on port 9090 via the embeddings alias.",
      "The domain eval harness uses GPT-4o as a reader model for end-to-end scoring.",
      "LongMemEval achieved R@1=78 and R@3=90 with the current stack.",
      "The reranker endpoint accepts jina-, siliconflow-, voyage-, and pinecone-shaped requests.",
      "CI publishes tagged releases via clawhub login --token from GitHub Actions.",
      "Telemetry relays to a Cloudflare Worker and fans out to D1 plus OpenPanel.",
      "The bge-reranker-v2-m3 Q8_0 GGUF is 635MB and supports an 8k context window."
    ]
  }' | jq '.results | sort_by(-.relevance_score)' | tee -a "$RESULT_LOG"

snapshot_mem "after_rerank_10" | tee -a "$RESULT_LOG"

step "5. Long-document stress test (simulated chunked session ~8k chars)"
# Build a single long document by repeating a block. This checks whether
# long inputs trigger the reported crash path or cause OOM.
long_doc=$(python3 -c '
import json
block = "memex stores retrieval memories as rows in SQLite with a vectors_vec virtual table for ANN search. The retrieval pipeline runs a hybrid score that blends dense similarity with BM25 and then applies a z-score normalization. "
doc = block * 40  # ~8000 chars
print(json.dumps(doc))
')
curl -sf "http://127.0.0.1:$SPIKE_PORT/v1/rerank" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --argjson d "$long_doc" '{
    model: "qwen3-reranker",
    query: "How does memex store and retrieve memories?",
    documents: [$d, "Paris is the capital of France.", "Flash attention reduces memory at long context."]
  }')" | jq '.results | sort_by(-.relevance_score)' | tee -a "$RESULT_LOG"

snapshot_mem "after_long_doc" | tee -a "$RESULT_LOG"

step "6. Latency: 5 sequential rerank calls with top-10"
for i in 1 2 3 4 5; do
  t=$( { time -p curl -sf -o /dev/null "http://127.0.0.1:$SPIKE_PORT/v1/rerank" \
      -H 'Content-Type: application/json' \
      -d '{"model":"qwen3-reranker","query":"latency probe","documents":["a","b","c","d","e","f","g","h","i","j"]}' ; } 2>&1 | awk '/real/ {print $2}')
  echo "rerank_$i=${t}s" | tee -a "$RESULT_LOG"
done

step "7. Final memory check"
snapshot_mem "final" | tee -a "$RESULT_LOG"

# Compare pageouts baseline vs final — if it grew, we spilled into swap
base_po=$(awk '/\[baseline\]/ {for(i=1;i<=NF;i++) if($i ~ /pageouts=/) {gsub("pageouts=","",$i); print $i}}' "$RESULT_LOG")
final_po=$(awk '/\[final\]/ {for(i=1;i<=NF;i++) if($i ~ /pageouts=/) {gsub("pageouts=","",$i); print $i}}' "$RESULT_LOG")
if [ -n "$base_po" ] && [ -n "$final_po" ]; then
  delta=$((final_po - base_po))
  if [ "$delta" -gt 1000 ]; then
    red "⚠ Pageouts grew by $delta during spike — host spilled into swap. Latency will suffer."
  else
    green "✓ Pageouts delta = $delta (no meaningful swap activity)."
  fi
fi

step "Spike complete"
green "Full result log: $RESULT_LOG"
green "Server log:      $SERVER_LOG"
echo
echo "Next step: diff the rerank scores against the equivalent bge-reranker-v2-m3"
echo "call on the same queries to see if Qwen3 beats the current baseline on memex-"
echo "shaped inputs before committing to a deployment plan."
