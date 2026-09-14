/**
 * Per-query retrieval trace (debug).
 *
 * A RetrievalTrace is a self-describing snapshot of every ranking stage for one
 * recall: the candidate pool at fusion, what the score floor filtered out, the
 * reranker's contribution, and the final set. Both retrievers emit the same
 * shape so a single loader/debugger (scripts/show-trace.ts) can explain any
 * recall regardless of pipeline.
 *
 * Capture is opt-in (`captureTrace` config on each retriever, gated by
 * MEMEX_DEBUG_RECALL at the call site). When off, no TraceRecorder is created
 * and snapshot calls are skipped — zero overhead on the hot path.
 */
/**
 * Accumulator for building a RetrievalTrace across a pipeline. Call `stage()`
 * at each snapshot point, then `finish()` once with the final id order.
 *
 * Returns `null` from `finish()` only if never used; callers hold the recorder
 * behind their `captureTrace` guard so absent capture never constructs one.
 */
export class TraceRecorder {
    head;
    stages = [];
    ts;
    constructor(head) {
        this.head = head;
        this.ts = new Date().toISOString();
    }
    /** Record a stage. `kept`/`dropped` are copied (shallow per-item) so later
     *  mutation of the live result objects doesn't retroactively change history. */
    stage(name, kept, opts = {}) {
        this.stages.push({
            name,
            kept: kept.map(freezeItem),
            ...(opts.dropped ? { dropped: opts.dropped.map(freezeItem) } : {}),
            ...(opts.meta ? { meta: opts.meta } : {}),
        });
    }
    finish(finalIds) {
        return {
            debugId: this.head.debugId,
            ts: this.ts,
            query: this.head.query,
            pipeline: this.head.pipeline,
            config: this.head.config,
            stages: this.stages,
            finalIds,
        };
    }
}
function freezeItem(item) {
    // Shallow clone + numeric copy so downstream in-place `.score` writes on the
    // original result objects cannot leak back into a prior stage's snapshot.
    return {
        id: item.id,
        score: item.score,
        ...(item.source !== undefined ? { source: item.source } : {}),
        ...(item.scores ? { scores: { ...item.scores } } : {}),
    };
}
//# sourceMappingURL=retrieval-trace.js.map