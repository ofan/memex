/**
 * Unified Retriever
 *
 * Replaces the dual-pipeline architecture with a single-pass retriever that
 * searches both conversation memories and documents with one embed call,
 * z-score calibration, and optional reranking.
 */

import type { MemoryStore, MemoryEntry, MemorySearchResult } from "./memory.js";
import type { Embedder } from "./embedder.js";
import { shouldSkipRetrieval } from "./adaptive-retrieval.js";
import { buildRerankRequest, parseRerankResponse } from "./retriever.js";
import { withTransientRetry } from "./transient-retry.js";
import { TraceRecorder, type RetrievalTrace, type TraceItem } from "./retrieval-trace.js";
import { randomUUID } from "node:crypto";

// =============================================================================
// Types
// =============================================================================

export interface UnifiedRetrieverConfig {
  /** Max results to return (default: 10) */
  limit: number;
  /** Min score threshold after calibration (default: 0.15) */
  minScore: number;
  /** Weight for conversation results in final blend (default: 0.55) */
  conversationWeight: number;
  /** Weight for document results in final blend (default: 0.45) */
  documentWeight: number;
  /** Reranker config, or null to disable (default: null) */
  reranker: {
    endpoint: string;
    apiKey: string;
    model: string;
    provider: string;
  } | null;
  /** Enable query expansion (default: false) */
  queryExpansion: boolean;
  /** Number of candidates to fetch per source before fusion (default: 15) */
  candidatePoolSize: number;
  /** Confidence threshold for early termination (default: 0.88) */
  confidenceThreshold: number;
  /** Gap between top and second result for confidence check (default: 0.15) */
  confidenceGap: number;
  /**
   * Weight given to the cross-encoder rerank score when blending with the
   * source-calibrated fused score. Final reranked score is:
   *     blended = rerankBlendWeight * rerank_score + (1 - rerankBlendWeight) * calibrated_score
   * Higher = reranker dominates. Lower = calibrated fusion has more say.
   * Default: 0.7 (keeping the existing behavior).
   */
  rerankBlendWeight: number;
  /**
   * Score mode for the cross-encoder rerank output:
   * - "raw": use the raw relevance_score as returned by the reranker
   * - "rank": replace raw scores with rank-normalized values (top-1 = 1.0,
   *   top-k = 1 - (k-1)/N). Useful when the reranker saturates (all top
   *   scores near 1.0) and raw-score differentials get dissolved by blend
   *   math with the fusion score. On Qwen3-Reranker + memex's domain-eval
   *   + TIER=pipeline fast-benchmark, rank mode recovered +1 query and
   *   +7/+13 queries respectively over raw mode.
   * Default: "raw" (backward compat).
   */
  rerankScoreMode: "raw" | "rank";
  /**
   * When true, `retrieve()` populates `lastTrace` with a per-stage ranking
   * snapshot. Off by default (zero overhead). Gated at the call site by
   * MEMEX_DEBUG_RECALL.
   */
  captureTrace?: boolean;
}

export interface UnifiedResult {
  id: string;
  text: string;
  score: number;
  rawScore: number;
  source: "conversation" | "document";
  metadata: Record<string, any>;
}

export type SourceRoute = "memory" | "document" | "both";

export interface DocumentCandidate {
  filepath: string;
  displayPath: string;
  title: string;
  body: string;
  bestChunk: string;
  bestChunkPos: number;
  score: number;
  docid: string;
  context: string | null;
}

/** Internal type for calibrated results before final output */
interface CalibratedResult {
  id: string;
  text: string;
  rawScore: number;
  calibrated: number;
  score: number;
  source: "conversation" | "document";
  metadata: Record<string, any>;
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_CONFIG: UnifiedRetrieverConfig = {
  limit: 10,
  minScore: 0.15,
  conversationWeight: 0.55,
  documentWeight: 0.45,
  reranker: null,
  queryExpansion: false,
  candidatePoolSize: 15,
  confidenceThreshold: 0.88,
  confidenceGap: 0.15,
  rerankBlendWeight: 0.7,
  rerankScoreMode: "raw",
};

// =============================================================================
// Source Routing Patterns
// =============================================================================

// Document-only signals
const DOC_PATTERNS = [
  /\b(in the file|documentation|readme|config file|source code|codebase)\b/,
  /\.(md|ts|json)\b/,
  /\b(what does .+ say|contents of|look at|check the file)\b/,
];

// Memory-only signals
const MEM_PATTERNS = [
  /\b(my preference|i said|i want|i told you|remember when|do i|did we|have i)\b/,
  /\b(what('s| is) (my|the) .*(key|token|password|secret|voice|port|channel|address))\b/,
];

// =============================================================================
// Unified Retriever
// =============================================================================

/** Curated config snapshot embedded in a trace so it is self-describing. */
function unifiedTraceConfigSnapshot(c: UnifiedRetrieverConfig): Record<string, unknown> {
  return {
    limit: c.limit, minScore: c.minScore,
    conversationWeight: c.conversationWeight, documentWeight: c.documentWeight,
    candidatePoolSize: c.candidatePoolSize,
    reranker: c.reranker ? { model: c.reranker.model, provider: c.reranker.provider } : null,
    rerankBlendWeight: c.rerankBlendWeight, rerankScoreMode: c.rerankScoreMode,
    confidenceThreshold: c.confidenceThreshold, confidenceGap: c.confidenceGap,
  };
}

/** Snapshot a calibrated unified result into a trace item. */
function toUnifiedTraceItem(r: CalibratedResult): TraceItem {
  return { id: r.id, score: r.score, source: r.source, scores: { calibrated: r.calibrated, raw: r.rawScore } };
}

export class UnifiedRetriever {
  private config: UnifiedRetrieverConfig;
  private _lastTrace: RetrievalTrace | null = null;
  /** Recorder active during the current retrieve() call; null when captureTrace is off. */
  private _currentRec: TraceRecorder | null = null;

  /** Per-stage ranking trace from the most recent call. Null unless captureTrace was on. */
  get lastTrace(): RetrievalTrace | null { return this._lastTrace; }

  constructor(
    private memoryStore: MemoryStore,
    private documentSearchFn: ((query: string, queryVec: number[], limit: number, collection?: string, collections?: string[]) => Promise<DocumentCandidate[]>) | null,
    private embedder: Embedder,
    config: Partial<UnifiedRetrieverConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Retrieve results from both conversation memory and document search
   * in a single unified pass.
   */
  async retrieve(query: string, options?: {
    limit?: number;
    scopeFilter?: string[];
    collection?: string;
    /** Collections to search (B4: takes precedence over single `collection`). */
    collections?: string[];
    recentlyRecalled?: Set<string>;
    /** Stable per-recall id embedded in the trace header (caller-owned). */
    debugId?: string;
  }): Promise<UnifiedResult[]> {
    this._lastTrace = null;
    // Stage 0: Skip check -- greetings, commands, etc.
    if (shouldSkipRetrieval(query)) return [];

    // Set up the per-call trace recorder (null when capture is off → no overhead).
    this._currentRec = this.config.captureTrace
      ? new TraceRecorder({
          debugId: options?.debugId ?? randomUUID().slice(0, 8),
          query,
          pipeline: "unified",
          config: unifiedTraceConfigSnapshot(this.config),
        })
      : null;

    // Stage 1: Route query to appropriate source(s)
    const route = this.routeQuery(query);
    const limit = options?.limit ?? this.config.limit;

    // Stage 2: Embed query (single call, reused for both sources)
    const queryVec = await this.embedder.embedQuery(query);

    // Stage 3: Parallel retrieval based on route
    const colls = options?.collections ?? (options?.collection ? [options.collection] : undefined);
    const [memoryRaw, docResults] = await Promise.all([
      // B2: memory search ALWAYS runs (no route guard) — prevents regression on DOC_PATTERNS queries.
      this.searchMemories(query, queryVec, options?.scopeFilter),
      (route !== "memory" && this.documentSearchFn)
        ? this.documentSearchFn(query, queryVec, this.config.candidatePoolSize, undefined, colls)
        : Promise.resolve([]),
    ]);

    // Stage 4: Fuse memory results (vector + BM25 hybrid)
    const memoryFused = this.fuseMemoryResults(memoryRaw.vecResults, memoryRaw.bm25Results);
    this._currentRec?.stage("memory-fusion", memoryFused.map(r => ({ id: r.entry.id, score: r.score, source: "conversation" })));
    if (docResults.length) {
      this._currentRec?.stage("document-search", docResults.map(d => {
        const dd = d as { id?: string; docid?: string; score?: number };
        return { id: dd.id ?? dd.docid ?? "", score: dd.score ?? 0, source: "document" };
      }));
    }

    // Stage 6: Z-score calibrate and merge both sources
    let pool = this.mergeAndCalibrate(memoryFused, docResults);
    this._currentRec?.stage("merge", pool.map(toUnifiedTraceItem), { meta: { route } });

    // Stage 7: Confidence-gated reranking
    const didRerank = !!(this.config.reranker && this.shouldRerank(pool));
    if (didRerank) {
      pool = await this.rerank(query, pool);
      this._currentRec?.stage("rerank", pool.map(toUnifiedTraceItem), { meta: { reranker: this.config.reranker?.model } });
    }

    // Stage 8: Post-merge modifiers (time decay, importance, length norm, floor)
    pool = this.applyPostMergeModifiers(pool);

    // Stage 9: Source diversity + final selection
    const final = this.applySourceDiversity(pool, limit);
    this._currentRec?.stage("diversity", final.map(r => ({ id: r.id, score: r.score, source: r.source })));
    this._lastTrace = this._currentRec ? this._currentRec.finish(final.map(r => r.id)) : null;
    this._currentRec = null;
    return final;
  }

  /**
   * Determine which source(s) to query based on the query text.
   */
  routeQuery(query: string): SourceRoute {
    const q = query.toLowerCase();

    // Document-only signals
    for (const pattern of DOC_PATTERNS) {
      if (pattern.test(q)) return "document";
    }

    // Memory-only signals
    for (const pattern of MEM_PATTERNS) {
      if (pattern.test(q)) return "memory";
    }

    return "both";
  }

  // ---------------------------------------------------------------------------
  // Stage 3: Source-specific retrieval
  // ---------------------------------------------------------------------------

  private async searchMemories(
    query: string,
    queryVec: number[],
    scopeFilter?: string[],
  ): Promise<{ vecResults: MemorySearchResult[]; bm25Results: MemorySearchResult[] }> {
    const poolSize = this.config.candidatePoolSize;
    const [vecResults, bm25Results] = await Promise.all([
      this.memoryStore.vectorSearch(queryVec, Math.min(poolSize * 3, 40), 0.0, scopeFilter),
      this.memoryStore.bm25Search(query, Math.min(poolSize, 20), scopeFilter),
    ]);
    return { vecResults, bm25Results };
  }

  // ---------------------------------------------------------------------------
  // Stage 4: Memory fusion (vector + BM25 hybrid)
  // ---------------------------------------------------------------------------

  fuseMemoryResults(
    vecResults: MemorySearchResult[],
    bm25Results: MemorySearchResult[],
  ): { entry: MemoryEntry; score: number }[] {
    // Z-score fusion: normalize each signal's distribution before combining.
    // This prevents BM25-only noise candidates from displacing vector hits.
    const vecScores = vecResults.map(r => r.score);
    const bm25Scores = bm25Results.map(r => r.score);

    let vecMean = 0, vecStd = 1, bm25Mean = 0, bm25Std = 1;
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

    // Build lookup maps
    const vecMap = new Map<string, MemorySearchResult>();
    for (const r of vecResults) vecMap.set(r.entry.id, r);
    const bm25Map = new Map<string, MemorySearchResult>();
    for (const r of bm25Results) bm25Map.set(r.entry.id, r);

    // Merge all unique candidates
    const allIds = new Set([...vecMap.keys(), ...bm25Map.keys()]);
    const fusedResults: { entry: MemoryEntry; score: number }[] = [];

    for (const id of allIds) {
      const vecResult = vecMap.get(id);
      const bm25Result = bm25Map.get(id);
      const entry = (vecResult || bm25Result)!.entry;

      // Z-score: absent signal = 0 (neutral, at the mean)
      const vz = vecResult ? (vecResult.score - vecMean) / vecStd : 0;
      const bz = bm25Result ? (bm25Result.score - bm25Mean) / bm25Std : 0;
      const rawZ = 0.8 * vz + 0.2 * bz;
      // Map back to [0,1] via sigmoid
      const score = 1 / (1 + Math.exp(-rawZ));

      fusedResults.push({ entry, score });
    }

    return fusedResults.sort((a, b) => b.score - a.score);
  }

  // ---------------------------------------------------------------------------
  // Stage 6: Z-score calibration + merge
  // ---------------------------------------------------------------------------

  /**
   * Build a sigmoid calibration function from a set of scores.
   * Maps raw scores to [0, 1] using z-score normalization followed by sigmoid.
   */
  calibrateScores(scores: number[]): (score: number) => number {
    const n = scores.length;
    if (n < 2) return () => 0.5;

    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const variance = scores.reduce((a, s) => a + (s - mean) ** 2, 0) / n;
    const std = Math.sqrt(variance);
    const safeStd = Math.max(std, 0.01);

    return (score: number) => 1 / (1 + Math.exp(-(score - mean) / safeStd));
  }

  /**
   * Z-score calibrate each source independently, apply source weights,
   * and merge into a single sorted pool.
   */
  mergeAndCalibrate(
    memoryFused: { entry: MemoryEntry; score: number }[],
    docCandidates: DocumentCandidate[],
  ): CalibratedResult[] {
    // Use raw scores directly — both sources already output [0,1].
    // Z-score calibration was removing absolute relevance signal.
    // Simple source weighting preserves the actual score magnitude.
    const calMem = (score: number) => score;
    const calDoc = (score: number) => score;

    const pool: CalibratedResult[] = [];

    for (const m of memoryFused) {
      const calibrated = calMem(m.score) * this.config.conversationWeight;
      pool.push({
        id: m.entry.id,
        text: m.entry.text,
        rawScore: m.score,
        calibrated,
        score: calibrated,
        source: "conversation",
        metadata: {
          type: "conversation",
          category: m.entry.category || "other",
          scope: m.entry.scope || "global",
          importance: m.entry.importance ?? 0.7,
          timestamp: m.entry.timestamp,
          memoryId: m.entry.id,
        },
      });
    }

    for (const d of docCandidates) {
      const calibrated = calDoc(d.score) * this.config.documentWeight;
      pool.push({
        id: d.docid || d.filepath,
        text: d.bestChunk || d.body?.slice(0, 500) || "",
        rawScore: d.score,
        calibrated,
        score: calibrated,
        source: "document",
        metadata: {
          type: "document",
          filepath: d.filepath,
          displayPath: d.displayPath,
          title: d.title,
          bestChunk: d.bestChunk,
          context: d.context,
          docid: d.docid,
        },
      });
    }

    return pool.sort((a, b) => b.score - a.score);
  }

  // ---------------------------------------------------------------------------
  // Stage 7: Confidence-gated reranking
  // ---------------------------------------------------------------------------

  /**
   * Decide whether cross-encoder reranking is needed.
   * Skip if: pool too small, top result is very confident, or clear gap
   * between top and second result.
   */
  private shouldRerank(pool: CalibratedResult[]): boolean {
    if (pool.length <= 1) return false;
    // Use rawScore (unweighted [0,1] sigmoid-fused source score) for threshold
    // and gap checks. The `score` field is multiplied by conversationWeight
    // (0.55) or documentWeight (0.45), so its max value is ~0.55 — which makes
    // a confidenceThreshold of 0.88 unreachable and the check dead code.
    const top = pool[0].rawScore;
    const second = pool[1].rawScore;
    if (top > this.config.confidenceThreshold) return false;
    if (top - second > this.config.confidenceGap) return false;
    return true;
  }

  /**
   * Cross-encoder reranking of the top-N candidates.
   * Blends 70% rerank score + 30% calibrated score.
   * On failure, falls back to calibrated scores silently.
   */
  private async rerank(query: string, pool: CalibratedResult[]): Promise<CalibratedResult[]> {
    const n = Math.min(pool.length, this.config.candidatePoolSize);
    const candidates = pool.slice(0, n);
    const rest = pool.slice(n);

    const rerankerConfig = this.config.reranker!;

    // Build documents: memory entries use full text, documents use bestChunk
    const documents = candidates.map(r => {
      if (r.source === "document" && r.metadata?.bestChunk) {
        return r.metadata.bestChunk as string;
      }
      return r.text;
    });

    try {
      const provider = (rerankerConfig.provider || "jina") as any;
      const { headers, body } = buildRerankRequest(
        provider,
        rerankerConfig.apiKey,
        rerankerConfig.model,
        query,
        documents,
        n,
      );

      // Per-attempt 10s timeout; retried up to 4 times on transient upstream
      // failures (502/503/504/AbortError). On persistent failure we fall back
      // to the calibrated scores via the outer catch block.
      const response = await withTransientRetry(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const resp = await fetch(rerankerConfig.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!resp.ok) {
            // Throw with a status so withTransientRetry can decide to retry.
            const err = new Error(`rerank endpoint returned ${resp.status}`) as Error & { status: number };
            err.status = resp.status;
            throw err;
          }
          return resp;
        } finally {
          clearTimeout(timeout);
        }
      });

      const data = await response.json() as Record<string, unknown>;
      const parsed = parseRerankResponse(provider, data);

      if (!parsed) {
        console.warn("Unified rerank API: invalid response shape, falling back to calibrated scores");
        return pool;
      }

      // Blend: rerankBlendWeight * rerank_score + (1-weight) * calibrated_score
      // Default: 0.7 reranker + 0.3 calibrated (see DEFAULT_CONFIG).
      const blendWeight = this.config.rerankBlendWeight;
      const fusionWeight = 1 - blendWeight;

      // For rank-mode, convert raw rerank scores into rank-normalized values
      // (top-1 = 1.0, top-k = 1 - (k-1)/N). See RetrievalConfig.rerankScoreMode
      // in retriever.ts for the motivation — identical approach here.
      const rerankScoreByIndex = new Map<number, number>();
      if (this.config.rerankScoreMode === "rank") {
        const sorted = [...parsed].sort((a, b) => b.score - a.score);
        const n = sorted.length || 1;
        sorted.forEach((item, rank) => {
          rerankScoreByIndex.set(item.index, 1 - rank / n);
        });
      }

      const reranked = parsed
        .filter(item => item.index >= 0 && item.index < candidates.length)
        .map(item => {
          const original = candidates[item.index];
          const rerankScore = this.config.rerankScoreMode === "rank"
            ? (rerankScoreByIndex.get(item.index) ?? 0)
            : item.score;
          const blended = blendWeight * rerankScore + fusionWeight * original.score;
          return { ...original, score: blended };
        });

      return [...reranked, ...rest].sort((a, b) => b.score - a.score);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        console.warn("Unified rerank API timed out, falling back to calibrated scores");
      } else {
        console.warn("Unified rerank API failed, falling back to calibrated scores:", error);
      }
      return pool;
    }
  }

  // ---------------------------------------------------------------------------
  // Stage 8: Post-merge modifiers
  // ---------------------------------------------------------------------------

  /**
   * Infer durability class for a conversation memory entry.
   * Determines how aggressively time decay is applied.
   */
  private inferDurability(entry: MemoryEntry): "permanent" | "transient" | "ephemeral" {
    const imp = entry.importance ?? 0.5;
    const cat = entry.category;
    const text = entry.text.toLowerCase();

    if (imp >= 0.85 && (cat === "preference" || cat === "decision")) return "permanent";
    if (imp <= 0.4 || /\b(today|right now|this morning|this afternoon|just now)\b/.test(text)) return "ephemeral";
    return "transient";
  }

  /**
   * Apply post-merge modifiers to conversation results only.
   * Documents get no temporal/importance adjustment.
   *
   * Modifiers:
   * - Durability-aware time decay
   * - Importance weight
   * - Length normalization
   * - Floor guarantee: never reduce below 25% of calibrated score
   */
  private applyPostMergeModifiers(pool: CalibratedResult[]): CalibratedResult[] {
    const now = Date.now();

    return pool.map(r => {
      if (r.source !== "conversation") return r;

      const entry = r.metadata as any;
      const timestamp = entry.timestamp ?? now;
      const ageDays = (now - timestamp) / 86_400_000;

      // Durability-aware time decay
      const durability = this.inferDurability({
        id: r.id,
        text: r.text,
        vector: [],
        category: entry.category || "other",
        scope: entry.scope || "global",
        importance: entry.importance ?? 0.5,
        timestamp: timestamp,
      });
      let alpha: number, halfLife: number;
      if (durability === "permanent") { alpha = 1.0; halfLife = 1; }
      else if (durability === "ephemeral") { alpha = 0.1; halfLife = 7; }
      else { alpha = 0.5; halfLife = 60; }
      const timeFactor = alpha + (1 - alpha) * Math.exp(-ageDays / halfLife);

      // Importance weight
      const importance = entry.importance ?? 0.5;
      const impFactor = 0.7 + 0.3 * importance;

      // Length normalization
      const charLen = r.text.length;
      const lenRatio = Math.max(charLen / 500, 1);
      const lenFactor = 1 / (1 + 0.5 * Math.log2(lenRatio));

      // Apply modifiers
      const adjusted = r.score * timeFactor * impFactor * lenFactor;

      // Floor guarantee: never reduce below 25% of calibrated score
      const floor = 0.25 * r.calibrated;

      return { ...r, score: Math.max(adjusted, floor) };
    }).sort((a, b) => b.score - a.score);
  }

  // ---------------------------------------------------------------------------
  // Stage 9: Source diversity + final selection
  // ---------------------------------------------------------------------------

  /**
   * Protect top-1 from each source to ensure diversity, then apply
   * minScore filter and limit.
   */
  private applySourceDiversity(pool: CalibratedResult[], limit: number): UnifiedResult[] {
    const topConv = pool.find(r => r.source === "conversation");
    const topDoc = pool.find(r => r.source === "document");
    const selected: CalibratedResult[] = [];
    const selectedIds = new Set<string>();

    const pushUnique = (result: CalibratedResult | undefined) => {
      if (!result || selectedIds.has(result.id) || selected.length >= limit) return;
      selected.push(result);
      selectedIds.add(result.id);
    };

    // Diversity guarantee: reserve space for the best conversation and document hit
    // before filling the remaining slots by score.
    pushUnique(topConv);
    pushUnique(topDoc);

    for (const result of pool) {
      if (selected.length >= limit) break;
      if (selectedIds.has(result.id)) continue;
      if (result.score < this.config.minScore) continue;
      selected.push(result);
      selectedIds.add(result.id);
    }

    return selected
      .sort((a, b) => b.score - a.score)
      .map(r => ({
      id: r.id,
      text: r.text,
      score: r.score,
      rawScore: r.rawScore,
      source: r.source,
      metadata: r.metadata,
    }));
  }
}
