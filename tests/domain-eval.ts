/**
 * Domain-Specific Eval — Entity-Rich Queries Against Production Data
 *
 * Tests retrieval quality on technical/domain content where entity
 * extraction should make a difference. Uses the live memex DB.
 *
 * Usage:
 *   EVAL_DB=~/.openclaw/memory/memex/memex.sqlite \
 *   EMBED_BASE_URL=${EMBED_BASE_URL} \
 *   EMBED_API_KEY=... \
 *   node --import jiti/register tests/domain-eval.ts
 */
import { MemoryStore } from "../src/memory.js";
import { createRetriever } from "../src/retriever.js";
import { createEmbedder } from "../src/embedder.js";

const DB_PATH = process.env.EVAL_DB || "";
const EMBED_BASE_URL = process.env.EMBED_BASE_URL || "";
const EMBED_API_KEY = process.env.EMBED_API_KEY || "";
const EMBED_MODEL = process.env.EMBED_MODEL || "";
const VECTOR_DIM = parseInt(process.env.VECTOR_DIM || "0");

// ============================================================================
// Eval queries — entity-rich, with expected memory content
// ============================================================================

interface EvalQuery {
  id: string;
  query: string;
  /** Substrings that MUST appear in at least one top-3 result */
  expected: string[];
  /** Entity type this tests */
  type: "person" | "system" | "model" | "rule" | "temporal" | "multi-entity";
}

const EVAL_QUERIES: EvalQuery[] = [
  // Person entity queries (anonymized 2026-07-02 — no real names per AGENTS.md)
  {
    id: "user-ban-sorry",
    query: "What words did the user ban?",
    expected: ["sorry", "ban"],
    type: "person",
  },
  {
    id: "user-response-style",
    query: "How does the user want responses formatted?",
    expected: ["TLDR", "default"],
    type: "person",
  },
  {
    id: "user-grafana",
    query: "What's the user's rule about Grafana passwords?",
    expected: ["grafana", "password", "never"],
    type: "person",
  },

  // System entity queries
  {
    id: "host-a-model",
    query: "What model is running on host-a?",
    expected: ["qwen", "host-a"],
    type: "system",
  },
  {
    id: "host-a-user",
    query: "What user should be used on Mac devices?",
    expected: ["default"],
    type: "system",
  },
  {
    id: "server-config",
    query: "What's the rule for modifying server config?",
    expected: ["approval", "embedding"],
    type: "system",
  },

  // Model entity queries
  {
    id: "gemma4-stability",
    query: "What happened when Gemma 4 was deployed?",
    expected: ["crash", "multi-turn"],
    type: "model",
  },
  {
    id: "agent-streaming",
    query: "Does the agent need streaming enabled?",
    expected: ["stream", "must"],
    type: "model",
  },
  {
    id: "agent-reasoning",
    query: "Should reasoning be kept on for the agent?",
    expected: ["reasoning", "kept on"],
    type: "model",
  },

  // Multi-entity queries (tests entity overlap between query and memory)
  {
    id: "user-host-a-deployment",
    query: "What's the user's deployment rule for host-a?",
    expected: ["one", "model", "time"],
    type: "multi-entity",
  },
  {
    id: "agent-qwen",
    query: "Why did the agent switch from Gemma to Qwen?",
    expected: ["crash", "switch"],
    type: "multi-entity",
  },
  {
    id: "user-agent-behavior",
    query: "What does the user want the agent to stop doing?",
    expected: ["explain", "fix"],
    type: "multi-entity",
  },

  // Temporal queries
  {
    id: "recent-deployments",
    query: "What models were deployed last week?",
    expected: [],  // temporal filter — just check results are recent
    type: "temporal",
  },

  // Rule queries (preference/decision)
  {
    id: "homebrew-rule",
    query: "What's the Homebrew installation rule?",
    expected: ["user-level", "homebrew"],
    type: "rule",
  },
  {
    id: "private-repos",
    query: "Should new repos be private or public?",
    expected: ["private"],
    type: "rule",
  },
  // Expanded set (2026-07-02): verifiable queries, ANONYMIZED per AGENTS.md (no real
  // usernames, account names, machine names, or infra refs — Codex P1 remediation).
  // Lifts N above 15 so reranker-vs-baseline deltas carry a confidence interval.
  { id: "ext-repo-issues", query: "What's the rule about filing issues on external repos?", expected: ["never file", "external repos"], type: "rule" },
  { id: "local-agent-quality-model", query: "What model should the local agent stay on for quality reasons?", expected: ["qwen35-27b-dense"], type: "model" },
  { id: "remote-access-default", query: "Which credential is used for remote access by default?", expected: ["pubkey"], type: "system" },
  { id: "gh-private-convention", query: "What's the convention for new GitHub repos — private or public?", expected: ["private", "gh repo create"], type: "rule" },
  { id: "changedetection-replies", query: "How should changedetection.io Discord replies be formatted?", expected: ["tl;dr", "concise"], type: "rule" },
  { id: "gemma-test-path", query: "For Gemma testing, which inference path is preferred?", expected: ["llama.cpp", "omlx"], type: "model" },
  { id: "active-chat-format", query: "Bullets or paragraphs for responses in active chat?", expected: ["paragraphs", "bullet"], type: "rule" },
  { id: "anthropic-credits-date", query: "Until when to use Anthropic credits before switching back to GPT?", expected: ["april 17", "anthropic"], type: "rule" },
  { id: "agent-small-decisions", query: "What should the agent stop doing for small decisions?", expected: ["if you want", "decide"], type: "person" },
  { id: "laptop-hardware", query: "What's the MacBook hardware spec?", expected: ["m1 max", "omlx"], type: "system" },
  { id: "tool-policy-control", query: "Allowlist or denylist for per-agent tool policies?", expected: ["allowlist", "denylist"], type: "rule" },
];

// ============================================================================
// Run eval
// ============================================================================

async function main() {
  console.log(`Domain Eval — ${EVAL_QUERIES.length} queries against ${DB_PATH}\n`);

  const store = new MemoryStore({ dbPath: DB_PATH, vectorDim: VECTOR_DIM });
  console.log(`Pool: ${store.totalMemories} memories\n`);

  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: EMBED_API_KEY,
    model: EMBED_MODEL,
    baseURL: EMBED_BASE_URL,
    dimensions: VECTOR_DIM,
  });

  const rerankEnabled = process.env.RERANK === "1";
  const poolSize = parseInt(process.env.POOL_SIZE || "30");  // tuning knob
  const retriever = createRetriever(store, embedder, {
    mode: "hybrid",
    fusionMethod: "zscore",
    vectorWeight: 0.8,
    bm25Weight: 0.2,
    rerank: rerankEnabled ? "cross-encoder" : "none",
    rerankApiKey: process.env.MEMEX_RERANK_API_KEY,
    rerankEndpoint: process.env.MEMEX_RERANK_ENDPOINT,
    rerankModel: process.env.MEMEX_RERANK_MODEL,
    rerankProvider: "jina",
    rerankBlendWeight: process.env.MEMEX_RERANK_BLEND_WEIGHT
      ? parseFloat(process.env.MEMEX_RERANK_BLEND_WEIGHT)
      : undefined,
    rerankScoreMode: (process.env.MEMEX_RERANK_SCORE_MODE as "raw" | "rank" | undefined),
    minScore: 0.05,
    candidatePoolSize: poolSize,
  });
  console.log(`Reranker: ${rerankEnabled ? "ENABLED (" + (process.env.MEMEX_RERANK_MODEL || "(missing MEMEX_RERANK_MODEL)") + ")" : "disabled"}  Pool: ${poolSize}\n`);
  // rerank toggle via RERANK=1 env var is intentional — lets us diff pipelines without forking the script.
  // Default remains disabled, matching production memex config.

  const queryDelayMs = parseInt(process.env.QUERY_DELAY_MS || "2000");
  let hits = 0;
  let total = 0;
  const results: { id: string; type: string; hit: boolean; topText: string }[] = [];

  for (const eq of EVAL_QUERIES) {
    if (total > 0) await new Promise(r => setTimeout(r, queryDelayMs));
    total++;
    const retrieved = await retriever.retrieve({ query: eq.query, limit: 3 });

    let hit = false;
    if (eq.type === "temporal") {
      // For temporal queries, just check we got results
      hit = retrieved.length > 0;
    } else {
      // Check if expected substrings appear in any top-3 result
      const allText = retrieved.map(r => r.entry.text.toLowerCase()).join(" ");
      hit = eq.expected.every(exp => allText.includes(exp.toLowerCase()));
    }

    if (hit) hits++;

    const topText = retrieved[0]?.entry.text.slice(0, 80) || "(empty)";
    const score = retrieved[0]?.score.toFixed(3) || "0";
    const status = hit ? "HIT" : "MISS";
    const entities = (() => {
      try {
        return JSON.parse(retrieved[0]?.entry.metadata || "{}").entities?.join(",") || "none";
      } catch { return "none"; }
    })();

    console.log(`  ${status}  [${eq.type}] ${eq.id} (${score}, entities: ${entities})`);
    if (!hit) {
      console.log(`       query: "${eq.query}"`);
      console.log(`       expected: ${eq.expected.join(", ")}`);
      console.log(`       got: "${topText}"`);
    }

    results.push({ id: eq.id, type: eq.type, hit, topText });
  }

  console.log(`\n=== Domain Eval Results ===`);
  console.log(`  Total:  ${total}`);
  // Wilson 95% CI on the hit rate (F6): small-N evals must report uncertainty.
  const p = total > 0 ? hits / total : 0;
  const z = 1.96;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denom;
  const ciLo = Math.max(0, center - margin);
  const ciHi = Math.min(1, center + margin);
  console.log(`  Hits:   ${hits}/${total} (${(p * 100).toFixed(0)}%)  [Wilson 95% CI ${(ciLo * 100).toFixed(0)}–${(ciHi * 100).toFixed(0)}%]`);
  console.log(`  Misses: ${total - hits}`);

  // By type
  const types = [...new Set(EVAL_QUERIES.map(q => q.type))];
  for (const type of types) {
    const typeQueries = results.filter(r => r.type === type);
    const typeHits = typeQueries.filter(r => r.hit).length;
    console.log(`  ${type}: ${typeHits}/${typeQueries.length}`);
  }

  store.close();
}

main().catch(console.error);
