import { mrr, ndcgAtK, recallAtK } from "./ir-metrics.js";

export interface BeirQueryMetrics {
  queryId: string;
  mrr: number;
  ndcgAt10: number;
  recall: Record<number, number>;
}

export interface BeirSummary {
  queryCount: number;
  mrr: number;
  ndcgAt10: number;
  recallAt: Record<number, number>;
}

export function evaluateBeirQuery(
  queryId: string,
  qrels: Map<string, number>,
  resultIds: string[],
  recallKs: number[] = [1, 3, 5, 10]
): BeirQueryMetrics {
  const relevantIds = Array.from(qrels.entries())
    .filter(([, grade]) => grade > 0)
    .map(([docId]) => docId);

  const recall: Record<number, number> = {};
  for (const k of recallKs) {
    recall[k] = recallAtK(relevantIds, resultIds, k);
  }

  return {
    queryId,
    mrr: mrr(relevantIds, resultIds),
    ndcgAt10: ndcgAtK(qrels, resultIds, 10),
    recall,
  };
}

export function summarizeBeirQueries(metrics: BeirQueryMetrics[]): BeirSummary {
  if (metrics.length === 0) {
    return { queryCount: 0, mrr: 0, ndcgAt10: 0, recallAt: {} };
  }

  const recallKs = new Set<number>();
  for (const metric of metrics) {
    for (const key of Object.keys(metric.recall)) {
      recallKs.add(Number(key));
    }
  }

  const recallAt: Record<number, number> = {};
  for (const k of recallKs) {
    const total = metrics.reduce((sum, metric) => sum + (metric.recall[k] ?? 0), 0);
    recallAt[k] = total / metrics.length;
  }

  return {
    queryCount: metrics.length,
    mrr: metrics.reduce((sum, metric) => sum + metric.mrr, 0) / metrics.length,
    ndcgAt10: metrics.reduce((sum, metric) => sum + metric.ndcgAt10, 0) / metrics.length,
    recallAt,
  };
}
