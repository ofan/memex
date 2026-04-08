/**
 * Document Indexer
 *
 * Library-friendly wrapper around QMD's store primitives for indexing
 * workspace documents. Unlike search/search.ts (which is a CLI app with
 * module-scoped state), this module is stateless and takes explicit
 * store/db parameters.
 */

import type { Database } from "./db.js";
import fastGlob from "fast-glob";
import { readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  hashContent,
  extractTitle,
  handelize,
  insertContent,
  insertDocument,
  findActiveDocument,
  updateDocumentTitle,
  updateDocument,
  deactivateDocument,
  getActiveDocumentPaths,
  cleanupOrphanedContent,
  getHashesForEmbedding,
  formatDocForEmbedding,
  chunkDocument,
  insertEmbedding,
  clearCache,
  getHashesNeedingEmbedding,
} from "./search.js";
import { withLLMSession } from "./llm.js";
import type { Embedder } from "./embedder.js";

// ============================================================================
// Types
// ============================================================================

export interface IndexPath {
  path: string;
  name: string;
  pattern?: string;
}

export interface IndexResult {
  collection: string;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  errors: string[];
}

export interface EmbedResult {
  embedded: number;
  chunks: number;
  errors: string[];
}

// ============================================================================
// File Indexing
// ============================================================================

const EXCLUDE_DIRS = ["node_modules", ".git", ".cache", "vendor", "dist", "build"];

/**
 * Index files from a workspace path into the QMD store.
 * This scans files, computes content hashes, and inserts/updates documents.
 * Does NOT compute embeddings — call embedDocuments() after indexing.
 */
export async function indexPath(
  db: Database,
  pathConfig: IndexPath
): Promise<IndexResult> {
  const result: IndexResult = {
    collection: pathConfig.name,
    indexed: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    errors: [],
  };

  const pattern = pathConfig.pattern || "**/*.md";
  const now = new Date().toISOString();

  try {
    clearCache(db);

    const allFiles = await fastGlob(pattern, {
      cwd: pathConfig.path,
      onlyFiles: true,
      followSymbolicLinks: false,
      dot: false,
      ignore: EXCLUDE_DIRS.map((d) => `**/${d}/**`),
    });

    // Filter hidden files/folders
    const files = allFiles.filter((file) => {
      const parts = file.split("/");
      return !parts.some((part) => part.startsWith("."));
    });

    const seenPaths = new Set<string>();

    if (files.length === 0) {
      // Even with no files, we need to check for removals
      const allActive = getActiveDocumentPaths(db, pathConfig.name);
      for (const path of allActive) {
        deactivateDocument(db, pathConfig.name, path);
        result.removed++;
      }
      if (result.removed > 0) cleanupOrphanedContent(db);
      return result;
    }

    for (const relativeFile of files) {
      try {
        const filepath = resolve(pathConfig.path, relativeFile);
        const path = handelize(relativeFile);
        seenPaths.add(path);

        const content = readFileSync(filepath, "utf-8");
        if (!content.trim()) continue;

        const hash = await hashContent(content);
        const title = extractTitle(content, relativeFile);
        const existing = findActiveDocument(db, pathConfig.name, path);

        if (existing) {
          if (existing.hash === hash) {
            if (existing.title !== title) {
              updateDocumentTitle(db, existing.id, title, now);
              result.updated++;
            } else {
              result.unchanged++;
            }
          } else {
            insertContent(db, hash, content, now);
            const stat = statSync(filepath);
            updateDocument(
              db,
              existing.id,
              title,
              hash,
              stat ? new Date(stat.mtime).toISOString() : now
            );
            result.updated++;
          }
        } else {
          insertContent(db, hash, content, now);
          const stat = statSync(filepath);
          insertDocument(
            db,
            pathConfig.name,
            path,
            title,
            hash,
            stat ? new Date(stat.birthtime).toISOString() : now,
            stat ? new Date(stat.mtime).toISOString() : now
          );
          result.indexed++;
        }
      } catch (err) {
        result.errors.push(`${relativeFile}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Deactivate removed files
    const allActive = getActiveDocumentPaths(db, pathConfig.name);
    for (const path of allActive) {
      if (!seenPaths.has(path)) {
        deactivateDocument(db, pathConfig.name, path);
        result.removed++;
      }
    }

    cleanupOrphanedContent(db);
  } catch (err) {
    result.errors.push(`Collection ${pathConfig.name}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Index all configured paths.
 * Also deactivates documents from collections not in the current config.
 */
export async function indexAllPaths(
  db: Database,
  paths: IndexPath[]
): Promise<IndexResult[]> {
  // Clean up stale collections not in current config
  const activeCollections = new Set(paths.map(p => p.name));
  const dbCollections = db.prepare(
    `SELECT DISTINCT collection FROM documents WHERE active = 1`
  ).all() as Array<{ collection: string }>;

  for (const { collection } of dbCollections) {
    if (!activeCollections.has(collection)) {
      const stale = db.prepare(
        `UPDATE documents SET active = 0 WHERE collection = ? AND active = 1`
      ).run(collection);
      if ((stale as any).changes > 0) {
        console.warn(`doc-indexer: deactivated ${(stale as any).changes} documents from stale collection "${collection}"`);
      }
    }
  }

  const results: IndexResult[] = [];
  for (const pathConfig of paths) {
    results.push(await indexPath(db, pathConfig));
  }

  // Clean up orphaned content/vectors from deactivated stale collections
  cleanupOrphanedContent(db);

  return results;
}

// ============================================================================
// Embedding
// ============================================================================

/**
 * Embed documents that need vectors.
 *
 * When an `Embedder` is provided (recommended), uses its embedPassage()
 * which handles context-size errors with adaptive re-chunking and caching.
 *
 * Falls back to the legacy LLMSession path when no Embedder is passed.
 */
export async function embedDocuments(
  db: Database,
  dimensions: number,
  embedder?: Embedder,
): Promise<EmbedResult> {
  const result: EmbedResult = { embedded: 0, chunks: 0, errors: [] };

  const hashesToEmbed = getHashesForEmbedding(db);
  if (hashesToEmbed.length === 0) return result;

  if (embedder) {
    return embedDocumentsViaEmbedder(db, dimensions, embedder, hashesToEmbed, result);
  }

  // Legacy path: LLMSession (no context-error handling, no re-chunking)
  try {
    await withLLMSession(async (session) => {
      for (const item of hashesToEmbed) {
        try {
          const title = extractTitle(item.body, item.path);
          const chunks = chunkDocument(item.body);
          let docChunks = 0;

          for (let seq = 0; seq < chunks.length; seq++) {
            const chunk = chunks[seq];
            if (!chunk) continue;

            const textForEmbed = formatDocForEmbedding(chunk.text, title);
            const embResult = await session.embed(textForEmbed);

            if (embResult && embResult.embedding.length === dimensions) {
              const vec = new Float32Array(embResult.embedding);
              insertEmbedding(db, item.hash, seq, chunk.pos, vec, embResult.model, new Date().toISOString());
              result.chunks++;
              docChunks++;
            }
          }

          if (docChunks > 0) result.embedded++;
        } catch (err) {
          result.errors.push(`${item.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }, { timeout: 30 * 60 * 1000 });
  } catch (err) {
    result.errors.push(`Embedding session failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

/**
 * Embed via the Embedder class which handles context-size errors,
 * adaptive re-chunking, and caching automatically.
 */
async function embedDocumentsViaEmbedder(
  db: Database,
  dimensions: number,
  embedder: Embedder,
  hashesToEmbed: { hash: string; body: string; path: string }[],
  result: EmbedResult,
): Promise<EmbedResult> {
  const model = embedder.model;
  const now = () => new Date().toISOString();

  for (const item of hashesToEmbed) {
    try {
      const title = extractTitle(item.body, item.path);
      const chunks = chunkDocument(item.body);
      let docChunks = 0;

      for (let seq = 0; seq < chunks.length; seq++) {
        const chunk = chunks[seq];
        if (!chunk) continue;

        const textForEmbed = formatDocForEmbedding(chunk.text, title);
        // embedPassage handles context-size errors internally:
        // detects "context|exceed|length" errors, re-chunks via smartChunk(),
        // embeds sub-chunks, and returns averaged embedding.
        const embedding = await embedder.embedPassage(textForEmbed);

        if (embedding.length === dimensions) {
          insertEmbedding(db, item.hash, seq, chunk.pos, new Float32Array(embedding), model, now());
          result.chunks++;
          docChunks++;
        }
      }

      if (docChunks > 0) result.embedded++;
    } catch (err) {
      // One error per document, not per chunk
      result.errors.push(`${item.path}: ${err instanceof Error ? err.message : String(err)}`);
      // Mark hash as failed so it's not retried every startup.
      // Insert a sentinel content_vectors row with model="_error".
      // getHashesForEmbedding() LEFT JOINs on this table, so the hash
      // won't appear in the backlog again.
      try {
        db.prepare(
          `INSERT OR IGNORE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, 0, 0, '_error', ?)`
        ).run(item.hash, now());
      } catch { /* ignore — best effort */ }
    }
  }

  return result;
}

/**
 * Check how many documents need embedding.
 */
export function getEmbeddingBacklog(db: Database): number {
  return getHashesNeedingEmbedding(db);
}
