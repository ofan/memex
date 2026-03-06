/**
 * Usage Simulation Benchmark
 *
 * Simulates realistic usage patterns to measure end-to-end performance:
 * 1. Day-in-the-life: morning stores, afternoon recalls, end-of-day maintenance
 * 2. Corpus growth: latency vs corpus size at checkpoints
 * 3. Document indexing: QMD indexing throughput at scale
 * 4. Concurrent patterns: interleaved store + recall under load
 *
 * Usage: node --import jiti/register tests/simulation-bench.ts [--scenario all|daily|growth|indexing|concurrent]
 */

import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { statSync } from "node:fs";

// ============================================================================
// Config
// ============================================================================

const EMBEDDING_BASE_URL = "http://100.122.104.26:8090/v1";
const EMBEDDING_MODEL = "Qwen3-Embedding-0.6B-Q8_0";
const EMBEDDING_DIMS = 1024;
const RERANKER_ENDPOINT = "http://100.122.104.26:8090/v1/rerank";
const RERANKER_MODEL = "bge-reranker-v2-m3-Q8_0";

// ============================================================================
// Imports
// ============================================================================

import { createEmbedder } from "../src/embedder.js";
import { MemoryStore } from "../src/store.js";
import { createRetriever } from "../src/retriever.js";
import { UnifiedRecall } from "../src/unified-recall.js";
import { isNoise } from "../src/noise-filter.js";
import { shouldSkipRetrieval } from "../src/adaptive-retrieval.js";

// ============================================================================
// Realistic conversation data
// ============================================================================

const MESSAGES = [
  "I prefer using dark mode in all my applications",
  "Let's deploy the new service to us-east-1",
  "The database connection string needs to be rotated every 90 days",
  "We use PostgreSQL 15 as our primary database",
  "Authentication is handled via OAuth2 with PKCE flow",
  "The API rate limit should be set to 500 requests per minute",
  "Frontend is built with React 19 and Next.js 15",
  "CI/CD runs on GitHub Actions with self-hosted runners",
  "Redis is used for session caching with a 30-minute TTL",
  "Docker images are built using multi-stage builds for smaller size",
  "Environment secrets are stored in AWS Secrets Manager",
  "The monitoring stack uses Prometheus, Grafana, and AlertManager",
  "Branching strategy is trunk-based development with feature flags",
  "Code reviews require at least two approvals before merging",
  "Error tracking is configured through Sentry with source maps",
  "My timezone is America/New_York for all scheduling",
  "We use structured JSON logging with correlation IDs",
  "Database migrations are managed with Prisma ORM",
  "The CDN is configured with CloudFront and 24-hour cache TTL",
  "Load testing is done with k6 targeting 99th percentile latency",
  "We follow semantic versioning for all published packages",
  "The message queue uses SQS with dead-letter queues enabled",
  "File uploads go to S3 with server-side encryption",
  "GraphQL API uses Apollo Server with data loader batching",
  "The search index is Elasticsearch 8 with custom analyzers",
];

const QUERIES = [
  "What database do we use?",
  "What's the deployment region?",
  "What authentication method do we use?",
  "What is the API rate limit?",
  "What frontend framework are we using?",
  "How do we handle CI/CD?",
  "What caching solution do we use?",
  "What's the monitoring setup?",
  "How do we handle database migrations?",
  "What's the branching strategy?",
];

// ============================================================================
// Helper functions
// ============================================================================

function memUsage(): { heapMB: number; rssMB: number } {
  const m = process.memoryUsage();
  return {
    heapMB: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
    rssMB: Math.round((m.rss / 1024 / 1024) * 10) / 10,
  };
}

function latencyStats(times: number[]): {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
} {
  if (times.length === 0) {
    return { avg: 0, p50: 0, p95: 0, p99: 0, min: 0, max: 0 };
  }
  const sorted = [...times].sort((a, b) => a - b);
  const avg = sorted.reduce((s, t) => s + t, 0) / sorted.length;
  const percentile = (p: number) => {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  };
  return {
    avg: Math.round(avg * 100) / 100,
    p50: Math.round(percentile(50) * 100) / 100,
    p95: Math.round(percentile(95) * 100) / 100,
    p99: Math.round(percentile(99) * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
  };
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

/** Generate a random conversation of N messages from MESSAGES pool */
function generateConversation(msgCount: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < msgCount; i++) {
    result.push(MESSAGES[Math.floor(Math.random() * MESSAGES.length)]);
  }
  return result;
}

/** Generate a synthetic markdown file with realistic structure */
function generateMarkdown(index: number): string {
  const topics = [
    "Authentication", "Database", "Deployment", "Monitoring", "Testing",
    "API Design", "Caching", "Security", "Performance", "Infrastructure",
  ];
  const topic = topics[index % topics.length];
  const topicLower = topic.toLowerCase();
  const topicUpper = topic.toUpperCase();
  const sections = [
    `## Overview\n\nThis document covers the ${topicLower} setup for our system. It includes configuration details, best practices, and troubleshooting steps.\n`,
    `## Configuration\n\nThe ${topicLower} module is configured via environment variables and a YAML config file. Default settings are optimized for production workloads.\n\n- Setting A: enabled by default\n- Setting B: 30-second timeout\n- Setting C: auto-scaling enabled\n`,
    `## Implementation\n\n\`\`\`typescript\nimport { create${topic}Client } from "@internal/${topicLower}";\n\nconst client = create${topic}Client({\n  endpoint: process.env.${topicUpper}_URL,\n  timeout: 30000,\n  retries: 3,\n  backoff: "exponential",\n});\n\nexport async function initialize(): Promise<void> {\n  await client.connect();\n  console.log("${topic} client initialized");\n}\n\nexport async function healthCheck(): Promise<boolean> {\n  try {\n    await client.ping();\n    return true;\n  } catch (err) {\n    console.error("${topic} health check failed:", err);\n    return false;\n  }\n}\n\`\`\`\n`,
  ];
  return `# ${topic} Guide (v${index})\n\n${sections.join("\n")}\n## Notes\n\nLast updated: 2025-01-15. Contact the platform team for questions.\n`;
}

// ============================================================================
// Pipeline setup (shared across scenarios)
// ============================================================================

async function createPipeline(tmpDir: string) {
  const embedder = createEmbedder({
    provider: "openai-compatible",
    apiKey: "unused",
    model: EMBEDDING_MODEL,
    baseURL: EMBEDDING_BASE_URL,
    dimensions: EMBEDDING_DIMS,
  });

  // Verify connection
  const connTest = await embedder.test();
  if (!connTest.success) {
    throw new Error(`Embedder connection failed: ${connTest.error}`);
  }

  const dbPath = join(tmpDir, "lancedb");
  const store = new MemoryStore({ dbPath, vectorDim: EMBEDDING_DIMS });

  const retriever = createRetriever(store, embedder, {
    mode: "hybrid",
    rerank: "cross-encoder",
    rerankApiKey: "unused",
    rerankEndpoint: RERANKER_ENDPOINT,
    rerankModel: RERANKER_MODEL,
    rerankProvider: "jina",
    candidatePoolSize: 20,
  });

  const unifiedRecall = new UnifiedRecall(retriever, embedder);

  return { embedder, store, retriever, unifiedRecall };
}

// ============================================================================
// Scenario 1: Day-in-the-life
// ============================================================================

async function scenarioDaily() {
  console.log("\n========================================");
  console.log("  Scenario 1: Day-in-the-life");
  console.log("========================================\n");

  const tmpDir = await mkdtemp(join(tmpdir(), "sim-daily-"));

  try {
    const { embedder, store, unifiedRecall } = await createPipeline(tmpDir);

    const storeTimes: number[] = [];
    const recallTimes: number[] = [];
    let storedCount = 0;
    let noiseSkipped = 0;
    let retrievalSkipped = 0;

    // --- Morning: 5 conversations (10-20 messages each) ---
    console.log("Morning: Processing 5 conversations...");
    for (let conv = 0; conv < 5; conv++) {
      const msgCount = 10 + Math.floor(Math.random() * 11); // 10-20
      const messages = generateConversation(msgCount);

      for (const msg of messages) {
        if (isNoise(msg)) {
          noiseSkipped++;
          continue;
        }

        const start = performance.now();
        const vec = await embedder.embedPassage(msg);
        await store.store({
          text: msg,
          vector: vec,
          category: (["preference", "fact", "decision", "entity", "other"] as const)[
            Math.floor(Math.random() * 5)
          ],
          scope: "global",
          importance: 0.5 + Math.random() * 0.5,
        });
        storeTimes.push(performance.now() - start);
        storedCount++;
      }
    }

    console.log(`  Stored ${storedCount} memories, skipped ${noiseSkipped} noise\n`);

    // --- Afternoon: 20 recall queries ---
    console.log("Afternoon: Running 20 recall queries...");
    for (let i = 0; i < 20; i++) {
      const query = QUERIES[i % QUERIES.length];

      if (shouldSkipRetrieval(query)) {
        retrievalSkipped++;
        continue;
      }

      const start = performance.now();
      await unifiedRecall.recall(query, { limit: 5 });
      recallTimes.push(performance.now() - start);
    }

    console.log(`  Completed ${recallTimes.length} recalls, skipped ${retrievalSkipped}\n`);

    // --- End of day: delete 2, update 1 ---
    console.log("End of day: Maintenance operations...");
    const allEntries = await store.list(["global"], undefined, 10);

    if (allEntries.length >= 3) {
      // Delete 2 entries
      await store.delete(allEntries[0].id);
      await store.delete(allEntries[1].id);
      console.log(`  Deleted 2 entries`);

      // Update 1 (delete + re-store with modified text)
      const toUpdate = allEntries[2];
      await store.delete(toUpdate.id);
      const updatedText = toUpdate.text + " [updated at end of day]";
      const vec = await embedder.embedPassage(updatedText);
      await store.store({
        text: updatedText,
        vector: vec,
        category: toUpdate.category,
        scope: toUpdate.scope,
        importance: toUpdate.importance,
      });
      console.log(`  Updated 1 entry`);
    }

    // --- Output ---
    const storeStats = latencyStats(storeTimes);
    const recallStats = latencyStats(recallTimes);
    const mem = memUsage();

    console.log("\n--- Day-in-the-life Results ---");
    console.log(`Store count: ${storedCount}`);
    console.log(`Noise skipped: ${noiseSkipped}`);
    console.log(`Retrieval skipped: ${retrievalSkipped}`);
    console.log(`\nStore latency:  avg=${fmtMs(storeStats.avg)}  p50=${fmtMs(storeStats.p50)}  p95=${fmtMs(storeStats.p95)}  min=${fmtMs(storeStats.min)}  max=${fmtMs(storeStats.max)}`);
    console.log(`Recall latency: avg=${fmtMs(recallStats.avg)}  p50=${fmtMs(recallStats.p50)}  p95=${fmtMs(recallStats.p95)}  min=${fmtMs(recallStats.min)}  max=${fmtMs(recallStats.max)}`);
    console.log(`Memory: heap=${mem.heapMB}MB  rss=${mem.rssMB}MB`);
    console.log(`Cache stats: ${JSON.stringify(embedder.cacheStats)}`);
  } finally {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ============================================================================
// Scenario 2: Corpus growth
// ============================================================================

async function scenarioGrowth() {
  console.log("\n========================================");
  console.log("  Scenario 2: Corpus Growth");
  console.log("========================================\n");

  const tmpDir = await mkdtemp(join(tmpdir(), "sim-growth-"));

  try {
    const { embedder, store, unifiedRecall } = await createPipeline(tmpDir);

    const checkpoints = [50, 200, 500, 1000, 2000];
    const results: Array<{
      size: number;
      avg: number;
      p50: number;
      p95: number;
      heapMB: number;
      rssMB: number;
    }> = [];

    let currentSize = 0;

    for (const checkpoint of checkpoints) {
      // Grow to checkpoint
      const toAdd = checkpoint - currentSize;
      console.log(`Growing corpus from ${currentSize} to ${checkpoint} (+${toAdd} entries)...`);

      for (let i = 0; i < toAdd; i++) {
        const text = MESSAGES[i % MESSAGES.length] + ` (instance ${currentSize + i})`;
        const vec = await embedder.embedPassage(text);
        await store.store({
          text,
          vector: vec,
          category: (["preference", "fact", "decision", "entity", "other"] as const)[i % 5],
          scope: "global",
          importance: 0.5 + Math.random() * 0.5,
        });
      }
      currentSize = checkpoint;

      // Run 10 recall queries and measure latency
      const times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const query = QUERIES[i % QUERIES.length];
        const start = performance.now();
        await unifiedRecall.recall(query, { limit: 5 });
        times.push(performance.now() - start);
      }

      const stats = latencyStats(times);
      const mem = memUsage();

      results.push({
        size: checkpoint,
        avg: stats.avg,
        p50: stats.p50,
        p95: stats.p95,
        heapMB: mem.heapMB,
        rssMB: mem.rssMB,
      });

      console.log(`  Checkpoint ${checkpoint}: avg=${fmtMs(stats.avg)} p50=${fmtMs(stats.p50)} p95=${fmtMs(stats.p95)} heap=${mem.heapMB}MB rss=${mem.rssMB}MB`);
    }

    // Print summary table
    console.log("\n--- Corpus Growth Results ---");
    console.log("| Corpus Size | Avg (ms) | P50 (ms) | P95 (ms) | Heap (MB) | RSS (MB) |");
    console.log("|---|---|---|---|---|---|");
    for (const r of results) {
      console.log(`| ${r.size} | ${r.avg} | ${r.p50} | ${r.p95} | ${r.heapMB} | ${r.rssMB} |`);
    }
  } finally {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ============================================================================
// Scenario 3: Document indexing
// ============================================================================

async function scenarioIndexing() {
  console.log("\n========================================");
  console.log("  Scenario 3: Document Indexing");
  console.log("========================================\n");

  const { indexPath } = await import("../src/doc-indexer.js");
  const { createStore: createQmdStore } = await import("../src/qmd/store.js");
  const { initializeQmdLLM } = await import("../src/qmd/llm.js");

  // Initialize QMD LLM with shared embedding config
  initializeQmdLLM({
    embedding: {
      baseURL: EMBEDDING_BASE_URL,
      apiKey: "unused",
      model: EMBEDDING_MODEL,
    },
  });

  const fileCounts = [30, 200, 500];
  const results: Array<{
    files: number;
    indexTimeMs: number;
    filesPerSec: number;
    indexSizeKB: number;
    reindexTimeMs: number;
  }> = [];

  for (const fileCount of fileCounts) {
    const tmpDir = await mkdtemp(join(tmpdir(), `sim-index-${fileCount}-`));

    try {
      // Generate synthetic markdown workspace
      const workspaceDir = join(tmpDir, "workspace");
      await mkdir(workspaceDir, { recursive: true });

      // Create subdirectories for realism
      const subdirs = ["docs", "guides", "api", "internal", "setup"];
      for (const sub of subdirs) {
        await mkdir(join(workspaceDir, sub), { recursive: true });
      }

      console.log(`Generating ${fileCount} markdown files...`);
      for (let i = 0; i < fileCount; i++) {
        const subdir = subdirs[i % subdirs.length];
        const content = generateMarkdown(i);
        await writeFile(join(workspaceDir, subdir, `doc-${i}.md`), content, "utf-8");
      }

      // Create QMD store
      const qmdDbDir = join(tmpDir, "qmd");
      await mkdir(qmdDbDir, { recursive: true });
      const qmdStore = createQmdStore(join(qmdDbDir, "qmd.sqlite"));

      // Index files
      console.log(`Indexing ${fileCount} files...`);
      const indexStart = performance.now();
      const indexResult = await indexPath(qmdStore.db, {
        path: workspaceDir,
        name: "bench-collection",
        pattern: "**/*.md",
      });
      const indexTimeMs = performance.now() - indexStart;

      // Measure index size on disk
      let indexSizeKB = 0;
      try {
        const dbStat = statSync(join(qmdDbDir, "qmd.sqlite"));
        indexSizeKB = Math.round(dbStat.size / 1024);
      } catch {
        // ignore
      }

      const filesPerSec = Math.round((fileCount / indexTimeMs) * 1000 * 10) / 10;

      console.log(`  Indexed: ${indexResult.indexed}, Updated: ${indexResult.updated}, Unchanged: ${indexResult.unchanged}, Errors: ${indexResult.errors.length}`);
      console.log(`  Time: ${fmtMs(indexTimeMs)}, Throughput: ${filesPerSec} files/sec, DB size: ${indexSizeKB}KB`);

      // Incremental re-index (no changes)
      console.log(`  Re-indexing (no changes)...`);
      const reindexStart = performance.now();
      const reindexResult = await indexPath(qmdStore.db, {
        path: workspaceDir,
        name: "bench-collection",
        pattern: "**/*.md",
      });
      const reindexTimeMs = performance.now() - reindexStart;
      console.log(`  Re-index: unchanged=${reindexResult.unchanged}, time=${fmtMs(reindexTimeMs)}`);

      results.push({
        files: fileCount,
        indexTimeMs: Math.round(indexTimeMs),
        filesPerSec,
        indexSizeKB,
        reindexTimeMs: Math.round(reindexTimeMs),
      });

      qmdStore.close();
    } finally {
      await rm(tmpDir, { recursive: true }).catch(() => {});
    }
  }

  // Print summary table
  console.log("\n--- Document Indexing Results ---");
  console.log("| Files | Index Time (ms) | Files/sec | DB Size (KB) | Re-index (ms) |");
  console.log("|---|---|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.files} | ${r.indexTimeMs} | ${r.filesPerSec} | ${r.indexSizeKB} | ${r.reindexTimeMs} |`);
  }
}

// ============================================================================
// Scenario 4: Concurrent patterns
// ============================================================================

async function scenarioConcurrent() {
  console.log("\n========================================");
  console.log("  Scenario 4: Concurrent Patterns");
  console.log("========================================\n");

  const tmpDir = await mkdtemp(join(tmpdir(), "sim-concurrent-"));

  try {
    const { embedder, store, unifiedRecall } = await createPipeline(tmpDir);

    // Seed 200 memories
    console.log("Seeding 200 memories...");
    for (let i = 0; i < 200; i++) {
      const text = MESSAGES[i % MESSAGES.length] + ` (seed ${i})`;
      const vec = await embedder.embedPassage(text);
      await store.store({
        text,
        vector: vec,
        category: (["preference", "fact", "decision", "entity", "other"] as const)[i % 5],
        scope: "global",
        importance: 0.5 + Math.random() * 0.5,
      });
    }
    console.log("Seeded 200 memories.\n");

    // 50 cycles of interleaved store + recall
    console.log("Running 50 interleaved store+recall cycles...");
    const storeTimes: number[] = [];
    const recallTimes: number[] = [];

    for (let cycle = 0; cycle < 50; cycle++) {
      // Store 1
      const storeText = MESSAGES[cycle % MESSAGES.length] + ` (cycle ${cycle})`;
      const storeStart = performance.now();
      const vec = await embedder.embedPassage(storeText);
      await store.store({
        text: storeText,
        vector: vec,
        category: (["preference", "fact", "decision", "entity", "other"] as const)[cycle % 5],
        scope: "global",
        importance: 0.5 + Math.random() * 0.5,
      });
      storeTimes.push(performance.now() - storeStart);

      // Recall 1
      const query = QUERIES[cycle % QUERIES.length];
      const recallStart = performance.now();
      await unifiedRecall.recall(query, { limit: 5 });
      recallTimes.push(performance.now() - recallStart);
    }

    const storeStats = latencyStats(storeTimes);
    const recallStats = latencyStats(recallTimes);
    const mem = memUsage();

    console.log("\n--- Concurrent Patterns Results ---");
    console.log(`Store latency (under load):  avg=${fmtMs(storeStats.avg)}  p50=${fmtMs(storeStats.p50)}  p95=${fmtMs(storeStats.p95)}  p99=${fmtMs(storeStats.p99)}  min=${fmtMs(storeStats.min)}  max=${fmtMs(storeStats.max)}`);
    console.log(`Recall latency (under load): avg=${fmtMs(recallStats.avg)}  p50=${fmtMs(recallStats.p50)}  p95=${fmtMs(recallStats.p95)}  p99=${fmtMs(recallStats.p99)}  min=${fmtMs(recallStats.min)}  max=${fmtMs(recallStats.max)}`);
    console.log(`Final corpus size: 250 (200 seed + 50 added)`);
    console.log(`Memory: heap=${mem.heapMB}MB  rss=${mem.rssMB}MB`);
    console.log(`Cache stats: ${JSON.stringify(embedder.cacheStats)}`);
  } finally {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: {
        type: "string",
        short: "s",
        default: "all",
      },
    },
    strict: true,
  });

  const scenario = values.scenario || "all";
  const validScenarios = ["all", "daily", "growth", "indexing", "concurrent"];
  if (!validScenarios.includes(scenario)) {
    console.error(`Invalid scenario: ${scenario}. Valid: ${validScenarios.join(", ")}`);
    process.exit(1);
  }

  console.log("=== memory-unified Usage Simulation Benchmark ===");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Node: ${process.version}`);
  console.log(`Scenario: ${scenario}`);
  const startMem = memUsage();
  console.log(`Memory at start: heap=${startMem.heapMB}MB  rss=${startMem.rssMB}MB`);

  const overallStart = performance.now();

  if (scenario === "all" || scenario === "daily") {
    await scenarioDaily();
  }
  if (scenario === "all" || scenario === "growth") {
    await scenarioGrowth();
  }
  if (scenario === "all" || scenario === "indexing") {
    await scenarioIndexing();
  }
  if (scenario === "all" || scenario === "concurrent") {
    await scenarioConcurrent();
  }

  const elapsed = performance.now() - overallStart;
  const endMem = memUsage();
  console.log(`\n=== Simulation complete in ${(elapsed / 1000).toFixed(1)}s ===`);
  console.log(`Memory: heap=${endMem.heapMB}MB (delta +${(endMem.heapMB - startMem.heapMB).toFixed(1)}MB)  rss=${endMem.rssMB}MB (delta +${(endMem.rssMB - startMem.rssMB).toFixed(1)}MB)`);
}

main().catch((err) => {
  console.error("Simulation benchmark failed:", err);
  process.exit(1);
});
