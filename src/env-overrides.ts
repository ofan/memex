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
}

export interface EnvOverridableConfig {
  debugRecall?: boolean | string;
  autoRecall?: boolean;
  autoRecallLimit?: number;
  reranker?: RerankerConfigLike;
  retrieval?: { hardMinScore?: number };
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
