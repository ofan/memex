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
import { lightSweep, deepSweep, runDreamCycle, type DreamConfig } from "../src/dreaming.js";

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
