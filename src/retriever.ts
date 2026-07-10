/**
 * Hybrid Retrieval System
 * Combines vector search + BM25 full-text search with RRF fusion
 */

import type { MemoryStore, MemorySearchResult } from "./memory.js";
import type { Embedder } from "./embedder.js";
import { filterNoise } from "./noise-filter.js";
import { Stopwatch } from "./telemetry.js";
import { detectTemporalRange } from "./temporal.js";
import { llmRerank } from "./rerankers/llm-reranker.js";
import { extractEntities, entityOverlap } from "./entities.js";
import { expandOneHop, LINK_SCORE_DISCOUNT_FACTOR } from "./graph.js";
import { withTransientRetry } from "./transient-retry.js";

// ============================================================================
// Types & Configuration
// ============================================================================

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  /** Fusion method: "weighted" (raw score blend) or "zscore" (z-score normalized).
   *  Z-score normalizes each signal's distribution to zero-mean/unit-variance
   *  before combining, preventing BM25-only noise from displacing vector hits.
   *  (default: "weighted") */
  fusionMethod: "weighted" | "zscore";
  minScore: number;
  rerank: "cross-encoder" | "llm" | "lightweight" | "none";
  candidatePoolSize: number;
  /** Recency boost half-life in days (default: 14). Set 0 to disable. */
  recencyHalfLifeDays: number;
  /** Max recency boost factor (default: 0.10) */
  recencyWeight: number;
  /** Filter noise from results (default: true) */
  filterNoise: boolean;
  /** Reranker API key (enables cross-encoder reranking) */
  rerankApiKey?: string;
  /** Reranker model (default: jina-reranker-v3) */
  rerankModel?: string;
  /** Reranker API endpoint (default: https://api.jina.ai/v1/rerank). */
  rerankEndpoint?: string;
  /** Reranker provider format. Determines request/response shape and auth header.
   *  - "jina" (default): Authorization: Bearer, string[] documents, results[].relevance_score
   *  - "siliconflow": same format as jina (alias, for clarity)
   *  - "voyage": Authorization: Bearer, string[] documents, data[].relevance_score
   *  - "pinecone": Api-Key header, {text}[] documents, data[].score */
  rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone";
  /** LLM reranker: OpenAI-compatible chat completions endpoint. */
  rerankLlmEndpoint?: string;
  /** LLM reranker: API key (dummy if proxy doesn't require auth). */
  rerankLlmApiKey?: string;
  /** LLM reranker: model name (e.g. deepseek/deepseek-v4-flash). */
  rerankLlmModel?: string;
  /** LLM reranker: request timeout in ms (default: 30000). */
  rerankLlmTimeoutMs?: number;
  /** LLM reranker: max documents per call (default: 10, max: 20). */
  rerankLlmMaxDocs?: number;
  /**
   * How to interpret the reranker's output score for blending:
   *
   * - "raw" (default): use the raw relevance_score as returned by the reranker.
   *   Works well when the reranker produces a broad score distribution.
   * - "rank": replace the raw score with a rank-normalized value
   *   `1 - (rank - 1) / N` where N is the pool size. Top-1 gets 1.0, top-2
   *   gets 1 - 1/N, etc. Useful when the reranker saturates (all top scores
   *   are near 1.0) and the raw-score differentials get dissolved by the
   *   blend math with the fusion score. Qwen3-Reranker tends to saturate
   *   on short, semantically-similar technical content.
   *
   * Default: "raw" (backward compatible).
   */
  rerankScoreMode?: "raw" | "rank";
  /**
   * Weight given to the cross-encoder rerank score when blending with the
   * original fused score. Final score is:
   *     blended = clamp01(rerankScore * rerankBlendWeight + originalScore * (1 - rerankBlendWeight))
   *
   * Higher (closer to 1) = reranker dominates — good for aggressively demoting
   * reranker-zero candidates but can overrule strong fusion winners when the
   * reranker picks a "defensible but wrong" semantic match.
   *
   * Lower (closer to 0) = fusion score is load-bearing and the reranker only
   * nudges rankings. Protects fusion winners when the reranker is overconfident
   * on short queries but lets obviously irrelevant rerank-zero candidates stick
   * around.
   *
   * Default: 0.8. Tunable via the `MEMEX_RERANK_BLEND_WEIGHT` env var at
   * benchmark/tuning time.
   */
  rerankBlendWeight?: number;
  /**
   * Length normalization: penalize long entries that dominate via sheer keyword
   * density. Formula: score *= 1 / (1 + log2(charLen / anchor)).
   * anchor = reference length (default: 500 chars). Entries shorter than anchor
   * get a slight boost; longer entries get penalized progressively.
   * Set 0 to disable. (default: 300)
   */
  lengthNormAnchor: number;
  /**
   * Enable entity-graph expansion (one-hop through memory_links).
   * Adds linked memories at a discounted score. Disabled by default —
   * measured zero quality impact on domain eval (BM25 + rerank already
   * capture the same signal).
   */
  entityGraph?: boolean;
  /**
   * Enable entity-overlap score boost (ACT-R spreading activation).
   * Disabled by default — BM25 already captures keyword entity matching,
   * and any positive weight hurts domain eval (73-75% vs 80% at 0).
   */
  entityBoost?: boolean;
  /**
   * Hard cutoff after rerank: discard results below this score.
   * Applied after all scoring stages (rerank, recency, importance, length norm).
   * Higher = fewer but more relevant results. (default: 0.40)
   */
  hardMinScore: number;
  /**
   * Time decay half-life in days. Entries older than this lose score.
   * Different from recencyBoost (additive bonus for new entries):
   * this is a multiplicative penalty for old entries.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At halfLife days: ~0.68x. At 2*halfLife: ~0.59x. At 4*halfLife: ~0.52x.
   * Set 0 to disable. (default: 60)
   */
  timeDecayHalfLifeDays: number;
}

export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  /**
   * Explicit scope-tag override — replaces the default active-context set
   * when provided (e.g. from memory_recall's `scopes` parameter).
   * Uses tag-intersection against memory_scopes.
   */
  scopes?: string[];
  category?: string;
  /** IDs recalled in recent turns — these get a diversity penalty */
  recentlyRecalled?: Set<string>;
}

export interface RetrievalResult extends MemorySearchResult {
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  fusionMethod: "weighted",
  minScore: 0.3,
  rerank: "cross-encoder",
  candidatePoolSize: 20,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.10,
  filterNoise: true,
  rerankModel: "jina-reranker-v3",
  rerankEndpoint: "https://api.jina.ai/v1/rerank",
  lengthNormAnchor: 500,
  hardMinScore: 0.15, // F12: wired into applyAdaptiveMinScore. 0.15 preserves pre-fix behavior; raise via MEMEX_HARD_MIN_SCORE_OVERRIDE after F3 calibration.
  timeDecayHalfLifeDays: 60,
};

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback: number = 0): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

// ============================================================================
// Rerank Provider Adapters
// ============================================================================

export type RerankProvider = "jina" | "siliconflow" | "voyage" | "pinecone";

export interface RerankItem { index: number; score: number }

/** Build provider-specific request headers and body */
export function buildRerankRequest(
  provider: RerankProvider,
  apiKey: string,
  model: string,
  query: string,
  documents: string[],
  topN: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  switch (provider) {
    case "pinecone":
      return {
        headers: {
          "Content-Type": "application/json",
          "Api-Key": apiKey,
          "X-Pinecone-API-Version": "2024-10",
        },
        body: {
          model,
          query,
          documents: documents.map(text => ({ text })),
          top_n: topN,
          rank_fields: ["text"],
        },
      };
    case "voyage":
      return {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents,
          // Voyage uses top_k (not top_n) to limit reranked outputs.
          top_k: topN,
        },
      };
    case "siliconflow":
    case "jina":
    default:
      return {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents,
          top_n: topN,
        },
      };
  }
}

/** Parse provider-specific response into unified format */
export function parseRerankResponse(
  provider: RerankProvider,
  data: Record<string, unknown>,
): RerankItem[] | null {
  const parseItems = (
    items: unknown,
    scoreKeys: Array<"score" | "relevance_score">,
  ): RerankItem[] | null => {
    if (!Array.isArray(items)) return null;
    const parsed: RerankItem[] = [];
    for (const raw of items as Array<Record<string, unknown>>) {
      const index = typeof raw?.index === "number" ? raw.index : Number(raw?.index);
      if (!Number.isFinite(index)) continue;
      let score: number | null = null;
      for (const key of scoreKeys) {
        const value = raw?.[key];
        const n = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(n)) {
          score = n;
          break;
        }
      }
      if (score === null) continue;
      // Normalize raw logits to [0,1] via sigmoid if score is outside [0,1]
      // (bge-reranker returns raw logits like 1.97 or -11.03)
      if (score < 0 || score > 1) {
        score = 1 / (1 + Math.exp(-score));
      }
      parsed.push({ index, score });
    }
    return parsed.length > 0 ? parsed : null;
  };

  switch (provider) {
    case "pinecone": {
      // Pinecone: usually { data: [{ index, score, ... }] }
      // Also tolerate results[] with score/relevance_score for robustness.
      return (
        parseItems(data.data, ["score", "relevance_score"]) ??
        parseItems(data.results, ["score", "relevance_score"])
      );
    }
    case "voyage": {
      // Voyage: usually { data: [{ index, relevance_score }] }
      // Also tolerate results[] for compatibility across gateways.
      return (
        parseItems(data.data, ["relevance_score", "score"]) ??
        parseItems(data.results, ["relevance_score", "score"])
      );
    }
    case "siliconflow":
    case "jina":
    default: {
      // Jina / SiliconFlow: usually { results: [{ index, relevance_score }] }
      // Also tolerate data[] for compatibility across gateways.
      return (
        parseItems(data.results, ["relevance_score", "score"]) ??
        parseItems(data.data, ["relevance_score", "score"])
      );
    }
  }
}

// Cosine similarity for reranking fallback
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vector dimensions must match for cosine similarity");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const norm = Math.sqrt(normA) * Math.sqrt(normB);
  return norm === 0 ? 0 : dotProduct / norm;
}

// ============================================================================
// Memory Retriever
// ============================================================================

export class MemoryRetriever {
  private _lastTimings: Record<string, number> = {};

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG
  ) {}

  /** Timing breakdown from the most recent retrieve() call. */
  get lastTimings(): Record<string, number> { return this._lastTimings; }

  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    const { query, limit, scopeFilter, scopes, category, recentlyRecalled } = context;
    const safeLimit = clampInt(limit, 1, 20);
    // Explicit `scopes` override takes precedence over the derived scopeFilter
    const effectiveScopeFilter = scopes ?? scopeFilter;

    if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
      return this.vectorOnlyRetrieval(query, safeLimit, effectiveScopeFilter, category, recentlyRecalled);
    }

    return this.hybridRetrieval(query, safeLimit, effectiveScopeFilter, category, recentlyRecalled);
  }

  private async vectorOnlyRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    recentlyRecalled?: Set<string>,
  ): Promise<RetrievalResult[]> {
    const sw = new Stopwatch();
    const queryVector = await this.embedder.embedQuery(query);
    sw.lap("embed");

    const results = await this.store.vectorSearch(queryVector, limit, this.config.minScore, scopeFilter);
    sw.lap("search");

    const filtered = category
      ? results.filter(r => r.entry.category === category)
      : results;

    const mapped = filtered.map((result, index) => ({
      ...result,
      sources: {
        vector: { score: result.score, rank: index + 1 },
      },
    } as RetrievalResult));

    const boosted = this.applyRecencyBoost(mapped);
    const weighted = this.applyImportanceWeight(boosted);
    const lengthNormalized = this.applyLengthNormalization(weighted);
    const timeDecayed = this.applyTimeDecay(lengthNormalized);
    const hardFiltered = this.applyAdaptiveMinScore(timeDecayed);
    const denoised = this.config.filterNoise
      ? filterNoise(hardFiltered, r => r.entry.text)
      : hardFiltered;
    const diversified = this.applyRecentlyRecalledPenalty(denoised, recentlyRecalled);
    const deduplicated = this.applyMMRDiversity(diversified);
    sw.lap("score");

    this._lastTimings = sw.timings;
    return deduplicated.slice(0, limit);
  }

  private async hybridRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
    recentlyRecalled?: Set<string>,
  ): Promise<RetrievalResult[]> {
    const sw = new Stopwatch();
    const candidatePoolSize = Math.max(this.config.candidatePoolSize, limit * 2);

    const queryVector = await this.embedder.embedQuery(query);
    sw.lap("embed");

    const [vectorResults, bm25Results] = await Promise.all([
      this.runVectorSearch(queryVector, candidatePoolSize, scopeFilter, category),
      this.runBM25Search(query, candidatePoolSize, scopeFilter, category),
    ]);
    sw.lap("search");

    const fusedResults = await this.fuseResults(vectorResults, bm25Results);

    // Graph expansion: one-hop through entity links (disabled by default)
    if (this.config.entityGraph) {
      const fusedIds = fusedResults.map(r => r.entry.id);
      try {
        const linkedIds = expandOneHop(this.store.db, fusedIds);
        if (linkedIds.length > 0) {
          const bestScore = fusedResults[0]?.score || 0;
          for (const linkedId of linkedIds.slice(0, 5)) {
            if (fusedResults.some(r => r.entry.id === linkedId)) continue;
            const row = this.store.db.prepare(
              "SELECT id, text, category, scope, importance, timestamp, metadata FROM memories WHERE id = ?"
            ).get(linkedId) as any;
            if (row) {
              fusedResults.push({
                entry: { ...row, vector: [] },
                score: bestScore * LINK_SCORE_DISCOUNT_FACTOR,
                sources: { graph: true },
              } as any);
            }
          }
        }
      } catch { /* graph not available — skip */ }
    }
    sw.lap("fuse");

    // Entity boost (disabled by default — BM25 handles keyword entities)
    let postEntityResults = fusedResults;
    if (this.config.entityBoost) {
      const queryEntities = extractEntities(query);
      postEntityResults = this.applyEntityBoost(fusedResults, queryEntities);
    }

    const filtered = postEntityResults.filter(r => r.score >= this.config.minScore);

    const reranked = this.config.rerank !== "none"
      ? await this.rerankResults(query, queryVector, filtered.slice(0, limit * 2))
      : filtered;
    sw.lap("rerank");

    const temporalReranked = this.applyRecencyBoost(reranked);
    const importanceWeighted = this.applyImportanceWeight(temporalReranked);
    const lengthNormalized = this.applyLengthNormalization(importanceWeighted);
    const timeDecayed = this.applyTimeDecay(lengthNormalized);
    const hardFiltered = this.applyAdaptiveMinScore(timeDecayed);
    const denoised = this.config.filterNoise
      ? filterNoise(hardFiltered, r => r.entry.text)
      : hardFiltered;
    const diversified = this.applyRecentlyRecalledPenalty(denoised, recentlyRecalled);
    const deduplicated = this.applyMMRDiversity(diversified);
    sw.lap("score");

    this._lastTimings = sw.timings;
    return deduplicated.slice(0, limit);
  }

  private async runVectorSearch(
    queryVector: number[],
    limit: number,
    scopeFilter?: string[],
    category?: string
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.vectorSearch(queryVector, limit, 0.1, scopeFilter);

    // Filter by category if specified
    const filtered = category
      ? results.filter(r => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async runBM25Search(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.bm25Search(query, limit, scopeFilter);

    // Filter by category if specified
    const filtered = category
      ? results.filter(r => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async fuseResults(
    vectorResults: Array<MemorySearchResult & { rank: number }>,
    bm25Results: Array<MemorySearchResult & { rank: number }>
  ): Promise<RetrievalResult[]> {
    // Create maps for quick lookup
    const vectorMap = new Map<string, MemorySearchResult & { rank: number }>();
    const bm25Map = new Map<string, MemorySearchResult & { rank: number }>();

    vectorResults.forEach(result => {
      vectorMap.set(result.entry.id, result);
    });

    bm25Results.forEach(result => {
      bm25Map.set(result.entry.id, result);
    });

    // Get all unique document IDs
    const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);

    // Pre-compute z-score stats if using zscore fusion
    let vecMean = 0, vecStd = 1, bm25Mean = 0, bm25Std = 1;
    if (this.config.fusionMethod === "zscore") {
      const vecScores = vectorResults.map(r => r.score);
      const bm25Scores = bm25Results.map(r => r.score);
      if (vecScores.length > 1) {
        vecMean = vecScores.reduce((a, b) => a + b, 0) / vecScores.length;
        vecStd = Math.sqrt(vecScores.reduce((a, s) => a + (s - vecMean) ** 2, 0) / vecScores.length);
        if (vecStd < 0.001) vecStd = 1;
      }
      if (bm25Scores.length > 1) {
        bm25Mean = bm25Scores.reduce((a, b) => a + b, 0) / bm25Scores.length;
        bm25Std = Math.sqrt(bm25Scores.reduce((a, s) => a + (s - bm25Mean) ** 2, 0) / bm25Scores.length);
        if (bm25Std < 0.001) bm25Std = 1;
      }
    }

    const fusedResults: RetrievalResult[] = [];

    for (const id of allIds) {
      const vectorResult = vectorMap.get(id);
      const bm25Result = bm25Map.get(id);

      // FIX(#15): BM25-only results may be "ghost" entries whose vector data was
      // deleted but whose FTS index entry lingers until the next index rebuild.
      // Validate that the entry actually exists in the store before including it.
      if (!vectorResult && bm25Result) {
        try {
          const exists = await this.store.hasId(id);
          if (!exists) continue; // Skip ghost entry
        } catch {
          // If hasId fails, keep the result (fail-open)
        }
      }

      // Use the result with more complete data (prefer vector result if both exist)
      const baseResult = vectorResult || bm25Result!;

      const vectorScore = vectorResult ? vectorResult.score : 0;
      const bm25Score = bm25Result ? bm25Result.score : 0;

      let fusedScore: number;

      if (this.config.fusionMethod === "zscore") {
        // Z-score fusion: normalize each signal to zero-mean/unit-variance,
        // then combine with configured weights. Absent signals get z=0 (neutral).
        const vz = vectorResult ? (vectorScore - vecMean) / vecStd : 0;
        const bz = bm25Result ? (bm25Score - bm25Mean) / bm25Std : 0;
        // Map z-score back to [0,1] via sigmoid for downstream compatibility
        const rawZ = this.config.vectorWeight * vz + this.config.bm25Weight * bz;
        fusedScore = 1 / (1 + Math.exp(-rawZ));
      } else {
        // Raw weighted fusion: blend proportionally when both exist,
        // use full score when only one exists.
        if (vectorResult && bm25Result) {
          fusedScore = clamp01(
            this.config.vectorWeight * vectorScore + this.config.bm25Weight * bm25Score,
            0.1,
          );
        } else if (vectorResult) {
          fusedScore = clamp01(vectorScore, 0.1);
        } else {
          fusedScore = clamp01(bm25Score, 0.1);
        }
      }

      fusedResults.push({
        entry: baseResult.entry,
        score: fusedScore,
        sources: {
          vector: vectorResult ? { score: vectorResult.score, rank: vectorResult.rank } : undefined,
          bm25: bm25Result ? { score: bm25Result.score, rank: bm25Result.rank } : undefined,
          fused: { score: fusedScore },
        },
      });
    }

    // Sort by fused score descending
    return fusedResults.sort((a, b) => b.score - a.score);
  }

  /**
   * Rerank results using cross-encoder API (Jina, Pinecone, or compatible).
   * Falls back to cosine similarity if API is unavailable or fails.
   */
  private async rerankResults(query: string, queryVector: number[], results: RetrievalResult[]): Promise<RetrievalResult[]> {
    if (results.length === 0) {
      return results;
    }

    // Try cross-encoder rerank via configured provider API
    if (this.config.rerank === "cross-encoder" && this.config.rerankApiKey) {
      try {
        const provider = this.config.rerankProvider || "jina";
        const model = this.config.rerankModel || "jina-reranker-v3";
        const endpoint = this.config.rerankEndpoint || "https://api.jina.ai/v1/rerank";
        // Truncate documents for reranker context window (most rerankers have 512-2048 token limits)
        const documents = results.map(r => r.entry.text.slice(0, 1500));

        // Build provider-specific request
        const { headers, body } = buildRerankRequest(provider, this.config.rerankApiKey, model, query, documents, results.length);

        // 15s per-attempt timeout, retried up to 4 times on transient
        // upstream failures (502/503/504/AbortError). Persistent failures
        // fall through to the catch block → cosine fallback.
        const response = await withTransientRetry(async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          try {
            const resp = await fetch(endpoint, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: controller.signal,
            });
            if (!resp.ok) {
              const err = new Error(`rerank endpoint returned ${resp.status}`) as Error & { status: number };
              err.status = resp.status;
              throw err;
            }
            return resp;
          } finally {
            clearTimeout(timeout);
          }
        });

        // If we reach this point the response is ok; withTransientRetry
        // threw on non-ok statuses and the outer catch handles them.
        const data = await response.json() as Record<string, unknown>;

        // Parse provider-specific response into unified format
        const parsed = parseRerankResponse(provider, data);

        if (!parsed) {
          console.warn("Rerank API: invalid response shape, returning hybrid-fusion ranking unchanged");
        } else {
          // Build a Set of returned indices to identify unreturned candidates
          const returnedIndices = new Set(parsed.map(r => r.index));

          // Configurable rerank/fusion blend (see RetrievalConfig.rerankBlendWeight).
          // Default: 0.8 reranker + 0.2 original fused score. Lower values
          // protect fusion winners from overconfident reranker calls.
          const blendWeight = this.config.rerankBlendWeight ?? 0.8;
          const fusionWeight = 1 - blendWeight;
          const scoreMode = this.config.rerankScoreMode ?? "raw";

          // For rank-mode scoring, convert the reranker's raw scores into
          // rank-normalized values (top-1 = 1.0, top-k = 1 - (k-1)/N). This
          // makes the rerank signal "ordinal" so saturated reranker output
          // (all scores near 1.0) can't get dissolved by the fusion gap
          // during blending.
          const rerankScoreByIndex = new Map<number, number>();
          if (scoreMode === "rank") {
            const sorted = [...parsed].sort((a, b) => b.score - a.score);
            const n = sorted.length || 1;
            sorted.forEach((item, rank) => {
              rerankScoreByIndex.set(item.index, 1 - rank / n);
            });
          }

          const reranked = parsed
            .filter(item => item.index >= 0 && item.index < results.length)
            .map(item => {
              const original = results[item.index];
              const rerankScore = scoreMode === "rank"
                ? (rerankScoreByIndex.get(item.index) ?? 0)
                : item.score;
              const blendedScore = clamp01(
                rerankScore * blendWeight + original.score * fusionWeight,
              );
              return {
                ...original,
                score: blendedScore,
                sources: {
                  ...original.sources,
                  reranked: { score: item.score },
                },
              };
            });

          // Keep unreturned candidates with their original scores (slightly penalized)
          const unreturned = results
            .filter((_, idx) => !returnedIndices.has(idx))
            .map(r => ({ ...r, score: r.score * 0.8 }));

          return [...reranked, ...unreturned].sort((a, b) => b.score - a.score);
        }
      } catch (error) {
        const errStatus = (error as { status?: number })?.status;
        if (typeof errStatus === "number") {
          console.warn(`Rerank API returned ${errStatus} after retries, returning hybrid-fusion ranking unchanged`);
        } else if (error instanceof Error && error.name === "AbortError") {
          console.warn("Rerank API timed out after retries, returning hybrid-fusion ranking unchanged");
        } else {
          console.warn("Rerank API failed, falling back to calibrated scores:", error);
        }
      }
      // Rerank was configured but the API call failed. Return the input
      // results unchanged — the hybrid-fusion ranking is already a good
      // default and is what the domain eval passes on. (Previously this
      // fell through to the cosine-similarity fallback below, which
      // aggressively re-ranked and displaced correct fusion winners.
      // That behavior is intended for the case where rerank is not
      // configured at all, not for transient rerank API failures.)
      return results;
    }

    // LLM-based reranker: use a chat model as relevance judge.
    // Slower and costlier than cross-encoder but often higher quality.
    if (this.config.rerank === "llm" && this.config.rerankLlmEndpoint && this.config.rerankLlmModel) {
      try {
        const documents = results.map(r => r.entry.text);
        const originalScores = results.map(r => r.score);
        const parsed = await llmRerank(query, documents, originalScores, {
          endpoint: this.config.rerankLlmEndpoint,
          apiKey: this.config.rerankLlmApiKey ?? "",
          model: this.config.rerankLlmModel,
          timeoutMs: this.config.rerankLlmTimeoutMs,
          maxDocuments: this.config.rerankLlmMaxDocs,
        });

        if (parsed) {
          const blendWeight = this.config.rerankBlendWeight ?? 0.8;
          const fusionWeight = 1 - blendWeight;

          const reranked = parsed
            .filter(item => item.index >= 0 && item.index < results.length)
            .map(item => {
              const original = results[item.index];
              const blended = clamp01(
                item.score * blendWeight + (original.score ?? 0) * fusionWeight,
              );
              return {
                ...original,
                score: blended,
                sources: { ...original.sources, reranked: { score: item.score } },
              };
            });

          // Keep documents that the LLM didn't return (un-reranked) at their
          // original fusion scores, marked as not reranked.
          const rerankedIndices = new Set(parsed.map(r => r.index));
          const untouched = results
            .filter((_, i) => !rerankedIndices.has(i))
            .map(r => ({ ...r, score: r.score }));

          const merged = [...reranked, ...untouched].sort((a, b) => b.score - a.score);
          return merged;
        }
      } catch {
        // LLM reranker failed — return fusion results unchanged
      }
      return results;
    }

    // Cosine-similarity second pass — runs ONLY when no cross-encoder rerank
    // is configured at all (e.g. in a lightweight deployment without a
    // reranker endpoint). Improves pure BM25 results slightly by mixing in
    // vector similarity.
    try {
      const reranked = results.map(result => {
        if (!result.entry.vector || result.entry.vector.length !== queryVector.length) {
          return result; // can't compute cosine — keep original score
        }
        const cosineScore = cosineSimilarity(queryVector, result.entry.vector);
        const combinedScore = (result.score * 0.5) + (cosineScore * 0.5);

        return {
          ...result,
          score: clamp01(combinedScore, result.score),
          sources: {
            ...result.sources,
            reranked: { score: cosineScore },
          },
        };
      });

      return reranked.sort((a, b) => b.score - a.score);
    } catch (error) {
      console.warn("Cosine fallback reranking failed, returning original results:", error);
      return results;
    }
  }

  /**
   * Apply recency boost: newer memories get a small score bonus.
   * This ensures corrections/updates naturally outrank older entries
   * when semantic similarity is close.
   * Formula: boost = exp(-ageDays / halfLife) * weight
   */
  private applyRecencyBoost(results: RetrievalResult[]): RetrievalResult[] {
    const { recencyHalfLifeDays, recencyWeight } = this.config;
    if (!recencyHalfLifeDays || recencyHalfLifeDays <= 0 || !recencyWeight) {
      return results;
    }

    const relevanceFirst = process.env.MEMEX_RELEVANCE_FIRST === "1";
    const now = Date.now();
    const boosted = results.map(r => {
      // Relevance gate (MEMEX_RELEVANCE_FIRST): don't add recency to low-relevance results,
      // so a recent-but-irrelevant memory (the junk-magnet pattern) can't float above an older
      // relevant one. Recency becomes a tie-break among already-relevant results, not an override.
      if (relevanceFirst && r.score < 0.40) return r;
      const ts = (r.entry.timestamp && r.entry.timestamp > 0) ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;
      const boost = Math.exp(-ageDays / recencyHalfLifeDays) * recencyWeight;
      return {
        ...r,
        score: clamp01(r.score + boost, r.score),
      };
    });

    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Apply importance weighting: memories with higher importance get a score boost.
   * This ensures critical memories (importance=1.0) outrank casual ones (importance=0.5)
   * when semantic similarity is close.
   * Formula: score *= (baseWeight + (1 - baseWeight) * importance)
   * With baseWeight=0.7: importance=1.0 → ×1.0, importance=0.5 → ×0.85, importance=0.0 → ×0.7
   */
  private applyImportanceWeight(results: RetrievalResult[]): RetrievalResult[] {
    const baseWeight = 0.7;
    const weighted = results.map(r => {
      const importance = r.entry.importance ?? 0.7;
      const factor = baseWeight + (1 - baseWeight) * importance;
      // Recall frequency boost: frequently recalled = proven useful (max +10%)
      const freqBoost = Math.min(0.1, (this.recallFrequency.get(r.entry.id) ?? 0) / 200);
      return {
        ...r,
        score: clamp01(r.score * factor * (1 + freqBoost), r.score * baseWeight),
      };
    });
    return weighted.sort((a, b) => b.score - a.score);
  }

  /**
   * Length normalization: penalize long entries that dominate search results
   * via sheer keyword density and broad semantic coverage.
   * Short, focused entries (< anchor) get a slight boost.
   * Long, sprawling entries (> anchor) get penalized.
   * Formula: score *= 1 / (1 + log2(charLen / anchor))
   */
  private applyLengthNormalization(results: RetrievalResult[]): RetrievalResult[] {
    const anchor = this.config.lengthNormAnchor;
    if (!anchor || anchor <= 0) return results;

    const normalized = results.map(r => {
      const charLen = r.entry.text.length;
      const ratio = charLen / anchor;
      // No penalty for entries at or below anchor length.
      // Gentle logarithmic decay for longer entries:
      //   anchor (500) → 1.0, 800 → 0.75, 1000 → 0.67, 1500 → 0.56, 2000 → 0.50
      // This prevents long, keyword-rich entries from dominating top-k
      // while keeping their scores reasonable.
      const logRatio = Math.log2(Math.max(ratio, 1)); // no boost for short entries
      const factor = 1 / (1 + 0.5 * logRatio);
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.3),
      };
    });

    return normalized.sort((a, b) => b.score - a.score);
  }

  /**
   * Time decay: multiplicative penalty for old entries.
   * Unlike recencyBoost (additive bonus for new entries), this actively
   * penalizes stale information so recent knowledge wins ties.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At 0 days: 1.0x (no penalty)
   * At halfLife: ~0.68x
   * At 2*halfLife: ~0.59x
   * Floor at 0.5x (never penalize more than half)
   */
  private applyTimeDecay(results: RetrievalResult[]): RetrievalResult[] {
    const halfLife = this.config.timeDecayHalfLifeDays;
    if (!halfLife || halfLife <= 0) return results;

    const now = Date.now();
    const decayed = results.map(r => {
      const ts = (r.entry.timestamp && r.entry.timestamp > 0) ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;
      // floor at 0.5: even very old entries keep at least 50% of their score
      const factor = 0.5 + 0.5 * Math.exp(-ageDays / halfLife);
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.5),
      };
    });

    return decayed.sort((a, b) => b.score - a.score);
  }

  /**
   * Adaptive minimum score: instead of a fixed floor, keep results within
   * a ratio of the best result's score. This adapts to each query —
   * strong matches use a higher effective floor, weak matches use a lower one.
   * Also enforces a hard floor to filter pure noise.
   */
  private applyAdaptiveMinScore(results: RetrievalResult[]): RetrievalResult[] {
    if (results.length === 0) return results;
    const bestScore = results[0].score; // already sorted desc
    const relativeFloor = bestScore * 0.3; // keep if within 30% of best
    const absoluteFloor = this.config.hardMinScore; // never return pure noise (F12: was hardcoded 0.15, config was dead)
    const effectiveFloor = Math.max(relativeFloor, absoluteFloor);
    return results.filter(r => r.score >= effectiveFloor);
  }

  /**
   * MMR-inspired diversity filter: greedily select results that are both
   * relevant (high score) and diverse (low similarity to already-selected).
   *
   * Uses cosine similarity between memory vectors. If two memories have
   * cosine similarity > threshold (default 0.92), the lower-scored one
   * is demoted to the end rather than removed entirely.
   *
   * This prevents top-k from being filled with near-identical entries
   * (e.g. 3 similar "SVG style" memories) while keeping them available
   * if the pool is small.
   */
  /**
   * Entity boost: memories sharing entities with the query get a score boost.
   * Implements ACT-R spreading activation as a 3rd retrieval signal.
   */
  private applyEntityBoost(results: RetrievalResult[], queryEntities: string[]): RetrievalResult[] {
    if (queryEntities.length === 0) return results;
    // Entity boost weight. Set to 0 to disable (BM25 already captures keyword entities).
    // Tuning on domain eval: 0.0 = 12/15, 0.15 = 11/15, 0.50 = 11/15, 0.75 = 10/15.
    // Keeping at 0 for now — entity boost hurts intra-cluster ranking.
    const ENTITY_BOOST_WEIGHT = parseFloat(process.env.ENTITY_BOOST_WEIGHT || "0");
    const boosted = results.map(r => {
      let memEntities: string[] = [];
      try {
        const meta = JSON.parse(r.entry.metadata || "{}");
        memEntities = meta.entities || [];
      } catch {}
      const overlap = entityOverlap(queryEntities, memEntities);
      if (overlap === 0) return r;
      const boost = 1 + (overlap / queryEntities.length) * ENTITY_BOOST_WEIGHT;
      return { ...r, score: r.score * boost };
    });
    return boosted.sort((a, b) => b.score - a.score);
  }

  private applyMMRDiversity(results: RetrievalResult[], similarityThreshold = 0.85): RetrievalResult[] {
    if (results.length <= 1) return results;

    const selected: RetrievalResult[] = [];
    const deferred: RetrievalResult[] = [];

    for (const candidate of results) {
      // Check if this candidate is too similar to any already-selected result
      const tooSimilar = selected.some(s => {
        // Both must have vectors to compare.
        // LanceDB returns Arrow Vector objects (not plain arrays),
        // so use .length directly and Array.from() for conversion.
        const sVec = s.entry.vector;
        const cVec = candidate.entry.vector;
        if (!sVec?.length || !cVec?.length) return false;
        const sArr = Array.from(sVec as Iterable<number>);
        const cArr = Array.from(cVec as Iterable<number>);
        const sim = cosineSimilarity(sArr, cArr);
        return sim > similarityThreshold;
      });

      if (tooSimilar) {
        deferred.push(candidate);
      } else {
        selected.push(candidate);
      }
    }
    // Append deferred results at the end (available but deprioritized)
    return [...selected, ...deferred];
  }

  /**
   * Apply a 30% score penalty to memories that were recalled in recent turns.
   * This promotes diversity by letting different memories surface across turns.
   */
  private applyRecentlyRecalledPenalty(
    results: RetrievalResult[],
    recentlyRecalled?: Set<string>,
  ): RetrievalResult[] {
    if (!recentlyRecalled || recentlyRecalled.size === 0) return results;

    const penalized = results.map(r => {
      if (recentlyRecalled.has(r.entry.id)) {
        return { ...r, score: r.score * 0.7 };
      }
      return r;
    });

    return penalized.sort((a, b) => b.score - a.score);
  }

  // Ephemeral recall frequency tracking (resets on gateway restart)
  private recallFrequency = new Map<string, number>();

  /**
   * Record that these IDs were recalled (for frequency-based importance signal).
   */
  recordRecall(ids: string[]): void {
    for (const id of ids) {
      this.recallFrequency.set(id, (this.recallFrequency.get(id) ?? 0) + 1);
    }
  }

  // Update configuration
  updateConfig(newConfig: Partial<RetrievalConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  // Get current configuration
  getConfig(): RetrievalConfig {
    return { ...this.config };
  }

  // Test retrieval system
  async test(query = "test query"): Promise<{
    success: boolean;
    mode: string;
    hasFtsSupport: boolean;
    error?: string;
  }> {
    try {
      const results = await this.retrieve({
        query,
        limit: 1,
      });

      return {
        success: true,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
      };
    } catch (error) {
      return {
        success: false,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  config?: Partial<RetrievalConfig>
): MemoryRetriever {
  const fullConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  // F12 kill-switch / calibration lever: override the absolute score floor at runtime.
  // Unset = config default (0.15, pre-fix behavior); set after F3 calibration measures the
  // optimal value. Guards against shipping an uncalibrated floor to production.
  const hardMinOverride = parseFloat(process.env.MEMEX_HARD_MIN_SCORE_OVERRIDE || "");
  if (Number.isFinite(hardMinOverride) && hardMinOverride >= 0 && hardMinOverride <= 1) {
    fullConfig.hardMinScore = hardMinOverride;
  }
  // MEMEX_RELEVANCE_FIRST (Wave-1 redesign, off by default): cap temporal signals so relevance
  // dominates. Recency capped to a tie-break (+0.05 max) and relevance-gated (no boost when
  // score < 0.40); multiplicative timeDecay disabled (halfLife 0 → applyTimeDecay early-returns).
  if (process.env.MEMEX_RELEVANCE_FIRST === "1") {
    fullConfig.recencyWeight = Math.min(fullConfig.recencyWeight, 0.05);
    fullConfig.timeDecayHalfLifeDays = 0;
  }
  return new MemoryRetriever(store, embedder, fullConfig);
}
