export class InTurnRecallCache {
    cache = new Map();
    ttlMs;
    maxSize;
    nowFn;
    constructor(options = {}) {
        this.ttlMs = options.ttlMs ?? 60_000;
        this.maxSize = options.maxSize ?? 32;
        this.nowFn = options.nowFn ?? (() => Date.now());
    }
    /** Returns the cached entry if the query matches and the entry is not expired. */
    get(agentId, sessionKey, query) {
        const key = this.buildKey(agentId, sessionKey);
        const entry = this.cache.get(key);
        if (!entry)
            return null;
        if (entry.query !== query)
            return null;
        if (entry.expireAt <= this.nowFn()) {
            this.cache.delete(key);
            return null;
        }
        return { context: entry.context, recalledIds: entry.recalledIds };
    }
    /** Store a fresh entry; opportunistically GC stale entries when the map grows. */
    set(agentId, sessionKey, query, entry) {
        const key = this.buildKey(agentId, sessionKey);
        const now = this.nowFn();
        this.cache.set(key, {
            query,
            context: entry.context,
            recalledIds: entry.recalledIds,
            expireAt: now + this.ttlMs,
        });
        if (this.cache.size > this.maxSize) {
            const cutoff = now - this.ttlMs;
            for (const [k, v] of this.cache) {
                if (v.expireAt < cutoff)
                    this.cache.delete(k);
            }
        }
    }
    /** For tests + introspection. */
    size() {
        return this.cache.size;
    }
    /** For tests; clears the entire map. */
    clear() {
        this.cache.clear();
    }
    buildKey(agentId, sessionKey) {
        return `${agentId}:${sessionKey || "default"}`;
    }
}
//# sourceMappingURL=recall-cache.js.map