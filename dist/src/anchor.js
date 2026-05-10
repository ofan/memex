/**
 * Citation anchors for recalled memories.
 *
 * The LLM-facing prompt and tool surfaces render every memory and document
 * with a short stable handle (`[mem:abc12345]` / `[doc:abc12345]`). The LLM
 * is instructed to cite this handle in its reasoning so memex can:
 *   - reduce reasoning-token overhead (LLM points instead of re-narrating)
 *   - look up which memory was actually used after the fact
 *   - accept anchor-prefix references in `memory_forget`
 *
 * Anchors are the first `ANCHOR_LEN` hex chars of the memory's UUID. At
 * memex's current scale (~2K memories) collision probability is negligible.
 * `expandAnchor` resolves a prefix back to the full ID and detects ambiguity.
 */
export const ANCHOR_LEN = 8;
/** First 8 hex chars of an id, for use in `[mem:...]` / `[doc:...]` markers. */
export function anchor(id) {
    return String(id).slice(0, ANCHOR_LEN);
}
/** True if a string looks like a memex anchor (8 hex chars, possibly more). */
export function looksLikeAnchor(s) {
    return /^[0-9a-f]{8,}$/i.test(s);
}
/**
 * Resolve a prefix (≥4 chars, typically the 8-char anchor) to a full id.
 * Returns the full id when exactly one candidate matches, null when none
 * match, and throws on ambiguity. Pass the candidate id list from the caller
 * (e.g. `await store.list(...)` ids) — this module stays storage-agnostic.
 */
export function expandAnchor(prefix, candidateIds) {
    if (prefix.length < 4)
        return null;
    const lower = prefix.toLowerCase();
    const matches = candidateIds.filter(id => id.toLowerCase().startsWith(lower));
    if (matches.length === 0)
        return null;
    if (matches.length === 1)
        return matches[0];
    throw new AnchorAmbiguityError(prefix, matches);
}
export class AnchorAmbiguityError extends Error {
    prefix;
    matches;
    constructor(prefix, matches) {
        super(`Anchor "${prefix}" matches ${matches.length} memories: ${matches.map(m => m.slice(0, 12)).join(", ")}. Use a longer prefix or the full id.`);
        this.name = "AnchorAmbiguityError";
        this.prefix = prefix;
        this.matches = matches;
    }
}
//# sourceMappingURL=anchor.js.map