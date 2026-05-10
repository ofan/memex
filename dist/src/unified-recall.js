/**
 * Unified Recall Pipeline
 *
 * Fans out search queries to both conversation memory and
 * document search (QMD) in parallel, normalizes scores, merges results
 * with source attribution, and optionally applies a shared reranking pass.
 */
import { buildRerankRequest, parseRerankResponse } from "./retriever.js";
export const DEFAULT_UNIFIED_CONFIG = {
    limit: 10,
    minScore: 0.2,
    conversationWeight: 0.5,
    documentWeight: 0.5,
    crossRerank: false,
    earlyTermination: false,
    highConfidenceThreshold: 0.6,
};
export class UnifiedRecall {
    retriever;
    embedder;
    searchStore = null;
    hybridQuery = null;
    searchEmbedModel = "";
    config;
    _lastQuery = "";
    warn;
    constructor(retriever, embedder, config = {}, logger) {
        this.retriever = retriever;
        this.embedder = embedder;
        this.config = { ...DEFAULT_UNIFIED_CONFIG, ...config };
        this.warn = logger?.warn ?? console.warn.bind(console);
    }
    /**
     * Connect QMD store for document search.
     * Called during plugin initialization when documents are enabled.
     */
    setSearchStore(store, hybridQueryFn, embedModel) {
        this.searchStore = store;
        this.hybridQuery = hybridQueryFn;
        this.searchEmbedModel = embedModel;
    }
    get hasDocumentSearch() {
        return this.searchStore !== null && this.hybridQuery !== null;
    }
    /**
     * Recall from both conversation memory and document search.
     */
    async recall(query, options = {}) {
        this._lastQuery = query;
        const limit = options.limit ?? this.config.limit;
        const wantConversation = !options.sources || options.sources.includes("conversation");
        const wantDocuments = !options.sources || options.sources.includes("document");
        let conversationResults = [];
        let documentResults = [];
        const convOpts = {
            limit: Math.ceil(limit * 1.5), // over-fetch for merge
            scopeFilter: options.scopeFilter,
            category: options.category,
            recentlyRecalled: options.recentlyRecalled,
        };
        // Early termination: try conversation first, skip documents if results are strong
        if (this.config.earlyTermination && wantConversation && wantDocuments && this.hasDocumentSearch) {
            conversationResults = await this.recallConversation(query, convOpts);
            const strongEnough = conversationResults.length >= limit
                && conversationResults.slice(0, limit).every((r) => r.rawScore >= this.config.highConfidenceThreshold);
            if (!strongEnough) {
                documentResults = await this.recallDocuments(query, { limit: Math.ceil(limit * 1.5), collection: options.collection });
            }
        }
        else {
            // Default: fan out to both stores in parallel
            [conversationResults, documentResults] = await Promise.all([
                wantConversation
                    ? this.recallConversation(query, convOpts)
                    : [],
                wantDocuments && this.hasDocumentSearch
                    ? this.recallDocuments(query, { limit: Math.ceil(limit * 1.5), collection: options.collection })
                    : [],
            ]);
        }
        // Merge and rank (async when cross-source reranking is enabled)
        const merged = await this.mergeResults(conversationResults, documentResults);
        // Guarantee at least the top result from each source survives filtering.
        // This prevents one source from completely drowning out the other.
        const topConv = merged.find(r => r.source === "conversation");
        const topDoc = merged.find(r => r.source === "document");
        const protected_ = new Set();
        if (topConv)
            protected_.add(topConv.id);
        if (topDoc)
            protected_.add(topDoc.id);
        // Apply min score filter (but protect top result from each source)
        return merged
            .filter((r) => r.score >= this.config.minScore || protected_.has(r.id))
            .slice(0, limit);
    }
    // ---------------------------------------------------------------------------
    // Internal: conversation recall
    // ---------------------------------------------------------------------------
    async recallConversation(query, options) {
        const results = await this.retriever.retrieve({
            query,
            limit: options.limit,
            scopeFilter: options.scopeFilter,
            category: options.category,
            recentlyRecalled: options.recentlyRecalled,
        });
        return results.map((r) => ({
            id: r.entry.id,
            text: r.entry.text,
            score: r.score,
            rawScore: r.score,
            source: "conversation",
            metadata: {
                type: "conversation",
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
    async recallDocuments(query, options) {
        if (!this.searchStore || !this.hybridQuery)
            return [];
        try {
            const results = await this.hybridQuery(this.searchStore, query, {
                limit: options.limit,
                minScore: 0,
                collection: options.collection,
            });
            return results.map((r) => ({
                id: r.docid,
                text: r.bestChunk || r.body.slice(0, 500),
                score: r.score,
                rawScore: r.score,
                source: "document",
                metadata: {
                    type: "document",
                    file: r.file,
                    displayPath: r.displayPath,
                    title: r.title,
                    bestChunk: r.bestChunk,
                    context: r.context,
                    docid: r.docid,
                },
            }));
        }
        catch (error) {
            this.warn(`Document recall error: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }
    // ---------------------------------------------------------------------------
    // Internal: merge results from both sources
    // ---------------------------------------------------------------------------
    async mergeResults(conversation, documents) {
        // Use raw scores directly — both sources already normalize to [0, 1].
        // Min-max normalization was destroying scores for tightly clustered results
        // (e.g. [0.92, 0.83, 0.79] → [1.0, 0.31, 0.0] which is wrong).
        // Apply source weights to raw scores.
        const weighted = [
            ...conversation.map((r) => ({
                ...r,
                score: r.rawScore * this.config.conversationWeight,
            })),
            ...documents.map((r) => ({
                ...r,
                score: r.rawScore * this.config.documentWeight,
            })),
        ];
        // Cross-source reranking: use a single cross-encoder pass across all results
        if (this.config.crossRerank && this.config.rerankConfig && weighted.length > 1) {
            const reranked = await this.crossEncoderRerank(weighted);
            if (reranked)
                return reranked;
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
    async crossEncoderRerank(results) {
        const cfg = this.config.rerankConfig;
        if (!cfg)
            return null;
        try {
            const documents = results.map((r) => r.text);
            // Build provider-specific request
            const { headers, body } = buildRerankRequest(cfg.provider, cfg.apiKey, cfg.model, this._lastQuery, documents, results.length);
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(cfg.endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            if (!response.ok)
                return null;
            const data = (await response.json());
            const parsed = parseRerankResponse(cfg.provider, data);
            if (!parsed)
                return null;
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
        }
        catch {
            return null;
        }
    }
    /**
     * Min-max normalize scores within a result set.
     * If all scores are equal, assigns 1.0 to all.
     */
    normalizeScores(results) {
        if (results.length === 0)
            return [];
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
//# sourceMappingURL=unified-recall.js.map