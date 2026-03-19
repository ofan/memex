import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitSections, CHUNK_SIZE_CHARS } from "../src/search.ts";

describe("splitSections", () => {
  it("returns empty array for empty string", () => {
    const result = splitSections("");
    assert.deepStrictEqual(result, []);
  });

  it("returns single section with headingLevel 0 for doc with no headings", () => {
    const content = "This is a plain document with no headings.\n\nIt has multiple paragraphs.";
    const result = splitSections(content);
    assert.equal(result.length, 1);
    assert.equal(result[0].headingLevel, 0);
    assert.equal(result[0].heading, "");
    assert.equal(result[0].text, content);
    assert.equal(result[0].charPos, 0);
  });

  it("splits doc with H1, H2, H3 into 4 sections (preamble + 3)", () => {
    const content = [
      "Preamble text here with enough content to avoid being merged. ".repeat(5),
      "",
      "# Heading 1",
      "Content under H1 that is long enough to stand on its own as a section. ".repeat(4),
      "",
      "## Heading 2",
      "Content under H2 that is also sufficiently long to be its own section. ".repeat(4),
      "",
      "### Heading 3",
      "Content under H3 that has enough text to not be considered tiny at all. ".repeat(4),
    ].join("\n");

    const result = splitSections(content);
    assert.equal(result.length, 4);

    assert.equal(result[0].headingLevel, 0);
    assert.equal(result[0].heading, "");
    assert.ok(result[0].text.includes("Preamble text here"));

    assert.equal(result[1].headingLevel, 1);
    assert.equal(result[1].heading, "Heading 1");
    assert.ok(result[1].text.includes("Content under H1"));

    assert.equal(result[2].headingLevel, 2);
    assert.equal(result[2].heading, "Heading 2");
    assert.ok(result[2].text.includes("Content under H2"));

    assert.equal(result[3].headingLevel, 3);
    assert.equal(result[3].heading, "Heading 3");
    assert.ok(result[3].text.includes("Content under H3"));
  });

  it("does not split on H4+ when maxLevel=3", () => {
    const content = [
      "# Top Level",
      "Some content.",
      "",
      "#### Deep Heading",
      "This should NOT create a new section.",
      "",
      "##### Even Deeper",
      "Also not split.",
    ].join("\n");

    const result = splitSections(content);
    // Should be just 1 section (the H1 section containing H4 and H5 inline)
    assert.equal(result.length, 1);
    assert.equal(result[0].heading, "Top Level");
    assert.ok(result[0].text.includes("#### Deep Heading"));
    assert.ok(result[0].text.includes("##### Even Deeper"));
  });

  it("does not split on headings inside code fences", () => {
    const content = [
      "Intro text with enough content to not be merged away as tiny. ".repeat(5),
      "",
      "```markdown",
      "# This Is Code",
      "## Also Code",
      "```",
      "",
      "# Real Heading",
      "Content after code fence with enough text to stand on its own. ".repeat(5),
    ].join("\n");

    const result = splitSections(content);
    assert.equal(result.length, 2);
    assert.equal(result[0].headingLevel, 0);
    assert.ok(result[0].text.includes("# This Is Code"));
    assert.equal(result[1].heading, "Real Heading");
  });

  it("merges tiny sections (<200 chars) with neighbor", () => {
    const content = [
      "# Big Section",
      "A".repeat(300),
      "",
      "# Tiny",
      "x",
      "",
      "# Another Big Section",
      "B".repeat(300),
    ].join("\n");

    const result = splitSections(content);
    // "# Tiny\nx\n" is < 200 chars, should be merged with previous
    assert.ok(result.length < 3, `Expected fewer than 3 sections due to merge, got ${result.length}`);
    // The tiny section content should exist somewhere in the results
    const allText = result.map(s => s.text).join("");
    assert.ok(allText.includes("x\n"));
  });

  it("sub-chunks oversized sections (>maxChars)", () => {
    const longContent = "Word ".repeat(2000); // ~10000 chars >> 3600
    const content = [
      "# Big Section",
      longContent,
    ].join("\n");

    const result = splitSections(content);
    assert.ok(result.length > 1, `Expected multiple chunks for oversized section, got ${result.length}`);
    // All sub-chunks should inherit the heading
    for (const section of result) {
      assert.equal(section.heading, "Big Section");
      assert.equal(section.headingLevel, 1);
    }
  });

  it("charPos accurately maps back to original document", () => {
    const content = [
      "Preamble text that is long enough to not be considered tiny. ".repeat(5),
      "",
      "# Section One",
      "Content for section one that is also long enough. ".repeat(5),
      "",
      "## Section Two",
      "Content for section two that is sufficiently long. ".repeat(5),
    ].join("\n");

    const result = splitSections(content);
    for (const section of result) {
      // The text at charPos in the original should match the start of section.text
      const sliced = content.slice(section.charPos, section.charPos + section.text.length);
      assert.equal(sliced, section.text,
        `charPos ${section.charPos} doesn't match for section "${section.heading}"`);
    }
  });

  it("handles doc starting with heading (no preamble)", () => {
    const content = [
      "# First Heading",
      "Content under first heading is long enough to not be tiny. ".repeat(5),
      "",
      "## Second Heading",
      "Content under second heading is also long enough. ".repeat(5),
    ].join("\n");

    const result = splitSections(content);
    assert.ok(result.length >= 2);
    assert.equal(result[0].headingLevel, 1);
    assert.equal(result[0].heading, "First Heading");
    assert.equal(result[0].charPos, 0);
  });

  it("respects custom maxLevel option", () => {
    const content = [
      "Preamble. ".repeat(30),
      "",
      "# H1 Section",
      "Content. ".repeat(30),
      "",
      "## H2 Section",
      "More content. ".repeat(30),
    ].join("\n");

    const result = splitSections(content, { maxLevel: 1 });
    // Should only split on H1, not H2
    assert.equal(result.length, 2); // preamble + H1 (H2 stays inside H1)
    assert.ok(result[1].text.includes("## H2 Section"));
  });

  it("sub-chunks with custom maxChars", () => {
    const content = "# Section\n" + "Hello world. ".repeat(100); // ~1300 chars
    const result = splitSections(content, { maxChars: 500 });
    assert.ok(result.length > 1, `Expected sub-chunking at 500 chars, got ${result.length} section(s)`);
  });

  it("charPos remains accurate after merge pass", () => {
    const content = [
      "# Big Section",
      "A".repeat(300),
      "",
      "# Tiny",
      "x",
      "",
      "# Another Big Section",
      "B".repeat(300),
    ].join("\n");

    const result = splitSections(content);
    for (const section of result) {
      const sliced = content.slice(section.charPos, section.charPos + section.text.length);
      assert.equal(sliced, section.text,
        `charPos ${section.charPos} doesn't match for section "${section.heading}"`);
    }
  });

  it("merges all-tiny sections into one (cascading merges)", () => {
    const content = [
      "# A",
      "Short.",
      "",
      "# B",
      "Also short.",
      "",
      "# C",
      "Tiny too.",
    ].join("\n");

    const result = splitSections(content);
    assert.equal(result.length, 1, `Expected 1 merged section, got ${result.length}`);
    // The single section should contain all content
    assert.ok(result[0].text.includes("Short."));
    assert.ok(result[0].text.includes("Also short."));
    assert.ok(result[0].text.includes("Tiny too."));
    // charPos should still be accurate
    const sliced = content.slice(result[0].charPos, result[0].charPos + result[0].text.length);
    assert.equal(sliced, result[0].text, "charPos doesn't match for merged section");
  });

  // =========================================================================
  // Bullet-level splitting for dense multi-topic sections
  // =========================================================================

  it("splits dense bullet-list sections into individual entries", () => {
    const content = [
      "## Conventions",
      "- **Preferred editor:** VS Code (with Vim keybindings)",
      "- **Weekly budget:** $200/week",
      "- **Chat channel:** #general 12345",
      "- **Sync interval:** 30s",
    ].join("\n");

    const result = splitSections(content);
    // Should have more than 1 section — bullets split out
    assert.ok(result.length > 1, `Expected bullet splitting, got ${result.length} section(s)`);
    // Each bullet section should contain its bullet text
    const texts = result.map(s => s.text);
    assert.ok(texts.some(t => t.includes("VS Code")), "Should have a section with VS Code");
    assert.ok(texts.some(t => t.includes("Weekly budget")), "Should have a section with Weekly budget");
  });

  it("does not split sections with fewer than 3 bullets", () => {
    const content = [
      "## Short List",
      "- Item one with some extra text to avoid tiny merge",
      "- Item two with some extra text to avoid tiny merge",
    ].join("\n");

    const result = splitSections(content);
    // 2 bullets is not "dense" — should stay as one section
    assert.equal(result.length, 1);
  });

  it("preserves parent heading on bullet-split entries", () => {
    const content = [
      "## Conventions",
      "- **Preferred editor:** VS Code (with Vim keybindings)",
      "- **Weekly budget:** $200/week",
      "- **Chat channel:** #general 12345",
    ].join("\n");

    const result = splitSections(content);
    // All entries should inherit the "Conventions" heading
    for (const section of result) {
      assert.equal(section.heading, "Conventions", `Section should inherit heading, got "${section.heading}"`);
    }
  });

  it("merges tiny bullets with neighbors", () => {
    const content = [
      "## Config",
      "- a",
      "- b",
      "- c",
      "- d",
      "- e",
    ].join("\n");

    const result = splitSections(content);
    // All bullets are tiny — should be merged together, not 5 separate entries
    assert.ok(result.length < 5, `Tiny bullets should merge, got ${result.length}`);
  });

  it("charPos accuracy for bullet-split entries", () => {
    const content = [
      "## Conventions",
      "- **Preferred editor:** VS Code (with Vim keybindings) and some extra padding text here",
      "- **Weekly budget:** $200/week and some extra padding text to be long enough",
      "- **Chat channel:** #general 12345 padding padding padding text",
      "- **Sync interval:** 30s and some extra padding text to be long enough",
    ].join("\n");

    const result = splitSections(content);
    for (const section of result) {
      const sliced = content.slice(section.charPos, section.charPos + section.text.length);
      assert.equal(sliced, section.text,
        `charPos ${section.charPos} doesn't match for "${section.text.slice(0, 40)}..."`);
    }
  });

  it("does not bullet-split inside code fences", () => {
    const content = [
      "## Example",
      "Some intro text that is long enough to not be tiny by itself here.",
      "```",
      "- this is not a bullet",
      "- this is code",
      "- not a list",
      "```",
    ].join("\n");

    const result = splitSections(content);
    // Code fence bullets should not cause splitting
    assert.equal(result.length, 1);
  });

  it("handles mixed content: prose paragraph then bullet list", () => {
    const content = [
      "## Overview",
      "This section has a prose paragraph first with enough text.",
      "",
      "- **Setting A:** value one with padding text that is long enough here",
      "- **Setting B:** value two with padding text that is long enough here",
      "- **Setting C:** value three with padding text that is long enough",
    ].join("\n");

    const result = splitSections(content);
    // Should split: prose is kept, bullets are split out
    assert.ok(result.length >= 2, `Expected splitting, got ${result.length}`);
  });
});
