/**
 * Benchmark Suite for memory-unified
 *
 * Measures latency, memory usage, and throughput for key operations:
 * 1. Embedding (single + batch)
 * 2. Reranking
 * 3. LanceDB store/search/BM25
 * 4. Unified recall pipeline
 * 5. Adaptive retrieval decision
 *
 * Usage: node --import jiti/register tests/benchmark.ts
 */

import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// ============================================================================
// Config
// ============================================================================

const EMBEDDING_BASE_URL = "http://100.122.104.26:8090/v1";
const EMBEDDING_MODEL = "Qwen3-Embedding-0.6B-Q8_0";
const EMBEDDING_DIMS = 1024;
const RERANKER_ENDPOINT = "http://100.122.104.26:8090/v1/rerank";
const RERANKER_MODEL = "bge-reranker-v2-m3-Q8_0";

// ============================================================================
// Helpers
// ============================================================================

interface BenchResult {
  name: string;
  runs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  cpuUserMs: number;
  cpuSystemMs: number;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function bench(name: string, fn: () => Promise<void>, runs = 10, warmup = 2): Promise<BenchResult> {
  for (let i = 0; i < warmup; i++) await fn();

  const times: number[] = [];
  const cpuBefore = process.cpuUsage();
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  const cpuAfter = process.cpuUsage(cpuBefore);

  times.sort((a, b) => a - b);
  const avg = times.reduce((s, t) => s + t, 0) / times.length;

  return {
    name,
    runs,
    avgMs: Math.round(avg * 100) / 100,
    minMs: Math.round(times[0] * 100) / 100,
    maxMs: Math.round(times[times.length - 1] * 100) / 100,
    p50Ms: Math.round(percentile(times, 50) * 100) / 100,
    p95Ms: Math.round(percentile(times, 95) * 100) / 100,
    p99Ms: Math.round(percentile(times, 99) * 100) / 100,
    cpuUserMs: Math.round(cpuAfter.user / 1000 * 100) / 100,
    cpuSystemMs: Math.round(cpuAfter.system / 1000 * 100) / 100,
  };
}

function formatTable(results: BenchResult[]): string {
  const header = "| Benchmark | Runs | Avg (ms) | Min (ms) | P50 (ms) | P95 (ms) | Max (ms) | CPU user (ms) | CPU sys (ms) |";
  const sep = "|---|---|---|---|---|---|---|---|---|";
  const rows = results.map(
    (r) => `| ${r.name} | ${r.runs} | ${r.avgMs} | ${r.minMs} | ${r.p50Ms} | ${r.p95Ms} | ${r.maxMs} | ${r.cpuUserMs} | ${r.cpuSystemMs} |`
  );
  return [header, sep, ...rows].join("\n");
}

function formatCpuSummary(results: BenchResult[]): string {
  const totalUser = results.reduce((s, r) => s + r.cpuUserMs, 0);
  const totalSystem = results.reduce((s, r) => s + r.cpuSystemMs, 0);
  const totalWall = results.reduce((s, r) => s + r.avgMs * r.runs, 0);
  const cpuEfficiency = totalWall > 0 ? ((totalUser + totalSystem) / totalWall * 100).toFixed(1) : "N/A";
  return [
    `CPU Summary:`,
    `  User:   ${totalUser.toFixed(1)}ms`,
    `  System: ${totalSystem.toFixed(1)}ms`,
    `  Total:  ${(totalUser + totalSystem).toFixed(1)}ms`,
    `  Wall:   ${totalWall.toFixed(1)}ms`,
    `  Efficiency: ${cpuEfficiency}% (CPU/wall — low = I/O bound, high = compute bound)`,
  ].join("\n");
}

function memUsage(): { heapMB: number; rssMB: number } {
  const m = process.memoryUsage();
  return {
    heapMB: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
    rssMB: Math.round((m.rss / 1024 / 1024) * 10) / 10,
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("=== memory-unified Benchmark Suite ===\n");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Node: ${process.version}`);
  const startMem = memUsage();
  console.log(`Memory at start: heap=${startMem.heapMB}MB rss=${startMem.rssMB}MB\n`);

  const results: BenchResult[] = [];

  // ------------------------------------------------------------------
  // 1. Embedder benchmarks
  // ------------------------------------------------------------------
  console.log("--- Embedder ---");

  const { createEmbedder } = await import("../src/embedder.js");
  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: "unused",
    model: EMBEDDING_MODEL,
    baseURL: EMBEDDING_BASE_URL,
    dimensions: EMBEDDING_DIMS,
  });

  const connTest = await embedder.test();
  if (!connTest.success) {
    console.error(`Embedder connection failed: ${connTest.error}`);
    process.exit(1);
  }
  console.log(`Connected to ${EMBEDDING_BASE_URL} (${EMBEDDING_MODEL}, ${connTest.dimensions}d)`);

  results.push(
    await bench("embed-short (query)", async () => {
      await embedder.embedQuery("What is dark mode preference?");
    }, 20, 3)
  );

  results.push(
    await bench("embed-medium (passage, ~200 chars)", async () => {
      await embedder.embedPassage(
        "The user prefers dark mode across all applications. They have mentioned this preference multiple times in conversations about IDE settings, browser themes, and system preferences. This should be remembered as a strong preference."
      );
    }, 20, 3)
  );

  results.push(
    await bench("embed-batch (5 texts)", async () => {
      await embedder.embedBatchPassage([
        "User prefers dark mode",
        "Project uses PostgreSQL database",
        "Deploy to AWS us-east-1",
        "TypeScript strict mode enabled",
        "Use pnpm for package management",
      ]);
    }, 10, 2)
  );

  // Cache hit benchmark
  await embedder.embedQuery("cached query test");
  results.push(
    await bench("embed-cache-hit", async () => {
      await embedder.embedQuery("cached query test");
    }, 100, 0)
  );

  console.log(`Embedder cache: ${JSON.stringify(embedder.cacheStats)}\n`);

  // ------------------------------------------------------------------
  // 2. Reranker benchmark
  // ------------------------------------------------------------------
  console.log("--- Reranker ---");

  results.push(
    await bench("rerank (5 docs)", async () => {
      const resp = await fetch(RERANKER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer unused" },
        body: JSON.stringify({
          model: RERANKER_MODEL,
          query: "dark mode preference",
          documents: [
            "User prefers dark mode in all applications",
            "The database is PostgreSQL version 15",
            "Deploy infrastructure to AWS us-east-1 region",
            "TypeScript strict mode is enabled in tsconfig",
            "Dark theme settings for the IDE and browser",
          ],
        }),
      });
      if (!resp.ok) throw new Error(`Rerank failed: ${resp.status}`);
      await resp.json();
    }, 15, 3)
  );

  results.push(
    await bench("rerank (10 docs)", async () => {
      const resp = await fetch(RERANKER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer unused" },
        body: JSON.stringify({
          model: RERANKER_MODEL,
          query: "database configuration and deployment",
          documents: Array.from({ length: 10 }, (_, i) =>
            `Document ${i}: This is sample document content about various topics including databases, deployment, configuration, and system settings. Each document has different relevance levels.`
          ),
        }),
      });
      if (!resp.ok) throw new Error(`Rerank failed: ${resp.status}`);
      await resp.json();
    }, 10, 2)
  );

  // ------------------------------------------------------------------
  // 3. LanceDB store benchmarks
  // ------------------------------------------------------------------
  console.log("--- LanceDB Store ---");

  const tmpDir = await mkdtemp(join(tmpdir(), "bench-lancedb-"));
  const { MemoryStore } = await import("../src/store.js");
  const store = new MemoryStore({ dbPath: tmpDir, vectorDim: EMBEDDING_DIMS });

  results.push(
    await bench("store-entry", async () => {
      const vec = await embedder.embedPassage(`Test memory entry ${Math.random()}`);
      await store.store({
        text: `User preference #${Math.random().toString(36).slice(2)}`,
        vector: vec,
        category: "preference",
        scope: "global",
        importance: 0.7,
      });
    }, 20, 3)
  );

  // Seed data for search benchmarks
  console.log("Seeding 50 entries for search benchmarks...");
  const seedTexts = [
    "User prefers dark mode in all applications",
    "Project uses PostgreSQL 15 for primary database",
    "Deploy to AWS us-east-1 region",
    "TypeScript strict mode enabled in tsconfig",
    "Use pnpm for package management",
    "API rate limit is 100 requests per minute",
    "Authentication uses JWT tokens with RS256",
    "Frontend uses React 19 with Next.js",
    "CI/CD pipeline runs on GitHub Actions",
    "Logging uses structured JSON format",
    "Redis is used for session caching",
    "Docker images built with multi-stage builds",
    "Environment variables stored in AWS Secrets Manager",
    "GraphQL API with Apollo Server",
    "Database migrations handled by Prisma",
    "Error tracking via Sentry",
    "User timezone is America/New_York",
    "Preferred code style is functional",
    "Testing framework is Vitest",
    "Git branching strategy is trunk-based",
    "Monitoring with Prometheus and Grafana",
    "CDN is CloudFront",
    "Search engine is Elasticsearch",
    "Message queue is SQS",
    "File storage on S3",
  ];

  for (let i = 0; i < 50; i++) {
    const text = seedTexts[i % seedTexts.length] + ` (variant ${i})`;
    const vec = await embedder.embedPassage(text);
    await store.store({
      text,
      vector: vec,
      category: (["preference", "fact", "decision", "entity", "other"] as const)[i % 5],
      scope: "global",
      importance: 0.5 + Math.random() * 0.5,
    });
  }
  console.log("Seeded 50 entries.");

  results.push(
    await bench("vector-search (top-5)", async () => {
      const queryVec = await embedder.embedQuery("dark mode preferences");
      await store.vectorSearch(queryVec, 5, 0.1, ["global"]);
    }, 15, 3)
  );

  if (store.hasFtsSupport) {
    results.push(
      await bench("bm25-search (top-5)", async () => {
        await store.bm25Search("database PostgreSQL", 5, ["global"]);
      }, 15, 3)
    );
  }

  // ------------------------------------------------------------------
  // 4. Retriever pipeline benchmark
  // ------------------------------------------------------------------
  console.log("--- Retriever Pipeline ---");

  const { createRetriever } = await import("../src/retriever.js");
  const retriever = createRetriever(store, embedder, {
    mode: "hybrid",
    rerank: "cross-encoder",
    rerankApiKey: "unused",
    rerankEndpoint: RERANKER_ENDPOINT,
    rerankModel: RERANKER_MODEL,
    rerankProvider: "jina",
    candidatePoolSize: 20,
  });

  results.push(
    await bench("retriever-hybrid+rerank (top-5)", async () => {
      await retriever.retrieve({
        query: "What database do we use?",
        limit: 5,
        scopeFilter: ["global"],
      });
    }, 10, 2)
  );

  const retrieverVec = createRetriever(store, embedder, {
    mode: "vector",
    rerank: "none",
  });

  results.push(
    await bench("retriever-vector-only (top-5)", async () => {
      await retrieverVec.retrieve({
        query: "What database do we use?",
        limit: 5,
        scopeFilter: ["global"],
      });
    }, 10, 2)
  );

  // ------------------------------------------------------------------
  // 5. Unified Recall benchmark
  // ------------------------------------------------------------------
  console.log("--- Unified Recall ---");

  const { UnifiedRecall } = await import("../src/unified-recall.js");
  const unifiedRecall = new UnifiedRecall(retriever, embedder);

  results.push(
    await bench("unified-recall-conv-only (top-5)", async () => {
      await unifiedRecall.recall("dark mode preferences", { limit: 5 });
    }, 10, 2)
  );

  // ------------------------------------------------------------------
  // 6. Adaptive retrieval benchmark
  // ------------------------------------------------------------------
  console.log("--- Adaptive Retrieval ---");

  const { shouldSkipRetrieval } = await import("../src/adaptive-retrieval.js");

  results.push(
    await bench("adaptive-skip-check (1000 calls)", async () => {
      const queries = [
        "hello", "npm install", "yes", "HEARTBEAT", "/help",
        "What database are we using?", "remember my name is John",
        "Add authentication to the API", "go ahead", "thanks",
      ];
      for (let i = 0; i < 1000; i++) {
        shouldSkipRetrieval(queries[i % queries.length]);
      }
    }, 5, 1)
  );

  // ------------------------------------------------------------------
  // Print results
  // ------------------------------------------------------------------
  console.log("\n=== Results ===\n");
  console.log(formatTable(results));

  const endMem = memUsage();
  console.log(`\nMemory: heap=${endMem.heapMB}MB (delta +${(endMem.heapMB - startMem.heapMB).toFixed(1)}MB), rss=${endMem.rssMB}MB (delta +${(endMem.rssMB - startMem.rssMB).toFixed(1)}MB)`);
  console.log(`\n${formatCpuSummary(results)}`);

  // Cleanup
  await rm(tmpDir, { recursive: true }).catch(() => {});
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
