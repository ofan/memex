/**
 * Fast LongMemEval benchmark — uses pre-computed research cache.
 * No embedding API calls needed. Runs the actual retriever pipeline.
 *
 * Tiers:
 *   TIER=fast     (~1s)   — pure math fusion simulation, no store
 *   TIER=pipeline  (~30s)  — real retriever pipeline with sqlite-vec + BM25
 *   TIER=e2e       (~2min) — pipeline + LLM reader for E2E accuracy
 *
 * Usage:
 *   node --import jiti/register tests/fast-benchmark.ts
 *   TIER=pipeline node --import jiti/register tests/fast-benchmark.ts
 *   TIER=e2e LLM_MODEL=gemini-2.5-flash node --import jiti/register tests/fast-benchmark.ts
 *
 * Environment:
 *   TIER             — "fast" (default), "pipeline", or "e2e"
 *   LLM_MODEL        — for e2e tier (default: gemini-2.5-flash)
 *   LLM_BASE_URL     — LLM endpoint
 *   LLM_API_KEY      — defaults to GEMINI_API_KEY
 *   FUSION           — "zscore" (default), "weighted", "veconly"
 *   VEC_WEIGHT       — vector weight (default: 0.8)
 *   BM25_WEIGHT      — BM25 weight (default: 0.2)
 *   POOL_VEC         — vector pool size (default: 30)
 *   POOL_BM25        — BM25 pool size (default: 20)
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Config
// ============================================================================

const CACHE_PATH = join(__dirname, "fixtures", "longmemeval-cache", "research-cache-50.json");
const CHUNK_SCORES_PATH = join(__dirname, "fixtures", "longmemeval-cache", "chunk-scores-50.json");
const TIER = (process.env.TIER || "fast") as "fast" | "pipeline" | "e2e";
const FUSION = (process.env.FUSION || "zscore") as "zscore" | "weighted" | "veconly";
const VEC_WEIGHT = parseFloat(process.env.VEC_WEIGHT || "0.8");
const BM25_WEIGHT = parseFloat(process.env.BM25_WEIGHT || "0.2");
const POOL_VEC = parseInt(process.env.POOL_VEC || "30");
const POOL_BM25 = parseInt(process.env.POOL_BM25 || "20");
const USE_CHUNKS = process.env.CHUNKS !== "0"; // default: use chunks if available
const RERANK = process.env.RERANK === "1";
const RERANK_ENDPOINT = process.env.RERANK_ENDPOINT || "http://REDACTED_IP:8090/v1/rerank";
const RERANK_MODEL = process.env.RERANK_MODEL || "bge-reranker-v2-m3-Q8_0";
const RERANK_API_KEY = process.env.RERANK_API_KEY || process.env.LLAMA_SWAP_API_KEY || "";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai";
const LLM_MODEL = process.env.LLM_MODEL || "gemini-2.5-flash";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "";
const RESPONSES_DIR = join(__dirname, "fixtures", "longmemeval-cache");

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

interface ChunkSessionScores {
  session_id: string;
  max_cosine: number;
  best_chunk_pos: number;
  chunk_scores: number[];
  num_chunks: number;
}

interface ChunkScoreCache {
  metadata: { chunk_size: number; chunk_overlap: number };
  examples: Array<{
    question_id: string;
    session_scores: ChunkSessionScores[];
  }>;
}

interface ExampleResult {
  question_id: string;
  question: string;
  question_type: string;
  expected_answer: string;
  answer_session_ids: string[];
  retrieved_session_ids: string[];
  retrieved_texts: string[];
  hit_at_1: boolean;
  hit_at_3: boolean;
  generated_answer: string | null;
  e2e_correct: boolean;
}

// ============================================================================
// Scorer (same as main benchmark)
// ============================================================================

const STOPWORDS = new Set([
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

// Semantic equivalences for scorer (date aliases, abbreviations, etc.)
const ALIASES: Record<string, string[]> = {
  "february 14th": ["valentine's day", "valentines day", "valentine day"],
  "valentine's day": ["february 14th", "feb 14", "february 14"],
  "december 25th": ["christmas", "christmas day", "xmas"],
  "christmas": ["december 25th", "dec 25"],
  "october 31st": ["halloween"],
  "halloween": ["october 31st", "oct 31"],
};

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

  const expectedTerms = expLower.split(/\s+/)
    .map(t => t.replace(/[().,]/g, ""))
    .filter(t => t.length > 0 && !STOPWORDS.has(t));
  if (expectedTerms.length === 0) return false;
  if (expectedTerms.length <= 2) return expectedTerms.every(t => gen.includes(t));
  const matchedTerms = expectedTerms.filter(t => gen.includes(t));
  return matchedTerms.length / expectedTerms.length >= 0.5;
}

// ============================================================================
// Tier: Fast (pure computation, ~1s)
// ============================================================================

async function rerankCandidates(query: string, candidates: Array<{ sid: string; text: string }>): Promise<string[]> {
  const resp = await fetch(RERANK_ENDPOINT, {
    method: "POST",
    headers: { "Authorization": `Bearer ${RERANK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: RERANK_MODEL, query, documents: candidates.map(c => c.text.slice(0, 2000)) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) return candidates.map(c => c.sid); // fallback to original order
  const data = await resp.json() as any;
  const sorted = data.results.sort((a: any, b: any) => b.relevance_score - a.relevance_score);
  return sorted.map((r: any) => candidates[r.index].sid);
}

async function runFast(cache: ResearchCache, chunkCache: ChunkScoreCache | null): Promise<ExampleResult[]> {
  const results: ExampleResult[] = [];

  // Build chunk score lookup: question_id -> session_id -> max_cosine
  const chunkLookup = new Map<string, Map<string, number>>();
  if (chunkCache) {
    for (const ex of chunkCache.examples) {
      const m = new Map<string, number>();
      for (const s of ex.session_scores) m.set(s.session_id, s.max_cosine);
      chunkLookup.set(ex.question_id, m);
    }
  }

  for (const ex of cache.examples) {
    const answerSet = new Set(ex.answer_session_ids);
    const chunkScores = chunkLookup.get(ex.question_id);

    // Build vector score map — use chunk max-sim when available
    let vecEntries: Array<{ session_id: string; score: number }>;
    if (chunkScores && USE_CHUNKS) {
      // Use chunked max-sim scores instead of truncated whole-session scores
      vecEntries = ex.sessions.map(s => ({
        session_id: s.session_id,
        score: chunkScores.get(s.session_id) ?? 0,
      }));
    } else {
      // Fallback: use original truncated cosine scores
      vecEntries = ex.vector_scores.map(v => ({
        session_id: v.session_id,
        score: v.cosine_score,
      }));
    }

    // Sort and apply pool capping
    vecEntries.sort((a, b) => b.score - a.score);
    const bm25Sorted = [...ex.bm25_scores].filter(b => b.bm25_score > 0).sort((a, b) => b.bm25_score - a.bm25_score);
    const vecPool = new Set(vecEntries.slice(0, POOL_VEC).map(v => v.session_id));
    const bm25Pool = new Set(bm25Sorted.slice(0, POOL_BM25).map(b => b.session_id));

    const vecMap = new Map<string, number>();
    for (const v of vecEntries) if (vecPool.has(v.session_id)) vecMap.set(v.session_id, v.score);
    const bm25Map = new Map<string, number>();
    for (const b of ex.bm25_scores) if (b.bm25_score > 0 && bm25Pool.has(b.session_id)) bm25Map.set(b.session_id, b.bm25_score);

    // Fuse
    const fused = applyFusion(vecMap, bm25Map, [...new Set([...vecPool, ...bm25Pool])]);
    let ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([sid]) => sid);

    // Build text lookup for E2E tier
    const textMap = new Map(ex.sessions.map(s => [s.session_id, s.text]));

    // Rerank top candidates if enabled — use best chunk text, not full session
    if (RERANK && chunkCache) {
      const chunkEx = chunkCache.examples.find(e => e.question_id === ex.question_id);
      const topCandidates = ranked.slice(0, 10).map(sid => {
        const fullText = textMap.get(sid) || "";
        // Find best chunk position for this session
        const cs = chunkEx?.session_scores.find(s => s.session_id === sid);
        if (cs && cs.best_chunk_pos > 0) {
          // Use text around the best chunk
          return { sid, text: fullText.slice(cs.best_chunk_pos, cs.best_chunk_pos + 2000) };
        }
        return { sid, text: fullText.slice(0, 2000) };
      });
      ranked = await rerankCandidates(ex.question, topCandidates);
    } else if (RERANK) {
      const topCandidates = ranked.slice(0, 10).map(sid => ({ sid, text: (textMap.get(sid) || "").slice(0, 2000) }));
      ranked = await rerankCandidates(ex.question, topCandidates);
    }

    const top10 = ranked.slice(0, 10);

    results.push({
      question_id: ex.question_id,
      question: ex.question,
      question_type: ex.question_type,
      expected_answer: ex.expected_answer,
      answer_session_ids: ex.answer_session_ids,
      retrieved_session_ids: top10,
      retrieved_texts: top10.map(sid => textMap.get(sid) || ""),
      hit_at_1: top10.slice(0, 1).some(s => answerSet.has(s)),
      hit_at_3: top10.slice(0, 3).some(s => answerSet.has(s)),
      generated_answer: null,
      e2e_correct: false,
    });
  }

  return results;
}

function applyFusion(
  vecMap: Map<string, number>,
  bm25Map: Map<string, number>,
  candidates: string[],
): Map<string, number> {
  if (FUSION === "veconly") {
    const fused = new Map<string, number>();
    for (const sid of candidates) {
      const v = vecMap.get(sid);
      if (v !== undefined) fused.set(sid, v);
    }
    return fused;
  }

  if (FUSION === "weighted") {
    const fused = new Map<string, number>();
    for (const sid of candidates) {
      const v = vecMap.get(sid) ?? 0;
      const b = bm25Map.get(sid) ?? 0;
      if (v > 0 && b > 0) fused.set(sid, VEC_WEIGHT * v + BM25_WEIGHT * b);
      else if (v > 0) fused.set(sid, v);
      else if (b > 0) fused.set(sid, b);
    }
    return fused;
  }

  // zscore
  const vecArr = [...vecMap.values()];
  const bm25Arr = [...bm25Map.values()];
  const vecMean = vecArr.length > 1 ? vecArr.reduce((a, b) => a + b, 0) / vecArr.length : 0;
  const vecStd = vecArr.length > 1 ? Math.sqrt(vecArr.reduce((a, s) => a + (s - vecMean) ** 2, 0) / vecArr.length) : 1;
  const bm25Mean = bm25Arr.length > 1 ? bm25Arr.reduce((a, b) => a + b, 0) / bm25Arr.length : 0;
  const bm25Std = bm25Arr.length > 1 ? Math.sqrt(bm25Arr.reduce((a, s) => a + (s - bm25Mean) ** 2, 0) / bm25Arr.length) : 1;
  const safeVecStd = vecStd < 0.001 ? 1 : vecStd;
  const safeBm25Std = bm25Std < 0.001 ? 1 : bm25Std;

  const fused = new Map<string, number>();
  for (const sid of candidates) {
    const v = vecMap.get(sid);
    const b = bm25Map.get(sid);
    if (v !== undefined || b !== undefined) {
      const vz = v !== undefined ? (v - vecMean) / safeVecStd : 0;
      const bz = b !== undefined ? (b - bm25Mean) / safeBm25Std : 0;
      const rawZ = VEC_WEIGHT * vz + BM25_WEIGHT * bz;
      fused.set(sid, 1 / (1 + Math.exp(-rawZ)));
    }
  }
  return fused;
}

// ============================================================================
// Tier: Pipeline (real retriever, ~30s)
// ============================================================================

async function runPipeline(cache: ResearchCache): Promise<ExampleResult[]> {
  const { MemoryStore } = await import("../src/memory.js");
  const { createRetriever } = await import("../src/retriever.js");
  const { createEmbedder } = await import("../src/embedder.js");

  const results: ExampleResult[] = [];
  const vectorDim = cache.metadata.vector_dim;

  // Create a dummy embedder that returns cached vectors
  // We intercept embedQuery to return the cached query vector
  let currentQueryVector: number[] = [];
  const dummyEmbedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: "unused",
    model: "cached",
    baseURL: "http://localhost:1", // never actually called
    dimensions: vectorDim,
  });
  // Override embedQuery to return cached vector
  const origEmbedQuery = dummyEmbedder.embedQuery.bind(dummyEmbedder);
  dummyEmbedder.embedQuery = async (_text: string) => currentQueryVector;

  for (let i = 0; i < cache.examples.length; i++) {
    const ex = cache.examples[i];
    const tmpDir = mkdtempSync(join(tmpdir(), "fast-bench-"));

    try {
      const store = new MemoryStore({ dbPath: join(tmpDir, "memex.sqlite"), vectorDim });

      // Bulk-insert sessions with cached vectors
      const entries = ex.sessions.map(s => ({
        text: s.text,
        vector: s.vector,
        category: "fact" as const,
        scope: "global",
        importance: 0.5,
        metadata: JSON.stringify({ sessionId: s.session_id }),
      }));
      await store.bulkStore(entries);

      // Set the query vector for this example
      currentQueryVector = ex.query_vector;

      const retriever = createRetriever(store, dummyEmbedder, {
        mode: "hybrid",
        fusionMethod: FUSION === "veconly" ? "weighted" : (FUSION as any),
        vectorWeight: FUSION === "veconly" ? 1.0 : VEC_WEIGHT,
        bm25Weight: FUSION === "veconly" ? 0.0 : BM25_WEIGHT,
        rerank: "none",
        candidatePoolSize: Math.max(POOL_VEC, POOL_BM25),
        minScore: 0.05,
        hardMinScore: 0.10,
        recencyHalfLifeDays: 0,
        recencyWeight: 0,
        timeDecayHalfLifeDays: 0,
        lengthNormAnchor: 0,
        filterNoise: false,
      });

      const retrieved = await retriever.retrieve({ query: ex.question, limit: 10 });
      const answerSet = new Set(ex.answer_session_ids);

      const retrievedIds: string[] = [];
      const retrievedTexts: string[] = [];
      for (const r of retrieved) {
        try {
          const meta = JSON.parse(r.entry.metadata || "{}");
          retrievedIds.push(meta.sessionId);
        } catch { retrievedIds.push(""); }
        retrievedTexts.push(r.entry.text);
      }

      results.push({
        question_id: ex.question_id,
        question: ex.question,
        question_type: ex.question_type,
        expected_answer: ex.expected_answer,
        answer_session_ids: ex.answer_session_ids,
        retrieved_session_ids: retrievedIds,
        retrieved_texts: retrievedTexts,
        hit_at_1: retrievedIds.slice(0, 1).some(s => answerSet.has(s)),
        hit_at_3: retrievedIds.slice(0, 3).some(s => answerSet.has(s)),
        generated_answer: null,
        e2e_correct: false,
      });

      await store.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    if ((i + 1) % 10 === 0) process.stdout.write(`${i + 1}/${cache.examples.length} `);
  }

  return results;
}

// ============================================================================
// Tier: E2E (pipeline + LLM reader)
// ============================================================================

async function addE2E(results: ExampleResult[]): Promise<void> {
  if (!LLM_API_KEY) {
    console.log("No LLM_API_KEY — skipping E2E. Set GEMINI_API_KEY or LLM_API_KEY.");
    return;
  }

  // Check for cached responses
  const responsesPath = join(RESPONSES_DIR, `fast-responses-${LLM_MODEL}.json`);
  let cached: Array<{ question_id: string; answer: string }> | null = null;
  if (existsSync(responsesPath)) {
    try {
      cached = JSON.parse(readFileSync(responsesPath, "utf-8"));
      if (cached && cached.length === results.length) {
        console.log(`Re-scoring cached ${LLM_MODEL} responses (no API calls).\n`);
      } else cached = null;
    } catch { cached = null; }
  }

  const newResponses: Array<{ question_id: string; answer: string }> = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];

    let answer: string;
    if (cached) {
      answer = cached[i].answer;
    } else {
      const topTexts = r.retrieved_texts.slice(0, 10);
      if (topTexts.length === 0) { answer = "NOT FOUND"; }
      else {
        const context = topTexts.join("\n---\n");
        for (let attempt = 0; attempt <= 3; attempt++) {
          try {
            const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${LLM_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: LLM_MODEL,
                messages: [
                  { role: "user", content: `I will give you several history chats between you and a user. Please answer the question based on the relevant chat history.\n\n\nHistory Chats:\n\n${context}\n\nQuestion: ${r.question}\nAnswer:` },
                ],
                max_tokens: 500, temperature: 0,
              }),
              signal: AbortSignal.timeout(30000),
            });
            if (resp.status === 429) {
              const backoff = Math.min(5000 * Math.pow(2, attempt), 60000);
              await new Promise(resolve => setTimeout(resolve, backoff));
              continue;
            }
            if (!resp.ok) { answer = "NOT FOUND"; break; }
            const data = await resp.json() as any;
            answer = data.choices?.[0]?.message?.content?.trim() || "NOT FOUND";
            break;
          } catch {
            if (attempt === 3) answer = "NOT FOUND";
            else await new Promise(resolve => setTimeout(resolve, 5000 * Math.pow(2, attempt)));
            continue;
          }
        }
        answer ??= "NOT FOUND";
      }
    }

    r.generated_answer = answer;
    newResponses.push({ question_id: r.question_id, answer });
  }

  if (!cached) {
    writeFileSync(responsesPath, JSON.stringify(newResponses, null, 2));
    console.log(`Responses saved to ${responsesPath}`);
  }

  // Official LongMemEval LLM-judge evaluation
  // Uses GPT-4o-mini as judge (same as official eval)
  const JUDGE_KEY = process.env.OPENAI_API_KEY || LLM_API_KEY;
  const JUDGE_MODEL = "gpt-4o-mini";
  console.log(`Judging with ${JUDGE_MODEL}...`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r.generated_answer) { r.e2e_correct = false; continue; }

    // Official judge prompt from LongMemEval evaluate_qa.py
    const judgePrompt = `I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: ${r.question}\n\nCorrect Answer: ${r.expected_answer}\n\nModel Response: ${r.generated_answer}\n\nIs the model response correct? Answer yes or no only.`;

    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Authorization": `Bearer ${JUDGE_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: JUDGE_MODEL,
            messages: [{ role: "user", content: judgePrompt }],
            max_tokens: 10, temperature: 0,
          }),
          signal: AbortSignal.timeout(15000),
        });
        if (resp.status === 429) {
          await new Promise(resolve => setTimeout(resolve, 3000 * Math.pow(2, attempt)));
          continue;
        }
        if (!resp.ok) { r.e2e_correct = false; break; }
        const data = await resp.json() as any;
        const verdict = (data.choices?.[0]?.message?.content || "").toLowerCase().trim();
        r.e2e_correct = verdict.includes("yes");
        break;
      } catch {
        if (attempt === 3) r.e2e_correct = false;
        else await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
}

// ============================================================================
// Reporting
// ============================================================================

function report(results: ExampleResult[], elapsedMs: number): void {
  const n = results.length;
  const r1 = results.filter(r => r.hit_at_1).length;
  const r3 = results.filter(r => r.hit_at_3).length;
  const hasE2E = results.some(r => r.generated_answer !== null);
  const e2e = hasE2E ? results.filter(r => r.e2e_correct).length : -1;

  const fusionLabel = `${FUSION} ${VEC_WEIGHT}v+${BM25_WEIGHT}b`;
  const vecLabel = USE_CHUNKS ? "chunked" : "truncated";
  console.log(`\n=== Fast Benchmark (${TIER}, ${fusionLabel}, pool=${POOL_VEC}/${POOL_BM25}, vec=${vecLabel}, N=${n}) ===\n`);

  // Per-example details
  for (const r of results) {
    const hit = r.hit_at_1 ? "R@1" : (r.hit_at_3 ? "R@3" : "miss");
    const e2eStr = r.generated_answer !== null ? (r.e2e_correct ? "/OK" : "/FAIL") : "";
    if (hit === "miss" || (r.generated_answer !== null && !r.e2e_correct)) {
      console.log(`  ${hit}${e2eStr} ${r.question_id.slice(0, 8)} "${r.question.slice(0, 55)}..."`);
      if (r.generated_answer !== null && !r.e2e_correct) {
        console.log(`    expected: ${r.expected_answer} | got: ${(r.generated_answer || "").slice(0, 80)}`);
      }
    }
  }

  console.log();
  console.log(`  R@1:  ${r1}/${n} (${(100 * r1 / n).toFixed(0)}%)`);
  console.log(`  R@3:  ${r3}/${n} (${(100 * r3 / n).toFixed(0)}%)`);
  if (hasE2E) console.log(`  E2E:  ${e2e}/${n} (${(100 * e2e / n).toFixed(0)}%)`);
  console.log(`  Time: ${(elapsedMs / 1000).toFixed(1)}s`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`Loading research cache...`);
  const t0 = performance.now();
  const cache: ResearchCache = JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  const loadMs = performance.now() - t0;
  console.log(`Loaded ${cache.examples.length} examples (${(loadMs / 1000).toFixed(1)}s parse)`);

  // Load chunk scores if available
  let chunkCache: ChunkScoreCache | null = null;
  if (USE_CHUNKS && existsSync(CHUNK_SCORES_PATH)) {
    const ct0 = performance.now();
    chunkCache = JSON.parse(readFileSync(CHUNK_SCORES_PATH, "utf-8"));
    console.log(`Loaded chunk scores (${chunkCache!.metadata.chunk_size}c/${chunkCache!.metadata.chunk_overlap}o, ${chunkCache!.metadata.total_chunks_embedded} chunks) in ${((performance.now() - ct0) / 1000).toFixed(1)}s`);
  } else if (USE_CHUNKS) {
    console.log(`No chunk scores found (run build-chunk-cache.ts first). Using truncated vectors.`);
  } else {
    console.log(`Chunks disabled (CHUNKS=0).`);
  }

  const chunksLabel = chunkCache ? "chunked" : "truncated";
  console.log(`\nTier: ${TIER} | Fusion: ${FUSION} ${VEC_WEIGHT}v+${BM25_WEIGHT}b | Pool: ${POOL_VEC}/${POOL_BM25} | Vec: ${chunksLabel}`);

  const start = performance.now();
  let results: ExampleResult[];

  if (TIER === "fast" || TIER === "e2e") {
    results = await runFast(cache, chunkCache);
  } else {
    results = await runPipeline(cache);
  }

  if (TIER === "e2e") {
    await addE2E(results);
  }

  const elapsed = performance.now() - start;
  report(results, elapsed);
}

main().catch(err => { console.error(err); process.exit(1); });
