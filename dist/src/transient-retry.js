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
function isTransientError(err, extra) {
    const status = err?.status;
    if (typeof status === "number") {
        if (TRANSIENT_STATUSES.has(status))
            return true;
        if (extra && extra.includes(status))
            return true;
    }
    // Network-level timeouts show up as AbortError or TimeoutError depending on
    // the fetch implementation; treat these as transient too.
    const name = err?.name;
    if (name === "AbortError" || name === "TimeoutError")
        return true;
    return false;
}
export async function withTransientRetry(fn, options = {}) {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const baseBackoffMs = options.baseBackoffMs ?? 1000;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
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
//# sourceMappingURL=transient-retry.js.map