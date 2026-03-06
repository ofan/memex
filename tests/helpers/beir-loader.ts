/**
 * BEIR Dataset Loader
 *
 * Downloads and parses BEIR benchmark datasets from HuggingFace.
 * Caches files locally in tests/.cache/beir/<dataset>/.
 *
 * HuggingFace layout:
 *   - BeIR/<name>  → corpus.jsonl.gz, queries.jsonl.gz
 *   - BeIR/<name>-qrels → test.tsv
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, dirname } from "node:path";

export const BEIR_DATASETS = ["fiqa", "nq", "scifact"] as const;
export type BeirDatasetName = (typeof BEIR_DATASETS)[number];

export interface BeirQuery {
  id: string;
  text: string;
}

export interface BeirDoc {
  id: string;
  title: string;
  text: string;
}

/** Map<queryId, Map<docId, relevanceGrade>> */
export type BeirQrels = Map<string, Map<string, number>>;

export interface BeirDataset {
  name: string;
  queries: BeirQuery[];
  corpus: BeirDoc[];
  qrels: BeirQrels;
}

const HF_BASE = "https://huggingface.co/datasets/BeIR";
const DEFAULT_CACHE_DIR = join(dirname(dirname(import.meta.url.replace("file://", ""))), ".cache", "beir");

function datasetUrls(name: BeirDatasetName) {
  return {
    corpus: `${HF_BASE}/${name}/resolve/main/corpus.jsonl.gz`,
    queries: `${HF_BASE}/${name}/resolve/main/queries.jsonl.gz`,
    qrels: `${HF_BASE}/${name}-qrels/resolve/main/test.tsv`,
  };
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  console.warn(`[beir-loader] downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });

  const body = res.body;
  if (!body) throw new Error(`No response body for ${url}`);

  const nodeStream = Readable.fromWeb(body as any);
  const fileStream = createWriteStream(destPath);
  await pipeline(nodeStream, fileStream);
  console.warn(`[beir-loader] saved ${destPath}`);
}

async function ensureCached(url: string, cachePath: string): Promise<string> {
  if (!existsSync(cachePath)) {
    await downloadFile(url, cachePath);
  }
  return cachePath;
}

function decompressGzToJsonl(gzPath: string): string {
  // Decompress .gz to .jsonl if not already done
  const jsonlPath = gzPath.replace(/\.gz$/, "");
  if (existsSync(jsonlPath)) return jsonlPath;
  return gzPath; // will decompress on read
}

async function decompressIfNeeded(gzPath: string): Promise<string> {
  const jsonlPath = gzPath.replace(/\.gz$/, "");
  if (existsSync(jsonlPath)) return jsonlPath;

  console.warn(`[beir-loader] decompressing ${gzPath}`);
  const input = Readable.from(readFileSync(gzPath));
  const gunzip = createGunzip();
  const output = createWriteStream(jsonlPath);
  await pipeline(input, gunzip, output);
  return jsonlPath;
}

function parseJsonl<T>(filePath: string, maxItems?: number): T[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const limit = maxItems ?? lines.length;
  const results: T[] = [];
  for (let i = 0; i < Math.min(lines.length, limit); i++) {
    results.push(JSON.parse(lines[i]));
  }
  return results;
}

function parseQrels(filePath: string): BeirQrels {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  const qrels: BeirQrels = new Map();

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split("\t");
    if (parts.length < 3) continue;
    const [queryId, corpusId, score] = parts;
    if (!qrels.has(queryId)) {
      qrels.set(queryId, new Map());
    }
    qrels.get(queryId)!.set(corpusId, parseInt(score, 10));
  }
  return qrels;
}

export async function loadBeirDataset(
  name: BeirDatasetName,
  opts?: { maxQueries?: number; maxCorpus?: number; cacheDir?: string }
): Promise<BeirDataset> {
  const cacheDir = opts?.cacheDir ?? DEFAULT_CACHE_DIR;
  const datasetDir = join(cacheDir, name);
  const urls = datasetUrls(name);

  // Download all files in parallel
  const [corpusGzPath, queriesGzPath, qrelsPath] = await Promise.all([
    ensureCached(urls.corpus, join(datasetDir, "corpus.jsonl.gz")),
    ensureCached(urls.queries, join(datasetDir, "queries.jsonl.gz")),
    ensureCached(urls.qrels, join(datasetDir, "test.tsv")),
  ]);

  // Decompress gzipped files
  const [corpusPath, queriesPath] = await Promise.all([
    decompressIfNeeded(corpusGzPath),
    decompressIfNeeded(queriesGzPath),
  ]);

  // Parse qrels first so we can filter queries
  const qrels = parseQrels(qrelsPath);

  // Parse queries, filtering to only those with relevance judgments
  const rawQueries = parseJsonl<{ _id: string; text: string }>(queriesPath);
  let queries: BeirQuery[] = rawQueries
    .filter((q) => qrels.has(q._id))
    .map((q) => ({ id: q._id, text: q.text }));

  if (opts?.maxQueries) {
    queries = queries.slice(0, opts.maxQueries);
  }

  // Collect all relevant doc IDs for selected queries
  const relevantDocIds = new Set<string>();
  for (const q of queries) {
    const rels = qrels.get(q.id);
    if (rels) {
      for (const [docId, score] of rels) {
        if (score > 0) relevantDocIds.add(docId);
      }
    }
  }

  // Parse full corpus, then select: all relevant docs + random fill to maxCorpus
  const allCorpus = parseJsonl<{ _id: string; title: string; text: string }>(corpusPath);
  const relevantDocs: BeirDoc[] = [];
  const otherDocs: BeirDoc[] = [];

  for (const d of allCorpus) {
    const doc: BeirDoc = { id: d._id, title: d.title ?? "", text: d.text };
    if (relevantDocIds.has(d._id)) {
      relevantDocs.push(doc);
    } else {
      otherDocs.push(doc);
    }
  }

  // Fill remaining slots with non-relevant docs (distractors)
  const maxCorpus = opts?.maxCorpus ?? allCorpus.length;
  const fillCount = Math.max(0, maxCorpus - relevantDocs.length);
  const corpus: BeirDoc[] = [...relevantDocs, ...otherDocs.slice(0, fillCount)];

  console.warn(
    `[beir-loader] loaded ${name}: ${queries.length} queries, ${corpus.length} docs (${relevantDocs.length} relevant + ${Math.min(fillCount, otherDocs.length)} distractors), ${qrels.size} judged queries`
  );

  return { name, queries, corpus, qrels };
}
