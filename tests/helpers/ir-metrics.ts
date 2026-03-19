/**
 * Pure IR (Information Retrieval) metric functions.
 * No external dependencies — operates on arrays of IDs and relevance maps.
 */

/** Fraction of relevant items found in the top-k results. */
export function recallAtK(relevantIds: string[], resultIds: string[], k: number): number {
  if (relevantIds.length === 0) return 0;
  const topK = resultIds.slice(0, k);
  const relevantSet = new Set(relevantIds);
  const found = topK.filter((id) => relevantSet.has(id)).length;
  return found / relevantIds.length;
}

/** Fraction of the top-k results that are relevant. */
export function precisionAtK(relevantIds: string[], resultIds: string[], k: number): number {
  if (k === 0) return 0;
  const topK = resultIds.slice(0, k);
  if (topK.length === 0) return 0;
  const relevantSet = new Set(relevantIds);
  const found = topK.filter((id) => relevantSet.has(id)).length;
  return found / topK.length;
}

/** Mean Reciprocal Rank — 1/rank of the first relevant result (0 if none found). */
export function mrr(relevantIds: string[], resultIds: string[]): number {
  const relevantSet = new Set(relevantIds);
  for (let i = 0; i < resultIds.length; i++) {
    if (relevantSet.has(resultIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Normalized Discounted Cumulative Gain at k with graded relevance. */
export function ndcgAtK(relevanceMap: Map<string, number>, resultIds: string[], k: number): number {
  const topK = resultIds.slice(0, k);

  // DCG of the actual ranking
  let dcg = 0;
  for (let i = 0; i < topK.length; i++) {
    const rel = relevanceMap.get(topK[i]) ?? 0;
    dcg += (Math.pow(2, rel) - 1) / Math.log2(i + 2); // i+2 because rank is 1-indexed
  }

  // Ideal DCG: sort all relevance values descending, take top k
  const idealRels = Array.from(relevanceMap.values()).sort((a, b) => b - a).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < idealRels.length; i++) {
    idcg += (Math.pow(2, idealRels[i]) - 1) / Math.log2(i + 2);
  }

  if (idcg === 0) return 0;
  return dcg / idcg;
}
