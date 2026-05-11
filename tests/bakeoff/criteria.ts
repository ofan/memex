/**
 * Decision logic for the bakeoff harness.
 *
 * Pure functions over benchmark deltas. No I/O. No globals. Easy to unit-test.
 *
 * See `docs/design/model-bakeoff.md` for the spec this implements.
 */

export interface BenchmarkResult {
  /** Domain eval hits, e.g. 12 of 15 */
  domainHits: number;
  domainTotal: number;
  /** LongMemEval (fast tier) recall numbers, e.g. 39 of 50 */
  lmeR1: number;
  lmeR3: number;
  lmeTotal: number;
  /** Optional E2E score (only when stage 2 ran), e.g. 45 of 50 */
  lmeE2E?: number;
}

export interface DeltaRow {
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  /** "+", "0", "-" — for table formatting */
  symbol: "+" | "0" | "-";
}

export interface DeltaSummary {
  rows: DeltaRow[];
  /** Largest regression in queries (positive number; 0 if no regression) */
  maxRegression: number;
  /** Largest improvement in queries */
  maxImprovement: number;
  /** Whether any e2e number is present */
  hasE2E: boolean;
}

export type Verdict = "PASS" | "HOLD" | "FAIL";

export interface DecisionCriteria {
  /** A regression of more than this many queries on any metric → fail. Default: 1. */
  maxRegressionQueries: number;
  /** Improvement of at least this many queries → considered "decisive". Default: 2. */
  decisiveWinQueries: number;
  /** If true, any regression on E2E is a hard fail. Default: true. */
  e2eRequired: boolean;
}

export const DEFAULT_CRITERIA: DecisionCriteria = {
  maxRegressionQueries: 1,
  decisiveWinQueries: 2,
  e2eRequired: true,
};

export function computeDelta(baseline: BenchmarkResult, candidate: BenchmarkResult): DeltaSummary {
  const rows: DeltaRow[] = [
    makeRow("domain-eval", baseline.domainHits, candidate.domainHits),
    makeRow("LME R@1", baseline.lmeR1, candidate.lmeR1),
    makeRow("LME R@3", baseline.lmeR3, candidate.lmeR3),
  ];
  const hasE2E = baseline.lmeE2E !== undefined && candidate.lmeE2E !== undefined;
  if (hasE2E) {
    rows.push(makeRow("LME E2E", baseline.lmeE2E!, candidate.lmeE2E!));
  }

  let maxRegression = 0;
  let maxImprovement = 0;
  for (const r of rows) {
    if (r.delta < 0) maxRegression = Math.max(maxRegression, -r.delta);
    if (r.delta > 0) maxImprovement = Math.max(maxImprovement, r.delta);
  }

  return { rows, maxRegression, maxImprovement, hasE2E };
}

function makeRow(metric: string, baseline: number, candidate: number): DeltaRow {
  const delta = candidate - baseline;
  return {
    metric,
    baseline,
    candidate,
    delta,
    symbol: delta > 0 ? "+" : delta < 0 ? "-" : "0",
  };
}

/**
 * Decide whether to ship the candidate based on the delta and criteria.
 *
 * Logic (in order):
 * - Any regression > maxRegressionQueries on any metric → FAIL
 * - E2E present AND e2eRequired AND E2E delta < 0 → FAIL
 * - At least one improvement >= decisiveWinQueries → PASS
 * - Otherwise (improvement = 0 or 1 query, no regressions) → HOLD
 */
export function decide(delta: DeltaSummary, criteria: DecisionCriteria = DEFAULT_CRITERIA): Verdict {
  if (delta.maxRegression > criteria.maxRegressionQueries) return "FAIL";
  if (criteria.e2eRequired && delta.hasE2E) {
    const e2e = delta.rows.find(r => r.metric === "LME E2E");
    if (e2e && e2e.delta < 0) return "FAIL";
  }
  if (delta.maxImprovement >= criteria.decisiveWinQueries) return "PASS";
  return "HOLD";
}

/**
 * Whether to run stage 2 (e2e) given stage 1 results.
 *
 * Skip stage 2 if stage 1 is already a hard fail. Otherwise run e2e to
 * confirm or tie-break.
 */
export function shouldRunStage2(stage1Delta: DeltaSummary, criteria: DecisionCriteria = DEFAULT_CRITERIA): boolean {
  if (stage1Delta.maxRegression > criteria.maxRegressionQueries) return false;
  return true;
}

/**
 * Format a delta summary as a markdown-like table for stdout.
 */
export function formatDeltaTable(delta: DeltaSummary): string {
  const lines: string[] = [];
  lines.push("              | baseline | candidate | Δ");
  lines.push("--------------|----------|-----------|------");
  for (const r of delta.rows) {
    const sign = r.delta > 0 ? "+" : r.delta < 0 ? "" : " ";
    lines.push(
      `${r.metric.padEnd(13)} | ${String(r.baseline).padStart(8)} | ${String(r.candidate).padStart(9)} | ${sign}${r.delta}  ${r.symbol === "+" ? "✓" : r.symbol === "-" ? "✗" : "◯"}`
    );
  }
  return lines.join("\n");
}
