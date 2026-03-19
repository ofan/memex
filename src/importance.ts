/**
 * Shared Importance Scorer
 * Scores text importance via reranker (cross-encoder) or heuristic fallback.
 * Used by both auto-capture (index.ts) and session-indexer (session-indexer.ts).
 */

// ============================================================================
// Sigmoid normalization
// ============================================================================

/** Sigmoid function: maps raw logits to 0-1 probability range */
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ============================================================================
// Heuristic importance scoring
// ============================================================================

// Keyword triggers for heuristic fallback
const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /\b(we )?decided\b|we'?ll use|we will use|switch(ed)? to|migrate(d)? to|going forward|from now on/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need|care)/i,
  /\b(i always|i never|is important to me|really important)\b/i,
];

/** Heuristic importance score: 0.0-1.0 based on keyword triggers */
export function heuristicImportance(text: string): number {
  const matchCount = MEMORY_TRIGGERS.filter(r => r.test(text)).length;
  if (matchCount === 0) return 0.3; // baseline — might still be useful context
  if (matchCount === 1) return 0.6;
  if (matchCount === 2) return 0.8;
  return 0.9;
}

// ============================================================================
// Reranker-based importance scoring
// ============================================================================

const IMPORTANCE_REFERENCE = "Important knowledge, preference, decision, fact, or technical detail worth remembering long-term";

/**
 * Score importance of texts via reranker endpoint.
 * Returns array of 0-1 scores (sigmoid-normalized).
 * Falls back to heuristic scoring on error.
 */
export async function scoreImportance(
  texts: string[],
  endpoint: string,
  model: string,
  apiKey?: string,
): Promise<number[]> {
  const scores = new Array(texts.length).fill(0.3); // fallback

  const batchSize = 20;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }

      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          query: IMPORTANCE_REFERENCE,
          documents: batch,
          top_n: batch.length,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) continue;
      const data = await resp.json() as any;
      const results = data.results || data.data || [];

      for (const item of results) {
        const idx = item.index;
        const rawScore = item.relevance_score ?? item.score ?? 0;
        if (typeof idx === "number" && idx >= 0 && idx < batch.length) {
          // Sigmoid-normalize raw logits, then scale to useful range
          // Raw logits from bge-reranker are typically -15 to +5
          // Sigmoid maps these to ~0 to ~0.99
          scores[i + idx] = sigmoid(rawScore);
        }
      }
    } catch {
      // Fallback to heuristic for this batch
      for (let j = 0; j < batch.length; j++) {
        scores[i + j] = heuristicImportance(batch[j]);
      }
    }

    if (i + batchSize < texts.length) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  return scores;
}
