/**
 * Disk-based embedding cache for benchmarks.
 *
 * Caches embeddings keyed by SHA-256(text + model) to avoid re-embedding
 * the same corpus across benchmark runs. Cache files are stored in
 * tests/.cache/embeddings/<model>/<hash>.json.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const CACHE_BASE = join(dirname(dirname(import.meta.url.replace("file://", ""))), ".cache", "embeddings");

function cacheKey(text: string, model: string): string {
  return createHash("sha256").update(`${model}:${text}`).digest("hex");
}

function cachePath(model: string, key: string): string {
  // Use first 2 chars as subdirectory to avoid too many files in one dir
  const dir = join(CACHE_BASE, model.replace(/[^a-zA-Z0-9_-]/g, "_"), key.slice(0, 2));
  return join(dir, `${key}.json`);
}

export function getCachedEmbedding(text: string, model: string): number[] | null {
  const path = cachePath(model, cacheKey(text, model));
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function setCachedEmbedding(text: string, model: string, embedding: number[]): void {
  const key = cacheKey(text, model);
  const path = cachePath(model, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(embedding));
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: string;
}

/**
 * Embed a corpus with disk caching. Only calls the embedder for uncached texts.
 * Returns vectors in the same order as the input texts.
 */
export async function embedWithCache(
  texts: string[],
  model: string,
  embedFn: (text: string) => Promise<number[]>,
  opts?: { onProgress?: (done: number, total: number) => void; retries?: number },
): Promise<{ vectors: number[][]; stats: CacheStats }> {
  const vectors: number[][] = new Array(texts.length);
  let hits = 0;
  let misses = 0;
  const retries = opts?.retries ?? 5;

  for (let i = 0; i < texts.length; i++) {
    const cached = getCachedEmbedding(texts[i], model);
    if (cached) {
      vectors[i] = cached;
      hits++;
    } else {
      // Embed with retry
      let vec: number[] | null = null;
      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          vec = await embedFn(texts[i]);
          break;
        } catch (err: any) {
          console.warn(`  [embed-cache] text ${i} attempt ${attempt + 1} failed: ${err.message?.slice(0, 80)}`);
          if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
        }
      }
      if (!vec) throw new Error(`Failed to embed text ${i} after ${retries} retries`);
      setCachedEmbedding(texts[i], model, vec);
      vectors[i] = vec;
      misses++;
    }

    if (opts?.onProgress && ((i + 1) % 50 === 0 || i + 1 === texts.length)) {
      opts.onProgress(i + 1, texts.length);
    }
  }

  return {
    vectors,
    stats: {
      hits,
      misses,
      hitRate: texts.length > 0 ? `${((hits / texts.length) * 100).toFixed(1)}%` : "N/A",
    },
  };
}
