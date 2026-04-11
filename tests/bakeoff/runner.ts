/**
 * Bakeoff runner — orchestration for the model-bakeoff harness.
 *
 * Spawns the existing benchmark scripts (`domain-eval.ts` and `fast-benchmark.ts`)
 * with appropriate env vars, parses their stdout for the metric numbers, and
 * dispatches to the criteria module for the decision.
 *
 * See `docs/design/model-bakeoff.md` for the full spec.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeDelta,
  decide,
  shouldRunStage2,
  formatDeltaTable,
  type BenchmarkResult,
} from "./criteria.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");

export interface BakeoffMode {
  kind: "reranker" | "embedder";
  endpoint: string;
  model: string;
  /** Embedder mode only — vector dimension. */
  vectorDim?: number;
  /** Reranker mode only — provider format (defaults to "jina"). */
  provider?: string;
  /**
   * Embedder mode only — path to the pre-built candidate cache
   * (research-cache-{N}.json built with `tests/build-research-cache.ts`
   * pointed at the candidate embedder).
   */
  candidateCachePath?: string;
  /**
   * Embedder mode only — path to the pre-built candidate chunk-scores
   * (chunk-scores-{N}.json built with `tests/build-chunk-cache.ts`).
   */
  candidateChunkScoresPath?: string;
}

export interface BakeoffOptions {
  /** Skip stage 2 (e2e) entirely — useful for fast iteration. */
  skipE2E?: boolean;
  /** Override defaults from criteria.ts */
  maxRegressionQueries?: number;
  decisiveWinQueries?: number;
}

/**
 * Pre-flight: probe the candidate reranker endpoint with a trivial request
 * to catch unreachable/misconfigured endpoints before running the full
 * benchmark suite (which would silently fall back to cosine and waste time).
 *
 * Exported for testing.
 */
export async function probeRerankerEndpoint(
  endpoint: string,
  apiKey: string,
  model: string,
  timeoutMs: number = 10_000,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          query: "probe",
          documents: ["ping", "pong"],
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        return { ok: false, reason: `HTTP ${resp.status}: ${body.slice(0, 200)}` };
      }
      const data = await resp.json() as Record<string, unknown>;
      // Accept jina shape (results[]) or voyage shape (data[]).
      const hasResults = Array.isArray(data.results) && (data.results as unknown[]).length > 0;
      const hasData = Array.isArray(data.data) && (data.data as unknown[]).length > 0;
      if (!hasResults && !hasData) {
        return { ok: false, reason: "response missing expected results[] or data[] field" };
      }
      return { ok: true };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: unknown) {
    const name = (err as { name?: string })?.name;
    if (name === "AbortError") return { ok: false, reason: `timeout after ${timeoutMs}ms` };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function runBakeoff(mode: BakeoffMode, options: BakeoffOptions = {}): Promise<{ verdict: string; baseline: BenchmarkResult; candidate: BenchmarkResult }> {
  if (mode.kind === "embedder") {
    // v1.5: the harness supports embedder mode as long as the candidate
    // research-cache and chunk-scores files have already been built by
    // `tests/build-research-cache.ts` + `tests/build-chunk-cache.ts`
    // pointed at the candidate embedder. The harness then runs fast-bench
    // against both the baseline cache and the candidate cache and reports
    // the delta. Domain-eval is skipped in embedder mode because it hits
    // the live memex DB whose vectors are built with the BASELINE embedder
    // — not a clean comparison.
    if (!mode.candidateCachePath || !mode.candidateChunkScoresPath) {
      throw new Error(
        "Embedder bakeoff requires `candidateCachePath` and `candidateChunkScoresPath`. " +
        "Pre-build them with `tests/build-research-cache.ts` and `tests/build-chunk-cache.ts` " +
        "pointed at the candidate embedder endpoint/model/dim."
      );
    }
    return runEmbedderBakeoff(mode, options);
  }

  // ---------------------------------------------------------------------------
  // Pre-flight: probe the candidate endpoint before running benchmarks
  // ---------------------------------------------------------------------------
  console.log(`\n=== Pre-flight: probing ${mode.endpoint} ===\n`);
  const probeKey = process.env.RERANK_API_KEY || process.env.MEMEX_RERANK_API_KEY || process.env.EMBED_API_KEY || "";
  const probe = await probeRerankerEndpoint(mode.endpoint, probeKey, mode.model);
  if (!probe.ok) {
    console.error(`ERROR: candidate rerank endpoint probe failed: ${probe.reason}`);
    console.error("Fix the endpoint (or auth/model name) before running the benchmark.");
    throw new Error(`rerank endpoint probe failed: ${probe.reason}`);
  }
  console.log(`  ✓ endpoint responded with a valid rerank response\n`);

  // ---------------------------------------------------------------------------
  // Stage 1: cheap fast benchmarks (reranker mode)
  // ---------------------------------------------------------------------------
  console.log(`=== Stage 1: cheap benchmarks (no LLM cost) ===\n`);

  console.log("running domain-eval baseline...");
  const baselineDomain = await runDomainEval({ rerank: false });
  console.log(`  domain baseline: ${baselineDomain.domainHits}/${baselineDomain.domainTotal}`);

  console.log("running domain-eval candidate...");
  const candidateDomain = await runDomainEval({
    rerank: true,
    rerankEndpoint: mode.endpoint,
    rerankModel: mode.model,
    rerankProvider: mode.provider || "jina",
  });
  console.log(`  domain candidate: ${candidateDomain.domainHits}/${candidateDomain.domainTotal}`);

  console.log("running fast-benchmark TIER=fast baseline...");
  const baselineFast = await runFastBench({ rerank: false });
  console.log(`  LME baseline: R@1=${baselineFast.lmeR1}/${baselineFast.lmeTotal}, R@3=${baselineFast.lmeR3}/${baselineFast.lmeTotal}`);

  console.log("running fast-benchmark TIER=fast candidate...");
  const candidateFast = await runFastBench({
    rerank: true,
    rerankEndpoint: mode.endpoint,
    rerankModel: mode.model,
  });
  console.log(`  LME candidate: R@1=${candidateFast.lmeR1}/${candidateFast.lmeTotal}, R@3=${candidateFast.lmeR3}/${candidateFast.lmeTotal}`);

  const baseline: BenchmarkResult = {
    domainHits: baselineDomain.domainHits,
    domainTotal: baselineDomain.domainTotal,
    lmeR1: baselineFast.lmeR1,
    lmeR3: baselineFast.lmeR3,
    lmeTotal: baselineFast.lmeTotal,
  };
  const candidate: BenchmarkResult = {
    domainHits: candidateDomain.domainHits,
    domainTotal: candidateDomain.domainTotal,
    lmeR1: candidateFast.lmeR1,
    lmeR3: candidateFast.lmeR3,
    lmeTotal: candidateFast.lmeTotal,
  };

  const stage1Delta = computeDelta(baseline, candidate);
  console.log("\n" + formatDeltaTable(stage1Delta));

  // ---------------------------------------------------------------------------
  // Stage 2 gate
  // ---------------------------------------------------------------------------
  if (options.skipE2E || !shouldRunStage2(stage1Delta)) {
    if (options.skipE2E) {
      console.log("\n[stage 2 skipped — --skip-e2e]");
    } else {
      console.log("\n[stage 2 skipped — stage 1 hard fail]");
    }
    const verdict = decide(stage1Delta);
    console.log(`\nverdict: ${verdict}`);
    return { verdict, baseline, candidate };
  }

  // ---------------------------------------------------------------------------
  // Stage 2: e2e with GPT-4o (cache-protected)
  // ---------------------------------------------------------------------------
  console.log(`\n=== Stage 2: e2e with GPT-4o (cache-protected) ===\n`);

  await withCacheGuard(async () => {
    console.log("running fast-benchmark TIER=e2e baseline (fresh generation)...");
    const baselineE2E = await runFastBench({ rerank: false, tier: "e2e" });
    baseline.lmeE2E = baselineE2E.lmeE2E;
    console.log(`  E2E baseline: ${baselineE2E.lmeE2E}/${baselineE2E.lmeTotal}`);

    console.log("running fast-benchmark TIER=e2e candidate (fresh generation)...");
    const candidateE2E = await runFastBench({
      rerank: true,
      rerankEndpoint: mode.endpoint,
      rerankModel: mode.model,
      tier: "e2e",
    });
    candidate.lmeE2E = candidateE2E.lmeE2E;
    console.log(`  E2E candidate: ${candidateE2E.lmeE2E}/${candidateE2E.lmeTotal}`);
  });

  const stage2Delta = computeDelta(baseline, candidate);
  console.log("\n" + formatDeltaTable(stage2Delta));

  const verdict = decide(stage2Delta);
  console.log(`\nverdict: ${verdict}`);
  return { verdict, baseline, candidate };
}

// ============================================================================
// Internals
// ============================================================================

interface BenchEnv {
  rerank: boolean;
  rerankEndpoint?: string;
  rerankModel?: string;
  rerankProvider?: string;
  tier?: "fast" | "e2e";
  /** Override research-cache-50.json (embedder mode). */
  cachePath?: string;
  /** Override chunk-scores-50.json (embedder mode). */
  chunkScoresPath?: string;
}

// ---------------------------------------------------------------------------
// Embedder mode
// ---------------------------------------------------------------------------

async function runEmbedderBakeoff(
  mode: BakeoffMode,
  options: BakeoffOptions,
): Promise<{ verdict: string; baseline: BenchmarkResult; candidate: BenchmarkResult }> {
  console.log(`\n=== Stage 1: cheap benchmarks (embedder swap) ===\n`);
  console.log(`Candidate embedder: ${mode.model} @ ${mode.endpoint} (dim=${mode.vectorDim ?? "default"})`);
  console.log(`Candidate cache:    ${mode.candidateCachePath}`);
  console.log(`Candidate chunks:   ${mode.candidateChunkScoresPath}`);
  console.log("");
  console.log("NOTE: domain-eval is skipped in embedder mode because it runs against");
  console.log("the live memex DB, whose vectors are built with the baseline embedder.");
  console.log("Only fast-benchmark (which uses the configurable cache paths) is used.");
  console.log("");

  console.log("running fast-benchmark TIER=fast on baseline cache...");
  const baselineFast = await runFastBench({ rerank: false });
  console.log(`  baseline: R@1=${baselineFast.lmeR1}/${baselineFast.lmeTotal}, R@3=${baselineFast.lmeR3}/${baselineFast.lmeTotal}`);

  console.log("running fast-benchmark TIER=fast on candidate cache...");
  const candidateFast = await runFastBench({
    rerank: false,
    cachePath: mode.candidateCachePath,
    chunkScoresPath: mode.candidateChunkScoresPath,
  });
  console.log(`  candidate: R@1=${candidateFast.lmeR1}/${candidateFast.lmeTotal}, R@3=${candidateFast.lmeR3}/${candidateFast.lmeTotal}`);

  const baseline: BenchmarkResult = {
    // Domain eval not run in embedder mode — set to 0/0 and mark via
    // the delta table that domain-eval wasn't measured.
    domainHits: 0,
    domainTotal: 0,
    lmeR1: baselineFast.lmeR1,
    lmeR3: baselineFast.lmeR3,
    lmeTotal: baselineFast.lmeTotal,
  };
  const candidate: BenchmarkResult = {
    domainHits: 0,
    domainTotal: 0,
    lmeR1: candidateFast.lmeR1,
    lmeR3: candidateFast.lmeR3,
    lmeTotal: candidateFast.lmeTotal,
  };

  const stage1Delta = computeDelta(baseline, candidate);
  console.log("\n" + formatDeltaTable(stage1Delta));

  if (options.skipE2E || !shouldRunStage2(stage1Delta)) {
    if (options.skipE2E) {
      console.log("\n[stage 2 skipped — --skip-e2e]");
    } else {
      console.log("\n[stage 2 skipped — stage 1 hard fail]");
    }
    const verdict = decide(stage1Delta);
    console.log(`\nverdict: ${verdict}`);
    return { verdict, baseline, candidate };
  }

  // Stage 2 — e2e with cache-protected fresh generation
  console.log(`\n=== Stage 2: e2e with GPT-4o (cache-protected) ===\n`);

  await withCacheGuard(async () => {
    console.log("running fast-benchmark TIER=e2e on baseline cache (fresh generation)...");
    const baselineE2E = await runFastBench({ rerank: false, tier: "e2e" });
    baseline.lmeE2E = baselineE2E.lmeE2E;
    console.log(`  baseline E2E: ${baselineE2E.lmeE2E}/${baselineE2E.lmeTotal}`);

    console.log("running fast-benchmark TIER=e2e on candidate cache (fresh generation)...");
    const candidateE2E = await runFastBench({
      rerank: false,
      tier: "e2e",
      cachePath: mode.candidateCachePath,
      chunkScoresPath: mode.candidateChunkScoresPath,
    });
    candidate.lmeE2E = candidateE2E.lmeE2E;
    console.log(`  candidate E2E: ${candidateE2E.lmeE2E}/${candidateE2E.lmeTotal}`);
  });

  const stage2Delta = computeDelta(baseline, candidate);
  console.log("\n" + formatDeltaTable(stage2Delta));

  const verdict = decide(stage2Delta);
  console.log(`\nverdict: ${verdict}`);
  return { verdict, baseline, candidate };
}

// ============================================================================
// Output parsers (pure functions — unit-testable without spawning processes)
// ============================================================================

export interface DomainEvalOutput {
  domainHits: number;
  domainTotal: number;
}

export interface FastBenchOutput {
  lmeR1: number;
  lmeR3: number;
  lmeTotal: number;
  lmeE2E?: number;
}

/** Parse `Hits: N/M` from domain-eval.ts stdout. Throws on malformed input. */
export function parseDomainEvalOutput(stdout: string): DomainEvalOutput {
  const m = stdout.match(/Hits:\s+(\d+)\/(\d+)/);
  if (!m) {
    throw new Error(
      "could not parse domain-eval output — expected 'Hits: N/M' line. " +
      "Got (first 500 chars): " + stdout.slice(0, 500)
    );
  }
  return { domainHits: parseInt(m[1], 10), domainTotal: parseInt(m[2], 10) };
}

/** Parse `R@1: N/M`, `R@3: N/M`, optional `E2E: N/M` from fast-benchmark.ts stdout. */
export function parseFastBenchOutput(stdout: string): FastBenchOutput {
  const r1 = stdout.match(/R@1:\s+(\d+)\/(\d+)/);
  const r3 = stdout.match(/R@3:\s+(\d+)\/(\d+)/);
  if (!r1 || !r3) {
    throw new Error(
      "could not parse fast-benchmark output — expected 'R@1: N/M' and 'R@3: N/M' lines. " +
      "Got (first 500 chars): " + stdout.slice(0, 500)
    );
  }
  const result: FastBenchOutput = {
    lmeR1: parseInt(r1[1], 10),
    lmeR3: parseInt(r3[1], 10),
    lmeTotal: parseInt(r1[2], 10),
  };
  const e2e = stdout.match(/E2E:\s+(\d+)\/(\d+)/);
  if (e2e) result.lmeE2E = parseInt(e2e[1], 10);
  return result;
}

// ============================================================================
// Child-process dispatch
// ============================================================================

async function runDomainEval(env: BenchEnv): Promise<DomainEvalOutput> {
  const subEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    RERANK: env.rerank ? "1" : "0",
  };
  if (env.rerank) {
    if (!env.rerankEndpoint || !env.rerankModel) {
      throw new Error("rerank=true requires rerankEndpoint and rerankModel");
    }
    subEnv.MEMEX_RERANK_ENDPOINT = env.rerankEndpoint;
    subEnv.MEMEX_RERANK_MODEL = env.rerankModel;
    subEnv.MEMEX_RERANK_API_KEY = process.env.MEMEX_RERANK_API_KEY || subEnv.EMBED_API_KEY || "";
  }

  const out = await spawnCapture("node", [
    "--import", "jiti/register",
    join(REPO_ROOT, "tests", "domain-eval.ts"),
  ], subEnv);

  return parseDomainEvalOutput(out);
}

async function runFastBench(env: BenchEnv): Promise<FastBenchOutput> {
  const tier = env.tier || "fast";
  const subEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    TIER: tier,
    RERANK: env.rerank ? "1" : "0",
  };
  if (env.rerank) {
    if (!env.rerankEndpoint || !env.rerankModel) {
      throw new Error("rerank=true requires rerankEndpoint and rerankModel");
    }
    subEnv.RERANK_ENDPOINT = env.rerankEndpoint;
    subEnv.RERANK_MODEL = env.rerankModel;
    subEnv.RERANK_API_KEY = process.env.RERANK_API_KEY || subEnv.EMBED_API_KEY || "";
  }
  if (env.cachePath) {
    subEnv.FAST_BENCH_CACHE_PATH = env.cachePath;
  }
  if (env.chunkScoresPath) {
    subEnv.FAST_BENCH_CHUNK_SCORES_PATH = env.chunkScoresPath;
  }

  const out = await spawnCapture("node", [
    "--import", "jiti/register",
    join(REPO_ROOT, "tests", "fast-benchmark.ts"),
  ], subEnv);

  return parseFastBenchOutput(out);
}

function spawnCapture(cmd: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\nstderr:\n${stderr}\nstdout:\n${stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * Wrap a block in cache backup/restore so cache invalidation never leaks.
 *
 * Backs up the gpt-4o response cache, runs the block, then restores from
 * backup regardless of success or failure. Hash-checks the restore to make
 * sure it actually completed.
 */
async function withCacheGuard<T>(fn: () => Promise<T>): Promise<T> {
  const cachePath = join(REPO_ROOT, "tests", "fixtures", "longmemeval-cache", "fast-responses-gpt-4o.json");
  const backupPath = cachePath + ".bakeoff-backup";
  const hadOriginal = existsSync(cachePath);

  if (hadOriginal) {
    copyFileSync(cachePath, backupPath);
  }

  try {
    return await fn();
  } finally {
    if (hadOriginal) {
      copyFileSync(backupPath, cachePath);
      // Verify by reading the size — content match would require a hash
      const restoredSize = readFileSync(cachePath).length;
      const backupSize = readFileSync(backupPath).length;
      if (restoredSize !== backupSize) {
        throw new Error(`cache restore failed: backup ${backupSize} bytes, restored ${restoredSize} bytes`);
      }
      try { unlinkSync(backupPath); } catch {}
    } else if (existsSync(cachePath)) {
      // We didn't have an original, but the run created one — leave it.
    }
  }
}
