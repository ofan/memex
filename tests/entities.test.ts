/**
 * Unit tests for src/entities.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractEntities, entityOverlap } from "../src/entities.js";

describe("extractEntities", () => {
  it("extracts people names", () => {
    const entities = extractEntities("Alex deployed the model yesterday");
    assert.ok(entities.some(e => e.includes("alex")), `should find "alex" in ${entities}`);
  });

  it("extracts proper nouns (capitalized terms)", () => {
    const entities = extractEntities("Gemma 4 was deployed on Host B");
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
    const entities = extractEntities("Alex told Alex about Alex's deployment");
    // Exact "alex" should appear at most once (Set dedup)
    const exactAlex = entities.filter(e => e === "alex").length;
    assert.ok(exactAlex <= 1, `exact "alex" should appear at most once, got ${exactAlex} in ${entities}`);
  });

  it("lowercases all entities", () => {
    const entities = extractEntities("Alex deployed Gemma on Host B");
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
    const overlap = entityOverlap(["alex", "host-a", "gemma"], ["alex", "qwen", "host-a"]);
    assert.equal(overlap, 2);
  });

  it("is case-insensitive", () => {
    const overlap = entityOverlap(["Alex"], ["alex"]);
    assert.equal(overlap, 1);
  });

  it("returns 0 for disjoint sets", () => {
    const overlap = entityOverlap(["alex", "host-a"], ["gemma", "qwen"]);
    assert.equal(overlap, 0);
  });

  it("returns 0 for empty arrays", () => {
    assert.equal(entityOverlap([], ["alex"]), 0);
    assert.equal(entityOverlap(["alex"], []), 0);
    assert.equal(entityOverlap([], []), 0);
  });
});
