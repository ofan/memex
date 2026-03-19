/**
 * LongMemEval Benchmark Adapter for memex — Two-Phase Pipeline
 *
 * Phase 1 (retrieve): embed 53 sessions per example, run BM25+vector search,
 *   cache results to disk. Slow (~60s/example), run once.
 *
 * Phase 2 (read): load cached retrievals, feed top-5 session texts + question
 *   to a configurable LLM, score answers. Fast (~2s/example), rerun freely.
 *
 * Metrics: Recall@1, Recall@5, Recall@10, E2E accuracy — by question type.
 *
 * Usage:
 *   # Phase 1: retrieve and cache (slow, run once)
 *   LONGMEMEVAL_PHASE=retrieve LONGMEMEVAL_SAMPLE=50 node --import jiti/register tests/longmemeval-benchmark.ts
 *
 *   # Phase 2: read with Gemini (fast, reuses cache)
 *   LONGMEMEVAL_PHASE=read LLM_MODEL=gemini-2.5-flash node --import jiti/register tests/longmemeval-benchmark.ts
 *
 *   # Phase 2: read with different LLM
 *   LONGMEMEVAL_PHASE=read LLM_MODEL=gpt-4o LLM_BASE_URL=https://api.openai.com/v1 LLM_API_KEY=sk-... node --import jiti/register tests/longmemeval-benchmark.ts
 *
 *   # Both phases (default — retrieve if no cache, then read)
 *   LONGMEMEVAL_SAMPLE=50 node --import jiti/register tests/longmemeval-benchmark.ts
 *
 * Environment variables:
 *   LONGMEMEVAL_PHASE    — "retrieve", "read", or "both" (default: "both")
 *   LONGMEMEVAL_SAMPLE   — number of examples to run (default: 50)
 *   LONGMEMEVAL_DATA     — path to dataset file
 *   LONGMEMEVAL_VECTORS  — "true"/"false" for hybrid vs BM25-only (default: true)
 *   LLAMA_SWAP_API_KEY   — for embedding server
 *   EMBED_BASE_URL, EMBED_MODEL — embedding config
 *   LLM_BASE_URL         — LLM endpoint (default: Gemini)
 *   LLM_MODEL            — LLM model name (default: gemini-2.5-flash)
 *   LLM_API_KEY          — defaults to GEMINI_API_KEY, falls back to OPENAI_API_KEY
 */

import { MemoryStore } from "../src/memory.js";
import { createEmbedder } from "../src/embedder.js";
import type { Embedder } from "../src/embedder.js";
import { createRetriever } from "../src/retriever.js";
import type { RetrievalConfig } from "../src/retriever.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// ============================================================================
// Config
// ============================================================================

const DATA_FILE =
  process.env.LONGMEMEVAL_DATA ||
  "/home/ubuntu/projects/LongMemEval/data/longmemeval_s_cleaned.json";
const SAMPLE_SIZE = parseInt(process.env.LONGMEMEVAL_SAMPLE || "50");
const K = 10;
const USE_VECTORS = process.env.LONGMEMEVAL_VECTORS !== "false"; // default: true
const EMBED_BASE_URL = process.env.EMBED_BASE_URL || process.env.EMBED_BASE_URL || "http://localhost:8090/v1";
const EMBED_MODEL = process.env.EMBED_MODEL || "Qwen3-Embedding-4B-Q8_0";
const EMBED_API_KEY = process.env.LLAMA_SWAP_API_KEY || "";
const VECTOR_DIM = USE_VECTORS ? 2560 : 4;
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai";
const LLM_MODEL = process.env.LLM_MODEL || "gemini-2.5-flash";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "";

const RERANK_ENDPOINT = process.env.RERANK_ENDPOINT || process.env.EMBED_BASE_URL || "http://localhost:8090/v1/rerank";
const RERANK_MODEL = process.env.RERANK_MODEL || "bge-reranker-v2-m3-Q8_0";
const RERANK_API_KEY = process.env.RERANK_API_KEY || EMBED_API_KEY || "unused";
const LLM_DELAY_MS = parseInt(process.env.LLM_DELAY_MS || "0"); // delay between LLM calls to avoid rate limits
const PHASE = (process.env.LONGMEMEVAL_PHASE || "both") as "retrieve" | "read" | "both" | "batch-submit" | "batch-collect";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_DIR = join(__dirname, "fixtures", "longmemeval-cache");

function cachePath(sampleSize: number): string {
  return join(CACHE_DIR, `retrieval-${sampleSize}.json`);
}

// ============================================================================
// Types
// ============================================================================

interface LongMemEvalExample {
  question_id: string;
  question_type: string;
  question: string;
  question_date: string;
  answer: string;
  answer_session_ids: string[];
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: Array<Array<{ role: string; content: string }>>;
}

interface CachedResult {
  question_id: string;
  question: string;
  question_type: string;
  expected_answer: string;
  answer_session_ids: string[];
  retrieved_session_ids: string[];
  retrieved_texts: string[];
  hit_at_1: boolean;
  hit_at_3: boolean;
  hit_at_5: boolean;
  hit_at_10: boolean;
}

interface CacheFile {
  metadata: {
    sample_size: number;
    use_vectors: boolean;
    embed_model: string;
    k: number;
    timestamp: string;
  };
  results: CachedResult[];
}

interface TypeMetrics {
  count: number;
  hitsAt1: number;
  hitsAt3: number;
  hitsAt5: number;
  hitsAt10: number;
  e2eCorrect: number;
  e2eTotal: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Concatenate all turns of a session into a single text block.
 * Format: "[user] ...\n[assistant] ...\n..."
 */
function sessionToText(session: Array<{ role: string; content: string }>): string {
  return session.map((turn) => `[${turn.role}] ${turn.content}`).join("\n");
}

// Shared embedder (created lazily)
let _embedder: Embedder | null = null;
function getEmbedder(): Embedder {
  if (!_embedder) {
    _embedder = createEmbedder({
      provider: "openai-compatible",
      apiKey: EMBED_API_KEY,
      model: EMBED_MODEL,
      baseURL: EMBED_BASE_URL,
      dimensions: VECTOR_DIM,
    });
  }
  return _embedder;
}

// Semantic equivalences for scorer (date aliases, abbreviations, etc.)
const ALIASES: Record<string, string[]> = {
  "february 14th": ["valentine's day", "valentines day", "valentine day"],
  "valentine's day": ["february 14th", "feb 14", "february 14"],
  "december 25th": ["christmas", "christmas day", "xmas"],
  "christmas": ["december 25th", "dec 25"],
  "october 31st": ["halloween"],
  "halloween": ["october 31st", "oct 31"],
};

/**
 * Check if the LLM response contains the expected answer.
 * Strategy: direct substring, alias check, parenthetical extraction,
 * then stopword-stripped term matching (≥50%).
 * "NOT FOUND" in the response means incorrect.
 */
function checkAnswerMatch(expected: string, generated: string): boolean {
  if (generated.toUpperCase().includes("NOT FOUND")) return false;

  const gen = generated.toLowerCase();
  const expLower = expected.toLowerCase().trim();

  // Direct substring match (either direction)
  if (gen.includes(expLower) || expLower.includes(gen.trim())) return true;

  // Alias check: if expected has a known alias that appears in generated
  for (const [key, aliases] of Object.entries(ALIASES)) {
    if (expLower.includes(key) && aliases.some(a => gen.includes(a))) return true;
    if (aliases.some(a => expLower.includes(a)) && gen.includes(key)) return true;
  }

  // Parenthetical extraction: "University of California, Los Angeles (UCLA)"
  // If expected contains parenthesized text, check if that alone matches
  const parenMatch = expected.match(/\(([^)]+)\)/);
  if (parenMatch && gen.includes(parenMatch[1].toLowerCase())) return true;

  const stopwords = new Set([
    "a", "an", "the", "is", "was", "are", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
    "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "and", "but", "or", "nor", "not", "so", "yet", "both",
    "each", "few", "more", "most", "other", "some", "such", "no",
    "than", "too", "very", "just", "about", "up", "i", "my", "me",
    "it", "its", "he", "she", "we", "they", "them", "his", "her",
    "our", "your", "this", "that", "what", "which", "who", "whom",
  ]);

  const expectedTerms = expLower.split(/\s+/)
    .map(t => t.replace(/[().,]/g, ""))
    .filter(t => t.length > 0 && !stopwords.has(t));

  if (expectedTerms.length === 0) return false;

  // For short answers (1-2 content terms), require all terms present
  if (expectedTerms.length <= 2) {
    return expectedTerms.every(t => gen.includes(t));
  }

  // For longer answers, require ≥50% of content terms
  const matchedTerms = expectedTerms.filter(t => gen.includes(t));
  return matchedTerms.length / expectedTerms.length >= 0.5;
}

// ============================================================================
// Phase 1: Retrieve
// ============================================================================

/**
 * Process a single example: create temp store, index sessions, search via
 * unified MemoryRetriever (RRF fusion, cross-encoder rerank, length norm,
 * adaptive min-score), return cached result with retrieved session IDs and texts.
 */
async function retrieveExample(example: LongMemEvalExample): Promise<CachedResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), "longmemeval-"));
  const dbPath = join(tmpDir, "memex.sqlite");

  try {
    const store = new MemoryStore({ dbPath, vectorDim: VECTOR_DIM });
    const embedder = getEmbedder();
    const texts = example.haystack_sessions.map(s => sessionToText(s));

    // Embed sessions if vectors enabled (truncate to ~2000 chars for embedding context)
    let vectors: number[][] | null = null;
    if (USE_VECTORS) {
      const truncated = texts.map(t => t.slice(0, 2000));
      vectors = await embedder.embedBatchPassage(truncated);
    }

    // Index all haystack sessions as memories
    const entries = texts.map((text, i) => ({
      text,
      vector: vectors ? vectors[i] : new Array(VECTOR_DIM).fill(0),
      category: "fact" as const,
      scope: "global",
      importance: 0.5,
      metadata: JSON.stringify({ sessionId: example.haystack_session_ids[i] }),
    }));

    await store.bulkStore(entries);

    // Build retriever config: use full pipeline but disable time-based stages
    // (all sessions ingested at same time, so recency/decay are meaningless)
    const retrieverConfig: Partial<RetrievalConfig> = {
      mode: USE_VECTORS ? "hybrid" : "vector",
      fusionMethod: "zscore",   // z-score normalized fusion — prevents BM25 noise from displacing vector hits
      vectorWeight: 0.8,        // z-score optimal: 0.8 vec + 0.2 bm25
      bm25Weight: 0.2,
      rerank: "none",           // reranker hurts on long sessions (truncated context too short)
      candidatePoolSize: K * 3,
      minScore: 0.05,        // low initial filter — let reranker decide
      hardMinScore: 0.10,    // low adaptive floor for benchmark
      recencyHalfLifeDays: 0, // disable recency boost (all same time)
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0, // disable time decay
      lengthNormAnchor: 0,    // disable — all sessions are similar length
      filterNoise: false,     // sessions aren't noise
    };

    const retriever = createRetriever(store, embedder, retrieverConfig);
    const results = await retriever.retrieve({ query: example.question, limit: K });

    // Extract session IDs and full texts from search results
    const retrievedSessionIds: string[] = [];
    const retrievedTexts: string[] = [];
    for (const r of results) {
      try {
        const meta = JSON.parse(r.entry.metadata || "{}");
        retrievedSessionIds.push(meta.sessionId as string);
      } catch {
        retrievedSessionIds.push("");
      }
      retrievedTexts.push(r.entry.text);
    }

    // Check if any answer session appears in top-K results
    const answerSet = new Set(example.answer_session_ids);
    const hitAt = (k: number): boolean => {
      for (let i = 0; i < Math.min(k, retrievedSessionIds.length); i++) {
        if (answerSet.has(retrievedSessionIds[i])) return true;
      }
      return false;
    };

    await store.close();

    return {
      question_id: example.question_id,
      question: example.question,
      question_type: example.question_type,
      expected_answer: example.answer,
      answer_session_ids: example.answer_session_ids,
      retrieved_session_ids: retrievedSessionIds,
      retrieved_texts: retrievedTexts,
      hit_at_1: hitAt(1),
      hit_at_3: hitAt(3),
      hit_at_5: hitAt(5),
      hit_at_10: hitAt(10),
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Run Phase 1: retrieve for all examples, write cache to disk.
 */
async function runRetrievePhase(examples: LongMemEvalExample[]): Promise<CacheFile> {
  const sampleSize = examples.length;
  console.log(`\n=== Phase 1: Retrieve (N=${sampleSize}, K=${K}, vectors=${USE_VECTORS}) ===\n`);

  const results: CachedResult[] = [];
  const startTime = performance.now();

  for (let i = 0; i < examples.length; i++) {
    const example = examples[i];
    process.stdout.write(`[retrieve] ${i + 1}/${sampleSize}... `);

    const exStart = performance.now();
    const result = await retrieveExample(example);
    const exMs = performance.now() - exStart;

    results.push(result);

    const hitStr = result.hit_at_1 ? "R@1" : (result.hit_at_3 ? "R@3" : (result.hit_at_10 ? "R@10" : "miss"));
    console.log(
      `${hitStr} (${exMs.toFixed(0)}ms) [${example.question_type}] "${example.question.slice(0, 60)}..."`
    );
  }

  const elapsedMs = performance.now() - startTime;
  console.log(`\nPhase 1 complete: ${(elapsedMs / 1000).toFixed(1)}s (${(elapsedMs / sampleSize).toFixed(0)}ms/example)`);

  const cache: CacheFile = {
    metadata: {
      sample_size: sampleSize,
      use_vectors: USE_VECTORS,
      embed_model: EMBED_MODEL,
      k: K,
      timestamp: new Date().toISOString(),
    },
    results,
  };

  // Write cache to disk
  mkdirSync(CACHE_DIR, { recursive: true });
  const cp = cachePath(sampleSize);
  writeFileSync(cp, JSON.stringify(cache, null, 2));
  console.log(`Cache written to ${cp}`);

  return cache;
}

// ============================================================================
// Phase 2: Read
// ============================================================================

/**
 * Call the configured LLM with retry + exponential backoff for rate limits.
 * Returns { generatedAnswer, answerCorrect }.
 */
async function readExample(
  cached: CachedResult,
): Promise<{ generatedAnswer: string | null; answerCorrect: boolean }> {
  if (!LLM_API_KEY) {
    return { generatedAnswer: null, answerCorrect: false };
  }

  // Feed full session texts (top-10) to LLM — no truncation
  const topTexts = cached.retrieved_texts.slice(0, 10);
  if (topTexts.length === 0) {
    return { generatedAnswer: null, answerCorrect: false };
  }

  const context = topTexts.join("\n---\n");
  const MAX_RETRIES = 5;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${LLM_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: [
            { role: "system", content: "Answer the question based ONLY on the provided conversation history. Be concise — answer in one sentence or phrase. If the answer is not in the history, say 'NOT FOUND'." },
            { role: "user", content: `Conversation history:\n${context}\n\nQuestion: ${cached.question}` },
          ],
          max_tokens: 500,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("retry-after") || "0");
        const backoff = retryAfter > 0 ? retryAfter * 1000 : Math.min(5000 * Math.pow(2, attempt), 60000);
        process.stdout.write(`429 — waiting ${(backoff / 1000).toFixed(0)}s... `);
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        console.warn(`LLM API error ${resp.status}: ${errBody.slice(0, 200)}`);
        return { generatedAnswer: null, answerCorrect: false };
      }

      const data = await resp.json() as any;
      const generatedAnswer = data.choices?.[0]?.message?.content?.trim() || null;

      if (!generatedAnswer) {
        return { generatedAnswer: null, answerCorrect: false };
      }

      const answerCorrect = checkAnswerMatch(cached.expected_answer, generatedAnswer);
      return { generatedAnswer, answerCorrect };
    } catch {
      if (attempt < MAX_RETRIES) {
        const backoff = 5000 * Math.pow(2, attempt);
        process.stdout.write(`timeout — retry in ${(backoff / 1000).toFixed(0)}s... `);
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }
      return { generatedAnswer: null, answerCorrect: false };
    }
  }
  return { generatedAnswer: null, answerCorrect: false };
}

interface ReadResult {
  question_id: string;
  question: string;
  expected_answer: string;
  generated_answer: string | null;
  answer_correct: boolean;
  hit_at_10: boolean;
}

/**
 * Run Phase 2: load cache, call LLM for each example, score answers.
 * Saves all LLM responses to disk so results can be re-scored without re-running.
 */
async function runReadPhase(cache: CacheFile): Promise<void> {
  const { results: cached, metadata } = cache;
  console.log(`\n=== Phase 2: Read (N=${cached.length}, LLM=${LLM_MODEL}) ===\n`);

  if (!LLM_API_KEY) {
    console.log("WARNING: No LLM_API_KEY set (checked LLM_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY). E2E scores will be 0.");
  }

  // Check for saved responses from a previous run with the same model
  const responsesPath = join(CACHE_DIR, `read-responses-${LLM_MODEL}.json`);
  let savedResponses: ReadResult[] | null = null;
  if (existsSync(responsesPath)) {
    try {
      savedResponses = JSON.parse(readFileSync(responsesPath, "utf-8"));
      if (savedResponses && savedResponses.length === cached.length) {
        console.log(`Found saved responses from previous ${LLM_MODEL} run — re-scoring without API calls.\n`);
      } else {
        savedResponses = null;
      }
    } catch { savedResponses = null; }
  }

  const byType = new Map<string, TypeMetrics>();
  const startTime = performance.now();
  const readResults: ReadResult[] = [];

  for (let i = 0; i < cached.length; i++) {
    const c = cached[i];
    process.stdout.write(`[read] ${i + 1}/${cached.length}... `);

    let generatedAnswer: string | null;
    let answerCorrect: boolean;

    if (savedResponses) {
      // Re-score from saved responses
      generatedAnswer = savedResponses[i].generated_answer;
      answerCorrect = generatedAnswer ? checkAnswerMatch(c.expected_answer, generatedAnswer) : false;
    } else {
      // Rate limiting: delay between LLM calls to avoid 429s
      if (LLM_DELAY_MS > 0 && i > 0) {
        await new Promise(resolve => setTimeout(resolve, LLM_DELAY_MS));
      }

      const exStart = performance.now();
      const result = await readExample(c);
      generatedAnswer = result.generatedAnswer;
      answerCorrect = result.answerCorrect;
    }

    readResults.push({
      question_id: c.question_id,
      question: c.question,
      expected_answer: c.expected_answer,
      generated_answer: generatedAnswer,
      answer_correct: answerCorrect,
      hit_at_10: c.hit_at_10,
    });

    // Accumulate metrics
    let m = byType.get(c.question_type);
    if (!m) {
      m = { count: 0, hitsAt1: 0, hitsAt3: 0, hitsAt5: 0, hitsAt10: 0, e2eCorrect: 0, e2eTotal: 0 };
      byType.set(c.question_type, m);
    }
    m.count++;
    if (c.hit_at_1) m.hitsAt1++;
    if (c.hit_at_3 ?? c.hit_at_5) m.hitsAt3++; // fallback for old caches without hit_at_3
    if (c.hit_at_5) m.hitsAt5++;
    if (c.hit_at_10) m.hitsAt10++;
    m.e2eTotal++;
    if (answerCorrect) m.e2eCorrect++;

    const e2eStr = answerCorrect ? "CORRECT" : "wrong";
    const hitStr = c.hit_at_1 ? "R@1" : (c.hit_at_3 ? "R@3" : (c.hit_at_10 ? "R@10" : "miss"));
    console.log(
      `${hitStr}/${e2eStr} [${c.question_type}] "${c.question.slice(0, 60)}..."`
    );
    if (!answerCorrect && generatedAnswer) {
      console.log(`  expected: ${c.expected_answer} | got: ${generatedAnswer.slice(0, 120)}`);
    }
  }

  // Save responses to disk for future re-scoring
  if (!savedResponses) {
    writeFileSync(responsesPath, JSON.stringify(readResults, null, 2));
    console.log(`\nResponses saved to ${responsesPath}`);
  }

  const elapsedMs = performance.now() - startTime;

  // Compute totals
  const total: TypeMetrics = { count: 0, hitsAt1: 0, hitsAt3: 0, hitsAt5: 0, hitsAt10: 0, e2eCorrect: 0, e2eTotal: 0 };
  for (const m of byType.values()) {
    total.count += m.count;
    total.hitsAt1 += m.hitsAt1;
    total.hitsAt3 += m.hitsAt3;
    total.hitsAt5 += m.hitsAt5;
    total.hitsAt10 += m.hitsAt10;
    total.e2eCorrect += m.e2eCorrect;
    total.e2eTotal += m.e2eTotal;
  }

  // Print results table
  const mode = metadata.use_vectors ? "hybrid (BM25+vec)" : "BM25-only";
  console.log(`\n=== LongMemEval Benchmark (memex ${mode}, E2E: ${LLM_MODEL}, N=${total.count}) ===\n`);

  const hdr = "| Question Type              | Count | R@1   | R@3   | E2E   |";
  const sep = "|----------------------------|-------|-------|-------|-------|";
  console.log(hdr);
  console.log(sep);

  const types = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [type, m] of types) {
    const r1 = (m.hitsAt1 / m.count).toFixed(3);
    const r3 = (m.hitsAt3 / m.count).toFixed(3);
    const e2e = m.e2eTotal > 0 ? (m.e2eCorrect / m.e2eTotal).toFixed(3) : "  —  ";
    console.log(`| ${type.padEnd(26)} | ${String(m.count).padStart(5)} | ${r1} | ${r3} | ${e2e} |`);
  }

  const r1 = (total.hitsAt1 / total.count).toFixed(3);
  const r3 = (total.hitsAt3 / total.count).toFixed(3);
  const e2e = total.e2eTotal > 0 ? (total.e2eCorrect / total.e2eTotal).toFixed(3) : "  —  ";
  console.log(`| ${"OVERALL".padEnd(26)} | ${String(total.count).padStart(5)} | ${r1} | ${r3} | ${e2e} |`);

  console.log(`\nRead phase: ${(elapsedMs / 1000).toFixed(1)}s (${(elapsedMs / total.count).toFixed(0)}ms/example)`);
}

// ============================================================================
// Cache management
// ============================================================================

/**
 * Load cache from disk. Returns null if cache doesn't exist or doesn't cover
 * all required question IDs.
 */
function loadCache(sampleSize: number, requiredIds: Set<string>): CacheFile | null {
  const cp = cachePath(sampleSize);
  if (!existsSync(cp)) return null;

  try {
    const raw = readFileSync(cp, "utf-8");
    const cache: CacheFile = JSON.parse(raw);

    // Verify all required question_ids are present
    const cachedIds = new Set(cache.results.map(r => r.question_id));
    for (const id of requiredIds) {
      if (!cachedIds.has(id)) return null;
    }

    return cache;
  } catch {
    return null;
  }
}

// ============================================================================
// Phase 2b: Batch API (OpenAI)
// ============================================================================

function buildBatchRequest(cached: CachedResult): object {
  const topTexts = cached.retrieved_texts.slice(0, 10);
  const context = topTexts.join("\n---\n");
  return {
    custom_id: cached.question_id,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: LLM_MODEL,
      messages: [
        { role: "system", content: "Answer the question based ONLY on the provided conversation history. Be concise — answer in one sentence or phrase. If the answer is not in the history, say 'NOT FOUND'." },
        { role: "user", content: `Conversation history:\n${context}\n\nQuestion: ${cached.question}` },
      ],
      max_tokens: 500,
      temperature: 0,
    },
  };
}

async function submitOneBatch(lines: string[], batchIdx: number): Promise<string> {
  const jsonlContent = lines.join("\n");

  // Upload file
  const formData = new FormData();
  formData.append("purpose", "batch");
  formData.append("file", new Blob([jsonlContent], { type: "application/jsonl" }), `batch-input-${batchIdx}.jsonl`);

  const uploadResp = await fetch(`${LLM_BASE_URL}/files`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${LLM_API_KEY}` },
    body: formData,
  });

  if (!uploadResp.ok) {
    const err = await uploadResp.text();
    throw new Error(`File upload failed (${uploadResp.status}): ${err}`);
  }

  const uploadData = await uploadResp.json() as any;
  const fileId = uploadData.id;

  // Create batch
  const batchResp = await fetch(`${LLM_BASE_URL}/batches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input_file_id: fileId,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    }),
  });

  if (!batchResp.ok) {
    const err = await batchResp.text();
    throw new Error(`Batch creation failed (${batchResp.status}): ${err}`);
  }

  const batchData = await batchResp.json() as any;
  return batchData.id;
}

async function waitForBatch(batchId: string): Promise<any> {
  const POLL_INTERVAL = 10000; // 10s
  const MAX_WAIT = 600000; // 10min
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT) {
    const resp = await fetch(`${LLM_BASE_URL}/batches/${batchId}`, {
      headers: { "Authorization": `Bearer ${LLM_API_KEY}` },
    });
    const data = await resp.json() as any;

    if (data.status === "completed" || data.status === "failed" || data.status === "expired") {
      return data;
    }

    process.stdout.write(`  ${data.status} (${data.request_counts?.completed || 0}/${data.request_counts?.total || 0})... `);
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`Batch ${batchId} timed out after ${MAX_WAIT / 1000}s`);
}

async function downloadBatchOutput(outputFileId: string): Promise<string> {
  const resp = await fetch(`${LLM_BASE_URL}/files/${outputFileId}/content`, {
    headers: { "Authorization": `Bearer ${LLM_API_KEY}` },
  });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  return await resp.text();
}

async function batchSubmit(cache: CacheFile): Promise<void> {
  const { results: cached } = cache;
  console.log(`\n=== Batch Submit + Collect (N=${cached.length}, LLM=${LLM_MODEL}) ===\n`);

  // Build all requests
  const allLines = cached.map(c => JSON.stringify(buildBatchRequest(c)));

  // Split into mini-batches of 4 (each ~76K tokens, under the 90K limit)
  const BATCH_SIZE = 4;
  const chunks: string[][] = [];
  for (let i = 0; i < allLines.length; i += BATCH_SIZE) {
    chunks.push(allLines.slice(i, i + BATCH_SIZE));
  }
  console.log(`Splitting into ${chunks.length} mini-batches of ≤${BATCH_SIZE} requests\n`);

  // Process each mini-batch: submit, wait, collect
  const allOutputLines: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    process.stdout.write(`[batch ${i + 1}/${chunks.length}] submitting ${chunk.length} requests... `);

    const batchId = await submitOneBatch(chunk, i);
    console.log(`${batchId}`);

    process.stdout.write(`[batch ${i + 1}/${chunks.length}] waiting... `);
    const result = await waitForBatch(batchId);
    console.log(`${result.status} (${result.request_counts?.completed}/${result.request_counts?.total})`);

    if (result.status === "completed" && result.output_file_id) {
      const output = await downloadBatchOutput(result.output_file_id);
      allOutputLines.push(...output.split("\n").filter(Boolean));
    } else if (result.status === "failed") {
      console.warn(`  FAILED:`, result.errors?.data?.[0]?.message || "unknown error");
    }
  }

  // Save combined output
  const outputPath = join(CACHE_DIR, "batch-output.jsonl");
  writeFileSync(outputPath, allOutputLines.join("\n"));

  // Save meta for batch-collect scoring
  const metaPath = join(CACHE_DIR, "batch-meta.json");
  writeFileSync(metaPath, JSON.stringify({ model: LLM_MODEL, submitted: new Date().toISOString(), totalBatches: chunks.length }, null, 2));

  console.log(`\nAll batches complete. ${allOutputLines.length} results saved to ${outputPath}`);
  console.log(`\nScoring results...\n`);

  // Score inline
  const fakeCache: CacheFile = { ...cache };
  await batchCollectFromFile(fakeCache, allOutputLines);
}

function scoreBatchResults(cache: CacheFile, outputLines: string[], modelName: string): void {
  const { results: cached } = cache;

  // Parse results into a map: question_id → generated answer
  const answerMap = new Map<string, string>();
  for (const line of outputLines) {
    const obj = JSON.parse(line) as any;
    const qid = obj.custom_id;
    const answer = obj.response?.body?.choices?.[0]?.message?.content?.trim();
    if (qid && answer) answerMap.set(qid, answer);
  }
  console.log(`Parsed ${answerMap.size} answers\n`);

  // Score
  const byType = new Map<string, TypeMetrics>();
  for (const c of cached) {
    let m = byType.get(c.question_type);
    if (!m) {
      m = { count: 0, hitsAt1: 0, hitsAt3: 0, hitsAt5: 0, hitsAt10: 0, e2eCorrect: 0, e2eTotal: 0 };
      byType.set(c.question_type, m);
    }
    m.count++;
    if (c.hit_at_1) m.hitsAt1++;
    if ((c as any).hit_at_3 ?? c.hit_at_5) m.hitsAt3++;
    if (c.hit_at_5) m.hitsAt5++;
    if (c.hit_at_10) m.hitsAt10++;

    const generated = answerMap.get(c.question_id);
    if (generated) {
      m.e2eTotal++;
      const correct = checkAnswerMatch(c.expected_answer, generated);
      if (correct) m.e2eCorrect++;
      const tag = correct ? "CORRECT" : "wrong";
      const hitStr = c.hit_at_1 ? "R@1" : ((c as any).hit_at_3 ? "R@3" : (c.hit_at_10 ? "R@10" : "miss"));
      console.log(`${hitStr}/${tag} [${c.question_type}] "${c.question.slice(0, 60)}..."`);
      if (!correct) console.log(`  expected: ${c.expected_answer} | got: ${generated.slice(0, 100)}`);
    } else {
      m.e2eTotal++;
      console.log(`miss/NO_ANSWER [${c.question_type}] "${c.question.slice(0, 60)}..."`);
    }
  }

  // Print results table
  const total: TypeMetrics = { count: 0, hitsAt1: 0, hitsAt3: 0, hitsAt5: 0, hitsAt10: 0, e2eCorrect: 0, e2eTotal: 0 };
  for (const m of byType.values()) {
    total.count += m.count; total.hitsAt1 += m.hitsAt1; total.hitsAt3 += m.hitsAt3;
    total.hitsAt5 += m.hitsAt5; total.hitsAt10 += m.hitsAt10;
    total.e2eCorrect += m.e2eCorrect; total.e2eTotal += m.e2eTotal;
  }

  const mode = cache.metadata.use_vectors ? "hybrid (BM25+vec)" : "BM25-only";
  console.log(`\n=== LongMemEval Benchmark (memex ${mode}, E2E: ${modelName}, N=${total.count}) ===\n`);

  const hdr = "| Question Type              | Count | R@1   | R@3   | E2E   |";
  const sep = "|----------------------------|-------|-------|-------|-------|";
  console.log(hdr);
  console.log(sep);

  const types = [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [type, m] of types) {
    const r1 = (m.hitsAt1 / m.count).toFixed(3);
    const r3 = (m.hitsAt3 / m.count).toFixed(3);
    const e2e = m.e2eTotal > 0 ? (m.e2eCorrect / m.e2eTotal).toFixed(3) : "  —  ";
    console.log(`| ${type.padEnd(26)} | ${String(m.count).padStart(5)} | ${r1} | ${r3} | ${e2e} |`);
  }

  const r1 = (total.hitsAt1 / total.count).toFixed(3);
  const r3 = (total.hitsAt3 / total.count).toFixed(3);
  const e2e = total.e2eTotal > 0 ? (total.e2eCorrect / total.e2eTotal).toFixed(3) : "  —  ";
  console.log(`| ${"OVERALL".padEnd(26)} | ${String(total.count).padStart(5)} | ${r1} | ${r3} | ${e2e} |`);
}

async function batchCollectFromFile(cache: CacheFile, outputLines: string[]): Promise<void> {
  scoreBatchResults(cache, outputLines, LLM_MODEL);
}

async function batchCollect(cache: CacheFile): Promise<void> {
  const outputPath = join(CACHE_DIR, "batch-output.jsonl");

  if (!existsSync(outputPath)) {
    console.error("No batch-output.jsonl found. Run batch-submit first.");
    process.exit(1);
  }

  const outputContent = readFileSync(outputPath, "utf-8");
  const outputLines = outputContent.split("\n").filter(Boolean);
  console.log(`\n=== Batch Collect (${outputLines.length} results from ${outputPath}) ===\n`);

  const metaPath = join(CACHE_DIR, "batch-meta.json");
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf-8")) : { model: LLM_MODEL };

  scoreBatchResults(cache, outputLines, meta.model);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // Load dataset
  console.log(`Loading LongMemEval data from ${DATA_FILE}...`);
  const raw = readFileSync(DATA_FILE, "utf-8");
  const allExamples: LongMemEvalExample[] = JSON.parse(raw);
  console.log(`Loaded ${allExamples.length} examples.`);

  // Sample deterministically (take the first N)
  const sampleSize = Math.min(SAMPLE_SIZE, allExamples.length);
  const examples = allExamples.slice(0, sampleSize);
  const requiredIds = new Set(examples.map(e => e.question_id));

  console.log(`Phase: ${PHASE}, sample: ${sampleSize}, K=${K}, vectors=${USE_VECTORS}`);

  let cache: CacheFile | null = null;

  // Phase 1: Retrieve
  if (PHASE === "retrieve" || PHASE === "both") {
    // Check if cache already covers all required IDs
    cache = loadCache(sampleSize, requiredIds);

    if (cache && PHASE === "both") {
      console.log(`\nCache hit: ${cachePath(sampleSize)} covers all ${sampleSize} examples — skipping Phase 1.`);
    } else {
      cache = await runRetrievePhase(examples);
    }
  }

  // Phase 2: Read (real-time or batch)
  if (PHASE === "read" || PHASE === "both" || PHASE === "batch-submit" || PHASE === "batch-collect") {
    if (!cache) {
      cache = loadCache(sampleSize, requiredIds);
    }
    if (!cache) {
      console.error(`\nERROR: No cache found at ${cachePath(sampleSize)}. Run Phase 1 first:`);
      console.error(`  LONGMEMEVAL_PHASE=retrieve LONGMEMEVAL_SAMPLE=${sampleSize} node --import jiti/register tests/longmemeval-benchmark.ts`);
      process.exit(1);
    }

    if (PHASE === "batch-submit") {
      await batchSubmit(cache);
    } else if (PHASE === "batch-collect") {
      await batchCollect(cache);
    } else {
      await runReadPhase(cache);
    }
  }
}

main().catch((err) => {
  console.error("LongMemEval benchmark failed:", err);
  process.exit(1);
});
