/**
 * Latency probe — measure unified recall end-to-end latency with the
 * configured reranker + entity graph stack.
 *
 * Usage:
 *   # Required sensitive env (from 1Password):
 *   export EMBED_API_KEY=$(op read "op://<vault>/<item>/MEMEX_LLAMA_SWAP_API_KEY")
 *   export MEMEX_RERANK_API_KEY="$EMBED_API_KEY"
 *
 *   # Non-sensitive config — read from live openclaw config, not 1Password:
 *   export EMBED_BASE_URL=$(python3 -c "import json; \
 *     print(json.load(open('$HOME/.openclaw/openclaw.json'))['plugins']['entries']['memex']['config']['embedding']['baseURL'])")
 *   export MEMEX_RERANK_ENDPOINT="${EMBED_BASE_URL}/rerank"
 *   export MEMEX_RERANK_MODEL=Qwen3-Reranker-0.6B-Q8_0
 *   export EMBED_MODEL=Qwen3-Embedding-4B-Q8_0
 *   export VECTOR_DIM=2560
 *   export EVAL_DB=$HOME/.openclaw/memory/memex/memex.sqlite
 *
 *   # Run (rerank on by default, RERANK=0 to disable for A/B):
 *   node --import jiti/register tests/latency-probe.ts
 *   RERANK=0 node --import jiti/register tests/latency-probe.ts
 */
import { MemoryStore } from "../src/memory.js";
import { UnifiedRetriever } from "../src/unified-retriever.js";
import { createEmbedder } from "../src/embedder.js";
import { performance } from "node:perf_hooks";

const DB_PATH = process.env.EVAL_DB || "";
const EMBED_BASE_URL = process.env.EMBED_BASE_URL || "";
const EMBED_API_KEY = process.env.EMBED_API_KEY || "";
const EMBED_MODEL = process.env.EMBED_MODEL || "";
const VECTOR_DIM = parseInt(process.env.VECTOR_DIM || "0");
const RERANK_ENABLED = process.env.RERANK !== "0";  // default ON matching prod
const RERANK_ENDPOINT = process.env.MEMEX_RERANK_ENDPOINT || "";
const RERANK_API_KEY = process.env.MEMEX_RERANK_API_KEY || "";
const RERANK_MODEL = process.env.MEMEX_RERANK_MODEL || "";

const QUERIES = [
  // Short technical lookups (memex's bread and butter)
  "What model is running on the inference host?",
  "What's the rule about sorry and absolutely right?",
  "How does Ryan want responses formatted?",
  // Multi-entity
  "Why did Virgil switch from Gemma to Qwen?",
  "What does Ryan want the assistant to stop doing?",
  // Temporal
  "What models were deployed last week?",
  // Medium-complexity rule queries
  "What's the Homebrew installation rule?",
  "Should new repos be private or public?",
];

async function main() {
  if (!DB_PATH || !EMBED_BASE_URL || !EMBED_API_KEY || !EMBED_MODEL || !VECTOR_DIM) {
    console.error("Missing env vars.");
    process.exit(1);
  }

  console.log(`DB: ${DB_PATH}`);
  console.log(`Rerank: ${RERANK_ENABLED ? "ENABLED (" + RERANK_MODEL + ")" : "disabled"}`);
  console.log();

  const store = new MemoryStore({ dbPath: DB_PATH, vectorDim: VECTOR_DIM });
  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: EMBED_API_KEY,
    model: EMBED_MODEL,
    baseURL: EMBED_BASE_URL,
    dimensions: VECTOR_DIM,
  });

  const retriever = new UnifiedRetriever(
    store,
    null,  // no document search fn
    embedder,
    {
      reranker: RERANK_ENABLED ? {
        endpoint: RERANK_ENDPOINT,
        apiKey: RERANK_API_KEY,
        model: RERANK_MODEL,
        provider: "jina",
      } : null,
      queryExpansion: false,
    },
  );

  // Warmup: first call always slow because embedder+swap+rerank cold
  console.log("Warming up...");
  await retriever.retrieve("warmup query", { limit: 5 });

  console.log(`\nRunning ${QUERIES.length} queries × 3 iterations each:\n`);

  const allTimings: number[] = [];
  let failures = 0;
  for (const query of QUERIES) {
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      try {
        await retriever.retrieve(query, { limit: 5 });
        const t1 = performance.now();
        times.push(t1 - t0);
      } catch (e) {
        failures++;
        // Skip failed samples — embedding server can 502 intermittently
      }
    }
    if (times.length === 0) {
      console.log(`  [  all 3 iterations failed]   "${query.slice(0, 60)}"`);
      continue;
    }
    const min = Math.min(...times);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    console.log(`  [${avg.toFixed(0).padStart(5)}ms avg | ${min.toFixed(0).padStart(5)}ms min | ${max.toFixed(0).padStart(5)}ms max] "${query.slice(0, 60)}"`);
    allTimings.push(...times);
  }

  const sorted = [...allTimings].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const mean = allTimings.reduce((a, b) => a + b, 0) / allTimings.length;

  console.log(`\n=== Summary (${allTimings.length} samples, ${failures} failures, rerank=${RERANK_ENABLED ? "on" : "off"}) ===`);
  console.log(`  mean:   ${mean.toFixed(0)}ms`);
  console.log(`  p50:    ${p50.toFixed(0)}ms`);
  console.log(`  p90:    ${p90.toFixed(0)}ms`);
  console.log(`  p95:    ${p95.toFixed(0)}ms`);
  console.log(`  min:    ${sorted[0].toFixed(0)}ms`);
  console.log(`  max:    ${sorted[sorted.length - 1].toFixed(0)}ms`);

  store.close();
}

main().catch(e => { console.error(e); process.exit(1); });
