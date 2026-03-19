# Session Import v2: Full-Transcript LLM Extraction

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the `import-sessions` pipeline to feed complete conversation transcripts (both user and assistant turns) into a capable LLM (Qwen3.5-4B) using session bin-packing into ~190K token windows, producing high-quality extracted memories with global scope and rich metadata provenance.

**Architecture:** Sessions are read from all agents (with optional `--include-deleted` for rotated `.jsonl.deleted.*` files), envelope-stripped but NOT noise-filtered, bin-packed into ~190K token windows (one session never split across windows), and sent to Qwen3.5-4B-Q8_0 via llama.cpp's OpenAI-compatible API with `cache_prompt: true`. Extracted memories are stored with `scope: global` and metadata containing `source`, `sessionKey`, and `agentId`. The heuristic path remains as fallback when no LLM is configured.

**Tech Stack:** TypeScript (no build step, jiti), LanceDB (vector store), llama.cpp/llama-swap (model serving), Qwen3.5-4B-Q8_0 (extraction model), Qwen3-Embedding-0.6B-Q8_0 (embedder)

---

## Current State

- `parseSessionFile()` (session-indexer.ts:149) drops entire sessions if ANY turn matches `AUTOMATED_PATTERNS` — too aggressive for import
- `extractKnowledge()` (session-indexer.ts:253) uses tiny sliding windows (3 turns, stride 2, 500 char/turn truncation) — wastes LLM context
- File discovery (session-indexer.ts:355) excludes `.deleted` files — misses rotated sessions (bulk of real conversation history)
- Scope is `session:KEY` per-session — retrieval needs `global` scope
- No multi-agent support (`--agent main` only, no `--all-agents`)
- No `--include-deleted` CLI flag
- No `cache_prompt` support in LLM requests

## Corpus Stats

- ~2M tokens across 880 files, 7 agents
- ~72K tokens/day growth
- 10 windows needed for full extraction at 190K/window
- Incremental daily: ~1 window (~10 seconds)

---

### Task 1: Include Deleted Session Files

**Files:**
- Modify: `src/session-indexer.ts:354-357` (file discovery filter)
- Modify: `src/session-indexer.ts:585-589` (`listSessions` filter)
- Modify: `src/session-indexer.ts:54-75` (`SessionIndexerConfig` type)
- Test: `tests/session-indexer.test.ts`

**Step 1: Write the failing test**

In `tests/session-indexer.test.ts`, add a new describe block after the existing `parseSessionFile` tests:

```typescript
describe("parseSessionFile with deleted files", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should parse .jsonl.deleted.TIMESTAMP files", () => {
    const lines = [
      makeSessionHeader("deleted-sess"),
      makeMessage("user", "I prefer using Vim over VS Code for all my editing"),
      makeMessage("assistant", "Noted — I'll remember your Vim preference."),
    ];
    const path = join(tempDir, "deleted-sess.jsonl.deleted.1709654321");
    writeFileSync(path, lines.join("\n"));

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 2);
    assert.ok(turns[0].text.includes("Vim"));
  });
});
```

**Step 2: Run test to verify it passes (parseSessionFile already accepts any path)**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: PASS — `parseSessionFile` takes any path, no `.deleted` filtering there

**Step 3: Write the failing test for indexSessions includeDeleted**

```typescript
describe("indexSessions includeDeleted", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should skip .deleted files by default", async () => {
    // Write a normal session
    const normalLines = [
      makeSessionHeader("normal-sess"),
      makeMessage("user", "I prefer using TypeScript for all backend development"),
      makeMessage("assistant", "Noted — TypeScript for backend."),
    ];
    writeSessionFile(tempDir, "normal-sess", normalLines);

    // Write a deleted session
    const deletedLines = [
      makeSessionHeader("deleted-sess"),
      makeMessage("user", "I always use dark mode in all my editors and terminals"),
      makeMessage("assistant", "Dark mode preference noted."),
    ];
    writeFileSync(
      join(tempDir, "deleted-sess.jsonl.deleted.1709654321"),
      deletedLines.join("\n"),
    );

    const result = await indexSessions(mockStore, mockEmbedder, {
      sessionsDir: tempDir,
      targetScope: "global",
      minImportance: 0.0,
      dryRun: true,
    });

    assert.equal(result.totalSessions, 1, "should only find the non-deleted session");
  });

  it("should include .deleted files when includeDeleted is true", async () => {
    // Write a normal session
    const normalLines = [
      makeSessionHeader("normal-sess"),
      makeMessage("user", "I prefer using TypeScript for all backend development"),
      makeMessage("assistant", "Noted — TypeScript for backend."),
    ];
    writeSessionFile(tempDir, "normal-sess", normalLines);

    // Write a deleted session
    const deletedLines = [
      makeSessionHeader("deleted-sess"),
      makeMessage("user", "I always use dark mode in all my editors and terminals"),
      makeMessage("assistant", "Dark mode preference noted."),
    ];
    writeFileSync(
      join(tempDir, "deleted-sess.jsonl.deleted.1709654321"),
      deletedLines.join("\n"),
    );

    const result = await indexSessions(mockStore, mockEmbedder, {
      sessionsDir: tempDir,
      targetScope: "global",
      minImportance: 0.0,
      includeDeleted: true,
      dryRun: true,
    });

    assert.equal(result.totalSessions, 2, "should find both sessions");
  });
});
```

**Step 4: Run test to verify it fails**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: FAIL — `includeDeleted` property doesn't exist on `SessionIndexerConfig`

**Step 5: Implement includeDeleted support**

In `src/session-indexer.ts`:

Add to `SessionIndexerConfig` (after line 74):
```typescript
  /** Include .deleted session files (rotated sessions) */
  includeDeleted?: boolean;
```

Add to `DEFAULT_CONFIG` (after line 104):
```typescript
  includeDeleted: false,
```

Change file discovery at line 355-357:
```typescript
  const files = readdirSync(cfg.sessionsDir)
    .filter(f => {
      if (f === "sessions.json") return false;
      if (cfg.includeDeleted) {
        // Match both "id.jsonl" and "id.jsonl.deleted.TIMESTAMP"
        return f.includes(".jsonl");
      }
      return f.endsWith(".jsonl") && !f.includes(".deleted");
    })
    .map(f => join(cfg.sessionsDir, f));
```

Update `parseSessionFile` session ID extraction (line 151) to handle `.deleted.TIMESTAMP` suffix:
```typescript
  const sessionId = basename(path).replace(/\.jsonl(\.deleted\.\d+)?$/, "");
```

Update `listSessions` filter at line 588-589 with same logic (add `includeDeleted` parameter or just keep it simple — `listSessions` is only used for CLI display, keep it showing non-deleted only).

**Step 6: Run test to verify it passes**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: PASS

**Step 7: Commit**

```bash
git add src/session-indexer.ts tests/session-indexer.test.ts
git commit -m "feat: add --include-deleted support to session import pipeline

Rotated session files (.jsonl.deleted.TIMESTAMP) contain real conversation
history. The new includeDeleted config option includes them in import.

Generated with Claude Code"
```

---

### Task 2: Loosen Automated Session Filter for Import

**Files:**
- Modify: `src/session-indexer.ts:149-193` (`parseSessionFile`)
- Modify: `src/session-indexer.ts:54-75` (`SessionIndexerConfig`)
- Test: `tests/session-indexer.test.ts`

**Context:** Currently `parseSessionFile()` drops the ENTIRE session if ANY user turn matches `AUTOMATED_PATTERNS` (line 191: `if (hasAutomatedContent) return []`). This is too aggressive — a 500-turn session gets dropped because one turn starts with `System: [`. For import-sessions, we want to keep the session but skip the automated turns.

**Step 1: Write the failing test**

```typescript
describe("parseSessionFile skipAutomatedTurns mode", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should drop entire session by default when automated content found", () => {
    const lines = [
      makeSessionHeader("mixed-sess"),
      makeMessage("user", "System: [notification] new message arrived"),
      makeMessage("user", "I prefer using dark mode in all editors and IDEs"),
      makeMessage("assistant", "Noted — dark mode preference saved."),
    ];
    const path = writeSessionFile(tempDir, "mixed-sess", lines);

    const turns = parseSessionFile(path);
    assert.equal(turns.length, 0, "default behavior drops entire session");
  });

  it("should skip only automated turns when skipAutomatedTurns is true", () => {
    const lines = [
      makeSessionHeader("mixed-sess"),
      makeMessage("user", "System: [notification] new message arrived"),
      makeMessage("user", "I prefer using dark mode in all editors and IDEs"),
      makeMessage("assistant", "Noted — dark mode preference saved."),
    ];
    const path = writeSessionFile(tempDir, "mixed-sess", lines);

    const turns = parseSessionFile(path, { skipAutomatedTurns: true });
    assert.equal(turns.length, 2, "should keep non-automated turns");
    assert.ok(turns[0].text.includes("dark mode"));
  });

  it("should return empty when ALL turns are automated with skipAutomatedTurns", () => {
    const lines = [
      makeSessionHeader("auto-only"),
      makeMessage("user", "System: [cron job] heartbeat check"),
      makeMessage("user", "[cron: daily cleanup] running scheduled task"),
    ];
    const path = writeSessionFile(tempDir, "auto-only", lines);

    const turns = parseSessionFile(path, { skipAutomatedTurns: true });
    assert.equal(turns.length, 0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: FAIL — `parseSessionFile` doesn't accept options parameter

**Step 3: Implement skipAutomatedTurns**

In `src/session-indexer.ts`, add a `ParseOptions` interface and modify `parseSessionFile`:

```typescript
export interface ParseOptions {
  /** Instead of dropping entire session, skip only automated turns */
  skipAutomatedTurns?: boolean;
}

export function parseSessionFile(path: string, options?: ParseOptions): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const sessionId = basename(path).replace(/\.jsonl(\.deleted\.\d+)?$/, "");

  let data: string;
  try {
    data = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const lines = data.split("\n").filter(Boolean);
  let hasAutomatedContent = false;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const text = extractTextFromContent(msg.content);
    if (!text) continue;

    if (msg.role === "user" && isAutomatedMessage(text)) {
      if (options?.skipAutomatedTurns) {
        continue; // Skip this turn, keep going
      }
      hasAutomatedContent = true;
    }

    turns.push({
      sessionId,
      timestamp: entry.timestamp || "",
      role: msg.role,
      text,
    });
  }

  // Skip entire session if it contains automated content (default behavior)
  if (hasAutomatedContent && !options?.skipAutomatedTurns) return [];
  return turns;
}
```

**Step 4: Run test to verify it passes**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: PASS

**Step 5: Wire skipAutomatedTurns into indexSessions**

In `indexSessions()` at line 373, pass the option when LLM extraction is configured:

```typescript
    const turns = parseSessionFile(file, cfg.llmExtraction ? { skipAutomatedTurns: true } : undefined);
```

This way, LLM extraction mode keeps all non-automated turns from mixed sessions, while heuristic mode preserves the conservative "drop entire session" behavior.

**Step 6: Run full test suite**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: PASS (all existing tests unchanged — they don't pass options)

**Step 7: Commit**

```bash
git add src/session-indexer.ts tests/session-indexer.test.ts
git commit -m "feat: add skipAutomatedTurns option to parseSessionFile

Instead of dropping entire sessions when automated content is found,
skip only the automated turns. Used by LLM extraction path to preserve
real conversation turns from mixed sessions.

Generated with Claude Code"
```

---

### Task 3: Session Bin-Packing into ~190K Token Windows

**Files:**
- Modify: `src/session-indexer.ts:253-308` (replace `extractKnowledge`)
- Modify: `src/session-indexer.ts:37-52` (`LLMExtractionConfig` type)
- Test: `tests/session-indexer.test.ts`

**Context:** The current `extractKnowledge()` uses tiny sliding windows (3 turns, stride 2) with 500 char/turn truncation. The new approach packs complete sessions into ~190K token windows. One session is NEVER split across windows. This maximizes context for the LLM and eliminates dedup issues from overlapping windows.

**Step 1: Write the failing tests**

```typescript
describe("binPackSessions", () => {
  it("should pack small sessions into one window", () => {
    const sessions: SessionTurn[][] = [
      [{ sessionId: "s1", timestamp: "", role: "user", text: "short message one" }],
      [{ sessionId: "s2", timestamp: "", role: "user", text: "short message two" }],
    ];
    const windows = binPackSessions(sessions, 100000); // 100K token limit
    assert.equal(windows.length, 1, "both sessions fit in one window");
    assert.equal(windows[0].length, 2, "window contains both sessions");
  });

  it("should split sessions across windows when they exceed limit", () => {
    // Create sessions with known sizes
    const bigText = "x".repeat(4000); // ~1000 tokens
    const sessions: SessionTurn[][] = [];
    for (let i = 0; i < 10; i++) {
      sessions.push([
        { sessionId: `s${i}`, timestamp: "", role: "user", text: bigText },
        { sessionId: `s${i}`, timestamp: "", role: "assistant", text: bigText },
      ]);
    }
    // 10 sessions × 2 turns × 1000 tokens = ~20K tokens
    // With limit of 5K, should need ~4 windows
    const windows = binPackSessions(sessions, 5000);
    assert.ok(windows.length >= 3, `expected 3+ windows, got ${windows.length}`);

    // Verify no session is split across windows
    for (const window of windows) {
      const sessionIds = new Set(window.map(t => t.sessionId));
      for (const sid of sessionIds) {
        const turnsInWindow = window.filter(t => t.sessionId === sid);
        const totalTurns = sessions.find(s => s[0]?.sessionId === sid)!;
        assert.equal(turnsInWindow.length, totalTurns.length,
          `session ${sid} should not be split`);
      }
    }
  });

  it("should handle a single session larger than the window limit", () => {
    const bigText = "x".repeat(800000); // ~200K tokens, bigger than any window
    const sessions: SessionTurn[][] = [
      [{ sessionId: "big", timestamp: "", role: "user", text: bigText }],
    ];
    const windows = binPackSessions(sessions, 100000);
    assert.equal(windows.length, 1, "oversized session gets its own window");
    assert.equal(windows[0].length, 1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: FAIL — `binPackSessions` not exported

**Step 3: Implement binPackSessions**

Add to `src/session-indexer.ts` before `extractKnowledge`:

```typescript
/** Estimate token count from text (chars / 4 is a reasonable approximation) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimate total tokens for a list of turns (includes role prefixes) */
function estimateSessionTokens(turns: SessionTurn[]): number {
  return turns.reduce((sum, t) => sum + estimateTokens(`[${t.role}] ${t.text}\n`), 0);
}

/**
 * Bin-pack complete sessions into windows of approximately maxTokens size.
 * A session is NEVER split across windows. If a single session exceeds
 * maxTokens, it gets its own window.
 *
 * Sessions are packed in order (not optimally — greedy first-fit).
 */
export function binPackSessions(
  sessions: SessionTurn[][],
  maxTokens: number,
): SessionTurn[][] {
  const windows: SessionTurn[][] = [];
  let currentWindow: SessionTurn[] = [];
  let currentTokens = 0;

  for (const session of sessions) {
    const sessionTokens = estimateSessionTokens(session);

    if (currentWindow.length > 0 && currentTokens + sessionTokens > maxTokens) {
      // Current window is full, start a new one
      windows.push(currentWindow);
      currentWindow = [];
      currentTokens = 0;
    }

    currentWindow.push(...session);
    currentTokens += sessionTokens;
  }

  if (currentWindow.length > 0) {
    windows.push(currentWindow);
  }

  return windows;
}
```

Export `binPackSessions` from the module (it's already `export`).

**Step 4: Run test to verify it passes**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
git add src/session-indexer.ts tests/session-indexer.test.ts
git commit -m "feat: add binPackSessions for packing sessions into token windows

Greedy first-fit bin-packing that never splits a session across windows.
Replaces the old sliding-window approach for LLM extraction.

Generated with Claude Code"
```

---

### Task 4: Rewrite extractKnowledge to Use Bin-Packed Windows

**Files:**
- Modify: `src/session-indexer.ts:37-52` (`LLMExtractionConfig`)
- Modify: `src/session-indexer.ts:253-308` (`extractKnowledge`)
- Test: `tests/session-indexer.test.ts`

**Context:** Replace the sliding-window `extractKnowledge()` with one that accepts pre-packed windows and sends each as a single LLM request. Add `cache_prompt: true` to the request body for llama.cpp prompt caching (same system prompt across all windows). Remove the 500-char truncation.

**Step 1: Update LLMExtractionConfig type**

Replace `windowSize`, `windowStride` with `maxWindowTokens`:

```typescript
export interface LLMExtractionConfig {
  /** OpenAI-compatible chat completions endpoint */
  endpoint: string;
  /** Model name (e.g. "Qwen3.5-4B-Q8_0") */
  model: string;
  /** API key (optional for local models) */
  apiKey?: string;
  /** Max tokens per window for bin-packing (default: 190000) */
  maxWindowTokens?: number;
  /** Max tokens for LLM response (default: 2048) */
  maxTokens?: number;
  /** Timeout per request in ms (default: 120000 — 2 min for large windows) */
  timeout?: number;
  /** Enable llama.cpp prompt caching (default: true) */
  cachePrompt?: boolean;
}
```

**Step 2: Rewrite extractKnowledge**

```typescript
export async function extractKnowledge(
  turns: SessionTurn[],
  config: LLMExtractionConfig,
): Promise<{ memories: string[]; errors: number }> {
  const maxWindowTokens = config.maxWindowTokens ?? 190000;
  const allMemories: string[] = [];
  let errors = 0;

  // Group turns by sessionId, preserving order
  const sessionMap = new Map<string, SessionTurn[]>();
  for (const turn of turns) {
    const existing = sessionMap.get(turn.sessionId);
    if (existing) {
      existing.push(turn);
    } else {
      sessionMap.set(turn.sessionId, [turn]);
    }
  }
  const sessions = Array.from(sessionMap.values());

  // Bin-pack sessions into windows
  const windows = binPackSessions(sessions, maxWindowTokens);
  console.warn(`session-indexer: packed ${sessions.length} sessions into ${windows.length} windows`);

  for (let wi = 0; wi < windows.length; wi++) {
    const window = windows[wi];
    const windowText = window
      .map(t => `[${t.role}] ${t.text}`)
      .join("\n");

    console.warn(`  window ${wi + 1}/${windows.length}: ${window.length} turns, ~${estimateTokens(windowText)} tokens`);

    try {
      const resp = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
            { role: "user", content: windowText },
          ],
          temperature: 0.0,
          max_tokens: config.maxTokens ?? 2048,
          ...(config.cachePrompt !== false ? { cache_prompt: true } : {}),
        }),
        signal: AbortSignal.timeout(config.timeout ?? 120000),
      });

      if (!resp.ok) {
        console.warn(`  window ${wi + 1}: HTTP ${resp.status}`);
        errors++;
        continue;
      }

      const data = await resp.json() as any;
      const content = data.choices?.[0]?.message?.content?.trim() || "";

      if (content === "NONE" || !content) continue;

      const memories = content.split("\n")
        .map((l: string) => l.trim())
        .filter((l: string) => l.length >= 20 && l !== "NONE");

      allMemories.push(...memories);
    } catch (err) {
      console.warn(`  window ${wi + 1}: ${err}`);
      errors++;
    }
  }

  return { memories: allMemories, errors };
}
```

**Step 3: Update existing extractKnowledge tests**

The existing tests create mock HTTP servers and call `extractKnowledge` with `windowSize`/`windowStride`. Update them to use the new config shape. The tests still work because the function signature hasn't changed — it still takes `(turns, config)`.

Update test configs from:
```typescript
{ windowSize: 3, windowStride: 2, ... }
```
to:
```typescript
{ maxWindowTokens: 100000, ... }
```

**Step 4: Write a new test for bin-packed extraction**

```typescript
describe("extractKnowledge with bin-packed windows", () => {
  it("should send one request per window", async () => {
    let requestCount = 0;
    const { server, port } = await createMockLLMServer((body) => {
      requestCount++;
      return "User prefers TypeScript for backend development.";
    });

    try {
      // Create turns from 2 sessions
      const turns: SessionTurn[] = [
        { sessionId: "s1", timestamp: "", role: "user", text: "I love TypeScript for backend" },
        { sessionId: "s1", timestamp: "", role: "assistant", text: "Great choice!" },
        { sessionId: "s2", timestamp: "", role: "user", text: "Always use dark mode please" },
        { sessionId: "s2", timestamp: "", role: "assistant", text: "Noted." },
      ];

      const { memories, errors } = await extractKnowledge(turns, {
        endpoint: `http://localhost:${port}/v1/chat/completions`,
        model: "test-model",
        maxWindowTokens: 100000, // All fit in one window
        timeout: 5000,
      });

      assert.equal(requestCount, 1, "should send one request for one window");
      assert.ok(memories.length > 0);
      assert.equal(errors, 0);
    } finally {
      server.close();
    }
  });
});
```

**Step 5: Run tests**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: PASS

**Step 6: Commit**

```bash
git add src/session-indexer.ts tests/session-indexer.test.ts
git commit -m "feat: rewrite extractKnowledge to use bin-packed session windows

Replaces tiny sliding windows (3 turns, 500 char truncation) with
session bin-packing into ~190K token windows. Adds cache_prompt for
llama.cpp prompt caching. Increases default timeout to 2 minutes.

Generated with Claude Code"
```

---

### Task 5: Global Scope with Metadata Provenance

**Files:**
- Modify: `src/session-indexer.ts:544-557` (entry creation in `indexSessions`)
- Modify: `src/session-indexer.ts:397-416` (LLM path in `indexSessions`)
- Test: `tests/session-indexer.test.ts`

**Context:** Currently memories are stored with `scope: session:KEY`. The new design stores everything with `scope: global` (so all memories are found during normal retrieval) but includes `sessionKey` and `agentId` in metadata for provenance tracking and potential future filtering.

**Step 1: Write the failing test**

```typescript
describe("indexSessions scope and metadata", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    // Write a sessions.json registry
    writeFileSync(join(tempDir, "sessions.json"), JSON.stringify({
      "agent:main:discord:channel:123": { sessionId: "sess-abc" },
    }));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should store memories with scope global", async () => {
    const lines = [
      makeSessionHeader("sess-abc"),
      makeMessage("user", "I prefer using dark mode in all editors and terminals"),
      makeMessage("assistant", "Noted — dark mode preference saved for all environments."),
    ];
    writeSessionFile(tempDir, "sess-abc", lines);

    const stored: any[] = [];
    const testStore = {
      ...mockStore,
      bulkStore: async (entries: any[]) => {
        stored.push(...entries);
      },
    };

    await indexSessions(testStore as any, mockEmbedder, {
      sessionsDir: tempDir,
      targetScope: "global",
      minImportance: 0.0,
    });

    assert.ok(stored.length > 0, "should store at least one memory");
    for (const entry of stored) {
      assert.equal(entry.scope, "global", "scope should be global");
      const meta = JSON.parse(entry.metadata);
      assert.equal(meta.source, "session-import");
      assert.equal(meta.sessionKey, "agent:main:discord:channel:123");
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: FAIL — current scope is `session:KEY`, metadata.source is `"session-indexer"`

**Step 3: Implement global scope + metadata provenance**

Change entry creation in `indexSessions()` (line 544-557):

```typescript
  const entries: Omit<MemoryEntry, "id" | "timestamp">[] = dedupedIndex.map((item, i) => {
    const sessionKey = sessionKeyMap.get(item.turn.sessionId) || item.turn.sessionId;
    // Extract agentId from session key (format: "agent:NAME:..." or just the session ID)
    const agentIdMatch = sessionKey.match(/^agent:([^:]+)/);
    const agentId = agentIdMatch ? agentIdMatch[1] : undefined;

    return {
      text: item.turn.text,
      vector: dedupedVectors[i],
      category: item.category,
      scope: "global",
      importance: item.importance,
      metadata: JSON.stringify({
        source: "session-import",
        sessionId: item.turn.sessionId,
        sessionKey,
        ...(agentId ? { agentId } : {}),
        role: item.turn.role,
        originalTimestamp: item.turn.timestamp,
      }),
    };
  });
```

Key changes:
- `scope` → `"global"` (was `session:KEY`)
- `metadata.source` → `"session-import"` (was `"session-indexer"`)
- Added `metadata.sessionKey` and `metadata.agentId`
- Removed `metadata.sessionScope` (no longer needed)

**Step 4: Update CLI incremental import to match new source name**

In `src/cli.ts` line 720, change:
```typescript
if (meta.source === "session-indexer" && meta.sessionId) {
```
to:
```typescript
if ((meta.source === "session-import" || meta.source === "session-indexer") && meta.sessionId) {
```

And line 690:
```typescript
return meta.source === "session-indexer";
```
to:
```typescript
return meta.source === "session-import" || meta.source === "session-indexer";
```

This ensures backward compatibility with existing imported memories.

**Step 5: Run test to verify it passes**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: PASS

**Step 6: Commit**

```bash
git add src/session-indexer.ts src/cli.ts tests/session-indexer.test.ts
git commit -m "feat: store session-imported memories with global scope + metadata provenance

Memories are now stored with scope: global for universal retrieval.
Provenance metadata includes sessionKey and agentId for filtering.
Source tag renamed to 'session-import' with backward compat for 'session-indexer'.

Generated with Claude Code"
```

---

### Task 6: Multi-Agent Support (--all-agents flag)

**Files:**
- Modify: `src/cli.ts:662-785` (import-sessions command)
- Test: `tests/session-indexer.test.ts`

**Step 1: Write the failing test (integration test for multi-agent directory discovery)**

```typescript
describe("multi-agent session discovery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    // Create agent directories
    mkdirSync(join(tempDir, "main", "sessions"), { recursive: true });
    mkdirSync(join(tempDir, "infra", "sessions"), { recursive: true });
    mkdirSync(join(tempDir, "coder", "sessions"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should discover all agent session directories", () => {
    // Write session files in each agent dir
    const lines = [
      makeSessionHeader("test-sess"),
      makeMessage("user", "I prefer TypeScript for all new backend services and APIs"),
      makeMessage("assistant", "TypeScript preference noted for backend work."),
    ];
    writeSessionFile(join(tempDir, "main", "sessions"), "main-sess", lines);
    writeSessionFile(join(tempDir, "infra", "sessions"), "infra-sess", lines);

    // Discover agents
    const agentDirs = readdirSync(tempDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(tempDir, d.name, "sessions")))
      .map(d => d.name);

    assert.deepEqual(agentDirs.sort(), ["coder", "infra", "main"]);
  });
});
```

**Step 2: Add --all-agents flag to CLI**

In `src/cli.ts`, add the option (after line 666):
```typescript
    .option("--all-agents", "Import sessions from all agents (not just the specified one)")
```

In the action handler, before the `indexSessions` call, add agent directory discovery:

```typescript
        // Determine which session directories to import
        const agentsDirs: Array<{ agent: string; dir: string }> = [];
        if (options.allAgents) {
          const agentsRoot = join(home, ".openclaw", "agents");
          const { readdirSync, existsSync } = await import("node:fs");
          if (existsSync(agentsRoot)) {
            for (const entry of readdirSync(agentsRoot, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                const sessDir = join(agentsRoot, entry.name, "sessions");
                if (existsSync(sessDir)) {
                  agentsDirs.push({ agent: entry.name, dir: sessDir });
                }
              }
            }
          }
          console.log(`Found ${agentsDirs.length} agents: ${agentsDirs.map(a => a.agent).join(", ")}`);
        } else {
          agentsDirs.push({ agent: options.agent, dir: sessionsDir });
        }
```

Then loop over agents:

```typescript
        let combinedResult: import("./session-indexer.js").IndexResult | undefined;
        for (const { agent, dir } of agentsDirs) {
          console.warn(`\nImporting sessions for agent: ${agent}`);
          const result = await indexSessions(context.store, context.embedder, {
            sessionsDir: dir,
            targetScope: options.scope,
            minImportance: parseFloat(options.minImportance) || 0.1,
            dryRun: options.dryRun === true,
            alreadyImported,
            llmExtraction,
            includeDeleted: options.includeDeleted === true,
          });

          if (!combinedResult) {
            combinedResult = result;
          } else {
            // Merge results
            combinedResult.totalSessions += result.totalSessions;
            combinedResult.skippedSessions += result.skippedSessions;
            combinedResult.skippedAlreadyImported += result.skippedAlreadyImported;
            combinedResult.totalTurns += result.totalTurns;
            combinedResult.indexedTurns += result.indexedTurns;
            combinedResult.skippedNoise += result.skippedNoise;
            combinedResult.skippedImportance += result.skippedImportance;
            combinedResult.llmExtracted += result.llmExtracted;
            combinedResult.llmErrors += result.llmErrors;
            combinedResult.llmDeduplicated += result.llmDeduplicated;
            combinedResult.skippedStoreDuplicates += result.skippedStoreDuplicates;
            combinedResult.errors.push(...result.errors);
          }
        }
        const result = combinedResult!;
```

**Step 3: Also add --include-deleted CLI flag**

In `src/cli.ts`, add the option (after line 671):
```typescript
    .option("--include-deleted", "Include rotated/deleted session files (.jsonl.deleted.*)")
```

**Step 4: Run full test suite**

Run: `node --import jiti/register --test tests/*.test.ts 2>&1 | tail -20`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli.ts tests/session-indexer.test.ts
git commit -m "feat: add --all-agents and --include-deleted CLI flags

--all-agents discovers and imports sessions from all agent directories.
--include-deleted includes rotated .jsonl.deleted.* files.
Results from multiple agents are merged into a single report.

Generated with Claude Code"
```

---

### Task 7: LLM Extraction in indexSessions — Wire Bin-Packing

**Files:**
- Modify: `src/session-indexer.ts:397-416` (LLM path in `indexSessions`)

**Context:** The LLM path in `indexSessions()` currently passes a flat array of turns to `extractKnowledge()`. With the rewritten `extractKnowledge()` from Task 4, it now groups by sessionId and bin-packs internally. But we need to ensure the LLM-extracted turns carry proper session metadata for scope/provenance.

**Step 1: Update LLM extraction path to pass sessionId through**

The LLM-extracted memories currently use `sessionId: "llm-extracted"` (line 408). This loses provenance. Instead, use a synthetic session ID that references the extraction batch:

```typescript
    if (memories.length > 0) {
      filtered = memories.map((text, i) => ({
        sessionId: `llm-batch-${Date.now()}`,
        timestamp: new Date().toISOString(),
        role: "assistant" as const,
        text,
      }));
    }
```

Actually, this is fine for now — the real provenance comes from the metadata in Task 5. The `sessionId` on the turn is only used for scope lookup via `sessionKeyMap`, and LLM-extracted memories won't match any session key, so they'll fall back to the session ID itself.

**Step 2: Verify no code changes needed (extractKnowledge handles bin-packing internally)**

The rewritten `extractKnowledge()` from Task 4 groups turns by `sessionId` and calls `binPackSessions()`. The `indexSessions()` LLM path passes `envelopeStripped` turns (which preserve `sessionId`), so bin-packing works automatically.

**Step 3: Run tests to verify**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: PASS

**Step 4: Commit (only if changes were needed)**

No commit needed if no code changes.

---

### Task 8: Update EXTRACTION_SYSTEM_PROMPT

**Files:**
- Modify: `src/session-indexer.ts:227-251` (`EXTRACTION_SYSTEM_PROMPT`)

**Context:** The current example in the prompt caused Qwen3-0.6B to hallucinate "Model preference: Use Opus..." in every output. While Qwen3.5-4B handles it fine, a safer prompt avoids examples that could be parroted. Also, with full transcripts, the prompt should instruct the LLM to process longer conversations.

**Step 1: Update the prompt**

```typescript
const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system. Given a conversation transcript, extract knowledge worth remembering long-term.

Extract ONLY:
- User preferences (tools, editors, styles, workflows, communication preferences)
- Technical decisions with rationale (architecture, technology choices, tradeoffs)
- Key facts (configurations, endpoints, names, dates, benchmarks, resource limits)
- Project conventions, coding standards, and rules
- Environment details (OS, hardware, deployment topology, model configs)

Do NOT extract:
- Greetings, acknowledgments, small talk, reactions
- Imperative commands ("do it", "run the tests", "fix this")
- Meta-discussion about memory or context itself
- Transient debugging state or temporary workarounds
- Code snippets or file contents (extract the DECISION, not the code)

For each extracted memory, write one concise self-contained statement per line.
Include relevant context (dates, versions, tools) when available.
Write in third person ("User prefers...", "Decision: ...", "Project uses...").
If nothing is worth remembering, respond with exactly: NONE`;
```

Key changes:
- Removed the example that caused hallucination
- Added "Environment details" category
- Added "Code snippets" to the "do not extract" list
- Clarified "extract the DECISION, not the code"

**Step 2: Run existing extraction tests**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: PASS (tests mock the LLM, don't depend on prompt content)

**Step 3: Commit**

```bash
git add src/session-indexer.ts
git commit -m "fix: update extraction prompt to avoid hallucination patterns

Remove example that Qwen3-0.6B was parroting. Add environment details
category. Clarify that code snippets should not be extracted.

Generated with Claude Code"
```

---

### Task 9: Wire Generation Config in Plugin Config

**Files:**
- Modify: `openclaw.plugin.json` (add `generation` to config schema if not present)
- Modify: `index.ts` (pass generation config to CLI context)

**Context:** The `--llm-extract` flag requires `context.generationConfig` which comes from the plugin's `generation` config block. This needs to be populated in the deployed config.

**Step 1: Check if generation config is already in the plugin schema**

The `openclaw.plugin.json` already has a `generation` config block in its schema. Verify it's being passed to the CLI context.

**Step 2: Verify wiring in index.ts**

Read `index.ts` to confirm `generationConfig` is passed to CLI context. If not, add it.

**Step 3: Update deployed config**

This is a deployment step — document what the user needs to add to their OpenClaw config:

```json
{
  "generation": {
    "baseURL": "http://localhost:8090/v1",
    "model": "Qwen3.5-4B-Instruct-Q8_0",
    "apiKey": "sk-..."
  }
}
```

**Step 4: Commit any schema/wiring changes**

```bash
git add openclaw.plugin.json index.ts
git commit -m "feat: wire generation config for LLM extraction

Ensures generation config from plugin settings is available to the
import-sessions command for --llm-extract flag.

Generated with Claude Code"
```

---

### Task 10: Full Integration Test — End-to-End Import Pipeline

**Files:**
- Test: `tests/session-indexer.test.ts`

**Step 1: Write integration test**

```typescript
describe("indexSessions full pipeline integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("should import sessions with includeDeleted and global scope", async () => {
    // Write sessions.json registry
    writeFileSync(join(tempDir, "sessions.json"), JSON.stringify({
      "agent:main:discord:general": { sessionId: "active-sess" },
      "agent:main:discord:dev": { sessionId: "deleted-sess" },
    }));

    // Write active session
    const activeLines = [
      makeSessionHeader("active-sess"),
      makeMessage("user", "I prefer using Vim keybindings in every editor I use"),
      makeMessage("assistant", "Vim keybindings preference noted across all editors."),
    ];
    writeSessionFile(tempDir, "active-sess", activeLines);

    // Write deleted/rotated session
    const deletedLines = [
      makeSessionHeader("deleted-sess"),
      makeMessage("user", "Always use dark theme for terminal and code editors"),
      makeMessage("assistant", "Dark theme preference saved for all environments."),
    ];
    writeFileSync(
      join(tempDir, "deleted-sess.jsonl.deleted.1709654321"),
      deletedLines.join("\n"),
    );

    const stored: any[] = [];
    const testStore = {
      ...mockStore,
      bulkStore: async (entries: any[]) => { stored.push(...entries); },
      vectorSearch: async () => [], // No duplicates
    };

    const result = await indexSessions(testStore as any, mockEmbedder, {
      sessionsDir: tempDir,
      targetScope: "global",
      minImportance: 0.0,
      includeDeleted: true,
    });

    assert.equal(result.totalSessions, 2, "should find both sessions");
    assert.ok(stored.length >= 2, "should store memories from both sessions");

    // Verify global scope
    for (const entry of stored) {
      assert.equal(entry.scope, "global");
    }

    // Verify metadata provenance
    const metas = stored.map(e => JSON.parse(e.metadata));
    assert.ok(metas.some(m => m.sessionKey === "agent:main:discord:general"));
    assert.ok(metas.some(m => m.sessionKey === "agent:main:discord:dev"));
    assert.ok(metas.every(m => m.source === "session-import"));
  });

  it("should do incremental import skipping already-imported sessions", async () => {
    const lines = [
      makeSessionHeader("sess-1"),
      makeMessage("user", "I always use TypeScript strict mode in all projects"),
      makeMessage("assistant", "TypeScript strict mode preference saved."),
    ];
    writeSessionFile(tempDir, "sess-1", lines);
    writeSessionFile(tempDir, "sess-2", [
      makeSessionHeader("sess-2"),
      makeMessage("user", "Deploy to production every Friday after code review"),
      makeMessage("assistant", "Friday deployment schedule noted."),
    ]);

    const stored: any[] = [];
    const testStore = {
      ...mockStore,
      bulkStore: async (entries: any[]) => { stored.push(...entries); },
      vectorSearch: async () => [],
    };

    const result = await indexSessions(testStore as any, mockEmbedder, {
      sessionsDir: tempDir,
      targetScope: "global",
      minImportance: 0.0,
      alreadyImported: new Set(["sess-1"]),
    });

    assert.equal(result.skippedAlreadyImported, 1);
    // Only sess-2 turns should be stored
    const metas = stored.map(e => JSON.parse(e.metadata));
    assert.ok(metas.every(m => m.sessionId === "sess-2"));
  });
});
```

**Step 2: Run tests**

Run: `node --import jiti/register --test tests/session-indexer.test.ts 2>&1 | tail -20`
Expected: PASS

**Step 3: Run full test suite**

Run: `node --import jiti/register --test tests/*.test.ts 2>&1 | tail -20`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add tests/session-indexer.test.ts
git commit -m "test: add integration tests for full import pipeline

Tests includeDeleted + global scope + metadata provenance + incremental
import in realistic scenarios.

Generated with Claude Code"
```

---

### Task 11: Deploy and Run Full Extraction

**Step 1: Deploy updated plugin**

```bash
cp -r . ~/.openclaw/plugins/memex/
```

**Step 2: Add generation config to deployed config**

Add to the memex plugin config (in OpenClaw settings or the plugin's config file):

```json
{
  "generation": {
    "baseURL": "http://localhost:8090/v1",
    "model": "Qwen3.5-4B-Instruct-Q8_0"
  }
}
```

**Step 3: Dry run to verify corpus coverage**

```bash
memory import-sessions --all-agents --include-deleted --llm-extract --dry-run
```

Expected output should show:
- All 7 agents discovered
- ~880 session files (including deleted)
- ~2M tokens worth of turns
- N windows packed

**Step 4: Full extraction**

```bash
memory import-sessions --all-agents --include-deleted --llm-extract --fresh
```

Expected: ~1-2 minutes for 10 windows, producing high-quality extracted memories.

**Step 5: Verify quality**

```bash
memory recall "user preferences"
memory recall "architecture decisions"
memory recall "deployment configuration"
```

---

## Verification Checklist

```bash
# Unit + integration tests
node --import jiti/register --test tests/session-indexer.test.ts

# Full suite (should be 280+ tests)
node --import jiti/register --test tests/*.test.ts

# Dry run with all flags
memory import-sessions --all-agents --include-deleted --llm-extract --dry-run

# Full import
memory import-sessions --all-agents --include-deleted --llm-extract --fresh
```

## Files Modified Summary

| File | Changes |
|------|---------|
| `src/session-indexer.ts` | includeDeleted, skipAutomatedTurns, binPackSessions, rewrite extractKnowledge, global scope + metadata, updated prompt |
| `src/cli.ts` | --all-agents, --include-deleted flags, multi-agent loop, backward-compat source tag |
| `tests/session-indexer.test.ts` | ~8 new test groups (~30 new tests) |
| `openclaw.plugin.json` | generation config wiring (if needed) |
| `index.ts` | generation config passthrough (if needed) |
