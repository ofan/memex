/**
 * Tests for intake guards — prevent garbage from entering the memory store.
 *
 * A1: Text hash dedup (exact duplicate rejection on store/bulkStore)
 * A2: Conversation fragment rejection ([user]/[assistant] prefix)
 * A3: Noise filter on session import path
 *
 * These guards run at write time with zero config. Always on.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";

const VECTOR_DIM = 8;

function makeVector(seed: number): number[] {
  const v = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

describe("intake guards", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "intake-guard-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  // ========================================================================
  // A1: Text hash dedup
  // ========================================================================

  describe("text hash dedup", () => {
    it("rejects exact duplicate text on store()", async () => {
      const entry1 = await store.store({
        text: "User prefers dark mode",
        vector: makeVector(1),
        category: "preference",
        scope: "global",
        importance: 0.8,
      });

      const entry2 = await store.store({
        text: "User prefers dark mode",
        vector: makeVector(2), // different vector, same text
        category: "preference",
        scope: "global",
        importance: 0.9,
      });

      // Second store should return null (rejected)
      assert.equal(entry2, null, "duplicate text should be rejected");
      assert.equal(store.totalMemories, 1, "only 1 entry in DB");
    });

    it("allows different text with same semantic meaning", async () => {
      await store.store({
        text: "User prefers dark mode",
        vector: makeVector(1),
        category: "preference",
        scope: "global",
        importance: 0.8,
      });

      const entry2 = await store.store({
        text: "Dark mode is the user's preference",
        vector: makeVector(2),
        category: "preference",
        scope: "global",
        importance: 0.8,
      });

      assert.ok(entry2, "different text should be accepted");
      assert.equal(store.totalMemories, 2);
    });

    it("rejects duplicates in bulkStore()", async () => {
      const entries = [
        { text: "Fact A", vector: makeVector(1), category: "fact" as const, scope: "global", importance: 0.5 },
        { text: "Fact B", vector: makeVector(2), category: "fact" as const, scope: "global", importance: 0.5 },
        { text: "Fact A", vector: makeVector(3), category: "fact" as const, scope: "global", importance: 0.6 }, // duplicate
        { text: "Fact C", vector: makeVector(4), category: "fact" as const, scope: "global", importance: 0.5 },
        { text: "Fact B", vector: makeVector(5), category: "fact" as const, scope: "global", importance: 0.7 }, // duplicate
      ];

      const stored = await store.bulkStore(entries);

      assert.equal(stored.length, 3, "only 3 unique entries stored");
      assert.equal(store.totalMemories, 3);
    });

    it("dedup is case-sensitive (different case = different text)", async () => {
      await store.store({
        text: "User prefers dark mode",
        vector: makeVector(1),
        category: "preference",
        scope: "global",
        importance: 0.8,
      });

      const entry2 = await store.store({
        text: "user prefers dark mode", // lowercase
        vector: makeVector(2),
        category: "preference",
        scope: "global",
        importance: 0.8,
      });

      // Case-sensitive: these are different strings
      assert.ok(entry2, "different case should be accepted");
      assert.equal(store.totalMemories, 2);
    });

    it("dedup ignores leading/trailing whitespace", async () => {
      await store.store({
        text: "User prefers dark mode",
        vector: makeVector(1),
        category: "preference",
        scope: "global",
        importance: 0.8,
      });

      const entry2 = await store.store({
        text: "  User prefers dark mode  ", // whitespace
        vector: makeVector(2),
        category: "preference",
        scope: "global",
        importance: 0.8,
      });

      assert.equal(entry2, null, "whitespace-padded duplicate should be rejected");
      assert.equal(store.totalMemories, 1);
    });
  });

  // ========================================================================
  // A2: Conversation fragment rejection
  // ========================================================================

  describe("conversation fragment rejection", () => {
    it("rejects entries starting with [assistant]", async () => {
      const entry = await store.store({
        text: "[assistant] yo — I'm back on the new config.",
        vector: makeVector(1),
        category: "fact",
        scope: "global",
        importance: 0.6,
      });

      assert.equal(entry, null, "conversation fragment should be rejected");
      assert.equal(store.totalMemories, 0);
    });

    it("rejects single-turn entries starting with [user]", async () => {
      const entry = await store.store({
        text: "[user] ok sure let's do that",
        vector: makeVector(1),
        category: "preference",
        scope: "global",
        importance: 0.6,
      });

      assert.equal(entry, null);
      assert.equal(store.totalMemories, 0);
    });

    it("allows multi-turn capture windows with [user]/[assistant] prefix", async () => {
      const entry = await store.store({
        text: "[user] I prefer dark mode\n[assistant] Got it.\n[user] Also use vim keybindings\n[assistant] Noted.",
        vector: makeVector(1),
        category: "preference",
        scope: "global",
        importance: 0.6,
      });

      assert.ok(entry, "multi-turn window should be accepted");
      assert.equal(store.totalMemories, 1);
    });

    it("allows entries that mention [assistant] mid-text", async () => {
      const entry = await store.store({
        text: "The [assistant] role should always verify facts before stating them.",
        vector: makeVector(1),
        category: "preference",
        scope: "global",
        importance: 0.7,
      });

      assert.ok(entry, "mid-text mention should be accepted");
      assert.equal(store.totalMemories, 1);
    });

    it("rejects fragments in bulkStore()", async () => {
      const entries = [
        { text: "Valid fact about deployment", vector: makeVector(1), category: "fact" as const, scope: "global", importance: 0.5 },
        { text: "[assistant] I did — T308 is running right now.", vector: makeVector(2), category: "fact" as const, scope: "global", importance: 0.6 },
        { text: "Another valid fact", vector: makeVector(3), category: "fact" as const, scope: "global", importance: 0.5 },
        { text: "[user] give me a diff", vector: makeVector(4), category: "preference" as const, scope: "global", importance: 0.6 },
      ];

      const stored = await store.bulkStore(entries);

      assert.equal(stored.length, 2, "only 2 valid entries stored");
      assert.equal(store.totalMemories, 2);
    });
  });

  // ========================================================================
  // A3: Schema — text_hash column exists
  // ========================================================================

  describe("schema", () => {
    it("memories table has text_hash column after init", () => {
      const cols = store.db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
      const colNames = cols.map(c => c.name);
      assert.ok(colNames.includes("text_hash"), "text_hash column should exist");
    });

    it("memories table has recall_count column after init", () => {
      const cols = store.db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
      const colNames = cols.map(c => c.name);
      assert.ok(colNames.includes("recall_count"), "recall_count column should exist");
    });

    it("memories table has last_recalled_at column after init", () => {
      const cols = store.db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
      const colNames = cols.map(c => c.name);
      assert.ok(colNames.includes("last_recalled_at"), "last_recalled_at column should exist");
    });

    it("text_hash is populated on store()", async () => {
      const entry = await store.store({
        text: "Test entry for hash",
        vector: makeVector(1),
        category: "fact",
        scope: "global",
        importance: 0.5,
      });

      const row = store.db.prepare("SELECT text_hash FROM memories WHERE id = ?").get(entry!.id) as { text_hash: string };
      assert.ok(row.text_hash, "text_hash should be populated");
      assert.equal(typeof row.text_hash, "string");
      assert.ok(row.text_hash.length > 10, "text_hash should be a real hash");
    });

    it("text_hash is consistent for same text", async () => {
      // Store one, check hash, then verify a second attempt would produce same hash
      const entry = await store.store({
        text: "Consistent hash test",
        vector: makeVector(1),
        category: "fact",
        scope: "global",
        importance: 0.5,
      });

      const row = store.db.prepare("SELECT text_hash FROM memories WHERE id = ?").get(entry!.id) as { text_hash: string };

      // Compute hash manually for same text
      const { createHash } = await import("node:crypto");
      const expected = createHash("sha256").update("Consistent hash test").digest("hex");
      assert.equal(row.text_hash, expected);
    });
  });
});
