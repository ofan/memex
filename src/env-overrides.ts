/**
 * Env-var overrides for plugin config (12-factor ops override).
 *
 * Precedence: **env > config > default**. When a supported env var is set it
 * overrides the corresponding plugin-config field, so behavior can be flipped
 * per-environment (daemon env, CI, a debug shell) without editing openclaw
 * config. Supported vars are documented in memex.env.example.
 *
 * `applyEnvOverrides` mutates the config in place AND returns it, so call sites
 * read the same `config` object unchanged. Pass an explicit `env` in tests to
 * avoid polluting process.env.
 */

export interface RerankerConfigLike {
  enabled?: boolean;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  provider?: string;
  blendWeight?: number;
  scoreMode?: string;
}

export interface EnvOverridableConfig {
  debugRecall?: boolean | string;
  autoRecall?: boolean;
  autoRecallLimit?: number;
  reranker?: RerankerConfigLike;
  retrieval?: { hardMinScore?: number };
  documents?: {
    paths?: Array<{ path: string; name: string; pattern?: string }>;
  };
}

const FALSY = new Set(["", "0", "false", "off", "no"]);

/** True when v is a non-empty string (treats undefined/"" as absent). */
function present(v: string | undefined): v is string {
  return v !== undefined && v !== "";
}

/**
 * Apply env overrides onto `config` in place. Returns the same config.
 * Only overrides when the env var is present (non-empty); leaves config
 * untouched otherwise so declarative config stays authoritative.
 */
export function applyEnvOverrides<T extends EnvOverridableConfig>(config: T, env: NodeJS.ProcessEnv = process.env): T {
  // debugRecall ← MEMEX_DEBUG_RECALL ("1"/"0"/"true"/"false"/dir path)
  if (present(env.MEMEX_DEBUG_RECALL)) {
    config.debugRecall = env.MEMEX_DEBUG_RECALL;
  }

  // autoRecall ← MEMEX_AUTO_RECALL (falsy → off, anything else → on)
  if (present(env.MEMEX_AUTO_RECALL)) {
    config.autoRecall = !FALSY.has(env.MEMEX_AUTO_RECALL.toLowerCase());
  }

  // autoRecallLimit ← MEMEX_AUTO_RECALL_LIMIT (positive int)
  if (present(env.MEMEX_AUTO_RECALL_LIMIT)) {
    const n = parseInt(env.MEMEX_AUTO_RECALL_LIMIT, 10);
    if (Number.isFinite(n) && n > 0) config.autoRecallLimit = n;
  }

  // Reranker ← MEMEX_RERANK_{ENDPOINT,API_KEY,MODEL,PROVIDER}; any one enables + merges
  if (present(env.MEMEX_RERANK_ENDPOINT) || present(env.MEMEX_RERANK_API_KEY) || present(env.MEMEX_RERANK_MODEL) || present(env.MEMEX_RERANK_PROVIDER)) {
    config.reranker = {
      enabled: true,
      endpoint: present(env.MEMEX_RERANK_ENDPOINT) ? env.MEMEX_RERANK_ENDPOINT : config.reranker?.endpoint,
      apiKey: present(env.MEMEX_RERANK_API_KEY) ? env.MEMEX_RERANK_API_KEY : (config.reranker?.apiKey ?? "unused"),
      model: present(env.MEMEX_RERANK_MODEL) ? env.MEMEX_RERANK_MODEL : config.reranker?.model,
      provider: present(env.MEMEX_RERANK_PROVIDER) ? env.MEMEX_RERANK_PROVIDER : config.reranker?.provider,
    };
  }

  // hardMinScore ← MEMEX_HARD_MIN_SCORE_OVERRIDE (float in [0,1])
  if (present(env.MEMEX_HARD_MIN_SCORE_OVERRIDE)) {
    const f = parseFloat(env.MEMEX_HARD_MIN_SCORE_OVERRIDE);
    if (Number.isFinite(f) && f >= 0 && f <= 1) {
      config.retrieval = { ...(config.retrieval ?? {}), hardMinScore: f };
    }
  }

  // documents.paths ← MEMEX_DOC_PATHS (comma-separated <abs-path>:<name>)
  if (present(env.MEMEX_DOC_PATHS)) {
    config.documents = {
      paths: env.MEMEX_DOC_PATHS.split(",").map((entry) => {
        const idx = entry.lastIndexOf(":");
        return idx > 0
          ? { path: entry.slice(0, idx), name: entry.slice(idx + 1) }
          : { path: entry, name: entry.split("/").pop() || entry };
      }),
    };
  }

  return config;
}

/**
 * Mirror config.debugRecall into process.env (only when env is unset) so the
 * env-based debug machinery — resolveDebugDir() / writeDebugRecall() — honors a
 * config-only debugRecall setting. No-op when MEMEX_DEBUG_RECALL is already set
 * (env stays authoritative) or debugRecall is absent.
 */
export function syncDebugEnvFromConfig(config: EnvOverridableConfig, env: NodeJS.ProcessEnv = process.env): void {
  if (env.MEMEX_DEBUG_RECALL !== undefined && env.MEMEX_DEBUG_RECALL !== "") return;
  const d = config.debugRecall;
  if (d === undefined) return;
  env.MEMEX_DEBUG_RECALL = d === true ? "1" : d === false ? "0" : d;
}

export type RerankerProviderName = "jina" | "siliconflow" | "voyage" | "pinecone";
export type RerankerScoreMode = "raw" | "rank";

/** Cross-encoder settings resolved from environment variables. */
export interface ResolvedCrossRerankerConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  provider: RerankerProviderName;
  /** Optional override; omitted callers keep their pipeline-specific default. */
  blendWeight?: number;
  /** Optional post-rerank relevance floor; omitted uses the base minScore. */
  minScore?: number;
  scoreMode: RerankerScoreMode;
  /** Unified reranking confidence gate; defaults favor reranking ambiguous pools. */
  confidenceThreshold: number;
  confidenceGap: number;
}

const VALID_RERANK_PROVIDERS = new Set<RerankerProviderName>([
  "jina", "siliconflow", "voyage", "pinecone",
]);

function clampNumber(value: string | undefined, min: number, max: number, fallback: number): number | undefined {
  if (!present(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Resolve the cross-encoder configuration used by the standalone MCP server.
 *
 * Endpoint and key are both required. This deliberately keeps an explicit
 * operator opt-in, while provider/blend/score-mode/confidence settings can be
 * tuned without code changes.
 */
export function resolveCrossRerankerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCrossRerankerConfig | null {
  const endpoint = env.MEMEX_RERANK_ENDPOINT?.trim();
  const apiKey = env.MEMEX_RERANK_API_KEY?.trim();
  if (!endpoint || !apiKey) return null;

  const requestedProvider = env.MEMEX_RERANK_PROVIDER?.trim().toLowerCase();
  const provider: RerankerProviderName = requestedProvider === "jina"
    ? "jina"
    : requestedProvider && VALID_RERANK_PROVIDERS.has(requestedProvider as RerankerProviderName)
      ? requestedProvider as RerankerProviderName
      : "jina";
  const blendWeight = clampNumber(env.MEMEX_RERANK_BLEND_WEIGHT, 0, 1, NaN);
  const minScore = clampNumber(env.MEMEX_RERANK_MIN_SCORE, 0, 1, NaN);

  return {
    endpoint,
    apiKey,
    model: env.MEMEX_RERANK_MODEL?.trim() || "jina-reranker-v3",
    provider,
    ...(blendWeight !== undefined ? { blendWeight } : {}),
    ...(minScore !== undefined ? { minScore } : {}),
    scoreMode: env.MEMEX_RERANK_SCORE_MODE?.trim().toLowerCase() === "rank" ? "rank" : "raw",
    // Fusion raw scores cluster near 1.0, so the old 0.88 gate frequently
    // skipped the reranker even when several plausible-but-wrong candidates were
    // competing. Keep a tiny explicit escape hatch for operators who want more
    // latency savings.
    confidenceThreshold: clampNumber(env.MEMEX_RERANK_CONFIDENCE_THRESHOLD, 0, 2, 0.995) ?? 0.995,
    confidenceGap: clampNumber(env.MEMEX_RERANK_CONFIDENCE_GAP, 0, 1, 0.20) ?? 0.20,
  };
}
