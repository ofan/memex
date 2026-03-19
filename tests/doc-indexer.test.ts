/**
 * Tests for src/doc-indexer.ts
 *
 * Uses a real SQLite database (via QMD store) with a temp directory
 * for isolated, repeatable tests.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexPath, indexAllPaths, getEmbeddingBacklog } from "../src/doc-indexer.js";
import { createStore } from "../src/search.js";

describe("doc-indexer", () => {
  let tmpDir: string;
  let docsDir: string;
  let store: ReturnType<typeof createStore>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "docidx-test-"));
    docsDir = join(tmpDir, "docs");
    await mkdir(docsDir, { recursive: true });

    const dbFile = join(tmpDir, "qmd.sqlite");
    store = createStore(dbFile);
    store.ensureVecTable(1024);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  describe("indexPath", () => {
    it("indexes markdown files", async () => {
      await writeFile(join(docsDir, "hello.md"), "# Hello\n\nThis is a test document.");
      await writeFile(join(docsDir, "world.md"), "# World\n\nAnother document.");

      const result = await indexPath(store.db, {
        path: docsDir,
        name: "test-collection",
        pattern: "**/*.md",
      });

      assert.equal(result.indexed, 2);
      assert.equal(result.updated, 0);
      assert.equal(result.unchanged, 0);
      assert.equal(result.removed, 0);
      assert.equal(result.errors.length, 0);
    });

    it("detects unchanged files on re-index", async () => {
      await writeFile(join(docsDir, "stable.md"), "# Stable\n\nContent that doesn't change.");

      await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.md" });
      const result = await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.md" });

      assert.equal(result.indexed, 0);
      assert.equal(result.unchanged, 1);
    });

    it("detects updated files", async () => {
      await writeFile(join(docsDir, "changing.md"), "# Version 1\n\nOriginal content.");
      await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.md" });

      // Modify the file
      await writeFile(join(docsDir, "changing.md"), "# Version 2\n\nUpdated content.");
      const result = await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.md" });

      assert.equal(result.updated, 1);
      assert.equal(result.indexed, 0);
    });

    it("detects removed files", async () => {
      await writeFile(join(docsDir, "temporary.md"), "# Temp\n\nWill be removed.");
      await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.md" });

      // Remove the file
      await rm(join(docsDir, "temporary.md"));
      const result = await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.md" });

      assert.equal(result.removed, 1);
    });

    it("skips empty files", async () => {
      await writeFile(join(docsDir, "empty.md"), "");
      await writeFile(join(docsDir, "real.md"), "# Real\n\nHas content.");

      const result = await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.md" });

      assert.equal(result.indexed, 1);
    });

    it("handles nested directories", async () => {
      await mkdir(join(docsDir, "sub"), { recursive: true });
      await writeFile(join(docsDir, "top.md"), "# Top Level");
      await writeFile(join(docsDir, "sub", "nested.md"), "# Nested");

      const result = await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.md" });

      assert.equal(result.indexed, 2);
    });

    it("respects custom glob patterns", async () => {
      await writeFile(join(docsDir, "readme.md"), "# README");
      await writeFile(join(docsDir, "code.ts"), "const x = 1;");

      const result = await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.ts" });

      assert.equal(result.indexed, 1); // Only the .ts file
    });

    it("excludes node_modules", async () => {
      await mkdir(join(docsDir, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(docsDir, "node_modules", "pkg", "readme.md"), "# Package");
      await writeFile(join(docsDir, "real.md"), "# Real");

      const result = await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.md" });

      assert.equal(result.indexed, 1); // Only real.md
    });

    it("returns errors for invalid paths", async () => {
      const result = await indexPath(store.db, {
        path: "/nonexistent/path",
        name: "bad",
        pattern: "**/*.md",
      });

      // fastGlob returns empty for nonexistent paths
      assert.equal(result.indexed, 0);
    });
  });

  describe("indexAllPaths", () => {
    it("indexes multiple paths", async () => {
      const dir2 = join(tmpDir, "docs2");
      await mkdir(dir2, { recursive: true });
      await writeFile(join(docsDir, "a.md"), "# Doc A");
      await writeFile(join(dir2, "b.md"), "# Doc B");

      const results = await indexAllPaths(store.db, [
        { path: docsDir, name: "collection1" },
        { path: dir2, name: "collection2" },
      ]);

      assert.equal(results.length, 2);
      assert.equal(results[0].indexed, 1);
      assert.equal(results[1].indexed, 1);
    });
  });

  describe("getEmbeddingBacklog", () => {
    it("reports pending embeddings after indexing", async () => {
      await writeFile(join(docsDir, "doc.md"), "# Document\n\nNeeds embedding.");
      await indexPath(store.db, { path: docsDir, name: "test", pattern: "**/*.md" });

      const backlog = getEmbeddingBacklog(store.db);
      assert.ok(backlog >= 1);
    });

    it("reports zero for empty database", () => {
      const backlog = getEmbeddingBacklog(store.db);
      assert.equal(backlog, 0);
    });
  });
});
