/**
 * CLI entry for the bakeoff harness — invoked by scripts/bakeoff.
 *
 * Reads BAKEOFF_MODE / BAKEOFF_ENDPOINT / BAKEOFF_MODEL / BAKEOFF_PROVIDER
 * / BAKEOFF_SKIP_E2E from the env (set by the bash wrapper) and dispatches
 * to runBakeoff. Exit code: 0 = PASS, 1 = HOLD/FAIL, 2 = error.
 */
import { runBakeoff, type BakeoffMode } from "./runner.js";

async function main() {
  const mode = process.env.BAKEOFF_MODE;
  const endpoint = process.env.BAKEOFF_ENDPOINT;
  const model = process.env.BAKEOFF_MODEL;
  const provider = process.env.BAKEOFF_PROVIDER || "jina";
  const skipE2E = process.env.BAKEOFF_SKIP_E2E === "true";
  const vectorDimRaw = process.env.BAKEOFF_VECTOR_DIM;
  const candidateCachePath = process.env.BAKEOFF_CANDIDATE_CACHE_PATH;
  const candidateChunkScoresPath = process.env.BAKEOFF_CANDIDATE_CHUNK_SCORES_PATH;

  if (mode !== "reranker" && mode !== "embedder") {
    console.error(`ERROR: BAKEOFF_MODE must be reranker|embedder (got: ${mode})`);
    process.exit(2);
  }
  if (!endpoint || !model) {
    console.error(`ERROR: BAKEOFF_ENDPOINT and BAKEOFF_MODEL must be set`);
    process.exit(2);
  }

  const m: BakeoffMode = {
    kind: mode,
    endpoint,
    model,
    provider,
    vectorDim: vectorDimRaw ? parseInt(vectorDimRaw, 10) : undefined,
    candidateCachePath,
    candidateChunkScoresPath,
  };
  const result = await runBakeoff(m, { skipE2E });
  process.exit(result.verdict === "PASS" ? 0 : 1);
}

main().catch(e => {
  console.error("bakeoff failed:", e);
  process.exit(2);
});
