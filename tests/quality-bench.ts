/**
 * Quality Benchmark Harness
 *
 * Measures indexing speed and retrieval quality (IR metrics) across pipeline modes.
 *
 * CLI:
 *   node --import jiti/register tests/quality-bench.ts [--dataset fiqa|nq|scifact|synthetic] [--max-queries 20]
 */

import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";

import { createEmbedder } from "../src/embedder.js";
import { MemoryStore } from "../src/store.js";
import { createRetriever } from "../src/retriever.js";
import { loadBeirDataset, type BeirDataset, type BeirDatasetName, BEIR_DATASETS } from "./helpers/beir-loader.js";
import { recallAtK, precisionAtK, mrr, ndcgAtK } from "./helpers/ir-metrics.js";

// ============================================================================
// Config
// ============================================================================

const EMBEDDING_BASE_URL = "http://100.122.104.26:8090/v1";
const EMBEDDING_MODEL = "Qwen3-Embedding-0.6B-Q8_0";
const EMBEDDING_DIMS = 1024;
const RERANKER_ENDPOINT = "http://100.122.104.26:8090/v1/rerank";
const RERANKER_MODEL = "bge-reranker-v2-m3-Q8_0";

// ============================================================================
// Pipeline Modes
// ============================================================================

interface PipelineMode {
  name: string;
  mode: "vector" | "hybrid";
  rerank: "cross-encoder" | "none";
  recencyBoost: boolean;
}

const PIPELINE_MODES: PipelineMode[] = [
  { name: "vector-only", mode: "vector", rerank: "none", recencyBoost: false },
  { name: "hybrid", mode: "hybrid", rerank: "none", recencyBoost: false },
  { name: "hybrid+rerank", mode: "hybrid", rerank: "cross-encoder", recencyBoost: false },
  { name: "hybrid+rerank+recency", mode: "hybrid", rerank: "cross-encoder", recencyBoost: true },
];

// ============================================================================
// Synthetic Dataset
// ============================================================================

interface SyntheticPair {
  query: string;
  answer: string;
  distractors: string[];
}

function generateSyntheticDataset(): BeirDataset {
  const pairs: SyntheticPair[] = [
    {
      query: "What programming language do we use for the backend?",
      answer: "The backend is written in TypeScript running on Node.js with the Express framework.",
      distractors: [
        "Python is used widely in data science and machine learning applications.",
        "Go is popular for building microservices due to its concurrency model.",
        "The frontend uses React with TypeScript for type safety.",
        "Database queries are written in SQL using PostgreSQL.",
        "Docker containers orchestrate the deployment pipeline.",
      ],
    },
    {
      query: "Where is the production database hosted?",
      answer: "The production PostgreSQL database is hosted on AWS RDS in us-east-1 with Multi-AZ failover.",
      distractors: [
        "Development databases run locally using Docker Compose.",
        "Redis is used as an in-memory cache layer for session data.",
        "MongoDB was evaluated but rejected due to consistency requirements.",
        "Database backups are stored in S3 with 30-day retention.",
        "The staging environment uses a smaller RDS instance in us-west-2.",
      ],
    },
    {
      query: "What is the preferred code formatting tool?",
      answer: "We use Prettier with a custom configuration for code formatting, enforced via pre-commit hooks.",
      distractors: [
        "ESLint handles code linting with the Airbnb style guide.",
        "TypeScript strict mode is enabled in tsconfig.json.",
        "Jest is configured as the primary testing framework.",
        "Husky manages Git hooks for the development workflow.",
        "VS Code is the recommended editor with shared settings.",
      ],
    },
    {
      query: "How do we handle authentication?",
      answer: "Authentication uses JWT tokens with RS256 signing, issued by our auth service with 15-minute expiry and refresh token rotation.",
      distractors: [
        "API rate limiting is configured at 100 requests per minute per user.",
        "CORS is configured to allow requests from specific frontend domains.",
        "The API gateway handles request routing and load balancing.",
        "SSL certificates are managed through AWS Certificate Manager.",
        "User sessions are stored in Redis with a 24-hour TTL.",
      ],
    },
    {
      query: "What is the deployment process?",
      answer: "Deployments are automated via GitHub Actions CI/CD, building Docker images pushed to ECR, then deploying to ECS Fargate with blue-green rollouts.",
      distractors: [
        "Feature branches are reviewed via pull requests requiring two approvals.",
        "Semantic versioning is used for all packages and services.",
        "Monitoring dashboards are built in Grafana with Prometheus metrics.",
        "Error tracking uses Sentry with source map uploads on each deploy.",
        "Infrastructure is defined as code using Terraform modules.",
      ],
    },
    {
      query: "What embedding model are we using?",
      answer: "We use Qwen3-Embedding-0.6B quantized to Q8 for embeddings, served via llama.cpp on the Mac Mini.",
      distractors: [
        "OpenAI's text-embedding-3-small produces 1536-dimensional vectors.",
        "BERT models are commonly used for text classification tasks.",
        "The reranker is a separate model from the embedding model.",
        "Vector similarity is computed using cosine distance in LanceDB.",
        "Sentence transformers provide multilingual embedding support.",
      ],
    },
    {
      query: "How are logs collected and analyzed?",
      answer: "Application logs are shipped via Fluent Bit to CloudWatch Logs, with structured JSON formatting and correlation IDs for tracing.",
      distractors: [
        "Metrics are collected using StatsD and forwarded to Datadog.",
        "Alerts are configured in PagerDuty with escalation policies.",
        "Health check endpoints return 200 OK with version and uptime info.",
        "Error rates above 1% trigger automatic rollback procedures.",
        "Performance budgets are enforced via Lighthouse CI checks.",
      ],
    },
    {
      query: "What testing framework do we use?",
      answer: "We use Node.js built-in test runner with the --test flag, loaded via jiti for TypeScript support without a build step.",
      distractors: [
        "Integration tests run against a local Docker environment.",
        "Code coverage is tracked using c8 with 80% threshold.",
        "End-to-end tests use Playwright for browser automation.",
        "Load testing is performed with k6 scripts targeting staging.",
        "Contract tests validate API compatibility between services.",
      ],
    },
    {
      query: "What is the user's preferred editor theme?",
      answer: "The user prefers a dark theme with the Catppuccin Mocha color scheme in VS Code.",
      distractors: [
        "Font size is set to 14px with JetBrains Mono as the font family.",
        "The minimap is disabled to save screen real estate.",
        "Auto-save is configured with a 1-second delay after changes.",
        "The terminal uses zsh with the Starship prompt theme.",
        "Extensions are synced via VS Code Settings Sync.",
      ],
    },
    {
      query: "How is the caching layer configured?",
      answer: "Redis 7 is used for caching with a 256MB max memory limit, LRU eviction policy, and sentinel-based failover for high availability.",
      distractors: [
        "CDN caching uses CloudFront with 24-hour TTL for static assets.",
        "Browser cache headers are set to max-age=3600 for API responses.",
        "Database query results are cached at the ORM level for 5 minutes.",
        "The embedding cache uses an in-memory LRU with 256 entries.",
        "DNS caching is handled by Route 53 with 60-second TTL.",
      ],
    },
    {
      query: "What is the branching strategy?",
      answer: "We follow trunk-based development with short-lived feature branches, squash merges to main, and release tags for production deployments.",
      distractors: [
        "Commits must be signed with GPG keys for verified authorship.",
        "Branch protection rules require CI to pass before merging.",
        "Dependabot checks for security vulnerabilities in dependencies.",
        "The changelog is auto-generated from conventional commit messages.",
        "Stale branches older than 30 days are automatically deleted.",
      ],
    },
    {
      query: "What monitoring tools are in use?",
      answer: "We use Grafana dashboards backed by Prometheus for metrics, with PagerDuty for alerting and Sentry for error tracking.",
      distractors: [
        "Uptime monitoring uses Pingdom with 1-minute check intervals.",
        "Synthetic tests run every 5 minutes from multiple regions.",
        "Log retention is set to 90 days for compliance requirements.",
        "AWS CloudTrail tracks all API calls for audit purposes.",
        "Network flow logs are stored in S3 for security analysis.",
      ],
    },
    {
      query: "What are the memory limits for the service?",
      answer: "The ECS task definition allocates 2GB RAM with a 512MB soft limit, and the Node.js process has --max-old-space-size=1536.",
      distractors: [
        "CPU allocation is 1 vCPU per container in the ECS task.",
        "Auto-scaling triggers at 70% CPU utilization average.",
        "Health checks run every 30 seconds with a 5-second timeout.",
        "Container logs are limited to 10MB with automatic rotation.",
        "The JVM services use -Xmx4g for heap allocation.",
      ],
    },
    {
      query: "How do we handle database migrations?",
      answer: "Database migrations use Prisma Migrate with version-controlled migration files, applied automatically during deployment via a pre-deploy hook.",
      distractors: [
        "Schema changes require a review from the DBA team.",
        "Rollback scripts are mandatory for every migration file.",
        "The test database is reset before each integration test suite.",
        "Data seeding scripts populate reference tables on fresh installs.",
        "Connection pooling uses PgBouncer with a pool size of 20.",
      ],
    },
    {
      query: "What API documentation standard is used?",
      answer: "APIs are documented using OpenAPI 3.1 specifications with Swagger UI served at /docs in non-production environments.",
      distractors: [
        "Internal documentation is maintained in Confluence wikis.",
        "Architecture Decision Records are stored in the docs/adr directory.",
        "Postman collections are shared via the team workspace.",
        "README files follow a standard template for all repositories.",
        "Code comments use JSDoc format for function documentation.",
      ],
    },
    {
      query: "What is the team's timezone convention?",
      answer: "All timestamps in the system use UTC, and team meetings are scheduled in US Eastern time with calendar invites auto-converting.",
      distractors: [
        "Sprint planning happens every two weeks on Monday mornings.",
        "Standups are asynchronous via Slack status updates.",
        "The on-call rotation follows a weekly schedule across timezones.",
        "Public holidays follow the US federal calendar.",
        "Core hours overlap between 10am-2pm ET for synchronous work.",
      ],
    },
    {
      query: "How are secrets managed?",
      answer: "Secrets are stored in AWS Secrets Manager and injected as environment variables at container startup, never committed to version control.",
      distractors: [
        "Environment configuration files use .env.example as templates.",
        "IAM roles follow the principle of least privilege for each service.",
        "Encryption at rest uses AWS KMS with customer-managed keys.",
        "API keys are rotated every 90 days via automated scripts.",
        "Service accounts use separate credentials from user accounts.",
      ],
    },
    {
      query: "What is the error handling strategy?",
      answer: "Errors use a typed hierarchy with ErrorCode enums, caught by a global Express middleware that maps them to HTTP status codes and structured JSON responses.",
      distractors: [
        "Retry logic uses exponential backoff with jitter for transient failures.",
        "Circuit breakers protect downstream service calls with Hystrix patterns.",
        "Dead letter queues capture failed message processing for later review.",
        "Graceful shutdown handlers drain connections before container stops.",
        "Timeout values are configured per-endpoint based on SLA requirements.",
      ],
    },
    {
      query: "What container registry do we use?",
      answer: "Docker images are pushed to Amazon ECR with image scanning enabled and lifecycle policies retaining the last 30 tagged images.",
      distractors: [
        "Base images use Alpine Linux for smaller container sizes.",
        "Multi-stage builds reduce the final image to under 200MB.",
        "Docker Compose is used for local development environments.",
        "Container vulnerability scanning runs in the CI pipeline.",
        "Image tags follow the format: git-sha-timestamp for traceability.",
      ],
    },
    {
      query: "What is the preferred communication channel?",
      answer: "Slack is the primary communication tool with dedicated channels per team, and important decisions are documented in Notion.",
      distractors: [
        "Email is used only for external communications with clients.",
        "Video calls use Google Meet with automatic recording enabled.",
        "Code reviews happen asynchronously via GitHub pull request comments.",
        "Incident communication uses a dedicated #incidents Slack channel.",
        "Weekly summaries are posted in the #engineering-updates channel.",
      ],
    },
  ];

  const corpus: BeirDataset["corpus"] = [];
  const queries: BeirDataset["queries"] = [];
  const qrels: BeirDataset["qrels"] = new Map();

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const queryId = `q${i}`;
    const answerId = `d${i}_0`;

    queries.push({ id: queryId, text: p.query });

    // Exact-match answer doc
    corpus.push({ id: answerId, title: "", text: p.answer });

    // Distractors
    for (let j = 0; j < p.distractors.length; j++) {
      corpus.push({ id: `d${i}_${j + 1}`, title: "", text: p.distractors[j] });
    }

    // Relevance: answer=2, distractors=0
    const docRels = new Map<string, number>();
    docRels.set(answerId, 2);
    qrels.set(queryId, docRels);
  }

  console.log(`[synthetic] generated ${queries.length} queries, ${corpus.length} docs`);
  return { name: "synthetic", queries, corpus, qrels };
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function parseCli(): { dataset: string; maxQueries: number; maxCorpus: number } {
  const { values } = parseArgs({
    options: {
      dataset: { type: "string", default: "synthetic" },
      "max-queries": { type: "string", default: "20" },
      "max-corpus": { type: "string", default: "1000" },
    },
    strict: false,
  });

  const dataset = (values.dataset as string) ?? "synthetic";
  const maxQueries = parseInt((values["max-queries"] as string) ?? "20", 10);
  const maxCorpus = parseInt((values["max-corpus"] as string) ?? "1000", 10);

  const validDatasets = ["fiqa", "nq", "scifact", "synthetic"];
  if (!validDatasets.includes(dataset)) {
    console.error(`Invalid dataset "${dataset}". Valid: ${validDatasets.join(", ")}`);
    process.exit(1);
  }

  return { dataset, maxQueries, maxCorpus };
}

// ============================================================================
// Indexing Phase
// ============================================================================

interface IndexingStats {
  totalDocs: number;
  totalTimeMs: number;
  perDocAvgMs: number;
  docsPerSec: number;
  memBefore: NodeJS.MemoryUsage;
  memAfter: NodeJS.MemoryUsage;
}

async function indexCorpus(
  store: MemoryStore,
  embedder: ReturnType<typeof createEmbedder>,
  corpus: BeirDataset["corpus"],
): Promise<{ stats: IndexingStats; storeIdToDocId: Map<string, string> }> {
  const storeIdToDocId = new Map<string, string>();
  const memBefore = process.memoryUsage();

  console.log(`\n[indexing] embedding and storing ${corpus.length} docs...`);
  const startAll = performance.now();

  // Embed one at a time with retry — llama.cpp router is fragile under batch load
  const allVectors: number[][] = [];

  for (let i = 0; i < corpus.length; i++) {
    const doc = corpus[i];
    const text = doc.title ? `${doc.title}. ${doc.text}` : doc.text;

    let vec: number[] | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        vec = await embedder.embedPassage(text);
        break;
      } catch (err: any) {
        console.warn(`  [indexing] doc ${i} attempt ${attempt + 1} failed: ${err.message?.slice(0, 80)}`);
        if (attempt < 4) await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
    if (!vec) throw new Error(`Failed to embed doc ${i} after 5 retries`);
    allVectors.push(vec);

    if ((i + 1) % 50 === 0 || i + 1 === corpus.length) {
      const pct = Math.round(((i + 1) / corpus.length) * 100);
      console.warn(`  [indexing] embedded ${i + 1}/${corpus.length} (${pct}%)`);
    }
  }

  // Store each doc
  for (let i = 0; i < corpus.length; i++) {
    const doc = corpus[i];
    const text = doc.title ? `${doc.title}. ${doc.text}` : doc.text;
    const storedEntry = await store.store({
      text,
      vector: allVectors[i],
      category: "fact",
      scope: "global",
      importance: 0.7,
      metadata: JSON.stringify({ docId: doc.id }),
    });
    storeIdToDocId.set(storedEntry.id, doc.id);
  }

  // Rebuild FTS index after bulk insert (LanceDB FTS is static at creation time)
  console.log("[indexing] rebuilding FTS index for BM25 search...");
  await store.rebuildFtsIndex();

  const totalTimeMs = performance.now() - startAll;
  const memAfter = process.memoryUsage();

  const stats: IndexingStats = {
    totalDocs: corpus.length,
    totalTimeMs,
    perDocAvgMs: totalTimeMs / corpus.length,
    docsPerSec: (corpus.length / totalTimeMs) * 1000,
    memBefore,
    memAfter,
  };

  console.log(`[indexing] done: ${corpus.length} docs in ${totalTimeMs.toFixed(0)}ms (${stats.docsPerSec.toFixed(1)} docs/sec)`);
  return { stats, storeIdToDocId };
}

// ============================================================================
// Retrieval Phase
// ============================================================================

interface MetricRow {
  pipeline: string;
  recall1: number;
  recall5: number;
  recall10: number;
  precision1: number;
  precision5: number;
  mrr: number;
  ndcg10: number;
  avgLatencyMs: number;
  queries: number;
}

async function evaluatePipeline(
  pipelineMode: PipelineMode,
  store: MemoryStore,
  embedder: ReturnType<typeof createEmbedder>,
  dataset: BeirDataset,
  storeIdToDocId: Map<string, string>,
): Promise<MetricRow> {
  const retriever = createRetriever(store, embedder, {
    mode: pipelineMode.mode,
    rerank: pipelineMode.rerank,
    rerankApiKey: "unused",
    rerankEndpoint: RERANKER_ENDPOINT,
    rerankModel: RERANKER_MODEL,
    rerankProvider: "jina",
    candidatePoolSize: 20,
    recencyHalfLifeDays: pipelineMode.recencyBoost ? 14 : 0,
    recencyWeight: pipelineMode.recencyBoost ? 0.1 : 0,
    hardMinScore: 0, // disable hard cutoff for fair metric evaluation
    filterNoise: false,
    minScore: 0,
  });

  const allRecall1: number[] = [];
  const allRecall5: number[] = [];
  const allRecall10: number[] = [];
  const allPrecision1: number[] = [];
  const allPrecision5: number[] = [];
  const allMrr: number[] = [];
  const allNdcg10: number[] = [];
  const latencies: number[] = [];

  for (let qi = 0; qi < dataset.queries.length; qi++) {
    const q = dataset.queries[qi];
    const qrelMap = dataset.qrels.get(q.id);
    if (!qrelMap || qrelMap.size === 0) continue;

    // Get relevant doc IDs for this query
    const relevantDocIds = Array.from(qrelMap.keys()).filter((docId) => (qrelMap.get(docId) ?? 0) > 0);
    if (relevantDocIds.length === 0) continue;

    const start = performance.now();
    const results = await retriever.retrieve({
      query: q.text,
      limit: 10,
      scopeFilter: ["global"],
    });
    latencies.push(performance.now() - start);

    // Map store IDs back to original doc IDs
    const resultDocIds = results.map((r) => {
      // Try metadata first
      if (r.entry.metadata) {
        try {
          const meta = JSON.parse(r.entry.metadata);
          if (meta.docId) return meta.docId as string;
        } catch {}
      }
      // Fall back to mapping
      return storeIdToDocId.get(r.entry.id) ?? r.entry.id;
    });

    allRecall1.push(recallAtK(relevantDocIds, resultDocIds, 1));
    allRecall5.push(recallAtK(relevantDocIds, resultDocIds, 5));
    allRecall10.push(recallAtK(relevantDocIds, resultDocIds, 10));
    allPrecision1.push(precisionAtK(relevantDocIds, resultDocIds, 1));
    allPrecision5.push(precisionAtK(relevantDocIds, resultDocIds, 5));
    allMrr.push(mrr(relevantDocIds, resultDocIds));
    allNdcg10.push(ndcgAtK(qrelMap, resultDocIds, 10));

    if ((qi + 1) % 5 === 0) {
      console.warn(`  [${pipelineMode.name}] ${qi + 1}/${dataset.queries.length} queries`);
    }
  }

  const avg = (arr: number[]) => (arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length);

  return {
    pipeline: pipelineMode.name,
    recall1: avg(allRecall1),
    recall5: avg(allRecall5),
    recall10: avg(allRecall10),
    precision1: avg(allPrecision1),
    precision5: avg(allPrecision5),
    mrr: avg(allMrr),
    ndcg10: avg(allNdcg10),
    avgLatencyMs: avg(latencies),
    queries: allMrr.length,
  };
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatIndexingTable(stats: IndexingStats): string {
  const memDeltaMB = ((stats.memAfter.rss - stats.memBefore.rss) / 1024 / 1024).toFixed(1);
  const heapMB = (stats.memAfter.heapUsed / 1024 / 1024).toFixed(1);

  return [
    "",
    "## Indexing Performance",
    "",
    "| Metric | Value |",
    "|---|---|",
    `| Total docs | ${stats.totalDocs} |`,
    `| Total time | ${stats.totalTimeMs.toFixed(0)}ms |`,
    `| Per-doc avg | ${stats.perDocAvgMs.toFixed(1)}ms |`,
    `| Throughput | ${stats.docsPerSec.toFixed(1)} docs/sec |`,
    `| RSS delta | ${memDeltaMB}MB |`,
    `| Heap used | ${heapMB}MB |`,
    "",
  ].join("\n");
}

function formatRetrievalTable(rows: MetricRow[]): string {
  const pct = (v: number) => (v * 100).toFixed(1);
  const lines = [
    "",
    "## Retrieval Quality",
    "",
    "| Pipeline | R@1 | R@5 | R@10 | P@1 | P@5 | MRR | nDCG@10 | Latency |",
    "|---|---|---|---|---|---|---|---|---|",
  ];

  for (const r of rows) {
    lines.push(
      `| ${r.pipeline} | ${pct(r.recall1)} | ${pct(r.recall5)} | ${pct(r.recall10)} | ${pct(r.precision1)} | ${pct(r.precision5)} | ${pct(r.mrr)} | ${pct(r.ndcg10)} | ${r.avgLatencyMs.toFixed(0)}ms |`
    );
  }

  lines.push("");
  return lines.join("\n");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const cli = parseCli();
  console.log(`\n=== Quality Benchmark ===`);
  console.log(`Dataset: ${cli.dataset}, Max queries: ${cli.maxQueries}\n`);

  // Load or generate dataset
  let dataset: BeirDataset;
  if (cli.dataset === "synthetic") {
    dataset = generateSyntheticDataset();
  } else {
    dataset = await loadBeirDataset(cli.dataset as BeirDatasetName, {
      maxQueries: cli.maxQueries,
      maxCorpus: cli.maxCorpus,
    });
  }

  // Limit queries
  if (dataset.queries.length > cli.maxQueries) {
    dataset.queries = dataset.queries.slice(0, cli.maxQueries);
  }

  // Create temp directory for LanceDB
  const tmpDir = await mkdtemp(join(tmpdir(), "quality-bench-"));
  console.log(`[setup] temp dir: ${tmpDir}`);

  try {
    // Create embedder
    const embedder = createEmbedder({
      provider: "openai-compatible",
      apiKey: "unused",
      model: EMBEDDING_MODEL,
      baseURL: EMBEDDING_BASE_URL,
      dimensions: EMBEDDING_DIMS,
    });

    // Create store
    const store = new MemoryStore({ dbPath: tmpDir, vectorDim: EMBEDDING_DIMS });

    // Indexing phase
    const { stats: indexStats, storeIdToDocId } = await indexCorpus(store, embedder, dataset.corpus);

    // Retrieval phase — run each pipeline mode
    const retrievalRows: MetricRow[] = [];
    for (const mode of PIPELINE_MODES) {
      console.log(`\n[retrieval] evaluating pipeline: ${mode.name}`);
      const row = await evaluatePipeline(mode, store, embedder, dataset, storeIdToDocId);
      retrievalRows.push(row);
      console.log(`  R@10=${(row.recall10 * 100).toFixed(1)}% MRR=${(row.mrr * 100).toFixed(1)}% nDCG@10=${(row.ndcg10 * 100).toFixed(1)}% latency=${row.avgLatencyMs.toFixed(0)}ms`);
    }

    // Output markdown
    const indexTable = formatIndexingTable(indexStats);
    const retrievalTable = formatRetrievalTable(retrievalRows);
    const output = [
      `# Quality Benchmark: ${dataset.name}`,
      ``,
      `- Date: ${new Date().toISOString()}`,
      `- Queries: ${dataset.queries.length}`,
      `- Corpus: ${dataset.corpus.length} docs`,
      `- Embedding: ${EMBEDDING_MODEL}`,
      `- Reranker: ${RERANKER_MODEL}`,
      indexTable,
      retrievalTable,
    ].join("\n");

    console.log("\n" + output);

    // Save JSON results
    const cacheDir = join(import.meta.dirname ?? ".", ".cache");
    await mkdir(cacheDir, { recursive: true });
    const jsonPath = join(cacheDir, `quality-bench-${dataset.name}-${Date.now()}.json`);
    const jsonData = {
      dataset: dataset.name,
      timestamp: new Date().toISOString(),
      config: {
        embeddingModel: EMBEDDING_MODEL,
        rerankerModel: RERANKER_MODEL,
        dimensions: EMBEDDING_DIMS,
        maxQueries: cli.maxQueries,
        corpusSize: dataset.corpus.length,
      },
      indexing: indexStats,
      retrieval: retrievalRows,
    };
    await writeFile(jsonPath, JSON.stringify(jsonData, null, 2));
    console.log(`\n[output] JSON saved to ${jsonPath}`);
  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    console.log(`[cleanup] removed ${tmpDir}`);
  }
}

main().catch((err) => {
  console.error("[quality-bench] fatal error:", err);
  process.exit(1);
});
