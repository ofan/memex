/**
 * Memory Unified Plugin
 * Unified memory: SQLite conversation memory + document search
 * with shared embedding/reranker and unified recall pipeline
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { homedir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync, mkdirSync, readdirSync, lstatSync } from "node:fs";

// Import core components (SQLite-backed memory store)
import { MemoryStore, validateStoragePath } from "./src/memory.js";
import { createEmbedder, getVectorDimensions } from "./src/embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "./src/retriever.js";
import { createScopeManager } from "./src/scopes.js";

import { registerAllMemoryTools } from "./src/tools.js";
import { shouldSkipRetrieval } from "./src/adaptive-retrieval.js";
import { isNoise, isStructuralNoise, identifyNoiseEntries, extractHumanText } from "./src/noise-filter.js";
// capture-windows.ts kept for potential future compaction-based extraction
import { UnifiedRecall } from "./src/unified-recall.js";
import { UnifiedRetriever } from "./src/unified-retriever.js";
import type { DocumentCandidate } from "./src/unified-retriever.js";
import { createMemoryCLI } from "./src/cli.js";

// Import search components
import { initializeLLM, disposeDefaultLlamaCpp } from "./src/llm.js";
import type { HttpLLMConfig } from "./src/llm.js";
import { createStore as createSearchStore, hybridQuery as searchHybridQuery, searchFTS } from "./src/search.js";
import { indexAllPaths, embedDocuments, getEmbeddingBacklog } from "./src/doc-indexer.js";
import { buildRecallContext, MEMORY_INSTRUCTION } from "./src/memory-instructions.js";
import { initTelemetry } from "./src/telemetry.js";

// ============================================================================
// Configuration & Types
// ============================================================================

interface PluginConfig {
  embedding: {
    provider: "openai-compatible";
    apiKey: string;
    model?: string;
    baseURL?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
    normalized?: boolean;
    chunking?: boolean;
  };
  dbPath?: string;
  autoRecall?: boolean;
  autoRecallAgents?: string[];
  autoRecallLimit?: number;
  autoRecallMinLength?: number;
  /** Set to 'off' to disable memory instruction injection */
  memoryInstructions?: "off" | string;
  /** Automatically purge noise entries from store on startup (default: false) */
  autoFixNoise?: boolean;
  retrieval?: {
    mode?: "hybrid" | "vector";
    vectorWeight?: number;
    bm25Weight?: number;
    minScore?: number;
    rerank?: "cross-encoder" | "lightweight" | "none";
    candidatePoolSize?: number;
    rerankApiKey?: string;
    rerankModel?: string;
    rerankEndpoint?: string;
    rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone";
    recencyHalfLifeDays?: number;
    recencyWeight?: number;
    filterNoise?: boolean;
    lengthNormAnchor?: number;
    hardMinScore?: number;
    timeDecayHalfLifeDays?: number;
  };
  scopes?: {
    default?: string;
    definitions?: Record<string, { description: string }>;
    agentAccess?: Record<string, string[]>;
  };
  enableManagementTools?: boolean;
  /** @deprecated — do not use */
  sessionMemory?: { enabled?: boolean };
  /** Shared reranker config */
  reranker?: {
    enabled?: boolean;
    endpoint?: string;
    apiKey?: string;
    model?: string;
    provider?: string;
  };
  /** Document search (document) config */
  documents?: {
    enabled?: boolean;
    dbPath?: string;
    paths?: Array<{ path: string; name: string; pattern?: string }>;
    queryExpansion?: boolean;
    /** Re-index interval in minutes (0 = disabled, default: 30) */
    reindexIntervalMinutes?: number;
  };
  /** Filter docs to current agent's workspace in auto-recall (default: true) */
  autoRecallDocFilter?: boolean;
  /** Optional generation model for query expansion */
  generation?: {
    baseURL?: string;
    apiKey?: string;
    model?: string;
  };
  /** Session indexing: bulk-import past conversation sessions on startup */
  sessionIndexing?: {
    enabled?: boolean;
    /** Agent name to index sessions from (default: "main") */
    agent?: string;
    /** Legacy — ignored. Indexed memories use per-session scopes. */
    scope?: string;
    /** Minimum importance threshold (default: 0.1) */
    minImportance?: number;
    /** Auto-index on first startup only (skips if memories already exist) */
    autoIndexOnce?: boolean;
  };
}

// ============================================================================
// Default Configuration
// ============================================================================

function getDefaultDbPath(): string {
  const home = homedir();
  return join(home, ".openclaw", "memory", "memex.sqlite");
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    const resolved = resolveEnvVars(s);
    const n = Number(resolved);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

// ============================================================================
// Capture & Category Detection (from old plugin)
// ============================================================================

export function detectCategory(text: string): "preference" | "fact" | "decision" | "entity" | "other" {
  const lower = text.toLowerCase();
  if (/prefer|radši|like|love|hate|want|偏好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯/i.test(lower)) {
    return "preference";
  }
  if (/rozhodli|decided|we decided|will use|we will use|we'?ll use|switch(ed)? to|migrate(d)? to|going forward|from now on|budeme|決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用|規則|流程|SOP/i.test(lower)) {
    return "decision";
  }
  if (/\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se|我的\S+是|叫我|稱呼|称呼/i.test(lower)) {
    return "entity";
  }
  if (/\b(is|are|has|have|je|má|jsou)\b|總是|总是|從不|从不|一直|每次都|老是/i.test(lower)) {
    return "fact";
  }
  return "other";
}

function sanitizeForContext(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/</g, "\uFF1C")
    .replace(/>/g, "\uFF1E")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// ============================================================================
// Version
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

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryUnifiedPlugin = {
  id: "memex",
  name: "Memex",
  description: "Unified memory: SQLite conversation memory + document search with shared embedding/reranker",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {

    // Detect CLI mode: this plugin is loaded for ordinary `openclaw ...` commands too,
    // not just `openclaw cli ...` or `openclaw memex ...`.
    // Treat every non-gateway process as CLI so startup timers/background work do not
    // keep one-shot commands alive after they print output.
    const isCli = !process.argv.includes("gateway");

    // Parse and validate configuration
    const config = parsePluginConfig(api.pluginConfig);

    const resolvedDbPath = api.resolvePath(config.dbPath || getDefaultDbPath());

    // Pre-flight: validate storage path (symlink resolution, mkdir, write check).
    // Runs synchronously and logs warnings; does NOT block gateway startup.
    try {
      validateStoragePath(resolvedDbPath);
    } catch (err) {
      api.logger.warn(
        `memex: storage path issue — ${String(err)}\n` +
        `  The plugin will still attempt to start, but writes may fail.`
      );
    }

    const vectorDim = getVectorDimensions(
      config.embedding.model || "text-embedding-3-small",
      config.embedding.dimensions
    );

    // Lazy DB initialization — deferred until first use.
    // This prevents `openclaw --help` and other non-memex commands from
    // opening sqlite handles that keep the Node event loop alive (issue #8).
    const unifiedDbPath = resolvedDbPath;
    let unifiedDbDir = unifiedDbPath;
    try {
      const stat = lstatSync(unifiedDbPath);
      if (!stat.isDirectory()) unifiedDbDir = dirname(unifiedDbPath);
    } catch {
      // Path doesn't exist — create directory
    }
    if (!existsSync(unifiedDbDir)) mkdirSync(unifiedDbDir, { recursive: true });
    const unifiedDbFile = unifiedDbPath.endsWith(".sqlite") ? unifiedDbPath : join(unifiedDbPath, "memex.sqlite");

    let _searchStore: ReturnType<typeof createSearchStore> | null = null;
    let _store: MemoryStore | null = null;
    let _storesInitialized = false;

    function initStores() {
      if (_storesInitialized) return;
      _searchStore = createSearchStore(unifiedDbFile);
      _searchStore.ensureVecTable(vectorDim);
      _store = new MemoryStore({ dbPath: unifiedDbFile, vectorDim, db: _searchStore.db });
      _storesInitialized = true;
    }

    // Getters that trigger lazy init
    function getStore(): MemoryStore {
      initStores();
      return _store!;
    }

    function getSearchStore() {
      initStores();
      return _searchStore!;
    }

    // For backward compat — proxy that lazy-inits on property access
    const store = new Proxy({} as MemoryStore, {
      get(_, prop) {
        return (getStore() as any)[prop];
      },
    });

    // LanceDB migration disabled — old memories used incompatible 3072d vectors.
    // Use `import-sessions` to re-index from conversation history with current model.

    const embedder = createEmbedder({
      provider: "openai-compatible",
      apiKey: resolveEnvVars(config.embedding.apiKey),
      model: config.embedding.model || "text-embedding-3-small",
      baseURL: config.embedding.baseURL,
      dimensions: config.embedding.dimensions,
      taskQuery: config.embedding.taskQuery,
      taskPassage: config.embedding.taskPassage,
      normalized: config.embedding.normalized,
      chunking: config.embedding.chunking,
    });
    // Background probe: verify embedding API returns expected dimensions (gateway only)
    if (!isCli) (async () => {
      try {
        const probe = await embedder.test();
        if (!probe.success) {
          api.logger.warn(`memex: embedding probe failed — ${probe.error}. Recall may not work.`);
        } else if (probe.dimensions !== vectorDim) {
          api.logger.warn(
            `memex: dimension mismatch! Config expects ${vectorDim}d but model returns ${probe.dimensions}d. ` +
            `Set embedding.dimensions to ${probe.dimensions} or use a compatible model.`
          );
        }
      } catch (err) {
        api.logger.warn(`memex: embedding probe error — ${String(err)}`);
      }
    })();

    // Embedding model change detection (two-phase state machine)
    // See docs/RESILIENCY.md for full failure mode analysis.
    const embeddingModel = config.embedding.model || "text-embedding-3-small";
    let embeddingMismatchWarning: string | null = null;

    if (!isCli) {
      const status = store.getEmbeddingStatus(embeddingModel);

      if (status === "first_run") {
        store.setStoredEmbeddingModel(embeddingModel);
      } else if (status === "model_changed" || status === "interrupted") {
        const stored = store.getStoredEmbeddingModel();
        const target = store.getMeta("embedding_target");
        const reason = status === "interrupted"
          ? `interrupted re-embed detected (target: ${target})`
          : `model changed (was: ${stored}, now: ${embeddingModel})`;

        api.logger.warn(`memex: ${reason}. Memory recall may return poor results. Run: openclaw memex re-embed`);

        // Set warning for context injection — agent will see this and can inform user
        embeddingMismatchWarning =
          `Memory embedding model mismatch: memories were embedded with "${stored || target}" ` +
          `but current model is "${embeddingModel}". Recall quality may be degraded. ` +
          `Run: openclaw memex re-embed`;
      }
    }

    // Merge shared reranker config into retrieval config
    const retrievalConfig = {
      ...DEFAULT_RETRIEVAL_CONFIG,
      ...config.retrieval,
    };
    // If shared reranker is configured but retrieval doesn't have its own, use shared config
    if (config.reranker?.enabled !== false && config.reranker?.endpoint) {
      if (!retrievalConfig.rerankEndpoint) {
        retrievalConfig.rerankEndpoint = config.reranker.endpoint;
      }
      if (!retrievalConfig.rerankApiKey && config.reranker.apiKey) {
        retrievalConfig.rerankApiKey = resolveEnvVars(config.reranker.apiKey);
      }
      if (!retrievalConfig.rerankModel && config.reranker.model) {
        retrievalConfig.rerankModel = config.reranker.model;
      }
      if (!retrievalConfig.rerankProvider && config.reranker.provider) {
        retrievalConfig.rerankProvider = config.reranker.provider as any;
      }
    }
    const retriever = createRetriever(store, embedder, retrievalConfig);
    const scopeManager = createScopeManager(config.scopes);
    const pluginVersion = getPluginVersion();
    const track = initTelemetry(pluginVersion);

    // ========================================================================
    // Initialize document search (Document Search) — optional
    // ========================================================================

    let searchStoreRef: any = new Proxy({} as any, {
      get(_, prop) {
        return _searchStore ? (_searchStore as any)[prop] : undefined;
      },
    });
    let activeHybridQuery: any = null;
    let reindexTimer: ReturnType<typeof setInterval> | null = null;
    // TODO: replace dual-pipeline with unified search (see memory/project-recall-fusion.md)
    const unifiedRecall = new UnifiedRecall(retriever, embedder, {}, { warn: (msg) => api.logger.warn(msg) });

    // Initialize document search (needed for both CLI and gateway)
    // Build per-agent collections + workspace→collection lookup for auto-recall filtering
    const defaultDocPaths: Array<{ path: string; name: string; pattern?: string }> = [];
    const workspaceToCollection = new Map<string, string>();
    const agentList = (api.config as any)?.agents?.list as Array<{ id?: string; workspace?: string }> | undefined;
    if (agentList) {
      const seen = new Set<string>();
      const usedNames = new Set<string>();
      for (const agent of agentList) {
        if (agent.workspace && !seen.has(agent.workspace) && existsSync(agent.workspace)) {
          seen.add(agent.workspace);
          let name = agent.id || basename(agent.workspace);
          // Guard against collection name collisions when agent.id is absent
          if (usedNames.has(name)) {
            let suffix = 2;
            while (usedNames.has(`${name}-${suffix}`)) suffix++;
            name = `${name}-${suffix}`;
          }
          usedNames.add(name);
          defaultDocPaths.push({ path: agent.workspace, name, pattern: "**/*.md" });
          workspaceToCollection.set(agent.workspace, name);
        }
      }
      // Discover orphan subdirs of the workspace root (e.g. shared/, projects/)
      // These are not owned by any agent but should still be indexed
      if (seen.size > 0) {
        const parents = new Set([...seen].map(ws => dirname(ws)));
        if (parents.size === 1) {
          const root = [...parents][0];
          try {
            const subdirs = readdirSync(root, { withFileTypes: true })
              .filter(d => d.isDirectory() && !d.name.startsWith("."))
              .map(d => join(root, d.name))
              .filter(d => !seen.has(d));
            for (const dir of subdirs) {
              defaultDocPaths.push({ path: dir, name: basename(dir), pattern: "**/*.md" });
            }
          } catch { /* ignore read errors */ }
        }
      }
    }
    // Fallback: default workspace from agent defaults
    if (defaultDocPaths.length === 0) {
      const defaultWorkspace = (api.config as any)?.agents?.defaults?.workspace as string | undefined;
      if (defaultWorkspace && existsSync(defaultWorkspace)) {
        defaultDocPaths.push({ path: defaultWorkspace, name: "workspace", pattern: "**/*.md" });
        workspaceToCollection.set(defaultWorkspace, "workspace");
      }
    }

    const explicitPaths = config.documents?.paths?.map((p: any) => ({
      path: p.path,
      name: p.name,
      pattern: p.pattern,
    })) || [];

    // Auto-discover always runs; explicit paths are additive
    const docPaths = [...defaultDocPaths];
    if (explicitPaths.length > 0) {
      const existingPaths = new Set(docPaths.map(d => resolve(d.path)));
      for (const ep of explicitPaths) {
        if (existingPaths.has(resolve(ep.path))) {
          api.logger.warn(`memex: explicit doc path "${ep.path}" already discovered via agent config, skipping duplicate`);
        } else {
          docPaths.push(ep);
        }
      }
    }
    let searchDims = 0;

    if (config.documents?.enabled !== false && docPaths.length > 0) {
      try {
        // Build shared LLM config for document
        const llmConfig: HttpLLMConfig = {
          embedding: {
            baseURL: config.embedding.baseURL || "",
            apiKey: resolveEnvVars(config.embedding.apiKey),
            model: config.embedding.model || "text-embedding-3-small",
            dimensions: config.embedding.dimensions,
          },
          reranker: config.reranker?.enabled !== false && config.reranker?.endpoint ? {
            enabled: true,
            endpoint: config.reranker.endpoint,
            apiKey: config.reranker.apiKey ? resolveEnvVars(config.reranker.apiKey) : "unused",
            model: config.reranker.model || "bge-reranker-v2-m3-Q8_0",
            provider: config.reranker.provider || "jina",
          } : undefined,
          generation: config.generation?.model ? {
            baseURL: config.generation.baseURL || config.embedding.baseURL || "",
            apiKey: config.generation.apiKey ? resolveEnvVars(config.generation.apiKey) : resolveEnvVars(config.embedding.apiKey),
            model: config.generation.model,
          } : undefined,
          queryExpansion: config.documents.queryExpansion ?? false,
        };

        // Initialize shared LLM (replaces node-llama-cpp with HTTP)
        initializeLLM(llmConfig);

        // Initialize stores lazily and wire up document search
        initStores();
        searchDims = vectorDim;

        activeHybridQuery = searchHybridQuery;

        // Wire into unified recall
        unifiedRecall.setSearchStore(searchStoreRef, activeHybridQuery, config.embedding.model || "text-embedding-3-small");

        // Background indexing — gateway only (skip in CLI mode)
        if (!isCli) {
          const searchDb = searchStoreRef.db;

          const runDocIndex = async (silent = false) => {
            try {
              const indexResults = await indexAllPaths(searchDb, docPaths);
              const totals = indexResults.reduce(
                (acc, r) => ({
                  indexed: acc.indexed + r.indexed,
                  updated: acc.updated + r.updated,
                  unchanged: acc.unchanged + r.unchanged,
                  removed: acc.removed + r.removed,
                }),
                { indexed: 0, updated: 0, unchanged: 0, removed: 0 }
              );

              if (!silent && (totals.indexed > 0 || totals.updated > 0)) {
                api.logger.info(
                  `memex: indexed ${totals.indexed} new, ${totals.updated} updated, ${totals.unchanged} unchanged, ${totals.removed} removed docs`
                );
              }

              const backlog = getEmbeddingBacklog(searchDb);
              if (backlog > 0) {
                if (!silent) api.logger.info(`memex: embedding ${backlog} document hashes...`);
                const embedResult = await embedDocuments(searchDb, searchDims);
                if (!silent) {
                  api.logger.info(
                    `memex: embedded ${embedResult.embedded} docs (${embedResult.chunks} chunks)${embedResult.errors.length > 0 ? `, ${embedResult.errors.length} errors` : ""}`
                  );
                }
              }
            } catch (err) {
              api.logger.warn(`memex: background indexing failed: ${String(err)}`);
            }
          };

          // Fire-and-forget initial indexing
          void runDocIndex();

          // Periodic re-indexing (default: every 30 minutes, 0 = disabled)
          const reindexMinutes = config.documents.reindexIntervalMinutes ?? 30;
          if (reindexMinutes > 0) {
            reindexTimer = setInterval(() => void runDocIndex(true), reindexMinutes * 60_000);
          }
        }

        api.logger.info(
          `memex: document search enabled (db: ${unifiedDbFile}, paths: ${docPaths.map(p => p.name).join(", ")})`
        );
      } catch (err) {
        api.logger.warn(`memex: document initialization failed (document search disabled): ${String(err)}`);
      }
    }

    // ========================================================================
    // Create Unified Retriever (single-pass pipeline)
    // ========================================================================

    // Build document search function for UnifiedRetriever
    // Always provide the function — it calls initStores() lazily inside
    const documentSearchFn = async (
      query: string,
      queryVec: number[],
      limit: number,
      collection?: string
    ): Promise<DocumentCandidate[]> => {
      const ss = getSearchStore();
      const db = ss.db;

      // FTS search (uses both documents_fts and sections_fts)
      const ftsResults = searchFTS(db, query, limit, collection);

      // Vector search with pre-computed embedding
      const embeddingModel = config.embedding.model || "text-embedding-3-small";
      const vecResults = await ss.searchVec(query, embeddingModel, limit, collection, undefined, queryVec);

      // Merge: take best score per filepath
      const resultMap = new Map<string, any>();
      for (const r of ftsResults) {
        resultMap.set(r.filepath, r);
      }
      for (const r of vecResults) {
        const existing = resultMap.get(r.filepath);
        if (!existing || r.score > existing.score) {
          resultMap.set(r.filepath, r);
        }
      }

      // Map to DocumentCandidate
      return Array.from(resultMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(r => ({
          filepath: r.filepath,
          displayPath: r.displayPath,
          title: r.title,
          body: r.body || "",
          bestChunk: r.body?.slice(0, 500) || "",
          bestChunkPos: r.chunkPos || 0,
          score: r.score,
          docid: r.docid || "",
          context: r.context || null,
        }));
    };

    // Create unified retriever (replaces dual-pipeline)
    const unifiedRetriever = new UnifiedRetriever(
      store,
      documentSearchFn,
      embedder,
      {
        reranker: (config.reranker?.enabled !== false && config.reranker?.endpoint) ? {
          endpoint: config.reranker.endpoint,
          apiKey: config.reranker.apiKey ? resolveEnvVars(config.reranker.apiKey) : "unused",
          model: config.reranker.model || "bge-reranker-v2-m3-Q8_0",
          provider: config.reranker.provider || "jina",
        } : null,
        queryExpansion: false,
      }
    );

    api.logger.info(
      `memex@${pluginVersion}: plugin registered (db: ${resolvedDbPath}, model: ${config.embedding.model || "text-embedding-3-small"}, documents: ${unifiedRecall.hasDocumentSearch ? "enabled" : "disabled"})`
    );

    // Config warnings
    if (!isCli) {
      const recallLimit = config.autoRecallLimit ?? 3;
      if (recallLimit === 1 && !(config.reranker?.enabled)) {
        api.logger.warn("memex: autoRecallLimit=1 without reranker — R@1=78%. Enable reranker for better precision.");
      }
      if (recallLimit > 5) {
        api.logger.warn(`memex: autoRecallLimit=${recallLimit} — R@5=96% already. Higher values increase token usage with no accuracy gain.`);
      }
    }

    // Track startup telemetry (fire-and-forget)
    if (!isCli) {
      (async () => {
        let memoryCount = 0;
        try { memoryCount = (await store.stats()).totalCount; } catch {}
        track("plugin_registered", {
          version: pluginVersion,
          vectorDim,
          documentsEnabled: unifiedRecall.hasDocumentSearch,
          autoRecall: config.autoRecall !== false,
          memoryCount,
        });
      })().catch(() => {});
    }

    // ========================================================================
    // Register Tools
    // ========================================================================

    registerAllMemoryTools(
      api,
      {
        retriever,
        store,
        scopeManager,
        embedder,
        agentId: undefined,
        unifiedRecall,
        unifiedRetriever,
        track,
      },
      {
        enableManagementTools: config.enableManagementTools,
      }
    );

    // ========================================================================
    // Register CLI Commands
    // ========================================================================

    api.registerCli(
      createMemoryCLI({
        store,
        retriever,
        scopeManager,
        embedder,
        unifiedRetriever,
        searchDb: searchStoreRef?.db,
        docPaths: docPaths.length > 0 ? docPaths : undefined,
        searchDimensions: searchDims || undefined,
        generationConfig: config.generation?.model ? {
          baseURL: config.generation.baseURL || config.embedding.baseURL || "",
          apiKey: config.generation.apiKey ? resolveEnvVars(config.generation.apiKey) : undefined,
          model: config.generation.model,
        } : undefined,
      }),
      { commands: ["memex"] }
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // Cross-turn recall tracking: avoid returning the same memories every turn
    // Maps agentId → last N turns of recalled memory IDs
    const recentRecalls = new Map<string, string[][]>();
    const RECALL_HISTORY_TURNS = 5;

    // Auto-recall: inject relevant memories before agent starts
    // Default ON — LLM needs recalled context to make good memory decisions.
    if (config.autoRecall !== false) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || shouldSkipRetrieval(event.prompt, config.autoRecallMinLength)) {
          return;
        }

        try {
          const recallStart = Date.now();
          // Determine agent ID and accessible scopes
          const agentId = ctx?.agentId || "main";

          // Skip recall for agents not in the whitelist (if configured)
          const recallAgents = config.autoRecallAgents as string[] | undefined;
          if (recallAgents && recallAgents.length > 0 && !recallAgents.includes(agentId)) {
            return;
          }
          // Spread to avoid mutating scope manager's internal array
          const accessibleScopes = [...scopeManager.getAccessibleScopes(agentId)];

          // Include current session scope so the agent sees its own session's memories
          const sessionScope = ctx?.sessionKey || ctx?.sessionId;
          if (sessionScope) {
            accessibleScopes.push(`session:${sessionScope}`);
          }

          // Build recentlyRecalled set from last N turns for diversity
          const agentHistory = recentRecalls.get(agentId) || [];
          const recentlyRecalled = new Set<string>();
          for (const turnIds of agentHistory) {
            for (const id of turnIds) recentlyRecalled.add(id);
          }

          // Use unified recall (memory + docs) when available, fallback to memory-only
          let memoryContext: string;
          let resultCount = 0;
          const recalledIds: string[] = [];
          if (unifiedRecall.hasDocumentSearch) {
            // Filter document to current agent's workspace collection to prevent cross-agent context pollution
            const docCollection = (config.autoRecallDocFilter !== false && ctx?.workspaceDir)
              ? workspaceToCollection.get(ctx.workspaceDir)
              : undefined;

            const results = await unifiedRecall.recall(event.prompt, {
              limit: config.autoRecallLimit ?? 3,
              scopeFilter: accessibleScopes,
              collection: docCollection,
              recentlyRecalled,
            });

            if (results.length === 0) {
              return;
            }
            resultCount = results.length;
            for (const r of results) recalledIds.push(r.id);

            memoryContext = results
              .map((r) => {
                if (r.source === "conversation") {
                  const meta = r.metadata as { category?: string; scope?: string };
                  return `- [memory:${meta.category || "other"}:${meta.scope || "global"}] ${sanitizeForContext(r.text)} (${(r.score * 100).toFixed(0)}%)`;
                } else {
                  const meta = r.metadata as { displayPath?: string; title?: string };
                  return `- [doc:${meta.displayPath || "unknown"}] ${sanitizeForContext(r.text)} (${(r.score * 100).toFixed(0)}%)`;
                }
              })
              .join("\n");
          } else {
            const results = await retriever.retrieve({
              query: event.prompt,
              limit: config.autoRecallLimit ?? 3,
              scopeFilter: accessibleScopes,
              recentlyRecalled,
            });

            if (results.length === 0) {
              return;
            }
            resultCount = results.length;
            for (const r of results) recalledIds.push(r.entry.id);

            memoryContext = results
              .map((r) => `- [${r.entry.category}:${r.entry.scope}] ${sanitizeForContext(r.entry.text)} (${(r.score * 100).toFixed(0)}%${r.sources?.bm25 ? ', vector+BM25' : ''}${r.sources?.reranked ? '+reranked' : ''})`)
              .join("\n");
          }

          // Record recalled IDs for cross-turn diversity
          if (recalledIds.length > 0) {
            const history = recentRecalls.get(agentId) || [];
            history.push(recalledIds);
            if (history.length > RECALL_HISTORY_TURNS) history.shift();
            recentRecalls.set(agentId, history);
            // Also record recall frequency in retriever
            retriever.recordRecall(recalledIds);
          }

          api.logger.info?.(
            `memex: injecting ${resultCount} memories into context for agent ${agentId}`
          );

          track("recall", { results: resultCount, latency_ms: Date.now() - recallStart, source: "auto" });

          return {
            prependContext: buildRecallContext(memoryContext),
          };
        } catch (err) {
          track("error", { operation: "auto_recall", message: String(err) });
          api.logger.warn(`memex: recall failed: ${String(err)}`);
        }
      });
    }

    // Memory instruction: inject into system prompt every turn
    if (config.memoryInstructions !== "off") {
      api.on("before_prompt_build", async () => {
        return {
          appendSystemContext: `<memory-instructions>\n${MEMORY_INSTRUCTION}\n</memory-instructions>`,
        };
      });
    }

    // Embedding mismatch warning: inject into agent context so user is informed
    if (embeddingMismatchWarning) {
      api.on("before_prompt_build", async () => {
        // Clear warning once re-embed completes (check live state)
        if (!store.needsReEmbed(embeddingModel)) {
          embeddingMismatchWarning = null;
          return {};
        }
        return {
          prependContext: `<system-warning>\n${embeddingMismatchWarning}\n</system-warning>`,
        };
      });
    }

    // Auto-capture removed — LLM-driven storage via memory_store tool is preferred.
    // Future: compaction-based extraction via session_before_compact hook.

    // ========================================================================
    // Session Memory Hook (replaces built-in session-memory)
    // ========================================================================

    // sessionMemory: deprecated and removed. Session summaries polluted retrieval quality.

    // ========================================================================
    // Auto-Backup (daily JSONL export)
    // ========================================================================

    let backupTimer: ReturnType<typeof setInterval> | null = null;
    const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

    async function runBackup() {
      try {
        const backupDir = api.resolvePath(join(resolvedDbPath, "..", "backups"));
        await mkdir(backupDir, { recursive: true });

        const allMemories = await store.list(undefined, undefined, 10000, 0);
        if (allMemories.length === 0) return;

        const dateStr = new Date().toISOString().split("T")[0];
        const backupFile = join(backupDir, `memory-backup-${dateStr}.jsonl`);

        const lines = allMemories.map(m => JSON.stringify({
          id: m.id,
          text: m.text,
          category: m.category,
          scope: m.scope,
          importance: m.importance,
          timestamp: m.timestamp,
          metadata: m.metadata,
        }));

        await writeFile(backupFile, lines.join("\n") + "\n");

        // Keep only last 7 backups
        const files = (await readdir(backupDir)).filter(f => f.startsWith("memory-backup-") && f.endsWith(".jsonl")).sort();
        if (files.length > 7) {
          const { unlink } = await import("node:fs/promises");
          for (const old of files.slice(0, files.length - 7)) {
            await unlink(join(backupDir, old)).catch(() => { });
          }
        }

        api.logger.info(`memex: backup completed (${allMemories.length} entries → ${backupFile})`);
      } catch (err) {
        api.logger.warn(`memex: backup failed: ${String(err)}`);
      }
    }

    // ========================================================================
    // Service Registration
    // ========================================================================

    api.registerService({
      id: "memex",
      start: async () => {
        // CLI commands are one-shot processes. Never schedule background timers there,
        // or the Node event loop will stay alive after command output is printed.
        if (isCli) {
          return;
        }

        // IMPORTANT: Do not block gateway startup on external network calls.
        // If embedding/retrieval tests hang (bad network / slow provider), the gateway
        // may never bind its HTTP port, causing restart timeouts.

        const withTimeout = async <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          });
          try {
            return await Promise.race([p, timeoutPromise]);
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        };

        const runStartupChecks = async () => {
          try {
            // Test components (bounded time)
            const embedTest = await withTimeout(embedder.test(), 8_000, "embedder.test()");
            const retrievalTest = await withTimeout(retriever.test(), 8_000, "retriever.test()");

            api.logger.info(
              `memex: initialized successfully ` +
              `(embedding: ${embedTest.success ? "OK" : "FAIL"}, ` +
              `retrieval: ${retrievalTest.success ? "OK" : "FAIL"}, ` +
              `mode: ${retrievalTest.mode}, ` +
              `FTS: ${retrievalTest.hasFtsSupport ? "enabled" : "disabled"})`
            );

            if (!embedTest.success) {
              api.logger.warn(`memex: embedding test failed: ${embedTest.error}`);
            }
            if (!retrievalTest.success) {
              api.logger.warn(`memex: retrieval test failed: ${retrievalTest.error}`);
            }
          } catch (error) {
            api.logger.warn(`memex: startup checks failed: ${String(error)}`);
          }
        };

        // Fire-and-forget: allow gateway to start serving immediately.
        setTimeout(() => void runStartupChecks(), 0);

        // Run initial backup after a short delay, then schedule daily
        setTimeout(() => void runBackup(), 60_000); // 1 min after start
        backupTimer = setInterval(() => void runBackup(), BACKUP_INTERVAL_MS);

        // Auto-index sessions on startup (if configured)
        if (config.sessionIndexing?.enabled) {
          const runSessionIndex = async () => {
            try {
              const { indexSessions } = await import("./src/session-indexer.js");
              const agentName = config.sessionIndexing!.agent || "main";
              const sessionsDir = join(homedir(), ".openclaw", "agents", agentName, "sessions");

              // If autoIndexOnce, skip if store already has memories
              if (config.sessionIndexing!.autoIndexOnce) {
                const stats = await store.stats();
                if (stats.totalCount > 0) {
                  api.logger.info("memex: session indexing skipped (memories already exist)");
                  return;
                }
              }

              const result = await indexSessions(store, embedder, {
                sessionsDir,
                targetScope: config.sessionIndexing!.scope || scopeManager.getDefaultScope(),
                minImportance: config.sessionIndexing!.minImportance ?? 0.1,
              });

              api.logger.info(
                `memex: session indexing complete — ` +
                `${result.indexedTurns} indexed from ${result.totalSessions - result.skippedSessions} sessions`
              );
            } catch (err) {
              api.logger.warn(`memex: session indexing failed: ${String(err)}`);
            }
          };
          // Delay to not block startup
          setTimeout(() => void runSessionIndex(), 5_000);
        }

        // Store health check: detect and auto-fix data issues on startup
        const runHealthCheck = async () => {
          // --- Memory store: noise detection + auto-purge ---
          try {
            const allEntries = await store.list(undefined, undefined, 10000, 0);
            if (allEntries.length > 0) {
              const noiseEntries = identifyNoiseEntries(allEntries);
              if (noiseEntries.length > 0) {
                const pct = ((noiseEntries.length / allEntries.length) * 100).toFixed(1);
                const structural = noiseEntries.filter(e => e.reason === "structural").length;
                const semantic = noiseEntries.filter(e => e.reason === "semantic").length;

                api.logger.warn(
                  `memex: store health — ${noiseEntries.length}/${allEntries.length} entries (${pct}%) are noise ` +
                  `(${structural} structural, ${semantic} semantic). ` +
                  (config.autoFixNoise
                    ? `Auto-fix enabled, purging...`
                    : `Run "openclaw memex purge-noise" to clean, or set autoFixNoise: true in config.`)
                );

                if (config.autoFixNoise) {
                  let purged = 0;
                  for (const entry of noiseEntries) {
                    const ok = await store.delete(entry.id);
                    if (ok) purged++;
                  }
                  api.logger.info(`memex: auto-fix purged ${purged}/${noiseEntries.length} noise entries`);
                }
              }
            }
          } catch (err) {
            api.logger.warn(`memex: memory store health check failed: ${String(err)}`);
          }

          // --- document: orphan cleanup + pending embedding recovery ---
          if (searchStoreRef) {
            try {
              const db = searchStoreRef.db;

              // Clean orphaned content and vectors (files removed but data lingering)
              const orphanedContent = searchStoreRef.cleanupOrphanedContent();
              const orphanedVectors = searchStoreRef.cleanupOrphanedVectors();
              if (orphanedContent > 0 || orphanedVectors > 0) {
                api.logger.info(
                  `memex: document cleanup — removed ${orphanedContent} orphaned content, ${orphanedVectors} orphaned vectors`
                );
              }

              // Auto-embed any documents that were indexed but not yet embedded
              // (e.g. gateway crashed mid-embed, or embedding model was down)
              const pending = getEmbeddingBacklog(db);
              if (pending > 0) {
                api.logger.info(`memex: document recovery — ${pending} docs indexed but not embedded, embedding now...`);
                const result = await embedDocuments(db, searchDims);
                api.logger.info(
                  `memex: document recovery — embedded ${result.embedded} docs (${result.chunks} chunks)` +
                  (result.errors.length > 0 ? `, ${result.errors.length} errors` : "")
                );
              }
            } catch (err) {
              api.logger.warn(`memex: document health check failed: ${String(err)}`);
            }
          }
        };
        // Delay health check to not block startup (after background indexing)
        setTimeout(() => void runHealthCheck(), 15_000);
      },
      stop: async () => {
        if (backupTimer) {
          clearInterval(backupTimer);
          backupTimer = null;
        }
        if (reindexTimer) {
          clearInterval(reindexTimer);
          reindexTimer = null;
        }
        // Dispose document LLM resources
        try {
          await disposeDefaultLlamaCpp();
        } catch { /* ignore */ }
        // Close document database
        try {
          if (searchStoreRef) searchStoreRef.close();
        } catch { /* ignore */ }
        api.logger.info("memex: stopped");
      },
    });
  },

};

function parsePluginConfig(value: unknown): PluginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("memex config required");
  }
  const cfg = value as Record<string, unknown>;

  const embedding = cfg.embedding as Record<string, unknown> | undefined;
  if (!embedding) {
    throw new Error("embedding config is required");
  }

  const apiKey = typeof embedding.apiKey === "string"
    ? embedding.apiKey
    : process.env.OPENAI_API_KEY || "";

  if (!apiKey) {
    throw new Error("embedding.apiKey is required (set directly or via OPENAI_API_KEY env var)");
  }

  // Parse reranker config
  const rerankerRaw = cfg.reranker as Record<string, unknown> | undefined;
  const reranker = rerankerRaw ? {
    enabled: rerankerRaw.enabled !== false,
    endpoint: typeof rerankerRaw.endpoint === "string" ? rerankerRaw.endpoint : undefined,
    apiKey: typeof rerankerRaw.apiKey === "string" ? rerankerRaw.apiKey : undefined,
    model: typeof rerankerRaw.model === "string" ? rerankerRaw.model : undefined,
    provider: typeof rerankerRaw.provider === "string" ? rerankerRaw.provider : undefined,
  } : undefined;

  // Parse documents config
  const docsRaw = cfg.documents as Record<string, unknown> | undefined;
  const documents = docsRaw ? {
    enabled: docsRaw.enabled !== false,
    dbPath: typeof docsRaw.dbPath === "string" ? docsRaw.dbPath : undefined,
    paths: Array.isArray(docsRaw.paths) ? docsRaw.paths as Array<{ path: string; name: string; pattern?: string }> : undefined,
    queryExpansion: docsRaw.queryExpansion === true,
    reindexIntervalMinutes: typeof docsRaw.reindexIntervalMinutes === "number" ? docsRaw.reindexIntervalMinutes : undefined,
  } : undefined;

  // Parse generation config
  const genRaw = cfg.generation as Record<string, unknown> | undefined;
  const generation = genRaw ? {
    baseURL: typeof genRaw.baseURL === "string" ? genRaw.baseURL : undefined,
    apiKey: typeof genRaw.apiKey === "string" ? genRaw.apiKey : undefined,
    model: typeof genRaw.model === "string" ? genRaw.model : undefined,
  } : undefined;

  return {
    embedding: {
      provider: "openai-compatible",
      apiKey,
      model: typeof embedding.model === "string" ? embedding.model : "text-embedding-3-small",
      baseURL: typeof embedding.baseURL === "string" ? resolveEnvVars(embedding.baseURL) : undefined,
      dimensions: parsePositiveInt(embedding.dimensions ?? cfg.dimensions),
      taskQuery: typeof embedding.taskQuery === "string" ? embedding.taskQuery : undefined,
      taskPassage: typeof embedding.taskPassage === "string" ? embedding.taskPassage : undefined,
      normalized: typeof embedding.normalized === "boolean" ? embedding.normalized : undefined,
      chunking: typeof embedding.chunking === "boolean" ? embedding.chunking : undefined,
    },
    dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : undefined,
    autoRecall: cfg.autoRecall !== false,
    autoRecallAgents: Array.isArray(cfg.autoRecallAgents) ? cfg.autoRecallAgents as string[] : undefined,
    autoRecallLimit: parsePositiveInt(cfg.autoRecallLimit),
    autoRecallMinLength: parsePositiveInt(cfg.autoRecallMinLength),
    autoRecallDocFilter: cfg.autoRecallDocFilter !== false,
    autoFixNoise: cfg.autoFixNoise === true,
    retrieval: typeof cfg.retrieval === "object" && cfg.retrieval !== null ? cfg.retrieval as any : undefined,
    scopes: typeof cfg.scopes === "object" && cfg.scopes !== null ? cfg.scopes as any : undefined,
    enableManagementTools: cfg.enableManagementTools === true,
    sessionMemory: typeof cfg.sessionMemory === "object" && cfg.sessionMemory !== null
      ? {
        enabled: (cfg.sessionMemory as Record<string, unknown>).enabled !== false,
        messageCount: typeof (cfg.sessionMemory as Record<string, unknown>).messageCount === "number"
          ? (cfg.sessionMemory as Record<string, unknown>).messageCount as number
          : undefined,
      }
      : undefined,
    reranker,
    documents,
    generation,
    sessionIndexing: typeof cfg.sessionIndexing === "object" && cfg.sessionIndexing !== null
      ? {
        enabled: (cfg.sessionIndexing as Record<string, unknown>).enabled === true,
        agent: typeof (cfg.sessionIndexing as Record<string, unknown>).agent === "string"
          ? (cfg.sessionIndexing as Record<string, unknown>).agent as string : undefined,
        scope: typeof (cfg.sessionIndexing as Record<string, unknown>).scope === "string"
          ? (cfg.sessionIndexing as Record<string, unknown>).scope as string : undefined,
        minImportance: typeof (cfg.sessionIndexing as Record<string, unknown>).minImportance === "number"
          ? (cfg.sessionIndexing as Record<string, unknown>).minImportance as number : undefined,
        autoIndexOnce: (cfg.sessionIndexing as Record<string, unknown>).autoIndexOnce !== false,
      }
      : undefined,
  };
}

export default memoryUnifiedPlugin;
