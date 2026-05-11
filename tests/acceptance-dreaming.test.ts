/**
 * Acceptance tests for memex dreaming.
 *
 * These verify end-to-end outcomes, not individual functions.
 * Each test seeds a realistic dataset, runs the dream cycle,
 * and asserts measurable quality improvements.
 *
 * Acceptance criteria:
 * 1. Conversation fragments ([user]/[assistant]) are eliminated (0 remaining)
 * 2. Exact text duplicates are eliminated (0 remaining)
 * 3. Noise entries (greetings, fillers) are eliminated (0 remaining)
 * 4. Frequently recalled entries have importance >= 0.7
 * 5. Old never-recalled entries have importance <= 0.3
 * 6. Ephemeral action logs older than 30d have importance <= 0.1
 * 7. Pool health ratio (never_recalled / total) decreases after deep sweep
 * 8. Dream cycle completes without errors
 * 9. Dream cycle is idempotent (second run changes nothing)
 * 10. High-quality agent-stored entries are never deleted
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { MemoryStore } from "../src/memory.js";
import { runDreamCycle, type DreamConfig } from "../src/dreaming.js";

const VECTOR_DIM = 8;
function makeVector(seed: number): number[] {
  const v = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}
const daysAgo = (d: number) => Date.now() - d * 86400_000;

/**
 * Seed a realistic memory pool that mirrors the actual production DB:
 * - 20 agent-stored high-quality entries (importance 0.7-0.95)
 * - 100 session-import entries (importance 0.3, mixed quality)
 * - 15 conversation fragments ([user]/[assistant] prefix)
 * - 5 exact duplicates
 * - 10 noise entries (greetings, fillers)
 * - 8 ephemeral action logs (>30 days old)
 * - 5 frequently recalled entries (recall_count >= 5)
 */
async function seedRealisticPool(store: MemoryStore) {
  const db = store.db;
  const insert = db.prepare(
    "INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash, recall_count, last_recalled_at) " +
    "VALUES (?, ?, ?, 'global', ?, ?, ?, ?, ?, ?)"
  );

  const hash = (t: string) => createHash("sha256").update(t.trim()).digest("hex");
  let id = 0;
  const nextId = () => `test-${String(++id).padStart(4, "0")}`;

  // Agent-stored high quality (20)
  const agentStored: string[] = [];
  for (let i = 0; i < 20; i++) {
    const text = `2026-04-0${i % 9 + 1}: Important preference or fact number ${i} about system config.`;
    const eid = nextId();
    agentStored.push(eid);
    insert.run(eid, text, "preference", 0.7 + (i % 6) * 0.05, daysAgo(i), JSON.stringify({ source: "agent" }), hash(text), i < 5 ? 5 + i : 0, i < 5 ? daysAgo(1) : null);
  }

  // Session import mixed quality (100)
  for (let i = 0; i < 100; i++) {
    const text = `Session import fact ${i}: configuration detail about service ${i % 15}.`;
    insert.run(nextId(), text, "fact", 0.3, daysAgo(20 + i % 60), JSON.stringify({ source: "session-import" }), hash(text), 0, null);
  }

  // Conversation fragments (15)
  for (let i = 0; i < 15; i++) {
    const text = i % 2 === 0
      ? `[assistant] I'll check that now. Let me look at the config.`
      : `[user] ok sounds good`;
    insert.run(nextId(), text + ` variation-${i}`, "preference", 0.6, daysAgo(10 + i), null, hash(text + ` variation-${i}`), 0, null);
  }

  // Exact duplicates (5 copies of same text)
  const dupeText = "Duplicate fact that got imported multiple times from sessions.";
  for (let i = 0; i < 5; i++) {
    insert.run(nextId(), dupeText, "fact", 0.3, daysAgo(25 - i), null, `dupe-hash-${i}`, 0, null);
  }

  // Noise (10)
  const noiseTexts = ["got it", "done", "ok", "sure", "right", "yep", "nice", "cool", "perfect", "hi there"];
  for (const text of noiseTexts) {
    insert.run(nextId(), text, "other", 0.3, daysAgo(15), null, hash(text + Math.random()), 0, null);
  }

  // Ephemeral action logs >30d (8)
  const actions = [
    "The webhook was deleted.",
    "Config was pushed to git.",
    "The service was deployed.",
    "The secret was rotated.",
    "The branch was merged.",
    "The DNS record was created.",
    "The PVC was updated.",
    "The image was removed.",
  ];
  for (const text of actions) {
    insert.run(nextId(), text, "fact", 0.3, daysAgo(45), null, hash(text), 0, null);
  }

  // Insert vectors for all (required for sqlite-vec)
  if (store.hasVectorSupport) {
    const allIds = db.prepare("SELECT id FROM memories").all() as { id: string }[];
    const vecInsert = db.prepare("INSERT OR IGNORE INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)");
    const mapInsert = db.prepare("INSERT OR IGNORE INTO memory_vectors (memory_id, embedded_at) VALUES (?, ?)");
    for (const { id: mid } of allIds) {
      try {
        vecInsert.run(`mem_${mid}`, new Float32Array(makeVector(mid.length)));
        mapInsert.run(mid, new Date().toISOString());
      } catch { /* ignore dupes */ }
    }
  }

  return { agentStored, totalSeeded: id };
}

describe("dreaming acceptance criteria", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let logPath: string;
  let config: DreamConfig;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "dream-accept-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
    logPath = join(tmpDir, "memex.log");
    config = { enabled: true, phases: { light: true, deep: true, reflection: false }, logPath };
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("AC1: conversation fragments are eliminated after dream cycle", async () => {
    await seedRealisticPool(store);

    const before = (store.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE text LIKE '[assistant]%' OR text LIKE '[user]%'"
    ).get() as { c: number }).c;
    assert.ok(before > 0, "should have fragments before dreaming");

    await runDreamCycle(store, config);

    const after = (store.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE text LIKE '[assistant]%' OR text LIKE '[user]%'"
    ).get() as { c: number }).c;
    assert.equal(after, 0, "all conversation fragments should be removed");
  });

  it("AC2: exact text duplicates are eliminated after dream cycle", async () => {
    await seedRealisticPool(store);

    const before = (store.db.prepare(
      "SELECT COUNT(*) as c FROM (SELECT text, COUNT(*) as cnt FROM memories GROUP BY text HAVING cnt > 1)"
    ).get() as { c: number }).c;
    assert.ok(before > 0, "should have duplicates before dreaming");

    await runDreamCycle(store, config);

    const after = (store.db.prepare(
      "SELECT COUNT(*) as c FROM (SELECT text, COUNT(*) as cnt FROM memories GROUP BY text HAVING cnt > 1)"
    ).get() as { c: number }).c;
    assert.equal(after, 0, "all duplicates should be removed");
  });

  it("AC3: noise entries are eliminated after dream cycle", async () => {
    await seedRealisticPool(store);
    await runDreamCycle(store, config);

    // Check for common noise patterns
    const noise = store.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE text IN ('got it', 'done', 'ok', 'sure', 'right', 'yep', 'nice', 'cool', 'perfect')"
    ).get() as { c: number };
    assert.equal(noise.c, 0, "noise entries should be removed");
  });

  it("AC4: frequently recalled entries have importance >= 0.7", async () => {
    await seedRealisticPool(store);
    await runDreamCycle(store, config);

    const lowRecalled = store.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE recall_count >= 5 AND importance < 0.7"
    ).get() as { c: number };
    assert.equal(lowRecalled.c, 0, "all entries with 5+ recalls should have importance >= 0.7");
  });

  it("AC5: old never-recalled entries have decayed importance", async () => {
    await seedRealisticPool(store);
    await runDreamCycle(store, config);

    const old30d = store.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE (recall_count IS NULL OR recall_count = 0) AND timestamp < ? AND importance > 0.3"
    ).get(daysAgo(30)) as { c: number };
    assert.equal(old30d.c, 0, "old never-recalled entries (>30d) should have importance <= 0.3");
  });

  it("AC6: ephemeral action logs older than 30d have importance <= 0.1", async () => {
    await seedRealisticPool(store);
    await runDreamCycle(store, config);

    const staleActions = store.db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE importance > 0.1 AND timestamp < ? AND (text LIKE '%was deleted%' OR text LIKE '%was pushed%' OR text LIKE '%was deployed%' OR text LIKE '%was created%' OR text LIKE '%was updated%' OR text LIKE '%was removed%' OR text LIKE '%was merged%' OR text LIKE '%was rotated%')"
    ).get(daysAgo(30)) as { c: number };
    assert.equal(staleActions.c, 0, "stale action logs should have importance <= 0.1");
  });

  it("AC7: pool health improves after dreaming", async () => {
    await seedRealisticPool(store);

    const beforeTotal = store.totalMemories;

    const tracked: Array<{ event: string; props: Record<string, unknown> }> = [];
    await runDreamCycle(store, config, (e, p) => tracked.push({ event: e, props: p || {} }));

    const afterTotal = store.totalMemories;

    // Pool should shrink (noise + fragments + dupes removed)
    assert.ok(afterTotal < beforeTotal, `pool should shrink: ${beforeTotal} → ${afterTotal}`);

    // Metrics event should report
    const metrics = tracked.find(t => t.event === "dream_metrics");
    assert.ok(metrics, "should fire dream_metrics");
    assert.ok((metrics!.props.pool_size as number) < beforeTotal);
  });

  it("AC8: dream cycle completes without errors", async () => {
    await seedRealisticPool(store);
    const result = await runDreamCycle(store, config);
    assert.equal(result.errors.length, 0, `expected no errors, got: ${result.errors.join("; ")}`);
  });

  it("AC9: dream cycle is idempotent — second run changes nothing", async () => {
    await seedRealisticPool(store);

    await runDreamCycle(store, config);
    const countAfterFirst = store.totalMemories;
    const importancesFirst = store.db.prepare("SELECT importance FROM memories ORDER BY id").all();

    await runDreamCycle(store, config);
    const countAfterSecond = store.totalMemories;
    const importancesSecond = store.db.prepare("SELECT importance FROM memories ORDER BY id").all();

    assert.equal(countAfterFirst, countAfterSecond, "entry count should not change on second run");
    assert.deepEqual(importancesFirst, importancesSecond, "importances should not change on second run");
  });

  it("AC10: high-quality agent-stored entries are never deleted", async () => {
    const { agentStored } = await seedRealisticPool(store);
    await runDreamCycle(store, config);

    for (const id of agentStored) {
      const row = store.db.prepare("SELECT id FROM memories WHERE id = ?").get(id);
      assert.ok(row, `agent-stored entry ${id} should survive dreaming`);
    }
  });
});
