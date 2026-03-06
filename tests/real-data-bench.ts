/**
 * Real-Data Benchmark: Replay OpenClaw Memory Calls Through Unified Pipeline
 *
 * Extracts actual memory_search / memory_recall calls from production session
 * transcripts and replays each query through the unified recall pipeline.
 * Compares: old system results vs unified pipeline results.
 *
 * Usage:
 *   node --import jiti/register tests/real-data-bench.ts
 *   node --import jiti/register tests/real-data-bench.ts --rebuild
 *   node --import jiti/register tests/real-data-bench.ts --rebuild-docs
 */

import { performance } from "node:perf_hooks";
import { join, resolve, basename } from "node:path";
import { mkdirSync, existsSync, readFileSync, readdirSync, cpSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";

import { createEmbedder, type Embedder } from "../src/embedder.js";
import { MemoryStore } from "../src/store.js";
import { createRetriever, type MemoryRetriever } from "../src/retriever.js";
import { UnifiedRecall, type UnifiedResult, type ResultSource } from "../src/unified-recall.js";
import { createStore as createQmdStore, hybridQuery as qmdHybridQueryFn } from "../src/qmd/store.js";
import { initializeQmdLLM } from "../src/qmd/llm.js";
import { indexPath } from "../src/doc-indexer.js";
import { embedWithCache } from "./helpers/embedding-cache.js";

// ============================================================================
// Config
// ============================================================================

const EMBEDDING_BASE_URL = "http://100.122.104.26:8090/v1";
const EMBEDDING_MODEL = "Qwen3-Embedding-0.6B-Q8_0";
const EMBEDDING_DIMS = 1024;
const RERANKER_ENDPOINT = "http://100.122.104.26:8090/v1/rerank";
const RERANKER_MODEL = "bge-reranker-v2-m3-Q8_0";

const SESSIONS_DIR = "/home/ubuntu/.openclaw/agents/main/sessions/";
const PROD_LANCEDB = "/home/ubuntu/.openclaw/memory/lancedb-pro";
const PROD_QMD_SQLITE = "/home/ubuntu/.openclaw/memory/main.sqlite";
const WORKSPACE_DIR = "/home/ubuntu/.openclaw/workspace/";

const CACHE_DIR = join(import.meta.url.replace("file://", "").replace(/\/[^/]+$/, ""), ".cache", "real-data");

// ============================================================================
// Types
// ============================================================================

interface ExtractedCall {
  sessionId: string;
  tool: "memory_search" | "memory_recall";
  query: string;
  originalResults: {
    count: number;
    topScore: number;
    snippets: string[];
    error?: string;
  };
}

interface ReplayResult {
  call: ExtractedCall;
  modes: {
    name: string;
    resultCount: number;
    topScore: number;
    latencyMs: number;
    snippets: string[];
  }[];
}

// ============================================================================
// Task 1: Extract tool calls from transcripts
// ============================================================================

function extractToolCalls(): ExtractedCall[] {
  const calls: ExtractedCall[] = [];

  if (!existsSync(SESSIONS_DIR)) {
    console.warn(`Sessions directory not found: ${SESSIONS_DIR}`);
    return calls;
  }

  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));

  for (const file of files) {
    const sessionId = file.replace(".jsonl", "");
    const lines = readFileSync(join(SESSIONS_DIR, file), "utf-8").split("\n");

    // Collect pending tool calls (waiting for results)
    const pending = new Map<string, { tool: string; query: string }>();

    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const msg = obj?.message;
      if (!msg) continue;
      const content = msg.content;

      // Assistant makes a tool call
      if (msg.role === "assistant" && Array.isArray(content)) {
        for (const c of content) {
          if (
            c?.type === "toolCall" &&
            (c.name === "memory_search" || c.name === "memory_recall")
          ) {
            pending.set(c.id, {
              tool: c.name,
              query: c.arguments?.query || "",
            });
          }
        }
      }

      // Tool result comes back
      if (
        msg.role === "toolResult" &&
        (msg.toolName === "memory_search" || msg.toolName === "memory_recall")
      ) {
        const toolCallId = msg.toolCallId;
        const call = pending.get(toolCallId);
        if (!call) continue;
        pending.delete(toolCallId);

        const resultText =
          Array.isArray(content) && content[0]?.text
            ? content[0].text
            : typeof content === "string"
              ? content
              : "";

        const parsed = parseOriginalResult(call.tool, resultText);

        // Skip empty queries
        if (!call.query.trim()) continue;

        calls.push({
          sessionId: sessionId.slice(-12),
          tool: call.tool as "memory_search" | "memory_recall",
          query: call.query,
          originalResults: parsed,
        });
      }
    }
  }

  return calls;
}

function parseOriginalResult(
  tool: string,
  resultText: string,
): ExtractedCall["originalResults"] {
  if (!resultText || resultText.trim().length < 5) {
    return { count: 0, topScore: 0, snippets: [] };
  }

  if (tool === "memory_recall") {
    // Format: "Found N memories:\n\n1. [id] [cat:scope] text..."
    const countMatch = resultText.match(/Found (\d+) memor/);
    const count = countMatch ? parseInt(countMatch[1]) : 0;
    // Extract first few snippets
    const snippets: string[] = [];
    const entryMatches = resultText.matchAll(/\d+\.\s+\[[^\]]+\]\s+\[[^\]]+\]\s+(.+?)(?=\n\d+\.|\n*$)/gs);
    for (const m of entryMatches) {
      if (snippets.length < 3) snippets.push(m[1].trim().slice(0, 150));
    }
    return { count, topScore: 0, snippets };
  }

  // memory_search — JSON format
  try {
    const parsed = JSON.parse(resultText);
    if (parsed.error) {
      return { count: 0, topScore: 0, snippets: [], error: parsed.error };
    }
    const results = parsed.results || [];
    const snippets = results.slice(0, 3).map((r: any) =>
      (r.snippet || r.bestChunk || r.title || "").slice(0, 150),
    );
    return {
      count: results.length,
      topScore: results[0]?.score ?? 0,
      snippets,
    };
  } catch {
    return { count: 0, topScore: 0, snippets: [] };
  }
}

// ============================================================================
// Task 2: Set up unified pipeline
// ============================================================================

async function setupPipeline(rebuild: boolean, rebuildDocs: boolean) {
  console.log("\n--- Setting up pipeline ---");

  // 1. Create embedder
  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: "unused",
    model: EMBEDDING_MODEL,
    baseURL: EMBEDDING_BASE_URL,
    dimensions: EMBEDDING_DIMS,
  });

  // Test embedder
  const testResult = await embedder.test();
  if (!testResult.success) {
    throw new Error(`Embedder test failed: ${testResult.error}`);
  }
  console.log(`  Embedder OK (dims=${testResult.dimensions})`);

  // Initialize QMD LLM early (needed by rebuildQmdStore → embedDocuments)
  initializeQmdLLM({
    embedding: {
      baseURL: EMBEDDING_BASE_URL,
      apiKey: "unused",
      model: EMBEDDING_MODEL,
      dimensions: EMBEDDING_DIMS,
    },
    reranker: {
      enabled: true,
      endpoint: RERANKER_ENDPOINT,
      apiKey: "unused",
      model: RERANKER_MODEL,
    },
  });

  // 2. Set up LanceDB store
  let lanceDbPath: string;
  let needsRebuild = rebuild;

  if (!rebuild) {
    // Try to use production data directly
    lanceDbPath = PROD_LANCEDB;
    try {
      const testStore = new MemoryStore({ dbPath: lanceDbPath, vectorDim: EMBEDDING_DIMS });
      // Force init to detect dimension mismatch
      const stats = await testStore.stats();
      console.log(`  Production LanceDB: ${stats.totalCount} memories`);
    } catch (err: any) {
      if (err.message?.includes("dimension mismatch")) {
        console.warn(`  Dimension mismatch detected, switching to rebuild mode`);
        needsRebuild = true;
      } else {
        throw err;
      }
    }
  }

  if (needsRebuild) {
    lanceDbPath = join(CACHE_DIR, "lancedb");
    await rebuildLanceDB(lanceDbPath, embedder);
  }

  const lanceStore = new MemoryStore({ dbPath: lanceDbPath, vectorDim: EMBEDDING_DIMS });

  // 3. Set up QMD store
  let qmdDbPath: string;

  if (!rebuild && !rebuildDocs) {
    qmdDbPath = PROD_QMD_SQLITE;
    console.log(`  Using production QMD: ${qmdDbPath}`);
  } else {
    qmdDbPath = join(CACHE_DIR, "qmd.sqlite");
    await rebuildQmdStore(qmdDbPath, embedder, EMBEDDING_DIMS);
  }

  const qmdStore = createQmdStore(qmdDbPath);
  qmdStore.ensureVecTable(EMBEDDING_DIMS);

  // 4. Set up retriever + unified recall
  const retriever = createRetriever(lanceStore, embedder, {
    mode: "hybrid",
    rerank: "cross-encoder",
    rerankEndpoint: RERANKER_ENDPOINT,
    rerankApiKey: "unused",
    rerankModel: RERANKER_MODEL,
    rerankProvider: "jina",
    hardMinScore: 0.1,  // Lower for benchmark — capture more results
    filterNoise: false,
  });

  const lanceStats = await lanceStore.stats();
  const qmdStatus = qmdStore.getStatus();
  console.log(`  LanceDB: ${lanceStats.totalCount} memories`);
  console.log(`  QMD: ${qmdStatus.totalDocuments} docs, needsEmbedding=${qmdStatus.needsEmbedding}, hasVectors=${qmdStatus.hasVectorIndex}`);

  return { embedder, lanceStore, qmdStore, retriever };
}

async function rebuildLanceDB(dbPath: string, embedder: Embedder) {
  console.log(`  Rebuilding LanceDB at ${dbPath}...`);
  mkdirSync(dbPath, { recursive: true });

  // Read memories from production LanceDB
  // We can't connect to prod with wrong dimensions, so read via a temp store
  // with the prod dimensions. But we don't know prod dims...
  // Instead, list all memories from prod using the store API with matching dims.
  // The plan says "46 memories with Gemini embeddings (3072d)".
  // We'll try 3072 first, fall back to reading text via sqlite if that fails.

  const PROD_DIMS = 3072; // Gemini embedding dimensions
  let memoryTexts: { text: string; category: string; scope: string; importance: number; timestamp: number; id: string }[] = [];

  try {
    const prodStore = new MemoryStore({ dbPath: PROD_LANCEDB, vectorDim: PROD_DIMS });
    const all = await prodStore.list(undefined, undefined, 1000);
    memoryTexts = all.map((m) => ({
      text: m.text,
      category: m.category,
      scope: m.scope,
      importance: m.importance,
      timestamp: m.timestamp,
      id: m.id,
    }));
    console.log(`  Read ${memoryTexts.length} memories from production LanceDB`);
  } catch (err: any) {
    console.warn(`  Could not read production LanceDB: ${err.message}`);
    console.warn(`  Skipping LanceDB rebuild — will have 0 conversation memories`);
    return;
  }

  if (memoryTexts.length === 0) return;

  // Remove old data
  if (existsSync(dbPath)) {
    rmSync(dbPath, { recursive: true, force: true });
    mkdirSync(dbPath, { recursive: true });
  }

  // Re-embed and store
  const newStore = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMS });

  const { vectors, stats } = await embedWithCache(
    memoryTexts.map((m) => m.text),
    EMBEDDING_MODEL,
    (text) => embedder.embedPassage(text),
    { onProgress: (done, total) => console.log(`    Embedding memories: ${done}/${total}`) },
  );
  console.log(`  Embedding cache: ${stats.hitRate} hit rate`);

  for (let i = 0; i < memoryTexts.length; i++) {
    const m = memoryTexts[i];
    await newStore.importEntry({
      id: m.id,
      text: m.text,
      vector: vectors[i],
      category: m.category as any,
      scope: m.scope,
      importance: m.importance,
      timestamp: m.timestamp,
    });
  }

  await newStore.rebuildFtsIndex();
  console.log(`  Rebuilt LanceDB with ${memoryTexts.length} memories (${EMBEDDING_DIMS}d)`);
}

async function rebuildQmdStore(dbPath: string, embedder: Embedder, dims: number) {
  console.log(`  Rebuilding QMD store at ${dbPath}...`);
  mkdirSync(CACHE_DIR, { recursive: true });

  // Remove old data
  if (existsSync(dbPath)) rmSync(dbPath);

  // Import QMD store functions we need
  const qmdMod = (await import("../src/qmd/store.js")) as any;
  // jiti wraps exports in .default for CommonJS-style modules
  const {
    createStore: _createStore,
    hashContent,
    insertContent,
    insertDocument,
    insertEmbedding,
    getHashesForEmbedding,
    chunkDocument,
    formatDocForEmbedding,
    extractTitle,
  } = qmdMod.default || qmdMod;

  const store = _createStore(dbPath);
  store.ensureVecTable(dims);

  // Index workspace docs
  if (existsSync(WORKSPACE_DIR)) {
    const result = await indexPath(store.db, {
      path: WORKSPACE_DIR,
      name: "workspace",
      pattern: "**/*.md",
    });
    console.log(`  Indexed workspace: ${result.indexed} new, ${result.updated} updated`);
  }

  // Also index LanceDB memories as documents in QMD
  const PROD_DIMS = 3072;
  try {
    const prodStore = new MemoryStore({ dbPath: PROD_LANCEDB, vectorDim: PROD_DIMS });
    const all = await prodStore.list(undefined, undefined, 1000);
    if (all.length > 0) {
      console.log(`  Indexing ${all.length} LanceDB memories into QMD as docs...`);
      const now = new Date().toISOString();
      for (const m of all) {
        const hash = await hashContent(m.text);
        insertContent(store.db, hash, m.text, now);
        const docPath = `memory/${m.id}.md`;
        const title = m.text.slice(0, 80).replace(/\n/g, " ");
        insertDocument(store.db, "memory", docPath, title, hash, now, now);
      }
      console.log(`  Inserted ${all.length} memory docs into QMD`);
    }
  } catch (err: any) {
    console.warn(`  Could not index LanceDB memories into QMD: ${err.message}`);
  }

  // Embed all documents directly (bypassing doc-indexer which has a bug)
  const hashesToEmbed = getHashesForEmbedding(store.db) as { hash: string; body: string; path: string }[];
  console.log(`  Embedding ${hashesToEmbed.length} docs...`);
  let embeddedCount = 0;
  let chunkCount = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < hashesToEmbed.length; i++) {
    const item = hashesToEmbed[i];
    try {
      const title = extractTitle(item.body, item.path);
      const chunks = chunkDocument(item.body);

      for (let seq = 0; seq < chunks.length; seq++) {
        const chunk = chunks[seq];
        if (!chunk) continue;

        const textForEmbed = formatDocForEmbedding(chunk.text, title);
        const vec = await embedder.embedPassage(textForEmbed);
        const embedding = new Float32Array(vec);

        insertEmbedding(store.db, item.hash, seq, chunk.pos, embedding, EMBEDDING_MODEL, now);
        chunkCount++;
      }
      embeddedCount++;
    } catch (err: any) {
      console.warn(`    Embed error for ${item.path}: ${err.message?.slice(0, 80)}`);
    }

    if ((i + 1) % 10 === 0 || i + 1 === hashesToEmbed.length) {
      console.log(`    Embedded ${i + 1}/${hashesToEmbed.length} docs (${chunkCount} chunks)`);
    }
  }

  console.log(`  Embedded: ${embeddedCount} docs, ${chunkCount} chunks`);
  store.close();
}

// ============================================================================
// Task 3: Replay queries through unified pipeline
// ============================================================================

type PipelineMode = {
  name: string;
  sources: ResultSource[];
  crossRerank: boolean;
};

const REPLAY_MODES: PipelineMode[] = [
  { name: "recall-only", sources: ["conversation"], crossRerank: false },
  { name: "search-only", sources: ["document"], crossRerank: false },
  { name: "unified", sources: ["conversation", "document"], crossRerank: false },
  { name: "unified+rerank", sources: ["conversation", "document"], crossRerank: true },
];

async function replayQueries(
  calls: ExtractedCall[],
  retriever: MemoryRetriever,
  embedder: Embedder,
  qmdStore: ReturnType<typeof createQmdStore>,
): Promise<ReplayResult[]> {
  console.log(`\n--- Replaying ${calls.length} queries ---\n`);

  const results: ReplayResult[] = [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const modeResults: ReplayResult["modes"] = [];

    for (const mode of REPLAY_MODES) {
      const unified = new UnifiedRecall(retriever, embedder, {
        limit: 10,
        minScore: 0.05,
        crossRerank: mode.crossRerank,
        rerankConfig: mode.crossRerank
          ? {
              provider: "jina",
              apiKey: "unused",
              model: RERANKER_MODEL,
              endpoint: RERANKER_ENDPOINT,
            }
          : undefined,
      });

      if (mode.sources.includes("document")) {
        unified.setQmdStore(qmdStore as any, qmdHybridQueryFn as any, EMBEDDING_MODEL);
      }

      const t0 = performance.now();
      try {
        const results = await unified.recall(call.query, {
          limit: 10,
          sources: mode.sources,
        });

        const latencyMs = performance.now() - t0;
        modeResults.push({
          name: mode.name,
          resultCount: results.length,
          topScore: results[0]?.score ?? 0,
          latencyMs,
          snippets: results.slice(0, 3).map((r) => r.text.slice(0, 150)),
        });
      } catch (err: any) {
        modeResults.push({
          name: mode.name,
          resultCount: 0,
          topScore: 0,
          latencyMs: performance.now() - t0,
          snippets: [`ERROR: ${err.message?.slice(0, 100)}`],
        });
      }
    }

    results.push({ call, modes: modeResults });

    // Progress
    const unified = modeResults.find((m) => m.name === "unified+rerank") || modeResults[modeResults.length - 1];
    const oldCount = call.originalResults.count;
    const newCount = unified.resultCount;
    const delta = newCount - oldCount;
    const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
    console.log(
      `  [${i + 1}/${calls.length}] ${call.tool.padEnd(15)} | ` +
      `old=${oldCount} new=${newCount} (${deltaStr}) | ` +
      `${unified.latencyMs.toFixed(0)}ms | ` +
      `q="${call.query.slice(0, 50)}"`
    );
  }

  return results;
}

// ============================================================================
// Task 4: Report findings
// ============================================================================

function reportFindings(results: ReplayResult[]) {
  console.log("\n" + "=".repeat(120));
  console.log("REAL-DATA BENCHMARK RESULTS");
  console.log("=".repeat(120));

  // Deduplicate by query (same query may appear multiple times)
  const seen = new Set<string>();
  const unique = results.filter((r) => {
    const key = `${r.call.tool}:${r.call.query}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\nTotal calls extracted: ${results.length} (${unique.length} unique queries)`);

  // Summary by tool
  const byTool = new Map<string, ReplayResult[]>();
  for (const r of unique) {
    const arr = byTool.get(r.call.tool) || [];
    arr.push(r);
    byTool.set(r.call.tool, arr);
  }

  for (const [tool, toolResults] of byTool) {
    console.log(`\n--- ${tool} (${toolResults.length} unique queries) ---`);

    const oldZero = toolResults.filter((r) => r.call.originalResults.count === 0);
    const oldError = toolResults.filter((r) => r.call.originalResults.error);

    console.log(`  Original 0-result queries: ${oldZero.length}${oldError.length > 0 ? ` (${oldError.length} errors)` : ""}`);

    // Per-mode stats
    for (const modeName of REPLAY_MODES.map((m) => m.name)) {
      const counts = toolResults.map(
        (r) => r.modes.find((m) => m.name === modeName)?.resultCount ?? 0,
      );
      const latencies = toolResults.map(
        (r) => r.modes.find((m) => m.name === modeName)?.latencyMs ?? 0,
      );
      const avgCount = counts.reduce((a, b) => a + b, 0) / counts.length;
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const zeroCount = counts.filter((c) => c === 0).length;
      console.log(
        `  ${modeName.padEnd(20)} avg_results=${avgCount.toFixed(1)} ` +
        `zero_results=${zeroCount} avg_latency=${avgLatency.toFixed(0)}ms`,
      );
    }
  }

  // Recovery analysis: queries that had 0 results before, now have results
  console.log("\n--- Recovery Analysis (old=0, new>0) ---");
  const recovered = unique.filter((r) => {
    const oldCount = r.call.originalResults.count;
    const unifiedCount = r.modes.find((m) => m.name === "unified+rerank")?.resultCount ?? 0;
    return oldCount === 0 && unifiedCount > 0;
  });

  if (recovered.length === 0) {
    console.log("  No zero-result queries were recovered (all original queries had results).");
  } else {
    for (const r of recovered) {
      const unified = r.modes.find((m) => m.name === "unified+rerank")!;
      console.log(
        `  RECOVERED: "${r.call.query.slice(0, 60)}" ` +
        `| old=${r.call.originalResults.count} new=${unified.resultCount} ` +
        `| score=${unified.topScore.toFixed(3)} ` +
        `| ${r.call.originalResults.error ? `was: ${r.call.originalResults.error}` : ""}`,
      );
    }
  }

  // Improvement analysis: unified returns more results
  console.log("\n--- Improvement Analysis ---");
  let improvedCount = 0;
  let worseCount = 0;
  let sameCount = 0;

  for (const r of unique) {
    const oldCount = r.call.originalResults.count;
    const unifiedCount = r.modes.find((m) => m.name === "unified+rerank")?.resultCount ?? 0;
    if (unifiedCount > oldCount) improvedCount++;
    else if (unifiedCount < oldCount) worseCount++;
    else sameCount++;
  }

  console.log(`  Improved (more results): ${improvedCount} / ${unique.length} (${((improvedCount / unique.length) * 100).toFixed(0)}%)`);
  console.log(`  Same: ${sameCount} / ${unique.length} (${((sameCount / unique.length) * 100).toFixed(0)}%)`);
  console.log(`  Fewer results: ${worseCount} / ${unique.length} (${((worseCount / unique.length) * 100).toFixed(0)}%)`);

  // Detailed comparison table
  console.log("\n--- Detailed Comparison ---");
  console.log(
    "Query".padEnd(55) + " | " +
    "Old Tool".padEnd(15) + " | " +
    "Old#".padEnd(5) + " | " +
    "recall".padEnd(8) + " | " +
    "search".padEnd(8) + " | " +
    "unified".padEnd(8) + " | " +
    "+rerank".padEnd(8) + " | " +
    "Delta",
  );
  console.log("-".repeat(120));

  for (const r of unique) {
    const q = r.call.query.slice(0, 53).padEnd(55);
    const tool = r.call.tool.padEnd(15);
    const old = String(r.call.originalResults.count).padEnd(5);

    const modeVals = REPLAY_MODES.map((m) => {
      const mr = r.modes.find((x) => x.name === m.name);
      return String(mr?.resultCount ?? 0).padEnd(8);
    });

    const unifiedCount = r.modes.find((m) => m.name === "unified+rerank")?.resultCount ?? 0;
    const delta = unifiedCount - r.call.originalResults.count;
    const deltaStr = delta > 0 ? `+${delta}` : delta === 0 ? "=" : `${delta}`;

    console.log(`${q} | ${tool} | ${old} | ${modeVals.join(" | ")} | ${deltaStr}`);
  }

  // Latency summary
  console.log("\n--- Latency Summary ---");
  for (const modeName of REPLAY_MODES.map((m) => m.name)) {
    const latencies = unique.map(
      (r) => r.modes.find((m) => m.name === modeName)?.latencyMs ?? 0,
    );
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)];
    const p95 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];
    console.log(`  ${modeName.padEnd(20)} avg=${avg.toFixed(0)}ms p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`);
  }

  return { unique, recovered, improvedCount, worseCount, sameCount };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { values: args } = parseArgs({
    options: {
      rebuild: { type: "boolean", default: false },
      "rebuild-docs": { type: "boolean", default: false },
    },
    strict: false,
  });

  const rebuild = !!args.rebuild;
  const rebuildDocs = !!args["rebuild-docs"];

  console.log("Real-Data Benchmark: Replay OpenClaw Memory Calls");
  console.log(`Mode: ${rebuild ? "--rebuild" : rebuildDocs ? "--rebuild-docs" : "production data"}`);

  // Step 1: Extract tool calls
  console.log("\n--- Extracting tool calls from transcripts ---");
  const allCalls = extractToolCalls();
  console.log(`Extracted ${allCalls.length} tool calls from session transcripts`);

  const searchCalls = allCalls.filter((c) => c.tool === "memory_search");
  const recallCalls = allCalls.filter((c) => c.tool === "memory_recall");
  console.log(`  memory_search: ${searchCalls.length}`);
  console.log(`  memory_recall: ${recallCalls.length}`);

  if (allCalls.length === 0) {
    console.log("No tool calls found. Exiting.");
    process.exit(0);
  }

  // Step 2: Set up pipeline
  const { embedder, lanceStore, qmdStore, retriever } = await setupPipeline(rebuild, rebuildDocs);

  // Step 3: Replay
  const results = await replayQueries(allCalls, retriever, embedder, qmdStore);

  // Step 4: Report
  const summary = reportFindings(results);

  // Cleanup
  qmdStore.close();

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
