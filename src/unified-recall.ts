/**
 * Unified Recall Pipeline
 *
 * Fans out search queries to both conversation memory (LanceDB Pro) and
 * document search (QMD) in parallel, normalizes scores, merges results
 * with source attribution, and optionally applies a shared reranking pass.
 */

import type { Embedder } from "./embedder.js";
import type { MemoryRetriever, RetrievalResult } from "./retriever.js";

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
}

export const DEFAULT_UNIFIED_CONFIG: UnifiedRecallConfig = {
  limit: 10,
  minScore: 0.2,
  conversationWeight: 0.5,
  documentWeight: 0.5,
  crossRerank: false,
};

// =============================================================================
// Unified Recall
// =============================================================================

export class UnifiedRecall {
  private retriever: MemoryRetriever;
  private embedder: Embedder;
  private qmdStore: QmdStore | null = null;
  private qmdHybridQuery: QmdHybridQuery | null = null;
  private qmdEmbedModel: string = "";
  private config: UnifiedRecallConfig;

  constructor(
    retriever: MemoryRetriever,
    embedder: Embedder,
    config: Partial<UnifiedRecallConfig> = {}
  ) {
    this.retriever = retriever;
    this.embedder = embedder;
    this.config = { ...DEFAULT_UNIFIED_CONFIG, ...config };
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
    const limit = options.limit ?? this.config.limit;
    const wantConversation = !options.sources || options.sources.includes("conversation");
    const wantDocuments = !options.sources || options.sources.includes("document");

    // Fan out to both stores in parallel
    const [conversationResults, documentResults] = await Promise.all([
      wantConversation
        ? this.recallConversation(query, {
            limit: Math.ceil(limit * 1.5), // over-fetch for merge
            scopeFilter: options.scopeFilter,
            category: options.category,
          })
        : [],
      wantDocuments && this.hasDocumentSearch
        ? this.recallDocuments(query, { limit: Math.ceil(limit * 1.5) })
        : [],
    ]);

    // Merge and rank
    const merged = this.mergeResults(conversationResults, documentResults);

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
      console.error("Document recall error:", error);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: merge results from both sources
  // ---------------------------------------------------------------------------

  private mergeResults(
    conversation: UnifiedResult[],
    documents: UnifiedResult[]
  ): UnifiedResult[] {
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

    // Sort by weighted score descending
    weighted.sort((a, b) => b.score - a.score);

    return weighted;
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
