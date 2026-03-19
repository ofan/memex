/**
 * CLI Commands for Memory Management
 */

import type { Command } from "commander";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryStore } from "./memory.js";
import type { MemoryRetriever } from "./retriever.js";
import type { MemoryScopeManager } from "./scopes.js";
import { identifyNoiseEntries } from "./noise-filter.js";
import { indexAllPaths, embedDocuments, getEmbeddingBacklog } from "./doc-indexer.js";

// ============================================================================
// Types
// ============================================================================

interface CLIContext {
  store: MemoryStore;
  retriever: MemoryRetriever;
  scopeManager: MemoryScopeManager;
  embedder?: import("./embedder.js").Embedder;
  searchDb?: import("./db.js").Database;
  docPaths?: Array<{ path: string; name: string; pattern?: string }>;
  searchDimensions?: number;
  generationConfig?: { baseURL: string; apiKey?: string; model: string };
  unifiedRetriever?: import("./unified-retriever.js").UnifiedRetriever;
}

// ============================================================================
// Utility Functions
// ============================================================================

function getPluginVersion(): string {
  try {
    const pkgUrl = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function renderProgressBar(done: number, total: number, width: number): string {
  if (total === 0) return "░".repeat(width);
  const filled = Math.round((done / total) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function timeAgo(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatMemory(memory: any, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  const id = memory?.id ? String(memory.id) : "unknown";
  const date = new Date(memory.timestamp || memory.createdAt || Date.now()).toISOString().split('T')[0];
  const fullText = String(memory.text || "");
  const text = fullText.slice(0, 100) + (fullText.length > 100 ? "..." : "");
  return `${prefix}[${id}] [${memory.category}:${memory.scope}] ${text} (${date})`;
}

function formatJson(obj: any): string {
  return JSON.stringify(obj, null, 2);
}

/** Recursively calculate directory size in bytes */
function dirSize(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  let total = 0;
  try {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(fullPath);
      } else if (entry.isFile()) {
        total += statSync(fullPath).size;
      }
    }
  } catch { /* permission errors, etc */ }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

// ============================================================================
// CLI Command Implementations
// ============================================================================

export function registerMemoryCLI(program: Command, context: CLIContext): void {
  const memory = program
    .command("memex")
    .description("Enhanced memory management commands");

  // Version
  memory
    .command("version")
    .description("Print plugin version")
    .action(() => {
      console.log(getPluginVersion());
    });

  // Search memories
  memory
    .command("search [query]")
    .description("Search memories and documents (or list recent if no query)")
    .option("--scope <scope>", "Search within specific scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "10")
    .option("--json", "Output as JSON")
    .action(async (query, options) => {
      try {
        const limit = parseInt(options.limit) || 10;

        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        // No query → list recent memories
        if (!query) {
          const memories = await context.store.list(scopeFilter, options.category, limit, 0);
          if (options.json) {
            console.log(formatJson(memories));
          } else if (memories.length === 0) {
            console.log("No memories stored.");
          } else {
            console.log(`Recent ${memories.length} memories:\n`);
            memories.forEach((m: any, i: number) => {
              const age = Math.floor((Date.now() - (m.timestamp || 0)) / 86400000);
              console.log(`${i + 1}. [${m.id.slice(0, 8)}] [${m.category}] ${m.text.slice(0, 100)} (${age}d ago)`);
            });
          }
          return;
        }

        // With query → search
        const results = context.unifiedRetriever
          ? await context.unifiedRetriever.retrieve(query, { limit, scopeFilter })
          : await context.retriever.retrieve({ query, limit, scopeFilter, category: options.category });

        if (options.json) {
          console.log(formatJson(results));
        } else {
          if (results.length === 0) {
            console.log("No relevant memories found.");
          } else {
            console.log(`Found ${results.length} results:\n`);
            results.forEach((result: any, i: number) => {
              // Handle both UnifiedResult and old RetrievalResult formats
              const id = result.id ?? result.entry?.id ?? "?";
              const text = result.text ?? result.entry?.text ?? "";
              const score = result.score ?? 0;
              const source = result.source ?? "conversation";
              const cat = result.metadata?.category ?? result.entry?.category ?? "";
              const scope = result.metadata?.scope ?? result.entry?.scope ?? "";
              const tag = source === "document" ? `[doc]` : `[${cat}:${scope}]`;

              console.log(
                `${i + 1}. [${String(id).slice(0, 8)}] ${tag} ${text.slice(0, 120)} ` +
                `(${(score * 100).toFixed(0)}%)`
              );
            });
          }
        }
      } catch (error) {
        console.error("Search failed:", error);
        process.exit(1);
      }
    });

  // Re-embed all memories with current embedding model
  memory
    .command("rebuild")
    .description("Rebuild search index — re-embed memories and/or re-index documents")
    .option("--memories-only", "Only re-embed memories, skip documents")
    .option("--docs-only", "Only re-index and re-embed documents, skip memories")
    .action(async (options) => {
      try {
        if (!context.embedder) {
          console.error("rebuild requires an embedder.");
          process.exit(1);
        }

        const doMemories = !options.docsOnly;
        const doDocs = !options.memoriesOnly;

        // Dimension pre-check
        console.log("Pre-check: testing embedding dimensions...");
        const testVec = await context.embedder.embedPassage("dimension check");
        console.log(`  Model: ${context.embedder.model}, Dimensions: ${testVec.length}d`);

        // Re-embed memories
        if (doMemories) {
          const currentModel = context.embedder.model;
          console.log("\n── Memories ──");
          const memCount = await context.store.reEmbedMemories(
            currentModel,
            async (texts) => context.embedder.embedBatchPassage(texts),
            20,
            (done, total) => {
              if (done % 100 === 0 || done === total) {
                console.log(`  ${done}/${total} re-embedded`);
              }
            }
          );
          console.log(`  Done: ${memCount} memories`);
        }

        // Re-index + re-embed documents
        if (doDocs && context.searchDb && context.docPaths) {
          console.log("\n── Documents ──");
          const db = context.searchDb;

          console.log("  Scanning files...");
          const results = await indexAllPaths(db, context.docPaths);
          let totalIndexed = 0;
          for (const r of results) {
            totalIndexed += r.indexed + r.updated;
          }
          console.log(`  ${totalIndexed} documents indexed/updated`);

          const backlog = getEmbeddingBacklog(db);
          if (backlog > 0) {
            console.log(`  Embedding ${backlog} documents...`);
            if (context.embedder && context.searchDimensions) {
              const embedResult = await embedDocuments(db, context.embedder.model, context.searchDimensions);
              console.log(`  ${embedResult.embedded} chunks embedded`);
            }
          } else {
            console.log("  All documents already embedded");
          }
        } else if (doDocs) {
          console.log("\nDocument search not configured — skipping docs.");
        }

        // Clean noise
        console.log("\n── Noise cleanup ──");
        const allMemories = await context.store.list(undefined, undefined, 10000, 0);
        const noiseEntries = identifyNoiseEntries(allMemories.map(m => ({ id: m.id, text: m.text })));
        if (noiseEntries.length > 0) {
          for (const entry of noiseEntries) {
            await context.store.delete(entry.id);
          }
          console.log(`  Removed ${noiseEntries.length} noise entries`);
        } else {
          console.log("  No noise found");
        }

        console.log("\nRebuild complete.");
      } catch (error) {
        console.error("Rebuild failed:", error);
        process.exit(1);
      }
    });

  // Memory statistics
  memory
    .command("stats")
    .description("Show memory and document indexing statistics")
    .option("--scope <scope>", "Stats for specific scope")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const stats = await context.store.stats(scopeFilter);
        const scopeStats = context.scopeManager.getStats();
        const retrievalConfig = context.retriever.getConfig();

        // Gather QMD document stats if available
        let docStats: {
          totalDocuments: number;
          docsEmbedded: number;
          docsPending: number;
          totalChunks: number;
          collections: Array<{ name: string; documents: number; docsEmbedded: number; docsPending: number; chunks: number; lastUpdated: string }>;
        } | null = null;

        if (context.searchDb) {
          const db = context.searchDb;
          // Per-collection: document counts (embedded vs pending) and chunk counts
          const collRows = db.prepare(`
            SELECT
              d.collection,
              COUNT(DISTINCT d.id) as doc_count,
              COUNT(DISTINCT CASE WHEN v0.hash IS NOT NULL THEN d.hash END) as docs_embedded,
              COUNT(DISTINCT CASE WHEN v0.hash IS NULL THEN d.hash END) as docs_pending,
              MAX(d.modified_at) as last_updated
            FROM documents d
            LEFT JOIN content_vectors v0 ON d.hash = v0.hash AND v0.seq = 0
            WHERE d.active = 1
            GROUP BY d.collection
            ORDER BY d.collection
          `).all() as Array<{ collection: string; doc_count: number; docs_embedded: number; docs_pending: number; last_updated: string | null }>;

          // Total chunks per collection (from content_vectors via documents)
          const chunkRows = db.prepare(`
            SELECT d.collection, COUNT(v.rowid) as chunk_count
            FROM documents d
            JOIN content_vectors v ON d.hash = v.hash
            WHERE d.active = 1
            GROUP BY d.collection
          `).all() as Array<{ collection: string; chunk_count: number }>;
          const chunksByCol = new Map(chunkRows.map(r => [r.collection, r.chunk_count]));

          const collections = collRows.map(row => ({
            name: row.collection,
            documents: row.doc_count,
            docsEmbedded: row.docs_embedded,
            docsPending: row.docs_pending,
            chunks: chunksByCol.get(row.collection) || 0,
            lastUpdated: row.last_updated || "never",
          }));

          docStats = {
            totalDocuments: collections.reduce((s, c) => s + c.documents, 0),
            docsEmbedded: collections.reduce((s, c) => s + c.docsEmbedded, 0),
            docsPending: collections.reduce((s, c) => s + c.docsPending, 0),
            totalChunks: collections.reduce((s, c) => s + c.chunks, 0),
            collections,
          };
        }

        const memoryDiskBytes = dirSize(context.store.dbPath);
        let diskBytes = 0;
        if (context.searchDb && (context.searchDb as any).name) {
          try { diskBytes = statSync((context.searchDb as any).name).size; } catch { /* ignore */ }
        }

        const summary = {
          memory: stats,
          scopes: scopeStats,
          retrieval: {
            mode: retrievalConfig.mode,
            hasFtsSupport: context.store.hasFtsSupport,
          },
          memoryDiskBytes,
          diskBytes,
          ...(docStats ? { documents: docStats } : {}),
        };

        if (options.json) {
          console.log(formatJson(summary));
        } else {
          // --- Conversation Memory ---
          console.log("── Conversation Memory ──");
          console.log(`  Memories: ${stats.totalCount}  │  Mode: ${retrievalConfig.mode}  │  FTS: ${context.store.hasFtsSupport ? 'yes' : 'no'}`);

          // Disk usage
          console.log(`  Disk:     ${formatBytes(memoryDiskBytes)}`);

          if (Object.keys(stats.scopeCounts).length > 0) {
            console.log(`  Scopes:   ${Object.entries(stats.scopeCounts).map(([s, c]) => `${s} (${c})`).join(", ")}`);
          }
          if (Object.keys(stats.categoryCounts).length > 0) {
            console.log(`  Types:    ${Object.entries(stats.categoryCounts).map(([s, c]) => `${s} (${c})`).join(", ")}`);
          }
          if (Object.keys(stats.sourceCounts).length > 0) {
            console.log(`  Sources:  ${Object.entries(stats.sourceCounts).map(([s, c]) => `${s} (${c})`).join(", ")}`);
          }

          // --- Document Search ---
          // Two phases: index (scan files → DB) then embed (chunk → vectors).
          // "Indexed" = in DB, searchable via FTS. "Embedded" = has vectors, searchable via similarity.
          console.log();
          console.log("── Document Search ──");
          if (docStats) {
            const pct = docStats.totalDocuments > 0
              ? Math.round((docStats.docsEmbedded / docStats.totalDocuments) * 100)
              : 100;
            const bar = renderProgressBar(docStats.docsEmbedded, docStats.totalDocuments, 30);

            console.log(`  ${bar} ${docStats.docsEmbedded}/${docStats.totalDocuments} docs embedded (${pct}%)`);
            if (docStats.docsPending > 0) {
              console.log(`  ${docStats.docsPending} docs awaiting embedding`);
            }
            console.log(`  ${docStats.totalChunks} chunks in vector index`);

            if (context.searchDb && (context.searchDb as any).name) {
              try {
                const dbSize = statSync((context.searchDb as any).name).size;
                console.log(`  Disk:     ${formatBytes(dbSize)}`);
              } catch { /* ignore stat errors */ }
            }

            if (docStats.collections.length > 0) {
              console.log();
              for (const col of docStats.collections) {
                const ago = col.lastUpdated !== "never" ? timeAgo(col.lastUpdated) : "never";
                if (col.docsPending > 0) {
                  console.log(`  ${col.name}: ${col.docsEmbedded}/${col.documents} docs (${col.chunks} chunks), ${col.docsPending} pending — ${ago}`);
                } else {
                  console.log(`  ${col.name}: ${col.documents} docs (${col.chunks} chunks) — ${ago}`);
                }
              }
            }
          } else {
            console.log("  Not configured");
          }
        }
      } catch (error) {
        console.error("Failed to get statistics:", error);
        process.exit(1);
      }
    });

  // Delete memory
  memory
    .command("delete <id>")
    .description("Delete a specific memory by ID")
    .option("--scope <scope>", "Scope to delete from (for access control)")
    .action(async (id, options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const deleted = await context.store.delete(id, scopeFilter);

        if (deleted) {
          console.log(`Memory ${id} deleted successfully.`);
        } else {
          console.log(`Memory ${id} not found or access denied.`);
          process.exit(1);
        }
      } catch (error) {
        console.error("Failed to delete memory:", error);
        process.exit(1);
      }
    });

  // Import sessions
  memory
    .command("import")
    .description("Import past conversation sessions as searchable memories (incremental — skips already-imported sessions)")
    .option("--agent <name>", "Agent name (determines sessions directory)", "main")
    .option("--all-agents", "Import sessions from all agents (not just the specified one)")
    .option("--scope <scope>", "Target scope for indexed memories", "global")
    .option("--min-importance <n>", "Minimum importance threshold (0.0-1.0)", "0.1")
    .option("--fresh", "Wipe all session-imported memories and reimport from scratch (requires confirmation)")
    .option("--llm-extract", "Use LLM to extract curated knowledge from conversation windows")
    .option("--exclude-deleted", "Exclude rotated/deleted session files (.jsonl.deleted.*)")
    .option("--dry-run", "Show what would be indexed without storing")
    .option("--json", "Output results as JSON")
    .action(async (options) => {
      try {
        if (!context.embedder) {
          console.error("import-sessions requires an embedder (not available in basic CLI mode).");
          process.exit(1);
        }

        const { indexSessions } = await import("./session-indexer.js");
        const { join } = await import("node:path");
        const home = process.env.HOME || "/home/ubuntu";
        const sessionsDir = join(home, ".openclaw", "agents", options.agent, "sessions");

        // Handle --fresh: wipe session-imported memories first
        if (options.fresh) {
          const allMemories = await context.store.list(undefined, undefined, 10000, 0);
          const sessionMemories = allMemories.filter(m => {
            try {
              const meta = JSON.parse(m.metadata || "{}");
              return meta.source === "session-import" || meta.source === "session-indexer";
            } catch { return false; }
          });

          if (sessionMemories.length > 0) {
            console.log(`Deleting ${sessionMemories.length} session-imported memories...`);
            let deleted = 0;
            for (const m of sessionMemories) {
              if (await context.store.delete(m.id)) deleted++;
            }
            console.log(`Deleted ${deleted} session-imported memories.`);
          }
        }

        // Find already-imported session IDs (incremental import)
        const alreadyImported = new Set<string>();
        if (!options.fresh) {
          const allMemories = await context.store.list(undefined, undefined, 10000, 0);
          for (const m of allMemories) {
            try {
              const meta = JSON.parse(m.metadata || "{}");
              if ((meta.source === "session-import" || meta.source === "session-indexer") && meta.sessionId) {
                alreadyImported.add(meta.sessionId);
              }
            } catch { /* ignore parse errors */ }
          }
          if (alreadyImported.size > 0) {
            console.log(`Continuing — ${alreadyImported.size} sessions already imported, will skip them.`);
          }
        }

        // Determine which session directories to import
        const agentsDirs: Array<{ agent: string; dir: string }> = [];
        if (options.allAgents) {
          const agentsRoot = join(home, ".openclaw", "agents");
          const { readdirSync, existsSync } = await import("node:fs");
          if (existsSync(agentsRoot)) {
            for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                const sessDir = join(agentsRoot, entry.name, "sessions");
                if (existsSync(sessDir)) {
                  agentsDirs.push({ agent: entry.name, dir: sessDir });
                }
              }
            }
          }
          console.log(`Found ${agentsDirs.length} agents: ${agentsDirs.map(a => a.agent).join(", ")}`);
        } else {
          agentsDirs.push({ agent: options.agent, dir: sessionsDir });
        }

        // Build LLM extraction config if --llm-extract is set
        let llmExtraction: import("./session-indexer.js").LLMExtractionConfig | undefined;
        if (options.llmExtract) {
          if (!context.generationConfig) {
            console.warn("Warning: --llm-extract requires 'generation' config. Falling back to heuristic extraction.");
          } else {
            const { probeBackend, applyBackendCapabilities } = await import("./session-indexer.js");

            // Auto-detect backend capabilities
            console.log("Probing backend capabilities...");
            const caps = await probeBackend(
              context.generationConfig.baseURL,
              context.generationConfig.model,
              context.generationConfig.apiKey,
            );
            console.log(`  backend: ${caps.backend}, cache_prompt: ${caps.cachePrompt}, context: ${caps.contextWindow ?? "unknown"}, timeout: ${caps.timeout}ms`);

            llmExtraction = applyBackendCapabilities(
              {
                endpoint: `${context.generationConfig.baseURL}/chat/completions`,
                model: context.generationConfig.model,
                apiKey: context.generationConfig.apiKey,
              },
              caps,
            );
          }
        }

        // Snapshot stats before import
        const beforeStats = await context.store.stats();
        const beforeCount = beforeStats.totalCount;
        const beforeSessionImportCount = beforeStats.sourceCounts["session-import"] || 0;

        let combinedResult: import("./session-indexer.js").IndexResult | undefined;
        for (const { agent, dir } of agentsDirs) {
          console.warn(`\nImporting sessions for agent: ${agent}`);
          const result = await indexSessions(context.store, context.embedder, {
            sessionsDir: dir,
            targetScope: options.scope,
            minImportance: parseFloat(options.minImportance) || 0.1,
            dryRun: options.dryRun === true,
            alreadyImported,
            llmExtraction,
            includeDeleted: options.excludeDeleted !== true,
          });

          if (!combinedResult) {
            combinedResult = result;
          } else {
            combinedResult.totalSessions += result.totalSessions;
            combinedResult.skippedSessions += result.skippedSessions;
            combinedResult.skippedAlreadyImported += result.skippedAlreadyImported;
            combinedResult.totalTurns += result.totalTurns;
            combinedResult.indexedTurns += result.indexedTurns;
            combinedResult.skippedNoise += result.skippedNoise;
            combinedResult.skippedImportance += result.skippedImportance;
            combinedResult.llmExtracted += result.llmExtracted;
            combinedResult.llmErrors += result.llmErrors;
            combinedResult.llmDeduplicated += result.llmDeduplicated;
            combinedResult.skippedStoreDuplicates += result.skippedStoreDuplicates;
            combinedResult.errors.push(...result.errors);
          }
        }
        const result = combinedResult!;

        if (options.json) {
          console.log(formatJson(result));
        } else {
          console.log(`Session Import Results:`);
          console.log(`• Sessions: ${result.totalSessions} total, ${result.skippedSessions} skipped (automated), ${result.skippedAlreadyImported} already imported`);
          console.log(`• Turns: ${result.totalTurns} total`);
          console.log(`• Noise filtered: ${result.skippedNoise}`);
          if (result.llmExtracted > 0 || result.llmErrors > 0) {
            console.log(`• LLM extracted: ${result.llmExtracted} memories (${result.llmErrors} errors)`);
            if (result.llmDeduplicated > 0) {
              console.log(`• LLM deduplicated: ${result.llmDeduplicated}`);
            }
          }
          if (result.skippedStoreDuplicates > 0) {
            console.log(`• Store duplicates skipped: ${result.skippedStoreDuplicates}`);
          }
          console.log(`• Below importance threshold: ${result.skippedImportance}`);
          console.log(`• Indexed: ${result.indexedTurns}`);
          if (result.errors.length > 0) {
            console.log(`• Errors: ${result.errors.length}`);
            result.errors.forEach(e => console.log(`  - ${e}`));
          }
          if (options.dryRun) {
            console.log(`\n(dry run — nothing was stored)`);
          }
        }

        // Before/after summary
        const afterStats = await context.store.stats();
        const afterCount = afterStats.totalCount;
        const afterSessionImportCount = afterStats.sourceCounts["session-import"] || 0;

        console.log();
        console.log(`Store: ${beforeCount} → ${afterCount} memories (+${afterCount - beforeCount})`);
        console.log(`  session-import: ${beforeSessionImportCount} → ${afterSessionImportCount} (+${afterSessionImportCount - beforeSessionImportCount})`);
      } catch (error) {
        console.error("Session import failed:", error);
        process.exit(1);
      }
    });

  // Purge all memories
  memory
    .command("wipe")
    .description("Wipe all memories (or filter by scope/age) — DESTRUCTIVE")
    .option("--scope <scope>", "Only delete memories in this scope")
    .option("--before <date>", "Only delete memories created before this date (ISO 8601, e.g. 2026-01-01)")
    .option("--confirm", "Skip confirmation prompt")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) scopeFilter = [options.scope];

        const memories = await context.store.list(scopeFilter, undefined, 10000, 0);
        let toDelete = memories;

        if (options.before) {
          const cutoff = new Date(options.before).getTime();
          if (isNaN(cutoff)) {
            console.error(`Invalid date: ${options.before}`);
            process.exit(1);
          }
          toDelete = memories.filter(m => new Date(m.timestamp).getTime() < cutoff);
        }

        if (toDelete.length === 0) {
          console.log("No memories match the filter.");
          return;
        }

        const label = options.scope ? ` in scope "${options.scope}"` : "";
        const dateLabel = options.before ? ` before ${options.before}` : "";
        console.log(`Will delete ${toDelete.length}/${memories.length} memories${label}${dateLabel}.`);

        if (!options.confirm) {
          const readline = await import("node:readline");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>(resolve => rl.question("Type YES to confirm: ", resolve));
          rl.close();
          if (answer !== "YES") {
            console.log("Aborted.");
            return;
          }
        }

        let deleted = 0;
        for (const m of toDelete) {
          const ok = await context.store.delete(m.id);
          if (ok) deleted++;
        }
        console.log(`Deleted ${deleted} memories.`);
      } catch (error) {
        console.error("Purge failed:", error);
        process.exit(1);
      }
    });
}

// ============================================================================
// Factory Function
// ============================================================================

export function createMemoryCLI(context: CLIContext) {
  return ({ program }: { program: Command }) => {
    registerMemoryCLI(program, context);

    // After any memex CLI command completes, close DB handles
    // and exit. Without this, sqlite-vec native handles keep Node alive.
    const memexCmd = program.commands.find(c => c.name() === "memex");
    if (memexCmd) {
      memexCmd.hook("postAction", () => {
        try { context.store.close(); } catch {}
        // Give a moment for any final output to flush, then exit
        setTimeout(() => process.exit(0), 50).unref();
      });
    }
  };
}