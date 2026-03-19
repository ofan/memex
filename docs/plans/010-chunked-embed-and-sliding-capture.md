# Chunked Embedding + Sliding Window Auto-Capture

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring chunked embedding into production so long memories get multi-vector representation with max-sim retrieval, and improve auto-capture to use a sliding window of user+assistant turns with filtered assistant output.

**Architecture:** Three changes that complement each other: (1) Memory store gains multi-vector support — memories >1500 chars get chunked into overlapping pieces, each stored as a separate vector row, and vectorSearch aggregates chunk hits back to memory level via max-sim. (2) Auto-capture switches from individual user messages to a sliding window of recent turns (user + filtered assistant). (3) A new `filterAssistantText()` function strips code blocks, tool outputs, and data blobs from assistant messages before capture.

**Tech Stack:** TypeScript, SQLite + sqlite-vec, existing `chunker.ts` for text splitting, existing `noise-filter.ts` for content filtering.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/memory.ts` | Modify | Multi-vector storage + max-sim vectorSearch |
| `src/noise-filter.ts` | Modify | Add `filterAssistantText()` for stripping code/tool/data |
| `src/capture-windows.ts` | Create | `buildCaptureWindows()` sliding window builder |
| `index.ts` | Modify | Sliding window auto-capture with assistant output |
| `tests/memory-store-sqlite.test.ts` | Modify | Chunk storage + max-sim tests |
| `tests/noise-filter.test.ts` | Modify | Assistant text filtering tests |
| `tests/auto-capture.test.ts` | Create | Sliding window integration tests |

---

### Task 1: Assistant Text Filtering

Add `filterAssistantText()` to `noise-filter.ts`. This strips noise from assistant messages while preserving the useful knowledge content.

**Files:**
- Modify: `src/noise-filter.ts`
- Modify: `tests/noise-filter.test.ts`

- [ ] **Step 1: Write failing tests for `filterAssistantText`**

Add to `tests/noise-filter.test.ts`:

```typescript
describe("filterAssistantText", () => {
  it("strips fenced code blocks", () => {
    const input = "I installed the package.\n```bash\nnpm install foo\n```\nIt should work now.";
    assert.equal(filterAssistantText(input), "I installed the package.\nIt should work now.");
  });

  it("strips multi-line code blocks preserving surrounding text", () => {
    const input = "Here's the fix:\n```typescript\nfunction foo() {\n  return 42;\n}\n```\nThis resolves the issue.";
    assert.equal(filterAssistantText(input), "Here's the fix:\nThis resolves the issue.");
  });

  it("strips tool output markers", () => {
    const input = "Let me check.\n<tool_result>\n{\"status\": \"ok\", \"data\": [1,2,3]}\n</tool_result>\nThe status is ok.";
    assert.equal(filterAssistantText(input), "Let me check.\nThe status is ok.");
  });

  it("strips [tool_result] blocks", () => {
    const input = "Running the test.\n[tool_result]\nPASSED 42 tests\n[/tool_result]\nAll tests pass.";
    assert.equal(filterAssistantText(input), "Running the test.\nAll tests pass.");
  });

  it("strips base64 blobs inline", () => {
    const input = "The image data is " + "A".repeat(120) + " and that's the icon.";
    assert.equal(filterAssistantText(input), "The image data is  and that's the icon.");
  });

  it("strips lines that look like stack traces", () => {
    const input = "I found the bug.\n  at Object.<anonymous> (/home/user/app.js:42:15)\n  at Module._compile (node:internal/modules/cjs/loader:1275:14)\nThe fix is simple.";
    assert.equal(filterAssistantText(input), "I found the bug.\n\nThe fix is simple.");
  });

  it("preserves short inline code", () => {
    const input = "Use `npm install` to set up the project.";
    assert.equal(filterAssistantText(input), "Use `npm install` to set up the project.");
  });

  it("preserves normal assistant prose", () => {
    const input = "Your favorite restaurant is Sushi Zen on 5th Avenue. You mentioned going there every Friday.";
    assert.equal(filterAssistantText(input), input);
  });

  it("returns null for all-noise content", () => {
    const input = "```python\ndef foo():\n  pass\n```";
    assert.equal(filterAssistantText(input), null);
  });

  it("collapses multiple blank lines after stripping", () => {
    const input = "First point.\n```\ncode\n```\n\n\n\nSecond point.";
    assert.equal(filterAssistantText(input), "First point.\n\nSecond point.");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import jiti/register --test tests/noise-filter.test.ts`
Expected: FAIL — `filterAssistantText` is not exported

- [ ] **Step 3: Implement `filterAssistantText`**

Add to `src/noise-filter.ts`:

```typescript
/**
 * Filter assistant message text for auto-capture.
 * Strips code blocks, tool output, stack traces, base64 blobs.
 * Returns cleaned text or null if nothing useful remains.
 */
export function filterAssistantText(text: string): string | null {
  let s = text;

  // Strip fenced code blocks (``` ... ```)
  s = s.replace(/^```[\s\S]*?^```/gm, "");

  // Strip XML-style tool output blocks (<tool_result>...</tool_result>, etc.)
  s = s.replace(/<(tool_result|function_result|tool_output)>[\s\S]*?<\/\1>/gi, "");

  // Strip bracket-style tool output ([tool_result]...[/tool_result])
  s = s.replace(/\[tool_result\][\s\S]*?\[\/tool_result\]/gi, "");

  // Strip stack trace lines (  at Object.<anonymous> ...)
  s = s.replace(/^[ \t]+at .+\(.+:\d+:\d+\).*$/gm, "");

  // Strip base64 blobs (100+ chars of base64 alphabet without spaces)
  s = s.replace(/[A-Za-z0-9+/]{100,}={0,2}/g, "");

  // Collapse multiple blank lines to one
  s = s.replace(/\n{3,}/g, "\n\n");

  // Trim
  s = s.trim();

  // If nothing useful remains, return null
  if (!s || s.length < 10) return null;

  return s;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import jiti/register --test tests/noise-filter.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/noise-filter.ts tests/noise-filter.test.ts
git commit -m "feat: add filterAssistantText for auto-capture noise stripping"
```

---

### Task 2: Multi-Vector Storage (Chunked Embedding)

Modify `MemoryStore` to store multiple chunk vectors per memory when text exceeds a threshold, and aggregate chunk results via max-sim in `vectorSearch`.

**Files:**
- Modify: `src/memory.ts`
- Modify: `tests/memory-store-sqlite.test.ts`

**Key design decisions:**
- Chunk threshold: 1500 chars (below this, single vector as before)
- Chunk size: 1500 chars with 200 char overlap (uses existing `chunker.ts`)
- Key scheme: `mem_{id}` for primary vector (chunk 0), `mem_{id}_c{1..N}` for additional chunks
- Backward compatible: short memories work exactly as before
- `vectorSearch` groups chunk hits by memory ID, takes max score

- [ ] **Step 1: Write failing tests for multi-vector store + max-sim search**

Add a new `describe` block in `tests/memory-store-sqlite.test.ts`:

```typescript
describe("chunked embedding (multi-vector)", () => {
  it("stores single vector for short text", async () => {
    const entry = await store.store({
      text: "User prefers dark mode",
      vector: seedVec(1),
      category: "preference",
      scope: "global",
      importance: 0.7,
    });
    // Should have exactly 1 vector row (mem_{id})
    const vecCount = store.getVectorCount(entry.id);
    assert.equal(vecCount, 1);
  });

  it("stores multiple vectors for long text", async () => {
    const longText = "Important fact. ".repeat(200); // ~3200 chars
    const chunks = store.chunkForEmbedding(longText);
    assert.ok(chunks.length >= 2, `Expected >=2 chunks, got ${chunks.length}`);

    // Build chunk vectors (different seed per chunk for test)
    const chunkVectors = chunks.map((_, i) => seedVec(10 + i));

    const entry = await store.storeWithChunks({
      text: longText,
      chunkVectors,
      category: "fact",
      scope: "global",
      importance: 0.7,
    });

    const vecCount = store.getVectorCount(entry.id);
    assert.equal(vecCount, chunkVectors.length);
  });

  it("vectorSearch returns max-sim score across chunks", async () => {
    const longText = "First chunk about cooking. ".repeat(50) +
                     "Second chunk about astronomy and stars. ".repeat(50);
    const chunks = store.chunkForEmbedding(longText);

    // Chunk 0: cooking-like vector, Chunk 1: astronomy-like vector
    const cookingVec = seedVec(100);
    const astronomyVec = seedVec(200);
    const chunkVectors = chunks.length >= 2
      ? [cookingVec, astronomyVec, ...chunks.slice(2).map((_, i) => seedVec(300 + i))]
      : [cookingVec];

    await store.storeWithChunks({
      text: longText,
      chunkVectors,
      category: "fact",
      scope: "global",
      importance: 0.7,
    });

    // Query with astronomy vector — should find the memory via chunk 1
    const results = await store.vectorSearch(astronomyVec, 5, 0.0);
    assert.ok(results.length > 0, "Should find the memory");

    // The score should be high (matching chunk 1, not diluted by chunk 0)
    const topScore = results[0].score;
    assert.ok(topScore > 0.9, `Expected high score from matching chunk, got ${topScore}`);
  });

  it("delete removes all chunk vectors", async () => {
    const longText = "Some content here. ".repeat(200);
    const chunks = store.chunkForEmbedding(longText);
    const chunkVectors = chunks.map((_, i) => seedVec(50 + i));

    const entry = await store.storeWithChunks({
      text: longText,
      chunkVectors,
      category: "fact",
      scope: "global",
      importance: 0.7,
    });

    assert.ok(store.getVectorCount(entry.id) >= 2);
    await store.delete(entry.id);
    assert.equal(store.getVectorCount(entry.id), 0);
  });

  it("update replaces all chunk vectors", async () => {
    const longText = "Original content. ".repeat(200);
    const chunks = store.chunkForEmbedding(longText);
    const chunkVectors = chunks.map((_, i) => seedVec(60 + i));

    const entry = await store.storeWithChunks({
      text: longText,
      chunkVectors,
      category: "fact",
      scope: "global",
      importance: 0.7,
    });

    const origCount = store.getVectorCount(entry.id);

    // Update with new (shorter) text that produces fewer chunks
    const newText = "Updated short text";
    const newVec = seedVec(99);
    await store.update(entry.id, { text: newText, vector: newVec });

    // Should now have exactly 1 vector (short text)
    assert.equal(store.getVectorCount(entry.id), 1);
  });

  it("chunkForEmbedding returns single chunk for short text", () => {
    const chunks = store.chunkForEmbedding("Short text");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "Short text");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import jiti/register --test tests/memory-store-sqlite.test.ts`
Expected: FAIL — `storeWithChunks`, `chunkForEmbedding`, `getVectorCount` don't exist

- [ ] **Step 3: Add `chunkForEmbedding` method**

Add to `src/memory.ts`, import `chunkText` from chunker:

```typescript
import { chunkDocument, type ChunkerConfig } from "./chunker.js";

// At class level:
private static CHUNK_THRESHOLD = 1500;
private static CHUNK_CONFIG: ChunkerConfig = {
  maxChunkSize: 1500,
  overlapSize: 200,
  minChunkSize: 200,
  semanticSplit: true,
  maxLinesPerChunk: 40,
};

/** Split text into chunks for embedding. Returns 1 chunk for short text. */
chunkForEmbedding(text: string): string[] {
  if (text.length <= MemoryStore.CHUNK_THRESHOLD) {
    return [text];
  }
  const result = chunkDocument(text, MemoryStore.CHUNK_CONFIG);
  return result.chunks;
}
```

- [ ] **Step 4: Add `storeWithChunks` method**

Add to `src/memory.ts`:

```typescript
/** Store a memory with pre-computed chunk vectors (for long text). */
async storeWithChunks(entry: Omit<MemoryEntry, "id" | "timestamp" | "vector"> & {
  chunkVectors: number[][];
}): Promise<MemoryEntry> {
  const fullEntry: MemoryEntry = {
    ...entry,
    id: randomUUID(),
    timestamp: Date.now(),
    vector: entry.chunkVectors[0] || [], // primary vector = first chunk
    metadata: entry.metadata || "{}",
  };

  // Insert memory row
  this.db.prepare(`
    INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    fullEntry.id, fullEntry.text, fullEntry.category, fullEntry.scope,
    fullEntry.importance, fullEntry.timestamp, fullEntry.metadata
  );

  // Insert chunk vectors
  if (this._sqliteVecAvailable) {
    for (let i = 0; i < entry.chunkVectors.length; i++) {
      const vecKey = i === 0 ? `mem_${fullEntry.id}` : `mem_${fullEntry.id}_c${i}`;
      this.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`)
        .run(vecKey, new Float32Array(entry.chunkVectors[i]));
    }
  }

  // Insert mapping
  this.db.prepare(
    `INSERT INTO memory_vectors (memory_id, embedded_at) VALUES (?, ?)`
  ).run(fullEntry.id, new Date().toISOString());

  return fullEntry;
}
```

- [ ] **Step 5: Add `getVectorCount` helper (for tests)**

```typescript
/** Count vector rows for a memory (includes chunk vectors). For testing. */
getVectorCount(memoryId: string): number {
  if (!this._sqliteVecAvailable) return 0;
  const primary = this.db.prepare(
    `SELECT COUNT(*) as cnt FROM vectors_vec WHERE hash_seq = ?`
  ).get(`mem_${memoryId}`) as { cnt: number };
  const chunks = this.db.prepare(
    `SELECT COUNT(*) as cnt FROM vectors_vec WHERE hash_seq LIKE ?`
  ).get(`mem_${memoryId}_c%`) as { cnt: number };
  return primary.cnt + chunks.cnt;
}
```

- [ ] **Step 6: Modify `vectorSearch` for max-sim aggregation**

Replace the vector search logic in `src/memory.ts:vectorSearch`:

```typescript
async vectorSearch(
  vector: number[],
  limit = 5,
  minScore = 0.3,
  scopeFilter?: string[]
): Promise<MemorySearchResult[]> {
  if (!this._sqliteVecAvailable) return [];

  const safeLimit = clampInt(limit, 1, 20);
  const fetchLimit = Math.min(safeLimit * 10, 200);

  // Step 1: Get vector matches from sqlite-vec
  const vecResults = this.db.prepare(`
    SELECT hash_seq, distance
    FROM vectors_vec
    WHERE embedding MATCH ? AND k = ?
  `).all(new Float32Array(vector), fetchLimit) as { hash_seq: string; distance: number }[];

  if (vecResults.length === 0) return [];

  // Filter to memory vectors only (prefix mem_)
  const memResults = vecResults.filter(r => r.hash_seq.startsWith('mem_'));
  if (memResults.length === 0) return [];

  // Step 2: Max-sim aggregation — group by memory ID, take best (lowest distance) per memory
  const bestPerMemory = new Map<string, number>(); // memoryId -> best distance
  for (const r of memResults) {
    // Parse memory ID from hash_seq: "mem_{id}" or "mem_{id}_c{N}"
    const withoutPrefix = r.hash_seq.slice(4); // strip "mem_"
    const chunkSep = withoutPrefix.indexOf("_c");
    const memId = chunkSep >= 0 ? withoutPrefix.slice(0, chunkSep) : withoutPrefix;

    const existing = bestPerMemory.get(memId);
    if (existing === undefined || r.distance < existing) {
      bestPerMemory.set(memId, r.distance);
    }
  }

  // Step 3: Look up memory entries
  const ids = [...bestPerMemory.keys()];
  const placeholders = ids.map(() => '?').join(',');
  let sql = `SELECT id, text, category, scope, importance, timestamp, metadata FROM memories WHERE id IN (${placeholders})`;
  const params: any[] = [...ids];

  if (scopeFilter && scopeFilter.length > 0) {
    const scopePlaceholders = scopeFilter.map(() => '?').join(',');
    sql += ` AND scope IN (${scopePlaceholders})`;
    params.push(...scopeFilter);
  }

  const rows = this.db.prepare(sql).all(...params) as any[];
  const mapped: MemorySearchResult[] = [];

  for (const row of rows) {
    const distance = bestPerMemory.get(row.id) ?? 0;
    const score = 1 / (1 + distance);

    if (score < minScore) continue;

    mapped.push({
      entry: {
        id: row.id,
        text: row.text,
        vector: [],
        category: row.category,
        scope: row.scope,
        importance: row.importance,
        timestamp: row.timestamp,
        metadata: row.metadata || "{}",
      },
      score,
    });
  }

  mapped.sort((a, b) => b.score - a.score);
  return mapped.slice(0, safeLimit);
}
```

- [ ] **Step 7: Update `delete` to remove chunk vectors**

In `src/memory.ts`, update the delete method's vector cleanup:

```typescript
// Replace the single delete line:
//   this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`mem_${resolvedId}`);
// With:
if (this._sqliteVecAvailable) {
  this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`mem_${resolvedId}`);
  this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq LIKE ?`).run(`mem_${resolvedId}_c%`);
}
```

Do the same in `bulkDelete` (the loop over rows).

- [ ] **Step 8: Update `update` to replace chunk vectors**

In the `update` method, when `updates.vector` is provided, also delete chunk vectors:

```typescript
if (updates.vector && this._sqliteVecAvailable) {
  // Delete primary + all chunk vectors
  this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`mem_${row.id}`);
  this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq LIKE ?`).run(`mem_${row.id}_c%`);
  // Insert new single vector
  this.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(
    `mem_${row.id}`, new Float32Array(updates.vector)
  );
}
```

- [ ] **Step 9: Update `reEmbedMemories` to produce chunk vectors**

Replace the batch loop body in `reEmbedMemories`. The `embedFn` signature stays the same (`(texts: string[]) => Promise<number[][]>`) — we just call it with chunk arrays instead of single texts:

```typescript
// Replace the existing batch loop (lines ~881-892) with:
let done = 0;
for (let i = 0; i < memories.length; i += batchSize) {
  const batch = memories.slice(i, i + batchSize);

  // For each memory: chunk it, embed all chunks, store all vectors
  for (const mem of batch) {
    const chunks = this.chunkForEmbedding(mem.text);
    const chunkEmbeddings = await embedFn(chunks);

    // Delete old vectors (primary + chunks)
    this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`).run(`mem_${mem.id}`);
    this.db.prepare(`DELETE FROM vectors_vec WHERE hash_seq LIKE ?`).run(`mem_${mem.id}_c%`);
    this.db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(mem.id);

    // Insert new vectors
    const now = new Date().toISOString();
    for (let c = 0; c < chunkEmbeddings.length; c++) {
      if (!chunkEmbeddings[c] || chunkEmbeddings[c].length === 0) continue;
      const vecKey = c === 0 ? `mem_${mem.id}` : `mem_${mem.id}_c${c}`;
      this.db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`).run(
        vecKey, new Float32Array(chunkEmbeddings[c])
      );
    }
    this.db.prepare(`INSERT OR REPLACE INTO memory_vectors (memory_id, embedded_at) VALUES (?, ?)`).run(
      mem.id, now
    );
  }

  done += batch.length;
  onProgress?.(done, memories.length);
}
```

Note: This changes re-embed from batch transactions to per-memory transactions for simplicity. The existing `batchTransaction` helper is no longer used — replace it with the loop above. Each memory gets its own chunk+embed+store cycle, which is correct since `embedFn` is async anyway.

- [ ] **Step 10: Run all memory store tests**

Run: `node --import jiti/register --test tests/memory-store-sqlite.test.ts`
Expected: All tests PASS (new chunk tests + existing tests unchanged)

- [ ] **Step 11: Run full test suite for regressions**

Run: `node --import jiti/register --test tests/*.test.ts`
Expected: 542+ tests PASS, 0 FAIL

- [ ] **Step 12: Commit**

```bash
git add src/memory.ts tests/memory-store-sqlite.test.ts
git commit -m "feat: multi-vector storage with max-sim aggregation for chunked embedding"
```

---

### Task 3: Wire Chunked Embedding into Store Callers

Update the `store` tool and auto-capture to use `storeWithChunks` for long text.

**Files:**
- Modify: `src/tools.ts`
- Modify: `index.ts`

- [ ] **Step 1: Update `store` tool to chunk long text**

In `src/tools.ts`, around line 299 where `embedPassage` is called:

```typescript
// Replace:
//   const vector = await context.embedder.embedPassage(text);
//   ...
//   const entry = await context.store.store({ text, vector, ... });

// With:
const chunks = context.store.chunkForEmbedding(text);
let entry: MemoryEntry;
if (chunks.length === 1) {
  const vector = await context.embedder.embedPassage(text);
  // existing duplicate check...
  const existing = await context.store.vectorSearch(vector, 1, 0.1, [targetScope]);
  if (existing.length > 0 && existing[0].score > 0.98) {
    return { content: [{ type: "text", text: `Similar memory already exists: "${existing[0].entry.text}"` }], details: { action: "duplicate", existingId: existing[0].entry.id, existingText: existing[0].entry.text, existingScope: existing[0].entry.scope, similarity: existing[0].score } };
  }
  entry = await context.store.store({ text, vector, importance: safeImportance, category: category as any, scope: targetScope, metadata: JSON.stringify({ source: "agent" }) });
} else {
  const chunkVectors = await context.embedder.embedBatchPassage(chunks);
  // Duplicate check using first chunk vector
  const existing = await context.store.vectorSearch(chunkVectors[0], 1, 0.1, [targetScope]);
  if (existing.length > 0 && existing[0].score > 0.98) {
    return { content: [{ type: "text", text: `Similar memory already exists: "${existing[0].entry.text}"` }], details: { action: "duplicate", existingId: existing[0].entry.id, existingText: existing[0].entry.text, existingScope: existing[0].entry.scope, similarity: existing[0].score } };
  }
  entry = await context.store.storeWithChunks({ text, chunkVectors, importance: safeImportance, category: category as any, scope: targetScope, metadata: JSON.stringify({ source: "agent" }) });
}
```

- [ ] **Step 2: Update auto-capture in `index.ts` similarly**

In `index.ts`, around line 963 where auto-capture embeds:

```typescript
// Replace:
//   const vector = await embedder.embedPassage(text);
//   ...
//   await store.store({ text, vector, ... });

// With:
const chunks = store.chunkForEmbedding(text);
if (chunks.length === 1) {
  const vector = await embedder.embedPassage(text);
  const existing = await store.vectorSearch(vector, 1, 0.1, [defaultScope]);
  if (existing.length > 0 && existing[0].score > 0.95) continue;
  await store.store({ text, vector, importance: scores[i], category, scope: defaultScope, metadata: JSON.stringify({ source: "auto-capture" }) });
} else {
  const chunkVectors = await embedder.embedBatchPassage(chunks);
  const existing = await store.vectorSearch(chunkVectors[0], 1, 0.1, [defaultScope]);
  if (existing.length > 0 && existing[0].score > 0.95) continue;
  await store.storeWithChunks({ text, chunkVectors, importance: scores[i], category, scope: defaultScope, metadata: JSON.stringify({ source: "auto-capture" }) });
}
```

- [ ] **Step 3: Run full test suite**

Run: `node --import jiti/register --test tests/*.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/tools.ts index.ts
git commit -m "feat: wire chunked embedding into store tool and auto-capture"
```

---

### Task 4: Sliding Window Auto-Capture

Change auto-capture from processing individual messages to building sliding windows of recent turns (user + filtered assistant), producing more contextual memory entries.

**Files:**
- Modify: `index.ts`
- Create: `tests/auto-capture.test.ts`

- [ ] **Step 1: Write failing tests for sliding window capture**

Create `tests/auto-capture.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCaptureWindows } from "../src/capture-windows.js";

describe("buildCaptureWindows", () => {
  it("builds a single window from short conversation", () => {
    const messages = [
      { role: "user", text: "My favorite color is blue." },
      { role: "assistant", text: "Got it, I'll remember that." },
    ];
    const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 3000 });
    assert.equal(windows.length, 1);
    assert.ok(windows[0].includes("blue"));
    assert.ok(windows[0].includes("remember"));
  });

  it("builds multiple windows for long conversations", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `Message ${i} with some content about topic ${i}. `.repeat(10),
    }));
    const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 1500 });
    assert.ok(windows.length >= 2, `Expected >=2 windows, got ${windows.length}`);
  });

  it("filters assistant code blocks", () => {
    const messages = [
      { role: "user", text: "How do I sort an array?" },
      { role: "assistant", text: "Use Array.sort().\n```javascript\narr.sort((a, b) => a - b);\n```\nThis sorts ascending." },
    ];
    const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 3000 });
    assert.equal(windows.length, 1);
    assert.ok(!windows[0].includes("```"), "Should not contain code fences");
    assert.ok(windows[0].includes("Array.sort()"));
    assert.ok(windows[0].includes("ascending"));
  });

  it("skips all-noise assistant messages", () => {
    const messages = [
      { role: "user", text: "My birthday is March 15th." },
      { role: "assistant", text: "```python\ndef foo():\n  pass\n```" },
      { role: "user", text: "I live in Portland." },
    ];
    const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 3000 });
    assert.equal(windows.length, 1);
    assert.ok(windows[0].includes("birthday"));
    assert.ok(windows[0].includes("Portland"));
    assert.ok(!windows[0].includes("python"));
  });

  it("includes role labels in window text", () => {
    const messages = [
      { role: "user", text: "I prefer dark mode." },
      { role: "assistant", text: "Noted, you prefer dark mode." },
    ];
    const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 3000 });
    assert.ok(windows[0].includes("[user]") || windows[0].includes("User:"));
    assert.ok(windows[0].includes("[assistant]") || windows[0].includes("Assistant:"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/auto-capture.test.ts`
Expected: FAIL — `buildCaptureWindows` not exported

- [ ] **Step 3: Implement `buildCaptureWindows`**

Create `src/capture-windows.ts`:

```typescript
import { filterAssistantText } from "./noise-filter.js";

export interface CaptureMessage {
  role: string;
  text: string;
}

interface WindowConfig {
  windowSize: number;   // max turns per window
  maxChars: number;     // max chars per window
  stride?: number;      // how many turns to advance (default: windowSize / 2)
}

/**
 * Build sliding windows of conversation turns for auto-capture.
 * User messages are included as-is (after envelope extraction).
 * Assistant messages are filtered (code blocks, tool output stripped).
 * Windows overlap by stride to avoid boundary splits cutting context.
 */
export function buildCaptureWindows(
  messages: CaptureMessage[],
  config: WindowConfig,
): string[] {
  const stride = config.stride ?? Math.max(1, Math.floor(config.windowSize / 2));

  // Pre-process: filter assistant text, drop all-noise messages
  const processed: Array<{ role: string; text: string }> = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const filtered = filterAssistantText(msg.text);
      if (filtered) processed.push({ role: "assistant", text: filtered });
    } else if (msg.role === "user") {
      if (msg.text.trim()) processed.push({ role: "user", text: msg.text.trim() });
    }
  }

  if (processed.length === 0) return [];

  // Build sliding windows
  const windows: string[] = [];
  for (let start = 0; start < processed.length; start += stride) {
    const windowMsgs = processed.slice(start, start + config.windowSize);
    if (windowMsgs.length === 0) break;

    // Format as labeled turns
    let windowText = "";
    for (const m of windowMsgs) {
      const label = m.role === "user" ? "[user]" : "[assistant]";
      const line = `${label} ${m.text}\n`;
      if (windowText.length + line.length > config.maxChars) break;
      windowText += line;
    }

    windowText = windowText.trim();
    if (windowText.length >= 20) {
      windows.push(windowText);
    }

    // If we've consumed all messages, stop
    if (start + config.windowSize >= processed.length) break;
  }

  return windows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import jiti/register --test tests/auto-capture.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Integrate into auto-capture hook**

In `index.ts`, add `import { buildCaptureWindows, type CaptureMessage } from "./src/capture-windows.js";` at the top.

Replace the message extraction loop in the `agent_end` handler (index.ts ~900-945) with the sliding window approach:

```typescript
// Replace the individual message extraction with:
const rawMessages: CaptureMessage[] = [];
for (const msg of event.messages) {
  if (!msg || typeof msg !== "object") continue;
  const msgObj = msg as Record<string, unknown>;
  const role = msgObj.role as string;
  if (role !== "user" && role !== "assistant") continue;

  let text = "";
  const content = msgObj.content;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = (content as any[])
      .filter(b => b?.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("\n");
  }
  if (!text.trim()) continue;

  // For user messages, extract from envelope
  if (role === "user") {
    const extracted = extractHumanText(text);
    if (!extracted) continue;
    text = extracted;
  }

  rawMessages.push({ role, text });
}

// Build sliding windows (maxChars < 2000 to avoid isStructuralNoise length filter)
const includeAssistant = config.captureAssistant !== false; // default: true (changed from old default)
const windows = buildCaptureWindows(
  includeAssistant ? rawMessages : rawMessages.filter(m => m.role === "user"),
  { windowSize: 6, maxChars: 1800, stride: 3 },
);

// Filter noise + score importance
const candidates: string[] = [];
for (const w of windows) {
  if (isStructuralNoise(w)) continue;
  if (isNoise(w)) continue;
  candidates.push(w);
}
```

The rest of the auto-capture logic (importance scoring, dedup, store) remains the same but now operates on window-level text instead of individual messages.

- [ ] **Step 6: Run full test suite**

Run: `node --import jiti/register --test tests/*.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/capture-windows.ts index.ts tests/auto-capture.test.ts
git commit -m "feat: sliding window auto-capture with user + filtered assistant output"
```

---

### Task 5: Integration Testing + Deploy

**Files:**
- Modify: `tests/auto-capture.test.ts`

- [ ] **Step 1: Add end-to-end integration test**

Add a test that exercises the full flow: messages → sliding windows → chunk embedding → store → vector search retrieval:

```typescript
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";

const DIM = 4;
function seedVec(seed: number): number[] {
  const v = Array.from({ length: DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

describe("end-to-end: sliding window + chunked storage + retrieval", () => {
  it("stores windowed conversation and retrieves via max-sim", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "e2e-capture-"));
    try {
      const store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });

      // Simulate a conversation about the user's work setup
      const messages = [
        { role: "user", text: "I just set up my home office with a standing desk from Uplift." },
        { role: "assistant", text: "Nice choice! Uplift makes great standing desks. How's the build quality?" },
        { role: "user", text: "It's solid. I paired it with an Aeron chair for when I want to sit." },
        { role: "assistant", text: "The Herman Miller Aeron is a classic ergonomic chair. Great combo." },
      ];

      const windows = buildCaptureWindows(messages, { windowSize: 4, maxChars: 1800 });
      assert.ok(windows.length >= 1);
      assert.ok(windows[0].includes("Uplift"));
      assert.ok(windows[0].includes("Aeron"));

      // Store the window with a known vector
      const vec = seedVec(42);
      const entry = await store.store({
        text: windows[0],
        vector: vec,
        category: "fact",
        scope: "global",
        importance: 0.7,
      });

      // Retrieve it via vector search
      const results = await store.vectorSearch(vec, 5, 0.0);
      assert.ok(results.length > 0, "Should retrieve the stored window");
      assert.equal(results[0].entry.id, entry.id);
      assert.ok(results[0].entry.text.includes("Uplift"));
      assert.ok(results[0].score > 0.9);

      await store.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `node --import jiti/register --test tests/*.test.ts`
Expected: All tests PASS, no regressions

- [ ] **Step 3: Deploy**

```bash
rm -rf ~/.openclaw/plugins/memex
cp -r . ~/.openclaw/plugins/memex
rm -rf ~/.openclaw/plugins/memex/.git ~/.openclaw/plugins/memex/.clone
openclaw gateway restart
```

- [ ] **Step 4: Final commit with test count update**

Update CLAUDE.md test count, then commit:

```bash
git add CLAUDE.md
git commit -m "docs: update test count after chunked embedding integration"
```
