/**
 * Domain-Specific Eval — Entity-Rich Queries Against Production Data
 *
 * Tests retrieval quality on technical/domain content where entity
 * extraction should make a difference. Uses the live memex DB.
 *
 * Usage:
 *   EVAL_DB=~/.openclaw/memory/memex/memex.sqlite \
 *   EMBED_BASE_URL=http://REDACTED_IP:8090/v1 \
 *   EMBED_API_KEY=... \
 *   node --import jiti/register tests/domain-eval.ts
 */
import { MemoryStore } from "../src/memory.js";
import { createRetriever } from "../src/retriever.js";
import { createEmbedder } from "../src/embedder.js";

const DB_PATH = process.env.EVAL_DB || `${process.env.HOME}/.openclaw/memory/memex/memex.sqlite`;
const EMBED_BASE_URL = process.env.EMBED_BASE_URL || "http://REDACTED_IP:8090/v1";
const EMBED_API_KEY = process.env.EMBED_API_KEY || process.env.LLAMA_SWAP_API_KEY || "";
const EMBED_MODEL = process.env.EMBED_MODEL || "Qwen3-Embedding-4B-Q8_0";
const VECTOR_DIM = parseInt(process.env.VECTOR_DIM || "2560");

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
  // Person entity queries
  {
    id: "ryan-ban-sorry",
    query: "What words did Ryan ban?",
    expected: ["sorry", "ban"],
    type: "person",
  },
  {
    id: "ryan-response-style",
    query: "How does Ryan want responses formatted?",
    expected: ["TLDR", "default"],
    type: "person",
  },
  {
    id: "ryan-grafana",
    query: "What's Ryan's rule about Grafana passwords?",
    expected: ["grafana", "password", "never"],
    type: "person",
  },

  // System entity queries
  {
    id: "mbp1-model",
    query: "What model is running on mbp-1?",
    expected: ["qwen", "mbp-1"],
    type: "system",
  },
  {
    id: "mbp1-user",
    query: "What user should be used on Mac devices?",
    expected: ["oc", "default"],
    type: "system",
  },
  {
    id: "mac-mini-1-config",
    query: "What's the rule for modifying mac-mini-1 config?",
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
    id: "virgil-streaming",
    query: "Does Virgil need streaming enabled?",
    expected: ["stream", "must"],
    type: "model",
  },
  {
    id: "virgil-reasoning",
    query: "Should reasoning be kept on for Virgil?",
    expected: ["reasoning", "kept on"],
    type: "model",
  },

  // Multi-entity queries (tests entity overlap between query and memory)
  {
    id: "ryan-mbp1-deployment",
    query: "What's Ryan's deployment rule for mbp-1?",
    expected: ["one", "model", "time"],
    type: "multi-entity",
  },
  {
    id: "virgil-qwen",
    query: "Why did Virgil switch from Gemma to Qwen?",
    expected: ["crash", "switch"],
    type: "multi-entity",
  },
  {
    id: "ryan-cabbie-behavior",
    query: "What does Ryan want Cabbie to stop doing?",
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

  const retriever = createRetriever(store, embedder, {
    mode: "hybrid",
    fusionMethod: "zscore",
    vectorWeight: 0.8,
    bm25Weight: 0.2,
    rerank: "none",
    minScore: 0.05,
    candidatePoolSize: 30,
  });

  let hits = 0;
  let total = 0;
  const results: { id: string; type: string; hit: boolean; topText: string }[] = [];

  for (const eq of EVAL_QUERIES) {
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
  console.log(`  Hits:   ${hits}/${total} (${(hits / total * 100).toFixed(0)}%)`);
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
