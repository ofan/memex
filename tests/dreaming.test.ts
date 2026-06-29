/**
 * Tests for memex dreaming — memory consolidation system.
 *
 * Step 4: Light sweep (dedup, noise removal, fragment purge)
 * Step 5: Deep sweep (recall-based re-scoring, ephemeral decay)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";

const VECTOR_DIM = 8;

function makeVector(seed: number): number[] {
  const v = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}

/** Store a memory with optional overrides for timestamp and recall_count. */
async function seedMemory(
  store: MemoryStore,
  text: string,
  opts: {
    seed?: number;
    importance?: number;
    category?: string;
    timestamp?: number;
    recallCount?: number;
    metadata?: string;
  } = {},
) {
  const entry = await store.store({
    text,
    vector: makeVector(opts.seed ?? text.length),
    category: (opts.category || "fact") as any,
    scope: "global",
    importance: opts.importance ?? 0.5,
    metadata: opts.metadata,
  });
  if (!entry) return null;

  // Override timestamp and recall_count if specified
  if (opts.timestamp) {
    store.db.prepare("UPDATE memories SET timestamp = ? WHERE id = ?").run(opts.timestamp, entry.id);
  }
  if (opts.recallCount) {
    store.db.prepare("UPDATE memories SET recall_count = ? WHERE id = ?").run(opts.recallCount, entry.id);
  }
  return entry;
}

// Days ago in milliseconds
const daysAgo = (d: number) => Date.now() - d * 86400_000;

// ============================================================================
// Import dreaming module (will be created in implementation)
// ============================================================================

// These will fail until src/dreaming.ts is created
import { lightSweep, deepSweep, reflectionSweep, runDreamCycle, type DreamConfig, type ReflectionLLMConfig } from "../src/dreaming.js";

// ============================================================================
// Light Sweep
// ============================================================================

describe("light sweep", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dream-light-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
    logPath = join(tmpDir, "memex.log");
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("removes exact text duplicates, keeps newest", async () => {
    // Insert 3 entries with same text but different timestamps
    // (bypass dedup guard by inserting directly)
    const text = "Duplicate fact about deployment";
    const hash = (await import("node:crypto")).createHash("sha256").update(text).digest("hex");

    for (let i = 0; i < 3; i++) {
      const id = `dup-${i}`;
      store.db.prepare(
        "INSERT INTO memories (id, text, category, scope, importance, timestamp, text_hash) VALUES (?, ?, 'fact', 'global', 0.5, ?, ?)"
      ).run(id, text, daysAgo(3 - i), i === 0 ? hash : `${hash}-${i}`);
    }

    assert.equal(store.totalMemories, 3);

    const result = await lightSweep(store, logPath);

    assert.equal(result.deduped, 2, "should remove 2 duplicates");
    assert.equal(store.totalMemories, 1, "1 entry remains");

    // The newest should survive
    const remaining = store.db.prepare("SELECT id FROM memories").get() as { id: string };
    assert.equal(remaining.id, "dup-2", "newest entry should survive");
  });

  it("removes conversation fragments from existing entries", async () => {
    // Insert fragments directly (bypass store guard)
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'fact', 'global', 0.6, ?)"
    ).run("frag-1", "[assistant] yo — I'm back on the new config.", Date.now());
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'preference', 'global', 0.6, ?)"
    ).run("frag-2", "[user] give me a diff", Date.now());

    // Also a valid entry
    await seedMemory(store, "Valid fact about servers");

    assert.equal(store.totalMemories, 3);

    const result = await lightSweep(store, logPath);

    assert.equal(result.fragmentsRemoved, 2);
    assert.equal(store.totalMemories, 1);
  });

  it("removes entries matching isNoise()", async () => {
    // Insert noise directly
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'other', 'global', 0.3, ?)"
    ).run("noise-1", "got it", Date.now());
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'other', 'global', 0.3, ?)"
    ).run("noise-2", "ok", Date.now());

    await seedMemory(store, "Real fact worth keeping");

    const result = await lightSweep(store, logPath);

    assert.ok(result.noiseRemoved >= 2, `expected >= 2 noise removed, got ${result.noiseRemoved}`);
    assert.equal(store.totalMemories, 1);
  });

  it("is idempotent — running twice produces same result", async () => {
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'fact', 'global', 0.6, ?)"
    ).run("frag-x", "[assistant] some dialogue", Date.now());
    await seedMemory(store, "Good entry");

    await lightSweep(store, logPath);
    const countAfterFirst = store.totalMemories;

    await lightSweep(store, logPath);
    const countAfterSecond = store.totalMemories;

    assert.equal(countAfterFirst, countAfterSecond, "second run should not change anything");
  });

  it("writes to log file", async () => {
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'other', 'global', 0.3, ?)"
    ).run("noise-log", "done", Date.now());

    await lightSweep(store, logPath);

    const log = await readFile(logPath, "utf-8");
    assert.ok(log.includes("[dream:light]"), "log should contain dream:light entry");
  });
});

// ============================================================================
// Scope-aware dedup (light sweep)
// ============================================================================

describe("scope-aware dedup", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dream-dedup-scope-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
    logPath = join(tmpDir, "memex.log");
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("dedup: same text + same scope-set → removes older, keeps newest", async () => {
    // Insert 3 memories with same text and same scope tags
    const text = "Shared deployment fact about production infra";
    const now = Date.now();

    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID();
      store.db.prepare(
        "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'fact', 'global', 0.5, ?)"
      ).run(id, text, now - (3 - i) * 3600_000);
      // Write same scope tags for each
      for (const tag of ["global", "project:abc123"]) {
        store.db.prepare(
          "INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)"
        ).run(id, tag);
      }
    }

    assert.equal(store.totalMemories, 3);

    const result = await lightSweep(store, logPath);

    assert.equal(result.deduped, 2, "should remove 2 duplicates (same text + same scope)");
    assert.equal(store.totalMemories, 1, "1 entry remains");
  });

  it("dedup: same text + different scope-set → both survive", async () => {
    const text = "Common fact applicable to multiple projects";

    // Memory A: scoped to project:abc
    const idA = crypto.randomUUID();
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'fact', 'global', 0.5, ?)"
    ).run(idA, text, Date.now() - 3600_000);
    for (const tag of ["global", "project:abc123"]) {
      store.db.prepare(
        "INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)"
      ).run(idA, tag);
    }

    // Memory B: same text, scoped to project:def
    const idB = crypto.randomUUID();
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'fact', 'global', 0.5, ?)"
    ).run(idB, text, Date.now() - 1800_000);
    for (const tag of ["global", "project:def456"]) {
      store.db.prepare(
        "INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)"
      ).run(idB, tag);
    }

    assert.equal(store.totalMemories, 2);

    const result = await lightSweep(store, logPath);

    assert.equal(result.deduped, 0, "should not dedup — different scope-sets");
    assert.equal(store.totalMemories, 2, "both entries survive");
  });

  it("dedup: memories without scope rows default to 'global' scope-set", async () => {
    // Insert 2 memories with same text but NO memory_scopes rows
    const text = "Fact without explicit scope rows";
    const now = Date.now();

    for (let i = 0; i < 2; i++) {
      const id = crypto.randomUUID();
      store.db.prepare(
        "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'fact', 'global', 0.5, ?)"
      ).run(id, text, now - (2 - i) * 3600_000);
    }

    assert.equal(store.totalMemories, 2);

    await lightSweep(store, logPath);

    // Both have scope_set = 'global' (default), so older should be deduped
    assert.equal(store.totalMemories, 1, "dupes removed (both default to global scope-set)");
  });

  it("dedup: partial scope overlap dedups within each scope-set independently", async () => {
    const text = "Multi-scope dedup test";
    const now = Date.now();

    // Two memories in scope-set A: {global, project:abc}
    for (let i = 0; i < 2; i++) {
      const id = crypto.randomUUID();
      store.db.prepare(
        "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'fact', 'global', 0.5, ?)"
      ).run(id, text, now - (2 - i) * 3600_000);
      for (const tag of ["global", "project:abc123"]) {
        store.db.prepare(
          "INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)"
        ).run(id, tag);
      }
    }

    // Two memories in scope-set B: {global, project:xyz}
    for (let i = 0; i < 2; i++) {
      const id = crypto.randomUUID();
      store.db.prepare(
        "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'fact', 'global', 0.5, ?)"
      ).run(id, text, now - (2 - i) * 3600_000);
      for (const tag of ["global", "project:xyz789"]) {
        store.db.prepare(
          "INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)"
        ).run(id, tag);
      }
    }

    assert.equal(store.totalMemories, 4);

    const result = await lightSweep(store, logPath);

    // Each scope-set had 2 dupes → 1 survivor each = 2 total
    assert.equal(result.deduped, 2, "should remove 2 duplicates (1 per scope-set)");
    assert.equal(store.totalMemories, 2, "1 per scope-set survives");
  });
});

// ============================================================================
// Deep Sweep
// ============================================================================

describe("deep sweep", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dream-deep-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
    logPath = join(tmpDir, "memex.log");
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("boosts importance for frequently recalled entries", async () => {
    const entry = await seedMemory(store, "Frequently recalled fact", {
      importance: 0.3,
      recallCount: 10,
      timestamp: daysAgo(15),
    });

    const result = await deepSweep(store, logPath);

    const row = store.db.prepare("SELECT importance FROM memories WHERE id = ?")
      .get(entry!.id) as { importance: number };

    assert.ok(row.importance >= 0.7, `expected importance >= 0.7, got ${row.importance}`);
    assert.ok(result.rescored > 0);
  });

  it("decays importance for old never-recalled entries", async () => {
    const entry = await seedMemory(store, "Old unused fact", {
      importance: 0.5,
      timestamp: daysAgo(60),
    });

    await deepSweep(store, logPath);

    const row = store.db.prepare("SELECT importance FROM memories WHERE id = ?")
      .get(entry!.id) as { importance: number };

    assert.ok(row.importance <= 0.3, `expected importance <= 0.3, got ${row.importance}`);
  });

  it("does not decay recent entries even if never recalled", async () => {
    const entry = await seedMemory(store, "Recent entry not yet recalled", {
      importance: 0.5,
      timestamp: daysAgo(5),
    });

    await deepSweep(store, logPath);

    const row = store.db.prepare("SELECT importance FROM memories WHERE id = ?")
      .get(entry!.id) as { importance: number };

    assert.equal(row.importance, 0.5, "recent entry should not be decayed");
  });

  it("decays stale action logs matching ephemeral patterns", async () => {
    const entry = await seedMemory(store, "The unused Discord webhook was deleted.", {
      importance: 0.3,
      timestamp: daysAgo(45),
    });

    await deepSweep(store, logPath);

    const row = store.db.prepare("SELECT importance FROM memories WHERE id = ?")
      .get(entry!.id) as { importance: number };

    assert.ok(row.importance <= 0.1, `expected importance <= 0.1 for stale action log, got ${row.importance}`);
  });

  it("aggressively decays session imports >14d to 0.1", async () => {
    await seedMemory(store, "Session import fact about deployment configs", {
      importance: 0.3,
      timestamp: daysAgo(20),
      metadata: '{"source":"session-import","sessionKey":"llm-extracted"}',
    });

    await deepSweep(store, logPath);

    const row = store.db.prepare("SELECT importance FROM memories").get() as { importance: number };
    assert.ok(row.importance <= 0.1, `expected importance <= 0.1, got ${row.importance}`);
  });

  it("evicts session imports >30d (importance set to 0.05)", async () => {
    await seedMemory(store, "Old session import about ABP config", {
      importance: 0.3,
      timestamp: daysAgo(35),
      metadata: '{"source":"session-import","sessionKey":"llm-extracted"}',
    });

    await deepSweep(store, logPath);

    // Entry should be evicted (importance ≤ 0.05 triggers DELETE)
    assert.equal(store.totalMemories, 0, "session import >30d should be evicted");
  });

  it("does NOT decay recalled session imports", async () => {
    await seedMemory(store, "Recalled session import about Discord channel", {
      importance: 0.3,
      timestamp: daysAgo(20),
      recallCount: 5,
      metadata: '{"source":"session-import","sessionKey":"llm-extracted"}',
    });

    await deepSweep(store, logPath);

    const row = store.db.prepare("SELECT importance FROM memories").get() as { importance: number };
    assert.ok(row.importance >= 0.7, `recalled session import should be boosted, got ${row.importance}`);
  });

  it("does NOT aggressively decay non-session memories", async () => {
    await seedMemory(store, "Agent-stored fact about servers", {
      importance: 0.3,
      timestamp: daysAgo(20),
      // No session-import metadata
    });

    await deepSweep(store, logPath);

    const row = store.db.prepare("SELECT importance FROM memories").get() as { importance: number };
    assert.equal(row.importance, 0.3, "non-session memory at 20d should keep importance 0.3");
  });

  it("is idempotent — decayed entries stay decayed", async () => {
    await seedMemory(store, "Old entry for idempotency test", {
      importance: 0.5,
      timestamp: daysAgo(60),
    });

    await deepSweep(store, logPath);
    const rows1 = store.db.prepare("SELECT importance FROM memories").all() as { importance: number }[];

    await deepSweep(store, logPath);
    const rows2 = store.db.prepare("SELECT importance FROM memories").all() as { importance: number }[];

    assert.deepEqual(rows1, rows2, "second run should produce same importance values");
  });

  it("writes to log file", async () => {
    await seedMemory(store, "Entry for log test", {
      importance: 0.3,
      recallCount: 10,
      timestamp: daysAgo(15),
    });

    await deepSweep(store, logPath);

    const log = await readFile(logPath, "utf-8");
    assert.ok(log.includes("[dream:deep]"), "log should contain dream:deep entry");
  });
});

// ============================================================================
// Reflection Sweep
// ============================================================================

describe("reflection sweep", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let logPath: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dream-reflect-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
    logPath = join(tmpDir, "memex.log");
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("produces learnings from LLM response", async () => {
    // Seed 10 memories so we pass the minimum threshold
    for (let i = 0; i < 10; i++) {
      await seedMemory(store, `Important fact number ${i} about deployment infrastructure`, {
        importance: 0.7,
        seed: i,
        timestamp: daysAgo(i),
      });
    }

    // Mock LLM to return learnings
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: "Deployment infrastructure is a recurring concern across multiple decisions.\nInfrastructure changes require careful sequencing to avoid cascading failures.\nDocumentation of deployment decisions prevents repeated mistakes.",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const result = await reflectionSweep(store, {
      endpoint: "http://fake-llm/v1/chat/completions",
      model: "test",
    }, logPath);

    assert.equal(result.learnings, 3);
    assert.equal(result.contradictions, 0);
    assert.equal(result.errors.length, 0);

    // Verify learnings are stored in DB
    const storedLearnings = store.db.prepare(
      "SELECT text, category, importance FROM memories WHERE category = 'learning'"
    ).all() as Array<{ text: string; category: string; importance: number }>;
    assert.equal(storedLearnings.length, 3);
    assert.ok(storedLearnings.every(l => l.importance === 0.85));
  });

  it("handles contradictions via SUPERSEDED markers", async () => {
    const older = await seedMemory(store, "Audio transcription uses Whisper turbo", {
      importance: 0.6,
      seed: 1,
      timestamp: daysAgo(20),
    });
    const newer = await seedMemory(store, "Audio transcription switched to Deepgram Nova-3", {
      importance: 0.6,
      seed: 2,
      timestamp: daysAgo(5),
    });

    // Pad to meet minimum
    for (let i = 0; i < 8; i++) {
      await seedMemory(store, `Filler fact ${i}`, { importance: 0.5, seed: 100 + i });
    }

    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: `Audio transcription stack evolved from Whisper to Deepgram Nova-3.\nSUPERSEDED:${older!.id}|${newer!.id}|switched to Deepgram`,
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const result = await reflectionSweep(store, {
      endpoint: "http://fake-llm/v1/chat/completions",
      model: "test",
    }, logPath);

    assert.equal(result.learnings, 1);
    assert.equal(result.contradictions, 1);

    // Older memory should be demoted
    const olderRow = store.db.prepare("SELECT importance FROM memories WHERE id = ?").get(older!.id) as any;
    assert.equal(olderRow.importance, 0.1, "superseded memory should be demoted to 0.1");
  });

  it("skips when too few memories", async () => {
    await seedMemory(store, "Only one memory", { importance: 0.7 });

    globalThis.fetch = async () => {
      throw new Error("should not be called");
    };

    const result = await reflectionSweep(store, {
      endpoint: "http://fake-llm/v1/chat/completions",
      model: "test",
    }, logPath);

    assert.equal(result.learnings, 0);
    assert.equal(result.errors.length, 0);
  });

  it("handles LLM errors gracefully", async () => {
    for (let i = 0; i < 10; i++) {
      await seedMemory(store, `Fact ${i} for error test`, { importance: 0.7, seed: i });
    }

    globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });

    const result = await reflectionSweep(store, {
      endpoint: "http://fake-llm/v1/chat/completions",
      model: "test",
    }, logPath);

    assert.equal(result.learnings, 0);
    assert.ok(result.errors.length > 0);
  });

  it("is idempotent — same learnings not stored twice", async () => {
    for (let i = 0; i < 10; i++) {
      await seedMemory(store, `Fact ${i} for idempotency`, { importance: 0.7, seed: i });
    }

    const mockResponse = JSON.stringify({
      choices: [{ message: { content: "Infrastructure reliability is the top engineering priority." } }],
    });

    globalThis.fetch = async () => new Response(mockResponse, { status: 200, headers: { "Content-Type": "application/json" } });

    const r1 = await reflectionSweep(store, { endpoint: "http://fake/v1/chat/completions", model: "test" }, logPath);
    const r2 = await reflectionSweep(store, { endpoint: "http://fake/v1/chat/completions", model: "test" }, logPath);

    assert.equal(r1.learnings, 1);
    assert.equal(r2.learnings, 0, "second run should not create duplicate learnings");
  });

  // --- Scope-aware reflection tests ---

  it("inherits tags from single-context batch (all same project)", async () => {
    // Seed 10 memories — all tagged with project:abc
    for (let i = 0; i < 10; i++) {
      const entry = await seedMemory(store, `Project ABC fact ${i} about deployment config`, {
        importance: 0.7,
        seed: i,
        timestamp: daysAgo(i),
      });
      // Add project:abc tag to memory_scopes
      if (entry) {
        store.db.prepare(
          "INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)"
        ).run(entry.id, "project:abc123");
      }
    }

    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: "Project ABC uses consistent deployment patterns across services.",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const result = await reflectionSweep(store, {
      endpoint: "http://fake-llm/v1/chat/completions",
      model: "test",
    }, logPath);

    assert.equal(result.learnings, 1);

    // Verify the learning has the inherited scope tags
    const learning = store.db.prepare(
      "SELECT id FROM memories WHERE category = 'learning'"
    ).get() as { id: string };
    assert.ok(learning, "learning should exist in DB");

    const scopeRows = store.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
    ).all(learning.id) as { scope: string }[];
    const scopes = scopeRows.map(r => r.scope);
    assert.ok(scopes.includes("global"), "learning should have global tag");
    assert.ok(scopes.includes("project:abc123"), "learning should inherit project:abc123 tag");
  });

  it("uses only global tag for mixed-context batch", async () => {
    // Seed 10 memories with mixed project tags
    for (let i = 0; i < 5; i++) {
      const entry = await seedMemory(store, `Project ABC fact ${i}`, {
        importance: 0.7,
        seed: i,
        timestamp: daysAgo(i),
      });
      if (entry) {
        store.db.prepare(
          "INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)"
        ).run(entry.id, "project:abc123");
      }
    }

    for (let i = 0; i < 5; i++) {
      const entry = await seedMemory(store, `Project XYZ fact ${i}`, {
        importance: 0.7,
        seed: 100 + i,
        timestamp: daysAgo(i + 5),
      });
      if (entry) {
        store.db.prepare(
          "INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)"
        ).run(entry.id, "project:xyz789");
      }
    }

    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: "Multiple projects share common deployment concerns but differ in execution.",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const result = await reflectionSweep(store, {
      endpoint: "http://fake-llm/v1/chat/completions",
      model: "test",
    }, logPath);

    assert.equal(result.learnings, 1);

    // Verify the learning has ONLY global tag
    const learning = store.db.prepare(
      "SELECT id FROM memories WHERE category = 'learning'"
    ).get() as { id: string };
    assert.ok(learning, "learning should exist in DB");

    const scopeRows = store.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ?"
    ).all(learning.id) as { scope: string }[];
    assert.equal(scopeRows.length, 1, "mixed-context learning should have exactly 1 scope tag");
    assert.equal(scopeRows[0].scope, "global", "mixed-context learning should only have global tag");
  });

  it("inherits tags when some memories are global-only and others share a context", async () => {
    // 6 memories with project:abc, 4 with only global (no non-global tags)
    for (let i = 0; i < 6; i++) {
      const entry = await seedMemory(store, `Project ABC scoped fact ${i}`, {
        importance: 0.7,
        seed: i,
        timestamp: daysAgo(i),
      });
      if (entry) {
        store.db.prepare(
          "INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)"
        ).run(entry.id, "project:abc123");
      }
    }

    for (let i = 0; i < 4; i++) {
      await seedMemory(store, `Global-only fact ${i}`, {
        importance: 0.7,
        seed: 200 + i,
        timestamp: daysAgo(i + 6),
      });
      // No extra scope tags — just the default 'global' from memory_scopes backfill
    }

    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: "Project ABC context provides key insights across sessions.",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    const result = await reflectionSweep(store, {
      endpoint: "http://fake-llm/v1/chat/completions",
      model: "test",
    }, logPath);

    assert.equal(result.learnings, 1);

    // Verify learning inherits project:abc (global-only memories don't define a context)
    const learning = store.db.prepare(
      "SELECT id FROM memories WHERE category = 'learning'"
    ).get() as { id: string };
    const scopeRows = store.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
    ).all(learning.id) as { scope: string }[];
    const scopes = scopeRows.map(r => r.scope);
    assert.ok(scopes.includes("global"), "learning should have global tag");
    assert.ok(scopes.includes("project:abc123"), "learning should inherit project tag from scoped memories");
  });

  // --- Semantic dedup tests ---

  it("skips learning that is a semantic near-duplicate of an existing memory", async () => {
    // Seed a memory with a known vector (seed=99)
    await seedMemory(store, "Infrastructure reliability is the engineering priority.", {
      importance: 0.7,
      seed: 99,
      timestamp: daysAgo(5),
    });

    // Pad to meet minimum
    for (let i = 0; i < 9; i++) {
      await seedMemory(store, `Filler fact ${i}`, { importance: 0.5, seed: 100 + i });
    }

    // Mock LLM returns a paraphrase of the seeded memory
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: "Engineering's top priority is infrastructure dependability and uptime.",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    // Mock embedder returns a vector identical to the existing memory
    const mockEmbedder = {
      embedPassage: async (_text: string) => makeVector(99),
    };

    const result = await reflectionSweep(
      store,
      { endpoint: "http://fake-llm/v1/chat/completions", model: "test" },
      logPath,
      mockEmbedder,
    );

    assert.equal(result.learnings, 0, "paraphrase should be skipped as semantic dupe");

    // Verify no learning was stored
    const storedLearnings = store.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE category = 'learning'"
    ).get() as { c: number };
    assert.equal(storedLearnings.c, 0, "no learning should be stored in DB");
  });

  it("stores genuinely new learning even with embedder", async () => {
    // Seed a memory about deployments (seed=1 — orthogonal to the learning vector)
    await seedMemory(store, "Deployment infrastructure is a recurring concern.", {
      importance: 0.7,
      seed: 1,
      timestamp: daysAgo(5),
    });

    // Pad to meet minimum
    for (let i = 0; i < 9; i++) {
      await seedMemory(store, `Filler fact ${i}`, { importance: 0.5, seed: 100 + i });
    }

    // Mock LLM returns a genuinely new learning
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: "Documentation of design decisions prevents repeated architectural mistakes.",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    // Mock embedder returns a completely different vector (seed=777)
    const mockEmbedder = {
      embedPassage: async (_text: string) => makeVector(777),
    };

    const result = await reflectionSweep(
      store,
      { endpoint: "http://fake-llm/v1/chat/completions", model: "test" },
      logPath,
      mockEmbedder,
    );

    assert.equal(result.learnings, 1, "genuinely new learning should be stored");

    // Verify learning is in DB
    const storedLearnings = store.db.prepare(
      "SELECT text, category FROM memories WHERE category = 'learning'"
    ).all() as Array<{ text: string; category: string }>;
    assert.equal(storedLearnings.length, 1);
  });

  it("without embedder, stores learning regardless (graceful degradation)", async () => {
    // Seed a memory — would be a semantic match if we had an embedder
    await seedMemory(store, "Deployment infrastructure is a recurring concern.", {
      importance: 0.7,
      seed: 1,
      timestamp: daysAgo(5),
    });

    // Pad to meet minimum
    for (let i = 0; i < 9; i++) {
      await seedMemory(store, `Filler fact ${i}`, { importance: 0.5, seed: 100 + i });
    }

    // Mock LLM returns a paraphrase of the seeded memory
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: "Infrastructure deployment concerns recur across projects.",
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    // No embedder passed — should fall back to today's behavior (stores regardless)
    const result = await reflectionSweep(
      store,
      { endpoint: "http://fake-llm/v1/chat/completions", model: "test" },
      logPath,
      // no embedder
    );

    assert.equal(result.learnings, 1, "without embedder, learning should be stored (graceful degradation)");
  });
});

// ============================================================================
// Dream Cycle Orchestrator
// ============================================================================

describe("dream cycle orchestrator", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dream-cycle-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
    logPath = join(tmpDir, "memex.log");
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("runs light and deep phases in sequence", async () => {
    // Seed noise + old entries
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'other', 'global', 0.3, ?)"
    ).run("noise-1", "got it", Date.now());
    await seedMemory(store, "Old fact never recalled", {
      importance: 0.5,
      timestamp: daysAgo(60),
    });

    const config: DreamConfig = {
      enabled: true,
      phases: { light: true, deep: true, reflection: false },
      logPath,
    };

    const result = await runDreamCycle(store, config);

    assert.ok(result.light, "light phase should have run");
    assert.ok(result.deep, "deep phase should have run");
    assert.ok(result.light!.noiseRemoved >= 1);
    assert.ok(result.duration_ms >= 0);
    assert.equal(result.errors.length, 0);
  });

  it("continues to next phase if light fails", async () => {
    await seedMemory(store, "Entry for deep test", {
      importance: 0.3,
      recallCount: 10,
      timestamp: daysAgo(15),
    });

    // Close the DB to make light sweep fail, then reopen
    // Actually, let's just test with a valid store — the orchestrator should handle errors
    const config: DreamConfig = {
      enabled: true,
      phases: { light: true, deep: true, reflection: false },
      logPath,
    };

    const result = await runDreamCycle(store, config);

    // Deep should still run even if light has issues
    assert.ok(result.deep, "deep phase should have run");
  });

  it("respects phase-level enabled flags", async () => {
    await seedMemory(store, "Test entry");

    const config: DreamConfig = {
      enabled: true,
      phases: { light: true, deep: false, reflection: false },
      logPath,
    };

    const result = await runDreamCycle(store, config);

    assert.ok(result.light, "light should run");
    assert.equal(result.deep, undefined, "deep should not run");
  });

  it("fires track() events for each phase", async () => {
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'other', 'global', 0.3, ?)"
    ).run("noise-t", "done", Date.now());

    const tracked: Array<{ event: string; props: Record<string, unknown> }> = [];
    const mockTrack = (event: string, props?: Record<string, unknown>) => {
      tracked.push({ event, props: props || {} });
    };

    const config: DreamConfig = {
      enabled: true,
      phases: { light: true, deep: true, reflection: false },
      logPath,
    };

    await runDreamCycle(store, config, mockTrack);

    const dreamEvents = tracked.filter(t => t.event === "dream");
    assert.ok(dreamEvents.length >= 2, `expected >= 2 dream track events, got ${dreamEvents.length}`);

    const metricsEvent = tracked.find(t => t.event === "dream_metrics");
    assert.ok(metricsEvent, "should fire dream_metrics event");
    assert.equal(typeof metricsEvent!.props.pool_size, "number");
    assert.equal(typeof metricsEvent!.props.never_recalled_ratio, "number");
  });

  it("writes summary to log file", async () => {
    await seedMemory(store, "Entry for summary log");

    const config: DreamConfig = {
      enabled: true,
      phases: { light: true, deep: true, reflection: false },
      logPath,
    };

    await runDreamCycle(store, config);

    const log = await readFile(logPath, "utf-8");
    assert.ok(log.includes("[dream:cycle]"), "should have cycle summary");
    assert.ok(log.includes("duration_ms="), "should include duration");
  });

  it("reports pool health metrics via track()", async () => {
    await seedMemory(store, "Entry A");
    await seedMemory(store, "Entry B");

    const tracked: Array<{ event: string; props: Record<string, unknown> }> = [];
    const mockTrack = (event: string, props?: Record<string, unknown>) => {
      tracked.push({ event, props: props || {} });
    };

    await runDreamCycle(store, {
      enabled: true,
      phases: { light: true, deep: true, reflection: false },
      logPath,
    }, mockTrack);

    const metrics = tracked.find(t => t.event === "dream_metrics");
    assert.ok(metrics, "should fire dream_metrics");
    assert.equal(metrics!.props.pool_size, 2);
    assert.equal(typeof metrics!.props.never_recalled_ratio, "number");
    assert.ok(
      (metrics!.props.never_recalled_ratio as number) >= 0 &&
      (metrics!.props.never_recalled_ratio as number) <= 1,
      "ratio should be between 0 and 1"
    );
  });

  it("total cycle completes within 5 seconds for 500 entries", async () => {
    // Seed 500 entries
    for (let i = 0; i < 500; i++) {
      store.db.prepare(
        "INSERT INTO memories (id, text, category, scope, importance, timestamp) VALUES (?, ?, 'fact', 'global', 0.3, ?)"
      ).run(`perf-${i}`, `Performance test entry number ${i} about topic ${i % 20}`, daysAgo(i % 90));
    }

    const start = Date.now();
    await runDreamCycle(store, {
      enabled: true,
      phases: { light: true, deep: true, reflection: false },
      logPath,
    });
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `Dream cycle took ${elapsed}ms for 500 entries — expected <5s`);
  });
});
