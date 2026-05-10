/**
 * Reranker endpoint liveness probe.
 *
 * Sends a minimal `/v1/rerank` request to verify the endpoint is reachable,
 * the auth is valid, and the response shape is parseable. Used by:
 *
 * - `memex.health` (when `probe: true`) — reports `rerank_probe` as ok/warn
 *   so operators can tell if the reranker is down without waiting for a
 *   retrieval failure to surface it
 * - `scripts/bakeoff reranker` — pre-flight check before running benchmarks
 *   so a dead candidate endpoint fails fast instead of silently falling back
 *   to fusion-only rerank (which would produce misleading PASS verdicts)
 *
 * Pure function — no globals, no state, no side effects beyond the fetch.
 */
export async function probeReranker(endpoint, apiKey, model, timeoutMs = 10_000) {
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
            const data = await resp.json();
            // Accept jina shape (results[]) or voyage shape (data[]).
            const hasResults = Array.isArray(data.results) && data.results.length > 0;
            const hasData = Array.isArray(data.data) && data.data.length > 0;
            if (!hasResults && !hasData) {
                return { ok: false, reason: "response missing expected results[] or data[] field" };
            }
            return { ok: true };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    catch (err) {
        const name = err?.name;
        if (name === "AbortError")
            return { ok: false, reason: `timeout after ${timeoutMs}ms` };
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}
//# sourceMappingURL=rerank-probe.js.map