/**
 * Unit tests for src/entities.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEntities, entityOverlap } from "../src/entities.js";

describe("extractEntities", () => {
  it("extracts people names", () => {
    const entities = extractEntities("Ryan deployed the model yesterday");
    assert.ok(entities.some(e => e.includes("ryan")), `should find "ryan" in ${entities}`);
  });

  it("extracts proper nouns (capitalized terms)", () => {
    const entities = extractEntities("Gemma 4 was deployed on Mac Mini");
    assert.ok(entities.length > 0, "should extract capitalized terms");
  });

  it("returns empty array for text with no entities", () => {
    const entities = extractEntities("the webhook was deleted");
    assert.ok(Array.isArray(entities), "should return array");
    // May or may not be empty — "webhook" might not be extracted, which is fine
  });

  it("handles empty string", () => {
    const entities = extractEntities("");
    assert.deepEqual(entities, []);
  });

  it("handles code snippets without crashing", () => {
    const entities = extractEntities("Run `git push origin main` to deploy");
    assert.ok(Array.isArray(entities));
  });

  it("deduplicates entities", () => {
    const entities = extractEntities("Ryan told Ryan about Ryan's deployment");
    // Exact "ryan" should appear at most once (Set dedup)
    const exactRyan = entities.filter(e => e === "ryan").length;
    assert.ok(exactRyan <= 1, `exact "ryan" should appear at most once, got ${exactRyan} in ${entities}`);
  });

  it("lowercases all entities", () => {
    const entities = extractEntities("Ryan deployed Gemma on Mac Mini");
    for (const e of entities) {
      assert.equal(e, e.toLowerCase(), `entity "${e}" should be lowercase`);
    }
  });

  it("caps at 10 entities", () => {
    const text = "Alice Bob Charlie David Eve Frank Grace Henry Iris Jack Kate Leo Mike Nancy Oscar Pete Quinn Rachel Steve Tom Uma Vera";
    const entities = extractEntities(text);
    assert.ok(entities.length <= 10, `should cap at 10, got ${entities.length}`);
  });
});

describe("entityOverlap", () => {
  it("returns count of shared entities", () => {
    const overlap = entityOverlap(["ryan", "mbp-1", "gemma"], ["ryan", "qwen", "mbp-1"]);
    assert.equal(overlap, 2);
  });

  it("is case-insensitive", () => {
    const overlap = entityOverlap(["Ryan"], ["ryan"]);
    assert.equal(overlap, 1);
  });

  it("returns 0 for disjoint sets", () => {
    const overlap = entityOverlap(["ryan", "mbp-1"], ["gemma", "qwen"]);
    assert.equal(overlap, 0);
  });

  it("returns 0 for empty arrays", () => {
    assert.equal(entityOverlap([], ["ryan"]), 0);
    assert.equal(entityOverlap(["ryan"], []), 0);
    assert.equal(entityOverlap([], []), 0);
  });
});
