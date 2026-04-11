/**
 * In-turn recall cache.
 *
 * A single agent turn fires `before_prompt_build` multiple times — once on
 * the initial prompt build and again after every tool result. The recall
 * query (last user message) doesn't change within a turn, so we cache the
 * computed memory context by `(agentId, sessionKey, query)` and reuse it
 * on subsequent prompt rebuilds. This prevents N redundant retrieve()
 * calls per turn.
 *
 * Lifetime: ephemeral, in-memory, per-process. Cleared on restart.
 *
 * The cache is intentionally tiny and tied to a single agent turn — not
 * a general-purpose query result cache. Cross-turn cache invalidation
 * happens automatically because each new user message changes the query.
 */
export interface InTurnRecallEntry {
  context: string;
  recalledIds: string[];
}

interface StoredEntry extends InTurnRecallEntry {
  query: string;
  expireAt: number;
}

export class InTurnRecallCache {
  private readonly cache = new Map<string, StoredEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly nowFn: () => number;

  constructor(options: { ttlMs?: number; maxSize?: number; nowFn?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.maxSize = options.maxSize ?? 32;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  /** Returns the cached entry if the query matches and the entry is not expired. */
  get(agentId: string, sessionKey: string | undefined, query: string): InTurnRecallEntry | null {
    const key = this.buildKey(agentId, sessionKey);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.query !== query) return null;
    if (entry.expireAt <= this.nowFn()) {
      this.cache.delete(key);
      return null;
    }
    return { context: entry.context, recalledIds: entry.recalledIds };
  }

  /** Store a fresh entry; opportunistically GC stale entries when the map grows. */
  set(
    agentId: string,
    sessionKey: string | undefined,
    query: string,
    entry: InTurnRecallEntry,
  ): void {
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
        if (v.expireAt < cutoff) this.cache.delete(k);
      }
    }
  }

  /** For tests + introspection. */
  size(): number {
    return this.cache.size;
  }

  /** For tests; clears the entire map. */
  clear(): void {
    this.cache.clear();
  }

  private buildKey(agentId: string, sessionKey: string | undefined): string {
    return `${agentId}:${sessionKey || "default"}`;
  }
}
