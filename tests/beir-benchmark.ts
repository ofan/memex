/**
 * BEIR document retrieval benchmark for memex.
 *
 * Uses standard BEIR datasets and the production document-search stack in
 * src/search.ts / src/doc-indexer.ts. This is the comparable document track
 * alongside LongMemEval's conversation-memory track.
 *
 * Usage:
 *   node --import jiti/register tests/beir-benchmark.ts
 *   BEIR_MODE=fts node --import jiti/register tests/beir-benchmark.ts
 *   BEIR_MODE=hybrid BEIR_DATASETS=fiqa,scifact node --import jiti/register tests/beir-benchmark.ts
 *
 * Environment:
 *   BEIR_MODE         — fts | hybrid | both (default: hybrid)
 *   BEIR_DATASETS     — comma-separated datasets (default: fiqa,scifact,nq)
 *   BEIR_MAX_QUERIES  — cap queries per dataset (default: 50)
 *   BEIR_MAX_CORPUS   — cap corpus size per dataset (default: 1000)
 *   BEIR_LIMIT        — retrieval depth / metric cutoff (default: 10)
 *   EMBED_BASE_URL    — embedding endpoint for hybrid mode
 *   EMBED_MODEL       — embedding model for hybrid mode
 *   EMBEDDING_DIMS    — vector dimensions (default: 2560)
 *   LLAMA_SWAP_API_KEY / RERANK_API_KEY / RERANK_ENDPOINT / RERANK_MODEL
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createStore, hashContent, hybridQuery } from "../src/search.ts";
import { embedDocuments } from "../src/doc-indexer.ts";
import { initializeLLM } from "../src/llm.ts";
import { BEIR_DATASETS, loadBeirDataset, type BeirDatasetName } from "./helpers/beir-loader.ts";
import { evaluateBeirQuery, summarizeBeirQueries, type BeirSummary } from "./helpers/beir-eval.ts";

type BenchmarkMode = "fts" | "hybrid" | "both";

const MODE = (process.env.BEIR_MODE || "hybrid") as BenchmarkMode;
const MAX_QUERIES = parseInt(process.env.BEIR_MAX_QUERIES || "50", 10);
const MAX_CORPUS = parseInt(process.env.BEIR_MAX_CORPUS || "1000", 10);
const LIMIT = parseInt(process.env.BEIR_LIMIT || "10", 10);
const EMBED_BASE_URL = process.env.EMBED_BASE_URL || "http://localhost:8090/v1";
const EMBED_MODEL = process.env.EMBED_MODEL || "Qwen3-Embedding-4B-Q8_0";
const EMBEDDING_DIMS = parseInt(process.env.EMBEDDING_DIMS || "2560", 10);
const EMBED_API_KEY = process.env.LLAMA_SWAP_API_KEY || "";
const RERANK_ENDPOINT = process.env.RERANK_ENDPOINT || process.env.EMBED_BASE_URL || "http://localhost:8090/v1/rerank";
const RERANK_MODEL = process.env.RERANK_MODEL || "bge-reranker-v2-m3-Q8_0";
const RERANK_API_KEY = process.env.RERANK_API_KEY || EMBED_API_KEY || "unused";

interface DatasetRunResult {
  dataset: BeirDatasetName;
  mode: Exclude<BenchmarkMode, "both">;
  summary: BeirSummary;
  elapsedMs: number;
  indexedDocs: number;
}

function parseDatasets(): BeirDatasetName[] {
  const raw = (process.env.BEIR_DATASETS || BEIR_DATASETS.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const unknown = raw.filter((name) => !BEIR_DATASETS.includes(name as BeirDatasetName));
  if (unknown.length > 0) {
    throw new Error(`Unknown BEIR dataset(s): ${unknown.join(", ")}. Supported: ${BEIR_DATASETS.join(", ")}`);
  }

  return raw as BeirDatasetName[];
}

function modesToRun(): Array<Exclude<BenchmarkMode, "both">> {
  if (MODE === "both") return ["fts", "hybrid"];
  return [MODE];
}

function ensureHybridConfigured(): void {
  initializeLLM({
    embedding: {
      baseURL: EMBED_BASE_URL,
      apiKey: EMBED_API_KEY || "unused",
      model: EMBED_MODEL,
      dimensions: EMBEDDING_DIMS,
    },
    reranker: {
      enabled: true,
      endpoint: RERANK_ENDPOINT,
      apiKey: RERANK_API_KEY,
      model: RERANK_MODEL,
    },
    queryExpansion: false,
  });
}

async function assertHybridBackendReady(): Promise<void> {
  const modelsUrl = `${EMBED_BASE_URL.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(modelsUrl, {
      signal: AbortSignal.timeout(5000),
      headers: EMBED_API_KEY && EMBED_API_KEY !== "unused"
        ? { Authorization: `Bearer ${EMBED_API_KEY}` }
        : undefined,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    throw new Error(
      `Hybrid mode requires a reachable embedding backend at ${modelsUrl}. ` +
      `Set EMBED_BASE_URL/EMBED_MODEL for this shell before running BEIR_MODE=hybrid. ` +
      `Cause: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function renderBeirDocument(id: string, title: string, text: string): string {
  const safeTitle = title.trim() || id;
  return `# ${safeTitle}\n\n${text.trim()}`;
}

function toStoredPath(docId: string): string {
  return `${docId}.md`;
}

function resultDocId(filepath: string): string {
  return filepath.replace(/^.*\//, "").replace(/\.md$/, "");
}

async function buildDatasetStore(dataset: Awaited<ReturnType<typeof loadBeirDataset>>, includeVectors: boolean) {
  const tmpDir = mkdtempSync(join(tmpdir(), `beir-${dataset.name}-`));
  const store = createStore(join(tmpDir, "beir.sqlite"));

  try {
    const now = new Date().toISOString();
    for (const doc of dataset.corpus) {
      const body = renderBeirDocument(doc.id, doc.title, doc.text);
      const hash = await hashContent(body);
      store.insertContent(hash, body, now);
      store.insertDocument(dataset.name, toStoredPath(doc.id), doc.title || doc.id, hash, now, now);
    }

    if (includeVectors) {
      store.ensureVecTable(EMBEDDING_DIMS);
      const embedResult = await embedDocuments(store.db, EMBEDDING_DIMS);
      if (embedResult.errors.length > 0) {
        throw new Error(`document embedding failed: ${embedResult.errors[0]}`);
      }
    }

    return { tmpDir, store };
  } catch (error) {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

async function runDataset(
  datasetName: BeirDatasetName,
  mode: Exclude<BenchmarkMode, "both">
): Promise<DatasetRunResult> {
  const dataset = await loadBeirDataset(datasetName, { maxQueries: MAX_QUERIES, maxCorpus: MAX_CORPUS });
  const includeVectors = mode === "hybrid";
  const { store, tmpDir } = await buildDatasetStore(dataset, includeVectors);

  const start = performance.now();
  try {
    const perQuery = [];

    for (const query of dataset.queries) {
      const qrels = dataset.qrels.get(query.id);
      if (!qrels) continue;

      const results = mode === "fts"
        ? store.searchFTS(query.text, LIMIT, dataset.name).map((result) => resultDocId(result.filepath))
        : (await hybridQuery(store, query.text, {
            collection: dataset.name,
            limit: LIMIT,
          })).map((result) => resultDocId(result.file));

      perQuery.push(evaluateBeirQuery(query.id, qrels, results, [1, 3, 5, 10]));
    }

    return {
      dataset: datasetName,
      mode,
      summary: summarizeBeirQueries(perQuery),
      elapsedMs: performance.now() - start,
      indexedDocs: dataset.corpus.length,
    };
  } finally {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatSummaryTable(results: DatasetRunResult[]): string {
  const header = "| Dataset | Mode | Queries | Docs | nDCG@10 | MRR | R@5 | R@10 | Time |";
  const sep = "|---|---|---:|---:|---:|---:|---:|---:|---:|";
  const rows = results.map((result) => {
    const { summary } = result;
    return `| ${result.dataset} | ${result.mode} | ${summary.queryCount} | ${result.indexedDocs} | ${formatPct(summary.ndcgAt10)} | ${formatPct(summary.mrr)} | ${formatPct(summary.recallAt[5] ?? 0)} | ${formatPct(summary.recallAt[10] ?? 0)} | ${(result.elapsedMs / 1000).toFixed(1)}s |`;
  });
  return [header, sep, ...rows].join("\n");
}

function formatMacroTable(results: DatasetRunResult[]): string {
  const groups = new Map<Exclude<BenchmarkMode, "both">, DatasetRunResult[]>();
  for (const result of results) {
    const list = groups.get(result.mode) ?? [];
    list.push(result);
    groups.set(result.mode, list);
  }

  const header = "| Mode | Datasets | Macro nDCG@10 | Macro MRR | Macro R@5 | Macro R@10 |";
  const sep = "|---|---:|---:|---:|---:|---:|";
  const rows = Array.from(groups.entries()).map(([mode, group]) => {
    const macro = summarizeBeirQueries(group.map((item) => ({
      queryId: item.dataset,
      mrr: item.summary.mrr,
      ndcgAt10: item.summary.ndcgAt10,
      recall: item.summary.recallAt,
    })));

    return `| ${mode} | ${group.length} | ${formatPct(macro.ndcgAt10)} | ${formatPct(macro.mrr)} | ${formatPct(macro.recallAt[5] ?? 0)} | ${formatPct(macro.recallAt[10] ?? 0)} |`;
  });

  return [header, sep, ...rows].join("\n");
}

async function main() {
  const datasets = parseDatasets();
  const modes = modesToRun();

  if (modes.includes("hybrid")) {
    ensureHybridConfigured();
    await assertHybridBackendReady();
  }

  console.log("=== memex BEIR Benchmark ===");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Datasets: ${datasets.join(", ")}`);
  console.log(`Mode: ${MODE}`);
  console.log(`Caps: queries=${MAX_QUERIES}, corpus=${MAX_CORPUS}, limit=${LIMIT}`);
  if (modes.includes("hybrid")) {
    console.log(`Hybrid config: ${EMBED_MODEL} @ ${EMBED_BASE_URL} (${EMBEDDING_DIMS}d)`);
  }
  console.log("");

  const results: DatasetRunResult[] = [];
  for (const mode of modes) {
    for (const dataset of datasets) {
      console.log(`[beir] running ${dataset} (${mode})`);
      results.push(await runDataset(dataset, mode));
    }
  }

  console.log("\nPer-dataset results\n");
  console.log(formatSummaryTable(results));
  console.log("\nMacro averages by mode\n");
  console.log(formatMacroTable(results));
}

main().catch((error) => {
  console.error("BEIR benchmark failed:", error);
  process.exit(1);
});
