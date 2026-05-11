/**
 * Transient error retry helper.
 *
 * Wraps an async operation in N attempts with exponential backoff,
 * retrying only on transient upstream failures (502/503/504 or network
 * timeouts). Non-transient errors propagate immediately on the first
 * attempt so bugs aren't masked by silent retries.
 *
 * Used by the embedder and reranker clients to absorb transient
 * inference-server crashes that llama-swap recovers from in 2-5s.
 */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const DEFAULT_MAX_ATTEMPTS = 4;

export interface TransientRetryOptions {
  /** Max attempts (total, not retries). Default: 4 (3 retries). */
  maxAttempts?: number;
  /** Base backoff in ms. Doubled each retry. Default: 1000 (so 1s, 2s, 4s). */
  baseBackoffMs?: number;
  /**
   * Additional status codes to treat as transient. Defaults to 502/503/504.
   * Useful if a specific upstream uses non-standard codes for transient
   * failures.
   */
  extraTransientStatuses?: number[];
  /** Called once per retry decision. Useful for observability hooks. */
  onRetry?: (attempt: number, error: unknown, backoffMs: number) => void;
}

function isTransientError(err: unknown, extra?: number[]): boolean {
  const status = (err as { status?: number })?.status;
  if (typeof status === "number") {
    if (TRANSIENT_STATUSES.has(status)) return true;
    if (extra && extra.includes(status)) return true;
  }
  // Network-level timeouts show up as AbortError or TimeoutError depending on
  // the fetch implementation; treat these as transient too.
  const name = (err as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  return false;
}

export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  options: TransientRetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = options.baseBackoffMs ?? 1000;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;
      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isTransientError(err, options.extraTransientStatuses)) {
        throw err;
      }
      const backoffMs = baseBackoffMs * Math.pow(2, attempt);
      options.onRetry?.(attempt + 1, err, backoffMs);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}
