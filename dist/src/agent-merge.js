/**
 * Agent-list merging for the unified `memoryAgents` config key (issue #30).
 *
 * Memex historically had two separate agent whitelists:
 *   - autoRecallAgents — controls which agents get memory injection
 *   - autoCaptureAgents — controls which agents get the memory_store nudge
 *
 * v0.7+ adds a unified `memoryAgents` key that controls both. Old keys remain
 * supported via union semantics: legacy keys never restrict access, only
 * extend the union (so config still works after the rollout).
 */
/**
 * Merge `memoryAgents` (the unified key) with a legacy specific list
 * (`autoRecallAgents` or `autoCaptureAgents`). Returns undefined when
 * neither input is a non-empty array, so call sites preserve the
 * "no whitelist = all agents" semantics.
 */
export function mergeAgentLists(unified, legacy) {
    const u = Array.isArray(unified) ? unified : [];
    const l = Array.isArray(legacy) ? legacy : [];
    if (u.length === 0 && l.length === 0)
        return undefined;
    return Array.from(new Set([...u, ...l]));
}
//# sourceMappingURL=agent-merge.js.map