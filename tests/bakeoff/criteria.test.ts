import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeDelta,
  decide,
  shouldRunStage2,
  formatDeltaTable,
  type BenchmarkResult,
  type DecisionCriteria,
} from "./criteria.js";

const baseline: BenchmarkResult = {
  domainHits: 12,
  domainTotal: 15,
  lmeR1: 39,
  lmeR3: 45,
  lmeTotal: 50,
  lmeE2E: 45,
};

describe("computeDelta", () => {
  it("computes per-metric deltas", () => {
    const candidate: BenchmarkResult = { ...baseline, domainHits: 14, lmeR1: 41, lmeE2E: 47 };
    const delta = computeDelta(baseline, candidate);
    assert.equal(delta.rows.length, 4);
    assert.equal(delta.rows[0].delta, 2, "domain +2");
    assert.equal(delta.rows[1].delta, 2, "R@1 +2");
    assert.equal(delta.rows[2].delta, 0, "R@3 0");
    assert.equal(delta.rows[3].delta, 2, "E2E +2");
  });

  it("tracks max improvement and max regression", () => {
    const candidate: BenchmarkResult = { ...baseline, domainHits: 14, lmeR1: 37 };
    const delta = computeDelta(baseline, candidate);
    assert.equal(delta.maxImprovement, 2);
    assert.equal(delta.maxRegression, 2);
  });

  it("omits e2e row when neither side has it", () => {
    const b: BenchmarkResult = { ...baseline, lmeE2E: undefined };
    const c: BenchmarkResult = { ...baseline, lmeE2E: undefined };
    const delta = computeDelta(b, c);
    assert.equal(delta.rows.length, 3);
    assert.equal(delta.hasE2E, false);
  });

  it("symbol reflects sign of delta", () => {
    const candidate: BenchmarkResult = { ...baseline, domainHits: 14, lmeR1: 39, lmeR3: 44 };
    const delta = computeDelta(baseline, candidate);
    assert.equal(delta.rows[0].symbol, "+");
    assert.equal(delta.rows[1].symbol, "0");
    assert.equal(delta.rows[2].symbol, "-");
  });
});

describe("decide", () => {
  it("PASS on decisive win, no regressions", () => {
    const candidate: BenchmarkResult = { ...baseline, lmeR1: 41, lmeE2E: 47 };
    const verdict = decide(computeDelta(baseline, candidate));
    assert.equal(verdict, "PASS");
  });

  it("FAIL on any single regression > maxRegressionQueries", () => {
    const candidate: BenchmarkResult = { ...baseline, lmeR1: 36 };  // -3
    const verdict = decide(computeDelta(baseline, candidate));
    assert.equal(verdict, "FAIL");
  });

  it("FAIL on E2E regression when e2eRequired", () => {
    const candidate: BenchmarkResult = { ...baseline, lmeR1: 41, lmeE2E: 44 };  // E2E -1
    const verdict = decide(computeDelta(baseline, candidate));
    assert.equal(verdict, "FAIL");
  });

  it("HOLD on neutral / marginal change", () => {
    const candidate: BenchmarkResult = { ...baseline, lmeR1: 40, lmeE2E: 45 };  // R@1 +1, E2E 0
    const verdict = decide(computeDelta(baseline, candidate));
    assert.equal(verdict, "HOLD");
  });

  it("PASS on a 1-query regression bounded by criteria", () => {
    // domain +2 (decisive win), LME R@3 -1 (within tolerance)
    const candidate: BenchmarkResult = { ...baseline, domainHits: 14, lmeR3: 44 };
    const verdict = decide(computeDelta(baseline, candidate));
    assert.equal(verdict, "PASS");
  });

  it("FAIL when regression exceeds tolerance even with a decisive win", () => {
    // domain +3 wins, but R@3 -2 fails
    const candidate: BenchmarkResult = { ...baseline, domainHits: 15, lmeR3: 43 };
    const verdict = decide(computeDelta(baseline, candidate));
    assert.equal(verdict, "FAIL");
  });

  it("custom criteria can loosen tolerance", () => {
    const loose: DecisionCriteria = { maxRegressionQueries: 2, decisiveWinQueries: 2, e2eRequired: false };
    const candidate: BenchmarkResult = { ...baseline, domainHits: 14, lmeR3: 43 };  // R@3 -2
    assert.equal(decide(computeDelta(baseline, candidate)), "FAIL", "default rejects -2");
    assert.equal(decide(computeDelta(baseline, candidate), loose), "PASS", "loose accepts -2");
  });
});

describe("shouldRunStage2", () => {
  it("skips stage 2 on hard fail", () => {
    const candidate: BenchmarkResult = { ...baseline, lmeR1: 35, lmeE2E: undefined };
    const stage1 = computeDelta(baseline, { ...candidate, lmeE2E: undefined });
    assert.equal(shouldRunStage2(stage1), false);
  });

  it("runs stage 2 on marginal stage 1", () => {
    const candidate: BenchmarkResult = { ...baseline, domainHits: 13, lmeE2E: undefined };
    const stage1 = computeDelta(baseline, { ...candidate, lmeE2E: undefined });
    assert.equal(shouldRunStage2(stage1), true);
  });

  it("runs stage 2 on decisive win to confirm e2e doesn't regress", () => {
    const candidate: BenchmarkResult = { ...baseline, lmeR1: 42, lmeE2E: undefined };
    const stage1 = computeDelta(baseline, { ...candidate, lmeE2E: undefined });
    assert.equal(shouldRunStage2(stage1), true);
  });
});

describe("formatDeltaTable", () => {
  it("produces a table with all rows", () => {
    const candidate: BenchmarkResult = { ...baseline, domainHits: 14, lmeR1: 41, lmeE2E: 47 };
    const out = formatDeltaTable(computeDelta(baseline, candidate));
    assert.match(out, /domain-eval/);
    assert.match(out, /LME R@1/);
    assert.match(out, /LME E2E/);
    assert.match(out, /\+2/);
  });

  it("works without e2e rows", () => {
    const b: BenchmarkResult = { ...baseline, lmeE2E: undefined };
    const c: BenchmarkResult = { ...baseline, lmeE2E: undefined };
    const out = formatDeltaTable(computeDelta(b, c));
    assert.ok(!out.includes("LME E2E"));
  });
});
