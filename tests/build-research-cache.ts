/**
 * Pre-compute and cache all embeddings + raw retrieval scores for LongMemEval.
 * This enables fast autoresearch iterations on fusion/ranking code (~30s per run).
 *
 * Output: tests/fixtures/longmemeval-cache/research-cache-{N}.json
 *
 * Contains per-example:
 *   - All session vectors (pre-embedded)
 *   - Query vector
 *   - Raw BM25 scores per session (from FTS5)
 *   - Raw vector scores per session (cosine similarity)
 *   - Ground truth (answer session IDs, expected answer, question type)
 *
 * Usage:
 *   LLAMA_SWAP_API_KEY=... node --import jiti/register tests/build-research-cache.ts
 */
import { MemoryStore } from "../src/memory.js";
import { createEmbedder } from "../src/embedder.js";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_FILE =
  process.env.LONGMEMEVAL_DATA ||
  "/home/ubuntu/projects/LongMemEval/data/longmemeval_s_cleaned.json";
const SAMPLE_SIZE = parseInt(process.env.LONGMEMEVAL_SAMPLE || "50");
const EMBED_BASE_URL = process.env.EMBED_BASE_URL || process.env.EMBED_BASE_URL || "http://localhost:8090/v1";
const EMBED_MODEL = process.env.EMBED_MODEL || "Qwen3-Embedding-4B-Q8_0";
const EMBED_API_KEY = process.env.LLAMA_SWAP_API_KEY || "";
const VECTOR_DIM = 2560;

const CACHE_DIR = join(__dirname, "fixtures", "longmemeval-cache");

interface CachedSession {
  session_id: string;
  text: string;
  char_count: number;
  vector: number[];
}

interface CachedBM25Score {
  session_id: string;
  bm25_score: number;
  bm25_rank: number;
}

interface CachedVectorScore {
  session_id: string;
  cosine_score: number;
  vec_rank: number;
}

interface CachedExample {
  question_id: string;
  question: string;
  question_type: string;
  expected_answer: string;
  answer_session_ids: string[];
  query_vector: number[];
  sessions: CachedSession[];
  bm25_scores: CachedBM25Score[];
  vector_scores: CachedVectorScore[];
}

interface ResearchCache {
  metadata: {
    sample_size: number;
    embed_model: string;
    vector_dim: number;
    timestamp: string;
    build_time_s: number;
  };
  examples: CachedExample[];
}

function sessionToText(session: Array<{ role: string; content: string }>): string {
  return session.map((t) => `[${t.role}] ${t.content}`).join("\n");
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function processExample(
  example: any,
  embedder: any,
): Promise<CachedExample> {
  const texts = example.haystack_sessions.map((s: any) => sessionToText(s));
  const sessionIds: string[] = example.haystack_session_ids;

  // Embed all sessions (truncate to 2000 chars for embedding)
  const truncated = texts.map((t: string) => t.slice(0, 2000));
  const sessionVectors = await embedder.embedBatchPassage(truncated);

  // Embed query
  const [queryVector] = await embedder.embedBatchQuery([example.question]);

  // Compute raw cosine similarities
  const vectorScores: CachedVectorScore[] = sessionIds.map((sid: string, i: number) => ({
    session_id: sid,
    cosine_score: cosineSimilarity(queryVector, sessionVectors[i]),
    vec_rank: 0,
  }));
  // Assign ranks
  vectorScores.sort((a, b) => b.cosine_score - a.cosine_score);
  vectorScores.forEach((v, i) => { v.vec_rank = i + 1; });

  // Get raw BM25 scores from FTS5 using MemoryStore.bm25Search (limit capped at 20)
  const tmpDir = mkdtempSync(join(tmpdir(), "research-cache-"));
  const dbPath = join(tmpDir, "memex.sqlite");
  let bm25Scores: CachedBM25Score[] = [];

  try {
    const store = new MemoryStore({ dbPath, vectorDim: VECTOR_DIM });

    // Insert all sessions as memories (with zero vectors — we only need BM25)
    const entries = texts.map((text: string, i: number) => ({
      text,
      vector: new Array(VECTOR_DIM).fill(0),
      category: "fact" as const,
      scope: "global",
      importance: 0.5,
      metadata: JSON.stringify({ sessionId: sessionIds[i] }),
    }));
    await store.bulkStore(entries);

    // bm25Search has limit capped at 20, so we get top-20 BM25 results
    const bm25Results = await store.bm25Search(example.question, 20, ["global"]);

    // Map BM25 results to session IDs
    const bm25Map = new Map<string, { score: number; rank: number }>();
    for (let i = 0; i < bm25Results.length; i++) {
      const meta = JSON.parse(bm25Results[i].entry.metadata || "{}");
      bm25Map.set(meta.sessionId, { score: bm25Results[i].score, rank: i + 1 });
    }

    bm25Scores = sessionIds.map((sid: string) => {
      const hit = bm25Map.get(sid);
      return {
        session_id: sid,
        bm25_score: hit?.score ?? 0,
        bm25_rank: hit?.rank ?? texts.length + 1,
      };
    });

    await store.close();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // Build cached sessions (vectors stored separately for compactness)
  const sessions: CachedSession[] = sessionIds.map((sid: string, i: number) => ({
    session_id: sid,
    text: texts[i],
    char_count: texts[i].length,
    vector: sessionVectors[i],
  }));

  return {
    question_id: example.question_id,
    question: example.question,
    question_type: example.question_type,
    expected_answer: example.answer,
    answer_session_ids: example.answer_session_ids,
    query_vector: queryVector,
    sessions,
    bm25_scores: bm25Scores,
    vector_scores: vectorScores,
  };
}

async function main() {
  console.log(`Loading LongMemEval data from ${DATA_FILE}...`);
  const raw = readFileSync(DATA_FILE, "utf-8");
  const allExamples = JSON.parse(raw);
  console.log(`Loaded ${allExamples.length} examples.`);

  const sampleSize = Math.min(SAMPLE_SIZE, allExamples.length);
  const examples = allExamples.slice(0, sampleSize);
  console.log(`Processing ${sampleSize} examples...\n`);

  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: EMBED_API_KEY,
    model: EMBED_MODEL,
    baseURL: EMBED_BASE_URL,
    dimensions: VECTOR_DIM,
  });

  const startTime = performance.now();
  const cached: CachedExample[] = [];

  for (let i = 0; i < examples.length; i++) {
    const exStart = performance.now();
    process.stdout.write(`[${i + 1}/${sampleSize}] ${examples[i].question_id}... `);

    const result = await processExample(examples[i], embedder);
    cached.push(result);

    const exMs = performance.now() - exStart;

    // Quick check: where does answer rank?
    const answerSet = new Set(result.answer_session_ids);
    const vecRank = result.vector_scores.find(v => answerSet.has(v.session_id))?.vec_rank ?? -1;
    const bm25Rank = result.bm25_scores.find(b => answerSet.has(b.session_id))?.bm25_rank ?? -1;
    console.log(`${(exMs / 1000).toFixed(1)}s — vec_rank=${vecRank}, bm25_rank=${bm25Rank}`);
  }

  const totalS = (performance.now() - startTime) / 1000;

  const cache: ResearchCache = {
    metadata: {
      sample_size: sampleSize,
      embed_model: EMBED_MODEL,
      vector_dim: VECTOR_DIM,
      timestamp: new Date().toISOString(),
      build_time_s: Math.round(totalS),
    },
    examples: cached,
  };

  mkdirSync(CACHE_DIR, { recursive: true });
  const outPath = join(CACHE_DIR, `research-cache-${sampleSize}.json`);
  writeFileSync(outPath, JSON.stringify(cache));
  const sizeMB = (Buffer.byteLength(JSON.stringify(cache)) / 1024 / 1024).toFixed(1);
  console.log(`\nCache written to ${outPath} (${sizeMB} MB)`);
  console.log(`Build time: ${totalS.toFixed(0)}s (${(totalS / sampleSize).toFixed(1)}s/example)`);

  // Print summary stats
  console.log(`\n=== Summary ===`);
  let vecTop10 = 0, bm25Top10 = 0, eitherTop10 = 0;
  for (const ex of cached) {
    const answerSet = new Set(ex.answer_session_ids);
    const vr = ex.vector_scores.find(v => answerSet.has(v.session_id))?.vec_rank ?? 999;
    const br = ex.bm25_scores.find(b => answerSet.has(b.session_id))?.bm25_rank ?? 999;
    if (vr <= 10) vecTop10++;
    if (br <= 10) bm25Top10++;
    if (vr <= 10 || br <= 10) eitherTop10++;
  }
  console.log(`Vector-only R@10: ${vecTop10}/${sampleSize} (${(100 * vecTop10 / sampleSize).toFixed(1)}%)`);
  console.log(`BM25-only R@10:   ${bm25Top10}/${sampleSize} (${(100 * bm25Top10 / sampleSize).toFixed(1)}%)`);
  console.log(`Either R@10:      ${eitherTop10}/${sampleSize} (${(100 * eitherTop10 / sampleSize).toFixed(1)}%)`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
