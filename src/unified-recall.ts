/**
 * Unified Recall Pipeline
 *
 * Fans out search queries to both conversation memory (LanceDB Pro) and
 * document search (QMD) in parallel, normalizes scores, merges results
 * with source attribution, and optionally applies a shared reranking pass.
 */

import type { Embedder } from "./embedder.js";
import type { MemoryRetriever, RetrievalResult } from "./retriever.js";
import { buildRerankRequest, parseRerankResponse } from "./retriever.js";
import type { RerankProvider } from "./retriever.js";

// QMD store type — imported dynamically to avoid hard dependency
type QmdStore = {
  searchFTS: (query: string, limit?: number, collectionName?: string) => any[];
  searchVec: (query: string, model: string, limit?: number, collectionName?: string, session?: any, precomputedEmbedding?: number[]) => Promise<any[]>;
};
type QmdHybridQuery = (store: QmdStore, query: string, options?: any) => Promise<QmdHybridResult[]>;

interface QmdHybridResult {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  bestChunk: string;
  bestChunkPos: number;
  score: number;
  context: string | null;
  docid: string;
}

// =============================================================================
// Types
// =============================================================================

export type ResultSource = "conversation" | "document";

export interface UnifiedResult {
  /** Unique identifier */
  id: string;
  /** Display text / content */
  text: string;
  /** Relevance score (0-1, normalized) */
  score: number;
  /** Where this result came from */
  source: ResultSource;
  /** Original score before normalization */
  rawScore: number;
  /** Source-specific metadata */
  metadata: ConversationMeta | DocumentMeta;
}

interface ConversationMeta {
  type: "conversation";
  category: string;
  scope: string;
  importance: number;
  timestamp: number;
  memoryId: string;
  /** Retrieval source breakdown from LanceDB Pro pipeline */
  sources?: RetrievalResult["sources"];
}

interface DocumentMeta {
  type: "document";
  file: string;
  displayPath: string;
  title: string;
  bestChunk: string;
  context: string | null;
  docid: string;
}

export interface RerankConfig {
  provider: RerankProvider;
  apiKey: string;
  model: string;
  endpoint: string;
}

export interface UnifiedRecallConfig {
  /** Max results to return (default: 10) */
  limit: number;
  /** Min score threshold after normalization (default: 0.2) */
  minScore: number;
  /** Weight for conversation results in final blend (default: 0.5) */
  conversationWeight: number;
  /** Weight for document results in final blend (default: 0.5) */
  documentWeight: number;
  /** Whether to apply shared reranking across both sources (default: false) */
  crossRerank: boolean;
  /** Reranker config — required when crossRerank is true */
  rerankConfig?: RerankConfig;
  /** If true, run sources sequentially: skip document search when
   *  conversation results are strong enough (all scores > highConfidenceThreshold).
   *  Saves ~200ms latency on queries that clearly match memories. (default: false) */
  earlyTermination: boolean;
  /** Score threshold above which all conversation results are "strong enough"
   *  to skip document search. (default: 0.6) */
  highConfidenceThreshold: number;
}

export const DEFAULT_UNIFIED_CONFIG: UnifiedRecallConfig = {
  limit: 10,
  minScore: 0.2,
  conversationWeight: 0.5,
  documentWeight: 0.5,
  crossRerank: false,
  earlyTermination: false,
  highConfidenceThreshold: 0.6,
};

// =============================================================================
// Unified Recall
// =============================================================================

export type LogFn = (message: string) => void;

export class UnifiedRecall {
  private retriever: MemoryRetriever;
  private embedder: Embedder;
  private qmdStore: QmdStore | null = null;
  private qmdHybridQuery: QmdHybridQuery | null = null;
  private qmdEmbedModel: string = "";
  private config: UnifiedRecallConfig;
  private _lastQuery: string = "";
  private warn: LogFn;

  constructor(
    retriever: MemoryRetriever,
    embedder: Embedder,
    config: Partial<UnifiedRecallConfig> = {},
    logger?: { warn: LogFn }
  ) {
    this.retriever = retriever;
    this.embedder = embedder;
    this.config = { ...DEFAULT_UNIFIED_CONFIG, ...config };
    this.warn = logger?.warn ?? console.warn.bind(console);
  }

  /**
   * Connect QMD store for document search.
   * Called during plugin initialization when documents are enabled.
   */
  setQmdStore(store: QmdStore, hybridQueryFn: QmdHybridQuery, embedModel: string): void {
    this.qmdStore = store;
    this.qmdHybridQuery = hybridQueryFn;
    this.qmdEmbedModel = embedModel;
  }

  get hasDocumentSearch(): boolean {
    return this.qmdStore !== null && this.qmdHybridQuery !== null;
  }

  /**
   * Recall from both conversation memory and document search.
   */
  async recall(
    query: string,
    options: {
      limit?: number;
      scopeFilter?: string[];
      category?: string;
      sources?: ResultSource[];
    } = {}
  ): Promise<UnifiedResult[]> {
    this._lastQuery = query;
    const limit = options.limit ?? this.config.limit;
    const wantConversation = !options.sources || options.sources.includes("conversation");
    const wantDocuments = !options.sources || options.sources.includes("document");

    let conversationResults: UnifiedResult[] = [];
    let documentResults: UnifiedResult[] = [];

    const convOpts = {
      limit: Math.ceil(limit * 1.5), // over-fetch for merge
      scopeFilter: options.scopeFilter,
      category: options.category,
    };

    // Early termination: try conversation first, skip documents if results are strong
    if (this.config.earlyTermination && wantConversation && wantDocuments && this.hasDocumentSearch) {
      conversationResults = await this.recallConversation(query, convOpts);
      const strongEnough = conversationResults.length >= limit
        && conversationResults.slice(0, limit).every(
          (r) => r.rawScore >= this.config.highConfidenceThreshold
        );
      if (!strongEnough) {
        documentResults = await this.recallDocuments(query, { limit: Math.ceil(limit * 1.5) });
      }
    } else {
      // Default: fan out to both stores in parallel
      [conversationResults, documentResults] = await Promise.all([
        wantConversation
          ? this.recallConversation(query, convOpts)
          : [],
        wantDocuments && this.hasDocumentSearch
          ? this.recallDocuments(query, { limit: Math.ceil(limit * 1.5) })
          : [],
      ]);
    }

    // Merge and rank (async when cross-source reranking is enabled)
    const merged = await this.mergeResults(conversationResults, documentResults);

    // Apply min score filter and limit
    return merged
      .filter((r) => r.score >= this.config.minScore)
      .slice(0, limit);
  }

  /**
   * Recall only from conversation memory (for backward compat).
   */
  async recallConversationOnly(
    query: string,
    options: {
      limit?: number;
      scopeFilter?: string[];
      category?: string;
    } = {}
  ): Promise<RetrievalResult[]> {
    return this.retriever.retrieve({
      query,
      limit: options.limit ?? 5,
      scopeFilter: options.scopeFilter,
      category: options.category,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: conversation recall
  // ---------------------------------------------------------------------------

  private async recallConversation(
    query: string,
    options: { limit: number; scopeFilter?: string[]; category?: string }
  ): Promise<UnifiedResult[]> {
    const results = await this.retriever.retrieve({
      query,
      limit: options.limit,
      scopeFilter: options.scopeFilter,
      category: options.category,
    });

    return results.map((r) => ({
      id: r.entry.id,
      text: r.entry.text,
      score: r.score,
      rawScore: r.score,
      source: "conversation" as const,
      metadata: {
        type: "conversation" as const,
        category: r.entry.category || "other",
        scope: r.entry.scope || "global",
        importance: r.entry.importance ?? 0.7,
        timestamp: r.entry.timestamp,
        memoryId: r.entry.id,
        sources: r.sources,
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // Internal: document recall
  // ---------------------------------------------------------------------------

  private async recallDocuments(
    query: string,
    options: { limit: number }
  ): Promise<UnifiedResult[]> {
    if (!this.qmdStore || !this.qmdHybridQuery) return [];

    try {
      const results = await this.qmdHybridQuery(this.qmdStore as any, query, {
        limit: options.limit,
        minScore: 0,
      });

      return results.map((r) => ({
        id: r.docid,
        text: r.bestChunk || r.body.slice(0, 500),
        score: r.score,
        rawScore: r.score,
        source: "document" as const,
        metadata: {
          type: "document" as const,
          file: r.file,
          displayPath: r.displayPath,
          title: r.title,
          bestChunk: r.bestChunk,
          context: r.context,
          docid: r.docid,
        },
      }));
    } catch (error) {
      this.warn(`Document recall error: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: merge results from both sources
  // ---------------------------------------------------------------------------

  private async mergeResults(
    conversation: UnifiedResult[],
    documents: UnifiedResult[]
  ): Promise<UnifiedResult[]> {
    // Normalize scores within each source to [0, 1]
    const normConv = this.normalizeScores(conversation);
    const normDocs = this.normalizeScores(documents);

    // Apply source weights
    const weighted = [
      ...normConv.map((r) => ({
        ...r,
        score: r.score * this.config.conversationWeight,
      })),
      ...normDocs.map((r) => ({
        ...r,
        score: r.score * this.config.documentWeight,
      })),
    ];

    // Cross-source reranking: use a single cross-encoder pass across all results
    if (this.config.crossRerank && this.config.rerankConfig && weighted.length > 1) {
      const reranked = await this.crossEncoderRerank(weighted);
      if (reranked) return reranked;
      // Fall through to score-based sort on failure
    }

    // Sort by weighted score descending
    weighted.sort((a, b) => b.score - a.score);

    return weighted;
  }

  /**
   * Apply cross-encoder reranking across all merged results.
   * Returns null on failure (caller falls back to score-based sort).
   */
  private async crossEncoderRerank(
    results: UnifiedResult[]
  ): Promise<UnifiedResult[] | null> {
    const cfg = this.config.rerankConfig;
    if (!cfg) return null;

    try {
      const documents = results.map((r) => r.text);

      // Build provider-specific request
      const { headers, body } = buildRerankRequest(
        cfg.provider,
        cfg.apiKey,
        cfg.model,
        this._lastQuery,
        documents,
        results.length
      );

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(cfg.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) return null;

      const data = (await response.json()) as Record<string, unknown>;
      const parsed = parseRerankResponse(cfg.provider, data);
      if (!parsed) return null;

      // Blend: 60% cross-encoder score + 40% original weighted score
      const reranked = parsed
        .filter((item) => item.index >= 0 && item.index < results.length)
        .map((item) => {
          const original = results[item.index];
          const blended = Math.min(1, Math.max(0, item.score * 0.6 + original.score * 0.4));
          return { ...original, score: blended };
        });

      // Include unreturned results with penalized scores
      const returnedIndices = new Set(parsed.map((r) => r.index));
      const unreturned = results
        .filter((_, idx) => !returnedIndices.has(idx))
        .map((r) => ({ ...r, score: r.score * 0.8 }));

      return [...reranked, ...unreturned].sort((a, b) => b.score - a.score);
    } catch {
      return null;
    }
  }

  /**
   * Min-max normalize scores within a result set.
   * If all scores are equal, assigns 1.0 to all.
   */
  private normalizeScores(results: UnifiedResult[]): UnifiedResult[] {
    if (results.length === 0) return [];

    const scores = results.map((r) => r.rawScore);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;

    if (range === 0) {
      return results.map((r) => ({ ...r, score: 1.0 }));
    }

    return results.map((r) => ({
      ...r,
      score: (r.rawScore - min) / range,
    }));
  }
}
