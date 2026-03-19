/**
 * Build chunked embedding supplement for LongMemEval research cache.
 *
 * Reads the existing research-cache-50.json, splits each session into
 * overlapping chunks, embeds them, and computes max-sim scores per
 * (example, session) pair.
 *
 * Output: tests/fixtures/longmemeval-cache/chunk-scores-50.json (~small)
 *
 * This file is loaded by fast-benchmark.ts to simulate chunked embedding
 * without needing to re-embed on every run.
 *
 * Usage:
 *   LLAMA_SWAP_API_KEY=... node --import jiti/register tests/build-chunk-cache.ts
 *
 * Environment:
 *   LLAMA_SWAP_API_KEY  — embedding API key
 *   EMBED_BASE_URL      — embedding endpoint (default: llama-swap)
 *   EMBED_MODEL         — model name
 *   CHUNK_SIZE          — chars per chunk (default: 2000)
 *   CHUNK_OVERLAP       — overlap chars (default: 200)
 *   BATCH_SIZE          — texts per API call (default: 8)
 *   PARALLEL            — concurrent API calls (default: 2)
 */
import { readFileSync, writeFileSync, existsSync, openSync, writeSync, closeSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CACHE_DIR = join(__dirname, "fixtures", "longmemeval-cache");
const CACHE_PATH = join(CACHE_DIR, "research-cache-50.json");

const EMBED_BASE_URL = process.env.EMBED_BASE_URL || "http://localhost:8090/v1";
const EMBED_MODEL = process.env.EMBED_MODEL || "Qwen3-Embedding-4B-Q8_0";
const EMBED_API_KEY = process.env.LLAMA_SWAP_API_KEY || "";
const VECTOR_DIM = 2560;
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "2000");
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || "200");
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "8");
const PARALLEL = parseInt(process.env.PARALLEL || "2");
const CHECKPOINT_PATH = join(CACHE_DIR, "chunk-checkpoint.json");
const CHECKPOINT_INTERVAL = 200; // save every N chunks

// ============================================================================
// Types
// ============================================================================

interface CachedSession {
  session_id: string;
  text: string;
  char_count: number;
  vector: number[];
}

interface CachedExample {
  question_id: string;
  question: string;
  question_type: string;
  expected_answer: string;
  answer_session_ids: string[];
  query_vector: number[];
  sessions: CachedSession[];
  bm25_scores: Array<{ session_id: string; bm25_score: number; bm25_rank: number }>;
  vector_scores: Array<{ session_id: string; cosine_score: number; vec_rank: number }>;
}

interface ResearchCache {
  metadata: { sample_size: number; vector_dim: number };
  examples: CachedExample[];
}

/** Per-session chunk scores for one example */
interface SessionChunkScores {
  session_id: string;
  /** max cosine(query, chunk_i) across all chunks */
  max_cosine: number;
  /** char position of best-matching chunk */
  best_chunk_pos: number;
  /** cosine score per chunk (for analysis) */
  chunk_scores: number[];
  /** number of chunks this session was split into */
  num_chunks: number;
}

interface ChunkScoreCache {
  metadata: {
    sample_size: number;
    chunk_size: number;
    chunk_overlap: number;
    embed_model: string;
    vector_dim: number;
    timestamp: string;
    build_time_s: number;
    total_chunks_embedded: number;
    unique_sessions: number;
  };
  /** Per-example chunk scores */
  examples: Array<{
    question_id: string;
    session_scores: SessionChunkScores[];
  }>;
}

// ============================================================================
// Chunking
// ============================================================================

/** Split text into overlapping chunks. Returns [{text, charPos}]. */
function chunkText(text: string, chunkSize: number, overlap: number): Array<{ text: string; charPos: number }> {
  if (text.length <= chunkSize) {
    return [{ text, charPos: 0 }];
  }

  const chunks: Array<{ text: string; charPos: number }> = [];
  const step = chunkSize - overlap;
  let pos = 0;

  while (pos < text.length) {
    const end = Math.min(pos + chunkSize, text.length);
    const chunk = text.slice(pos, end);

    // Try to break at a turn boundary for cleaner chunks
    if (end < text.length) {
      const turnBreak = chunk.lastIndexOf("\n[");
      if (turnBreak > chunkSize * 0.3) {
        // Found a turn boundary in the latter 70% of the chunk
        chunks.push({ text: chunk.slice(0, turnBreak), charPos: pos });
        pos += turnBreak - overlap;
        if (pos <= chunks.at(-1)!.charPos) pos = chunks.at(-1)!.charPos + step; // prevent infinite loop
        continue;
      }
    }

    chunks.push({ text: chunk, charPos: pos });
    if (end >= text.length) break;
    pos += step;
  }

  return chunks;
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

// ============================================================================
// Main
// ============================================================================

async function main() {
  if (!EMBED_API_KEY) {
    console.error("Set LLAMA_SWAP_API_KEY to run this script.");
    process.exit(1);
  }

  console.log(`Loading research cache...`);
  const cache: ResearchCache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  console.log(`Loaded ${cache.examples.length} examples.`);
  console.log(`Chunk size: ${CHUNK_SIZE}, overlap: ${CHUNK_OVERLAP}, batch: ${BATCH_SIZE}, parallel: ${PARALLEL}\n`);

  // Step 1: Collect all unique sessions and their chunks
  const uniqueSessions = new Map<string, string>(); // session_id -> text
  for (const ex of cache.examples) {
    for (const s of ex.sessions) {
      if (!uniqueSessions.has(s.session_id)) {
        uniqueSessions.set(s.session_id, s.text);
      }
    }
  }
  console.log(`Unique sessions: ${uniqueSessions.size}`);

  // Step 2: Chunk all sessions, build embedding work queue
  interface ChunkJob {
    sessionId: string;
    chunkIdx: number;
    text: string;
    charPos: number;
  }

  const sessionChunks = new Map<string, Array<{ text: string; charPos: number }>>();
  const jobs: ChunkJob[] = [];

  for (const [sid, text] of uniqueSessions) {
    if (text.length <= CHUNK_SIZE) {
      // Already fully covered by existing vector — skip embedding
      sessionChunks.set(sid, [{ text, charPos: 0 }]);
      continue;
    }

    const chunks = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);
    sessionChunks.set(sid, chunks);
    for (let i = 0; i < chunks.length; i++) {
      jobs.push({ sessionId: sid, chunkIdx: i, text: chunks[i].text, charPos: chunks[i].charPos });
    }
  }

  const sessionsNeedingEmbed = new Set(jobs.map(j => j.sessionId)).size;
  console.log(`Sessions needing chunk embedding: ${sessionsNeedingEmbed}`);
  console.log(`Total chunks to embed: ${jobs.length}`);
  console.log(`Estimated batches: ${Math.ceil(jobs.length / BATCH_SIZE)}\n`);

  // Step 3: Embed chunks via direct HTTP (bypasses embedder overhead for bulk operations)
  // Load checkpoint if available (NDJSON format: one {"k":"sessionId:idx","v":[...]} per line)
  const chunkVectors = new Map<string, number[]>(); // "sessionId:chunkIdx" -> vector
  let skipCount = 0;
  if (existsSync(CHECKPOINT_PATH)) {
    const lines = readFileSync(CHECKPOINT_PATH, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const { k, v } = JSON.parse(line);
      chunkVectors.set(k, v);
    }
    skipCount = chunkVectors.size;
    console.log(`Loaded checkpoint: ${skipCount} vectors already embedded`);
  }

  const startTime = performance.now();
  let embedded = skipCount;
  let errors = 0;
  let lastCheckpoint = skipCount;

  async function embedBatch(texts: string[]): Promise<number[][]> {
    const resp = await fetch(`${EMBED_BASE_URL}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${EMBED_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      signal: AbortSignal.timeout(texts.length > 1 ? 45000 : 20000),
    });
    if (!resp.ok) throw new Error(`Embed API ${resp.status}: ${await resp.text()}`);
    const data = await resp.json() as any;
    const sorted = data.data.sort((a: any, b: any) => a.index - b.index);
    return sorted.map((d: any) => d.embedding as number[]);
  }

  console.log(`Starting embedding (${PARALLEL} parallel, batch ${BATCH_SIZE})...`);

  // Filter out already-embedded jobs
  const remainingJobs = jobs.filter(j => !chunkVectors.has(`${j.sessionId}:${j.chunkIdx}`));
  console.log(`Remaining chunks to embed: ${remainingJobs.length} (${skipCount} from checkpoint)`);

  // Process with parallelism
  for (let batchStart = 0; batchStart < remainingJobs.length; batchStart += BATCH_SIZE * PARALLEL) {
    const parallelBatches: ChunkJob[][] = [];
    for (let p = 0; p < PARALLEL; p++) {
      const start = batchStart + p * BATCH_SIZE;
      const batch = remainingJobs.slice(start, start + BATCH_SIZE);
      if (batch.length > 0) parallelBatches.push(batch);
    }

    const results = await Promise.all(
      parallelBatches.map(async (batch) => {
        const texts = batch.map(j => j.text);
        try {
          const vectors = await embedBatch(texts);
          return batch.map((j, i) => ({ key: `${j.sessionId}:${j.chunkIdx}`, vector: vectors[i], ok: true }));
        } catch (err: any) {
          errors++;
          console.warn(`\n  Batch error: ${err.message?.slice(0, 100)}`);
          // Fallback: retry first 3 items only (avoid long stall on full batch retry)
          const fallback = [];
          for (let i = 0; i < Math.min(batch.length, 3); i++) {
            try {
              const [vec] = await embedBatch([texts[i]]);
              fallback.push({ key: `${batch[i].sessionId}:${batch[i].chunkIdx}`, vector: vec, ok: true });
            } catch { /* skip */ }
          }
          return fallback;
        }
      })
    );

    for (const batchResult of results) {
      for (const { key, vector } of batchResult) {
        chunkVectors.set(key, vector);
        embedded++;
      }
    }

    const elapsed = (performance.now() - startTime) / 1000;
    const newSinceStart = embedded - skipCount;
    const rate = newSinceStart / elapsed;
    const remaining = remainingJobs.length - (batchStart + BATCH_SIZE * PARALLEL);
    const eta = remaining > 0 ? remaining / rate : 0;
    if (embedded % 200 === 0 || batchStart + BATCH_SIZE * PARALLEL >= remainingJobs.length) {
      console.warn(`  ${embedded}/${jobs.length} chunks (${rate.toFixed(1)}/s, ETA ${(eta / 60).toFixed(0)}min, ${errors} errors)`);
    }

    // Save checkpoint as NDJSON (one line per vector — avoids V8 string length limit on large JSON)
    if (embedded - lastCheckpoint >= CHECKPOINT_INTERVAL) {
      const fd = openSync(CHECKPOINT_PATH, "w");
      for (const [key, vector] of chunkVectors) {
        writeSync(fd, JSON.stringify({ k: key, v: vector }) + "\n");
      }
      closeSync(fd);
      lastCheckpoint = embedded;
      console.warn(`  [checkpoint saved: ${embedded} vectors]`);
    }
  }

  const embedTime = (performance.now() - startTime) / 1000;
  console.log(`\n\nEmbedding done in ${(embedTime / 60).toFixed(1)} min`);

  // Step 4: Compute chunk scores per (example, session)
  console.log(`\nComputing chunk scores...`);
  const exampleResults: ChunkScoreCache["examples"] = [];

  for (const ex of cache.examples) {
    const sessionScores: SessionChunkScores[] = [];

    for (const session of ex.sessions) {
      const chunks = sessionChunks.get(session.session_id)!;

      if (session.text.length <= CHUNK_SIZE) {
        // Use existing whole-session vector
        const score = cosineSimilarity(ex.query_vector, session.vector);
        sessionScores.push({
          session_id: session.session_id,
          max_cosine: score,
          best_chunk_pos: 0,
          chunk_scores: [score],
          num_chunks: 1,
        });
        continue;
      }

      // Compute cosine for each chunk
      const scores: number[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const vec = chunkVectors.get(`${session.session_id}:${i}`);
        if (vec) {
          scores.push(cosineSimilarity(ex.query_vector, vec));
        } else {
          scores.push(0);
        }
      }

      const maxIdx = scores.indexOf(Math.max(...scores));
      sessionScores.push({
        session_id: session.session_id,
        max_cosine: scores[maxIdx],
        best_chunk_pos: chunks[maxIdx].charPos,
        chunk_scores: scores,
        num_chunks: chunks.length,
      });
    }

    exampleResults.push({
      question_id: ex.question_id,
      session_scores: sessionScores,
    });
  }

  // Step 5: Write output
  const output: ChunkScoreCache = {
    metadata: {
      sample_size: cache.examples.length,
      chunk_size: CHUNK_SIZE,
      chunk_overlap: CHUNK_OVERLAP,
      embed_model: EMBED_MODEL,
      vector_dim: VECTOR_DIM,
      timestamp: new Date().toISOString(),
      build_time_s: Math.round(embedTime),
      total_chunks_embedded: embedded,
      unique_sessions: uniqueSessions.size,
    },
    examples: exampleResults,
  };

  const outPath = join(CACHE_DIR, `chunk-scores-${cache.examples.length}.json`);
  const outJson = JSON.stringify(output, null, 2);
  writeFileSync(outPath, outJson);
  const sizeMB = (Buffer.byteLength(outJson) / 1024 / 1024).toFixed(1);
  console.log(`\nChunk scores written to ${outPath} (${sizeMB} MB)`);

  // Clean up checkpoint on success
  if (existsSync(CHECKPOINT_PATH)) {
    unlinkSync(CHECKPOINT_PATH);
    console.log(`Checkpoint cleaned up.`);
  }

  // Step 6: Quick comparison — original vs chunked
  console.log(`\n=== Improvement Preview ===\n`);
  let origR1 = 0, origR3 = 0, chunkR1 = 0, chunkR3 = 0;

  for (let i = 0; i < cache.examples.length; i++) {
    const ex = cache.examples[i];
    const chunkEx = exampleResults[i];
    const answerSet = new Set(ex.answer_session_ids);

    // Original: sort by existing cosine score
    const origRanked = [...ex.vector_scores].sort((a, b) => b.cosine_score - a.cosine_score);
    if (origRanked.slice(0, 1).some(v => answerSet.has(v.session_id))) origR1++;
    if (origRanked.slice(0, 3).some(v => answerSet.has(v.session_id))) origR3++;

    // Chunked: sort by max chunk cosine
    const chunkRanked = [...chunkEx.session_scores].sort((a, b) => b.max_cosine - a.max_cosine);
    const hitAt1 = chunkRanked.slice(0, 1).some(v => answerSet.has(v.session_id));
    const hitAt3 = chunkRanked.slice(0, 3).some(v => answerSet.has(v.session_id));
    if (hitAt1) chunkR1++;
    if (hitAt3) chunkR3++;

    // Show improvements
    const origRank = origRanked.findIndex(v => answerSet.has(v.session_id)) + 1;
    const chunkRank = chunkRanked.findIndex(v => answerSet.has(v.session_id)) + 1;
    if (chunkRank < origRank) {
      const bestChunk = chunkEx.session_scores.find(s => answerSet.has(s.session_id));
      console.log(`  ${ex.question_id.slice(0, 8)} rank ${origRank}→${chunkRank} (${bestChunk?.num_chunks} chunks, best@${bestChunk?.best_chunk_pos}) "${ex.question.slice(0, 50)}"`);
    }
  }

  console.log(`\n  Vec-only R@1: ${origR1} → ${chunkR1}  (${origR1 < chunkR1 ? "+" : ""}${chunkR1 - origR1})`);
  console.log(`  Vec-only R@3: ${origR3} → ${chunkR3}  (${origR3 < chunkR3 ? "+" : ""}${chunkR3 - origR3})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
