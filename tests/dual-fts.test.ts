/**
 * Tests for dual-granularity FTS: document_sections table + sections_fts index.
 *
 * Verifies the section FTS lifecycle: insert, deactivate, update documents
 * and ensure section rows are properly created/removed.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createStore,
  insertContent,
  insertDocument,
  deactivateDocument,
  updateDocument,
  findActiveDocument,
  splitSections,
  searchFTS,
} from "../src/search.ts";
import { createHash } from "node:crypto";

function md5(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

describe("dual-fts: section FTS lifecycle", () => {
  let tmpDir: string;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dual-fts-test-"));
    const dbFile = join(tmpDir, "test.sqlite");
    store = createStore(dbFile);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("insert doc creates document_sections rows", () => {
    const content = "# Introduction\n\nSome intro text here.\n\n## Methods\n\nDescription of methods used.\n\n## Results\n\nThe results are interesting.";
    const hash = md5(content);
    const now = new Date().toISOString();

    insertContent(store.db, hash, content, now);
    insertDocument(store.db, "col1", "doc.md", "Test Doc", hash, now, now);

    // Verify document_sections rows exist
    const sections = store.db.prepare(
      `SELECT * FROM document_sections ORDER BY section_idx`
    ).all() as any[];

    assert.ok(sections.length > 0, "should have at least one section row");

    // Verify sections_fts rows exist
    const ftsRows = store.db.prepare(
      `SELECT * FROM sections_fts`
    ).all() as any[];

    assert.ok(ftsRows.length > 0, "should have at least one FTS row");
    assert.equal(sections.length, ftsRows.length, "section rows should match FTS rows");
  });

  it("insert large doc, search for section-specific term finds it", () => {
    const content = [
      "# Alpha Section\n\nThis section discusses photosynthesis in great detail.",
      "## Beta Section\n\nThis section covers quantum entanglement phenomena.",
      "## Gamma Section\n\nThis section is about mitochondria and cellular respiration.",
    ].join("\n\n");
    const hash = md5(content);
    const now = new Date().toISOString();

    insertContent(store.db, hash, content, now);
    insertDocument(store.db, "col1", "science.md", "Science", hash, now, now);

    // Search sections_fts for a term only in one section
    const results = store.db.prepare(
      `SELECT filepath, heading, rank FROM sections_fts WHERE sections_fts MATCH 'quantum' ORDER BY rank`
    ).all() as any[];

    assert.ok(results.length > 0, "should find 'quantum' in section FTS");
    // The term 'quantum' should appear in a section whose body mentions it
    // (heading may vary due to section merging, so just verify we got a result)
    assert.ok(results[0].filepath === "col1/science.md", "should be from the correct file");
  });

  it("deactivate doc removes sections", () => {
    const content = "# Title\n\nSome content.\n\n## Another\n\nMore content.";
    const hash = md5(content);
    const now = new Date().toISOString();

    insertContent(store.db, hash, content, now);
    insertDocument(store.db, "col1", "remove-me.md", "Remove", hash, now, now);

    // Verify sections exist
    let sections = store.db.prepare(
      `SELECT COUNT(*) as cnt FROM document_sections`
    ).get() as any;
    assert.ok(sections.cnt > 0, "should have sections before deactivation");

    // Deactivate
    deactivateDocument(store.db, "col1", "remove-me.md");

    // Verify sections are gone
    sections = store.db.prepare(
      `SELECT COUNT(*) as cnt FROM document_sections`
    ).get() as any;
    assert.equal(sections.cnt, 0, "sections should be removed after deactivation");

    const ftsCount = store.db.prepare(
      `SELECT COUNT(*) as cnt FROM sections_fts`
    ).get() as any;
    assert.equal(ftsCount.cnt, 0, "FTS rows should be removed after deactivation");
  });

  it("update doc replaces sections", () => {
    const content1 = "# Old Title\n\nOld content about dinosaurs.";
    const hash1 = md5(content1);
    const now = new Date().toISOString();

    insertContent(store.db, hash1, content1, now);
    insertDocument(store.db, "col1", "evolving.md", "Evolving", hash1, now, now);

    // Find the doc id
    const doc = findActiveDocument(store.db, "col1", "evolving.md");
    assert.ok(doc, "document should exist");

    // Verify initial sections
    let ftsResults = store.db.prepare(
      `SELECT * FROM sections_fts WHERE sections_fts MATCH 'dinosaurs'`
    ).all() as any[];
    assert.ok(ftsResults.length > 0, "should find 'dinosaurs' before update");

    // Update with new content
    const content2 = "# New Title\n\nNew content about spaceships.\n\n## Launch\n\nLaunch details.";
    const hash2 = md5(content2);
    insertContent(store.db, hash2, content2, now);
    updateDocument(store.db, doc!.id, "Evolving v2", hash2, now);

    // Old term should be gone
    ftsResults = store.db.prepare(
      `SELECT * FROM sections_fts WHERE sections_fts MATCH 'dinosaurs'`
    ).all() as any[];
    assert.equal(ftsResults.length, 0, "'dinosaurs' should not be in sections FTS after update");

    // New term should be present
    ftsResults = store.db.prepare(
      `SELECT * FROM sections_fts WHERE sections_fts MATCH 'spaceships'`
    ).all() as any[];
    assert.ok(ftsResults.length > 0, "'spaceships' should be in sections FTS after update");
  });

  it("cross-section query: whole-doc FTS finds terms spanning sections", () => {
    // "photosynthesis" is in section 1, "entanglement" is in section 2
    // Each section must exceed minChars (200) to avoid merging
    const bioFiller = "Plants convert sunlight into chemical energy through complex biochemical pathways. This process involves chlorophyll molecules absorbing photons and driving electron transport chains across thylakoid membranes. ";
    const physicsFiller = "Particles can become correlated in ways that classical physics cannot explain. When measured, these correlated particles reveal statistical patterns that violate Bell inequalities conclusively. ";
    const content = `# Biology\n\nPhotosynthesis is the foundation of life on Earth. ${bioFiller}${bioFiller}\n\n## Physics\n\nQuantum entanglement connects distant particles. ${physicsFiller}${physicsFiller}`;
    const hash = md5(content);
    const now = new Date().toISOString();

    insertContent(store.db, hash, content, now);
    insertDocument(store.db, "col1", "cross.md", "Cross", hash, now, now);

    // Whole-doc FTS should find both terms in one document (AND = both required)
    const wholeDocResults = store.db.prepare(
      `SELECT filepath FROM documents_fts WHERE documents_fts MATCH 'photosynthesis AND entanglement'`
    ).all() as any[];
    assert.ok(
      wholeDocResults.length > 0,
      "whole-doc FTS should find document with terms spanning sections"
    );

    // Section FTS should NOT find both terms in a single section (use AND operator)
    const sectionResults = store.db.prepare(
      `SELECT filepath FROM sections_fts WHERE sections_fts MATCH 'photosynthesis AND entanglement'`
    ).all() as any[];
    assert.equal(
      sectionResults.length, 0,
      "section FTS should not find both terms in a single section"
    );
  });

  it("backfills sections on store creation when document_sections is empty", () => {
    // Insert docs via the store (which populates sections)
    const content1 = "# Heading One\n\nFirst section content with enough text to stand alone.\n\n# Heading Two\n\nSecond section content.";
    const hash1 = md5(content1);
    insertContent(store.db, hash1, content1, new Date().toISOString());
    insertDocument(store.db, "test-col", "backfill-doc.md", "Backfill Doc", hash1, new Date().toISOString(), new Date().toISOString());

    // Verify sections exist
    const beforeCount = (store.db.prepare(`SELECT COUNT(*) as c FROM document_sections`).get() as { c: number }).c;
    assert.ok(beforeCount > 0, "sections should exist after insert");

    // Clear sections tables (simulate pre-upgrade state)
    store.db.exec(`DELETE FROM sections_fts`);
    store.db.exec(`DELETE FROM document_sections`);
    const afterClear = (store.db.prepare(`SELECT COUNT(*) as c FROM document_sections`).get() as { c: number }).c;
    assert.equal(afterClear, 0, "sections should be cleared");

    // Re-create store (triggers initializeDatabase which backfills)
    const dbPath = store.dbPath;
    store.close();
    store = createStore(dbPath);

    // Verify backfill happened
    const backfillCount = (store.db.prepare(`SELECT COUNT(*) as c FROM document_sections`).get() as { c: number }).c;
    assert.ok(backfillCount > 0, "backfill should have populated sections");

    const ftsCount = (store.db.prepare(`SELECT COUNT(*) as c FROM sections_fts`).get() as { c: number }).c;
    assert.equal(ftsCount, backfillCount, "sections_fts should match document_sections count");
  });
});

describe("dual-fts: searchFTS() dual-granularity", () => {
  let tmpDir: string;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dual-fts-search-"));
    const dbFile = join(tmpDir, "test.sqlite");
    store = createStore(dbFile);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("section FTS boosts score for term concentrated in one section among filler", () => {
    // Build a large doc where "xylophone" appears only in one small section,
    // surrounded by lots of unrelated filler text.
    const fillerParagraph = "The quick brown fox jumps over the lazy dog. ".repeat(20) + "\n\n";
    const sections = [
      "# Overview\n\n" + fillerParagraph.repeat(3),
      "## Background\n\n" + fillerParagraph.repeat(3),
      "## Xylophone Details\n\nThe xylophone is a percussion instrument with wooden bars. Xylophone players use mallets to strike the bars and produce melodic tones.\n\n",
      "## Conclusion\n\n" + fillerParagraph.repeat(3),
    ];
    const content = sections.join("");
    const hash = md5(content);
    const now = new Date().toISOString();

    insertContent(store.db, hash, content, now);
    insertDocument(store.db, "col1", "instruments.md", "Instruments", hash, now, now);

    const results = searchFTS(store.db, "xylophone", 10);

    assert.ok(results.length > 0, "should find at least one result for 'xylophone'");
    assert.ok(results[0]!.score > 0, "score should be positive");
    assert.ok(results[0]!.score <= 1, "score should be <= 1");

    // Section FTS should win and provide chunkPos since the term is concentrated
    // in one section (high BM25) vs diluted across the whole doc (lower BM25).
    assert.ok(results[0]!.chunkPos != null, "chunkPos should be populated from section FTS");
    assert.ok(results[0]!.chunkPos! > 0, "chunkPos should point into the document body");
  });

  it("searchFTS() returns scores in [0,1] range", () => {
    const content = "# API Reference\n\nThe frobnicate function processes widgets.\n\n## Parameters\n\nAccepts a widget ID and options object.";
    const hash = md5(content);
    const now = new Date().toISOString();

    insertContent(store.db, hash, content, now);
    insertDocument(store.db, "col1", "api.md", "API Ref", hash, now, now);

    const results = searchFTS(store.db, "frobnicate widget", 10);

    assert.ok(results.length > 0, "should find results");
    for (const r of results) {
      assert.ok(r.score >= 0, `score ${r.score} should be >= 0`);
      assert.ok(r.score <= 1, `score ${r.score} should be <= 1`);
    }
  });

  it("searchFTS() deduplicates results across whole-doc and section queries", () => {
    const content = "# Title\n\nSome unique content about algorithms.\n\n## Details\n\nMore about algorithms and data structures.";
    const hash = md5(content);
    const now = new Date().toISOString();

    insertContent(store.db, hash, content, now);
    insertDocument(store.db, "col1", "algo.md", "Algo", hash, now, now);

    const results = searchFTS(store.db, "algorithms", 10);

    // Should have exactly one result (deduplicated by filepath)
    const filepaths = results.map(r => r.filepath);
    const uniqueFilepaths = new Set(filepaths);
    assert.equal(filepaths.length, uniqueFilepaths.size, "no duplicate filepaths in results");
  });
});
