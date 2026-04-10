# Temporal Queries Design

## Problem

Queries like "What happened last week?" or "What did I do yesterday?" carry
temporal constraints, but the current retrieval pipeline ignores them entirely.
The vector search and BM25 search treat these as plain semantic queries, often
returning results from months ago that happen to match the keywords.

## Approach

Regex-based detection of temporal phrases in the query, converted to an absolute
date range `[start, end]`, applied as a `WHERE timestamp BETWEEN` filter
**before** vector search and BM25 queries.

### Detected patterns

| Pattern             | Example                      | Range                        |
| ------------------- | ---------------------------- | ---------------------------- |
| `yesterday`         | "what happened yesterday"    | [start of yesterday, now]    |
| `last week`         | "what did I do last week"    | [7 days ago, now]            |
| `last month`        | "updates from last month"    | [30 days ago, now]           |
| `in {month}`        | "meetings in March"          | [March 1, March 31]          |
| `N days ago`        | "what happened 2 days ago"   | [2 days ago start, now]      |
| `N weeks ago`       | "tasks from 3 weeks ago"     | [21 days ago, now]           |

### Implementation

- **`src/temporal.ts`** exports `detectTemporalRange(query: string): [number, number] | null`
- Pure regex + `Date` arithmetic. No LLM cost.
- Returns epoch-millisecond `[start, end]` or `null` if no temporal phrase found.

### Wiring

In `src/retriever.ts`:
- Before calling `vectorSearch` / `bm25Search`, call `detectTemporalRange(query)`.
- If a range is detected, pass it as an additional timestamp filter to both search paths.
- The `MemoryStore` search methods accept an optional `timestampRange: [number, number]` parameter and add `WHERE timestamp BETWEEN ? AND ?` to the SQL.

### Trade-offs

- Regex covers ~80% of temporal queries (simple, deterministic, zero cost).
- Misses complex expressions like "the meeting before Christmas" or "two Tuesdays ago".
- False positives are possible but unlikely (e.g., "last resort" is excluded via negative patterns).
- Future: LLM-based temporal extraction for the remaining 20%.
