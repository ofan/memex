import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDomainEvalOutput, parseFastBenchOutput } from "./runner.js";

// ============================================================================
// Fixtures — realistic stdout from the actual benchmark scripts
// ============================================================================

const DOMAIN_EVAL_OUTPUT_PASS = `
Pool: 2105 memories
Reranker: ENABLED (Qwen3-Reranker-0.6B-Q8_0)  Pool: 30

  HIT  [person] ryan-ban-sorry (0.782, entities: ryan,cabbie)
  HIT  [person] ryan-response-style (0.877, entities: ebay,ryan)
  HIT  [person] ryan-grafana (0.841, entities: ryan,grafana)
  MISS  [system] host-A-model (0.886, entities: none)
       query: "What model is running on host-A?"
       expected: qwen, host-A
       got: "host-A oMLX installed"
  HIT  [system] host-A-user (0.852, entities: ryan)
  HIT  [system] server-config (0.911, entities: ryan)
  MISS  [model] gemma4-stability (0.912, entities: gemma)
  HIT  [model] virgil-streaming (0.941, entities: virgil)
  HIT  [model] virgil-reasoning (0.932, entities: virgil)
  HIT  [multi-entity] ryan-host-A-deployment (0.912, entities: host-A)
  MISS  [multi-entity] virgil-qwen (0.941, entities: virgil)
  MISS  [multi-entity] ryan-cabbie-behavior (0.810, entities: cabbie)
  HIT  [temporal] recent-deployments (0.822, entities: gemma)
  HIT  [rule] homebrew-rule (0.838, entities: homebrew)
  HIT  [rule] private-repos (0.734, entities: github)

=== Domain Eval Results ===
  Total:  15
  Hits:   11/15 (73%)
  Misses: 4
  person: 3/3
  system: 2/3
  model: 2/3
  multi-entity: 1/3
  temporal: 1/1
  rule: 2/2
`;

const FAST_BENCH_FAST_TIER = `
Loading research cache...
Loaded 50 examples (1.5s parse)
Loaded chunk scores (2000c/200o, 16691 chunks) in 0.0s

Tier: fast | Fusion: zscore 0.8v+0.2b | Pool: 30/20 | Vec: chunked
10/50 20/50 30/50 40/50 50/50

=== Fast Benchmark (fast, zscore 0.8v+0.2b, pool=30/20, vec=chunked, N=50) ===

  miss e47becba "What degree did I graduate with?..."
  miss 1e043500 "What is the name of the playlist I created on Spotify?..."
  ...

  R@1:  41/50 (82%)
  R@3:  45/50 (90%)
  Time: 137.6s
`;

const FAST_BENCH_E2E_TIER = `
Tier: e2e | Fusion: zscore 0.8v+0.2b | Pool: 30/20 | Vec: chunked

  miss/FAIL e47becba "What degree did I graduate with?..."
    expected: Business Administration | got: I don't have info...
  R@1/FAIL 51a45a95 "Where did I redeem a $5 coupon on coffee creamer?..."
  ...

  R@1:  41/50 (82%)
  R@3:  45/50 (90%)
  E2E:  47/50 (94%)
  Time: 353.3s
`;

// ============================================================================
// Tests
// ============================================================================

describe("parseDomainEvalOutput", () => {
  it("parses a passing run", () => {
    const result = parseDomainEvalOutput(DOMAIN_EVAL_OUTPUT_PASS);
    assert.equal(result.domainHits, 11);
    assert.equal(result.domainTotal, 15);
  });

  it("parses a run where N != default 15", () => {
    const stdout = `
=== Domain Eval Results ===
  Total:  20
  Hits:   18/20 (90%)
`;
    const result = parseDomainEvalOutput(stdout);
    assert.equal(result.domainHits, 18);
    assert.equal(result.domainTotal, 20);
  });

  it("throws on output missing the Hits: line", () => {
    assert.throws(
      () => parseDomainEvalOutput("some random output without the expected line"),
      /could not parse domain-eval output/,
    );
  });

  it("throws on output with partial Hits: line", () => {
    assert.throws(
      () => parseDomainEvalOutput("Hits: 11 (73%)"),  // missing /total
      /could not parse domain-eval output/,
    );
  });

  it("error message includes first 500 chars of stdout for debuggability", () => {
    const bad = "x".repeat(1000);
    try {
      parseDomainEvalOutput(bad);
      assert.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      assert.ok(msg.includes("x"), "error should reference the bad input");
      assert.ok(msg.length < 1000, "error should not dump full input");
    }
  });
});

describe("parseFastBenchOutput", () => {
  it("parses fast tier (no E2E)", () => {
    const result = parseFastBenchOutput(FAST_BENCH_FAST_TIER);
    assert.equal(result.lmeR1, 41);
    assert.equal(result.lmeR3, 45);
    assert.equal(result.lmeTotal, 50);
    assert.equal(result.lmeE2E, undefined);
  });

  it("parses e2e tier with E2E present", () => {
    const result = parseFastBenchOutput(FAST_BENCH_E2E_TIER);
    assert.equal(result.lmeR1, 41);
    assert.equal(result.lmeR3, 45);
    assert.equal(result.lmeTotal, 50);
    assert.equal(result.lmeE2E, 47);
  });

  it("parses output with different N", () => {
    const stdout = `
  R@1:  85/100 (85%)
  R@3:  92/100 (92%)
  Time: 10s
`;
    const result = parseFastBenchOutput(stdout);
    assert.equal(result.lmeR1, 85);
    assert.equal(result.lmeR3, 92);
    assert.equal(result.lmeTotal, 100);
    assert.equal(result.lmeE2E, undefined);
  });

  it("throws on missing R@1 line", () => {
    const stdout = `
  R@3: 45/50 (90%)
`;
    assert.throws(
      () => parseFastBenchOutput(stdout),
      /could not parse fast-benchmark output/,
    );
  });

  it("throws on missing R@3 line", () => {
    const stdout = `
  R@1: 41/50 (82%)
`;
    assert.throws(
      () => parseFastBenchOutput(stdout),
      /could not parse fast-benchmark output/,
    );
  });

  it("throws on empty output", () => {
    assert.throws(
      () => parseFastBenchOutput(""),
      /could not parse fast-benchmark output/,
    );
  });

  it("tolerates extra whitespace in the metric lines", () => {
    // Some tmux/ansi contexts add extra spaces — make sure the regex is lenient
    const stdout = `
  R@1:     41/50  (82%)
  R@3:     45/50  (90%)
`;
    const result = parseFastBenchOutput(stdout);
    assert.equal(result.lmeR1, 41);
    assert.equal(result.lmeR3, 45);
  });

  it("picks up E2E when it appears after R@1 and R@3 in the same section", () => {
    const stdout = `
  R@1:  39/50 (78%)
  R@3:  45/50 (90%)
  E2E:  45/50 (90%)
  Time: 31.5s
`;
    const result = parseFastBenchOutput(stdout);
    assert.equal(result.lmeE2E, 45);
  });

  it("does NOT confuse a question label like 'R@1/CORRECT' with the summary line", () => {
    const stdout = `
[read] 29/50... R@1/CORRECT [single-session-user] "What is my preferred gin..."
[read] 30/50... R@1/CORRECT [single-session-user] "How much RAM did I upgrade..."

  R@1:  39/50 (78%)
  R@3:  45/50 (90%)
`;
    const result = parseFastBenchOutput(stdout);
    // The regex requires ":" after R@1 so "R@1/CORRECT" should be skipped
    assert.equal(result.lmeR1, 39);
    assert.equal(result.lmeR3, 45);
  });
});
